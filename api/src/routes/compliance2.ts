// Compliance operations, part two: in-app notifications, inbound Travel Rule manual review, the placement-limit
// hard cap used by decisions, audit-anchor verification, evidence accept-and-issue, and the rule-pack regression
// suite that runs when a draft is approved.
import { z } from 'zod';
import type { Sql } from '../db';
import { router, need, audit, auditQ, body, bg, type C } from '../http';
import { ApiError, today, addDays } from '../util';
import { notify, unreadCount } from '../notifications';
import { pageParams, pageOut } from '../pagination';
import { TRP_VERSION, confirmEndpoint, trpPost, safeCallback, beneficiaryName, originatingVaspName } from '../trp';
import { limitFor } from './reports';
import { PLACEMENT_WARN_AT } from '../monitor';
import { loadDeployment, txUrl, verifyProof, anchorLeaf } from '../chain';
import { issueCredential } from './core';
import { evaluate, defaultCtx, type Ctx, type Check } from '../../../src/proto/engine';
import { funds as PROTO_FUNDS, type Investor, type Classification } from '../../../src/proto/data';
import { findTest } from '../../../src/proto/thresholds';
import { REGRESSION_CASES, extendCtx, type CaseParty, type RegressionCase } from '../../../src/proto/rulepacks';

export const routes = router();

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** API keys have no user, so they see organization-wide notifications only. */
const viewerId = (c: C): string | null => c.get('actor').userId ?? null;

/** Notifications, newest first. Filter: unread. Cursor pagination (limit, cursor). */
routes.get('/notifications', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const uid = viewerId(c);
  const unreadOnly = c.req.query('unread') === 'true';
  const page = pageParams(c, 50, 200);
  const [rows, unread] = await Promise.all([
    sql`select id, kind, title, body, link, created_at, read_at, (user_id is null) as organization_wide from notifications
        where workspace_id = ${ws} and (user_id is null or user_id = ${uid}::uuid) and (${unreadOnly} = false or read_at is null)
          and (${page.at}::timestamptz is null or (created_at, id) < (${page.at}::timestamptz, ${page.id}))
        order by created_at desc, id desc limit ${page.limit + 1}`,
    unreadCount(sql, ws, uid),
  ]);
  return c.json({ ...pageOut(rows as any[], page), unread, poll_seconds: 60 });
});

routes.post('/notifications/read-all', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const uid = viewerId(c);
  const rows = await sql`update notifications set read_at = now() where workspace_id = ${ws} and read_at is null and (user_id is null or user_id = ${uid}::uuid) returning id`;
  return c.json({ marked: rows.length, unread: 0 });
});

routes.post('/notifications/:id/read', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const uid = viewerId(c);
  const [row] = await sql`update notifications set read_at = coalesce(read_at, now()) where workspace_id = ${ws} and id = ${c.req.param('id')} and (user_id is null or user_id = ${uid}::uuid) returning id, read_at`;
  if (!row) throw new ApiError(404, 'not_found', 'No notification with that id for you in this organization.');
  return c.json({ ...row, unread: await unreadCount(sql, ws, uid) });
});

// ---------------------------------------------------------------------------
// Inbound Travel Rule: manual review of a name mismatch
// ---------------------------------------------------------------------------

const tl = (event: string, detail?: string) => JSON.stringify([{ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }]);

