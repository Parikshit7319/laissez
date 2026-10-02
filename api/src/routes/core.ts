// Core API: organization, clients and credentials, funds and policy, decisions, settlements,
// point-in-time replay, and the public reference data the rule engine reads.
import { z } from 'zod';
import {
  evaluate, holderStatus, inputsHash, snapshotFor, ctxFromSnapshot, replaySnapshot, WHAT_IFS,
  type WhatIf, type Decision, type Ctx, type Order, type Snapshot, type DocReq, type FundExt, type Check,
} from '../../../src/proto/engine';
import type { Investor, Fund } from '../../../src/proto/data';
import { findTest } from '../../../src/proto/thresholds';
import { adminSql, type Sql } from '../db';
import { ApiError, id, rand, digits, today, addDays, lzid, sha256, signReceipt, publicKey, verifyReceipt } from '../util';
import { type C, type Actor, router, body, bg, need, audit, auditQ, actorRef } from '../http';
import { buildCtx, loadGlobals, loadInvestors, loadFunds, packsAsOf, emit } from '../ctx';
import { screenNames, recordHits, type Match } from '../sanctions';
import { lawDefaults } from '../seed';
import { docsCtx, lifecycleCtx, noticeExecutionQueries, closedEndCtx } from '../fundops-core';
import { calendarsCtx } from '../calendars';
import { receiptPdf } from '../receipt-pdf';
import { chainEnabled, queueSettlement, onCredentialRevoked, onCredentialIssued, onPolicyPublished } from '../chain';
import { placementCapCheck } from './compliance2';
import { notifyRoles, APPROVER_ROLES } from '../notifications';
import { startTravelRule, travelRuleApproved, travelRuleConfirm } from './travel';
import { pageParams, pageOut } from '../pagination';
import { requireApproval, registerExecutor, isPending } from '../approvals';
import { waitlistEligible, releaseWaitlist, joinBatch, concentrationCheck, suitabilityCheck, taxCheck } from './workflow';
import { loadActiveRules } from './rules';

export const routes = router();
/** Reference data the engine reads. Public: no organization data. */
export const publicRoutes = router();

const adminOf = (c: C): Sql => c.get('admin') ?? adminSql(c.env.DATABASE_URL);
const SETTLE_WINDOW_MS = 15 * 60_000;
const LEGACY_VERSION = '2026-10-01';

// ---------- Public reference data ----------
publicRoutes.get('/jurisdictions', async (c) => c.json({ data: await adminSql(c.env.DATABASE_URL)`select * from jurisdictions order by name` }));
publicRoutes.get('/investor-classes', async (c) => c.json({ data: await adminSql(c.env.DATABASE_URL)`select * from investor_classes order by jurisdiction, code` }));
publicRoutes.get('/booking-centers', async (c) => c.json({ data: await adminSql(c.env.DATABASE_URL)`select * from booking_centers order by name` }));
publicRoutes.get('/rule-packs', async (c) => c.json({
  data: await adminSql(c.env.DATABASE_URL)`select id, version, jurisdiction, status, summary, effective_from::text, effective_to::text, approved_by, reviewed_on::text, review_ref, created_at from rule_packs order by id, effective_from desc nulls last, created_at desc`,
}));
publicRoutes.get('/signing-key', async (c) => {
  try { return c.json({ alg: 'Ed25519', key: await publicKey(c.env) }); }
  catch { throw new ApiError(501, 'not_configured', 'Receipt signing is not configured on this deployment.'); }
});
publicRoutes.post('/receipts/verify', async (c) => {
  const { receipt, signature } = await body(c, z.object({ receipt: z.record(z.string(), z.unknown()), signature: z.string().min(10) }));
  let valid = false;
  try { valid = await verifyReceipt(c.env, receipt, signature); } catch { valid = false; }
  return c.json({ valid, message: valid ? 'Signature is valid. This receipt was issued by Laissez and has not been altered.' : 'Signature does not match. The receipt was altered or was not issued by Laissez.' });
});

// ---------- Organization ----------
routes.get('/workspace', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [[w], [counts]] = await Promise.all([
    sql`select id, name, kind, slug, brand_name, brand_color, created_at, expires_at from workspaces where id = ${ws}`,
    sql`select (select count(*)::int from investors where workspace_id = ${ws}) as investors, (select count(*)::int from funds where workspace_id = ${ws}) as funds,
      (select count(*)::int from decisions where workspace_id = ${ws}) as decisions, (select count(*)::int from settlements where workspace_id = ${ws}) as settlements`,
  ]);
  return c.json({ ...w, counts });
});

