// Investor portal. A distributor sends a client a private link; the client sees their credential and
// eligibility per fund, reads and acknowledges fund documents, submits evidence for a classification,
// and signs subscription requests. The distributor approves a request into a pre-trade decision.
import { z } from 'zod';
import { router, need, body, bg, audit, auditQ, type C, type Actor } from '../http';
import { adminSql, tenantSql } from '../db';
import { ApiError, id, rand, sha256, rateLimit, canonical, signReceipt, today } from '../util';
import { loadGlobals, loadInvestors, buildCtx } from '../ctx';
import { docsCtx } from '../fundops-core';
import { sendEmail, templates, deliverable } from '../email';
import { createDecision, liveCtx } from './core';
import { loadShareRow, decideShare, shareDetail } from './network';
import { evaluate, type Check } from '../../../src/proto/engine';
import { findTest } from '../../../src/proto/thresholds';

export const routes = router();
/** Mounted at /v1/portal: /v1/portal/me, /v1/portal/funds and so on, authenticated by "Authorization: Bearer lz_inv_...". */
export const publicRoutes = router();

const PORTAL_BASE = 'https://parikshit7319.github.io/laissez/portal/#';
const SCREEN_IDS = new Set(['screen', 'cpScreen', 'sanc']);
const ELIGIBILITY_LAYERS = new Set(['Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Fund terms']);
const isDocCheck = (ch: Check) => (ch.layer as string) === 'Documents' || /^doc/i.test(ch.id);

// ---------- Portal authentication ----------
publicRoutes.use('*', async (c, next) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const h = c.req.header('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok.startsWith('lz_inv_')) throw new ApiError(401, 'portal_unauthorized', 'Open the portal from the link your distributor sent you.');
  const hash = await sha256(tok);
  const [r] = await admin`select pa.workspace_id, pa.investor_id, pa.last_used_at, w.kind, i.name as inv_name
    from portal_access pa join workspaces w on w.id = pa.workspace_id join investors i on i.workspace_id = pa.workspace_id and i.id = pa.investor_id
    where pa.token_hash = ${hash} and pa.revoked_at is null and pa.expires_at > now() and (w.expires_at is null or w.expires_at > now())`;
  if (!r) throw new ApiError(401, 'portal_link_expired', 'This portal link has expired or was withdrawn. Ask your distributor for a new link.');
  if (!(await rateLimit(admin, `portal:${hash.slice(0, 24)}`, 120, 60))) throw new ApiError(429, 'rate_limited', 'Too many requests in a minute. Wait a moment and try again.');
  if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 600_000) {
    try { bg(c, admin`update portal_access set last_used_at = now() where token_hash = ${hash}` as any); } catch { /* no execution context */ }
  }
  const actor: Actor = { kind: 'investor', id: r.investor_id, name: `${r.inv_name} (investor portal)` };
  c.set('admin', admin); c.set('ws', r.workspace_id); c.set('wsKind', r.kind); c.set('actor', actor);
  c.set('sql', tenantSql(c.env.DATABASE_URL_TENANT, r.workspace_id));
  await next();
});

function credentialStatus(inv: any, t: string) {
  if (inv.shareStatus && inv.shareStatus !== 'active') return 'withdrawn';
  if (!inv.credentialId) return 'none';
  if (inv.expires < t) return 'lapsed';
  if (inv.classifications.some((x: any) => x.expires < t)) return 'partly_lapsed';
  return 'active';
}

function nextStep(ch: Check): string | null {
  switch (ch.id) {
    case 'cred': return 'Ask your relationship manager to renew your credential.';
    case 'fundClass': case 'law': case 'booking': return 'Submit current figures on the Evidence tab so your distributor can update your classification.';
    case 'dist': return 'This fund is not offered where you live. Nothing you submit changes this; ask about funds that are.';
    case 'regS': return 'This fund is not available to U.S. persons.';
    case 'cap': return 'The fund has reached its investor limit. Your distributor can put you on the waitlist.';
    case 'min': return ch.remedy ?? null;
    default: return ch.remedy ?? null;
  }
}

