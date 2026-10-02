// Workflow routes: the approvals queue and policies, settings changes through approval, client edits with
// maker-checker and revision history, the holder-cap waitlist, order batches at the dealing cut-off, global
// search, concentration limits, suitability assessments and FATCA/CRS tax profiles. The engine-side checks
// (concentration, suitability, tax) are exported for core.ts to call after evaluate().
import { z } from 'zod';
import type { Check } from '../../../src/proto/engine';
import type { Investor, Fund } from '../../../src/proto/data';
import type { Sql } from '../db';
import { ApiError, id, rand, sha256, today, addDays, validCidr } from '../util';
import { type C, type Actor, router, body, bg, need, audit, auditQ, SCOPES, ROLE_LABEL, type Role } from '../http';
import { notifyRoles, notify } from '../notifications';
import { loadGlobals, loadInvestors, emit } from '../ctx';
import { runMonitor } from '../monitor';
import { aumOf } from '../fundops-core';
import { pageParams, pageOut } from '../pagination';
import {
  requireApproval, registerExecutor, loadPolicies, loadRequest, approveRequest, rejectRequest, expireOverdue, presentRequest, approvalOut,
  APPROVAL_KINDS, DEFAULT_POLICIES, isPending, type ApprovalKind, type ApprovalRow,
} from '../approvals';
import { createDecision, executeSettlement } from './core';

export const routes = router();
const adminOf = (c: C): Sql => c.get('admin');
const r2 = (n: number) => Math.round(n * 100) / 100;

// ===========================================================================
// 1. Approvals queue and policies
// ===========================================================================

const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'expired'];
/** Approval requests, newest first, with cursor pagination. Filters: status, kind. */
routes.get('/approvals', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  await expireOverdue(sql, ws);
  const page = pageParams(c, 50, 200);
  const status = c.req.query('status') || null; const kind = c.req.query('kind') || null;
  if (status && !APPROVAL_STATES.includes(status)) throw new ApiError(400, 'invalid_filter', `status must be one of ${APPROVAL_STATES.join(', ')}.`);
  if (kind && !(APPROVAL_KINDS as string[]).includes(kind)) throw new ApiError(400, 'invalid_filter', `kind must be one of ${APPROVAL_KINDS.join(', ')}.`);
  const [rows, [counts], policies] = await Promise.all([
    sql`select * from approval_requests where workspace_id = ${ws} and (${status}::text is null or status = ${status}) and (${kind}::text is null or kind = ${kind})
      and (${page.at}::timestamptz is null or (created_at, id) < (${page.at}::timestamptz, ${page.id})) order by created_at desc, id desc limit ${page.limit + 1}`,
    sql`select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'approved')::int as approved, count(*) filter (where status = 'rejected')::int as rejected, count(*) filter (where status = 'expired')::int as expired from approval_requests where workspace_id = ${ws}`,
    loadPolicies(sql, ws),
  ]);
  const out = pageOut(rows as any[], page);
  const mine = (r: ApprovalRow) => (r.requested_by_user ? r.requested_by_user === a.userId : r.requested_by === a.name);
  return c.json({
    ...out,
    data: out.data.map((r: any) => { const x = presentRequest(approvalOut(r), a); return { ...x, can_decide: x.status === 'pending' && a.kind === 'user' && !mine(x) && (a.role === 'admin' || policies[x.kind]?.roles.includes(a.role ?? '')) && !x.approvals.some((y) => y.user_id === a.userId), requested_by_me: mine(x), label: DEFAULT_POLICIES[x.kind]?.label ?? x.kind }; }),
    counts, filters: { status, kind },
  });
});
routes.get('/approvals/:id', async (c) => {
  need(c, 'read');
  const r = await loadRequest(c, c.req.param('id'));
  return c.json({ ...presentRequest(r, c.get('actor')), label: DEFAULT_POLICIES[r.kind]?.label ?? r.kind });
});
const noteIn = z.object({ note: z.string().trim().max(500).optional() });
routes.post('/approvals/:id/approve', async (c) => {
  need(c, 'read');
  const { note } = await body(c, noteIn);
  const r = await approveRequest(c, c.req.param('id'), note ?? null);
  return c.json({ ...presentRequest(r, c.get('actor')), executed: r.executed, label: DEFAULT_POLICIES[r.kind]?.label ?? r.kind });
});
routes.post('/approvals/:id/reject', async (c) => {
  need(c, 'read');
  const { note } = await body(c, noteIn);
  const r = await rejectRequest(c, c.req.param('id'), note ?? null);
  return c.json({ ...r, label: DEFAULT_POLICIES[r.kind]?.label ?? r.kind });
});

const policiesOut = (p: Awaited<ReturnType<typeof loadPolicies>>) => ({
  data: APPROVAL_KINDS.map((k) => ({ ...p[k], label: DEFAULT_POLICIES[k].label, description: DEFAULT_POLICIES[k].description, default_threshold: DEFAULT_POLICIES[k].threshold })),
  roles: Object.entries(ROLE_LABEL).map(([id, label]) => ({ id, label })),
});
routes.get('/approval-policies', async (c) => {
  need(c, 'read');
  return c.json(policiesOut(await loadPolicies(c.get('sql'), c.get('ws'))));
});
const ROLES = ['admin', 'ops', 'compliance', 'issuer', 'developer', 'auditor'] as const;
const policyIn = z.object({
  kind: z.enum(['credential.issue', 'order.large', 'settings.change', 'investor.update']),
  enabled: z.boolean().optional(),
  threshold: z.record(z.string(), z.unknown()).optional(),
  required_approvals: z.number().int().min(1).max(5).optional(),
  roles: z.array(z.enum(ROLES)).min(1).max(6).optional(),
});
/** Updates one or more policies. Administrators only, and the change itself is audited. */
routes.put('/approval-policies', async (c) => {
  const a = need(c, 'members:admin');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ policies: z.array(policyIn).min(1).max(APPROVAL_KINDS.length) }));
  const current = await loadPolicies(sql, ws);
  const q: any[] = [];
  for (const p of b.policies) {
    const cur = current[p.kind];
    const threshold = p.threshold ? validateThreshold(p.kind, p.threshold) : cur.threshold;
    const roles = p.roles ?? cur.roles;
    if (!roles.includes('admin') && p.kind === 'settings.change') throw new ApiError(422, 'admin_required', 'Settings changes must keep administrators among the approvers.');
    q.push(sql`update approval_policies set enabled = ${p.enabled ?? cur.enabled}, threshold = ${JSON.stringify(threshold)}, required_approvals = ${p.required_approvals ?? cur.required_approvals}, roles = ${roles}, updated_by = ${a.name}, updated_at = now() where workspace_id = ${ws} and kind = ${p.kind}`);
    q.push(auditQ(sql, ws, a, 'approval_policy.updated', p.kind, { before: { enabled: cur.enabled, threshold: cur.threshold, required_approvals: cur.required_approvals, roles: cur.roles }, after: { enabled: p.enabled ?? cur.enabled, threshold, required_approvals: p.required_approvals ?? cur.required_approvals, roles } }));
  }
  await sql.transaction(q);
  return c.json(policiesOut(await loadPolicies(sql, ws)));
});
function validateThreshold(kind: ApprovalKind, t: Record<string, unknown>): Record<string, unknown> {
  const d = DEFAULT_POLICIES[kind].threshold;
  if (kind === 'order.large') {
    const amt = (t.amount && typeof t.amount === 'object' ? t.amount : {}) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const ccy of ['USD', 'EUR']) { const v = Number(amt[ccy] ?? (d.amount as any)[ccy]); if (!Number.isFinite(v) || v <= 0) throw new ApiError(422, 'invalid_threshold', `amount.${ccy} must be a positive number.`); out[ccy] = v; }
    return { amount: out };
  }
  if (kind === 'credential.issue') {
    const kinds = Array.isArray(t.investor_kinds) ? t.investor_kinds.map(String).slice(0, 10) : d.investor_kinds;
    const min = Number(t.min_classes ?? d.min_classes);
    if (!Number.isInteger(min) || min < 0 || min > 10) throw new ApiError(422, 'invalid_threshold', 'min_classes must be a whole number from 0 to 10.');
    return { investor_kinds: kinds, min_classes: min };
  }
  if (kind === 'settings.change') {
    const actions = Array.isArray(t.actions) ? t.actions.map(String).filter((x) => ['member.role', 'sso', 'api_key.create'].includes(x)) : d.actions;
    const scopes = Array.isArray(t.api_key_scopes) ? t.api_key_scopes.map(String).filter((x) => x in SCOPES) : d.api_key_scopes;
    return { actions, api_key_scopes: scopes };
  }
  const fields = Array.isArray(t.fields) ? t.fields.map(String).filter((x) => ['name', 'kind', 'residence', 'city', 'booking_center', 'us_person', 'email', 'wallet'].includes(x)) : d.fields;
  return { fields };
}

