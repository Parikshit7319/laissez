// Approvals workflow engine. A policy per organization and kind says when an action needs a second person.
// requireApproval() evaluates the policy: when no approval is needed the action runs at once; otherwise the action's
// inputs are stored as an approval request and the caller gets { pending: true, approval_id }. When enough eligible
// approvers have approved, the executor registered for the kind runs the stored action. Executors call into the
// existing functions (issueCredential, createDecision + executeSettlement, the settings writers), so an approved
// action is audited exactly like a direct one, under the approver's name with the requester recorded on the request.
import type { Sql } from './db';
import { ApiError, id } from './util';
import { type C, type Actor, auditQ, bg } from './http';
import { notify, notifyRoles } from './notifications';

export type ApprovalKind = 'credential.issue' | 'order.large' | 'settings.change' | 'investor.update';
export const APPROVAL_KINDS: ApprovalKind[] = ['credential.issue', 'order.large', 'settings.change', 'investor.update'];

export type Policy = {
  kind: ApprovalKind;
  enabled: boolean;
  threshold: Record<string, unknown>;
  required_approvals: number;
  roles: string[];
  updated_by: string | null;
  updated_at: string | null;
  /** True when the row is the seeded default, not yet edited. */
  is_default?: boolean;
};

/** Defaults seeded per organization on first read. Thresholds are editable through PUT /v1/approval-policies. */
export const DEFAULT_POLICIES: Record<ApprovalKind, { threshold: Record<string, unknown>; required_approvals: number; roles: string[]; label: string; description: string }> = {
  'credential.issue': {
    label: 'Credential issuance',
    description: 'A credential for an individual with any classification needs one more person before it is issued. Entities issue directly.',
    threshold: { investor_kinds: ['Individual'], min_classes: 1 },
    required_approvals: 1, roles: ['admin', 'compliance'],
  },
  'order.large': {
    label: 'Large orders',
    description: 'A subscription, redemption or transfer at or above the amount for its currency needs one approval from compliance or an administrator before it is decided and settled.',
    threshold: { amount: { USD: 5_000_000, EUR: 5_000_000 } },
    required_approvals: 1, roles: ['admin', 'compliance'],
  },
  'settings.change': {
    label: 'Settings changes',
    description: 'Creating an API key with the admin scope, changing single sign-on and changing a member role need one administrator other than the requester.',
    threshold: { api_key_scopes: ['admin'], actions: ['member.role', 'sso', 'api_key.create'] },
    required_approvals: 1, roles: ['admin'],
  },
  'investor.update': {
    label: 'Client record changes',
    description: 'Changing a client field that affects eligibility (residence, U.S. person status or legal name) needs one approval from compliance or an administrator. Other fields apply directly.',
    threshold: { fields: ['residence', 'us_person', 'name'] },
    required_approvals: 1, roles: ['admin', 'compliance'],
  },
};

const rowToPolicy = (r: any): Policy => ({ kind: r.kind, enabled: r.enabled !== false, threshold: r.threshold ?? {}, required_approvals: Number(r.required_approvals ?? 1), roles: Array.isArray(r.roles) ? r.roles : [], updated_by: r.updated_by ?? null, updated_at: r.updated_at ?? null, is_default: !r.updated_by });

/** Every policy of the organization. Missing kinds are seeded with the defaults, so a new organization gets maker-checker from day one. */
export async function loadPolicies(sql: Sql, ws: string): Promise<Record<ApprovalKind, Policy>> {
  let rows = await sql`select kind, enabled, threshold, required_approvals, roles, updated_by, updated_at from approval_policies where workspace_id = ${ws}`;
  const missing = APPROVAL_KINDS.filter((k) => !rows.some((r: any) => r.kind === k));
  if (missing.length) {
    await sql.transaction(missing.map((k) => sql`insert into approval_policies (workspace_id, kind, threshold, required_approvals, roles)
      values (${ws}, ${k}, ${JSON.stringify(DEFAULT_POLICIES[k].threshold)}, ${DEFAULT_POLICIES[k].required_approvals}, ${DEFAULT_POLICIES[k].roles}) on conflict (workspace_id, kind) do nothing`));
    rows = await sql`select kind, enabled, threshold, required_approvals, roles, updated_by, updated_at from approval_policies where workspace_id = ${ws}`;
  }
  const out = {} as Record<ApprovalKind, Policy>;
  for (const r of rows) if ((APPROVAL_KINDS as string[]).includes(r.kind)) out[r.kind as ApprovalKind] = rowToPolicy(r);
  return out;
}

const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);

/**
 * Whether the policy requires approval for this payload. Returns a reason string when it does, null when it does not.
 * Each kind reads the payload fields its threshold refers to; callers pass those fields in the payload.
 */