routes.get('/metrics', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [daily, totals, reasons, value, reuse, expiring, network, ttfs, shares, needs, crossBorder] = await Promise.all([
    sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, outcome, count(*)::int as n from decisions where workspace_id = ${ws} and created_at > now() - interval '14 days' group by 1, 2 order by 1`,
    sql`select count(*)::int as decisions, count(*) filter (where outcome = 'ALLOW')::int as allowed, count(*) filter (where outcome = 'DENY')::int as denied, count(*) filter (where outcome = 'FREEZE')::int as frozen from decisions where workspace_id = ${ws}`,
    sql`select ch->>'label' as label, count(*)::int as n from decisions d, jsonb_array_elements(d.checks) ch where d.workspace_id = ${ws} and ch->>'result' = 'fail' group by 1 order by 2 desc limit 6`,
    sql`select f.currency, coalesce(sum(d.amount), 0)::float8 as value, count(*)::int as n from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker where s.workspace_id = ${ws} and s.status = 'settled' group by 1`,
    sql`select count(*) filter (where funds >= 2)::int as reused, count(*)::int as total from (select investor_id, count(distinct ticker) as funds from decisions where workspace_id = ${ws} and outcome = 'ALLOW' group by 1) t`,
    sql`select count(*)::int as n from credentials where workspace_id = ${ws} and status = 'active' and expires_on between current_date and current_date + 30`,
    sql`select count(*)::int as n from investors i where i.workspace_id = ${ws} and i.relied_share is not null
      and exists (select 1 from decisions d where d.workspace_id = i.workspace_id and d.investor_id = i.id and d.outcome = 'ALLOW')`,
    // Hours from a client's first credential (own, or a relied-on share once the client consented) to their first settled order.
    sql`with first_cred as (
        select investor_id, min(at) as at from (
          select investor_id, created_at as at from credentials where workspace_id = ${ws}
          union all
          select to_investor_id, consent_at from credential_shares where to_workspace = ${ws} and to_investor_id is not null and consent_at is not null
        ) x group by 1
      ), first_stl as (
        select d.investor_id, min(s.created_at) as at from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
        where s.workspace_id = ${ws} and s.status = 'settled' group by 1
      )
      select percentile_cont(0.5) within group (order by extract(epoch from fs.at - fc.at) / 3600.0)::float8 as hours, count(*)::int as investors
      from first_cred fc join first_stl fs on fs.investor_id = fc.investor_id where fs.at >= fc.at`,
    sql`select count(*) filter (where to_workspace = ${ws} and status = 'active')::int as relied_on,
        count(*) filter (where from_workspace = ${ws} and status = 'active')::int as shared_out,
        count(*) filter (where status = 'pending')::int as pending
      from credential_shares where from_workspace = ${ws} or to_workspace = ${ws}`,
    sql`select (select count(*)::int from approval_requests where workspace_id = ${ws} and status = 'pending') as approvals,
        (select count(*)::int from work_items where workspace_id = ${ws} and status = 'open') as work_items,
        (select count(*)::int from portal_requests where workspace_id = ${ws} and status = 'submitted') as portal_requests`,
    // Cross-border: the acquiring (or exiting) investor resides outside the fund's domicile. Same definition as GET /v1/metrics/public.
    sql`select f.currency, coalesce(sum(d.amount), 0)::float8 as value, count(*)::int as n
      from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
      join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker
      join investors i on i.workspace_id = d.workspace_id and i.id = case when d.action = 'transfer' and d.counterparty_id is not null then d.counterparty_id else d.investor_id end
      where s.workspace_id = ${ws} and s.status = 'settled' and d.outcome = 'ALLOW'
        and i.residence is distinct from (case f.domicile when 'British Virgin Islands' then 'VG' when 'Ireland' then 'IE' when 'Delaware, United States' then 'US' when 'Luxembourg' then 'LU' when 'Singapore' then 'SG' when 'Cayman Islands' then 'KY' else null end)
      group by 1 order by 1`,
  ]);
  const t = totals[0];
  return c.json({
    totals: { ...t, allow_rate: t.decisions ? t.allowed / t.decisions : null },
    daily, top_refusal_reasons: reasons, settled_value: value,
    cross_border_settled_value: crossBorder,
    credential_reuse: { investors_with_two_or_more_funds: reuse[0].reused, investors_with_allowed_orders: reuse[0].total, rate: reuse[0].total ? reuse[0].reused / reuse[0].total : null },
    credential_reuse_network: network[0].n,
    credentials_expiring_30d: expiring[0].n,
    time_to_first_settlement_hours_median: ttfs[0].hours == null ? null : Math.round(Number(ttfs[0].hours) * 10) / 10,
    time_to_first_settlement_investors: ttfs[0].investors,
    network: { relied_on: shares[0].relied_on, shared_out: shares[0].shared_out, pending_shares: shares[0].pending },
    needs_you: { approvals: needs[0].approvals, work_items: needs[0].work_items, portal_requests: needs[0].portal_requests, shares: shares[0].pending },
  });
});

// ---------- Investors ----------
export const investorIn = z.object({
  name: z.string().trim().min(2).max(120), kind: z.string().trim().min(2).max(60), residence: z.string().min(2).max(10), city: z.string().trim().min(1).max(80),
  booking_center: z.string().min(2).max(10), us_person: z.boolean().default(false), wallet: z.string().max(80).optional(), email: z.string().trim().toLowerCase().email().max(160).optional(),
});
function credentialStatus(i: Investor, t: string) {
  if (i.reliedShare && i.shareStatus && i.shareStatus !== 'active') return i.shareStatus === 'pending' ? 'share_pending' : 'relied_invalid';
  if (!i.credentialId) return 'none';
  if (i.expires < t) return 'lapsed';
  return i.classifications.some((x) => x.expires < t) ? 'partly_lapsed' : 'active';
}
const CRED_FILTERS = ['active', 'none', 'lapsed', 'share_pending'] as const;
/**
 * Clients, newest first, with cursor pagination. Filters: q (name, city, id or passport number), residence,
 * booking_center, credential_status (active, none, lapsed, share_pending). Without limit or cursor the first 50 come back.
 */
routes.get('/investors', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const page = pageParams(c, 50, 200);
  const q = (c.req.query('q') ?? '').trim().slice(0, 80) || null;
  const residence = c.req.query('residence') || null; const booking = c.req.query('booking_center') || null;
  const credRaw = c.req.query('credential_status') || null;
  if (credRaw && !(CRED_FILTERS as readonly string[]).includes(credRaw)) throw new ApiError(400, 'invalid_filter', `credential_status must be one of ${CRED_FILTERS.join(', ')}.`);
  const cred = credRaw as (typeof CRED_FILTERS)[number] | null;
  const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  // The credential filter is decided in SQL from the active credential or the relied-on share, so pages stay full.
  const ids = await sql`select i.id, i.created_at from investors i
      left join lateral (select expires_on from credentials c where c.workspace_id = i.workspace_id and c.investor_id = i.id and c.status = 'active' order by c.created_at desc limit 1) c on true
      left join credential_shares sh on sh.id = i.relied_share
    where i.workspace_id = ${ws}
      and (${like}::text is null or i.name ilike ${like} or i.city ilike ${like} or i.id ilike ${like}
        or exists (select 1 from credentials cx where cx.workspace_id = i.workspace_id and cx.investor_id = i.id and cx.lzid ilike ${like}))
      and (${residence}::text is null or i.residence = ${residence})
      and (${booking}::text is null or i.booking_center = ${booking})
      and (${cred}::text is null
        or (${cred} = 'none' and c.expires_on is null and i.relied_share is null)
        or (${cred} = 'lapsed' and c.expires_on is not null and c.expires_on < current_date)
        or (${cred} = 'share_pending' and sh.status = 'pending')
        or (${cred} = 'active' and ((c.expires_on is not null and c.expires_on >= current_date) or sh.status = 'active')))
      and (${page.at}::timestamptz is null or (i.created_at, i.id) < (${page.at}::timestamptz, ${page.id}))
    order by i.created_at desc, i.id desc limit ${page.limit + 1}`;
  const out = pageOut(ids as any[], page);
  const keep = out.data.map((r: any) => r.id as string);
  const [invs, g] = await Promise.all([keep.length ? loadInvestors(sql, ws, keep, adminOf(c)) : Promise.resolve({} as Record<string, Investor>), loadGlobals(sql)]);
  const t = today();
  return c.json({
    ...out,
    data: keep.map((id) => invs[id]).filter(Boolean).map((i) => ({ ...i, credential_status: credentialStatus(i, t), residence_name: g.jurName[i.residence] })),
    filters: { q, residence, booking_center: booking, credential_status: cred },
  });
});
routes.post('/investors', async (c) => {
  const a = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const g = await loadGlobals(sql);
  const b = await body(c, investorIn);
  if (!g.jurName[b.residence] || b.residence === 'GLOBAL') throw new ApiError(422, 'unknown_jurisdiction', `Residence ${b.residence} is not a supported jurisdiction. See GET /v1/jurisdictions.`);
  if (!g.bookingCenters[b.booking_center]) throw new ApiError(422, 'unknown_booking_center', `Booking center ${b.booking_center} does not exist. See GET /v1/booking-centers.`);
  const invId = id('inv', 10);
  const wallet = b.wallet || `0x${rand(4, '0123456789abcdef')}…${rand(4, '0123456789abcdef')}`;
  await sql.transaction([
    sql`insert into investors (workspace_id, id, name, short_name, kind, residence, city, booking_center, us_person, wallet, email)
      values (${ws}, ${invId}, ${b.name}, ${b.name.split(/\s+/).slice(0, 3).join(' ')}, ${b.kind}, ${b.residence}, ${b.city}, ${b.booking_center}, ${b.us_person || b.residence === 'US'}, ${wallet}, ${b.email ?? null})`,
    auditQ(sql, ws, a, 'investor.created', invId, { name: b.name, residence: b.residence, booking_center: b.booking_center }),
  ]);
  return c.json((await loadInvestors(sql, ws, [invId]))[invId], 201);
});
routes.get('/investors/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const [ctx, decisions, creds] = await Promise.all([
    buildCtx(sql, ws, [invId], null, adminOf(c)),
    sql`select id, action, ticker, amount::float8 as amount, outcome, headline, dealing_date::text, created_at from decisions where workspace_id = ${ws} and (investor_id = ${invId} or counterparty_id = ${invId}) order by created_at desc limit 20`,
    sql`select id, lzid, issuer_name, issued_on::text, expires_on::text, status, revoked_at from credentials where workspace_id = ${ws} and investor_id = ${invId} order by created_at desc limit 20`,
  ]);
  const inv = ctx.investors[invId];
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const holdings = Object.entries(inv.holdings).map(([t, h]) => {
    const f = ctx.funds[t];
    const lock = f?.lockupMonths ? addDays(h!.since, Math.round(f.lockupMonths * 30.44)) : null;
    return { ticker: t, fund: f?.short, units: h!.units, value: f ? +(h!.units * f.nav).toFixed(2) : null, currency: f?.currency, since: h!.since, lockup_ends: lock && lock > ctx.today ? lock : null, ...(f ? holderStatus(inv, f, ctx) : { status: 'unknown', reason: '' }) };
  });
  return c.json({ ...inv, credential_status: credentialStatus(inv, ctx.today), holdings_detail: holdings, recent_decisions: decisions, credentials: creds });
});

// ---------- Credentials ----------
export const credentialIn = z.object({
  investor_id: z.string(),
  valid_months: z.number().int().min(1).max(24).default(12),
  classifications: z.array(z.object({ class_code: z.string(), evidence: z.record(z.string(), z.union([z.number(), z.boolean()])).default({}), evidence_ref: z.string().max(200).optional() })).max(10),
});
export type CredentialInput = z.input<typeof credentialIn>;
/**
 * Verifies each classification against its legal threshold and issues a new credential, revoking the investor's
 * active one. Shared by POST /v1/credentials and evidence accept-and-issue. Callers check permissions first.
 */
export type CarriedClass = { class_code: string; basis: string; opt_in_on: string | null };
export async function issueCredential(c: C, input: CredentialInput, a: Actor = c.get('actor'), opts: { carry?: CarriedClass[] } = {}) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = credentialIn.parse(input);
  // Classifications carried over from the credential being replaced keep their basis; they are not re-tested.
  const carry = (opts.carry ?? []).filter((x) => !b.classifications.some((y) => y.class_code === x.class_code));
  const [g, invs, [w]] = await Promise.all([loadGlobals(sql), loadInvestors(sql, ws, [b.investor_id]), sql`select name, brand_name from workspaces where id = ${ws}`]);
  const inv = invs[b.investor_id];
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${b.investor_id} in this organization.`);
  const results = b.classifications.map((x) => {
    const meta = g.classInfo[x.class_code];
    if (!meta) return { class_code: x.class_code, pass: false, reason: `Unknown classification ${x.class_code}. See GET /v1/investor-classes.` };
    const test = findTest(x.class_code, inv.kind);
    if (!test) return { class_code: x.class_code, pass: false, reason: `${meta.label} is not available to a ${inv.kind.toLowerCase()}.` };
    return { class_code: x.class_code, ...test.check(x.evidence), label: meta.label, jurisdiction: meta.jur };
  });
  if (results.some((r) => !r.pass)) throw new ApiError(422, 'threshold_not_met', 'One or more classifications do not meet their legal threshold. Nothing was issued.', results);
  const start = today(); const end = addDays(start, Math.round(b.valid_months * 30.44));
  const jur = inv.residence === 'AE-DIFC' ? 'AE' : inv.residence;
  const credId = `LP-${jur}-${digits(4)}-${digits(4)}`;
  const passport = lzid();
  const issuer = w?.brand_name ?? w?.name ?? 'Laissez sandbox';
  await sql.transaction([
    sql`update credentials set status = 'revoked', revoked_at = now() where workspace_id = ${ws} and investor_id = ${inv.id} and status = 'active'`,
    sql`insert into credentials (workspace_id, id, investor_id, issued_on, expires_on, lzid, issuer_name) values (${ws}, ${credId}, ${inv.id}, ${start}, ${end}, ${passport}, ${issuer})`,
    ...b.classifications.map((x, i) => sql`insert into classifications (workspace_id, credential_id, class_code, basis, verified_on, expires_on, opt_in_on)
      values (${ws}, ${credId}, ${x.class_code}, ${x.evidence_ref ? `${results[i].reason} Evidence: ${x.evidence_ref}` : results[i].reason}, ${start}, ${end}, ${x.evidence.opt_in ? start : null})`),
    ...carry.map((x) => sql`insert into classifications (workspace_id, credential_id, class_code, basis, verified_on, expires_on, opt_in_on)
      values (${ws}, ${credId}, ${x.class_code}, ${x.basis}, ${start}, ${end}, ${x.opt_in_on})`),
    // Issuing your own credential replaces any credential relied on from another distributor.
    sql`update investors set relied_share = null where workspace_id = ${ws} and id = ${inv.id}`,
    auditQ(sql, ws, a, 'credential.issued', credId, { investor: inv.id, lzid: passport, classes: [...b.classifications.map((x) => x.class_code), ...carry.map((x) => x.class_code)], carried: carry.map((x) => x.class_code), replaced: inv.credentialId || null, relied_share_cleared: inv.reliedShare ?? null }),
  ]);
  bg(c, Promise.all([
    emit(sql, ws, 'credential.issued', { credential: credId, lzid: passport, investor: inv.id }),
    // A renewal re-issues the on-chain claim with the new expiry for an onboarded investor.
    onCredentialIssued(c, inv.id),
  ]));
  return { credential_id: credId, lzid: passport, issuer_name: issuer, issued_on: start, expires_on: end, checks: results, investor: (await loadInvestors(sql, ws, [inv.id]))[inv.id] };
}
routes.post('/credentials', async (c) => {
  const a = need(c, 'clients:write');
  const input = await body(c, credentialIn);
  const [inv] = await c.get('sql')`select id, name, kind from investors where workspace_id = ${c.get('ws')} and id = ${input.investor_id}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${input.investor_id} in this organization.`);
  // Maker-checker: the organization's credential.issue policy decides whether a second person must approve first.
  const res = await requireApproval(c, 'credential.issue', inv.id, { input, investor_kind: inv.kind, investor_name: inv.name, classes: input.classifications.map((x) => x.class_code) }, () => issueCredential(c, input, a), {
    title: `Issue credential to ${inv.name} (${input.classifications.map((x) => x.class_code).join(', ')})`, link: `#/clients/${inv.id}`,
  });
  if (isPending(res)) return c.json(res, 202);
  return c.json(res, 201);
});
routes.get('/credentials', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const within = Math.max(0, Math.min(365, Number(c.req.query('expiring_within') ?? 0) || 0));
  const rows = within
    ? await sql`select c.id, c.lzid, c.issuer_name, c.investor_id, i.name, c.issued_on::text, c.expires_on::text, c.status, c.revoked_at from credentials c join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id
        where c.workspace_id = ${ws} and c.status = 'active' and c.expires_on <= current_date + ${within}::int order by c.expires_on`
    : await sql`select c.id, c.lzid, c.issuer_name, c.investor_id, i.name, c.issued_on::text, c.expires_on::text, c.status, c.revoked_at from credentials c join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id
        where c.workspace_id = ${ws} order by c.created_at desc limit 500`;
  return c.json({ data: rows });
});
routes.post('/credentials/:id/revoke', async (c) => {
  const a = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const credId = c.req.param('id');
  const { reason } = await body(c, z.object({ reason: z.string().max(300).optional() }));
  const [r] = await sql.transaction([
    sql`update credentials set status = 'revoked', revoked_at = now() where workspace_id = ${ws} and id = ${credId} and status = 'active' returning investor_id, lzid, revoked_at`,
  ]);
  if (!r.length) throw new ApiError(404, 'not_found', `No active credential ${credId}. It may already be revoked.`);
  const investorId = r[0].investor_id;
  await audit(sql, ws, a, 'credential.revoked', credId, { investor: investorId, lzid: r[0].lzid, reason: reason ?? null });
  bg(c, Promise.all([
    onCredentialRevoked(c, investorId),
    emit(sql, ws, 'credential.revoked', { credential: credId, investor: investorId }),
    emit(sql, ws, 'holder.status_changed', { investor: investorId, reason: 'credential_revoked' }),
  ]));
  return c.json({ revoked: credId, investor_id: investorId, revoked_at: r[0].revoked_at });
});

