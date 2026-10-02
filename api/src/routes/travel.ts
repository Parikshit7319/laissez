// Travel Rule over the OpenVASP Travel Rule Protocol (TRP 3.x).
// Each booking center of an organization acts as its own VASP. A transfer between two accounts
// sends an IVMS101 inquiry from the originator's booking center to the beneficiary's Travel Address;
// the beneficiary screens the name, posts its resolution to the callback, and receives the txid once
// the transfer is broadcast. Settlement waits for an approved resolution (see travelRuleApproved).
import { z } from 'zod';
import { router, need, body, audit, auditQ, type C, type Actor } from '../http';
import { adminSql, tenantSql, type Sql } from '../db';
import { ApiError, id, sha256, rateLimit, type Env } from '../util';
import {
  TRP_VERSION, TRP_EXTENSION, encodeTravelAddress, decodeTravelAddress, beneficiaryEndpoint, callbackEndpoint, confirmEndpoint,
  ivms101, beneficiaryName, originatorName, originatingVaspName, namesMatch, trpPost, safeCallback, iso2, type TrpResult,
} from '../trp';

export const routes = router();
/** Mount at /trp (outside /v1): POST /trp/v3/:ws/:investor, /trp/v3/callback/:ws/:msgId, /trp/v3/confirm/:ws/:msgId. */
export const trpRoutes = router();
/** Same router as trpRoutes; index.ts mounts publicRoutes at /trp. */
export const publicRoutes = trpRoutes;

