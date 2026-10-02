// Account and organization lifecycle: the email outbox, session revocation, recovery codes, SSO group mapping,
// SCIM token, sandbox conversion and export, organization export and deletion, and rate limit headers.
import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { adminSql, type Sql } from '../db';
import { ApiError, rand, sha256, rateLimit, canonical, type Env, type RateStatus } from '../util';
import { type Vars, type C, type Role, router, body, need, audit, auditQ, ROLE_LABEL } from '../http';
import { createSession } from '../auth';

export const routes = router();
export const publicRoutes = router();

const ROLES = ['admin', 'ops', 'compliance', 'legal', 'issuer', 'developer', 'auditor'] as const;
const roleZ = z.enum(ROLES);
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'org';
const human = (c: C) => {
  const a = c.get('actor');
  if (a.kind !== 'user' || !a.realUserId) throw new ApiError(403, 'human_required', 'Only a signed-in person can do this. API keys cannot.');
  if (a.userId !== a.realUserId) throw new ApiError(403, 'acting_as', 'Switch back to yourself first. This action is recorded against your own account.');
  return a;
};
const realEmail = (e: string | null | undefined) => !!e && e.includes('@') && !e.endsWith('.sandbox') && !e.endsWith('.example');

// ---------- Rate limit headers on every authenticated response ----------
type Mw = MiddlewareHandler<{ Bindings: Env; Variables: Vars }>;
export const rateLimitHeaders: Mw = async (c, next) => {
  await next();
  const r = (c.get as any)('rate') as (RateStatus & { quota?: { used: number; quota: number } }) | undefined;
  if (!r) return;
  const apply = (h: Headers) => {
    h.set('X-RateLimit-Limit', String(r.limit));
    h.set('X-RateLimit-Remaining', String(r.remaining));
    h.set('X-RateLimit-Reset', String(r.resetAt));
    if (r.quota) { h.set('X-Quota-Limit', String(r.quota.quota)); h.set('X-Quota-Remaining', String(Math.max(0, r.quota.quota - r.quota.used))); }
  };
  try { apply(c.res.headers); } catch { c.res = new Response(c.res.body, c.res); apply(c.res.headers); }
};

// ---------- Outbox ----------
routes.get('/outbox', async (c) => {
  need(c, 'read');
  const kind = c.req.query('kind') || null;
  const rows = await c.get('sql')`select id, to_email, subject, kind, status, provider_id, error, link, created_at, left(text, 240) as preview from email_outbox
    where workspace_id = ${c.get('ws')} and (${kind}::text is null or kind = ${kind}) order by created_at desc limit 100`;
  return c.json({ data: rows, provider: c.env.RESEND_API_KEY && c.env.EMAIL_FROM ? 'resend' : null, note: c.env.RESEND_API_KEY ? 'Messages are sent through Resend and kept here for reference.' : 'No mail provider is connected, so every message stays here. Open one to use its link.' });
});
routes.get('/outbox/:id', async (c) => {
  need(c, 'read');
  const [m] = await c.get('sql')`select id, to_email, subject, kind, status, provider_id, error, link, created_at, html, text from email_outbox where workspace_id = ${c.get('ws')} and id::text = ${c.req.param('id')}`;
  if (!m) throw new ApiError(404, 'not_found', 'No message with that id in this organization.');
  return c.json(m);
});

// ---------- Sessions ----------
routes.post('/sessions/revoke-all', async (c) => {
  const a = human(c);
  const admin = c.get('admin');
  const r = await admin`update sessions set revoked_at = now() where user_id = ${a.realUserId} and revoked_at is null and expires_at > now() and id <> ${a.sessionId ?? null} returning id`;
  await audit(admin, c.get('ws'), a, 'session.revoked_all', a.realUserId!, { sessions: r.length });
  return c.json({ revoked: r.length, kept: a.sessionId, note: 'Every other session is signed out. This one stays.' });
});

// ---------- Recovery codes ----------
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => `${rand(4, CODE_ALPHA)}-${rand(4, CODE_ALPHA)}-${rand(4, CODE_ALPHA)}`;
const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');