// ---------- Funds ----------
const termsIn = {
  cutoff_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  cutoff_tz: z.string().min(1).max(60).optional(),
  dealing_frequency: z.enum(['daily', 'monthly', 'quarterly']).optional(),
  notice_days: z.number().int().min(0).max(365).optional(),
  gate_pct: z.number().positive().max(100).nullable().optional(),
  share_class_type: z.enum(['distributing', 'accumulating']).optional(),
};
const initialDocIn = z.object({
  doc_type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use a lowercase type such as offering_memorandum.'),
  title: z.string().trim().min(3).max(140),
  content: z.string().min(50, 'Document content is too short.').max(200_000),
  jurisdiction: z.string().max(12).nullable().optional(),
  audience: z.enum(['all', 'retail', 'professional']).default('all'),
  required: z.boolean().optional(),
});
export const fundIn = z.object({
  ticker: z.string().regex(/^[A-Z]{3,6}$/), name: z.string().trim().min(3).max(140), domicile: z.string().trim().min(2).max(80), structure: z.string().trim().min(3).max(160),
  currency: z.enum(['USD', 'EUR']), nav: z.number().positive(), reg_s: z.boolean(), min_subscription: z.number().nonnegative(),
  holder_cap: z.number().int().positive().nullable().default(null), lockup_months: z.number().int().positive().nullable().default(null),
  /** Closed-end funds take money only through capital calls against commitments (see POST /v1/funds/{ticker}/commitments). */
  fund_type: z.enum(['open_ended', 'closed_end']).default('open_ended'),
  assets: z.array(z.string().min(2).max(20)).min(1).max(8), chains: z.array(z.string().min(2).max(40)).min(1).max(8), issuer: z.string().trim().min(2).max(120),
  distribution: z.array(z.object({ jurisdiction: z.string(), accepts: z.array(z.string()).min(1) })).min(1),
  ...termsIn,
  yield_bps: z.number().min(0).max(5000).nullable().optional(),
  /** Initial documents, published as version 1 with the fund. */
  documents: z.array(initialDocIn).max(12).default([]),
});
function validTz(tz: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

routes.get('/funds', async (c) => { need(c, 'read'); return c.json({ data: Object.values(await loadFunds(c.get('sql'), c.get('ws'), null)) }); });
routes.get('/funds/:ticker', async (c) => {
  need(c, 'read');
  const t = c.req.param('ticker');
  const f = (await loadFunds(c.get('sql'), c.get('ws'), t))[t];
  if (!f) throw new ApiError(404, 'not_found', `No fund ${t} in this organization.`);
  return c.json(f);
});
routes.post('/funds', async (c) => {
  const a = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const g = await loadGlobals(sql);
  const b = await body(c, fundIn);
  for (const d of b.distribution) {
    if (!lawDefaults(d.jurisdiction, b.reg_s)) throw new ApiError(422, 'unsupported_jurisdiction', `No launch rule pack covers ${d.jurisdiction} yet. Remove it from the distribution list.`);
    for (const x of d.accepts) if (!g.classInfo[x]) throw new ApiError(422, 'unknown_class', `Unknown investor class ${x}. See GET /v1/investor-classes.`);
  }
  if (b.reg_s && b.distribution.some((d) => d.jurisdiction === 'US')) throw new ApiError(422, 'conflict', 'A Regulation S fund cannot be offered to U.S. investors. Remove US or turn off Regulation S.');
  if (b.cutoff_tz && !validTz(b.cutoff_tz)) throw new ApiError(422, 'invalid_time_zone', `${b.cutoff_tz} is not an IANA time zone. Use a name like America/New_York.`);
  for (const d of b.documents) {
    if (d.jurisdiction && !g.jurName[d.jurisdiction]) throw new ApiError(422, 'unknown_jurisdiction', `Document "${d.title}" names unknown jurisdiction ${d.jurisdiction}. Leave it empty for a document that applies everywhere.`);
  }
  const docKeys = b.documents.map((d) => `${d.doc_type}|${d.jurisdiction ?? ''}`);
  if (new Set(docKeys).size !== docKeys.length) throw new ApiError(422, 'duplicate_document', 'Each document type can appear once per jurisdiction at creation. Publish later versions from the fund page.');
  const docRows = await Promise.all(b.documents.map(async (d) => ({ ...d, id: id('doc', 12), jurisdiction: d.jurisdiction || null, required: d.required ?? d.doc_type !== 'factsheet', sha256: await sha256(d.content) })));
  const exists = await sql`select 1 from funds where workspace_id = ${ws} and ticker = ${b.ticker}`;
  if (exists.length) throw new ApiError(409, 'exists', `A fund with ticker ${b.ticker} already exists. Pick another ticker.`);
  const dist = Object.fromEntries(b.distribution.map((d) => { const l = lawDefaults(d.jurisdiction, b.reg_s)!; return [d.jurisdiction, { accepts: d.accepts, basis: l.basis, lawRequires: l.lawRequires, lawText: l.lawText, lawRef: l.lawRef, lawSource: l.lawSource }]; }));
  const usAccepts = b.reg_s ? null : b.distribution.find((d) => d.jurisdiction === 'US')?.accepts ?? null;
  await sql.transaction([
    sql`insert into funds (workspace_id, ticker, name, short_name, domicile, structure, currency, nav, reg_s, us_accepts, min_subscription, holder_cap, holders, lockup_months, assets, chains, issuer,
        cutoff_time, cutoff_tz, dealing_frequency, notice_days, gate_pct, share_class_type, yield_bps, fund_type)
      values (${ws}, ${b.ticker}, ${b.name}, ${b.name.split(',')[0].slice(0, 60)}, ${b.domicile}, ${b.structure}, ${b.currency}, ${b.nav}, ${b.reg_s}, ${usAccepts}, ${b.min_subscription}, ${b.holder_cap}, 0, ${b.lockup_months}, ${b.assets}, ${b.chains}, ${b.issuer},
        ${b.cutoff_time ?? '16:00'}, ${b.cutoff_tz ?? 'America/New_York'}, ${b.dealing_frequency ?? 'daily'}, ${b.notice_days ?? 0}, ${b.gate_pct ?? null}, ${b.share_class_type ?? 'distributing'}, ${b.yield_bps ?? null}, ${b.fund_type})`,
    ...docRows.map((d) => sql`insert into fund_documents (workspace_id, id, ticker, doc_type, title, version, jurisdiction, audience, content, sha256, required, published_by)
      values (${ws}, ${d.id}, ${b.ticker}, ${d.doc_type}, ${d.title}, 1, ${d.jurisdiction}, ${d.audience}, ${d.content}, ${d.sha256}, ${d.required}, ${a.name})`),
    ...docRows.map((d) => auditQ(sql, ws, a, 'document.published', d.id, { ticker: b.ticker, doc_type: d.doc_type, title: d.title, version: 1, jurisdiction: d.jurisdiction, audience: d.audience, required: d.required, sha256: d.sha256, supersedes: null, at_creation: true })),
    ...Object.entries(dist).map(([j, l]) => sql`insert into fund_distribution (workspace_id, ticker, jurisdiction, accepts, basis, law_requires, law_requires_any, law_text, law_ref, law_source)
      values (${ws}, ${b.ticker}, ${j}, ${l.accepts}, ${l.basis}, ${l.lawRequires}, ${(l as any).lawRequiresAny ?? (l.lawRequires ? [l.lawRequires] : null)}, ${l.lawText}, ${l.lawRef}, ${l.lawSource})`),
    sql`insert into fund_policy_versions (workspace_id, ticker, version, distribution, min_subscription, holder_cap, lockup_months, published_by)
      values (${ws}, ${b.ticker}, 1, ${JSON.stringify(dist)}, ${b.min_subscription}, ${b.holder_cap}, ${b.lockup_months}, ${a.name})`,
    auditQ(sql, ws, a, 'fund.created', b.ticker, { name: b.name, fund_type: b.fund_type, distribution: Object.keys(dist), chains: b.chains, documents: docRows.map((d) => d.id), terms: { cutoff_time: b.cutoff_time ?? '16:00', cutoff_tz: b.cutoff_tz ?? 'America/New_York', dealing_frequency: b.dealing_frequency ?? 'daily', notice_days: b.notice_days ?? 0, gate_pct: b.gate_pct ?? null, share_class_type: b.share_class_type ?? 'distributing', yield_bps: b.yield_bps ?? null } }),
  ]);
  return c.json({ ...(await loadFunds(sql, ws, b.ticker))[b.ticker], documents: docRows.map((d) => ({ id: d.id, doc_type: d.doc_type, title: d.title, version: 1, jurisdiction: d.jurisdiction, required: d.required, sha256: d.sha256 })) }, 201);
});

async function registerFor(c: C, ticker: string) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [funds, holders] = await Promise.all([loadFunds(sql, ws, ticker), sql`select investor_id from holdings where workspace_id = ${ws} and ticker = ${ticker} and units > 0`]);
  const f = funds[ticker];
  if (!f) throw new ApiError(404, 'not_found', `No fund ${ticker} in this organization.`);
  const ctx = await buildCtx(sql, ws, holders.map((h) => h.investor_id), ticker, adminOf(c));
  const rows = Object.values(ctx.investors).map((inv) => ({
    investor_id: inv.id, name: inv.name, residence: inv.residence, units: inv.holdings[ticker]?.units ?? 0, value: +((inv.holdings[ticker]?.units ?? 0) * f.nav).toFixed(2), since: inv.holdings[ticker]?.since,
    ...holderStatus(inv, f, ctx),
  }));
  return { f, ctx, rows };
}
routes.get('/funds/:ticker/register', async (c) => {
  need(c, 'read');
  const { f, rows } = await registerFor(c, c.req.param('ticker'));
  return c.json({ fund: f.ticker, holder_cap: f.holderCap, total_holders_of_record: f.holders, sandbox_holders: rows.length, data: rows });
});

// ---------- Fund policy: preview, propose, approve ----------
export const policyIn = z.object({
  distribution: z.array(z.object({ jurisdiction: z.string(), accepts: z.array(z.string()).min(1) })).min(1),
  min_subscription: z.number().nonnegative().optional(), holder_cap: z.number().int().positive().nullable().optional(), lockup_months: z.number().int().positive().nullable().optional(),
});
type PolicyIn = z.infer<typeof policyIn>;

async function validatePolicy(sql: Sql, f: Fund, p: PolicyIn) {
  const g = await loadGlobals(sql);
  for (const d of p.distribution) {
    if (!f.distribution[d.jurisdiction] && !lawDefaults(d.jurisdiction, f.regS)) throw new ApiError(422, 'unsupported_jurisdiction', `No launch rule pack covers ${d.jurisdiction} yet. Remove it from the distribution list.`);
    if (f.regS && d.jurisdiction === 'US') throw new ApiError(422, 'conflict', `${f.short} is a Regulation S fund, so it cannot be offered in the United States.`);
    for (const x of d.accepts) if (!g.classInfo[x]) throw new ApiError(422, 'unknown_class', `Unknown investor class ${x}. See GET /v1/investor-classes.`);
  }
  if (new Set(p.distribution.map((d) => d.jurisdiction)).size !== p.distribution.length) throw new ApiError(422, 'duplicate_jurisdiction', 'Each jurisdiction can appear once in the distribution list.');
}
/** The fund as it would be under a proposed policy. Existing law text is kept; new jurisdictions take the launch rules. */
function applyPolicy(f: Fund, p: PolicyIn): Fund {
  return {
    ...f,
    distribution: Object.fromEntries(p.distribution.map((d) => [d.jurisdiction, { ...(f.distribution[d.jurisdiction] ?? lawDefaults(d.jurisdiction, f.regS)!), accepts: d.accepts }])),
    minSubscription: p.min_subscription ?? f.minSubscription,
    holderCap: p.holder_cap === undefined ? f.holderCap : p.holder_cap,
    lockupMonths: p.lockup_months === undefined ? f.lockupMonths : p.lockup_months,
  } as Fund;
}
async function previewPolicy(c: C, ticker: string, p: PolicyIn) {
  const { f, ctx, rows } = await registerFor(c, ticker);
  await validatePolicy(c.get('sql'), f, p);
  const next = applyPolicy(f, p);
  const affected = Object.values(ctx.investors).map((inv) => ({ inv, before: holderStatus(inv, f, ctx), after: holderStatus(inv, next, ctx) })).filter((x) => x.before.status !== x.after.status);
  return {
    removed: Object.keys(f.distribution).filter((j) => !p.distribution.some((d) => d.jurisdiction === j)),
    added: p.distribution.map((d) => d.jurisdiction).filter((j) => !f.distribution[j]),
    holders_affected: affected.map((x) => ({ investor_id: x.inv.id, name: x.inv.name, from: x.before.status, to: x.after.status, units: x.inv.holdings[ticker]?.units ?? 0, value: +((x.inv.holdings[ticker]?.units ?? 0) * f.nav).toFixed(2) })),
    value_affected: +affected.reduce((s, x) => s + (x.inv.holdings[ticker]?.units ?? 0) * f.nav, 0).toFixed(2),
    currency: f.currency, sandbox_holders: rows.length, current_policy_version: f.policyVersion ?? 1,
    note: 'Holders who lose eligibility move to redemption-only. They keep their units and can always redeem. Nobody is force-redeemed.',
  };
}
routes.post('/funds/:ticker/policy/preview', async (c) => {
  need(c, 'read');
  return c.json(await previewPolicy(c, c.req.param('ticker'), await body(c, policyIn)));
});
routes.post('/funds/:ticker/policy/changes', async (c) => {
  const a = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const ticker = c.req.param('ticker');
  // Legacy clients sent proposed_by; the proposer is now always the signed-in person or key.
  const b = await body(c, policyIn.extend({ proposed_by: z.unknown().optional() }));
  const p: PolicyIn = { distribution: b.distribution, min_subscription: b.min_subscription, holder_cap: b.holder_cap, lockup_months: b.lockup_months };
  const impact = await previewPolicy(c, ticker, p);
  const pcId = id('pc', 10);
  await sql.transaction([
    sql`insert into policy_changes (workspace_id, id, ticker, proposed_by, proposed_by_user, status, changes, impact) values (${ws}, ${pcId}, ${ticker}, ${a.name}, ${a.userId ?? null}, 'draft', ${JSON.stringify(p)}, ${JSON.stringify(impact)})`,
    auditQ(sql, ws, a, 'policy.proposed', pcId, { ticker, removed: impact.removed, added: impact.added, holders_affected: impact.holders_affected.length }),
  ]);
  bg(c, notifyRoles(sql, ws, APPROVER_ROLES, {
    kind: 'policy.proposed', title: `Policy change for ${ticker} needs a second approver`, link: '#/policy-changes',
    body: `${a.name} proposed ${pcId}: ${impact.holders_affected.length} holder${impact.holders_affected.length === 1 ? '' : 's'} affected${impact.added.length ? `, adds ${impact.added.join(', ')}` : ''}${impact.removed.length ? `, removes ${impact.removed.join(', ')}` : ''}. Nothing changes until someone else approves it.`,
  }, a.userId ?? null));
  return c.json({ id: pcId, status: 'draft', ticker, proposed_by: a.name, impact }, 201);
});
routes.get('/policy-changes', async (c) => {
  need(c, 'read');
  return c.json({ data: await c.get('sql')`select * from policy_changes where workspace_id = ${c.get('ws')} order by created_at desc limit 200` });
});

