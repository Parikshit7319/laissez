// Identity verification routes (Sumsub). Authenticated routes under /v1; the provider webhook is public and signed.
import { z } from 'zod';
import { router, need, body, audit, actorRef, bg } from '../http';
import { ApiError, sha256 } from '../util';
import { adminSql } from '../db';
import { type KycEnv, kycConfigured, kycLevel, startCheck, refreshCheck, readEvidence, verifyWebhookDigest, applyResult, externalUserId } from '../kyc';

export const routes = router();
export const publicRoutes = router();

const ipHash = async (c: any) => sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
const present = (k: any) => ({ id: k.id, investor_id: k.investor_id, provider: k.provider, applicant_id: k.applicant_id, level: k.level_name, status: k.status, outcome: k.outcome ?? {}, evidence_sha256: k.evidence_sha256, evidence_ref: k.status === 'approved' ? `kyc:${k.id}` : null, created_by: k.created_by, created_at: k.created_at, reviewed_at: k.reviewed_at, last_webhook_at: k.last_webhook_at });
const COLS = 'id, investor_id, provider, applicant_id, level_name, status, outcome, evidence_sha256, created_by, created_at, reviewed_at, last_webhook_at';

routes.get('/kyc', async (c) => {
  need(c, 'read');
  const env = c.env as KycEnv;
  const [{ n, approved }] = await c.get('sql')`select count(*)::int as n, count(*) filter (where status = 'approved')::int as approved from kyc_checks where workspace_id = ${c.get('ws')}`;
  return c.json({ provider: 'sumsub', configured: kycConfigured(env), level: kycLevel(env), checks: n, approved, sdk: 'https://static.sumsub.com/idensic/static/sns-websdk-builder.js' });
});

routes.get('/investors/:id/kyc/checks', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql').query(`select ${COLS} from kyc_checks where workspace_id = $1 and investor_id = $2 order by created_at desc`, [c.get('ws'), c.req.param('id')]);
  return c.json({ data: rows.map(present) });
});

routes.post('/investors/:id/kyc/checks', async (c) => {
  const a = need(c, 'clients:write');
  const ws = c.get('ws'); const sql = c.get('sql');
  const [inv] = await sql`select id, name, kind, residence, email from investors where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${c.req.param('id')} in this organization.`);
  const r = await startCheck(c.env as KycEnv, sql, c.get('admin'), ws, inv, actorRef(a));
  await audit(sql, ws, a, 'kyc.check_started', r.check_id, { investor: inv.id, applicant_id: r.applicant_id, level: r.level });
  return c.json(r, 201);
});

routes.post('/investors/:id/kyc/checks/:checkId/refresh', async (c) => {
  const a = need(c, 'clients:write');
  const ws = c.get('ws');
  const r = await refreshCheck(c.env as KycEnv, c.get('admin'), ws, c.req.param('checkId'));
  await audit(c.get('sql'), ws, a, 'kyc.check_refreshed', r.id, { investor: c.req.param('id'), status: r.status });
  const [row] = await c.get('sql').query(`select ${COLS} from kyc_checks where workspace_id = $1 and id = $2`, [ws, r.id]);
  return c.json(present(row));
});

/** The full provider result, decrypted. Every read is logged with who, why and from where. */
routes.get('/investors/:id/kyc/checks/:checkId/evidence', async (c) => {
  const a = need(c, 'compliance:write');
  const ws = c.get('ws');
  const purpose = (c.req.query('purpose') ?? '').trim().slice(0, 200);
  if (purpose.length < 4) throw new ApiError(422, 'purpose_required', 'Say why you are opening the evidence (?purpose=...). It is written to the access log.');
  const r = await readEvidence(c.env as KycEnv, c.get('admin'), ws, c.req.param('checkId'), actorRef(a), purpose, await ipHash(c));
  await audit(c.get('sql'), ws, a, 'kyc.evidence_read', r.check_id, { investor: r.investor_id, purpose });
  return c.json(r);
});

routes.get('/kyc/evidence-access-log', async (c) => {
  need(c, 'audit:export');
  const rows = await c.get('admin')`select id, object_kind, object_id, accessed_by, purpose, accessed_at from evidence_access_log where workspace_id = ${c.get('ws')} order by accessed_at desc limit 200`;
  return c.json({ data: rows.map((r: any) => ({ ...r, id: Number(r.id) })) });
});

/** Provider webhook. Verified with the webhook secret; the applicant is matched by external user id, never trusted blindly. */
publicRoutes.post('/kyc/webhooks/sumsub', async (c) => {
  const env = c.env as KycEnv;
  const raw = await c.req.text();
  const ok = await verifyWebhookDigest(env, raw, c.req.header('x-payload-digest') ?? null, c.req.header('x-payload-digest-alg') ?? null);
  if (!ok) throw new ApiError(401, 'bad_signature', 'The webhook digest did not verify.');
  let p: any; try { p = JSON.parse(raw); } catch { throw new ApiError(400, 'invalid_request', 'The webhook body is not JSON.'); }
  const ext = String(p.externalUserId ?? '');
  const [ws, investorId] = ext.split(':');
  if (!ws || !investorId) return c.json({ ignored: true, reason: 'no external user id' });
  const admin = adminSql(env.DATABASE_URL);
  const [chk] = await admin`select * from kyc_checks where workspace_id = ${ws} and investor_id = ${investorId} and (applicant_id = ${p.applicantId ?? ''} or applicant_id is null) order by created_at desc limit 1`;
  if (!chk) return c.json({ ignored: true, reason: 'no matching check' });
  if (!chk.applicant_id && p.applicantId) await admin`update kyc_checks set applicant_id = ${p.applicantId} where id = ${chk.id}`;
  if (!['applicantReviewed', 'applicantPending', 'applicantOnHold', 'applicantReset', 'applicantPrechecked'].includes(p.type)) return c.json({ ignored: true, reason: `event ${p.type}` });
  const status = { reviewStatus: p.reviewStatus, reviewResult: p.reviewResult ?? {}, levelName: p.levelName };
  const r = await applyResult(env, admin, { ...chk, applicant_id: chk.applicant_id ?? p.applicantId }, status, null, 'webhook');
  await audit(admin, ws, null, 'kyc.webhook', chk.id, { investor: investorId, type: p.type, status: r.status, external_user_id: externalUserId(ws, investorId) });
  // The full applicant record is fetched after the response so the webhook returns quickly.
  if (r.status === 'approved' || r.status === 'rejected') bg(c, refreshCheck(env, admin, ws, chk.id).catch((e) => console.error('kyc refresh after webhook', e)));
  return c.json({ received: true, status: r.status });
});