// ---------- Settings changes through approval ----------
// PATCH /v1/members/:id, POST /v1/api-keys and PUT /v1/sso live in auth.ts and platform.ts. This route is the
// approval-gated path for the same writes: it stores the change and the executor below applies it once approved.
const roleZ = z.enum(ROLES);
const settingsIn = z.discriminatedUnion('action', [
  z.object({ action: z.literal('member.role'), user_id: z.string().uuid(), role: roleZ }),
  z.object({ action: z.literal('api_key.create'), name: z.string().trim().min(1).max(60).default('API key'), scopes: z.array(z.string()).min(1).max(8), ip_allowlist: z.array(z.string().trim()).max(20).optional(), expires_in_days: z.number().int().min(1).max(365).optional() }),
  z.object({ action: z.literal('sso'), enabled: z.boolean() }),
]);
type SettingsChange = z.infer<typeof settingsIn>;
const MAX_KEYS = 10;

async function applySettingsChange(c: C, ch: SettingsChange, a: Actor, approvalId: string | null): Promise<Record<string, unknown>> {
  const sql = c.get('sql'); const ws = c.get('ws'); const admin = adminOf(c);
  if (ch.action === 'member.role') {
    if (ch.role !== 'admin') {
      const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${ws} and role = 'admin' and user_id <> ${ch.user_id}`;
      if (n === 0) throw new ApiError(422, 'last_admin', 'An organization needs at least one administrator.');
    }
    const r = await admin`update memberships set role = ${ch.role} where workspace_id = ${ws} and user_id = ${ch.user_id} returning user_id`;
    if (!r.length) throw new ApiError(404, 'not_found', 'That person is not a member.');
    await audit(sql, ws, a, 'member.role_changed', ch.user_id, { role: ch.role, approval: approvalId });
    return { user_id: ch.user_id, role: ch.role };
  }
  if (ch.action === 'api_key.create') {
    const scopes = [...new Set(ch.scopes)];
    const unknown = scopes.filter((s) => !(s in SCOPES));
    if (unknown.length) throw new ApiError(422, 'unknown_scope', `Unknown scope ${unknown.join(', ')}. Use ${Object.keys(SCOPES).join(', ')}.`);
    const bad = (ch.ip_allowlist ?? []).filter((x) => !validCidr(x));
    if (bad.length) throw new ApiError(422, 'invalid_cidr', `Not a valid IP address or CIDR range: ${bad.join(', ')}.`);
    const [{ n }] = await sql`select count(*)::int as n from api_keys where workspace_id = ${ws} and (expires_at is null or expires_at > now())`;
    if (n >= MAX_KEYS) throw new ApiError(422, 'limit', `An organization can have up to ${MAX_KEYS} active keys. Revoke one first.`);
    const key = `lz_test_${rand(32)}`;
    const expires = ch.expires_in_days ? new Date(Date.now() + ch.expires_in_days * 86_400_000).toISOString() : null;
    const allow = ch.ip_allowlist?.length ? ch.ip_allowlist : null;
    const [[row]] = await sql.transaction([
      sql`insert into api_keys (workspace_id, prefix, key_hash, name, scopes, ip_allowlist, expires_at, created_by) values (${ws}, ${key.slice(0, 12)}, ${await sha256(key)}, ${ch.name}, ${scopes}, ${allow}, ${expires}, ${a.realUserId ?? a.userId ?? null})
        returning id, name, prefix, scopes, ip_allowlist, expires_at, created_at`,
      auditQ(sql, ws, a, 'api_key.created', key.slice(0, 12), { name: ch.name, scopes, ip_allowlist: allow, expires_at: expires, approval: approvalId }),
    ]);
    return { key: row, secret: key, note: 'Store this key now. It is shown once, to the person who requested it.' };
  }
  const [w] = await admin`select sso from workspaces where id = ${ws}`;
  if (!w?.sso) throw new ApiError(409, 'sso_not_configured', 'Single sign-on is not configured yet. Configure it with PUT /v1/sso first.');
  await admin`update workspaces set sso = sso || ${JSON.stringify({ enabled: ch.enabled })}::jsonb where id = ${ws}`;
  await audit(sql, ws, a, 'sso.configured', ws, { enabled: ch.enabled, issuer: w.sso.issuer, email_domain: w.sso.email_domain, approval: approvalId });
  return { enabled: ch.enabled };
}
registerExecutor('settings.change', (c, r) => applySettingsChange(c, settingsIn.parse(r.payload.change), c.get('actor'), r.id));

routes.post('/settings-changes', async (c) => {
  const a = need(c, 'members:admin');
  const ch = await body(c, settingsIn);
  if (ch.action === 'api_key.create') need(c, 'keys:admin');
  const label = ch.action === 'member.role' ? `Change member role to ${ROLE_LABEL[ch.role as Role]}` : ch.action === 'api_key.create' ? `Create API key "${ch.name}" (${ch.scopes.join(', ')})` : `${ch.enabled ? 'Enable' : 'Disable'} single sign-on`;
  const res = await requireApproval(c, 'settings.change', ch.action === 'member.role' ? ch.user_id : null, { change: ch, action: ch.action, scopes: ch.action === 'api_key.create' ? ch.scopes : [] }, () => applySettingsChange(c, ch, a, null), { title: label, link: '#/approvals' });
  if (isPending(res)) return c.json(res, 202);
  return c.json({ pending: false, result: res }, 201);
});

// ===========================================================================
// 2. Client edits: maker-checker and revision history
// ===========================================================================

const investorPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(), kind: z.string().trim().min(2).max(60).optional(), residence: z.string().min(2).max(10).optional(),
  city: z.string().trim().min(1).max(80).optional(), booking_center: z.string().min(2).max(10).optional(), us_person: z.boolean().optional(),
  email: z.string().trim().toLowerCase().email().max(160).nullable().optional(), wallet: z.string().trim().min(4).max(80).optional(),
}).strict();
type InvestorPatch = z.infer<typeof investorPatch>;
const INVESTOR_FIELDS = ['name', 'kind', 'residence', 'city', 'booking_center', 'us_person', 'email', 'wallet'] as const;

async function applyInvestorUpdate(c: C, invId: string, changes: Record<string, { from: unknown; to: unknown }>, a: Actor, approved: { by: string; id: string } | null) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [cur] = await sql`select name, kind, residence, city, booking_center, us_person, email, wallet from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!cur) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const next: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(changes)) next[k] = v.to;
  if (next.residence === 'US') next.us_person = true;
  const residenceChanged = 'residence' in changes;
  const [, [rev]] = await sql.transaction([
    sql`update investors set name = ${next.name}, short_name = ${String(next.name).split(/\s+/).slice(0, 3).join(' ')}, kind = ${next.kind}, residence = ${next.residence}, city = ${next.city}, booking_center = ${next.booking_center},
        us_person = ${next.us_person}, email = ${next.email ?? null}, wallet = ${next.wallet} where workspace_id = ${ws} and id = ${invId}`,
    sql`insert into investor_revisions (workspace_id, investor_id, revision, changes, changed_by, approved_by, approval_id)
      select ${ws}, ${invId}, coalesce(max(revision), 0) + 1, ${JSON.stringify(changes)}, ${a.name}, ${approved?.by ?? null}, ${approved?.id ?? null} from investor_revisions where workspace_id = ${ws} and investor_id = ${invId} returning revision`,
    auditQ(sql, ws, a, 'investor.updated', invId, { changes, approved_by: approved?.by ?? null, approval: approved?.id ?? null }),
  ]);
  if (residenceChanged) {
    // A new residence changes which rule pack applies: re-check this holder now rather than at the nightly sweep.
    bg(c, Promise.all([
      runMonitor(sql, ws, 'investor.residence_changed', { admin: adminOf(c), investorIds: [invId], defer: (p) => bg(c, p), requestedBy: a.name }).catch((e) => console.error('monitor after residence change failed', e)),
      emit(sql, ws, 'investor.updated', { investor: invId, changes: Object.keys(changes), residence: next.residence }),
    ]));
  } else {
    bg(c, emit(sql, ws, 'investor.updated', { investor: invId, changes: Object.keys(changes) }));
  }
  const inv = (await loadInvestors(sql, ws, [invId], adminOf(c)))[invId];
  return { investor: inv, revision: Number(rev.revision), changes, monitoring_rechecked: residenceChanged };
}
registerExecutor('investor.update', async (c, r) => {
  const approver = r.approvals[r.approvals.length - 1];
  return applyInvestorUpdate(c, r.payload.investor_id, r.payload.changes, c.get('actor'), { by: approver?.name ?? c.get('actor').name, id: r.id });
});