routes.get('/travel-rule/inbound', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const status = c.req.query('status') || 'review';
  const [rows, [counts]] = await Promise.all([
    sql`select m.*, i.name as account_name, i.kind as account_kind, i.residence as account_residence, i.city as account_city
        from travel_rule_messages m left join investors i on i.workspace_id = m.workspace_id and i.id = m.account_id
        where m.workspace_id = ${ws} and m.direction = 'inbound' and (${status} = 'all' or m.status = ${status}) order by m.created_at desc limit 200`,
    sql`select count(*) filter (where status = 'review')::int as review, count(*) filter (where status = 'approved')::int as approved,
          count(*) filter (where status = 'rejected')::int as rejected, count(*)::int as total from travel_rule_messages where workspace_id = ${ws} and direction = 'inbound'`,
  ]);
  const data = rows.map((r: any) => ({
    id: r.id, status: r.status, originator_vasp: r.originator_vasp, beneficiary_vasp: r.beneficiary_vasp, request_identifier: r.request_identifier,
    claimed_beneficiary: beneficiaryName(r.payload?.IVMS101), beneficiary_person: r.payload?.IVMS101?.beneficiary?.beneficiaryPersons?.[0] ?? null,
    originator: r.payload?.IVMS101?.originator?.originatorPersons?.[0] ?? null, originator_name: r.payload?.IVMS101 ? (r.payload.IVMS101.originator?.originatorPersons?.[0]?.legalPerson?.name?.nameIdentifier?.[0]?.legalPersonName ?? null) : null,
    account: r.account_id ? { id: r.account_id, name: r.account_name, kind: r.account_kind, residence: r.account_residence, city: r.account_city } : null,
    amount: r.payload?.amount ?? null, asset: r.payload?.extensions ?? null, created_at: r.created_at, updated_at: r.updated_at,
    reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, review_note: r.review_note, timeline: r.timeline ?? [],
  }));
  return c.json({ data, counts });
});