async function loadDraft(c: C, pcId: string) {
  const [pc] = await c.get('sql')`select * from policy_changes where workspace_id = ${c.get('ws')} and id = ${pcId}`;
  if (!pc) throw new ApiError(404, 'not_found', `No policy change ${pcId}.`);
  if (pc.status !== 'draft') throw new ApiError(409, 'not_draft', `This change is already ${pc.status}. Propose a new change to make further edits.`);
  const a = c.get('actor');
  const same = pc.proposed_by_user ? pc.proposed_by_user === a.userId : String(pc.proposed_by).trim().toLowerCase() === a.name.trim().toLowerCase();
  if (same) throw new ApiError(403, 'same_person', `You proposed this change. A second person must approve it.${c.get('wsKind') === 'sandbox' ? ' Switch to a teammate to try it.' : ''}`);
  return pc;
}
routes.post('/policy-changes/:id/approve', async (c) => {
  const a = need(c, 'policy:approve');
  const sql = c.get('sql'); const ws = c.get('ws');
  const pc = await loadDraft(c, c.req.param('id'));
  const ch = pc.changes as PolicyIn;
  const f = (await loadFunds(sql, ws, pc.ticker))[pc.ticker];
  if (!f) throw new ApiError(404, 'not_found', `Fund ${pc.ticker} no longer exists.`);
  const next = applyPolicy(f, ch);
  const dist = next.distribution;
  try {
    await sql.transaction([
      // Fails with division by zero if another approver got there first, which aborts the whole transaction.
      sql`select 1 / count(*)::int from (select 1 from policy_changes where workspace_id = ${ws} and id = ${pc.id} and status = 'draft' for update) x`,
      sql`delete from fund_distribution where workspace_id = ${ws} and ticker = ${pc.ticker}`,
      ...Object.entries(dist).map(([j, l]) => sql`insert into fund_distribution (workspace_id, ticker, jurisdiction, accepts, basis, law_requires, law_requires_any, law_text, law_ref, law_source)
        values (${ws}, ${pc.ticker}, ${j}, ${l!.accepts}, ${l!.basis}, ${l!.lawRequires}, ${(l as any).lawRequiresAny ?? (l!.lawRequires ? [l!.lawRequires] : null)}, ${l!.lawText}, ${l!.lawRef}, ${l!.lawSource})`),
      sql`update funds set policy_version = policy_version + 1, min_subscription = ${next.minSubscription}, holder_cap = ${next.holderCap}, lockup_months = ${next.lockupMonths} where workspace_id = ${ws} and ticker = ${pc.ticker}`,
      sql`insert into fund_policy_versions (workspace_id, ticker, version, effective_at, distribution, min_subscription, holder_cap, lockup_months, published_by)
        select workspace_id, ticker, policy_version, now(), ${JSON.stringify(dist)}, min_subscription, holder_cap, lockup_months, ${a.name} from funds where workspace_id = ${ws} and ticker = ${pc.ticker}`,
      sql`update policy_changes set status = 'published', approved_by = ${a.name}, approved_by_user = ${a.userId ?? null}, decided_at = now() where workspace_id = ${ws} and id = ${pc.id}`,
      auditQ(sql, ws, a, 'policy.published', pc.id, { ticker: pc.ticker, proposed_by: pc.proposed_by, approved_by: a.name, policy_version: (f.policyVersion ?? 1) + 1 }),
    ]);
  } catch (e: any) {
    if (String(e?.message ?? '').includes('division by zero')) throw new ApiError(409, 'not_draft', 'Someone else decided this change a moment ago. Reload to see its status.');
    throw e;
  }
  bg(c, Promise.all([onPolicyPublished(c, pc.ticker), emit(sql, ws, 'policy.published', { policy_change: pc.id, ticker: pc.ticker, policy_version: (f.policyVersion ?? 1) + 1, impact: pc.impact })]));
  return c.json({ id: pc.id, status: 'published', ticker: pc.ticker, policy_version: (f.policyVersion ?? 1) + 1, proposed_by: pc.proposed_by, approved_by: a.name });
});
routes.post('/policy-changes/:id/reject', async (c) => {
  const a = need(c, 'policy:approve');
  const sql = c.get('sql'); const ws = c.get('ws');
  const pc = await loadDraft(c, c.req.param('id'));
  const { reason } = await body(c, z.object({ reason: z.string().max(500).optional() }));
  const [r] = await sql.transaction([
    sql`update policy_changes set status = 'rejected', approved_by = ${a.name}, approved_by_user = ${a.userId ?? null}, decided_at = now() where workspace_id = ${ws} and id = ${pc.id} and status = 'draft' returning id`,
    auditQ(sql, ws, a, 'policy.rejected', pc.id, { ticker: pc.ticker, by: a.name, reason: reason ?? null }),
  ]);
  if (!r.length) throw new ApiError(409, 'not_draft', 'Someone else decided this change a moment ago. Reload to see its status.');
  return c.json({ id: pc.id, status: 'rejected', rejected_by: a.name });
});

// ---------- Decisions ----------
export const decisionIn = z.object({
  action: z.enum(['subscribe', 'transfer', 'redeem']), investor_id: z.string().min(1), fund: z.string().min(1), amount: z.number().positive().max(1e12),
  settle_with: z.string().min(1).max(20), counterparty_id: z.string().optional(), what_ifs: z.array(z.string()).max(6).default([]), persist: z.boolean().default(true),
  /** Closed-end funds only: the capital call this subscription pays in. Set by POST /v1/capital-calls/{id}/settle. */
  capital_call_id: z.string().min(1).max(40).optional(),
});
export type DecisionInput = z.input<typeof decisionIn>;

/** Builds the full engine context for live orders: register state, screening, documents, fund liquidity and the clock. */
export async function liveCtx(c: C, ids: string[], ticker: string, capitalCallId: string | null = null): Promise<{ ctx: Ctx; matches: Record<string, Match | null> }> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [ctx, docs, life, closed, customRules] = await Promise.all([
    buildCtx(sql, ws, ids, ticker, adminOf(c)),
    docsCtx(sql, ws, [ticker], ids),
    lifecycleCtx(sql, ws, ticker, ids),
    closedEndCtx(sql, ws, ticker, ids[0] ?? null, capitalCallId),
    loadActiveRules(sql, ws),
  ]);
  if (ctx.funds[ticker]) (ctx.funds[ticker] as FundExt).fundType = closed.fundType;
  ctx.capitalCall = closed.capitalCall;
  // Rules the organization authored in the rule workbench, in force today. Evaluated after the built-in layers.
  if (customRules.length) ctx.customRules = customRules;
  const names = ids.map((i) => ctx.investors[i]?.name).filter((n): n is string => !!n);
  const matches = names.length ? await screenNames(sql, ws, names) : {};
  ctx.screen = (n: string) => { const m = matches[n]; return m ? { entry: m.entry, program: m.program, score: m.score, source: m.source } : null; };
  ctx.documents = docs?.documents ?? {};
  ctx.acks = docs?.acks ?? {};
  ctx.aum = life?.aum ?? {};
  ctx.redeemedInPeriod = life?.redeemedInPeriod ?? {};
  ctx.notices = life?.notices ?? {};
  ctx.calendars = calendarsCtx(ctx.funds[ticker]?.cutoffTz);
  ctx.now = new Date().toISOString();
  return { ctx, matches };
}

function receiptOf(row: any, ws: string) {
  const r: Record<string, unknown> = {
    decision_id: row.id, sandbox: ws.slice(0, 8), outcome: row.outcome, action: row.action, fund: row.ticker, amount: String(row.amount), asset: row.asset,
    binding_rules: (row.resolved as any[]).map((x) => `${x.text} (${x.ruleRef})`), rule_packs: row.rule_packs, inputs_sha256: row.inputs_sha256,
    issued_at: new Date(row.created_at).toISOString(),
  };
  if (row.dealing_date) r.dealing_date = String(row.dealing_date).slice(0, 10);
  return r;
}
async function signed(c: C, row: any) {
  try { const receipt = receiptOf(row, c.get('ws')); return { receipt, signature: await signReceipt(c.env, receipt) }; }
  catch { return { receipt: null, signature: null }; }
}

const countryOf = (j: string) => (j === 'AE-DIFC' ? 'AE' : j.split('-')[0]);
/** IVMS101 payload for transfers at or above the FATF Recommendation 16 threshold. */
export function travelRule(d: Decision) {
  if (d.order.action !== 'transfer' || !d.counterparty || d.notional < 1000) return null;
  const person = (i: Investor) => {
    const address = [{ addressType: 'GEOG', townName: i.city, country: countryOf(i.residence) }];
    if (i.kind === 'Individual') {
      const parts = i.name.trim().split(/\s+/);
      const primary = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      const secondary = parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined;
      return { naturalPerson: { name: { nameIdentifier: [{ primaryIdentifier: primary, ...(secondary ? { secondaryIdentifier: secondary } : {}), nameIdentifierType: 'LEGL' }] }, geographicAddress: address, countryOfResidence: countryOf(i.residence) } };
    }
    return { legalPerson: { name: { nameIdentifier: [{ legalPersonName: i.name, legalPersonNameIdentifierType: 'LEGL' }] }, geographicAddress: address, countryOfRegistration: countryOf(i.residence) } };
  };
  return {
    standard: 'IVMS101', threshold: 'USD/EUR 1,000 (FATF R.16)',
    originator: { originatorPersons: [person(d.investor)], accountNumber: [d.investor.wallet] },
    beneficiary: { beneficiaryPersons: [person(d.counterparty)], accountNumber: [d.counterparty.wallet] },
    transferredAmount: { amount: String(d.notional), assetType: d.fund.ticker, units: String(d.units) },
  };
}

function decisionOut(d: Decision, hash: string, whatIfs: WhatIf[]) {
  return {
    id: null as string | null, outcome: d.outcome, headline: d.headline, redemption_only: d.redemptionOnly, units: d.units, checks: d.checks, binding_rules: d.resolved,
    remedies: [...new Set(d.remedies)], rule_packs: d.rulePacks, inputs_sha256: hash, hypothetical: whatIfs.length > 0, what_ifs: whatIfs,
    dealing_date: d.dealingDate ?? null, travel_rule: travelRule(d), settle_by: null as string | null,
  };
}
const orderOf = (b: { action: Order['action']; investor_id: string; fund: string; amount: number; settle_with: string; counterparty_id?: string | null }): Order =>
  ({ action: b.action, investorId: b.investor_id, fundId: b.fund, amount: b.amount, asset: b.settle_with, counterpartyId: b.counterparty_id ?? undefined });

/**
 * Evaluates an order against current state and, unless persist is false, records the decision with its snapshot.
 * Shared by POST /v1/decisions and the investor portal. Callers check permissions first.
 */
export type DecisionOpts = {
  /** Set by the order.large executor and the waitlist: the approval already happened, or does not apply. */
  bypassApproval?: boolean;
  /** Settle now even when the dealing date is in the future (waitlist releases, one-off operator orders). */
  bypassBatch?: boolean;
};
export async function createDecision(c: C, input: DecisionInput, opts: DecisionOpts = {}) {
  const b = decisionIn.parse(input);
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  if (b.action === 'transfer' && !b.counterparty_id) throw new ApiError(422, 'counterparty_required', 'A transfer needs counterparty_id, the investor receiving the units.');
  if (b.counterparty_id && b.counterparty_id === b.investor_id) throw new ApiError(422, 'same_party', 'The sender and the receiver are the same investor. Pick a different counterparty.');
  const ids = [b.investor_id, ...(b.action === 'transfer' && b.counterparty_id ? [b.counterparty_id] : [])];
  const { ctx, matches } = await liveCtx(c, ids, b.fund, b.capital_call_id ?? null);
  if (!ctx.investors[b.investor_id]) throw new ApiError(404, 'not_found', `No investor ${b.investor_id} in this organization.`);
  if (b.action === 'transfer' && !ctx.investors[b.counterparty_id!]) throw new ApiError(404, 'not_found', `No investor ${b.counterparty_id} in this organization.`);
  if (!ctx.funds[b.fund]) throw new ApiError(404, 'not_found', `No fund ${b.fund} in this organization.`);
  const whatIfs = b.what_ifs.filter((w): w is WhatIf => WHAT_IFS.some((x) => x.id === w));
  const order = orderOf({ ...b, counterparty_id: b.action === 'transfer' ? b.counterparty_id : undefined });
  const d = evaluate(order, whatIfs, ctx);
  // Hard cap: a new holder who would take the fund past a numeric placement limit for their jurisdiction is refused.
  if (b.action === 'subscribe' && !whatIfs.length && d.outcome !== 'FREEZE') {
    const inv = ctx.investors[b.investor_id];
    const cap = await placementCapCheck(sql, ws, b.fund, inv.residence, !((inv.holdings[b.fund]?.units ?? 0) > 0));
    if (cap) {
      d.checks.push(cap.check);
      if (cap.check.result === 'fail') {
        d.outcome = 'DENY';
        d.headline = `Subscription denied. ${cap.check.detail}`;
        if (cap.check.remedy) d.remedies.push(cap.check.remedy);
      }
    }
  }
  // Checks the engine cannot make from its context alone: they read organization tables and append to the trace
  // the same way the placement cap does. A failing one turns the outcome to DENY.
  if (!whatIfs.length && d.outcome !== 'FREEZE') {
    const fund = ctx.funds[b.fund];
    const receiver = b.action === 'transfer' ? ctx.investors[b.counterparty_id!] : ctx.investors[b.investor_id];
    const extra: Check[] = [];
    if (b.action === 'subscribe') {
      const s = await suitabilityCheck(sql, ws, receiver, fund, ctx.jurName);
      if (s) extra.push(s);
    }
    if (b.action !== 'redeem') {
      extra.push(await taxCheck(sql, ws, receiver, fund));
      const con = await concentrationCheck(sql, ws, fund, receiver, b.amount, d.units);
      if (con) extra.push(con);
    }
    for (const ch of extra) {
      d.checks.push(ch);
      if (ch.result === 'fail' && d.outcome === 'ALLOW') {
        d.outcome = 'DENY';
        d.headline = `${b.action === 'subscribe' ? 'Subscription' : b.action === 'transfer' ? 'Transfer' : 'Redemption'} denied. ${ch.detail}`;
      }
      if (ch.result === 'fail' && ch.remedy) d.remedies.push(ch.remedy);
    }
  }
  const hash = await inputsHash(d);
  const out = decisionOut(d, hash, whatIfs);
  // A subscription refused only by a holder limit can wait for a slot.
  (out as any).waitlist_eligible = !whatIfs.length && waitlistEligible(d, b.action);

  const hits = ids.map((i) => ctx.investors[i]).filter((inv) => matches[inv.name]).map((inv) => ({ investorId: inv.id, name: inv.name, m: matches[inv.name]! }));
  if (hits.length) bg(c, recordHits(sql, ws, hits, 'order'));
  if (!b.persist) return { ...out, persisted: false as const, pending: false as const };

  const persist = async () => {
  const decId = id('dec', 12);
  const snapshot = snapshotFor(order, ctx, whatIfs);
  // Orders dealing on a later date join that date's batch and settle together after the cut-off.
  const batchId = !opts.bypassBatch && !whatIfs.length && b.action !== 'transfer' && d.dealingDate && d.dealingDate > ctx.today ? await joinBatch(sql, ws, ctx.funds[b.fund], d.dealingDate) : null;
  const [[row]] = await sql.transaction([
    sql`insert into decisions (workspace_id, id, action, investor_id, counterparty_id, ticker, amount, asset, outcome, headline, checks, resolved, remedies, rule_packs, what_ifs, units, inputs_sha256, snapshot, dealing_date, actor, capital_call_id, batch_id)
      values (${ws}, ${decId}, ${b.action}, ${b.investor_id}, ${order.counterpartyId ?? null}, ${b.fund}, ${b.amount}, ${d.order.asset}, ${d.outcome}, ${d.headline}, ${JSON.stringify(d.checks)}, ${JSON.stringify(d.resolved)},
        ${JSON.stringify(out.remedies)}, ${d.rulePacks}, ${whatIfs}, ${d.units}, ${hash}, ${JSON.stringify(snapshot)}, ${d.dealingDate ?? null}, ${actorRef(a)}, ${b.capital_call_id ?? null}, ${batchId})
      returning id, action, investor_id, counterparty_id, ticker, amount::float8 as amount, asset, outcome, headline, resolved, rule_packs, what_ifs, units::float8 as units, inputs_sha256, dealing_date::text, created_at`,
    auditQ(sql, ws, a, 'decision.created', decId, { outcome: d.outcome, action: b.action, fund: b.fund, investor: b.investor_id, counterparty: order.counterpartyId ?? null, amount: b.amount, inputs_sha256: hash, hypothetical: whatIfs.length > 0, batch: batchId }),
  ]);
  out.id = decId;
  if (d.outcome === 'ALLOW' && !whatIfs.length && !batchId) out.settle_by = new Date(new Date(row.created_at).getTime() + SETTLE_WINDOW_MS).toISOString();
  bg(c, emit(sql, ws, 'decision.created', { id: decId, outcome: d.outcome, headline: d.headline, action: b.action, fund: b.fund, batch: batchId }));
  if (d.outcome === 'ALLOW' && b.action === 'transfer' && !whatIfs.length) bg(c, startTravelRule(c, row));
  const { receipt, signature } = await signed(c, row);
  return { ...out, persisted: true as const, pending: false as const, receipt, signature, created_at: row.created_at, batch_id: batchId, in_batch: !!batchId,
    ...(batchId ? { batch_note: `Deals on ${d.dealingDate}. The order settles with its batch after the cut-off; an operator can still settle it alone with force: true.` } : {}) };
  };
  // Large orders need a second person before they are recorded and settled. The approval executor re-enters with bypassApproval.
  if (opts.bypassApproval || whatIfs.length || d.outcome !== 'ALLOW') return persist();
  const res = await requireApproval(c, 'order.large', b.fund, { input: { ...b, what_ifs: [] }, amount: b.amount, currency: ctx.funds[b.fund].currency, investor_name: ctx.investors[b.investor_id].name, preview_outcome: d.outcome, headline: d.headline }, persist, {
    title: `${b.action[0].toUpperCase()}${b.action.slice(1)} ${ctx.funds[b.fund].currency} ${b.amount.toLocaleString('en-US')} of ${b.fund} for ${ctx.investors[b.investor_id].short}`, link: '#/approvals',
  });
  if (isPending(res)) return { ...out, persisted: false as const, ...res, preview: { outcome: d.outcome, headline: d.headline } };
  return res;
}