routes.get('/auth/recovery-codes', async (c) => {
  const a = human(c);
  const [r] = await c.get('admin')`select count(*) filter (where used_at is null)::int as unused, count(*)::int as total, max(created_at) as generated_at from recovery_codes where user_id = ${a.realUserId}`;
  return c.json({ unused: r.unused, total: r.total, generated_at: r.generated_at });
});
routes.post('/auth/recovery-codes/generate', async (c) => {
  const a = human(c);
  const admin = c.get('admin');
  const [u] = await admin`select email from users where id = ${a.realUserId}`;
  if (!realEmail(u?.email)) throw new ApiError(403, 'account_required', 'Recovery codes belong to real accounts. Set your email first.');
  const codes = Array.from({ length: 10 }, newCode);
  const hashes = await Promise.all(codes.map((x) => sha256(`recovery:${x}`)));
  await admin.transaction([
    admin`delete from recovery_codes where user_id = ${a.realUserId}`,
    ...hashes.map((h) => admin`insert into recovery_codes (user_id, code_hash) values (${a.realUserId}, ${h})`),
    auditQ(admin, c.get('ws'), a, 'recovery_codes.generated', a.realUserId!, { count: codes.length }),
  ]);
  return c.json({ codes, note: 'Store these somewhere safe. Each works once, and they are shown only now. Any codes you had before no longer work.' }, 201);
});

publicRoutes.post('/auth/recovery', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const ip = await sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
  if (!(await rateLimit(admin, `recovery:${ip}`, 10, 900))) throw new ApiError(429, 'rate_limited', 'Too many recovery attempts from this network. Wait fifteen minutes.');
  const b = await body(c, z.object({ email: z.string().trim().toLowerCase().email(), code: z.string().trim().min(12).max(20) }));
  const [u] = await admin`select id, name from users where email = ${b.email} and sandbox_workspace is null`;
  const bad = new ApiError(401, 'recovery_invalid', 'That email and recovery code do not match, or the code was already used.');
  if (!u) throw bad;
  const r = await admin`update recovery_codes set used_at = now() where user_id = ${u.id} and code_hash = ${await sha256(`recovery:${normCode(b.code)}`)} and used_at is null returning id`;
  if (!r.length) throw bad;
  const orgs = await admin`select m.workspace_id, w.name, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${u.id} and (w.expires_at is null or w.expires_at > now()) order by m.created_at`;
  if (!orgs.length) throw new ApiError(403, 'no_organization', 'Your account is not a member of any organization.');
  const token = await createSession(c as C, admin, u.id, orgs[0].workspace_id, 'recovery', 1);
  const [{ left }] = await admin`select count(*)::int as left from recovery_codes where user_id = ${u.id} and used_at is null`;
  await audit(admin, orgs[0].workspace_id, { kind: 'user', id: u.id, name: u.name }, 'session.recovery', u.id, { codes_left: left });
  return c.json({ session_token: token, workspace_id: orgs[0].workspace_id, codes_left: left, restricted: true, note: 'This session lasts one hour and can only add a passkey. Add one on the Security page, then sign in with it.' });
});