export function policyReason(kind: ApprovalKind, p: Policy, payload: Record<string, any>): string | null {
  if (!p.enabled) return null;
  const t = p.threshold ?? {};
  if (kind === 'credential.issue') {
    const kinds = strs(t.investor_kinds).map((k) => k.toLowerCase());
    const minClasses = num(t.min_classes, 1);
    const invKind = String(payload.investor_kind ?? '').toLowerCase();
    const classes = strs(payload.classes);
    if ((kinds.length === 0 || kinds.includes(invKind)) && classes.length >= minClasses) return `Credentials for ${kinds.length ? kinds.join(' or ') + 's' : 'any client'} with ${minClasses === 1 ? 'a classification' : `${minClasses} or more classifications`} need a second person.`;
    return null;
  }
  if (kind === 'order.large') {
    const amounts = (t.amount && typeof t.amount === 'object' ? t.amount : {}) as Record<string, unknown>;
    const ccy = String(payload.currency ?? 'USD');
    const limit = num(amounts[ccy], num(amounts.USD, 5_000_000));
    const amount = num(payload.amount);
    if (limit > 0 && amount >= limit) return `Orders of ${ccy} ${limit.toLocaleString('en-US')} or more need approval before they are decided and settled.`;
    return null;
  }
  if (kind === 'settings.change') {
    const actions = strs(t.actions);
    const action = String(payload.action ?? '');
    if (!actions.includes(action)) return null;
    if (action === 'api_key.create') {
      const gated = strs(t.api_key_scopes);
      const scopes = strs(payload.scopes);
      if (!scopes.some((s) => gated.includes(s))) return null;
      return `API keys with the ${gated.join(' or ')} scope need an administrator other than the requester.`;
    }
    return 'Changes to members and single sign-on need an administrator other than the requester.';
  }
  if (kind === 'investor.update') {
    const fields = strs(t.fields);
    const changed = strs(payload.changed_fields);
    const hit = changed.filter((f) => fields.includes(f));
    if (hit.length) return `Changing ${hit.join(', ')} affects eligibility, so it needs a second person.`;
    return null;
  }
  return null;
}

export type ApprovalRow = {
  id: string; kind: ApprovalKind; subject: string | null; title: string; payload: any; requested_by: string; requested_by_user: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired'; required_approvals: number; approvals: { user_id: string | null; name: string; at: string; note: string | null }[];
  rejection: { user_id: string | null; name: string; at: string; note: string | null } | null; result: unknown; error: string | null; expires_at: string; decided_at: string | null; created_at: string;
};

export type Executor = (c: C, req: ApprovalRow) => Promise<unknown>;
const EXECUTORS: Record<string, Executor> = {};
/** Register the function that runs a stored action of this kind once approved. Called at module load by the owning route file. */
export function registerExecutor(kind: ApprovalKind, fn: Executor) { EXECUTORS[kind] = fn; }
export const hasExecutor = (kind: string) => !!EXECUTORS[kind];

export type Pending = { pending: true; approval_id: string; kind: ApprovalKind; status: 'pending'; required_approvals: number; approver_roles: string[]; reason: string; expires_at: string; message: string };
export const isPending = (x: unknown): x is Pending => !!x && typeof x === 'object' && (x as any).pending === true && typeof (x as any).approval_id === 'string';

export type RequireOpts = {
  /** Shown in the approvals queue. Defaults to the kind and subject. */
  title?: string;
  /** How long the request stays open. Defaults to 72 hours. */
  expiresAt?: string | Date | null;
  /** Link for the approver notification. */
  link?: string;
  /** Skip the policy entirely (used when an executor re-enters the gated function). */
  bypass?: boolean;
};

/**
 * Runs `execute` now when the organization's policy for `kind` does not require approval for this payload; otherwise
 * stores the request, notifies the approver roles and returns a Pending result. The payload must hold everything the
 * registered executor needs to perform the action later.
 */