routes.post('/decisions', async (c) => {
  need(c, 'orders:write');
  const res = await createDecision(c, await body(c, decisionIn));
  return c.json(res, res.pending ? 202 : res.persisted ? 201 : 200);
});
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Decisions, newest first, with cursor pagination. Filters: outcome (ALLOW, DENY, FREEZE), fund, investor_id, action, from and to (YYYY-MM-DD, inclusive). */
routes.get('/decisions', async (c) => {
  need(c, 'read');
  const page = pageParams(c, 50, 200);
  const ticker = c.req.query('fund') || null; const inv = c.req.query('investor_id') || null;
  const outcome = (c.req.query('outcome') || '').toUpperCase() || null; const action = c.req.query('action') || null;
  const from = c.req.query('from') || null; const to = c.req.query('to') || null;
  if (outcome && !['ALLOW', 'DENY', 'FREEZE'].includes(outcome)) throw new ApiError(400, 'invalid_filter', 'outcome must be ALLOW, DENY or FREEZE.');
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new ApiError(400, 'invalid_filter', 'from and to must be dates like 2026-10-01.');
  const toExclusive = to ? addDays(to, 1) : null;
  const rows = await c.get('sql')`select d.id, d.action, d.investor_id, i.name as investor, d.counterparty_id, d.ticker, d.amount::float8 as amount, d.asset, d.outcome, d.headline, d.what_ifs,
      d.dealing_date::text, d.actor, d.created_at, s.id as settlement_id, s.status as settlement_status
    from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id
    where d.workspace_id = ${c.get('ws')} and (${ticker}::text is null or d.ticker = ${ticker}) and (${inv}::text is null or d.investor_id = ${inv} or d.counterparty_id = ${inv})
      and (${outcome}::text is null or d.outcome = ${outcome}) and (${action}::text is null or d.action = ${action})
      and (${from}::date is null or d.created_at >= ${from}::date) and (${toExclusive}::date is null or d.created_at < ${toExclusive}::date)
      and (${page.at}::timestamptz is null or (d.created_at, d.id) < (${page.at}::timestamptz, ${page.id}))
    order by d.created_at desc, d.id desc limit ${page.limit + 1}`;
  return c.json({ ...pageOut(rows as any[], page), filters: { fund: ticker, investor_id: inv, outcome, action, from, to } });
});
routes.get('/decisions/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const decId = c.req.param('id');
  const [[row], who] = await Promise.all([
    sql`select d.*, d.amount::float8 as amount, d.units::float8 as units, d.dealing_date::text as dealing_date, i.name as investor_name, cp.name as counterparty_name, s.id as settlement_id, s.status as settlement_status
      from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join investors cp on cp.workspace_id = d.workspace_id and cp.id = d.counterparty_id
      left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id where d.workspace_id = ${ws} and d.id = ${decId}`,
    sql`select actor_name from audit_events where workspace_id = ${ws} and subject = ${decId} and type = 'decision.created' order by seq limit 1`,
  ]);
  if (!row) throw new ApiError(404, 'not_found', `No decision ${decId} in this organization.`);
  const { receipt, signature } = await signed(c, row);
  return c.json({ ...row, actor_name: who[0]?.actor_name ?? null, replayable: !!row.snapshot, receipt, signature });
});