routes.patch('/investors/:id', async (c) => {
  const a = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const b: InvestorPatch = await body(c, investorPatch);
  const [cur] = await sql`select name, kind, residence, city, booking_center, us_person, email, wallet from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!cur) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const g = await loadGlobals(sql);
  if (b.residence !== undefined && (!g.jurName[b.residence] || b.residence === 'GLOBAL')) throw new ApiError(422, 'unknown_jurisdiction', `Residence ${b.residence} is not a supported jurisdiction. See GET /v1/jurisdictions.`);
  if (b.booking_center !== undefined && !g.bookingCenters[b.booking_center]) throw new ApiError(422, 'unknown_booking_center', `Booking center ${b.booking_center} does not exist. See GET /v1/booking-centers.`);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of INVESTOR_FIELDS) {
    if (b[k] === undefined) continue;
    const from = cur[k] ?? null; const to = b[k] ?? null;
    if (from !== to) changes[k] = { from, to };
  }
  if (!Object.keys(changes).length) throw new ApiError(422, 'no_change', 'Nothing differs from the current record.');
  const changed = Object.keys(changes);
  const res = await requireApproval(c, 'investor.update', invId, { investor_id: invId, investor_name: cur.name, changes, changed_fields: changed }, () => applyInvestorUpdate(c, invId, changes, a, null), {
    title: `Change ${changed.join(', ')} for ${cur.name}`, link: `#/clients/${invId}`,
  });
  if (isPending(res)) return c.json({ ...res, changes }, 202);
  return c.json({ pending: false, ...res });
});

routes.get('/investors/:id/revisions', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const [exists] = await sql`select 1 from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!exists) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const [rows, pending] = await Promise.all([
    sql`select revision, changes, changed_by, changed_at, approved_by, approval_id from investor_revisions where workspace_id = ${ws} and investor_id = ${invId} order by revision desc limit 200`,
    sql`select id, title, requested_by, created_at, expires_at, payload->'changes' as changes from approval_requests where workspace_id = ${ws} and kind = 'investor.update' and subject = ${invId} and status = 'pending' order by created_at desc`,
  ]);
  return c.json({ data: rows, pending });
});

// ===========================================================================
// 3. Holder-cap waitlist
// ===========================================================================

const CAP_CHECKS = new Set(['cap', 'placement_cap', 'cap12g']);
/** True when a subscribe decision failed only because of a holder count limit, so the order can wait for a slot. */
export function waitlistEligible(d: { outcome: string; checks: Check[] }, action: string): boolean {
  if (action !== 'subscribe' || d.outcome !== 'DENY') return false;
  const fails = d.checks.filter((x) => x.result === 'fail');
  return fails.length > 0 && fails.every((x) => CAP_CHECKS.has(x.id));
}

const waitlistIn = z.object({ ticker: z.string().min(1).max(10), investor_id: z.string().min(1), amount: z.number().positive().max(1e12), asset: z.string().min(1).max(20) });
routes.post('/waitlist', async (c) => {
  const a = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, waitlistIn);
  const [[inv], [fund], dup] = await Promise.all([
    sql`select id, name from investors where workspace_id = ${ws} and id = ${b.investor_id}`,
    sql`select ticker, short_name, assets, holder_cap, holders from funds where workspace_id = ${ws} and ticker = ${b.ticker}`,
    sql`select id from waitlist where workspace_id = ${ws} and ticker = ${b.ticker} and investor_id = ${b.investor_id} and status = 'waiting'`,
  ]);
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${b.investor_id} in this organization.`);
  if (!fund) throw new ApiError(404, 'not_found', `No fund ${b.ticker} in this organization.`);
  if (!(fund.assets as string[]).includes(b.asset)) throw new ApiError(422, 'bad_asset', `${fund.short_name} settles only in ${(fund.assets as string[]).join(' or ')}.`);
  if (dup.length) throw new ApiError(409, 'already_waiting', `${inv.name} is already on the ${b.ticker} waitlist as ${dup[0].id}.`);
  // Only orders the cap refuses belong here: evaluate without persisting and require a cap-only refusal.
  const d = await createDecision(c, { action: 'subscribe', investor_id: b.investor_id, fund: b.ticker, amount: b.amount, settle_with: b.asset, persist: false }, { bypassApproval: true });
  if (isPending(d)) throw new ApiError(409, 'approval_pending', 'This order is waiting for approval, so it cannot join the waitlist yet.');
  if (!waitlistEligible(d as any, 'subscribe')) {
    if (d.outcome === 'ALLOW') throw new ApiError(409, 'not_needed', 'This order is allowed right now. Place it instead of waiting.');
    throw new ApiError(409, 'not_eligible', `The waitlist is for orders refused only by a holder limit. ${d.headline}`);
  }
  const wlId = id('wl', 10);
  const [[pos]] = await sql.transaction([
    sql`insert into waitlist (workspace_id, id, ticker, investor_id, amount, asset, reason, created_by) values (${ws}, ${wlId}, ${b.ticker}, ${b.investor_id}, ${b.amount}, ${b.asset}, ${(d as any).headline}, ${a.name})
      returning (select count(*)::int + 1 from waitlist w where w.workspace_id = ${ws} and w.ticker = ${b.ticker} and w.status = 'waiting' and w.id <> ${wlId}) as position`,
    auditQ(sql, ws, a, 'waitlist.joined', wlId, { ticker: b.ticker, investor: b.investor_id, amount: b.amount, asset: b.asset }),
  ]);
  return c.json({ id: wlId, ticker: b.ticker, investor_id: b.investor_id, investor: inv.name, amount: b.amount, asset: b.asset, status: 'waiting', position: Number(pos.position), holders: fund.holders, holder_cap: fund.holder_cap, note: 'The order is re-evaluated, oldest first, each time a holder fully redeems. When it passes, a decision is recorded and operations are notified to settle it within 15 minutes.' }, 201);
});
routes.get('/waitlist', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const status = c.req.query('status') || 'waiting'; const ticker = c.req.query('fund') || null;
  if (!['waiting', 'released', 'cancelled', 'expired', 'all'].includes(status)) throw new ApiError(400, 'invalid_filter', 'status must be waiting, released, cancelled, expired or all.');
  const rows = await sql`select w.*, w.amount::float8 as amount, i.name as investor, i.residence, f.short_name as fund, f.currency, f.holders, f.holder_cap,
      row_number() over (partition by w.ticker order by w.created_at) as position
    from waitlist w join investors i on i.workspace_id = w.workspace_id and i.id = w.investor_id join funds f on f.workspace_id = w.workspace_id and f.ticker = w.ticker
    where w.workspace_id = ${ws} and (${status} = 'all' or w.status = ${status}) and (${ticker}::text is null or w.ticker = ${ticker}) order by w.ticker, w.created_at limit 500`;
  return c.json({ data: rows.map((r: any) => ({ ...r, position: r.status === 'waiting' ? Number(r.position) : null })), filters: { status, fund: ticker } });
});
routes.delete('/waitlist/:id', async (c) => {
  const a = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const wlId = c.req.param('id');
  const [r] = await sql.transaction([
    sql`update waitlist set status = 'cancelled' where workspace_id = ${ws} and id = ${wlId} and status = 'waiting' returning id, ticker, investor_id`,
    auditQ(sql, ws, a, 'waitlist.cancelled', wlId, {}),
  ]);
  if (!r.length) throw new ApiError(404, 'not_found', `No waiting entry ${wlId}. It may already be released or cancelled.`);
  return c.json({ id: wlId, status: 'cancelled' });
});