const TRP_ACTOR: Actor = { kind: 'system', id: 'trp', name: 'Travel Rule Protocol' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THRESHOLD = 1000;
const ev = (event: string, detail?: string) => JSON.stringify([{ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }]);
const fictional = (kind: string) => kind === 'sandbox' || kind === 'network';
const vaspName = (w: { name: string; brand_name: string | null; kind: string }, bcName: string) =>
  `${(w.brand_name ?? w.name).replace(/\s*\(fictional\)\s*$/i, '')}, ${bcName} booking center${fictional(w.kind) ? ' (fictional)' : ''}`;

// ---------- Originator side ----------
type DecisionLike = { id: string; action: string; investor_id: string; counterparty_id?: string | null; ticker?: string; fund?: string; amount: number | string; units?: number | string; outcome?: string; what_ifs?: string[] | null };

async function buildInquiry(env: Env, sql: Sql, ws: string, d: DecisionLike, msgId: string) {
  const ticker = d.ticker ?? d.fund!;
  const [parties, funds, wsRows] = await sql.transaction([
    sql`select i.id, i.name, i.kind, i.residence, i.city, i.booking_center, coalesce(i.chain_wallet, i.wallet) as wallet, b.name as bc_name, b.jurisdiction as bc_jur
        from investors i join booking_centers b on b.id = i.booking_center where i.workspace_id = ${ws} and i.id = any(${[d.investor_id, d.counterparty_id]})`,
    sql`select ticker, name, currency, chains, chain_token, nav::float8 as nav from funds where workspace_id = ${ws} and ticker = ${ticker}`,
    sql`select name, brand_name, kind from workspaces where id = ${ws}`,
  ]);
  const o = parties.find((p: any) => p.id === d.investor_id);
  const b = parties.find((p: any) => p.id === d.counterparty_id);
  const f = funds[0]; const w = wsRows[0];
  if (!o || !b || !f || !w) throw new ApiError(404, 'not_found', 'The decision refers to an investor or fund that no longer exists, so no Travel Rule message was sent.');
  const originatingVasp = { name: vaspName(w, o.bc_name), country: iso2(o.bc_jur) };
  const beneficiaryVasp = { name: vaspName(w, b.bc_name), country: iso2(b.bc_jur) };
  const travelAddress = await encodeTravelAddress(beneficiaryEndpoint(env, ws, b.id));
  const units = Number(d.units ?? 0) || Math.round((Number(d.amount) / (f.nav || 1)) * 100) / 100;
  const inquiry = {
    // Tokenized fund units in the sandbox have no ISO 24165 DTI, so asset details travel in a named extension.
    asset: {},
    amount: units,
    callback: callbackEndpoint(env, ws, msgId),
    IVMS101: ivms101({
      originator: { name: o.name, kind: o.kind, residence: o.residence, city: o.city, wallet: o.wallet },
      beneficiary: { name: b.name, kind: b.kind, residence: b.residence, city: b.city, wallet: b.wallet },
      originatingVasp, beneficiaryVasp,
    }),
    extensions: { [TRP_EXTENSION]: { ticker: f.ticker, fund: f.name, chain: f.chains?.[0] ?? null, token_contract: f.chain_token ?? null, units: String(units), notional: String(d.amount), currency: f.currency, decision_id: d.id } },
  };
  return { inquiry, travelAddress, originatingVasp, beneficiaryVasp };
}

/** Records a resolution on an outbound message, once. */
async function applyResolution(sql: Sql, ws: string, msgId: string, r: any, via: string) {
  const approved = r?.approved;
  const status = approved ? 'approved' : 'rejected';
  const detail = approved ? `Beneficiary wallet ${approved.address}. ${via}` : `Reason: ${String(r?.rejected ?? 'none given')}. ${via}`;
  return sql`update travel_rule_messages set status = ${status}, response = ${JSON.stringify(r)}, beneficiary_address = ${approved?.address ?? null}, next_url = ${approved?.callback ?? null},
    updated_at = now(), timeline = timeline || ${ev(approved ? 'Approved by the beneficiary VASP' : 'Rejected by the beneficiary VASP', detail)}::jsonb
    where workspace_id = ${ws} and id = ${msgId} and direction = 'outbound' and status in ('sending', 'awaiting_resolution') returning id, status`;
}

async function sendInquiry(c: C, msgId: string, travelAddress: string, rid: string, inquiry: unknown) {
  const sql = c.get('sql'); const ws = c.get('ws');
  let res: TrpResult;
  try {
    const { url } = await decodeTravelAddress(travelAddress);
    res = await trpPost(c.env, url, rid, inquiry, [TRP_EXTENSION]);
  } catch (e: any) {
    res = { status: 0, body: null, error: e?.message ?? 'Could not decode the Travel Address' };
  }
  if (res.status === 200 && res.body && (res.body.approved || res.body.rejected)) {
    await applyResolution(sql, ws, msgId, res.body, 'Returned in the inquiry response (HTTP 200).');
  } else if (res.status === 204 || res.status === 202) {
    await sql`update travel_rule_messages set status = case when status = 'sending' then 'awaiting_resolution' else status end, updated_at = now(),
      timeline = timeline || ${ev('Inquiry acknowledged', `HTTP ${res.status}. The beneficiary posts its resolution to the callback URL.`)}::jsonb where workspace_id = ${ws} and id = ${msgId}`;
  } else {
    const why = res.error ? res.error : `HTTP ${res.status}${res.body?.error?.message ? `: ${res.body.error.message}` : ''}`;
    await sql`update travel_rule_messages set status = 'failed', response = ${JSON.stringify({ http_status: res.status, body: res.body, error: res.error ?? null })}, updated_at = now(),
      timeline = timeline || ${ev('Inquiry failed', `${why}. Retry once the beneficiary VASP is reachable.`)}::jsonb where workspace_id = ${ws} and id = ${msgId} and status in ('sending', 'awaiting_resolution')`;
  }
  const [row] = await sql`select id, decision_id, status, travel_address, request_identifier, beneficiary_address, response from travel_rule_messages where workspace_id = ${ws} and id = ${msgId}`;
  return row;
}

/**
 * Starts the Travel Rule exchange for an allowed transfer at or above USD/EUR 1,000.
 * Returns the outbound message, or null when the Travel Rule does not apply.
 */
export async function startTravelRule(c: C, d: DecisionLike) {
  if (d.action !== 'transfer' || !d.counterparty_id || (d.outcome && d.outcome !== 'ALLOW') || d.what_ifs?.length || Number(d.amount) < THRESHOLD) return null;
  const sql = c.get('sql'); const ws = c.get('ws'); const actor = c.get('actor');
  const msgId = id('trm', 12);
  const rid = crypto.randomUUID();
  const { inquiry, travelAddress, originatingVasp, beneficiaryVasp } = await buildInquiry(c.env, sql, ws, d, msgId);
  await sql.transaction([
    sql`insert into travel_rule_messages (workspace_id, id, decision_id, direction, originator_vasp, beneficiary_vasp, travel_address, request_identifier, status, payload, timeline)
      values (${ws}, ${msgId}, ${d.id}, 'outbound', ${originatingVasp.name}, ${beneficiaryVasp.name}, ${travelAddress}, ${rid}, 'sending', ${JSON.stringify(inquiry)},
      ${JSON.stringify([{ at: new Date().toISOString(), event: 'Inquiry sent', detail: `IVMS101 originator and beneficiary data sent to ${travelAddress.slice(0, 18)}… with TRP ${TRP_VERSION}.` }])}::jsonb)`,
    auditQ(sql, ws, actor, 'travel_rule.inquiry_sent', msgId, { decision: d.id, travel_address: travelAddress, request_identifier: rid }),
  ]);
  return sendInquiry(c, msgId, travelAddress, rid, inquiry);
}

/** True when the Travel Rule does not apply to the decision, or the beneficiary VASP approved it. */
export async function travelRuleApproved(sql: Sql, ws: string, decisionId: string): Promise<boolean> {
  const [d] = await sql`select d.action, d.amount::float8 as amount, d.counterparty_id,
      exists (select 1 from travel_rule_messages t where t.workspace_id = d.workspace_id and t.decision_id = d.id and t.direction = 'outbound' and t.status in ('approved', 'confirmed')) as ok
    from decisions d where d.workspace_id = ${ws} and d.id = ${decisionId}`;
  if (!d) return false;
  if (d.action !== 'transfer' || !d.counterparty_id || Number(d.amount) < THRESHOLD) return true;
  return !!d.ok;
}

/** Sends the TRP transfer confirmation (txid) to the beneficiary after the transfer is broadcast. Optional for callers. */
export async function travelRuleConfirm(c: C, decisionId: string, txid: string) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [m] = await sql`select id, request_identifier, next_url from travel_rule_messages where workspace_id = ${ws} and decision_id = ${decisionId} and direction = 'outbound' and status = 'approved' order by created_at desc limit 1`;
  if (!m) return null;
  if (!safeCallback(c.env, m.next_url)) {
    await sql`update travel_rule_messages set txid = ${txid}, updated_at = now(), timeline = timeline || ${ev('Confirmation not sent', 'The beneficiary gave no usable confirmation URL. The txid is recorded here only.')}::jsonb where workspace_id = ${ws} and id = ${m.id}`;
    return { id: m.id, status: 'approved', txid };
  }
  const res = await trpPost(c.env, m.next_url, m.request_identifier, { txid });
  const ok = res.status >= 200 && res.status < 300;
  await sql`update travel_rule_messages set txid = ${txid}, status = ${ok ? 'confirmed' : 'approved'}, updated_at = now(),
    timeline = timeline || ${ev(ok ? 'Transfer confirmed to the beneficiary' : 'Confirmation failed', ok ? `txid ${txid}` : `HTTP ${res.status || 'error'}. Retry from the message page.`)}::jsonb where workspace_id = ${ws} and id = ${m.id}`;
  return { id: m.id, status: ok ? 'confirmed' : 'approved', txid };
}