routes.get('/decisions/:id/receipt.pdf', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const decId = c.req.param('id');
  const [[row], who] = await Promise.all([
    sql`select d.*, d.amount::float8 as amount, d.units::float8 as units, d.dealing_date::text as dealing_date,
        i.name as investor_name, i.residence as investor_residence, i.booking_center as investor_booking,
        cp.name as counterparty_name, cp.residence as counterparty_residence, cp.booking_center as counterparty_booking,
        f.name as fund_name, f.currency as fund_currency, f.issuer as fund_issuer, s.id as settlement_id, s.status as settlement_status, w.name as workspace_name
      from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id
      left join investors cp on cp.workspace_id = d.workspace_id and cp.id = d.counterparty_id
      left join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker
      left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id
      left join workspaces w on w.id = d.workspace_id
      where d.workspace_id = ${ws} and d.id = ${decId}`,
    sql`select actor_name from audit_events where workspace_id = ${ws} and subject = ${decId} and type = 'decision.created' order by seq limit 1`,
  ]);
  if (!row) throw new ApiError(404, 'not_found', `No decision ${decId} in this organization.`);
  const { signature } = await signed(c, row);
  const bytes = receiptPdf({
    decisionId: row.id, outcome: row.outcome, headline: row.headline, action: row.action, createdAt: new Date(row.created_at).toISOString(),
    workspace: row.workspace_name ?? ws.slice(0, 8), actor: who[0]?.actor_name ?? null,
    investor: { name: row.investor_name, residence: row.investor_residence, booking: row.investor_booking },
    counterparty: row.counterparty_name ? { name: row.counterparty_name, residence: row.counterparty_residence, booking: row.counterparty_booking } : null,
    fund: { ticker: row.ticker, name: row.fund_name ?? row.ticker, currency: row.fund_currency ?? (row.asset === 'EURC' || row.asset === 'AVB-EUR' ? 'EUR' : 'USD'), issuer: row.fund_issuer ?? null },
    amount: Number(row.amount), units: Number(row.units), asset: row.asset, dealingDate: row.dealing_date ?? null,
    bindingRules: (row.resolved as any[]) ?? [], checks: (row.checks as any[]) ?? [], rulePacks: row.rule_packs ?? [], inputsHash: row.inputs_sha256,
    signature, whatIfs: row.what_ifs ?? [], settlement: row.settlement_id ? { id: row.settlement_id, status: row.settlement_status } : null,
  });
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="laissez-receipt-${row.id}.pdf"`, 'cache-control': 'private, no-store' } });
});

// ---------- Point-in-time: replay, as-of evaluation, policy backtest ----------
routes.get('/decisions/:id/replay', async (c) => {
  need(c, 'read');
  const decId = c.req.param('id');
  const [row] = await c.get('sql')`select id, outcome, inputs_sha256, rule_packs, snapshot, checks, created_at from decisions where workspace_id = ${c.get('ws')} and id = ${decId}`;
  if (!row) throw new ApiError(404, 'not_found', `No decision ${decId} in this organization.`);
  if (!row.snapshot) throw new ApiError(409, 'no_snapshot', 'This decision was made before Laissez stored decision snapshots, so it cannot be replayed. Decisions made from now on can.');
  const snap = row.snapshot as Snapshot;
  const d = replaySnapshot(snap);
  // Suitability, tax and concentration read organization tables, not the snapshot. Their stored results rejoin the trace so the hash can match.
  for (const ch of ((row.checks as any[]) ?? [])) {
    if (['suitability', 'tax', 'concentration'].includes(ch.id) && !d.checks.some((x) => x.id === ch.id)) d.checks.push(ch);
  }
  const hash = await inputsHash(d);
  // Fresh evaluation of the same order against today's state, to show what has changed since the decision.
  const ids = [snap.order.investorId, ...(snap.order.counterpartyId ? [snap.order.counterpartyId] : [])];
  let live: Decision | null = null; let liveNote: string;
  try {
    const { ctx } = await liveCtx(c, ids, snap.order.fundId, snap.capitalCall?.id ?? null);
    if (ids.every((i) => ctx.investors[i]) && ctx.funds[snap.order.fundId]) { live = evaluate(snap.order, snap.whatIfs ?? [], ctx); liveNote = 'Evaluated again against the register, credentials, policy, rule packs, documents and screening lists as they are now.'; }
    else liveNote = 'The investor, counterparty or fund on this decision no longer exists, so there is no live evaluation to compare.';
  } catch (e: any) { liveNote = `Live evaluation unavailable: ${e?.message ?? 'error'}.`; }
  const diff: { id: string; layer: string; label: string; before: { result: string; detail: string } | null; after: { result: string; detail: string } | null }[] = [];
  if (live) {
    const ids2 = [...new Set([...d.checks.map((x) => x.id), ...live.checks.map((x) => x.id)])];
    for (const cid of ids2) {
      const b = d.checks.find((x) => x.id === cid); const a = live.checks.find((x) => x.id === cid);
      if (b && a && b.result === a.result) continue;
      diff.push({ id: cid, layer: (a ?? b)!.layer, label: (a ?? b)!.label, before: b ? { result: b.result, detail: b.detail } : null, after: a ? { result: a.result, detail: a.detail } : null });
    }
  }
  return c.json({
    decision_id: row.id, decided_at: row.created_at,
    reproduced: d.outcome === row.outcome && hash === row.inputs_sha256,
    stored_outcome: row.outcome, replayed_outcome: d.outcome, stored_hash: row.inputs_sha256, replayed_hash: hash,
    rule_packs: d.rulePacks, stored_rule_packs: row.rule_packs, headline: d.headline, dealing_date: d.dealingDate ?? null, checks: d.checks,
    live: live ? { outcome: live.outcome, headline: live.headline, inputs_sha256: await inputsHash(live), rule_packs: live.rulePacks, evaluated_at: new Date().toISOString() } : null,
    diff, live_note: liveNote,
    note: 'Replayed from the inputs stored with the decision: the same register, credential, policy, rule-pack, document and screening state the engine saw at the time. diff lists the checks whose result differs between that replay and a fresh evaluation today.',
  });
});

export const asOfIn = decisionIn.omit({ what_ifs: true, persist: true, capital_call_id: true }).extend({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD') });
routes.post('/evaluate/as-of', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, asOfIn);
  if (Number.isNaN(Date.parse(b.as_of + 'T00:00:00Z'))) throw new ApiError(422, 'invalid_date', `${b.as_of} is not a calendar date.`);
  if (b.as_of > today()) throw new ApiError(422, 'future_date', 'as_of cannot be in the future. Use POST /v1/decisions with persist: false to evaluate today.');
  if (b.action === 'transfer' && !b.counterparty_id) throw new ApiError(422, 'counterparty_required', 'A transfer needs counterparty_id, the investor receiving the units.');
  const ids = [b.investor_id, ...(b.action === 'transfer' && b.counterparty_id ? [b.counterparty_id] : [])];
  const endOfDay = addDays(b.as_of, 1) + 'T00:00:00Z';
  const [g, investors, funds, [pv], creds, stls, docs, acks, hits] = await Promise.all([
    loadGlobals(sql), loadInvestors(sql, ws, ids, adminOf(c)), loadFunds(sql, ws, b.fund),
    sql`select version, effective_at, distribution, min_subscription::float8 as min_subscription, holder_cap, lockup_months, published_by from fund_policy_versions
      where workspace_id = ${ws} and ticker = ${b.fund} and effective_at < ${endOfDay}::timestamptz order by effective_at desc, version desc limit 1`,
    sql`select distinct on (investor_id) id, investor_id, lzid, issuer_name, issued_on::text, expires_on::text, status, revoked_at from credentials
      where workspace_id = ${ws} and investor_id = any(${ids}) and issued_on <= ${b.as_of}::date and (revoked_at is null or revoked_at::date > ${b.as_of}::date)
      order by investor_id, issued_on desc, created_at desc`,
    // Settlements of this fund after the as-of date that touched the involved investors, newest first, to unwind.
    sql`select s.id, s.created_at, d.action, d.investor_id, d.counterparty_id, d.units::float8 as units from settlements s
      join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
      where s.workspace_id = ${ws} and s.status in ('settled', 'pending') and d.ticker = ${b.fund} and s.created_at >= ${endOfDay}::timestamptz
        and (d.investor_id = any(${ids}) or d.counterparty_id = any(${ids})) order by s.created_at desc`,
    sql`select id, ticker, title, doc_type, version, sha256, jurisdiction, audience, required from fund_documents
      where workspace_id = ${ws} and ticker = ${b.fund} and published_at < ${endOfDay}::timestamptz and (superseded_at is null or superseded_at >= ${endOfDay}::timestamptz) order by doc_type, jurisdiction nulls first`,
    sql`select investor_id, document_id, sha256 from doc_acknowledgments where workspace_id = ${ws} and investor_id = any(${ids}) and acknowledged_at < ${endOfDay}::timestamptz`,
    sql`select investor_id, screened_name, matched_name, programs, source, score::float8 as score, status, created_at, decided_at from screening_hits
      where workspace_id = ${ws} and investor_id = any(${ids}) and created_at < ${endOfDay}::timestamptz
        and (status = 'open' or decided_at is null or decided_at >= ${endOfDay}::timestamptz) order by score desc`,
  ]);
  for (const i of ids) if (!investors[i]) throw new ApiError(404, 'not_found', `No investor ${i} in this organization.`);
  const f = funds[b.fund];
  if (!f) throw new ApiError(404, 'not_found', `No fund ${b.fund} in this organization.`);
  if (!pv) throw new ApiError(422, 'no_policy_in_force', `No published policy of ${b.fund} was in force on ${b.as_of}.`);
  const credIds = creds.map((r: any) => r.id);
  const cls = credIds.length ? await sql`select credential_id, class_code, basis, verified_on::text as verified_on, expires_on::text as expires_on, opt_in_on::text as opt_in_on from classifications where workspace_id = ${ws} and credential_id = any(${credIds}) order by id` : [];
  const used: Record<string, unknown> = {};
  for (const i of ids) {
    const inv = investors[i];
    if (inv.reliedShare) { used[i] = { id: inv.credentialId || null, relied_share: inv.reliedShare, note: 'Relied-on credentials are read as they are today.' }; continue; }
    const cr = creds.find((r: any) => r.investor_id === i);
    Object.assign(inv, cr
      ? { credentialId: cr.id, issued: cr.issued_on, expires: cr.expires_on, lzid: cr.lzid ?? undefined, issuer: cr.issuer_name ?? inv.issuer,
          classifications: cls.filter((x: any) => x.credential_id === cr.id).map((x: any) => ({ code: x.class_code, basis: x.basis, verified: x.verified_on, expires: x.expires_on, optIn: x.opt_in_on ?? undefined })) }
      : { credentialId: '', issued: '', expires: '0000-00-00', classifications: [] });
    used[i] = cr ? { id: cr.id, lzid: cr.lzid, issued_on: cr.issued_on, expires_on: cr.expires_on, status_today: cr.status, revoked_at: cr.revoked_at } : null;
  }
  // Holdings as of the date: today's register with every later settlement of this fund unwound, newest first.
  const unwound: { settlement_id: string; action: string; units: number; at: string }[] = [];
  const adjust = (invId: string | null | undefined, delta: number) => {
    const inv = invId ? investors[invId] : undefined;
    if (!inv) return;
    const h = inv.holdings[b.fund];
    const units = Math.round(((h?.units ?? 0) + delta) * 100) / 100;
    if (units <= 0.0001) delete inv.holdings[b.fund];
    else inv.holdings[b.fund] = { units, since: h?.since ?? b.as_of };
  };
  for (const s of stls) {
    const u = Number(s.units);
    if (s.action === 'subscribe') adjust(s.investor_id, -u);
    else if (s.action === 'redeem') adjust(s.investor_id, u);
    else if (s.action === 'transfer') { adjust(s.investor_id, u); adjust(s.counterparty_id, -u); }
    unwound.push({ settlement_id: s.id, action: s.action, units: u, at: new Date(s.created_at).toISOString() });
  }
  // Documents and acknowledgments as of the date.
  const documents: Record<string, DocReq[]> = { [b.fund]: docs.map((d: any): DocReq => ({
    id: d.id, ticker: d.ticker, title: d.title, docType: d.doc_type, version: Number(d.version), sha256: d.sha256,
    jurisdiction: d.jurisdiction ?? null, audience: d.audience === 'retail' || d.audience === 'professional' ? d.audience : 'all', required: !!d.required,
  })) };
  const ackMap: Record<string, Record<string, string>> = Object.fromEntries(ids.map((i) => [i, {}]));
  for (const a of acks) (ackMap[a.investor_id] ??= {})[a.document_id] = a.sha256;
  // Screening hits that were open on the date (recorded before it and not yet dispositioned, or dispositioned later).
  const openHits: Record<string, any> = {};
  for (const h of hits) {
    const inv = ids.map((i) => investors[i]).find((x) => x.id === h.investor_id || x.name === h.screened_name);
    if (inv && !openHits[inv.name]) openHits[inv.name] = { entry: h.matched_name, program: h.programs ?? '', source: h.source, score: Number(h.score), status_today: h.status, recorded_at: h.created_at };
  }
  const fundAsOf = { ...f, distribution: pv.distribution, minSubscription: pv.min_subscription == null ? f.minSubscription : Number(pv.min_subscription), holderCap: pv.holder_cap, lockupMonths: pv.lockup_months, policyVersion: pv.version } as Fund;
  const ctx: Ctx = {
    classInfo: g.classInfo, bookingCenters: g.bookingCenters, jurName: g.jurName, sanctioned: g.sanctioned, investors, funds: { [b.fund]: fundAsOf }, today: b.as_of, rulePacks: packsAsOf(g, b.as_of),
    documents, acks: ackMap, calendars: calendarsCtx(f.cutoffTz),
    screen: (name: string) => { const h = openHits[name]; return h ? { entry: h.entry, program: h.program, source: h.source, score: h.score } : null; },
  };
  const order = orderOf({ ...b, counterparty_id: b.action === 'transfer' ? b.counterparty_id : undefined });
  const d = evaluate(order, [], ctx);
  const hash = await inputsHash(d);
  return c.json({
    ...decisionOut(d, hash, []), persisted: false, as_of: b.as_of,
    policy_version_used: pv.version, policy_version_detail: { version: pv.version, effective_at: pv.effective_at, published_by: pv.published_by },
    credential_used: ids.length === 1 ? used[ids[0]] : used,
    reconstructed: {
      holdings: Object.fromEntries(ids.map((i) => [i, investors[i].holdings[b.fund] ?? null])), settlements_unwound: unwound,
      documents_in_force: docs.length, acknowledgments: Object.fromEntries(ids.map((i) => [i, Object.keys(ackMap[i] ?? {}).length])),
      open_screening_hits: Object.values(openHits).length,
    },
    note: `Fund policy, credentials, rule packs, holdings, fund documents, acknowledgments and open screening hits are taken as they stood on ${b.as_of}: holdings are today's register with ${unwound.length} later settlement${unwound.length === 1 ? '' : 's'} of ${b.fund} unwound, and a hit counts if it was recorded by then and not yet cleared. Still read as of today: the holder count and sanctions list contents, relied-on credentials from other organizations, redemption notices, NAV and the fund's liquidity state (assets, gate usage), and reinvested distributions, so the Fund terms layer is not evaluated. Dates follow the fund calendar in force now.`,
  });
});

const backtestIn = policyIn.extend({ days: z.number().int().min(1).max(365).default(90) });
/** Bounded so one request stays within the Worker CPU budget. */
const BACKTEST_MAX = 120;
routes.post('/funds/:ticker/policy/backtest', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const ticker = c.req.param('ticker');
  const b = await body(c, backtestIn);
  const [funds, g, rows] = await Promise.all([
    loadFunds(sql, ws, ticker), loadGlobals(sql),
    sql`select d.id, d.created_at, d.action, d.amount::float8 as amount, d.outcome, d.snapshot, i.name as investor from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id
      where d.workspace_id = ${ws} and d.ticker = ${ticker} and d.snapshot is not null and cardinality(d.what_ifs) = 0 and d.created_at > now() - make_interval(days => ${b.days})
      order by d.created_at desc limit ${BACKTEST_MAX + 1}`,
  ]);
  const f = funds[ticker];
  if (!f) throw new ApiError(404, 'not_found', `No fund ${ticker} in this organization.`);
  const p: PolicyIn = { distribution: b.distribution, min_subscription: b.min_subscription, holder_cap: b.holder_cap, lockup_months: b.lockup_months };
  await validatePolicy(sql, f, p);
  const flips: Record<string, unknown>[] = [];
  const checked = rows.slice(0, BACKTEST_MAX);
  for (const r of checked) {
    const snap = r.snapshot as Snapshot;
    const ctx = ctxFromSnapshot(snap);
    const orig = ctx.funds[snap.order.fundId];
    if (!orig) continue;
    // Swap only the policy fields; the fund's register state at decision time stays as it was.
    const proposed = applyPolicy(orig, p);
    ctx.funds = { ...ctx.funds, [snap.order.fundId]: { ...orig, distribution: proposed.distribution, minSubscription: proposed.minSubscription, holderCap: proposed.holderCap, lockupMonths: proposed.lockupMonths } };
    ctx.classInfo = { ...g.classInfo, ...ctx.classInfo };
    ctx.jurName = { ...g.jurName, ...ctx.jurName };
    const d = evaluate(snap.order, snap.whatIfs ?? [], ctx);
    if (d.outcome !== r.outcome) {
      const fail = d.checks.find((x) => x.result === 'fail');
      flips.push({ decision_id: r.id, created_at: r.created_at, investor: r.investor, action: r.action, amount: r.amount, from: r.outcome, to: d.outcome,
        reason: d.outcome === 'ALLOW' ? 'Every check passes under the proposed policy.' : fail ? `${fail.label}: ${fail.detail}` : d.headline });
    }
  }
  return c.json({
    fund: ticker, window_days: b.days, decisions_checked: checked.length, truncated: rows.length > BACKTEST_MAX, flips,
    note: 'Each past decision is re-run from its stored snapshot with only the fund policy swapped. Hypothetical what-if decisions are skipped.',
  });
});

// ---------- Settlements ----------
const stepsFor = (action: string) => {
  const base = Date.now();
  const at = (ms: number) => new Date(base + ms).toISOString();
  return action === 'redeem'
    ? [{ step: 'decision_signed', at: at(200) }, { step: 'units_locked', at: at(12_000), block: 1 }, { step: 'atomic_payout', at: at(12_000), block: 1 }, { step: 'final', at: at(780_000) }]
    : [{ step: 'decision_signed', at: at(200) }, { step: 'cash_locked', at: at(12_000), block: 1 }, { step: 'registry_confirmed', at: at(12_000), block: 1 }, { step: 'atomic_swap', at: at(12_000), block: 1 }, { step: 'final', at: at(780_000) }];
};

/** Register updates for the simulated settlement path: credit, debit, holder count and redemption notices. */
async function simulatedLegQueries(sql: Sql, ws: string, ctx: Ctx, dec: any, u: number, t: string): Promise<any[]> {
  const inv = ctx.investors[dec.investor_id]; const cp = dec.counterparty_id ? ctx.investors[dec.counterparty_id] : null;
  const q: any[] = []; let holderDelta = 0;
  const now = today();
  const credit = (who: Investor) => { if (!who.holdings[t]) holderDelta++; q.push(sql`insert into holdings (workspace_id, investor_id, ticker, units, since) values (${ws}, ${who.id}, ${t}, ${u}, ${now}) on conflict (workspace_id, investor_id, ticker) do update set units = holdings.units + excluded.units`); };
  const debit = (who: Investor) => { const left = (who.holdings[t]?.units ?? 0) - u; if (left <= 0.0001) { holderDelta--; q.push(sql`delete from holdings where workspace_id = ${ws} and investor_id = ${who.id} and ticker = ${t}`); } else q.push(sql`update holdings set units = units - ${u} where workspace_id = ${ws} and investor_id = ${who.id} and ticker = ${t}`); };
  if (dec.action === 'subscribe') credit(inv);
  if (dec.action === 'redeem') debit(inv);
  if (dec.action === 'transfer' && cp) { debit(inv); credit(cp); }
  if (holderDelta) q.push(sql`update funds set holders = greatest(0, holders + ${holderDelta}) where workspace_id = ${ws} and ticker = ${t}`);
  if (dec.action === 'redeem') q.push(...(await noticeExecutionQueries(sql, ws, dec.investor_id, t, u, '9999-12-31')));
  return q;
}

/**
 * Settles an allowed decision. Re-checks the order against current state first. With on-chain settlement
 * configured (and API version 2026-10-02), queues the chain job and returns 202 pending; otherwise runs the
 * simulated atomic settlement in one database transaction and returns 201.
 */
export type SettleOpts = {
  /** Batch settlement: the decision was taken days before its dealing date, so the 15-minute window does not apply. */
  ignoreWindow?: boolean;
  fromBatch?: boolean;
};
export async function executeSettlement(c: C, dec: any, opts: SettleOpts = {}): Promise<{ httpStatus: 201 | 202; settlement: Record<string, unknown> }> {
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  if (dec.outcome !== 'ALLOW') throw new ApiError(409, 'not_allowed', 'Only allowed decisions can settle. Fix the refusal and request a new decision.');
  if ((dec.what_ifs as string[] | null)?.length) throw new ApiError(409, 'hypothetical', 'This decision used what-if scenarios, so it is hypothetical and cannot settle. Request a decision without what_ifs.');
  if (!opts.ignoreWindow && Date.now() - new Date(dec.created_at).getTime() > SETTLE_WINDOW_MS) throw new ApiError(409, 'expired', 'Settlement instructions expire 15 minutes after the decision. Request a new decision.');
  const done = await sql`select id, status from settlements where workspace_id = ${ws} and decision_id = ${dec.id}`;
  if (done.length) {
    if (done[0].status === 'reverted') throw new ApiError(409, 'reverted', `The settlement of this decision (${done[0].id}) reverted. Retry it from the settlement page, or request a new decision and settle that one.`);
    if (done[0].status === 'cancelled') throw new ApiError(409, 'cancelled', `The settlement of this decision (${done[0].id}) was cancelled. Request a new decision and settle that one.`);
    throw new ApiError(409, 'already_settled', `This decision already settled as ${done[0].id} (${done[0].status}).`);
  }
  const amount = Number(dec.amount);
  // Re-check against current state: something may have changed since the decision.
  const ids = [dec.investor_id, ...(dec.counterparty_id ? [dec.counterparty_id] : [])];
  const { ctx } = await liveCtx(c, ids, dec.ticker, dec.capital_call_id ?? null);
  if (!ctx.investors[dec.investor_id] || !ctx.funds[dec.ticker] || (dec.counterparty_id && !ctx.investors[dec.counterparty_id])) throw new ApiError(409, 'state_changed', 'The investor, counterparty or fund on this decision no longer exists.');
  const d = evaluate({ action: dec.action, investorId: dec.investor_id, fundId: dec.ticker, amount, asset: dec.asset, counterpartyId: dec.counterparty_id ?? undefined }, [], ctx);
  const recheck = { outcome: d.outcome, inputs_sha256: await inputsHash(d), checked_at: new Date().toISOString() };
  if (d.outcome !== 'ALLOW') throw new ApiError(409, 'state_changed', `Something changed since the decision. ${d.headline}`, d.checks.filter((x) => x.result === 'fail'));
  if (dec.action === 'transfer' && !(await travelRuleApproved(sql, ws, dec.id))) {
    throw new ApiError(409, 'travel_rule_pending', 'Waiting for the beneficiary institution to approve the Travel Rule message. Try again in a few seconds.');
  }
  const u = d.units; const t = dec.ticker;
  const stlId = id('stl', 12);
  const legacy = c.get('version') === LEGACY_VERSION;

  if (!legacy && (await chainEnabled(c))) {
    try {
      await sql.transaction([
        sql`insert into settlements (workspace_id, id, decision_id, status, steps) values (${ws}, ${stlId}, ${dec.id}, 'pending', ${JSON.stringify({ simulated: false, recheck, steps: [{ step: 'decision_signed', at: new Date().toISOString() }] })})`,
        auditQ(sql, ws, a, 'settlement.queued', stlId, { decision: dec.id, action: dec.action, units: u, fund: t }),
      ]);
    } catch (e: any) {
      if (e?.code === '23505') throw new ApiError(409, 'already_settled', 'This decision is already settling. Check GET /v1/settlements.');
      throw e;
    }
    let job: { job_id: string | null };
    try { job = await queueSettlement(c, { settlementId: stlId, decision: dec, units: u }); }
    catch (e) {
      await sql.transaction([
        sql`update settlements set status = 'reverted', steps = steps || ${JSON.stringify({ reason: 'The chain job could not be queued, so nothing moved.' })}::jsonb where workspace_id = ${ws} and id = ${stlId}`,
        auditQ(sql, ws, a, 'settlement.reverted', stlId, { decision: dec.id, reason: 'queue_failed' }),
      ]);
      bg(c, emit(sql, ws, 'settlement.reverted', { id: stlId, decision: dec.id }));
      throw new ApiError(502, 'chain_unavailable', 'The settlement could not be queued on chain. Nothing moved. Request a new decision and try again.');
    }
    const chainInfo = { job_id: job.job_id, status: 'queued' };
    const [[row]] = await sql.transaction([sql`update settlements set chain = coalesce(chain, ${JSON.stringify(chainInfo)}::jsonb) where workspace_id = ${ws} and id = ${stlId} returning chain`]);
    bg(c, emit(sql, ws, 'settlement.pending', { id: stlId, decision: dec.id, units: u, fund: t, job_id: job.job_id }));
    return { httpStatus: 202, settlement: { id: stlId, decision_id: dec.id, status: 'pending', units: u, fund: t, simulated: false, chain: row?.chain ?? chainInfo, poll: `/v1/settlements/${stlId}` } };
  }

  // Simulated atomic settlement: both legs move in one database transaction, or neither does.
  const fullRedemption = dec.action === 'redeem' && (ctx.investors[dec.investor_id].holdings[t]?.units ?? 0) - u <= 0.0001;
  const q = await simulatedLegQueries(sql, ws, ctx, dec, u, t);
  const steps = stepsFor(dec.action);
  q.push(sql`insert into settlements (workspace_id, id, decision_id, status, steps) values (${ws}, ${stlId}, ${dec.id}, 'settled', ${JSON.stringify({ simulated: true, chain: 'Ethereum', recheck, steps, ...(opts.fromBatch ? { batch: dec.batch_id ?? null } : {}) })})`);
  q.push(auditQ(sql, ws, a, 'settlement.completed', stlId, { decision: dec.id, action: dec.action, units: u, fund: t, simulated: true, batch: dec.batch_id ?? null }));
  try { await sql.transaction(q); }
  catch (e: any) {
    if (e?.code === '23505') throw new ApiError(409, 'already_settled', 'This decision settled a moment ago. Check GET /v1/settlements.');
    await sql.transaction([
      sql`insert into settlements (workspace_id, id, decision_id, status, steps) values (${ws}, ${stlId}, ${dec.id}, 'reverted', ${JSON.stringify({ simulated: true, recheck, reason: 'A leg failed, so both legs reverted.' })}) on conflict do nothing`,
      auditQ(sql, ws, a, 'settlement.reverted', stlId, { decision: dec.id, reason: 'leg_failed' }),
    ]).catch((err) => console.error(err));
    bg(c, emit(sql, ws, 'settlement.reverted', { id: stlId, decision: dec.id }));
    throw new ApiError(409, 'reverted', 'A leg failed, so both legs reverted. Nothing moved. Request a new decision and try again.');
  }
  bg(c, emit(sql, ws, 'settlement.completed', { id: stlId, decision: dec.id, units: u, fund: t }));
  if (dec.action === 'transfer') bg(c, travelRuleConfirm(c, dec.id, stlId));
  // A holder leaving frees a slot under the holder cap: the oldest waiting order is re-evaluated.
  if (fullRedemption) bg(c, releaseWaitlist(c, t));
  return { httpStatus: 201, settlement: { id: stlId, decision_id: dec.id, status: 'settled', units: u, fund: t, steps, simulated: true, chain: null } };
}

routes.post('/settlements', async (c) => {
  need(c, 'orders:write');
  const { decision_id, force } = await body(c, z.object({ decision_id: z.string().min(1), force: z.boolean().default(false) }));
  const [dec] = await c.get('sql')`select d.id, d.action, d.investor_id, d.counterparty_id, d.ticker, d.amount::float8 as amount, d.asset, d.outcome, d.what_ifs, d.units::float8 as units, d.inputs_sha256, d.created_at, d.capital_call_id, d.batch_id, ob.status as batch_status, ob.dealing_date::text as batch_dealing_date
    from decisions d left join order_batches ob on ob.workspace_id = d.workspace_id and ob.id = d.batch_id where d.workspace_id = ${c.get('ws')} and d.id = ${decision_id}`;
  if (!dec) throw new ApiError(404, 'not_found', `No decision ${decision_id} in this organization.`);
  // A decision in an open batch settles with the batch after the cut-off, unless an operator forces it alone.
  if (dec.batch_id && dec.batch_status === 'open' && !force) throw new ApiError(409, 'in_batch', `This decision deals on ${dec.batch_dealing_date} in batch ${dec.batch_id}, which is still open. Close and settle the batch, or send force: true to settle this order alone.`, { batch_id: dec.batch_id, dealing_date: dec.batch_dealing_date });
  const r = await executeSettlement(c, dec, dec.batch_id ? { ignoreWindow: true } : {});
  return c.json(r.settlement, r.httpStatus);
});
const SETTLEMENT_STATES = ['pending', 'settled', 'reverted', 'cancelled'];
/** Settlements, newest first, with cursor pagination. Filter: status (pending, settled, reverted, cancelled). Each row carries its chain job status when there is one. */
routes.get('/settlements', async (c) => {
  need(c, 'read');
  const page = pageParams(c, 50, 200);
  const status = c.req.query('status') || null;
  if (status && !SETTLEMENT_STATES.includes(status)) throw new ApiError(400, 'invalid_filter', `status must be one of ${SETTLEMENT_STATES.join(', ')}.`);
  const rows = await c.get('sql')`select s.id, s.decision_id, s.status, s.steps, s.chain, s.created_at, d.action, d.ticker, d.amount::float8 as amount, d.asset, i.name as investor,
      j.id as job_id, j.status as job_status, j.attempts as job_attempts, j.error as job_error, j.tx_hashes as job_tx_hashes
    from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id
    left join lateral (select id, status, attempts, error, tx_hashes from chain_jobs where kind = 'settle' and ref = s.id order by created_at desc limit 1) j on true
    where s.workspace_id = ${c.get('ws')} and (${status}::text is null or s.status = ${status})
      and (${page.at}::timestamptz is null or (s.created_at, s.id) < (${page.at}::timestamptz, ${page.id}))
    order by s.created_at desc, s.id desc limit ${page.limit + 1}`;
  const out = pageOut(rows as any[], page);
  return c.json({ ...out, data: out.data.map((r: any) => ({ ...r, job: r.job_id ? { id: r.job_id, status: r.job_status, attempts: r.job_attempts, error: r.job_error, tx_hashes: r.job_tx_hashes ?? [] } : null, ...settlementActions(r) })), filters: { status } });
});
/** Which operator actions a settlement allows right now. Retry: reverted, or pending with a failed job. Cancel: pending and nothing sent on chain. */
function settlementActions(r: { status: string; job_status?: string | null; job_tx_hashes?: string[] | null; chain?: any }) {
  const sent = !!(r.job_tx_hashes ?? []).length || !!r.chain?.tx_hash;
  const retryable = r.status === 'reverted' || (r.status === 'pending' && r.job_status === 'failed');
  const cancellable = r.status === 'pending' && !sent && (r.job_status === 'queued' || r.job_status === 'failed' || !r.job_status);
  return { retryable, cancellable };
}
async function loadSettlement(c: C, stlId: string) {
  const [row] = await c.get('sql')`select s.*, d.action, d.ticker, d.amount::float8 as amount, d.asset, d.units::float8 as units, d.investor_id, d.counterparty_id, d.outcome, d.what_ifs, d.inputs_sha256, d.created_at as decision_created_at, d.capital_call_id,
      j.id as job_id, j.status as job_status, j.attempts as job_attempts, j.error as job_error, j.tx_hashes as job_tx_hashes, j.updated_at as job_updated_at
    from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
    left join lateral (select id, status, attempts, error, tx_hashes, updated_at from chain_jobs where kind = 'settle' and ref = s.id order by created_at desc limit 1) j on true
    where s.workspace_id = ${c.get('ws')} and s.id = ${stlId}`;
  if (!row) throw new ApiError(404, 'not_found', `No settlement ${stlId} in this organization.`);
  return row;
}
const settlementOut = (row: any) => ({ ...row, chain: row.chain ?? null, job: row.job_id ? { id: row.job_id, status: row.job_status, attempts: row.job_attempts, error: row.job_error, tx_hashes: row.job_tx_hashes ?? [], updated_at: row.job_updated_at } : null, ...settlementActions(row) });
routes.get('/settlements/:id', async (c) => {
  need(c, 'read');
  return c.json(settlementOut(await loadSettlement(c, c.req.param('id'))));
});

/**
 * Retries a reverted settlement, or a pending one whose chain job failed. The decision is re-checked against current
 * state first (same as a first settlement). With on-chain settlement configured the chain job is queued again;
 * otherwise the simulated atomic path runs now.
 */
export async function retrySettlement(c: C, stlId: string): Promise<Record<string, unknown>> {
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  const row = await loadSettlement(c, stlId);
  const { retryable } = settlementActions(row);
  if (!retryable) throw new ApiError(409, 'not_retryable', row.status === 'settled' ? 'This settlement already settled.' : row.status === 'cancelled' ? 'This settlement was cancelled. Request a new decision.' : 'This settlement is still in progress. Wait for its chain job to finish.');
  if (row.outcome !== 'ALLOW' || (row.what_ifs as string[] | null)?.length) throw new ApiError(409, 'not_allowed', 'The decision behind this settlement is not an allowed, non-hypothetical decision.');
  const dec = { id: row.decision_id, action: row.action, investor_id: row.investor_id, counterparty_id: row.counterparty_id, ticker: row.ticker, amount: Number(row.amount), asset: row.asset, outcome: row.outcome, what_ifs: row.what_ifs, units: row.units, created_at: row.decision_created_at, capital_call_id: row.capital_call_id ?? null };
  const ids = [dec.investor_id, ...(dec.counterparty_id ? [dec.counterparty_id] : [])];
  const { ctx } = await liveCtx(c, ids, dec.ticker, dec.capital_call_id ?? null);
  if (!ctx.investors[dec.investor_id] || !ctx.funds[dec.ticker] || (dec.counterparty_id && !ctx.investors[dec.counterparty_id])) throw new ApiError(409, 'state_changed', 'The investor, counterparty or fund on this decision no longer exists.');
  const d = evaluate({ action: dec.action, investorId: dec.investor_id, fundId: dec.ticker, amount: dec.amount, asset: dec.asset, counterpartyId: dec.counterparty_id ?? undefined }, [], ctx);
  const recheck = { outcome: d.outcome, inputs_sha256: await inputsHash(d), checked_at: new Date().toISOString(), retry: true };
  if (d.outcome !== 'ALLOW') throw new ApiError(409, 'state_changed', `The decision is no longer valid, so the settlement cannot be retried. ${d.headline}`, d.checks.filter((x) => x.result === 'fail'));
  if (dec.action === 'transfer' && !(await travelRuleApproved(sql, ws, dec.id))) throw new ApiError(409, 'travel_rule_pending', 'The Travel Rule message for this transfer is not approved, so it cannot settle yet.');
  const u = d.units; const t = dec.ticker;
  const retryStep = { step: 'retried', at: new Date().toISOString(), by: a.name, previous_status: row.status, previous_reason: row.chain?.reason ?? row.steps?.reason ?? row.job_error ?? null };
  const legacy = c.get('version') === LEGACY_VERSION;
  if (!legacy && (await chainEnabled(c))) {
    // Back to pending, with the earlier attempt kept in the step history, then a fresh chain job.
    await sql.transaction([
      sql`update settlements set status = 'pending', chain = ${JSON.stringify({ status: 'queued', retried_from: row.job_id ?? null })}::jsonb,
          steps = jsonb_set((coalesce(steps, '{}'::jsonb) - 'reason') || ${JSON.stringify({ simulated: false, recheck })}::jsonb, '{steps}', coalesce(steps->'steps', '[]'::jsonb) || ${JSON.stringify([retryStep])}::jsonb)
        where workspace_id = ${ws} and id = ${stlId}`,
      ...(row.job_id && row.job_status === 'failed' ? [sql`update chain_jobs set status = 'cancelled', error = coalesce(error, '') || ' Superseded by a retry.', cancelled_at = now(), cancelled_by = ${a.name}, updated_at = now() where id = ${row.job_id} and status = 'failed'`] : []),
      auditQ(sql, ws, a, 'settlement.retried', stlId, { decision: dec.id, previous_status: row.status, previous_job: row.job_id ?? null }),
    ]);
    let job: { job_id: string | null };
    try { job = await queueSettlement(c, { settlementId: stlId, decision: dec, units: u }); }
    catch (e) {
      await sql.transaction([
        sql`update settlements set status = 'reverted', steps = steps || ${JSON.stringify({ reason: 'The chain job could not be queued, so nothing moved.' })}::jsonb where workspace_id = ${ws} and id = ${stlId}`,
        auditQ(sql, ws, a, 'settlement.reverted', stlId, { decision: dec.id, reason: 'queue_failed' }),
      ]);
      throw new ApiError(502, 'chain_unavailable', 'The settlement could not be queued on chain. Nothing moved. Try again in a moment.');
    }
    bg(c, emit(sql, ws, 'settlement.pending', { id: stlId, decision: dec.id, units: u, fund: t, job_id: job.job_id, retry: true }));
    return settlementOut(await loadSettlement(c, stlId));
  }
  const fullRedemption = dec.action === 'redeem' && (ctx.investors[dec.investor_id].holdings[t]?.units ?? 0) - u <= 0.0001;
  const q = await simulatedLegQueries(sql, ws, ctx, dec, u, t);
  const steps = stepsFor(dec.action);
  q.push(sql`update settlements set status = 'settled', chain = null,
      steps = ${JSON.stringify({ simulated: true, chain: 'Ethereum', recheck, steps: [...((row.steps?.steps as any[]) ?? []), retryStep, ...steps] })}::jsonb
    where workspace_id = ${ws} and id = ${stlId} and status in ('pending', 'reverted')`);
  q.push(auditQ(sql, ws, a, 'settlement.completed', stlId, { decision: dec.id, action: dec.action, units: u, fund: t, simulated: true, retry: true }));
  if (row.job_id && row.job_status !== 'confirmed') q.push(sql`update chain_jobs set status = 'cancelled', error = 'Settled on the register by a retry.', cancelled_at = now(), cancelled_by = ${a.name}, updated_at = now() where id = ${row.job_id} and status in ('queued', 'failed')`);
  await sql.transaction(q);
  bg(c, emit(sql, ws, 'settlement.completed', { id: stlId, decision: dec.id, units: u, fund: t, retry: true }));
  if (dec.action === 'transfer') bg(c, travelRuleConfirm(c, dec.id, stlId));
  if (fullRedemption) bg(c, releaseWaitlist(c, t));
  return settlementOut(await loadSettlement(c, stlId));
}

routes.post('/settlements/:id/retry', async (c) => {
  need(c, 'orders:write');
  return c.json(await retrySettlement(c, c.req.param('id')));
});

/** Cancels a pending settlement whose chain job has not sent anything. The decision cannot be settled again afterwards; request a new one. */
routes.post('/settlements/:id/cancel', async (c) => {
  const a = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const stlId = c.req.param('id');
  const { reason } = await body(c, z.object({ reason: z.string().trim().max(300).optional() }));
  const row = await loadSettlement(c, stlId);
  const { cancellable } = settlementActions(row);
  if (!cancellable) {
    if (row.status !== 'pending') throw new ApiError(409, 'not_cancellable', `This settlement is ${row.status}, so there is nothing to cancel.`);
    throw new ApiError(409, 'already_sent', 'A transaction for this settlement is already on chain. Wait for the receipt; it settles or reverts on its own.');
  }
  const why = reason || `Cancelled by ${a.name} before anything was sent on chain.`;
  // The job update is conditional: if the job started in the meantime the whole transaction is refused.
  const [stl] = await sql.transaction([
    sql`update settlements set status = 'cancelled', chain = coalesce(chain, '{}'::jsonb) || ${JSON.stringify({ status: 'cancelled', reason: why })}::jsonb,
        steps = jsonb_set(coalesce(steps, '{}'::jsonb) || ${JSON.stringify({ reason: why })}::jsonb, '{steps}', coalesce(steps->'steps', '[]'::jsonb) || ${JSON.stringify([{ step: 'cancelled', at: new Date().toISOString(), by: a.name, reason: why }])}::jsonb)
      where workspace_id = ${ws} and id = ${stlId} and status = 'pending'
        and not exists (select 1 from chain_jobs j where j.kind = 'settle' and j.ref = ${stlId} and (j.status = 'running' or cardinality(j.tx_hashes) > 0)) returning id`,
    sql`update chain_jobs set status = 'cancelled', error = ${why}, cancelled_at = now(), cancelled_by = ${a.name}, updated_at = now() where kind = 'settle' and ref = ${stlId} and workspace_id = ${ws} and status in ('queued', 'failed') and cardinality(tx_hashes) = 0`,
    auditQ(sql, ws, a, 'settlement.cancelled', stlId, { decision: row.decision_id, reason: why }),
  ]);
  if (!stl.length) throw new ApiError(409, 'already_sent', 'The chain job started a moment ago, so this settlement can no longer be cancelled. Wait for the receipt.');
  bg(c, emit(sql, ws, 'settlement.cancelled', { id: stlId, decision: row.decision_id, reason: why }));
  return c.json(settlementOut(await loadSettlement(c, stlId)));
});

// ---------- Bulk eligibility ----------
routes.post('/eligibility/bulk', async (c) => {
  const a = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({
    rows: z.array(z.object({ name: z.string().trim().min(1).max(120), kind: z.string().default('Corporate'), residence: z.string(), booking_center: z.string(), us_person: z.boolean().default(false), classes: z.array(z.string()).default([]) })).min(1).max(200),
    funds: z.array(z.string()).optional(),
  }));
  const [g, funds, matches] = await Promise.all([loadGlobals(sql), loadFunds(sql, ws, null), screenNames(sql, ws, b.rows.map((r) => r.name))]);
  const tickers = (b.funds?.length ? b.funds : Object.keys(funds)).filter((t) => funds[t]);
  const t0 = today(); const exp = addDays(t0, 365);
  const investors: Record<string, Investor> = {};
  b.rows.forEach((r, i) => {
    investors[`row${i}`] = {
      id: `row${i}`, name: r.name, short: r.name, kind: r.kind, residence: r.residence, city: '', booking: r.booking_center, usPerson: r.us_person || r.residence === 'US', wallet: '',
      credentialId: `BULK-${i}`, issued: t0, expires: exp,
      classifications: r.classes.filter((x) => g.classInfo[x]).map((code) => ({ code, basis: 'Declared in bulk upload', verified: t0, expires: exp, optIn: code === 'SG_AI' ? t0 : undefined })), holdings: {},
    };
  });
  const ctx: Ctx = {
    classInfo: g.classInfo, bookingCenters: g.bookingCenters, jurName: g.jurName, sanctioned: g.sanctioned, investors, funds, today: t0, rulePacks: packsAsOf(g, t0),
    screen: (n) => { const m = matches[n]; return m ? { entry: m.entry, program: m.program, score: m.score, source: m.source } : null; },
  };
  const data = b.rows.map((r, i) => ({
    row: i + 1, name: r.name, residence: r.residence, screening: matches[r.name] ? { entry: matches[r.name]!.entry, program: matches[r.name]!.program, score: matches[r.name]!.score } : null,
    results: tickers.map((t) => {
      if (!g.jurName[r.residence] || !g.bookingCenters[r.booking_center]) return { fund: t, outcome: 'DENY', reason: 'Unknown residence or booking center. See GET /v1/jurisdictions and /v1/booking-centers.', binding: [] };
      const d = evaluate({ action: 'subscribe', investorId: `row${i}`, fundId: t, amount: funds[t].minSubscription || 1, asset: funds[t].assets[0] }, [], ctx);
      return { fund: t, outcome: d.outcome, reason: d.outcome === 'ALLOW' ? (d.resolved.map((x) => x.text).join('; ') || 'No investor-class restriction') : d.checks.find((x) => x.result === 'fail')?.detail ?? '', binding: d.resolved.map((x) => x.ruleRef) };
    }),
  }));
  await audit(sql, ws, a, 'eligibility.bulk_checked', null, { rows: b.rows.length, funds: tickers, potential_matches: Object.values(matches).filter(Boolean).length });
  return c.json({ funds: tickers, data, note: 'Bulk results assume each declared classification is verified today. Required fund documents are not checked here.' });
});

// ---------- Approval executors for the actions this file owns ----------
// credential.issue: the stored CredentialInput is issued under the approver's name; the request keeps the requester.
registerExecutor('credential.issue', async (c, r) => issueCredential(c, r.payload.input as CredentialInput, c.get('actor')));
// order.large: the stored order is decided (the approval already happened, so no second gate) and, when allowed and
// not batched, settled at once by the approver.
registerExecutor('order.large', async (c, r) => {
  const d = await createDecision(c, r.payload.input as DecisionInput, { bypassApproval: true });
  if (!d.persisted) return { decision: d };
  const head = { id: d.id, outcome: d.outcome, headline: d.headline };
  if (d.outcome !== 'ALLOW') return { decision: head, settlement: null, note: 'The order no longer passes, so nothing settled.' };
  if (d.in_batch) return { decision: { ...head, batch_id: d.batch_id }, settlement: null, note: 'The order joined its dealing-date batch and settles with it.' };
  const [dec] = await c.get('sql')`select id, action, investor_id, counterparty_id, ticker, amount::float8 as amount, asset, outcome, what_ifs, units::float8 as units, inputs_sha256, created_at, capital_call_id, batch_id from decisions where workspace_id = ${c.get('ws')} and id = ${d.id}`;
  try {
    const s = await executeSettlement(c, dec);
    return { decision: head, settlement: s.settlement };
  } catch (e: any) {
    return { decision: head, settlement: null, settlement_error: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e?.message ?? e), note: 'The decision is recorded; settle it from the decision page within 15 minutes.' };
  }
});