/**
 * Called when a settlement frees a holder slot (a full redemption). Re-evaluates the oldest waiting entries for the
 * fund; each that now passes gets a persisted decision and operations are told to settle it. Released entries are
 * limited to the slots freed so two entries do not chase one slot.
 */
export async function releaseWaitlist(c: C, ticker: string): Promise<{ released: string[]; checked: number }> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [[fund], waiting] = await Promise.all([
    sql`select ticker, short_name, holders, holder_cap from funds where workspace_id = ${ws} and ticker = ${ticker}`,
    sql`select id, investor_id, amount::float8 as amount, asset from waitlist where workspace_id = ${ws} and ticker = ${ticker} and status = 'waiting' order by created_at limit 10`,
  ]);
  if (!fund || !waiting.length) return { released: [], checked: 0 };
  let slots = fund.holder_cap ? Math.max(0, Number(fund.holder_cap) - Number(fund.holders)) : 1;
  const released: string[] = [];
  let checked = 0;
  for (const w of waiting) {
    if (slots <= 0) break;
    checked++;
    let d: any;
    try { d = await createDecision(c, { action: 'subscribe', investor_id: w.investor_id, fund: ticker, amount: w.amount, settle_with: w.asset, persist: true }, { bypassApproval: false, bypassBatch: true }); }
    catch (e) { console.error('waitlist re-evaluation failed', w.id, e); continue; }
    if (isPending(d)) {
      await notifyRoles(sql, ws, ['admin', 'compliance'], { kind: 'waitlist.approval', title: `Waitlisted ${ticker} order for ${w.investor_id} needs approval`, body: `A holder slot opened and the order now passes, but it is above the large-order threshold. Approve it to place and settle it.`, link: `#/approvals/${d.approval_id}` });
      slots--; continue;
    }
    if (d.outcome !== 'ALLOW') continue;
    slots--;
    released.push(w.id);
    await sql.transaction([
      sql`update waitlist set status = 'released', released_decision_id = ${d.id}, released_at = now() where workspace_id = ${ws} and id = ${w.id}`,
      auditQ(sql, ws, c.get('actor'), 'waitlist.released', w.id, { ticker, investor: w.investor_id, decision: d.id }),
    ]);
    await notifyRoles(sql, ws, ['admin', 'ops'], { kind: 'waitlist.released', title: `Waitlist: ${fund.short_name} slot released`, body: `A holder fully redeemed. The oldest waiting order now passes every check and is recorded as decision ${d.id}. Settle it within 15 minutes or it expires and goes back to the queue.`, link: `#/decisions/${d.id}` });
  }
  if (released.length) bg(c, emit(sql, ws, 'waitlist.released', { ticker, entries: released }));
  return { released, checked };
}

// ===========================================================================
// 4. Order batches at the dealing cut-off
// ===========================================================================

/** The UTC instant of a wall-clock time in an IANA zone, without a time-zone library. */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m);
  const offsetAt = (ms: number) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - ms;
    } catch { return 0; }
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/** Finds or creates the open batch for a fund and dealing date. Returns its id. */
export async function joinBatch(sql: Sql, ws: string, fund: Fund, dealingDate: string): Promise<string> {
  const [open] = await sql`select id from order_batches where workspace_id = ${ws} and ticker = ${fund.ticker} and dealing_date = ${dealingDate}::date and status = 'open'`;
  if (open) return open.id;
  const batchId = id('bat', 10);
  const cutoff = zonedInstant(dealingDate, fund.cutoffTime ?? '16:00', fund.cutoffTz ?? 'America/New_York').toISOString();
  try {
    await sql`insert into order_batches (workspace_id, id, ticker, dealing_date, cutoff_at) values (${ws}, ${batchId}, ${fund.ticker}, ${dealingDate}::date, ${cutoff})`;
    return batchId;
  } catch (e: any) {
    if (e?.code === '23505') { const [again] = await sql`select id from order_batches where workspace_id = ${ws} and ticker = ${fund.ticker} and dealing_date = ${dealingDate}::date and status = 'open'`; if (again) return again.id; }
    throw e;
  }
}

const BATCH_STATES = ['open', 'closed', 'settled'];
async function batchTotals(sql: Sql, ws: string, batchId: string) {
  const [t] = await sql`select count(*)::int as orders, count(*) filter (where outcome = 'ALLOW')::int as allowed, count(*) filter (where outcome <> 'ALLOW')::int as refused,
      coalesce(sum(amount) filter (where action = 'subscribe' and outcome = 'ALLOW'), 0)::float8 as gross_subscriptions, coalesce(sum(units) filter (where action = 'subscribe' and outcome = 'ALLOW'), 0)::float8 as subscription_units,
      coalesce(sum(amount) filter (where action = 'redeem' and outcome = 'ALLOW'), 0)::float8 as gross_redemptions, coalesce(sum(units) filter (where action = 'redeem' and outcome = 'ALLOW'), 0)::float8 as redemption_units
    from decisions where workspace_id = ${ws} and batch_id = ${batchId}`;
  return { ...t, net: r2(Number(t.gross_subscriptions) - Number(t.gross_redemptions)), net_units: r2(Number(t.subscription_units) - Number(t.redemption_units)) };
}
async function batchProgress(sql: Sql, ws: string, batchId: string) {
  const [p] = await sql`select count(*) filter (where d.outcome = 'ALLOW')::int as allowed, count(*) filter (where d.outcome = 'ALLOW' and s.status in ('settled', 'pending'))::int as settled,
      count(*) filter (where d.outcome = 'ALLOW' and s.id is null)::int as remaining, count(*) filter (where d.outcome = 'ALLOW' and s.status in ('reverted', 'cancelled'))::int as failed
    from decisions d left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id where d.workspace_id = ${ws} and d.batch_id = ${batchId}`;
  return p;
}
const batchOut = (b: any) => ({ ...b, dealing_date: String(b.dealing_date).slice(0, 10), totals: b.totals ?? null, progress: b.progress ?? null });