// ---------- Beneficiary side (public TRP endpoints) ----------
function trpHeaders(c: C) {
  const rid = c.req.header('request-identifier') ?? '';
  const ver = c.req.header('api-version') ?? '';
  if (!rid || rid.length > 100) throw new ApiError(400, 'missing_request_identifier', 'Send a request-identifier header. TRP uses one identifier for the whole transfer.');
  if (!/^3\./.test(ver)) throw new ApiError(400, 'unsupported_version', `This endpoint speaks TRP ${TRP_VERSION}. Send an api-version header starting with 3.`);
  return rid;
}
async function limit(c: C) {
  const ip = c.req.header('cf-connecting-ip');
  const key = ip ? `trp:${(await sha256(ip)).slice(0, 24)}` : 'trp:internal';
  if (!(await rateLimit(adminSql(c.env.DATABASE_URL), key, ip ? 120 : 1000, 60))) throw new ApiError(429, 'rate_limited', 'Too many Travel Rule messages from this address. Wait a minute and retry.');
}

// Inquiry: an originator VASP asks whether it may send to this account.
trpRoutes.post('/v3/:ws/:investor', async (c) => {
  const ws = c.req.param('ws'); const invId = c.req.param('investor');
  const rid = trpHeaders(c);
  if (!UUID.test(ws)) throw new ApiError(404, 'unknown_beneficiary_vasp', 'No VASP is registered at this Travel Address.');
  await limit(c);
  const b: any = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object' || !b.IVMS101 || typeof b.callback !== 'string' || b.amount === undefined || !b.asset) {
    throw new ApiError(400, 'invalid_inquiry', 'A TRP inquiry needs asset, amount, callback and IVMS101.');
  }
  const sql = tenantSql(c.env.DATABASE_URL_TENANT, ws);
  const [wsRows, invRows, outRows] = await sql.transaction([
    sql`select name, brand_name, kind from workspaces where id = ${ws}`,
    sql`select i.id, i.name, coalesce(i.chain_wallet, i.wallet) as wallet, b.name as bc_name from investors i join booking_centers b on b.id = i.booking_center where i.workspace_id = ${ws} and i.id = ${invId}`,
    sql`select decision_id from travel_rule_messages where workspace_id = ${ws} and request_identifier = ${rid} and direction = 'outbound' limit 1`,
  ]);
  const w = wsRows[0];
  if (!w) throw new ApiError(404, 'unknown_beneficiary_vasp', 'No VASP is registered at this Travel Address.');
  const inv = invRows[0];
  const claimed = beneficiaryName(b.IVMS101);
  const ok = !!inv && namesMatch(claimed, inv.name);
  const msgId = id('trm', 12);
  const resolution = ok
    ? { version: TRP_VERSION, approved: { address: inv.wallet, callback: confirmEndpoint(c.env, ws, msgId) } }
    : { version: TRP_VERSION, rejected: 'Beneficiary name does not match the account' };
  const travelAddress = await encodeTravelAddress(beneficiaryEndpoint(c.env, ws, invId));
  const now = new Date().toISOString();
  const timeline = [
    { at: now, event: 'Inquiry received', detail: `From ${originatingVaspName(b.IVMS101) ?? 'an unnamed VASP'} for ${originatorName(b.IVMS101) ?? 'an unnamed originator'}.` },
    { at: now, event: ok ? 'Beneficiary name matched' : 'Beneficiary name did not match', detail: `Inquiry names "${claimed ?? 'nobody'}".${inv && !ok ? ' The account holder has a different legal name.' : ''}` },
  ];
  await sql.transaction([
    sql`insert into travel_rule_messages (workspace_id, id, decision_id, direction, originator_vasp, beneficiary_vasp, travel_address, request_identifier, status, payload, response, beneficiary_address, next_url, timeline)
      values (${ws}, ${msgId}, ${outRows[0]?.decision_id ?? null}, 'inbound', ${originatingVaspName(b.IVMS101) ?? 'Unknown originator VASP'}, ${vaspName(w, inv?.bc_name ?? 'Unknown')}, ${travelAddress}, ${rid},
      ${ok ? 'approved' : 'rejected'}, ${JSON.stringify(b)}, ${JSON.stringify(resolution)}, ${ok ? inv.wallet : null}, ${b.callback}, ${JSON.stringify(timeline)}::jsonb)`,
    auditQ(sql, ws, TRP_ACTOR, ok ? 'travel_rule.inquiry_approved' : 'travel_rule.inquiry_rejected', msgId, { request_identifier: rid, beneficiary: invId, originator_vasp: originatingVaspName(b.IVMS101) }),
  ]);
  let delivered = false; let detail = 'The callback URL is not reachable from Laissez, so the resolution is returned in the inquiry response.';
  if (safeCallback(c.env, b.callback)) {
    const r = await trpPost(c.env, b.callback, rid, resolution);
    delivered = r.status >= 200 && r.status < 300;
    detail = delivered ? `Posted to ${b.callback.split('/').slice(0, 3).join('/')} (HTTP ${r.status}).` : `Callback returned HTTP ${r.status || 'error'}. Resolution returned in the inquiry response instead.`;
  }
  await sql`update travel_rule_messages set updated_at = now(), timeline = timeline || ${ev(delivered ? 'Resolution sent to the originator' : 'Resolution returned inline', detail)}::jsonb where workspace_id = ${ws} and id = ${msgId}`;
  return delivered ? c.body(null, 204) : c.json(resolution, 200);
});