export async function requireApproval<T>(c: C, kind: ApprovalKind, subject: string | null, payload: Record<string, any>, execute: () => Promise<T>, opts: RequireOpts = {}): Promise<T | Pending> {
  if (opts.bypass) return execute();
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  const policies = await loadPolicies(sql, ws);
  const p = policies[kind];
  const reason = p ? policyReason(kind, p, payload) : null;
  if (!reason) return execute();
  if (!EXECUTORS[kind]) throw new ApiError(501, 'no_executor', `Approval kind ${kind} has no executor registered on this deployment.`);
  const reqId = id('apr', 12);
  const expires = opts.expiresAt ? new Date(opts.expiresAt).toISOString() : new Date(Date.now() + 72 * 3_600_000).toISOString();
  const title = opts.title ?? `${DEFAULT_POLICIES[kind].label}${subject ? `: ${subject}` : ''}`;
  await sql.transaction([
    sql`insert into approval_requests (workspace_id, id, kind, subject, title, payload, requested_by, requested_by_user, status, required_approvals, expires_at)
      values (${ws}, ${reqId}, ${kind}, ${subject}, ${title}, ${JSON.stringify(payload)}, ${a.name}, ${a.userId ?? null}, 'pending', ${p.required_approvals}, ${expires})`,
    auditQ(sql, ws, a, 'approval.requested', reqId, { kind, subject, title, reason, required_approvals: p.required_approvals, roles: p.roles }),
  ]);
  bg(c, notifyRoles(sql, ws, p.roles, {
    kind: 'approval.requested', title: `${title} needs your approval`, link: opts.link ?? `#/approvals/${reqId}`,
    body: `${a.name} requested it. ${reason} Nothing happens until ${p.required_approvals === 1 ? 'someone else approves' : `${p.required_approvals} people approve`} it.`,
  }, a.userId ?? null));
  return {
    pending: true, approval_id: reqId, kind, status: 'pending', required_approvals: p.required_approvals, approver_roles: p.roles, reason, expires_at: expires,
    message: `Waiting for approval. ${reason} Track it at GET /v1/approvals/${reqId}.`,
  };
}

const rowOut = (r: any): ApprovalRow => ({
  id: r.id, kind: r.kind, subject: r.subject, title: r.title, payload: r.payload ?? {}, requested_by: r.requested_by, requested_by_user: r.requested_by_user ?? null,
  status: r.status, required_approvals: Number(r.required_approvals), approvals: Array.isArray(r.approvals) ? r.approvals : [], rejection: r.rejection ?? null,
  result: r.result ?? null, error: r.error ?? null, expires_at: r.expires_at, decided_at: r.decided_at ?? null, created_at: r.created_at,
});

/** Marks overdue pending requests expired. Cheap, so list and detail routes call it first. */
export async function expireOverdue(sql: Sql, ws: string) {
  await sql`update approval_requests set status = 'expired', decided_at = now() where workspace_id = ${ws} and status = 'pending' and expires_at < now()`;
}

export async function loadRequest(c: C, reqId: string): Promise<ApprovalRow> {
  const sql = c.get('sql'); const ws = c.get('ws');
  await expireOverdue(sql, ws);
  const [r] = await sql`select * from approval_requests where workspace_id = ${ws} and id = ${reqId}`;
  if (!r) throw new ApiError(404, 'not_found', `No approval request ${reqId} in this organization.`);
  return rowOut(r);
}

/** Secrets an executor produced (an API key) are shown to the requester once; everyone else sees the result without them. */
export function presentRequest(r: ApprovalRow, viewer: Actor): ApprovalRow {
  const res: any = r.result;
  if (!res || typeof res !== 'object' || !res.secret) return r;
  const mine = !!viewer.userId && viewer.userId === r.requested_by_user;
  const { secret, ...rest } = res;
  return { ...r, result: mine ? res : { ...rest, secret_note: 'Shown once to the person who requested it.' } };
}

function checkApprover(a: Actor, r: ApprovalRow, p: Policy, sandbox: boolean) {
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in person can approve or reject. API keys can request, not approve.');
  const same = r.requested_by_user ? r.requested_by_user === a.userId : r.requested_by.trim().toLowerCase() === a.name.trim().toLowerCase();
  if (same) throw new ApiError(403, 'same_person', `You requested this. A second person must decide it.${sandbox ? ' Switch to a teammate to try it.' : ''}`);
  if (a.role !== 'admin' && !p.roles.includes(a.role ?? '')) throw new ApiError(403, 'forbidden', `Approving ${DEFAULT_POLICIES[r.kind].label.toLowerCase()} needs one of these roles: ${p.roles.join(', ')}.`);
  if (r.approvals.some((x) => x.user_id && x.user_id === a.userId)) throw new ApiError(409, 'already_approved', 'You already approved this request. Another approver has to add theirs.');
}

/**
 * Records an approval. When the request reaches its required count the registered executor runs the stored action.
 * A lock column keeps two approvers from executing it twice; a failed execution leaves the request pending with the
 * error recorded, so an approver can retry once the cause is fixed.
 */