routes.get('/batches', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const page = pageParams(c, 50, 200);
  const status = c.req.query('status') || null; const ticker = c.req.query('fund') || null;
  if (status && !BATCH_STATES.includes(status)) throw new ApiError(400, 'invalid_filter', `status must be one of ${BATCH_STATES.join(', ')}.`);
  const rows = await sql`select b.*, b.dealing_date::text as dealing_date, f.short_name as fund, f.currency, (select count(*)::int from decisions d where d.workspace_id = b.workspace_id and d.batch_id = b.id) as orders,
      (select count(*)::int from decisions d where d.workspace_id = b.workspace_id and d.batch_id = b.id and d.outcome = 'ALLOW') as allowed
    from order_batches b join funds f on f.workspace_id = b.workspace_id and f.ticker = b.ticker
    where b.workspace_id = ${ws} and (${status}::text is null or b.status = ${status}) and (${ticker}::text is null or b.ticker = ${ticker})
      and (${page.at}::timestamptz is null or (b.created_at, b.id) < (${page.at}::timestamptz, ${page.id})) order by b.created_at desc, b.id desc limit ${page.limit + 1}`;
  const out = pageOut(rows as any[], page);
  return c.json({ ...out, data: out.data.map(batchOut), filters: { status, fund: ticker } });
});
async function loadBatch(c: C, batchId: string) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [b] = await sql`select b.*, b.dealing_date::text as dealing_date, f.short_name as fund, f.currency, f.nav::float8 as nav from order_batches b join funds f on f.workspace_id = b.workspace_id and f.ticker = b.ticker where b.workspace_id = ${ws} and b.id = ${batchId}`;
  if (!b) throw new ApiError(404, 'not_found', `No batch ${batchId} in this organization.`);
  return b;
}
routes.get('/batches/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await loadBatch(c, c.req.param('id'));
  const [orders, totals, progress] = await Promise.all([
    sql`select d.id, d.action, d.investor_id, i.name as investor, d.amount::float8 as amount, d.units::float8 as units, d.asset, d.outcome, d.headline, d.created_at, s.id as settlement_id, s.status as settlement_status
      from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id
      where d.workspace_id = ${ws} and d.batch_id = ${b.id} order by d.created_at`,
    batchTotals(sql, ws, b.id), batchProgress(sql, ws, b.id),
  ]);
  return c.json({ ...batchOut(b), totals: b.totals ?? totals, live_totals: totals, progress, orders, after_cutoff: new Date(b.cutoff_at).getTime() <= Date.now() });
});
routes.post('/batches/:id/close', async (c) => {
  const a = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const { force } = await body(c, z.object({ force: z.boolean().default(false) }));
  const b = await loadBatch(c, c.req.param('id'));
  if (b.status !== 'open') throw new ApiError(409, 'not_open', `This batch is already ${b.status}.`);
  if (new Date(b.cutoff_at).getTime() > Date.now() && !force) throw new ApiError(409, 'before_cutoff', `The cut-off for dealing ${b.dealing_date} is ${new Date(b.cutoff_at).toISOString()}. Orders can still arrive until then. Send force: true to close it early.`);
  const totals = await batchTotals(sql, ws, b.id);
  const [r] = await sql.transaction([
    sql`update order_batches set status = 'closed', totals = ${JSON.stringify(totals)}, closed_by = ${a.name}, closed_at = now() where workspace_id = ${ws} and id = ${b.id} and status = 'open' returning id`,
    auditQ(sql, ws, a, 'batch.closed', b.id, { ticker: b.ticker, dealing_date: b.dealing_date, totals, forced: force && new Date(b.cutoff_at).getTime() > Date.now() }),
  ]);
  if (!r.length) throw new ApiError(409, 'not_open', 'Someone else closed this batch a moment ago.');
  bg(c, emit(sql, ws, 'batch.closed', { id: b.id, ticker: b.ticker, dealing_date: b.dealing_date, totals }));
  return c.json({ ...batchOut(await loadBatch(c, b.id)), totals });
});
/** Settles up to 10 allowed decisions of a closed batch per call, so one request stays inside the Worker CPU budget. Callers poll until done. */
const BATCH_CHUNK = 10;
routes.post('/batches/:id/settle', async (c) => {
  const a = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await loadBatch(c, c.req.param('id'));
  if (b.status === 'open') throw new ApiError(409, 'not_closed', 'Close the batch first. Settlement runs on a closed batch.');
  const pending = await sql`select d.id, d.action, d.investor_id, d.counterparty_id, d.ticker, d.amount::float8 as amount, d.asset, d.outcome, d.what_ifs, d.units::float8 as units, d.inputs_sha256, d.created_at, d.batch_id
    from decisions d left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id
    where d.workspace_id = ${ws} and d.batch_id = ${b.id} and d.outcome = 'ALLOW' and s.id is null order by d.created_at limit ${BATCH_CHUNK}`;
  const results: { decision_id: string; status: string; settlement_id?: string; error?: string }[] = [];
  for (const dec of pending) {
    try { const r = await executeSettlement(c, dec, { ignoreWindow: true, fromBatch: true }); results.push({ decision_id: dec.id, status: String(r.settlement.status), settlement_id: String(r.settlement.id) }); }
    catch (e: any) { results.push({ decision_id: dec.id, status: 'failed', error: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e?.message ?? e) }); }
  }
  const progress = await batchProgress(sql, ws, b.id);
  const done = Number(progress.remaining) === 0;
  const q: any[] = [sql`update order_batches set progress = ${JSON.stringify({ ...progress, last_run: results, at: new Date().toISOString() })}, status = ${done ? 'settled' : 'closed'}, settled_at = ${done ? new Date().toISOString() : null} where workspace_id = ${ws} and id = ${b.id}`];
  q.push(auditQ(sql, ws, a, 'batch.settle_run', b.id, { ticker: b.ticker, attempted: results.length, settled: results.filter((x) => x.status !== 'failed').length, failed: results.filter((x) => x.status === 'failed').length, done }));
  await sql.transaction(q);
  if (done) bg(c, emit(sql, ws, 'batch.settled', { id: b.id, ticker: b.ticker, dealing_date: b.dealing_date, progress }));
  return c.json({ id: b.id, status: done ? 'settled' : 'closed', done, chunk: results, progress, note: done ? 'Every allowed decision in the batch has a settlement.' : `${progress.remaining} allowed decision${Number(progress.remaining) === 1 ? '' : 's'} still to settle. Call again to continue.` });
});

// ===========================================================================
// 5. Global search
// ===========================================================================

routes.get('/search', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  if (q.length < 2) return c.json({ q, groups: [], note: 'Type at least two characters.' });
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const [investors, decisions, funds, settlements, work, docs] = await Promise.all([
    sql`select id, name, city, residence, (select lzid from credentials cr where cr.workspace_id = i.workspace_id and cr.investor_id = i.id and cr.status = 'active' order by created_at desc limit 1) as lzid, similarity(name, ${q}) as sim from investors i
      where workspace_id = ${ws} and (name ilike ${like} or city ilike ${like} or id ilike ${like} or exists (select 1 from credentials cx where cx.workspace_id = i.workspace_id and cx.investor_id = i.id and cx.lzid ilike ${like}))
      order by sim desc, name limit 8`,
    sql`select d.id, d.headline, d.outcome, d.action, d.ticker, d.amount::float8 as amount, d.created_at, similarity(d.headline, ${q}) as sim from decisions d
      where d.workspace_id = ${ws} and (d.id ilike ${like} or d.headline ilike ${like}) order by (d.id ilike ${like}) desc, sim desc, d.created_at desc limit 8`,
    sql`select ticker, name, short_name, currency, similarity(name, ${q}) as sim from funds where workspace_id = ${ws} and (ticker ilike ${like} or name ilike ${like}) order by (ticker ilike ${like}) desc, sim desc limit 8`,
    sql`select s.id, s.status, s.created_at, d.ticker, d.action, d.amount::float8 as amount from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id where s.workspace_id = ${ws} and (s.id ilike ${like} or s.decision_id ilike ${like}) order by s.created_at desc limit 8`,
    sql`select id, title, kind, severity, status, similarity(title, ${q}) as sim from work_items where workspace_id = ${ws} and title ilike ${like} order by (status = 'open') desc, sim desc limit 8`,
    sql`select id, title, ticker, doc_type, version, (superseded_at is null) as current, similarity(title, ${q}) as sim from fund_documents where workspace_id = ${ws} and title ilike ${like} order by (superseded_at is null) desc, sim desc limit 8`,
  ]);
  const groups = [
    { group: 'Clients', items: investors.map((r: any) => ({ id: r.id, title: r.name, subtitle: [r.city, r.residence, r.lzid].filter(Boolean).join(' · '), link: `#/clients/${r.id}` })) },
    { group: 'Decisions', items: decisions.map((r: any) => ({ id: r.id, title: `${r.id} · ${r.outcome}`, subtitle: r.headline, link: `#/decisions/${r.id}` })) },
    { group: 'Funds', items: funds.map((r: any) => ({ id: r.ticker, title: `${r.short_name} (${r.ticker})`, subtitle: r.name, link: `#/funds/${r.ticker}` })) },
    { group: 'Settlements', items: settlements.map((r: any) => ({ id: r.id, title: r.id, subtitle: `${r.action} ${r.ticker}, ${r.status}`, link: `#/settlements/${r.id}` })) },
    { group: 'Work items', items: work.map((r: any) => ({ id: r.id, title: r.title, subtitle: `${r.severity}, ${r.status}`, link: '#/work' })) },
    { group: 'Documents', items: docs.map((r: any) => ({ id: r.id, title: r.title, subtitle: `${r.ticker} v${r.version}${r.current ? '' : ', superseded'}`, link: `#/funds/${r.ticker}` })) },
  ].filter((g) => g.items.length);
  return c.json({ q, groups, total: groups.reduce((s, g) => s + g.items.length, 0) });
});