// Resolution callback: the beneficiary VASP answers our inquiry.
trpRoutes.post('/v3/callback/:ws/:msgId', async (c) => {
  const ws = c.req.param('ws'); const msgId = c.req.param('msgId');
  const rid = trpHeaders(c);
  if (!UUID.test(ws)) throw new ApiError(404, 'not_found', 'No Travel Rule message at this callback URL.');
  await limit(c);
  const sql = tenantSql(c.env.DATABASE_URL_TENANT, ws);
  const [m] = await sql`select id, request_identifier, decision_id from travel_rule_messages where workspace_id = ${ws} and id = ${msgId} and direction = 'outbound'`;
  if (!m || m.request_identifier !== rid) throw new ApiError(404, 'not_found', 'No Travel Rule message matches this callback URL and request-identifier.');
  const r: any = await c.req.json().catch(() => null);
  if (!r || (!r.approved && !r.rejected)) throw new ApiError(400, 'invalid_resolution', 'A resolution needs approved {address, callback} or rejected.');
  if (r.approved && (typeof r.approved.address !== 'string' || !r.approved.address)) throw new ApiError(400, 'invalid_resolution', 'An approval needs the beneficiary address.');
  const done = await applyResolution(sql, ws, msgId, r, 'Received at the callback URL.');
  if (done.length) await audit(sql, ws, TRP_ACTOR, r.approved ? 'travel_rule.approved' : 'travel_rule.rejected', msgId, { decision: m.decision_id, reason: r.rejected ?? null });
  return c.body(null, 204);
});