// ---------- Portal: who am I ----------
publicRoutes.get('/me', async (c) => {
  const sql = c.get('sql'); const admin = c.get('admin'); const ws = c.get('ws'); const invId = c.get('actor').id;
  const [invs, g, wrows, shares, funds, evidence] = await Promise.all([
    loadInvestors(sql, ws, [invId], admin),
    loadGlobals(sql),
    admin`select name, brand_name, brand_color, kind from workspaces where id = ${ws}`,
    admin`select s.id, s.purpose, s.consent_at, s.created_at, s.requested_by_name, s.consent_expires_at, coalesce(w.brand_name, w.name) as org,
        case when s.status = 'pending' and s.consent_expires_at is not null and s.consent_expires_at < now() then 'expired' else s.status end as status
      from credential_shares s join workspaces w on w.id = s.to_workspace join credentials cr on cr.workspace_id = s.from_workspace and cr.id = s.credential_id
      where s.from_workspace = ${ws} and cr.investor_id = ${invId} order by (s.status = 'pending') desc, s.created_at desc`,
    sql`select ticker, name, short_name, currency, nav::float8 as nav from funds where workspace_id = ${ws}`,
    sql`select count(*) filter (where status = 'submitted')::int as open from evidence_submissions where workspace_id = ${ws} and investor_id = ${invId}`,
  ]);
  const inv = invs[invId];
  if (!inv) throw new ApiError(404, 'not_found', 'Your account was removed by your distributor. Contact them for help.');
  const w = wrows[0];
  const t = today();
  return c.json({
    distributor: { name: w.brand_name || w.name, brand_color: w.brand_color || '#1f3a33', sandbox: w.kind === 'sandbox' || w.kind === 'network' },
    investor: {
      ...inv,
      residence_name: g.jurName[inv.residence] ?? inv.residence,
      booking_name: g.bookingCenters[inv.booking]?.name ?? inv.booking,
      credential_status: credentialStatus(inv, t),
      classifications: inv.classifications.map((x) => ({ ...x, label: g.classInfo[x.code]?.label ?? x.code, jurisdiction: g.classInfo[x.code]?.jur ?? null, jurisdiction_name: g.jurName[g.classInfo[x.code]?.jur] ?? null, rule: g.classInfo[x.code]?.rule ?? null, lapsed: x.expires < t })),
    },
    holdings: Object.entries(inv.holdings).map(([ticker, h]) => {
      const f = funds.find((x: any) => x.ticker === ticker);
      return { ticker, fund: f?.name ?? ticker, units: h!.units, value: f ? Math.round(h!.units * f.nav * 100) / 100 : null, currency: f?.currency ?? null, since: h!.since };
    }),
    shares: shares.map((s: any) => ({ id: s.id, status: s.status, organization: s.org, purpose: s.purpose, consent_at: s.consent_at, created_at: s.created_at, requested_by: s.requested_by_name ?? null, expires_at: s.consent_expires_at ?? null })),
    pending_shares: shares.filter((s: any) => s.status === 'pending').length,
    open_evidence: evidence[0]?.open ?? 0,
    today: t,
  });
});

// ---------- Portal: eligibility per fund ----------
publicRoutes.get('/funds', async (c) => {
  const sql = c.get('sql'); const admin = c.get('admin'); const ws = c.get('ws'); const invId = c.get('actor').id;
  const [ctx, ackRows, reqRows] = await Promise.all([
    buildCtx(sql, ws, [invId], null, admin),
    sql`select document_id, sha256, acknowledged_at, signed_name from doc_acknowledgments where workspace_id = ${ws} and investor_id = ${invId}`,
    sql`select ticker, count(*) filter (where status = 'submitted')::int as open from portal_requests where workspace_id = ${ws} and investor_id = ${invId} group by 1`,
  ]);
  const inv = ctx.investors[invId];
  if (!inv) throw new ApiError(404, 'not_found', 'Your account was removed by your distributor. Contact them for help.');
  const tickers = Object.keys(ctx.funds);
  const docs = tickers.length ? await docsCtx(sql, ws, tickers, [invId]) : { documents: {}, acks: {} };
  const out = tickers.map((t) => {
    const f = ctx.funds[t];
    const d = evaluate({ action: 'subscribe', investorId: invId, fundId: t, amount: f.minSubscription || 1, asset: f.assets[0] }, [], { ...ctx, documents: docs.documents, acks: docs.acks } as any);
    const visible = d.checks.filter((ch) => ELIGIBILITY_LAYERS.has(ch.layer as string) && !SCREEN_IDS.has(ch.id));
    const frozen = d.outcome === 'FREEZE';
    const eligible = !frozen && !visible.some((ch) => ch.result === 'fail');
    // The engine decides which documents apply (jurisdiction and audience); optional documents are listed for reading.
    const requiredIds = new Set(d.checks.filter(isDocCheck).map((ch) => ch.id.replace(/^doc:/, '')));
    const documents = ((docs.documents as any)[t] ?? [])
      .filter((doc: any) => requiredIds.has(doc.id) || (!doc.required && (!doc.jurisdiction || doc.jurisdiction === inv.residence)))
      .map((doc: any) => {
        const ack = ackRows.find((a: any) => a.document_id === doc.id);
        return { id: doc.id, title: doc.title, doc_type: doc.docType, version: doc.version, sha256: doc.sha256, required: requiredIds.has(doc.id), jurisdiction: doc.jurisdiction ?? null, audience: doc.audience,
          acknowledged_at: ack && ack.sha256 === doc.sha256 ? ack.acknowledged_at : null, signed_name: ack && ack.sha256 === doc.sha256 ? ack.signed_name : null, outdated_ack: !!ack && ack.sha256 !== doc.sha256 };
      });
    const outstanding = documents.filter((x: any) => x.required && !x.acknowledged_at).length;
    return {
      ticker: t, name: f.name, short: f.short, issuer: f.issuer, domicile: f.domicile, structure: f.structure, currency: f.currency, nav: f.nav,
      min_subscription: f.minSubscription, assets: f.assets, chains: f.chains, lockup_months: f.lockupMonths, dealing_frequency: f.dealingFrequency ?? 'daily',
      cutoff: f.cutoffTime ? `${f.cutoffTime} ${f.cutoffTz ?? ''}`.trim() : null, yield_bps: f.yieldBps ?? null,
      holding_units: inv.holdings[t]?.units ?? 0,
      eligible,
      summary: frozen
        ? 'Not available right now. Your distributor needs to review your account first.'
        : eligible
          ? outstanding ? `You are eligible. Read and acknowledge ${outstanding} document${outstanding === 1 ? '' : 's'} before you subscribe.` : 'You are eligible to subscribe.'
          : `Not available to you yet. ${visible.find((ch) => ch.result === 'fail')?.detail ?? ''}`.trim(),
      reasons: frozen
        ? [{ label: 'Account review', result: 'fail', detail: 'Your distributor needs to review your account before you can subscribe.', next_step: 'Contact your relationship manager.' }]
        : visible.filter((ch) => ch.result === 'pass' || ch.result === 'fail').map((ch) => ({ label: ch.label, result: ch.result, detail: ch.detail, rule: ch.ruleRef ?? null, next_step: ch.result === 'fail' ? nextStep(ch) : null })),
      binding_rules: frozen ? [] : d.resolved.map((r) => r.text),
      documents, documents_outstanding: outstanding,
      open_requests: reqRows.find((r: any) => r.ticker === t)?.open ?? 0,
    };
  });
  return c.json({ data: out, as_of: ctx.today });
});