// ===========================================================================
// 6. Concentration limits
// ===========================================================================

async function concentrationStanding(sql: Sql, ws: string, ticker: string) {
  const [[f], holders] = await Promise.all([
    sql`select ticker, short_name, currency, nav::float8 as nav, holders, max_holder_pct::float8 as max_holder_pct, max_holding_per_investor::float8 as max_holding_per_investor from funds where workspace_id = ${ws} and ticker = ${ticker}`,
    sql`select h.investor_id, i.name, h.units::float8 as units from holdings h join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id where h.workspace_id = ${ws} and h.ticker = ${ticker} and h.units > 0 order by h.units desc`,
  ]);
  if (!f) throw new ApiError(404, 'not_found', `No fund ${ticker} in this organization.`);
  const unitsHere = holders.reduce((s: number, h: any) => s + Number(h.units), 0);
  const aum = aumOf({ nav: f.nav, holders: f.holders }, unitsHere, holders.length);
  const top = holders.slice(0, 5).map((h: any) => ({ investor_id: h.investor_id, name: h.name, units: Number(h.units), value: r2(Number(h.units) * f.nav), pct: aum > 0 ? r2((Number(h.units) * f.nav * 100) / aum) : 0 }));
  return { fund: f, aum, holders_here: holders.length, largest: top[0] ?? null, top };
}
routes.get('/funds/:ticker/concentration', async (c) => {
  need(c, 'read');
  const s = await concentrationStanding(c.get('sql'), c.get('ws'), c.req.param('ticker'));
  return c.json({ ticker: s.fund.ticker, currency: s.fund.currency, aum: s.aum, holders_here: s.holders_here, max_holder_pct: s.fund.max_holder_pct, max_holding_per_investor: s.fund.max_holding_per_investor, largest_holder: s.largest, top_holders: s.top,
    breached: !!(s.largest && ((s.fund.max_holder_pct && s.largest.pct > s.fund.max_holder_pct) || (s.fund.max_holding_per_investor && s.largest.value > s.fund.max_holding_per_investor))) });
});
routes.patch('/funds/:ticker/concentration', async (c) => {
  const a = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const ticker = c.req.param('ticker');
  const b = await body(c, z.object({ max_holder_pct: z.number().positive().max(100).nullable().optional(), max_holding_per_investor: z.number().positive().max(1e13).nullable().optional() }));
  if (b.max_holder_pct === undefined && b.max_holding_per_investor === undefined) throw new ApiError(422, 'no_change', 'Send max_holder_pct, max_holding_per_investor or both.');
  const before = await concentrationStanding(sql, ws, ticker);
  const next = { max_holder_pct: b.max_holder_pct === undefined ? before.fund.max_holder_pct : b.max_holder_pct, max_holding_per_investor: b.max_holding_per_investor === undefined ? before.fund.max_holding_per_investor : b.max_holding_per_investor };
  await sql.transaction([
    sql`update funds set max_holder_pct = ${next.max_holder_pct}, max_holding_per_investor = ${next.max_holding_per_investor} where workspace_id = ${ws} and ticker = ${ticker}`,
    auditQ(sql, ws, a, 'fund.concentration_updated', ticker, { before: { max_holder_pct: before.fund.max_holder_pct, max_holding_per_investor: before.fund.max_holding_per_investor }, after: next }),
  ]);
  bg(c, emit(sql, ws, 'fund.concentration_updated', { ticker, ...next }));
  const after = await concentrationStanding(sql, ws, ticker);
  return c.json({ ticker, ...next, largest_holder: after.largest, aum: after.aum, currency: after.fund.currency,
    note: 'Applied directly with an audit event. In production this belongs in the fund policy change flow (propose, second approver, new policy version), the same as holder cap and minimum subscription. Existing holders above a new limit keep their units; the limit stops them adding.' });
});
/**
 * Engine check for subscriptions and transfers: the receiving holder's position after the order must stay within the
 * fund's per-investor amount and share-of-AUM limits. Returns null when the fund has no limits.
 */
export async function concentrationCheck(sql: Sql, ws: string, fund: Fund, receiver: Investor, amount: number, units: number): Promise<Check | null> {
  const [f] = await sql`select max_holder_pct::float8 as max_holder_pct, max_holding_per_investor::float8 as max_holding_per_investor from funds where workspace_id = ${ws} and ticker = ${fund.ticker}`;
  if (!f || (!f.max_holder_pct && !f.max_holding_per_investor)) return null;
  const [t] = await sql`select coalesce(sum(units), 0)::float8 as units, count(*) filter (where units > 0)::int as n from holdings where workspace_id = ${ws} and ticker = ${fund.ticker}`;
  const aum = aumOf({ nav: fund.nav, holders: fund.holders }, Number(t.units), Number(t.n));
  const current = receiver.holdings[fund.ticker]?.units ?? 0;
  const afterUnits = current + units;
  const afterValue = r2(afterUnits * fund.nav);
  const afterAum = aum + amount;
  const pct = afterAum > 0 ? (afterValue * 100) / afterAum : 100;
  const ccy = fund.currency === 'EUR' ? '€' : '$';
  const fmt = (n: number) => ccy + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const problems: string[] = [];
  if (f.max_holding_per_investor && afterValue > f.max_holding_per_investor) problems.push(`${receiver.short} would hold ${fmt(afterValue)}, above the ${fmt(f.max_holding_per_investor)} per-investor limit`);
  if (f.max_holder_pct && pct > f.max_holder_pct) problems.push(`${receiver.short} would hold ${pct.toFixed(1)}% of the fund, above the ${f.max_holder_pct}% single-holder limit`);
  const base = { id: 'concentration', layer: 'Fund policy' as const, subject: receiver.short, label: 'Concentration limit', ruleRef: `Fund policy v${fund.policyVersion ?? 1}` };
  if (problems.length) return { ...base, result: 'fail', detail: `${problems.join('; ')}. Limits: ${[f.max_holding_per_investor ? `${fmt(f.max_holding_per_investor)} per investor` : null, f.max_holder_pct ? `${f.max_holder_pct}% of assets` : null].filter(Boolean).join(', ')}.`, remedy: `Reduce the order so ${receiver.short} stays within the limit, or ask the issuer to raise it through a policy change.` };
  return { ...base, result: 'pass', detail: `After this order ${receiver.short} holds ${fmt(afterValue)} (${pct.toFixed(1)}% of assets). Limits: ${[f.max_holding_per_investor ? `${fmt(f.max_holding_per_investor)} per investor` : null, f.max_holder_pct ? `${f.max_holder_pct}% of assets` : null].filter(Boolean).join(', ')}.` };
}

// ===========================================================================
// 7. Suitability questionnaire
// ===========================================================================