// Transfer confirmation: the originator reports the transaction id (or a cancellation).
trpRoutes.post('/v3/confirm/:ws/:msgId', async (c) => {
  const ws = c.req.param('ws'); const msgId = c.req.param('msgId');
  const rid = trpHeaders(c);
  if (!UUID.test(ws)) throw new ApiError(404, 'not_found', 'No Travel Rule message at this confirmation URL.');
  await limit(c);
  const sql = tenantSql(c.env.DATABASE_URL_TENANT, ws);
  const [m] = await sql`select id, request_identifier, status from travel_rule_messages where workspace_id = ${ws} and id = ${msgId} and direction = 'inbound'`;
  if (!m || m.request_identifier !== rid) throw new ApiError(404, 'not_found', 'No Travel Rule message matches this confirmation URL and request-identifier.');
  if (m.status !== 'approved' && m.status !== 'confirmed') throw new ApiError(409, 'not_approved', 'This transfer was not approved, so it cannot be confirmed.');
  const r: any = await c.req.json().catch(() => null);
  if (!r || (typeof r.txid !== 'string' && typeof r.canceled !== 'string')) throw new ApiError(400, 'invalid_confirmation', 'A confirmation needs txid, or canceled with a reason.');
  const canceled = typeof r.canceled === 'string';
  await sql.transaction([
    sql`update travel_rule_messages set status = ${canceled ? 'canceled' : 'confirmed'}, txid = ${canceled ? null : r.txid}, updated_at = now(),
      timeline = timeline || ${ev(canceled ? 'Transfer canceled by the originator' : 'Transfer confirmed by the originator', canceled ? r.canceled : `txid ${r.txid}`)}::jsonb where workspace_id = ${ws} and id = ${msgId}`,
    auditQ(sql, ws, TRP_ACTOR, canceled ? 'travel_rule.canceled' : 'travel_rule.confirmed', msgId, canceled ? { reason: r.canceled } : { txid: r.txid }),
  ]);
  return c.body(null, 204);
});

