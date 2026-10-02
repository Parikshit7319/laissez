// SCIM 2.0 user provisioning (RFC 7643, 7644), one bearer token per organization. Mounted at /scim/v2.
// Users are the organization's members: creating one adds a membership (and an account without a passkey, which
// signs in through SSO), deactivating or deleting one removes the membership and revokes that person's sessions.
import { Hono } from 'hono';
import { adminSql, type Sql } from './db';
import { ApiError, sha256, rateLimit, type Env } from './util';
import { audit, type Actor, type Role } from './http';

type ScimVars = { admin: Sql; ws: string; wsName: string; defaultRole: Role; groupRoles: { group: string; role: Role }[] };
export const scim = new Hono<{ Bindings: Env; Variables: ScimVars }>();

const ROLES = new Set(['admin', 'ops', 'compliance', 'issuer', 'developer', 'auditor']);
const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCIM_JSON = 'application/scim+json; charset=utf-8';

class ScimError extends Error { constructor(public status: number, public scimType: string | null, message: string) { super(message); } }
const scimActor = (ws: string): Actor => ({ kind: 'system', id: 'scim', name: 'SCIM provisioning' });

scim.onError((err, c) => {
  const status = err instanceof ScimError ? err.status : err instanceof ApiError ? err.status : 500;
  const detail = err instanceof ScimError || err instanceof ApiError ? err.message : 'Something went wrong on our side.';
  if (status === 500) console.error(err);
  return c.body(JSON.stringify({ schemas: [SCHEMA_ERROR], status: String(status), ...(err instanceof ScimError && err.scimType ? { scimType: err.scimType } : {}), detail }), status as any, { 'content-type': SCIM_JSON });
});
scim.notFound((c) => c.body(JSON.stringify({ schemas: [SCHEMA_ERROR], status: '404', detail: `No SCIM resource at ${new URL(c.req.url).pathname}.` }), 404, { 'content-type': SCIM_JSON }));

// ---------- Authentication: one bearer token per organization ----------
scim.use('*', async (c, next) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const h = c.req.header('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok.startsWith('lz_scim_')) throw new ScimError(401, null, 'Send the organization SCIM token as "Authorization: Bearer lz_scim_...".');
  const [w] = await admin`select id, name, kind, sso from workspaces where scim_token_hash = ${await sha256(tok)} and kind = 'org' and (expires_at is null or expires_at > now())`;
  if (!w) throw new ScimError(401, null, 'This SCIM token is not valid. Generate a new one in Laissez under Organization, Provisioning.');
  if (!(await rateLimit(admin, `scim:${w.id}`, 300, 60))) throw new ScimError(429, null, 'More than 300 requests in a minute. Slow down.');
  c.set('admin', admin); c.set('ws', w.id); c.set('wsName', w.name);
  c.set('defaultRole', (w.sso?.default_role && ROLES.has(w.sso.default_role) ? w.sso.default_role : 'auditor') as Role);
  c.set('groupRoles', Array.isArray(w.sso?.group_roles) ? w.sso.group_roles : []);
  await next();
});

// ---------- Resource shape ----------
type Row = { id: string; email: string; name: string; title: string | null; role: Role; created_at: string; scim_external_id: string | null; last_login_at: string | null };
function toScim(c: any, r: Row) {
  const [given, ...rest] = (r.name ?? '').split(' ');
  const base = `${new URL(c.req.url).origin}/scim/v2/Users/${r.id}`;
  return {
    schemas: [SCHEMA_USER], id: r.id, externalId: r.scim_external_id ?? undefined, userName: r.email, displayName: r.name,
    name: { givenName: given, familyName: rest.join(' ') || undefined, formatted: r.name }, title: r.title ?? undefined,
    emails: [{ value: r.email, primary: true, type: 'work' }], active: true, roles: [{ value: r.role, primary: true }],
    meta: { resourceType: 'User', created: r.created_at, lastModified: r.created_at, location: base },
  };
}
const memberQ = (admin: Sql, ws: string) => admin`select u.id, u.email, u.name, u.title, u.last_login_at, m.role, m.created_at, m.scim_external_id
  from memberships m join users u on u.id = m.user_id where m.workspace_id = ${ws} and not u.fictional order by m.created_at`;