// ---------- Portal: documents ----------
publicRoutes.get('/documents/:id', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.get('actor').id;
  const [docs, acks] = await sql.transaction([
    sql`select id, ticker, doc_type, title, version, jurisdiction, audience, content, sha256, required, published_at, superseded_at from fund_documents where workspace_id = ${ws} and id = ${c.req.param('id')}`,
    sql`select sha256, signed_name, signature, acknowledged_at from doc_acknowledgments where workspace_id = ${ws} and investor_id = ${invId} and document_id = ${c.req.param('id')}`,
  ]);
  const doc = docs[0];
  if (!doc) throw new ApiError(404, 'not_found', 'This document is no longer available. Go back to the fund to see the current version.');
  const ack = acks[0];
  return c.json({ ...doc, current: !doc.superseded_at, acknowledgment: ack && ack.sha256 === doc.sha256 ? ack : null });
});

publicRoutes.post('/documents/:id/acknowledge', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const actor = c.get('actor');
  const { signed_name } = await body(c, z.object({ signed_name: z.string().trim().min(2, 'Type your full name to acknowledge.').max(120) }));
  const [doc] = await sql`select id, ticker, title, version, sha256, superseded_at from fund_documents where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!doc) throw new ApiError(404, 'not_found', 'This document is no longer available. Go back to the fund to see the current version.');
  if (doc.superseded_at) throw new ApiError(409, 'superseded', 'A newer version of this document was published. Open the current version and acknowledge that one.');
  const at = new Date().toISOString();
  const signature = await sha256(`${doc.sha256}|${signed_name}|${at}`);
  await sql.transaction([
    sql`insert into doc_acknowledgments (workspace_id, investor_id, document_id, sha256, method, signed_name, signature, acknowledged_at)
      values (${ws}, ${actor.id}, ${doc.id}, ${doc.sha256}, 'portal', ${signed_name}, ${signature}, ${at})
      on conflict (workspace_id, investor_id, document_id) do update set sha256 = excluded.sha256, method = excluded.method, signed_name = excluded.signed_name, signature = excluded.signature, acknowledged_at = excluded.acknowledged_at`,
    auditQ(sql, ws, actor, 'document.acknowledged', doc.id, { investor: actor.id, ticker: doc.ticker, title: doc.title, version: doc.version, sha256: doc.sha256, method: 'portal', signed_name }),
  ]);
  return c.json({ document_id: doc.id, sha256: doc.sha256, signed_name, signature, acknowledged_at: at }, 201);
});

// ---------- Portal: evidence ----------
const evidenceIn = z.object({
  class_code: z.string().min(2).max(20),
  evidence: z.record(z.string().max(60), z.union([z.number(), z.boolean(), z.string().max(200)])).refine((o) => Object.keys(o).length <= 12, 'Send at most 12 figures.'),
  reference: z.string().trim().max(300).optional(),
});
publicRoutes.post('/evidence', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const actor = c.get('actor');
  const b = await body(c, evidenceIn);
  const [g, invRows, open] = await Promise.all([
    loadGlobals(sql),
    sql`select kind from investors where workspace_id = ${ws} and id = ${actor.id}`,
    sql`select count(*)::int as n from evidence_submissions where workspace_id = ${ws} and investor_id = ${actor.id} and status = 'submitted'`,
  ]);
  const meta = g.classInfo[b.class_code];
  if (!meta) throw new ApiError(422, 'unknown_class', `There is no investor classification called ${b.class_code}.`);
  if (open[0].n >= 10) throw new ApiError(422, 'limit', 'You have 10 submissions waiting for review. Wait for your distributor to review them.');
  const test = findTest(b.class_code, invRows[0]?.kind ?? 'Corporate');
  const numeric = Object.fromEntries(Object.entries(b.evidence).filter(([, v]) => typeof v !== 'string')) as Record<string, number | boolean>;
  const precheck = test ? test.check(numeric) : null;
  const evId = id('evd', 10);
  await sql.transaction([
    sql`insert into evidence_submissions (workspace_id, id, investor_id, class_code, evidence, reference) values (${ws}, ${evId}, ${actor.id}, ${b.class_code}, ${JSON.stringify(b.evidence)}, ${b.reference ?? null})`,
    auditQ(sql, ws, actor, 'evidence.submitted', evId, { investor: actor.id, class_code: b.class_code, precheck: precheck?.pass ?? null }),
  ]);
  return c.json({ id: evId, status: 'submitted', class_code: b.class_code, label: meta.label, precheck, note: 'Your distributor reviews the figures and the documents behind them, then updates your credential.' }, 201);
});

publicRoutes.get('/evidence', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [rows, g] = await Promise.all([
    sql`select id, class_code, evidence, reference, status, created_at, reviewed_at from evidence_submissions where workspace_id = ${ws} and investor_id = ${c.get('actor').id} order by created_at desc limit 50`,
    loadGlobals(sql),
  ]);
  return c.json({ data: rows.map((r: any) => ({ ...r, label: g.classInfo[r.class_code]?.label ?? r.class_code, jurisdiction: g.classInfo[r.class_code]?.jur ?? null })) });
});

// ---------- Portal: subscription requests ----------
const STATEMENT: Record<'subscribe' | 'redeem' | 'transfer', string> = {
  subscribe: 'I have read the documents and request this subscription.',
  redeem: 'I request this redemption of my units at the next dealing price.',
  transfer: 'I request this transfer of my units to the named counterparty.',
};
/**
 * A signed subscription, redemption or transfer request. Subscriptions need the fund documents acknowledged; redemptions
 * and transfers need the units; a transfer names its counterparty by passport number or legal name at the same distributor.
 */
publicRoutes.post('/requests', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const actor = c.get('actor');
  const b = await body(c, z.object({
    action: z.enum(['subscribe', 'redeem', 'transfer']).default('subscribe'),
    ticker: z.string().min(2).max(10), amount: z.number().positive().max(1e12), asset: z.string().min(2).max(20),
    counterparty: z.string().trim().min(2).max(160).optional(),
    signed_name: z.string().trim().min(2, 'Type your full name to sign.').max(120),
    agree: z.literal(true, { error: 'Confirm the statement to send this request.' }),
  }));
  const [funds, invRows, open, holdRows] = await sql.transaction([
    sql`select ticker, name, currency, assets, nav::float8 as nav, min_subscription::float8 as min from funds where workspace_id = ${ws} and ticker = ${b.ticker}`,
    sql`select name, residence from investors where workspace_id = ${ws} and id = ${actor.id}`,
    sql`select count(*)::int as n from portal_requests where workspace_id = ${ws} and investor_id = ${actor.id} and status = 'submitted'`,
    sql`select units::float8 as units from holdings where workspace_id = ${ws} and investor_id = ${actor.id} and ticker = ${b.ticker}`,
  ]);
  const f = funds[0]; const inv = invRows[0];
  if (!f) throw new ApiError(404, 'not_found', 'This fund is not offered by your distributor.');
  if (!f.assets.includes(b.asset)) throw new ApiError(422, 'unsupported_asset', `${f.name} settles only in ${f.assets.join(' or ')}. Choose one of those.`);
  if (b.action === 'subscribe' && b.amount < f.min) throw new ApiError(422, 'below_minimum', `The minimum subscription is ${f.currency} ${f.min.toLocaleString('en-US')}. Increase the amount.`);
  if (open[0].n >= 10) throw new ApiError(422, 'limit', 'You have 10 requests waiting for your distributor. Wait for them to be reviewed.');
  const held = Number(holdRows[0]?.units ?? 0);
  if (b.action !== 'subscribe') {
    if (held <= 0) throw new ApiError(422, 'no_holding', `You hold no ${f.ticker} units, so there is nothing to ${b.action === 'redeem' ? 'redeem' : 'transfer'}.`);
    const units = f.nav ? b.amount / f.nav : 0;
    if (units > held + 0.005) throw new ApiError(422, 'exceeds_holding', `That is about ${units.toLocaleString('en-US', { maximumFractionDigits: 2 })} units at today's price, but you hold ${held.toLocaleString('en-US')}. Lower the amount.`);
  }
  // A transfer counterparty is another client of the same distributor, found by passport number or legal name.
  let counterparty: { id: string; name: string } | null = null;
  if (b.action === 'transfer') {
    if (!b.counterparty) throw new ApiError(422, 'counterparty_required', 'Name the client who receives the units: their passport number (LZ-...) or legal name.');
    const key = b.counterparty.trim();
    const matches = await sql`select i.id, i.name from investors i where i.workspace_id = ${ws} and i.id <> ${actor.id}
      and (lower(i.name) = lower(${key}) or exists (select 1 from credentials cr where cr.workspace_id = i.workspace_id and cr.investor_id = i.id and upper(cr.lzid) = upper(${key})))
      order by i.created_at limit 2`;
    if (!matches.length) throw new ApiError(404, 'counterparty_not_found', `No client called "${key}" at your distributor. Check the passport number or the exact legal name with them.`);
    if (matches.length > 1) throw new ApiError(409, 'counterparty_ambiguous', 'More than one client has that name. Use their passport number instead.');
    counterparty = { id: matches[0].id, name: matches[0].name };
  }
  // Same context the distributor's decision will use, so the portal never accepts a request the engine would refuse for eligibility.
  const ids = [actor.id, ...(counterparty ? [counterparty.id] : [])];
  const { ctx } = await liveCtx(c as C, ids, f.ticker);
  const d = evaluate({ action: b.action, investorId: actor.id, fundId: f.ticker, amount: b.amount, asset: b.asset, counterpartyId: counterparty?.id }, [], ctx);
  const blocking = d.checks.filter((ch) => ch.result === 'fail' && (ELIGIBILITY_LAYERS.has(ch.layer as string) || (ch.layer as string) === 'Counterparty' || (ch.layer as string) === 'Transfer controls') && !SCREEN_IDS.has(ch.id) && ch.id !== 'min');
  if (blocking.length) {
    const why = b.action === 'subscribe' ? 'You are not eligible for this fund yet, so the request was not sent.' : b.action === 'redeem' ? 'This redemption cannot go ahead right now, so the request was not sent.' : 'This transfer cannot go ahead, so the request was not sent.';
    throw new ApiError(422, 'not_eligible', why, blocking.map((ch) => `${ch.subject ? `${ch.subject}: ` : ''}${ch.label}: ${ch.detail}`));
  }
  const docFails = d.checks.filter((ch) => isDocCheck(ch) && ch.result === 'fail');
  if (docFails.length) throw new ApiError(422, 'documents_outstanding', `Read and acknowledge ${docFails.length === 1 ? 'this document' : 'these documents'} first.`, docFails.map((ch) => ch.label.replace(/ acknowledged$/, '')));
  const requiredIds = new Set(d.checks.filter((ch) => isDocCheck(ch) && ch.id.startsWith('doc:')).map((ch) => ch.id.slice(4)));
  const required = (ctx.documents?.[f.ticker] ?? []).filter((x) => requiredIds.has(x.id));
  const reqId = id('prq', 10);
  const signedAt = new Date().toISOString();
  const documentHashes = required.map((d: any) => ({ id: d.id, title: d.title, version: d.version, sha256: d.sha256 }));
  const payload = {
    request_id: reqId, organization: ws, investor_id: actor.id, investor_name: inv.name, action: b.action,
    ticker: f.ticker, amount: b.amount.toFixed(2), currency: f.currency, asset: b.asset,
    ...(counterparty ? { counterparty_id: counterparty.id, counterparty_name: counterparty.name } : {}),
    statement: STATEMENT[b.action], signed_name: b.signed_name, signed_at: signedAt, document_hashes: documentHashes,
  };
  const payloadSha = await sha256(canonical(payload));
  let laissezSignature: string | null = null;
  try { laissezSignature = await signReceipt(c.env, payload); } catch { /* signing key not configured */ }
  const signature = { signed_name: b.signed_name, signed_at: signedAt, document_hashes: documentHashes, payload_sha256: payloadSha, laissez_signature: laissezSignature, alg: 'Ed25519', payload, ip_sha256: await sha256(c.req.header('cf-connecting-ip') ?? 'unknown') };
  await sql.transaction([
    sql`insert into portal_requests (workspace_id, id, investor_id, ticker, action, amount, asset, counterparty_id, signature) values (${ws}, ${reqId}, ${actor.id}, ${f.ticker}, ${b.action}, ${b.amount}, ${b.asset}, ${counterparty?.id ?? null}, ${JSON.stringify(signature)})`,
    auditQ(sql, ws, actor, 'portal_request.submitted', reqId, { investor: actor.id, action: b.action, ticker: f.ticker, amount: b.amount, asset: b.asset, counterparty: counterparty?.id ?? null, payload_sha256: payloadSha }),
  ]);
  const note = b.action === 'subscribe' ? 'Your distributor reviews the request and runs the pre-trade checks. You will see the outcome here.'
    : b.action === 'redeem' ? 'Your distributor reviews the request, applies any notice period or gate, and runs the pre-trade checks. You will see the outcome here.'
      : `Your distributor reviews the request and checks that ${counterparty!.name} may receive the units. You will see the outcome here.`;
  return c.json({ id: reqId, status: 'submitted', action: b.action, ticker: f.ticker, amount: b.amount, asset: b.asset, counterparty: counterparty, signature: { signed_name: b.signed_name, signed_at: signedAt, payload_sha256: payloadSha, laissez_signature: laissezSignature, document_hashes: documentHashes }, note }, 201);
});