// ---------- SSO group to role mapping ----------
const groupsZ = z.object({ group_claim: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_.:/-]+$/).default('groups'), group_roles: z.array(z.object({ group: z.string().trim().min(1).max(120), role: roleZ })).max(50) });
routes.get('/sso/groups', async (c) => {
  need(c, 'read');
  const [w] = await c.get('admin')`select sso from workspaces where id = ${c.get('ws')}`;
  return c.json({ configured: !!w.sso, group_claim: w.sso?.group_claim ?? 'groups', group_roles: Array.isArray(w.sso?.group_roles) ? w.sso.group_roles : [], roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r] })) });
});
routes.put('/sso/groups', async (c) => {
  need(c, 'members:admin');
  const b = await body(c, groupsZ);
  const admin = c.get('admin'); const ws = c.get('ws');
  const [w] = await admin`select sso from workspaces where id = ${ws}`;
  if (!w.sso) throw new ApiError(409, 'sso_required', 'Connect an identity provider first. Group mapping applies to people who sign in through it.');
  const seen = new Set<string>();
  for (const g of b.group_roles) { const k = g.group.toLowerCase(); if (seen.has(k)) throw new ApiError(422, 'duplicate_group', `${g.group} is listed twice. Each group maps to one role.`); seen.add(k); }
  await admin`update workspaces set sso = ${JSON.stringify({ ...w.sso, group_claim: b.group_claim, group_roles: b.group_roles })} where id = ${ws}`;
  await audit(c.get('sql'), ws, c.get('actor'), 'sso.groups_configured', ws, { group_claim: b.group_claim, group_roles: b.group_roles });
  return c.json({ saved: true, group_claim: b.group_claim, group_roles: b.group_roles });
});

// ---------- SCIM token ----------
routes.get('/scim', async (c) => {
  need(c, 'read');
  const admin = c.get('admin'); const ws = c.get('ws');
  const [w] = await admin`select scim_token_hash, scim_token_created_at, (select count(*)::int from memberships m where m.workspace_id = ${ws} and m.provisioned_by = 'scim') as provisioned from workspaces where id = ${ws}`;
  return c.json({ configured: !!w.scim_token_hash, token_created_at: w.scim_token_created_at, provisioned_members: w.provisioned, base_url: `${c.env.API_URL}/scim/v2`, note: 'Point your identity provider at the base URL with the bearer token. Users it creates join with the SSO default role or a mapped group role; deactivating one removes the membership and signs out their sessions.' });
});
routes.post('/scim/token', async (c) => {
  const a = human(c); need(c, 'members:admin');
  if (c.get('wsKind') === 'sandbox') throw new ApiError(403, 'sandbox_only', 'SCIM provisioning is for organizations. Keep this sandbox as an organization first.');
  const token = `lz_scim_${rand(40)}`;
  await c.get('admin')`update workspaces set scim_token_hash = ${await sha256(token)}, scim_token_created_at = now() where id = ${c.get('ws')}`;
  await audit(c.get('sql'), c.get('ws'), a, 'scim.token_created', c.get('ws'));
  return c.json({ token, base_url: `${c.env.API_URL}/scim/v2`, note: 'Store the token now. It is shown once. Generating a new token replaces this one.' }, 201);
});
routes.delete('/scim/token', async (c) => {
  const a = human(c); need(c, 'members:admin');
  await c.get('admin')`update workspaces set scim_token_hash = null, scim_token_created_at = null where id = ${c.get('ws')}`;
  await audit(c.get('sql'), c.get('ws'), a, 'scim.token_revoked', c.get('ws'));
  return c.json({ revoked: true });
});

// ---------- Export bundles ----------
async function dataBundle(sql: Sql, ws: string) {
  const [investors, credentials, classifications, funds, distribution, holdings, decisions, settlements, policyChanges, auditEvents] = await sql.transaction([
    sql`select * from investors where workspace_id = ${ws} order by created_at`,
    sql`select * from credentials where workspace_id = ${ws} order by id`,
    sql`select * from classifications where workspace_id = ${ws} order by id`,
    sql`select * from funds where workspace_id = ${ws} order by ticker`,
    sql`select * from fund_distribution where workspace_id = ${ws} order by ticker, jurisdiction`,
    sql`select * from holdings where workspace_id = ${ws} order by investor_id, ticker`,
    sql`select * from decisions where workspace_id = ${ws} order by created_at`,
    sql`select * from settlements where workspace_id = ${ws} order by created_at`,
    sql`select * from policy_changes where workspace_id = ${ws} order by created_at`,
    sql`select seq, type, subject, data, actor, actor_name, created_at, prev_hash, hash from audit_events where workspace_id = ${ws} order by seq limit 20000`,
  ]);
  return { investors, credentials, classifications, funds, distribution, holdings, decisions, settlements, policy_changes: policyChanges, audit_events: auditEvents };
}
async function orgBundle(sql: Sql, admin: Sql, ws: string) {
  const base = await dataBundle(sql, ws);
  const [members, keys, webhooks, workItems] = await Promise.all([
    admin`select u.id, u.name, u.email, u.title, u.fictional, m.role, m.created_at, m.scim_external_id, m.provisioned_by from memberships m join users u on u.id = m.user_id where m.workspace_id = ${ws} order by m.created_at`,
    sql`select id, name, prefix, scopes, ip_allowlist, expires_at, created_at, last_used_at, last_used_country, rotated_from from api_keys where workspace_id = ${ws} order by created_at`,
    sql`select id, url, events, created_at from webhooks where workspace_id = ${ws} order by created_at`,
    sql`select * from work_items where workspace_id = ${ws} order by created_at`,
  ]);
  return { ...base, members, api_keys: keys, webhooks, work_items: workItems };
}
const counts = (b: Record<string, unknown>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Array.isArray(v) ? v.length : null]));