function pickRole(c: any, body: any): Role {
  const r = Array.isArray(body?.roles) ? body.roles.find((x: any) => ROLES.has(String(x?.value ?? x)))?.value ?? body.roles.find((x: any) => ROLES.has(String(x))) : null;
  if (r && ROLES.has(String(r))) return String(r) as Role;
  const groups: string[] = Array.isArray(body?.groups) ? body.groups.map((g: any) => String(g?.display ?? g?.value ?? g)) : [];
  const mapped = (c.get('groupRoles') as { group: string; role: Role }[]).find((m) => groups.some((g) => g.toLowerCase() === m.group.toLowerCase()));
  return mapped?.role ?? c.get('defaultRole');
}
function nameOf(body: any, fallback: string) {
  const n = body?.name;
  const formatted = n?.formatted || [n?.givenName, n?.familyName].filter(Boolean).join(' ');
  return (body?.displayName || formatted || fallback).toString().trim().slice(0, 80);
}
const emailOf = (body: any): string | null => {
  const e = (Array.isArray(body?.emails) ? body.emails.find((x: any) => x?.primary)?.value ?? body.emails[0]?.value : null) ?? body?.userName;
  const s = String(e ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
};

async function deprovision(admin: Sql, ws: string, userId: string, via: string) {
  const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${ws} and role = 'admin' and user_id <> ${userId}`;
  const [m] = await admin`select role from memberships where workspace_id = ${ws} and user_id = ${userId}`;
  if (m?.role === 'admin' && n === 0) throw new ScimError(409, 'mutability', 'This person is the last administrator. Make someone else an administrator before deactivating them.');
  await admin`delete from memberships where workspace_id = ${ws} and user_id = ${userId}`;
  await admin`update sessions set revoked_at = now() where workspace_id = ${ws} and user_id = ${userId} and revoked_at is null`;
  await audit(admin, ws, scimActor(ws), 'member.removed', userId, { via });
}

// ---------- Discovery ----------
scim.get('/ServiceProviderConfig', (c) => c.body(JSON.stringify({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://parikshit7319.github.io/laissez/developers/',
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The organization SCIM token from Laissez settings.', primary: true }],
  meta: { resourceType: 'ServiceProviderConfig', location: `${new URL(c.req.url).origin}/scim/v2/ServiceProviderConfig` },
}), 200, { 'content-type': SCIM_JSON }));
scim.get('/ResourceTypes', (c) => c.body(JSON.stringify({ schemas: [SCHEMA_LIST], totalResults: 1, Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA_USER }] }), 200, { 'content-type': SCIM_JSON }));

// ---------- Users ----------
scim.get('/Users', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws');
  let rows: Row[] = await memberQ(admin, ws);
  const filter = c.req.query('filter');
  if (filter) {
    const m = /^(userName|externalId|emails(?:\.value)?)\s+eq\s+"([^"]*)"$/i.exec(filter.trim());
    if (!m) throw new ScimError(400, 'invalidFilter', 'Only filters of the form userName eq "value" or externalId eq "value" are supported.');
    const v = m[2].toLowerCase();
    rows = rows.filter((r) => (m[1].toLowerCase() === 'externalid' ? (r.scim_external_id ?? '').toLowerCase() === v : r.email.toLowerCase() === v));
  }
  const start = Math.max(1, Number(c.req.query('startIndex') ?? 1) || 1);
  const count = Math.min(200, Math.max(0, Number(c.req.query('count') ?? 100) || 100));
  const page = rows.slice(start - 1, start - 1 + count);
  return c.body(JSON.stringify({ schemas: [SCHEMA_LIST], totalResults: rows.length, startIndex: start, itemsPerPage: page.length, Resources: page.map((r) => toScim(c, r)) }), 200, { 'content-type': SCIM_JSON });
});

scim.post('/Users', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws');
  const b: any = await c.req.json().catch(() => null);
  if (!b) throw new ScimError(400, 'invalidSyntax', 'The request body is not JSON.');
  const email = emailOf(b);
  if (!email) throw new ScimError(400, 'invalidValue', 'userName (or a primary email) must be an email address.');
  if (b.active === false) throw new ScimError(400, 'invalidValue', 'Create the user as active, or do not create them.');
  const role = pickRole(c, b);
  const externalId = b.externalId ? String(b.externalId).slice(0, 200) : null;
  let [u] = await admin`select id, name from users where email = ${email} and sandbox_workspace is null`;
  if (!u) {
    const id = crypto.randomUUID();
    await admin`insert into users (id, email, name, title) values (${id}, ${email}, ${nameOf(b, email)}, ${b.title ? String(b.title).slice(0, 80) : null})`;
    u = { id, name: nameOf(b, email) };
  }
  const existing = await admin`select 1 from memberships where workspace_id = ${ws} and user_id = ${u.id}`;
  if (existing.length) throw new ScimError(409, 'uniqueness', `${email} is already a member of this organization.`);
  await admin`insert into memberships (workspace_id, user_id, role, scim_external_id, provisioned_by) values (${ws}, ${u.id}, ${role}, ${externalId}, 'scim')`;
  await audit(admin, ws, scimActor(ws), 'member.joined', u.id, { email, role, via: 'scim', external_id: externalId });
  const [row] = (await memberQ(admin, ws)).filter((r: Row) => r.id === u.id);
  c.header('Location', `${new URL(c.req.url).origin}/scim/v2/Users/${u.id}`);
  return c.body(JSON.stringify(toScim(c, row)), 201, { 'content-type': SCIM_JSON });
});

async function loadOne(c: any): Promise<Row> {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, null, `No user ${id} in this organization.`);
  const [r] = (await memberQ(c.get('admin'), c.get('ws'))).filter((x: Row) => x.id === id);
  if (!r) throw new ScimError(404, null, `No user ${id} in this organization.`);
  return r;
}
scim.get('/Users/:id', async (c) => c.body(JSON.stringify(toScim(c, await loadOne(c))), 200, { 'content-type': SCIM_JSON }));

/** Applies name, title, externalId and role changes to a member. Deactivation is handled by the caller. */
async function applyAttrs(admin: Sql, ws: string, r: Row, attrs: { name?: string; title?: string | null; externalId?: string | null; role?: Role }) {
  if (attrs.name && attrs.name !== r.name) await admin`update users set name = ${attrs.name} where id = ${r.id}`;
  if (attrs.title !== undefined) await admin`update users set title = ${attrs.title} where id = ${r.id}`;
  if (attrs.externalId !== undefined) await admin`update memberships set scim_external_id = ${attrs.externalId} where workspace_id = ${ws} and user_id = ${r.id}`;
  if (attrs.role && attrs.role !== r.role) {
    if (r.role === 'admin') {
      const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${ws} and role = 'admin' and user_id <> ${r.id}`;
      if (n === 0) throw new ScimError(409, 'mutability', 'This person is the last administrator. Assign another administrator first.');
    }
    await admin`update memberships set role = ${attrs.role} where workspace_id = ${ws} and user_id = ${r.id}`;
    await audit(admin, ws, scimActor(ws), 'member.role_changed', r.id, { role: attrs.role, from: r.role, via: 'scim' });
  }
}