publicRoutes.get('/requests', async (c) => {
  const rows = await c.get('sql')`select r.id, r.ticker, f.name as fund, f.currency, r.action, r.amount::float8 as amount, r.asset, r.status, r.note, r.created_at, r.decided_at, r.decision_id,
      r.counterparty_id, cp.name as counterparty_name,
      d.outcome, d.headline, r.signature->>'signed_name' as signed_name, r.signature->>'payload_sha256' as payload_sha256, r.signature->>'laissez_signature' as laissez_signature,
      exists (select 1 from settlements s where s.workspace_id = r.workspace_id and s.decision_id = r.decision_id and s.status = 'settled') as settled
    from portal_requests r left join funds f on f.workspace_id = r.workspace_id and f.ticker = r.ticker left join decisions d on d.workspace_id = r.workspace_id and d.id = r.decision_id
    left join investors cp on cp.workspace_id = r.workspace_id and cp.id = r.counterparty_id
    where r.workspace_id = ${c.get('ws')} and r.investor_id = ${c.get('actor').id} order by r.created_at desc limit 50`;
  return c.json({ data: rows });
});

// ---------- Portal: consent requests from other distributors ----------
/** Shares of this client's credential: pending ones wait for a decision here, the rest are listed for the record. */
publicRoutes.get('/shares', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws'); const invId = c.get('actor').id;
  const rows = await admin`select s.id, s.status, s.purpose, s.created_at, s.consent_at, s.consent_name, s.consent_expires_at, s.revoked_at, s.revoked_reason, s.booking_center, s.terms, s.requested_by_name,
      (s.status = 'pending' and s.consent_expires_at is not null and s.consent_expires_at < now()) as expired,
      coalesce(wt.brand_name, wt.name) as organization, coalesce(wf.brand_name, wf.name) as issuer
    from credential_shares s join credentials cr on cr.workspace_id = s.from_workspace and cr.id = s.credential_id
    join workspaces wt on wt.id = s.to_workspace join workspaces wf on wf.id = s.from_workspace
    where s.from_workspace = ${ws} and cr.investor_id = ${invId} order by (s.status = 'pending') desc, s.created_at desc limit 50`;
  const data = rows.map((r: any) => ({
    id: r.id, status: r.expired ? 'expired' : r.status, organization: r.organization, issuer: r.issuer, purpose: r.purpose, requested_by: r.requested_by_name,
    booking_center: r.booking_center, classifications: r.terms?.scope ?? [], created_at: r.created_at, expires_at: r.consent_expires_at, consent_at: r.consent_at, consent_name: r.consent_name,
    revoked_at: r.revoked_at, revoked_reason: r.revoked_reason, pending: r.status === 'pending' && !r.expired,
  }));
  return c.json({ data, pending: data.filter((x: any) => x.pending).length });
});