routes.get('/sandbox/export', async (c) => {
  need(c, 'read');
  if (c.get('wsKind') !== 'sandbox') throw new ApiError(403, 'sandbox_only', 'Use GET /v1/organization/export for an organization.');
  const ws = c.get('ws');
  const [w] = await c.get('admin')`select id, name, kind, slug, created_at, expires_at from workspaces where id = ${ws}`;
  const data = await dataBundle(c.get('sql'), ws);
  const bundle = { format: 'laissez.sandbox.v1', exported_at: new Date().toISOString(), workspace: w, counts: counts(data), ...data };
  c.header('content-disposition', `attachment; filename="laissez-sandbox-${w.slug}.json"`);
  return c.json(bundle);
});

routes.get('/organization/export', async (c) => {
  need(c, 'members:admin');
  const ws = c.get('ws'); const admin = c.get('admin');
  const [w] = await admin`select id, name, kind, slug, brand_name, brand_color, created_at, expires_at, monthly_quota, (sso - 'client_secret') as sso from workspaces where id = ${ws}`;
  const data = await orgBundle(c.get('sql'), admin, ws);
  const bundle = { format: 'laissez.organization.v1', exported_at: new Date().toISOString(), workspace: w, counts: counts(data), ...data };
  await audit(c.get('sql'), ws, c.get('actor'), 'organization.exported', ws, { counts: bundle.counts });
  c.header('content-disposition', `attachment; filename="laissez-${w.slug}.json"`);
  return c.json(bundle);
});