async function reviewInbound(c: C, approve: boolean) {
  const actor = need(c, 'compliance:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const msgId = c.req.param('id') ?? '';
  const { note } = await body(c, z.object({ note: z.string().trim().max(500).optional() }));
  const [m] = await sql`select m.*, i.name as account_name, coalesce(i.chain_wallet, i.wallet) as account_wallet from travel_rule_messages m
    left join investors i on i.workspace_id = m.workspace_id and i.id = m.account_id where m.workspace_id = ${ws} and m.id = ${msgId} and m.direction = 'inbound'`;
  const callbackUrl: string | null = typeof m?.next_url === 'string' ? m.next_url : null;
  if (!m) throw new ApiError(404, 'not_found', 'No inbound Travel Rule message with that id in this organization.');
  if (m.status !== 'review') throw new ApiError(409, 'not_in_review', `This inquiry is ${m.status}, not waiting for review.`);
  if (approve && !m.account_wallet) throw new ApiError(409, 'no_account', 'The beneficiary account behind this inquiry no longer exists, so it cannot be approved. Reject it instead.');
  const resolution = approve
    ? { version: TRP_VERSION, approved: { address: m.account_wallet, callback: confirmEndpoint(c.env, ws, msgId) } }
    : { version: TRP_VERSION, rejected: note ?? 'Beneficiary name does not match the account' };
  const status = approve ? 'approved' : 'rejected';
  const claimed = beneficiaryName(m.payload?.IVMS101);
  const [row] = await sql.transaction([
    sql`update travel_rule_messages set status = ${status}, response = ${JSON.stringify(resolution)}, beneficiary_address = ${approve ? m.account_wallet : null},
        reviewed_by = ${actor.name}, reviewed_at = now(), review_note = ${note || null}, updated_at = now(),
        timeline = timeline || ${tl(approve ? 'Approved after manual review' : 'Rejected after manual review', `${actor.name} compared "${claimed ?? 'nobody'}" with ${m.account_name ?? 'the account'}.${note ? ` Note: ${note}` : ''}`)}::jsonb
      where workspace_id = ${ws} and id = ${msgId} and status = 'review' returning id`,
    auditQ(sql, ws, actor, approve ? 'travel_rule.review_approved' : 'travel_rule.review_rejected', msgId, { beneficiary: m.account_id ?? null, claimed_name: claimed, note: note || null, originator_vasp: originatingVaspName(m.payload?.IVMS101) }),
  ]);
  if (!row?.length) throw new ApiError(409, 'not_in_review', 'Someone else decided this inquiry a moment ago. Reload to see its status.');
  // Post the deferred resolution to the originator's callback.
  let delivered = false; let detail = 'The callback URL is not reachable from Laissez, so the originator must retry its inquiry.';
  if (safeCallback(c.env, callbackUrl)) {
    const r = await trpPost(c.env, callbackUrl, m.request_identifier, resolution);
    delivered = r.status >= 200 && r.status < 300;
    detail = delivered ? `Posted to ${String(m.next_url).split('/').slice(0, 3).join('/')} (HTTP ${r.status}).` : `Callback returned HTTP ${r.status || 'error'}${r.error ? `: ${r.error}` : ''}. The originator can retry its inquiry.`;
  }
  await sql`update travel_rule_messages set updated_at = now(), timeline = timeline || ${tl(delivered ? 'Resolution sent to the originator' : 'Resolution not delivered', detail)}::jsonb where workspace_id = ${ws} and id = ${msgId}`;
  if (!delivered) {
    await notify(sql, ws, { kind: 'travel_rule.callback_failed', title: `Travel Rule resolution for ${m.account_name ?? msgId} was not delivered`, body: detail, link: `#/travel-rule/inbound/${msgId}` });
  }
  return c.json({ id: msgId, status, delivered, detail, reviewed_by: actor.name, resolution });
}
routes.post('/travel-rule/inbound/:id/approve', (c) => reviewInbound(c, true));
routes.post('/travel-rule/inbound/:id/reject', (c) => reviewInbound(c, false));

// ---------------------------------------------------------------------------
// Placement limits: hard cap at decision time
// ---------------------------------------------------------------------------

const DOMESTIC: Record<string, string[]> = { US: ['united states', 'delaware'], SG: ['singapore'], HK: ['hong kong'], CH: ['switzerland'], DE: ['germany'], 'AE-DIFC': ['difc', 'dubai'], GB: ['united kingdom', 'england'] };
function periodMonths(p: string | null | undefined): number | null {
  if (!p) return null;
  const m = /(\d+)\s*-?\s*month/i.exec(p); if (m) return Number(m[1]);
  const y = /(\d+)\s*-?\s*year/i.exec(p); if (y) return Number(y[1]) * 12;
  if (/annual|per year|calendar year|twelve/i.test(p)) return 12;
  return null;
}
const UNIT_TEXT: Record<string, string> = { offerees: 'offerees', investors: 'investors', beneficial_owners: 'beneficial owners', holders_of_record: 'holders of record' };

export type PlacementCap = {
  check: Check;
  standing: { ticker: string; jurisdiction: string; basis: string; counted: number; limit: number; unit: string; utilization: number; citation: string; period: string | null };
};

/**
 * Whether a subscription from this jurisdiction would take the fund past a numeric placement limit. Returns null when
 * the jurisdiction has no numeric limit or the investor already holds units (an existing holder adds no head count).
 * Within PLACEMENT_WARN_AT of the limit the check is informational; at the limit a new holder fails it.
 */
export async function placementCapCheck(sql: Sql, ws: string, ticker: string, jurisdiction: string, isNewHolder: boolean): Promise<PlacementCap | null> {
  if (!isNewHolder) return null;
  const [f] = await sql`select f.domicile, d.basis from funds f join fund_distribution d on d.workspace_id = f.workspace_id and d.ticker = f.ticker and d.jurisdiction = ${jurisdiction}
    where f.workspace_id = ${ws} and f.ticker = ${ticker}`;
  if (!f) return null;
  const foreign = !(DOMESTIC[jurisdiction] ?? []).some((n) => String(f.domicile ?? '').toLowerCase().includes(n));
  const lim = limitFor(jurisdiction, f.basis, foreign);
  if (!lim || typeof lim.number !== 'number' || !(lim.number > 0)) return null;
  const months = periodMonths(lim.period);
  const since = months ? (() => { const d = new Date(today() + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); })() : null;
  const [row] = await sql`select count(distinct h.investor_id)::int as n from holdings h join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id
    where h.workspace_id = ${ws} and h.ticker = ${ticker} and h.units > 0 and i.residence = ${jurisdiction} and (${since}::date is null or h.since >= ${since}::date)`;
  const counted = Number(row?.n ?? 0);
  const util = counted / lim.number;
  const unit = UNIT_TEXT[lim.unit] ?? lim.unit;
  const standing = { ticker, jurisdiction, basis: f.basis, counted, limit: lim.number, unit, utilization: util, citation: lim.citation, period: lim.period };
  const base = { id: 'placement_cap', layer: 'Fund policy' as const, label: 'Placement limit', ruleRef: lim.citation, source: lim.source_url };
  if (counted >= lim.number) {
    return { standing, check: { ...base, result: 'fail',
      detail: `${ticker} already counts ${counted} of ${lim.number} ${unit}${lim.period ? ` over ${lim.period}` : ''} in this jurisdiction under ${f.basis}, so a new holder would exceed the limit (${lim.citation}).`,
      remedy: 'Place this investor only after the count falls, or confirm with the issuer that another distributor has headroom to transfer.' } };
  }
  if (util >= PLACEMENT_WARN_AT) {
    return { standing, check: { ...base, result: 'info', detail: `${ticker} counts ${counted} of ${lim.number} ${unit} in this jurisdiction (${Math.round(util * 100)}% of the ${lim.citation} limit). This subscription fits; ${lim.number - counted - 1} more new holder${lim.number - counted - 1 === 1 ? '' : 's'} would after it.` } };
  }
  return null;
}

routes.get('/placement-cap', async (c) => {
  need(c, 'read');
  const ticker = c.req.query('fund') ?? ''; const jur = c.req.query('jurisdiction') ?? '';
  if (!ticker || !jur) throw new ApiError(400, 'missing_parameter', 'Send fund and jurisdiction query parameters.');
  const r = await placementCapCheck(c.get('sql'), c.get('ws'), ticker.toUpperCase(), jur, true);
  return c.json(r ? { blocked: r.check.result === 'fail', ...r } : { blocked: false, check: null, standing: null, note: 'No numeric placement limit applies to new holders from this jurisdiction.' });
});

// ---------------------------------------------------------------------------
// Audit anchors: verify one anchor from the raw audit log
// ---------------------------------------------------------------------------

routes.get('/audit-anchors/:id/verify', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const anchorId = Number(c.req.param('id'));
  if (!Number.isInteger(anchorId) || anchorId <= 0) throw new ApiError(404, 'not_found', 'No audit anchor with that id for this organization.');
  const [[leaf], dep] = await Promise.all([
    sql`select a.id as anchor_id, a.anchor_date::text as anchor_date, a.merkle_root, a.leaves, a.tx_hash, a.block, a.status, l.seq, l.head_hash, l.leaf, l.proof
        from audit_anchor_leaves l join audit_anchors a on a.id = l.anchor_id where l.workspace_id = ${ws} and l.anchor_id = ${anchorId}`,
    loadDeployment(c.get('admin')),
  ]);
  if (!leaf) throw new ApiError(404, 'not_found', 'No audit anchor with that id for this organization.');
  const seq = Number(leaf.seq);
  // Recompute the hash chain from the first event up to the anchored sequence number, from event contents only.
  const [r] = await sql`
    with recursive ev as (
      select seq, workspace_id, type, subject, data, actor, created_at, hash from audit_events where workspace_id = ${ws} and seq is not null and seq <= ${seq}
    ), chain as (
      select e.seq, audit_hash(e.seq, e.workspace_id, e.type, e.subject, e.data, e.actor, e.created_at, repeat('0', 64)) as h from ev e where e.seq = 1
      union all
      select e.seq, audit_hash(e.seq, e.workspace_id, e.type, e.subject, e.data, e.actor, e.created_at, ch.h) from chain ch join ev e on e.seq = ch.seq + 1
    )
    select (select count(*)::int from ev) as events, (select max(seq) from chain)::int as reached,
      (select h from chain order by seq desc limit 1) as recomputed, (select hash from ev where seq = ${seq}) as stored`;
  const recomputed: string | null = r?.recomputed ?? null;
  const complete = Number(r?.events ?? 0) === seq && Number(r?.reached ?? 0) === seq;
  const headMatches = !!recomputed && complete && recomputed.toLowerCase() === String(leaf.head_hash).toLowerCase();
  const storedMatches = !!r?.stored && String(r.stored).toLowerCase() === String(leaf.head_hash).toLowerCase();
  const leafMatches = anchorLeaf(ws, seq, leaf.head_hash).toLowerCase() === String(leaf.leaf).toLowerCase();
  const proofValid = verifyProof(leaf.merkle_root, leaf.leaf, leaf.proof ?? []);
  const valid = headMatches && leafMatches && proofValid;
  const message = !complete
    ? `The log holds ${r?.events ?? 0} of the ${seq} events the anchor covers, so the head cannot be recomputed. Events were removed or renumbered.`
    : !headMatches ? `Recomputing events 1 to ${seq} gives a different head hash than the one anchored. An event in that range was altered after anchoring.`
    : !leafMatches ? 'The head hash matches but the stored leaf does not derive from it.'
    : !proofValid ? 'The leaf is right but its proof does not lead to the anchored Merkle root.'
    : `Events 1 to ${seq} recompute to the anchored head, and the proof leads to the Merkle root${leaf.status === 'confirmed' ? ' written on-chain' : ''}.`;
  return c.json({
    anchor_id: Number(leaf.anchor_id), anchor_date: leaf.anchor_date, status: leaf.status, merkle_root: leaf.merkle_root, leaves: leaf.leaves,
    tx_hash: leaf.tx_hash, block: leaf.block == null ? null : Number(leaf.block), explorer_url: txUrl(dep, leaf.tx_hash),
    seq, events_in_log: Number(r?.events ?? 0), head_hash: leaf.head_hash, recomputed_head: recomputed, stored_head: r?.stored ?? null,
    head_matches: headMatches, stored_matches: storedMatches, leaf: leaf.leaf, leaf_matches: leafMatches, proof: leaf.proof ?? [], proof_valid: proofValid,
    valid, message, checked_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Evidence: accept a submission and issue the credential in one step
// ---------------------------------------------------------------------------

routes.post('/evidence/:id/accept-and-issue', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const evId = c.req.param('id');
  const b = await body(c, z.object({ valid_months: z.number().int().min(1).max(24).default(12), note: z.string().trim().max(500).optional() }));
  const [e] = await sql`select e.*, i.kind as investor_kind from evidence_submissions e join investors i on i.workspace_id = e.workspace_id and i.id = e.investor_id where e.workspace_id = ${ws} and e.id = ${evId}`;
  if (!e) throw new ApiError(404, 'not_found', 'No evidence submission with that id in this organization.');
  if (e.status === 'rejected') throw new ApiError(409, 'rejected', 'This submission was rejected. Ask the client to submit again.');
  const test = findTest(e.class_code, e.investor_kind);
  if (!test) throw new ApiError(422, 'no_test', `${e.class_code} has no threshold test for a ${String(e.investor_kind).toLowerCase()}, so it cannot be issued from evidence.`);
  const numeric = Object.fromEntries(Object.entries(e.evidence ?? {}).filter(([, v]) => typeof v !== 'string')) as Record<string, number | boolean>;
  const pre = test.check(numeric);
  if (!pre.pass) throw new ApiError(422, 'threshold_not_met', `The figures do not meet the threshold, so nothing was issued. ${pre.reason}`);
  // Keep the classifications already on the active credential; only the submitted class is re-verified from figures.
  const existing = await sql`select cl.class_code, cl.basis, cl.opt_in_on::text as opt_in_on from classifications cl join credentials cr on cr.workspace_id = cl.workspace_id and cr.id = cl.credential_id
    where cr.workspace_id = ${ws} and cr.investor_id = ${e.investor_id} and cr.status = 'active' and cl.class_code <> ${e.class_code} and cl.expires_on >= current_date order by cl.id`;
  if (e.status === 'submitted') {
    await sql.transaction([
      sql`update evidence_submissions set status = 'accepted', reviewed_by = ${actor.name}, reviewed_at = now(), review_note = ${b.note ?? null} where workspace_id = ${ws} and id = ${evId} and status = 'submitted'`,
      auditQ(sql, ws, actor, 'evidence.accepted', evId, { investor: e.investor_id, class_code: e.class_code, note: b.note ?? null, issued_with: true }),
    ]);
  }
  const issued = await issueCredential(c, {
    investor_id: e.investor_id, valid_months: b.valid_months,
    classifications: [{ class_code: e.class_code, evidence: numeric, evidence_ref: `Investor portal submission ${evId}${e.reference ? ` (${e.reference})` : ''}` }],
  }, actor, { carry: existing.map((x: any) => ({ class_code: x.class_code, basis: x.basis, opt_in_on: x.opt_in_on })) });
  await audit(sql, ws, actor, 'evidence.credential_issued', evId, { investor: e.investor_id, class_code: e.class_code, credential: issued.credential_id, carried: existing.map((x: any) => x.class_code) });
  return c.json({ submission: { id: evId, status: 'accepted' }, carried_classes: existing.map((x: any) => x.class_code), ...issued }, 201);
});

// ---------------------------------------------------------------------------
// Rule-pack regression suite, run when a draft is approved
// ---------------------------------------------------------------------------

const ISSUED = '2026-06-01';
const EXPIRES = addDays(today(), 365);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const BASE = extendCtx(defaultCtx);

function materialize(p: CaseParty): { investor: Investor; issued: string[] } {
  const issued: string[] = [];
  const classifications: Classification[] = [...clone(p.classifications ?? [])];
  for (const [code, ev] of Object.entries(p.evidence ?? {})) {
    const test = findTest(code, p.kind);
    if (!test) throw new Error(`No ${p.kind} threshold test for ${code}`);
    const r = test.check(ev);
    if (!r.pass) continue;
    issued.push(code);
    classifications.push({ code, basis: r.reason, verified: ISSUED, expires: EXPIRES, ...(ev.opt_in ? { optIn: ISSUED } : {}) });
  }
  const investor: Investor = {
    id: p.id, name: p.name, short: p.name, kind: p.kind, residence: p.residence, city: BASE.jurName[p.residence] ?? p.residence, booking: p.booking,
    usPerson: !!p.usPerson, wallet: '0x0000…test', credentialId: `LP-TEST-${p.id}`, issued: ISSUED, expires: EXPIRES,
    classifications, holdings: clone(p.holdings ?? {}),
  };
  return { investor, issued };
}

/** Engine context for one golden case. Exported for the rule workbench, which runs the suite with a custom rule added. */
export function ctxFor(cse: RegressionCase): { ctx: Ctx; issued: string[] } {
  const inv = materialize(cse.investor);
  const cp = cse.counterparty ? materialize(cse.counterparty) : null;
  const fund = clone(PROTO_FUNDS[cse.fund]);
  fund.distribution = { ...fund.distribution, ...clone(cse.distribution ?? {}) };
  Object.assign(fund, clone((cse as any).fund_patch ?? {}));
  const hitName = cse.screenHit === 'investor' ? inv.investor.name : cse.screenHit === 'counterparty' ? cp?.investor.name : undefined;
  const ctx: Ctx = {
    ...BASE, today: '2026-10-01',
    investors: { [inv.investor.id]: inv.investor, ...(cp ? { [cp.investor.id]: cp.investor } : {}) },
    funds: { [fund.id]: fund },
    ...(hitName ? { screen: (name: string) => (name === hitName ? { entry: name, program: 'Test watchlist entry' } : null) } : {}),
  };
  return { ctx, issued: inv.issued };
}

export type RegressionResult = { pack: string; passed: number; failed: number; total: number; cases: { id: string; name: string; ok: boolean; message: string | null }[]; ran_at: string };
const sorted = (xs: string[]) => [...xs].sort();
const same = (a: string[], b: string[]) => a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i]);

/** Runs the golden cases of one pack through the engine. Jurisdiction packs are <JUR>/eligibility; GLOBAL runs both global packs. */
export function regressionFor(jurisdiction: string | null): RegressionResult {
  const jur = (jurisdiction ?? '').toUpperCase();
  const packs = jur === 'GLOBAL' ? ['global/sanctions', 'global/travel-rule'] : jur === 'EU' ? ['DE/eligibility', 'LU/eligibility', 'IE/eligibility'] : [`${jur}/eligibility`];
  const cases = REGRESSION_CASES.filter((x) => packs.includes(x.pack));
  const out: RegressionResult['cases'] = [];
  for (const cse of cases) {
    try {
      const { ctx, issued } = ctxFor(cse);
      const order = { ...cse.order, investorId: cse.investor.id, fundId: cse.fund, counterpartyId: cse.counterparty?.id };
      const d = evaluate(order, cse.whatIfs ?? [], ctx);
      const failing = d.checks.filter((x) => x.result === 'fail').map((x) => x.id);
      const problems: string[] = [];
      if (d.outcome !== cse.expect) problems.push(`outcome ${d.outcome}, expected ${cse.expect}: ${d.headline}`);
      if (!same(failing, cse.failing)) problems.push(`failing checks [${failing.join(', ')}], expected [${cse.failing.join(', ')}]`);
      if (cse.issued && !same(issued, cse.issued)) problems.push(`issued [${issued.join(', ')}], expected [${cse.issued.join(', ')}]`);
      if (cse.binding) {
        const binding = d.checks.filter((x) => x.binding).map((x) => x.id);
        if (!same(binding, cse.binding)) problems.push(`binding [${binding.join(', ')}], expected [${cse.binding.join(', ')}]`);
      }
      for (const cid of cse.present ?? []) if (!d.checks.some((x) => x.id === cid)) problems.push(`check ${cid} missing`);
      for (const cid of cse.absent ?? []) if (d.checks.some((x) => x.id === cid)) problems.push(`check ${cid} should be absent`);
      out.push({ id: cse.id, name: cse.name, ok: problems.length === 0, message: problems.length ? problems.join('; ') : null });
    } catch (e: any) {
      out.push({ id: cse.id, name: cse.name, ok: false, message: String(e?.message ?? e) });
    }
  }
  const failed = out.filter((x) => !x.ok).length;
  return { pack: packs.join(', '), passed: out.length - failed, failed, total: out.length, cases: out, ran_at: new Date().toISOString() };
}

const NUMERIC_FIELD = /threshold|amount|asset|income|portfolio|balance|turnover|own_funds|equity|net_worth|minimum|cap|limit|holders|count|value|subscription|securities/i;
const numbersIn = (s: unknown) => (String(s ?? '').match(/\d[\d,._]*\d|\d/g) ?? []).map((x) => x.replace(/[,_]/g, ''));

/** Warnings a reviewer should read before approving: a draft that moves a figure needs an engine change and new golden cases. */
export function thresholdWarnings(draft: any): string[] {
  const warnings: string[] = [];
  const changes: any[] = Array.isArray(draft?.changes) ? draft.changes : [];
  const numeric = changes.filter((ch) => {
    const field = String(ch?.field ?? '');
    const from = numbersIn(ch?.from); const to = numbersIn(ch?.to);
    // A figure moved: a threshold-like field with a number, or a sum of four digits or more that differs from before.
    const moneyLike = (xs: string[]) => xs.some((x) => x.replace(/\D/g, '').length >= 4);
    return (NUMERIC_FIELD.test(field) && to.length > 0) || (moneyLike(to) && to.join('|') !== from.join('|'));
  });
  if (numeric.length) {
    warnings.push(`This draft changes numeric thresholds: ${numeric.map((ch) => `${ch.class_code ?? 'class'} ${ch.field ?? 'field'} ${ch.from ?? 'unset'} to ${ch.to}`).join('; ')}. Approving records the change; the threshold tests in the engine and the golden regression cases must be updated in code before decisions reflect it.`);
  }
  if (draft?.source_status && draft.source_status !== 'final') warnings.push(`The source is a ${draft.source_status}, not final rules. Approve only if you intend to track it as a draft pack.`);
  if (Array.isArray(draft?.open_questions) && draft.open_questions.length) warnings.push(`${draft.open_questions.length} open question${draft.open_questions.length === 1 ? ' from the drafting agent remains' : 's from the drafting agent remain'} unanswered.`);
  return warnings;
}

routes.post('/rule-drafts/:id/regression', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const draftId = c.req.param('id');
  const [d] = await sql`select id, jurisdiction, draft, status from rule_drafts where workspace_id = ${ws} and id = ${draftId}`;
  if (!d) throw new ApiError(404, 'not_found', 'No rule draft with that id in this organization.');
  const regression = regressionFor(d.jurisdiction ?? d.draft?.jurisdiction ?? null);
  const warnings = thresholdWarnings(d.draft);
  if (d.status === 'draft') bg(c, Promise.resolve(sql`update rule_drafts set regression = ${JSON.stringify(regression)}, warnings = ${JSON.stringify(warnings)} where workspace_id = ${ws} and id = ${draftId}`));
  return c.json({ id: draftId, regression, warnings });
});