publicRoutes.get('/shares/:id', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws'); const invId = c.get('actor').id;
  const s = await loadShareRow(admin, { id: c.req.param('id') });
  if (!s || s.from_workspace !== ws || s.from_investor_id !== invId) throw new ApiError(404, 'not_found', 'No consent request with that id for your credential.');
  return c.json(await shareDetail(admin, s));
});

/** Approve or decline a pending consent request from inside the portal, signed with the client's typed name. */
publicRoutes.post('/shares/:id/:decision{approve|decline}', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws'); const actor = c.get('actor');
  const decision = c.req.param('decision');
  if (decision !== 'approve' && decision !== 'decline') throw new ApiError(404, 'not_found', 'Use /shares/:id/approve or /shares/:id/decline.');
  const { name } = await body(c, z.object({ name: z.string().trim().min(2, 'Type your full name to sign.').max(120) }));
  const s = await loadShareRow(admin, { id: c.req.param('id') });
  if (!s || s.from_workspace !== ws || s.from_investor_id !== actor.id) throw new ApiError(404, 'not_found', 'No consent request with that id for your credential.');
  const out = await decideShare(admin, s, decision, name, 'portal');
  return c.json(out);
});

publicRoutes.post('/consent/withdraw/:share_id', async (c) => {
  const sql = c.get('sql'); const admin = c.get('admin'); const ws = c.get('ws'); const actor = c.get('actor');
  const r = await sql`update credential_shares set status = 'revoked', revoked_at = now(), revoked_reason = 'Consent withdrawn by the client in the investor portal'
    where id = ${c.req.param('share_id')} and from_workspace = ${ws} and status in ('pending', 'active')
      and credential_id in (select id from credentials where workspace_id = ${ws} and investor_id = ${actor.id}) returning id, to_workspace`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No active share of your credential with that id.');
  await audit(sql, ws, actor, 'credential_share.withdrawn', r[0].id, { via: 'portal' });
  await audit(admin, r[0].to_workspace, { kind: 'system', id: 'consent', name: actor.name.replace(' (investor portal)', ' (client consent)') }, 'credential_share.withdrawn', r[0].id, { via: 'portal' });
  return c.json({ revoked: r[0].id, message: 'The other distributor can no longer rely on your credential.' });
});