// ---------- Sandbox to organization ----------
routes.get('/sandbox/convert', async (c) => {
  const a = human(c);
  if (c.get('wsKind') !== 'sandbox') throw new ApiError(403, 'sandbox_only', 'This is already an organization.');
  const admin = c.get('admin');
  const [u] = await admin`select email, name, (select count(*)::int from passkeys p where p.user_id = users.id) as passkeys from users where id = ${a.realUserId}`;
  const emailOk = realEmail(u.email); const nameOk = !!u.name && u.name !== 'You (guest)';
  return c.json({ steps: { profile: emailOk && nameOk, passkey: u.passkeys > 0 }, email: emailOk ? u.email : null, name: nameOk ? u.name : null, passkeys: u.passkeys, ready: emailOk && nameOk && u.passkeys > 0 });
});
routes.post('/sandbox/convert', async (c) => {
  const a = human(c); need(c, 'members:admin');
  if (c.get('wsKind') !== 'sandbox') throw new ApiError(403, 'sandbox_only', 'This is already an organization.');
  const admin = c.get('admin'); const ws = c.get('ws');
  const { org_name } = await body(c, z.object({ org_name: z.string().trim().min(2).max(80) }));
  const [u] = await admin`select email, name, (select count(*)::int from passkeys p where p.user_id = users.id) as passkeys from users where id = ${a.realUserId}`;
  if (!realEmail(u.email) || !u.name || u.name === 'You (guest)') throw new ApiError(422, 'profile_required', 'Set your real name and email first (PATCH /v1/me), so the organization has an owner who can sign back in.');
  if (!u.passkeys) throw new ApiError(422, 'passkey_required', 'Add a passkey first. Without one there is no way back into the organization after this browser session ends.');
  const taken = await admin`select 1 from users where email = ${u.email} and sandbox_workspace is null and id <> ${a.realUserId}`;
  if (taken.length) throw new ApiError(409, 'email_taken', 'An account with your email already exists. Sign in with it and create an organization there instead.');
  const slug = `${slugify(org_name)}-${rand(4)}`;
  const [w] = await admin`select sso from workspaces where id = ${ws}`;
  const sso = w.sso ? { ...w.sso, enabled: false, demo: false, converted_from_demo: true } : null;
  const fictional = await admin`select id from users where sandbox_workspace = ${ws} and fictional`;
  await admin.transaction([
    admin`update workspaces set kind = 'org', expires_at = null, slug = ${slug}, name = ${org_name}, brand_name = ${org_name}, created_by = ${a.realUserId}, sso = ${sso ? JSON.stringify(sso) : null} where id = ${ws}`,
    admin`update users set sandbox_workspace = null where id = ${a.realUserId}`,
    admin`delete from memberships where workspace_id = ${ws} and user_id = any(${fictional.map((f: any) => f.id)}::uuid[])`,
    admin`delete from users where sandbox_workspace = ${ws} and fictional`,
    admin`update sessions set acting_as = null where workspace_id = ${ws}`,
    admin`update api_keys set name = 'First key' where workspace_id = ${ws} and name = 'Sandbox key'`,
    auditQ(admin, ws, a, 'organization.converted', ws, { from: 'sandbox', name: org_name, slug, fictional_members_removed: fictional.length }),
  ]);
  const [out] = await admin`select id, name, kind, slug, created_at, expires_at from workspaces where id = ${ws}`;
  return c.json({ workspace: out, removed_teammates: fictional.length, note: 'This is now your organization. It no longer expires, the fictional teammates are gone, and the demo identity provider is disconnected. Fictional clients and funds stay until you delete them.' });
});

// ---------- Delete the organization ----------
routes.delete('/organization', async (c) => {
  const a = human(c); need(c, 'members:admin');
  const admin = c.get('admin'); const ws = c.get('ws');
  const { confirm_name } = await body(c, z.object({ confirm_name: z.string().trim().min(1).max(120) }));
  const [w] = await admin`select id, name, kind, slug from workspaces where id = ${ws}`;
  if (w.kind === 'network') throw new ApiError(403, 'forbidden', 'The shared network organization cannot be deleted.');
  if (confirm_name !== w.name) throw new ApiError(422, 'name_mismatch', `Type the organization name exactly as it appears: ${w.name}.`);
  const data = await orgBundle(c.get('sql'), admin, ws);
  const bundle = { format: 'laissez.organization.v1', exported_at: new Date().toISOString(), workspace: w, counts: counts(data), ...data };
  const exportSha = await sha256(canonical(bundle));
  const [del] = await admin`insert into org_deletions (workspace_id, name, kind, deleted_by, deleted_by_name, export_sha256, counts) values (${ws}, ${w.name}, ${w.kind}, ${a.realUserId}, ${a.name}, ${exportSha}, ${JSON.stringify(bundle.counts)}) returning id, deleted_at`;
  await admin`delete from workspaces where id = ${ws}`;
  const remaining = await admin`select m.workspace_id, wk.name, wk.kind, m.role from memberships m join workspaces wk on wk.id = m.workspace_id where m.user_id = ${a.realUserId} and (wk.expires_at is null or wk.expires_at > now()) order by wk.name`;
  return c.json({ deleted: ws, name: w.name, deletion_id: del.id, deleted_at: del.deleted_at, export_sha256: exportSha, counts: bundle.counts, remaining_organizations: remaining, note: remaining.length ? 'Everything in the organization is gone. Your account remains; switch to another organization.' : 'Everything in the organization is gone. Your account remains, but belongs to no organization now.' });
});