// ---------- Organization routes ----------
function summarize(r: any) {
  const ext = r.payload?.extensions?.[TRP_EXTENSION] ?? {};
  return {
    id: r.id, decision_id: r.decision_id, direction: r.direction, status: r.status,
    originator_vasp: r.originator_vasp, beneficiary_vasp: r.beneficiary_vasp,
    originator: originatorName(r.payload?.IVMS101), beneficiary: beneficiaryName(r.payload?.IVMS101),
    amount: r.payload?.amount ?? null, ticker: ext.ticker ?? null, notional: ext.notional ?? null, currency: ext.currency ?? null,
    travel_address: r.travel_address, request_identifier: r.request_identifier, beneficiary_address: r.beneficiary_address, txid: r.txid,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

routes.get('/travel-rule/messages', async (c) => {
  need(c, 'read');
  const status = c.req.query('status');
  const rows = status
    ? await c.get('sql')`select * from travel_rule_messages where workspace_id = ${c.get('ws')} and status = ${status} order by created_at desc limit 200`
    : await c.get('sql')`select * from travel_rule_messages where workspace_id = ${c.get('ws')} order by created_at desc limit 200`;
  return c.json({ data: rows.map(summarize), threshold: { amount: THRESHOLD, currencies: ['USD', 'EUR'], rule: 'FATF Recommendation 16' }, protocol: { name: 'OpenVASP Travel Rule Protocol', version: TRP_VERSION } });
});

routes.get('/travel-rule/messages/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [r] = await sql`select * from travel_rule_messages where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!r) throw new ApiError(404, 'not_found', 'No Travel Rule message with that id in this organization.');
  const related = await sql`select id, direction, status, created_at from travel_rule_messages where workspace_id = ${ws} and request_identifier = ${r.request_identifier} and id <> ${r.id} order by created_at`;
  let decoded: string | null = null;
  try { decoded = r.travel_address ? (await decodeTravelAddress(r.travel_address)).url : null; } catch { decoded = null; }
  return c.json({
    ...summarize(r),
    travel_address_decoded: decoded,
    payload: r.payload, response: r.response, ivms101: r.payload?.IVMS101 ?? null,
    timeline: r.timeline ?? [], related,
    headers: { 'api-version': TRP_VERSION, 'request-identifier': r.request_identifier, ...(r.direction === 'outbound' ? { 'api-extensions': TRP_EXTENSION } : {}) },
    retryable: r.direction === 'outbound' && ['failed', 'rejected', 'awaiting_resolution'].includes(r.status),
  });
});

// Start the exchange by hand for an allowed transfer that has no message yet.
routes.post('/travel-rule/messages', async (c) => {
  need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const { decision_id } = await body(c, z.object({ decision_id: z.string().min(3).max(60) }));
  const [d] = await sql`select id, action, investor_id, counterparty_id, ticker, amount::float8 as amount, units::float8 as units, outcome, what_ifs from decisions where workspace_id = ${ws} and id = ${decision_id}`;
  if (!d) throw new ApiError(404, 'not_found', 'No decision with that id in this organization.');
  if (d.action !== 'transfer' || Number(d.amount) < THRESHOLD) throw new ApiError(422, 'not_required', 'The Travel Rule applies to transfers of USD or EUR 1,000 and above. This decision does not need a message.');
  if (d.outcome !== 'ALLOW') throw new ApiError(409, 'not_allowed', 'Only allowed transfers exchange Travel Rule data. Fix the refusal and request a new decision.');
  const open = await sql`select id from travel_rule_messages where workspace_id = ${ws} and decision_id = ${decision_id} and direction = 'outbound' and status in ('sending', 'awaiting_resolution', 'approved', 'confirmed')`;
  if (open.length) throw new ApiError(409, 'exists', `This decision already has Travel Rule message ${open[0].id}. Retry that one instead.`);
  return c.json(await startTravelRule(c, d), 201);
});

routes.post('/travel-rule/messages/:id/retry', async (c) => {
  need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const actor = c.get('actor');
  const [m] = await sql`select id, decision_id, direction, status from travel_rule_messages where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!m) throw new ApiError(404, 'not_found', 'No Travel Rule message with that id in this organization.');
  if (m.direction !== 'outbound') throw new ApiError(422, 'inbound', 'Only messages this organization sent can be retried. The originator retries inbound messages.');
  if (!['failed', 'rejected', 'awaiting_resolution'].includes(m.status)) throw new ApiError(409, 'not_retryable', `This message is ${m.status}. Only failed, rejected or unanswered messages can be retried.`);
  const [d] = await sql`select id, action, investor_id, counterparty_id, ticker, amount::float8 as amount, units::float8 as units, outcome from decisions where workspace_id = ${ws} and id = ${m.decision_id}`;
  if (!d) throw new ApiError(404, 'not_found', 'The decision behind this message no longer exists.');
  // A new inquiry needs a new request-identifier; the data is rebuilt so corrected client details are sent.
  const rid = crypto.randomUUID();
  const { inquiry, travelAddress, originatingVasp, beneficiaryVasp } = await buildInquiry(c.env, sql, ws, d, m.id);
  await sql.transaction([
    sql`update travel_rule_messages set status = 'sending', request_identifier = ${rid}, payload = ${JSON.stringify(inquiry)}, response = null, beneficiary_address = null, next_url = null,
      travel_address = ${travelAddress}, originator_vasp = ${originatingVasp.name}, beneficiary_vasp = ${beneficiaryVasp.name}, updated_at = now(),
      timeline = timeline || ${ev('Retried', `New inquiry sent by ${actor.name} with request-identifier ${rid}.`)}::jsonb where workspace_id = ${ws} and id = ${m.id}`,
    auditQ(sql, ws, actor, 'travel_rule.retried', m.id, { decision: d.id, request_identifier: rid }),
  ]);
  return c.json(await sendInquiry(c, m.id, travelAddress, rid, inquiry));
});

routes.post('/travel-rule/messages/:id/confirm', async (c) => {
  need(c, 'orders:write');
  const { txid } = await body(c, z.object({ txid: z.string().min(4).max(120) }));
  const [m] = await c.get('sql')`select decision_id, status, direction from travel_rule_messages where workspace_id = ${c.get('ws')} and id = ${c.req.param('id')}`;
  if (!m) throw new ApiError(404, 'not_found', 'No Travel Rule message with that id in this organization.');
  if (m.direction !== 'outbound' || m.status !== 'approved') throw new ApiError(409, 'not_approved', 'Only approved outbound messages can be confirmed with a transaction id.');
  const r = await travelRuleConfirm(c, m.decision_id, txid);
  await audit(c.get('sql'), c.get('ws'), c.get('actor'), 'travel_rule.confirmation_sent', c.req.param('id'), { txid, delivered: r?.status === 'confirmed' });
  return c.json(r);
});