// ---------- Distributor routes ----------
routes.post('/investors/:id/portal-invite', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [inv] = await sql`select id, name, email from investors where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!inv) throw new ApiError(404, 'not_found', 'No client with that id in this organization.');
  const token = `lz_inv_${rand(32)}`;
  const [row] = await c.get('admin')`insert into portal_access (token_hash, workspace_id, investor_id, created_by) values (${await sha256(token)}, ${ws}, ${inv.id}, ${`${actor.kind}:${actor.id}`}) returning expires_at`;
  await audit(sql, ws, actor, 'portal.invited', inv.id, { investor: inv.id, expires_at: row.expires_at });
  const link = `${PORTAL_BASE}${token}`;
  let emailStatus: string | null = null;
  if (deliverable(inv.email)) {
    const [w] = await c.get('admin')`select name, brand_name from workspaces where id = ${ws}`;
    const m = await sendEmail(c.env, c.get('admin'), { ws, to: inv.email, kind: 'portal_access', ...templates.portalAccess({ investor: inv.name, org: w.brand_name || w.name, link }) });
    emailStatus = m.status;
  }
  return c.json({
    link, expires_at: row.expires_at, investor: { id: inv.id, name: inv.name }, email_status: emailStatus,
    note: emailStatus === 'sent'
      ? `Laissez emailed the link to ${inv.email}. It works for 30 days, and anyone holding it can act for this client in the portal.`
      : `Send this link to the client only. It works for 30 days, and anyone holding it can act for this client in the portal.${emailStatus ? ' A copy of the email is in the Outbox.' : ''}`,
  }, 201);
});

/** Issues a new portal link for a client, emails it when the client has a deliverable address, and records the invite. */
async function issuePortalLink(c: C, actor: Actor, inv: { id: string; name: string; email: string | null }, reason: 'invite' | 'reissue') {
  const sql = c.get('sql'); const ws = c.get('ws');
  const token = `lz_inv_${rand(32)}`;
  const [row] = await c.get('admin')`insert into portal_access (token_hash, workspace_id, investor_id, created_by) values (${await sha256(token)}, ${ws}, ${inv.id}, ${`${actor.kind}:${actor.id}`}) returning expires_at`;
  await audit(sql, ws, actor, reason === 'reissue' ? 'portal.access_reissued' : 'portal.invited', inv.id, { investor: inv.id, expires_at: row.expires_at });
  const link = `${PORTAL_BASE}${token}`;
  let emailStatus: string | null = null;
  if (deliverable(inv.email)) {
    const [w] = await c.get('admin')`select name, brand_name from workspaces where id = ${ws}`;
    const m = await sendEmail(c.env, c.get('admin'), { ws, to: inv.email as string, kind: 'portal_access', ...templates.portalAccess({ investor: inv.name, org: w.brand_name || w.name, link }) });
    emailStatus = m.status;
  }
  return { link, expires_at: row.expires_at, email_status: emailStatus };
}

routes.get('/investors/:id/portal-access', async (c) => {
  need(c, 'read');
  const ws = c.get('ws'); const invId = c.req.param('id');
  const [inv] = await c.get('sql')`select id, name, email from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!inv) throw new ApiError(404, 'not_found', 'No client with that id in this organization.');
  const rows = await c.get('admin')`select left(token_hash, 12) as id, created_by, created_at, expires_at, last_used_at, revoked_at from portal_access where workspace_id = ${ws} and investor_id = ${invId} order by created_at desc limit 50`;
  const now = Date.now();
  const data = rows.map((r: any) => ({ ...r, status: r.revoked_at ? 'revoked' : new Date(r.expires_at).getTime() < now ? 'expired' : 'active' }));
  return c.json({ investor: { id: inv.id, name: inv.name, email: inv.email ?? null, email_deliverable: deliverable(inv.email) }, data, active: data.filter((x: any) => x.status === 'active').length });
});