export async function approveRequest(c: C, reqId: string, note: string | null): Promise<ApprovalRow & { executed: boolean }> {
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  const r = await loadRequest(c, reqId);
  if (r.status !== 'pending') throw new ApiError(409, 'not_pending', `This request is already ${r.status}.`);
  const policies = await loadPolicies(sql, ws);
  const p = policies[r.kind];
  checkApprover(a, r, p, c.get('wsKind') === 'sandbox');
  const entry = { user_id: a.userId ?? null, name: a.name, at: new Date().toISOString(), note };
  const [locked] = await sql.transaction([
    sql`update approval_requests set approvals = approvals || ${JSON.stringify([entry])}::jsonb, locked_at = now()
      where workspace_id = ${ws} and id = ${reqId} and status = 'pending' and (locked_at is null or locked_at < now() - interval '2 minutes') returning approvals`,
    auditQ(sql, ws, a, 'approval.approved', reqId, { kind: r.kind, subject: r.subject, note, approvals_before: r.approvals.length, required: r.required_approvals }),
  ]);
  if (!locked.length) throw new ApiError(409, 'in_progress', 'Someone else is deciding this request right now. Reload in a moment.');
  const approvals = locked[0].approvals as ApprovalRow['approvals'];
  if (approvals.length < r.required_approvals) {
    await sql`update approval_requests set locked_at = null where workspace_id = ${ws} and id = ${reqId}`;
    return { ...(await loadRequest(c, reqId)), executed: false };
  }
  const exec = EXECUTORS[r.kind];
  if (!exec) {
    await sql`update approval_requests set locked_at = null, error = 'No executor registered for this kind.' where workspace_id = ${ws} and id = ${reqId}`;
    throw new ApiError(501, 'no_executor', `Approval kind ${r.kind} has no executor registered on this deployment.`);
  }
  let result: unknown;
  try {
    result = await exec(c, { ...r, approvals });
  } catch (e: any) {
    const msg = e instanceof ApiError ? `${e.message}${e.detail ? ` ${JSON.stringify(e.detail).slice(0, 300)}` : ''}` : String(e?.message ?? e);
    await sql.transaction([
      sql`update approval_requests set locked_at = null, error = ${msg.slice(0, 1000)} where workspace_id = ${ws} and id = ${reqId}`,
      auditQ(sql, ws, a, 'approval.execution_failed', reqId, { kind: r.kind, subject: r.subject, error: msg.slice(0, 500) }),
    ]);
    if (e instanceof ApiError) throw new ApiError(e.status, e.code, `Approved, but the action did not complete: ${e.message} The request stays open; fix the cause and approve again.`, e.detail);
    throw e;
  }
  await sql.transaction([
    sql`update approval_requests set status = 'approved', decided_at = now(), locked_at = null, error = null, result = ${JSON.stringify(result ?? null)} where workspace_id = ${ws} and id = ${reqId}`,
    auditQ(sql, ws, a, 'approval.executed', reqId, { kind: r.kind, subject: r.subject, requested_by: r.requested_by, approved_by: approvals.map((x) => x.name) }),
  ]);
  if (r.requested_by_user) {
    bg(c, notify(sql, ws, { kind: 'approval.approved', user_id: r.requested_by_user, title: `${r.title} was approved`, body: `${a.name} approved it${note ? `: ${note}` : '.'} The action has run.`, link: `#/approvals/${reqId}` }));
  }
  return { ...(await loadRequest(c, reqId)), executed: true };
}

export async function rejectRequest(c: C, reqId: string, note: string | null): Promise<ApprovalRow> {
  const sql = c.get('sql'); const ws = c.get('ws'); const a: Actor = c.get('actor');
  const r = await loadRequest(c, reqId);
  if (r.status !== 'pending') throw new ApiError(409, 'not_pending', `This request is already ${r.status}.`);
  const policies = await loadPolicies(sql, ws);
  checkApprover(a, r, policies[r.kind], c.get('wsKind') === 'sandbox');
  const entry = { user_id: a.userId ?? null, name: a.name, at: new Date().toISOString(), note };
  const [rows] = await sql.transaction([
    sql`update approval_requests set status = 'rejected', rejection = ${JSON.stringify(entry)}, decided_at = now(), locked_at = null where workspace_id = ${ws} and id = ${reqId} and status = 'pending' returning id`,
    auditQ(sql, ws, a, 'approval.rejected', reqId, { kind: r.kind, subject: r.subject, note }),
  ]);
  if (!rows.length) throw new ApiError(409, 'not_pending', 'Someone else decided this request a moment ago. Reload to see its status.');
  if (r.requested_by_user) {
    bg(c, notify(sql, ws, { kind: 'approval.rejected', user_id: r.requested_by_user, title: `${r.title} was rejected`, body: `${a.name} rejected it${note ? `: ${note}` : '.'} Nothing changed.`, link: `#/approvals/${reqId}` }));
  }
  return loadRequest(c, reqId);
}

export { rowOut as approvalOut };