scim.put('/Users/:id', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws');
  const r = await loadOne(c);
  const b: any = await c.req.json().catch(() => null);
  if (!b) throw new ScimError(400, 'invalidSyntax', 'The request body is not JSON.');
  if (b.active === false) { await deprovision(admin, ws, r.id, 'scim_put'); return c.body(JSON.stringify({ ...toScim(c, r), active: false }), 200, { 'content-type': SCIM_JSON }); }
  const role = Array.isArray(b.roles) || Array.isArray(b.groups) ? pickRole(c, b) : undefined;
  await applyAttrs(admin, ws, r, { name: nameOf(b, r.name), title: b.title !== undefined ? (b.title ? String(b.title).slice(0, 80) : null) : undefined, externalId: b.externalId !== undefined ? (b.externalId ? String(b.externalId).slice(0, 200) : null) : undefined, role });
  return c.body(JSON.stringify(toScim(c, await loadOne(c))), 200, { 'content-type': SCIM_JSON });
});

scim.patch('/Users/:id', async (c) => {
  const admin = c.get('admin'); const ws = c.get('ws');
  const r = await loadOne(c);
  const b: any = await c.req.json().catch(() => null);
  if (!b || !Array.isArray(b.Operations) || !(b.schemas ?? []).includes(SCHEMA_PATCH)) throw new ScimError(400, 'invalidSyntax', 'Send a PatchOp with an Operations array.');
  const attrs: { name?: string; title?: string | null; externalId?: string | null; role?: Role } = {};
  let deactivate = false;
  let given: string | undefined; let family: string | undefined;
  for (const op of b.Operations) {
    const kind = String(op.op ?? '').toLowerCase();
    if (!['replace', 'add', 'remove'].includes(kind)) throw new ScimError(400, 'invalidValue', `Unsupported operation ${op.op}.`);
    const path = String(op.path ?? '').replace(/^urn:[^:]+(:[^:]+)*:/, '');
    const val = op.value;
    const setField = (p: string, v: any) => {
      switch (p) {
        case 'active': if (v === false || String(v).toLowerCase() === 'false') deactivate = true; break;
        case 'displayName': case 'name.formatted': attrs.name = String(v).trim().slice(0, 80); break;
        case 'name.givenName': given = String(v); break;
        case 'name.familyName': family = String(v); break;
        case 'title': attrs.title = kind === 'remove' || v == null ? null : String(v).slice(0, 80); break;
        case 'externalId': attrs.externalId = kind === 'remove' || v == null ? null : String(v).slice(0, 200); break;
        case 'roles': { const role = pickRole(c, { roles: Array.isArray(v) ? v : [v] }); attrs.role = role; break; }
        case 'userName': case 'emails': if (String(Array.isArray(v) ? v[0]?.value ?? v[0] : v).toLowerCase() !== r.email) throw new ScimError(400, 'mutability', 'Email addresses cannot be changed through SCIM. Deprovision and create the user again.'); break;
        default: break; // unknown attributes are ignored, as the specification allows
      }
    };
    if (path) setField(path, val);
    else if (val && typeof val === 'object') for (const [k, v] of Object.entries(val)) {
      if (k === 'name' && v && typeof v === 'object') for (const [nk, nv] of Object.entries(v as object)) setField(`name.${nk}`, nv);
      else setField(k, v);
    }
  }
  if (given !== undefined || family !== undefined) {
    const [g0, ...rest] = r.name.split(' ');
    attrs.name = [given ?? g0, family ?? rest.join(' ')].filter(Boolean).join(' ').slice(0, 80);
  }
  if (deactivate) { await deprovision(admin, ws, r.id, 'scim_patch'); return c.body(JSON.stringify({ ...toScim(c, r), active: false }), 200, { 'content-type': SCIM_JSON }); }
  await applyAttrs(admin, ws, r, attrs);
  return c.body(JSON.stringify(toScim(c, await loadOne(c))), 200, { 'content-type': SCIM_JSON });
});

scim.delete('/Users/:id', async (c) => {
  const r = await loadOne(c);
  await deprovision(c.get('admin'), c.get('ws'), r.id, 'scim_delete');
  return c.body(null, 204);
});