routes.delete('/investors/:id/portal-access', async (c) => {
  const actor = need(c, 'clients:write');
  const r = await c.get('admin')`update portal_access set revoked_at = now() where workspace_id = ${c.get('ws')} and investor_id = ${c.req.param('id')} and revoked_at is null returning token_hash`;
  await audit(c.get('sql'), c.get('ws'), actor, 'portal.access_revoked', c.req.param('id'), { links: r.length });
  return c.json({ revoked_links: r.length });
});

/** Withdraws every active link for the client and issues one new link in the same step. */
routes.post('/investors/:id/portal-access/reissue', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [inv] = await sql`select id, name, email from investors where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!inv) throw new ApiError(404, 'not_found', 'No client with that id in this organization.');
  const revoked = await c.get('admin')`update portal_access set revoked_at = now() where workspace_id = ${ws} and investor_id = ${inv.id} and revoked_at is null returning token_hash`;
  if (revoked.length) await audit(sql, ws, actor, 'portal.access_revoked', inv.id, { links: revoked.length, reason: 'reissue' });
  const issued = await issuePortalLink(c as C, actor, inv, 'reissue');
  return c.json({
    ...issued, revoked_links: revoked.length, investor: { id: inv.id, name: inv.name },
    note: issued.email_status === 'sent'
      ? `${revoked.length} earlier link${revoked.length === 1 ? '' : 's'} withdrawn. Laissez emailed the new link to ${inv.email}.`
      : `${revoked.length} earlier link${revoked.length === 1 ? '' : 's'} withdrawn. Send the new link to the client only; it works for 30 days.${issued.email_status ? ' A copy of the email is in the Outbox.' : ''}`,
  }, 201);
});

routes.get('/portal-requests', async (c) => {
  need(c, 'read');
  const status = c.req.query('status');
  const sql = c.get('sql'); const ws = c.get('ws');
  const q = status
    ? sql`select r.*, r.amount::float8 as amount, i.name as investor_name, i.residence, f.name as fund_name, f.currency, d.outcome, d.headline, cp.name as counterparty_name from portal_requests r join investors i on i.workspace_id = r.workspace_id and i.id = r.investor_id left join funds f on f.workspace_id = r.workspace_id and f.ticker = r.ticker left join decisions d on d.workspace_id = r.workspace_id and d.id = r.decision_id left join investors cp on cp.workspace_id = r.workspace_id and cp.id = r.counterparty_id where r.workspace_id = ${ws} and r.status = ${status} order by r.created_at desc limit 100`
    : sql`select r.*, r.amount::float8 as amount, i.name as investor_name, i.residence, f.name as fund_name, f.currency, d.outcome, d.headline, cp.name as counterparty_name from portal_requests r join investors i on i.workspace_id = r.workspace_id and i.id = r.investor_id left join funds f on f.workspace_id = r.workspace_id and f.ticker = r.ticker left join decisions d on d.workspace_id = r.workspace_id and d.id = r.decision_id left join investors cp on cp.workspace_id = r.workspace_id and cp.id = r.counterparty_id where r.workspace_id = ${ws} order by r.created_at desc limit 100`;
  return c.json({ data: await q });
});

routes.post('/portal-requests/:id/approve', async (c) => {
  const actor = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [r] = await sql`select id, investor_id, ticker, action, amount::float8 as amount, asset, counterparty_id, status from portal_requests where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!r) throw new ApiError(404, 'not_found', 'No portal request with that id in this organization.');
  if (r.status !== 'submitted') throw new ApiError(409, 'already_decided', `This request was already ${r.status}.`);
  if (r.action === 'transfer' && !r.counterparty_id) throw new ApiError(422, 'counterparty_required', 'This transfer request names no counterparty, so no decision can be made. Reject it and ask the client to send it again.');
  const decision: any = await createDecision(c as C, { action: r.action, investor_id: r.investor_id, fund: r.ticker, amount: r.amount, settle_with: r.asset, ...(r.action === 'transfer' ? { counterparty_id: r.counterparty_id } : {}) });
  const what = r.action === 'subscribe' ? 'subscription' : r.action === 'redeem' ? 'redemption' : 'transfer';
  const note = decision.outcome === 'ALLOW' ? `Approved. The pre-trade check allowed the ${what}.` : `Approved for processing, but the pre-trade check refused it: ${decision.headline}`;
  const done = await sql.transaction([
    sql`update portal_requests set status = 'approved', decision_id = ${decision.id}, decided_at = now(), decided_by = ${actor.name}, note = ${note} where workspace_id = ${ws} and id = ${r.id} and status = 'submitted' returning id`,
    auditQ(sql, ws, actor, 'portal_request.approved', r.id, { decision: decision.id, outcome: decision.outcome }),
  ]);
  if (!done[0].length) throw new ApiError(409, 'already_decided', 'Someone decided this request a moment ago. Reload to see the result.');
  return c.json({ request: { id: r.id, status: 'approved', decision_id: decision.id, note }, decision });
});