export type SuitabilityQuestion = { id: string; text: string; options: { value: number; label: string }[] };
/** Eight fixed questions. Each answer scores 0 to 3; the total of 0 to 24 maps to an outcome. */
export const SUITABILITY_QUESTIONS: SuitabilityQuestion[] = [
  { id: 'fund_knowledge', text: 'How well does the client understand how collective investment funds work (NAV, dealing, fees)?', options: [{ value: 0, label: 'Not at all' }, { value: 1, label: 'Basic idea' }, { value: 2, label: 'Good working knowledge' }, { value: 3, label: 'Professional or equivalent' }] },
  { id: 'tokenized_experience', text: 'Experience with tokenized assets or digital securities?', options: [{ value: 0, label: 'None' }, { value: 1, label: 'Has read about them' }, { value: 2, label: 'Has held them' }, { value: 3, label: 'Trades or manages them regularly' }] },
  { id: 'horizon', text: 'Investment horizon for this allocation?', options: [{ value: 0, label: 'Under 1 year' }, { value: 1, label: '1 to 3 years' }, { value: 2, label: '3 to 7 years' }, { value: 3, label: 'Over 7 years' }] },
  { id: 'loss_tolerance', text: 'Reaction to a 20% fall in value over a year?', options: [{ value: 0, label: 'Would sell everything' }, { value: 1, label: 'Would reduce' }, { value: 2, label: 'Would hold' }, { value: 3, label: 'Would add' }] },
  { id: 'liquidity', text: 'Need for access to this money?', options: [{ value: 0, label: 'May need it at any time' }, { value: 1, label: 'Within a year' }, { value: 2, label: 'Only in an emergency' }, { value: 3, label: 'Not needed' }] },
  { id: 'net_worth_share', text: 'Share of net financial assets this allocation represents?', options: [{ value: 0, label: 'Over 50%' }, { value: 1, label: '25% to 50%' }, { value: 2, label: '10% to 25%' }, { value: 3, label: 'Under 10%' }] },
  { id: 'objectives', text: 'Primary objective?', options: [{ value: 0, label: 'Capital preservation only' }, { value: 1, label: 'Income' }, { value: 2, label: 'Balanced growth and income' }, { value: 3, label: 'Growth, accepting volatility' }] },
  { id: 'settlement_asset_risk', text: 'Understanding of settlement asset risk (stablecoin issuer, redemption and on-chain settlement risk)?', options: [{ value: 0, label: 'Not understood' }, { value: 1, label: 'Explained, limited understanding' }, { value: 2, label: 'Understood' }, { value: 3, label: 'Understood and independently assessed' }] },
];
const SUITABILITY_VERSION = 1;
const SUITABILITY_MONTHS = 12;
export const scoreSuitability = (answers: Record<string, number>) => {
  const score = SUITABILITY_QUESTIONS.reduce((s, q) => s + Math.max(0, Math.min(3, Number(answers[q.id] ?? 0))), 0);
  const outcome = score >= 16 ? 'suitable' : score >= 10 ? 'advised_only' : 'not_suitable';
  return { score, outcome: outcome as 'suitable' | 'advised_only' | 'not_suitable' };
};
/** Source citations for the suitability requirement by residence. IN and JP citations are flagged for verification against primary sources. */
export const SUITABILITY_BASIS: Record<string, { ruleRef: string; text: string; source: string }> = {
  HK: { ruleRef: 'SFC Code of Conduct para 5.2', text: 'the SFC suitability requirement for solicited sales and recommendations', source: 'sfc-code' },
  CH: { ruleRef: 'FinSA Art. 11 and 12', text: 'the FinSA appropriateness and suitability assessment', source: 'finsa' },
  DE: { ruleRef: 'MiFID II Art. 25(2)', text: 'the MiFID II suitability assessment', source: 'mifid2' },
  LU: { ruleRef: 'MiFID II Art. 25(2)', text: 'the MiFID II suitability assessment', source: 'mifid2' },
  IE: { ruleRef: 'MiFID II Art. 25(2)', text: 'the MiFID II suitability assessment', source: 'mifid2' },
  GB: { ruleRef: 'FCA COBS 9A', text: 'the FCA suitability rules (COBS 9A)', source: 'fca-cobs' },
  JP: { ruleRef: 'FIEA Art. 40(i)', text: 'the FIEA principle of suitability', source: 'fiea' },
  IN: { ruleRef: 'SEBI (Investment Advisers) Regulations 2013, reg. 17', text: 'the SEBI suitability requirement', source: 'sebi-ia' },
};
routes.get('/suitability/questions', async (c) => { need(c, 'read'); return c.json({ version: SUITABILITY_VERSION, valid_months: SUITABILITY_MONTHS, scoring: { suitable: '16 to 24', advised_only: '10 to 15', not_suitable: '0 to 9' }, questions: SUITABILITY_QUESTIONS }); });
routes.post('/investors/:id/suitability', async (c) => {
  const a = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const b = await body(c, z.object({ answers: z.record(z.string(), z.number().int().min(0).max(3)), note: z.string().trim().max(500).optional() }));
  const missing = SUITABILITY_QUESTIONS.filter((q) => b.answers[q.id] === undefined).map((q) => q.id);
  if (missing.length) throw new ApiError(422, 'incomplete', `Answer every question. Missing: ${missing.join(', ')}.`);
  const [inv] = await sql`select id, name from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const { score, outcome } = scoreSuitability(b.answers);
  const sid = id('suit', 10);
  const expires = addDays(today(), Math.round(SUITABILITY_MONTHS * 30.44));
  await sql.transaction([
    sql`insert into suitability (workspace_id, id, investor_id, version, answers, score, outcome, assessed_by, expires_on) values (${ws}, ${sid}, ${invId}, ${SUITABILITY_VERSION}, ${JSON.stringify({ ...b.answers, note: b.note ?? null })}, ${score}, ${outcome}, ${a.name}, ${expires})`,
    auditQ(sql, ws, a, 'suitability.assessed', sid, { investor: invId, score, outcome, version: SUITABILITY_VERSION, expires_on: expires }),
  ]);
  return c.json({ id: sid, investor_id: invId, version: SUITABILITY_VERSION, score, outcome, assessed_by: a.name, assessed_at: new Date().toISOString(), expires_on: expires, answers: b.answers }, 201);
});
routes.get('/investors/:id/suitability', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const [[inv], rows, [j]] = await Promise.all([
    sql`select id, residence from investors where workspace_id = ${ws} and id = ${invId}`,
    sql`select id, version, answers, score, outcome, assessed_by, assessed_at, expires_on::text as expires_on from suitability where workspace_id = ${ws} and investor_id = ${invId} order by assessed_at desc limit 10`,
    sql`select j.requires_suitability from investors i join jurisdictions j on j.code = i.residence where i.workspace_id = ${ws} and i.id = ${invId}`,
  ]);
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const latest = rows[0] ?? null;
  const current = latest && latest.expires_on >= today();
  return c.json({ latest, current: !!current, history: rows, required: !!j?.requires_suitability, basis: SUITABILITY_BASIS[inv.residence] ?? null, questions: SUITABILITY_QUESTIONS, version: SUITABILITY_VERSION });
});
/** Engine check: subscriptions by residents of a jurisdiction whose rule pack requires suitability need a current suitable assessment. Returns null where not required. */
export async function suitabilityCheck(sql: Sql, ws: string, inv: Investor, fund: Fund, jurName: Record<string, string>): Promise<Check | null> {
  const [[j], [s]] = await Promise.all([
    sql`select requires_suitability from jurisdictions where code = ${inv.residence}`,
    sql`select id, outcome, score, assessed_by, assessed_at, expires_on::text as expires_on from suitability where workspace_id = ${ws} and investor_id = ${inv.id} order by assessed_at desc limit 1`,
  ]);
  if (!j?.requires_suitability) return null;
  const basis = SUITABILITY_BASIS[inv.residence] ?? { ruleRef: 'Local suitability rule', text: 'the local suitability requirement', source: '' };
  const place = jurName[inv.residence] ?? inv.residence;
  const base = { id: 'suitability', layer: 'Fund policy' as const, subject: inv.short, label: `Suitability assessment (${place})`, ruleRef: basis.ruleRef, source: basis.source };
  const t = today();
  if (!s) return { ...base, result: 'fail', detail: `${place} applies ${basis.text} (${basis.ruleRef}) to this subscription and no suitability assessment is on file for ${inv.short}.`, remedy: 'Complete the suitability questionnaire on the client page. A suitable outcome is valid for 12 months.' };
  if (s.expires_on < t) return { ...base, result: 'fail', detail: `The last assessment (${s.id}, ${s.outcome.replace('_', ' ')}, score ${s.score}) expired on ${s.expires_on}. ${place} requires a current one under ${basis.ruleRef}.`, remedy: 'Reassess the client. A suitable outcome is valid for 12 months.' };
  if (s.outcome !== 'suitable') return { ...base, result: 'fail', detail: `The current assessment (${s.id}, ${String(s.assessed_at).slice(0, 10)}) scored ${s.score} of 24: ${s.outcome === 'advised_only' ? 'advised only, so this product may be sold only with documented advice' : 'not suitable'}. ${place} requires a suitable outcome under ${basis.ruleRef}.`, remedy: s.outcome === 'advised_only' ? 'Record the advice given and reassess, or decline the subscription.' : 'Decline the subscription. Reassess only if the client\'s circumstances change.' };
  return { ...base, result: 'pass', detail: `Assessed suitable on ${String(s.assessed_at).slice(0, 10)} by ${s.assessed_by} (score ${s.score} of 24), valid to ${s.expires_on}. Satisfies ${basis.text} (${basis.ruleRef}).` };
}

// ===========================================================================
// 8. FATCA / CRS tax classification
// ===========================================================================

const FATCA = ['us_person', 'non_us_individual', 'ffi', 'nffe_active', 'nffe_passive', 'exempt'] as const;
const FORMS = ['W-9', 'W-8BEN', 'W-8BEN-E', 'W-8IMY', 'W-8EXP', 'W-8ECI'] as const;
export const FATCA_LABEL: Record<string, string> = { us_person: 'U.S. person', non_us_individual: 'Non-U.S. individual', ffi: 'Foreign financial institution', nffe_active: 'Active NFFE', nffe_passive: 'Passive NFFE', exempt: 'Exempt beneficial owner' };
const taxIn = z.object({
  tax_residences: z.array(z.string().min(2).max(10)).min(1).max(8),
  tin_provided: z.boolean().default(false),
  fatca_status: z.enum(FATCA),
  crs_status: z.string().trim().max(60).nullable().optional(),
  w8_or_w9: z.enum(FORMS).nullable().optional(),
  self_certified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
routes.post('/investors/:id/tax-profile', async (c) => {
  const a = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const b = await body(c, taxIn);
  const [inv] = await sql`select id, name, us_person from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  if (b.fatca_status === 'us_person' && b.w8_or_w9 && b.w8_or_w9 !== 'W-9') throw new ApiError(422, 'wrong_form', 'A U.S. person certifies on Form W-9, not a W-8.');
  if (b.fatca_status !== 'us_person' && b.w8_or_w9 === 'W-9') throw new ApiError(422, 'wrong_form', 'Form W-9 is for U.S. persons. A non-U.S. holder certifies on a W-8 form.');
  const certified = b.self_certified_on ?? today();
  // A W-8 is valid until the end of the third calendar year after signature (Treas. Reg. 1.1441-1(e)(4)(ii)); a W-9 does not lapse but is re-solicited on a change in circumstances.
  const expires = b.w8_or_w9 && b.w8_or_w9 !== 'W-9' ? `${Number(certified.slice(0, 4)) + 3}-12-31` : null;
  const [prev] = await sql`select fatca_status, w8_or_w9 from tax_profiles where workspace_id = ${ws} and investor_id = ${invId}`;
  await sql.transaction([
    sql`insert into tax_profiles (workspace_id, investor_id, tax_residences, tin_provided, fatca_status, crs_status, w8_or_w9, self_certified_on, expires_on, updated_by, updated_at)
      values (${ws}, ${invId}, ${b.tax_residences}, ${b.tin_provided}, ${b.fatca_status}, ${b.crs_status ?? null}, ${b.w8_or_w9 ?? null}, ${certified}, ${expires}, ${a.name}, now())
      on conflict (workspace_id, investor_id) do update set tax_residences = excluded.tax_residences, tin_provided = excluded.tin_provided, fatca_status = excluded.fatca_status, crs_status = excluded.crs_status, w8_or_w9 = excluded.w8_or_w9, self_certified_on = excluded.self_certified_on, expires_on = excluded.expires_on, updated_by = excluded.updated_by, updated_at = now()`,
    auditQ(sql, ws, a, 'tax_profile.updated', invId, { before: prev ?? null, after: { fatca_status: b.fatca_status, crs_status: b.crs_status ?? null, w8_or_w9: b.w8_or_w9 ?? null, tax_residences: b.tax_residences, tin_provided: b.tin_provided } }),
  ]);
  const warnings: string[] = [];
  if (inv.us_person && b.fatca_status !== 'us_person') warnings.push('The client record marks this investor as a U.S. person, but the FATCA status is not us_person. Reconcile one of them.');
  if (!b.tin_provided) warnings.push('No TIN recorded. CRS reporting needs a TIN or a documented reason for its absence.');
  if (!b.w8_or_w9) warnings.push('No W-8 or W-9 on file. Subscriptions to U.S.-domiciled funds fail the tax check until one is recorded.');
  return c.json({ investor_id: invId, ...b, crs_status: b.crs_status ?? null, w8_or_w9: b.w8_or_w9 ?? null, self_certified_on: certified, expires_on: expires, updated_by: a.name, warnings }, 201);
});
routes.get('/investors/:id/tax-profile', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const invId = c.req.param('id');
  const [[inv], [p]] = await Promise.all([
    sql`select id, us_person, residence from investors where workspace_id = ${ws} and id = ${invId}`,
    sql`select tax_residences, tin_provided, fatca_status, crs_status, w8_or_w9, self_certified_on::text as self_certified_on, expires_on::text as expires_on, updated_by, updated_at from tax_profiles where workspace_id = ${ws} and investor_id = ${invId}`,
  ]);
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  return c.json({ profile: p ?? null, current: !!p && (!p.expires_on || p.expires_on >= today()), us_person: inv.us_person, fatca_statuses: FATCA.map((k) => ({ id: k, label: FATCA_LABEL[k] })), forms: FORMS });
});
const US_DOMICILE = /united states|delaware|cayman.*\(us|u\.s\./i;
/** Engine check: an informational Credential-layer check showing the tax classification; fails for U.S.-domiciled funds and U.S. persons without the right form. */
export async function taxCheck(sql: Sql, ws: string, inv: Investor, fund: Fund): Promise<Check> {
  const [p] = await sql`select fatca_status, crs_status, w8_or_w9, tin_provided, self_certified_on::text as self_certified_on, expires_on::text as expires_on from tax_profiles where workspace_id = ${ws} and investor_id = ${inv.id}`;
  const usFund = US_DOMICILE.test(fund.domicile);
  const base = { id: 'tax', layer: 'Credential' as const, subject: inv.short, label: 'FATCA / CRS classification', ruleRef: usFund ? 'IRC ch. 4 (FATCA), Treas. Reg. 1.1471-3' : 'OECD CRS; FATCA IGA', source: 'fatca-crs' };
  const t = today();
  const lapsed = p?.expires_on && p.expires_on < t;
  if (!p) {
    if (usFund || inv.usPerson) return { ...base, result: 'fail', detail: `${usFund ? `${fund.short} is domiciled in ${fund.domicile}, so the fund must document every holder's chapter 4 status before admitting them` : `${inv.short} is a U.S. person`}, and no tax self-certification is on file.`, remedy: `Record a tax profile with ${inv.usPerson ? 'Form W-9' : 'the applicable W-8 form'} on the client page.` };
    return { ...base, result: 'info', detail: `No FATCA/CRS self-certification on file for ${inv.short}. Not required for ${fund.short} (${fund.domicile}), but CRS due diligence expects one for reportable accounts.` };
  }
  const form = p.w8_or_w9 as string | null;
  const label = FATCA_LABEL[p.fatca_status] ?? p.fatca_status;
  if (inv.usPerson && form !== 'W-9') return { ...base, result: 'fail', detail: `${inv.short} is a U.S. person (classified ${label}) ${form ? `with ${form} on file` : 'with no form on file'}. A U.S. person must certify on Form W-9 before the fund can pay or report correctly.`, remedy: 'Collect Form W-9 and update the tax profile.' };
  if (usFund && !form) return { ...base, result: 'fail', detail: `${fund.short} is domiciled in ${fund.domicile}. ${inv.short} is classified ${label} but has no W-8 or W-9 on file, so the withholding agent cannot document chapter 4 status.`, remedy: `Collect ${inv.kind === 'Individual' ? 'Form W-8BEN' : 'Form W-8BEN-E (or W-8IMY for an intermediary)'} and update the tax profile.` };
  if (usFund && lapsed) return { ...base, result: 'fail', detail: `${inv.short}'s ${form} expired on ${p.expires_on}. A W-8 is valid to the end of the third calendar year after signature (Treas. Reg. 1.1441-1(e)(4)(ii)).`, remedy: 'Collect a new W-8 and update the tax profile.' };
  return { ...base, result: 'info', detail: `${label}${p.crs_status ? `, CRS ${p.crs_status}` : ''}${form ? `, ${form} on file${p.expires_on ? ` to ${p.expires_on}` : ''}` : ', no W-8/W-9 on file'}${p.tin_provided ? ', TIN provided' : ', no TIN'}.${lapsed ? ' The form has lapsed; re-solicit it.' : ''}` };
}