routes.post('/portal-requests/:id/reject', async (c) => {
  const actor = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const { note } = await body(c, z.object({ note: z.string().trim().min(3, 'Tell the client why, in a sentence.').max(500) }));
  const r = await sql`update portal_requests set status = 'rejected', note = ${note}, decided_at = now(), decided_by = ${actor.name} where workspace_id = ${ws} and id = ${c.req.param('id')} and status = 'submitted' returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No open portal request with that id.');
  await audit(sql, ws, actor, 'portal_request.rejected', r[0].id, { note });
  return c.json({ id: r[0].id, status: 'rejected', note });
});

routes.get('/evidence', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const status = c.req.query('status');
  const [rows, g] = await Promise.all([
    status
      ? sql`select e.*, i.name as investor_name, i.kind as investor_kind, i.residence from evidence_submissions e join investors i on i.workspace_id = e.workspace_id and i.id = e.investor_id where e.workspace_id = ${ws} and e.status = ${status} order by e.created_at desc limit 100`
      : sql`select e.*, i.name as investor_name, i.kind as investor_kind, i.residence from evidence_submissions e join investors i on i.workspace_id = e.workspace_id and i.id = e.investor_id where e.workspace_id = ${ws} order by e.created_at desc limit 100`,
    loadGlobals(sql),
  ]);
  return c.json({ data: rows.map((r: any) => {
    const test = findTest(r.class_code, r.investor_kind);
    const numeric = Object.fromEntries(Object.entries(r.evidence ?? {}).filter(([, v]) => typeof v !== 'string')) as Record<string, number | boolean>;
    return { ...r, label: g.classInfo[r.class_code]?.label ?? r.class_code, jurisdiction: g.classInfo[r.class_code]?.jur ?? null, threshold: g.classInfo[r.class_code]?.threshold ?? null, fields: test?.fields ?? [], precheck: test ? test.check(numeric) : null };
  }) });
});

routes.post('/evidence/:id/review', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ status: z.enum(['accepted', 'rejected']), note: z.string().trim().max(500).optional() }));
  const r = await sql`update evidence_submissions set status = ${b.status}, reviewed_by = ${actor.name}, reviewed_at = now(), review_note = ${b.note ?? null}
    where workspace_id = ${ws} and id = ${c.req.param('id')} and status = 'submitted' returning id, investor_id, class_code`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No submission waiting for review with that id.');
  await audit(sql, ws, actor, `evidence.${b.status}`, r[0].id, { investor: r[0].investor_id, class_code: r[0].class_code, note: b.note ?? null });
  return c.json({
    id: r[0].id, status: b.status,
    next: b.status === 'accepted' ? { label: 'Issue an updated credential with this classification', path: `/clients/${r[0].investor_id}/credential`, class_code: r[0].class_code } : null,
  });
});
