import { z } from 'zod';
import { adminSql, tenantSql, type Sql } from './db';
import { type Env, ApiError, rand, sha256, randomB64, b64url, rateLimit, ipAllowed, seal, unseal } from './util';
import { type C, type Actor, type Role, router, body, bg, need, audit, auditQ, ROLE_LABEL } from './http';
import { rpFor, verifyRegistration, verifyAssertion, type RegistrationResponse, type AssertionResponse } from './webauthn';
import { discover, pkce, verifyIdToken, exchangeCode, DEMO_IDP_CLIENT, DEMO_PEOPLE } from './oidc';
import { seedQueries } from './seed';
import { runMonitor } from './monitor';

const ROLES = ['admin', 'ops', 'compliance', 'issuer', 'developer', 'auditor'] as const;
const roleZ = z.enum(ROLES);
const allowedOrigins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
const ipHash = async (c: C) => sha256(c.req.header('cf-connecting-ip') ?? 'unknown');

// ---------- Sessions ----------
export async function createSession(c: C, admin: Sql, userId: string, ws: string, method: string, maxHours = 24 * 7) {
  const token = `lz_sess_${rand(40)}`;
  await admin`insert into sessions (token_hash, user_id, workspace_id, method, expires_at, ip_hash, user_agent)
    values (${await sha256(token)}, ${userId}, ${ws}, ${method}, now() + make_interval(hours => ${maxHours}), ${await ipHash(c)}, ${(c.req.header('user-agent') ?? '').slice(0, 200)})`;
  await admin`update users set last_login_at = now() where id = ${userId}`;
  return token;
}

/** Resolves a session token or API key into an organization, an actor and a tenant connection. */
export async function authenticate(c: C, next: () => Promise<void>) {
  const admin = adminSql(c.env.DATABASE_URL);
  c.set('admin', admin);
  const h = c.req.header('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  let actor: Actor; let ws: string; let kind: string;
  if (tok.startsWith('lz_sess_')) {
    const rows = await admin`select s.id as sid, s.user_id, s.acting_as, s.workspace_id, s.last_seen_at, w.kind, u.name, m.role, au.name as act_name, am.role as act_role
      from sessions s join users u on u.id = s.user_id join workspaces w on w.id = s.workspace_id
      join memberships m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
      left join users au on au.id = s.acting_as left join memberships am on am.workspace_id = s.workspace_id and am.user_id = s.acting_as
      where s.token_hash = ${await sha256(tok)} and s.revoked_at is null and s.expires_at > now()
        and (w.expires_at is null or w.expires_at > now()) and (w.kind = 'sandbox' or s.last_seen_at > now() - interval '12 hours')`;
    if (!rows.length) throw new ApiError(401, 'session_expired', 'Your session has ended. Sign in again.');
    const r = rows[0];
    const acting = r.acting_as && r.act_role;
    actor = { kind: 'user', id: acting ? r.acting_as : r.user_id, userId: acting ? r.acting_as : r.user_id, realUserId: r.user_id, name: acting ? r.act_name : r.name, role: (acting ? r.act_role : r.role) as Role, sessionId: r.sid };
    ws = r.workspace_id; kind = r.kind;
    if (!(await rateLimit(admin, `sess:${r.sid}`, 600, 60))) throw new ApiError(429, 'rate_limited', 'More than 600 requests in a minute. Wait a moment and retry.');
    if (Date.now() - new Date(r.last_seen_at).getTime() > 300_000) bg(c, admin`update sessions set last_seen_at = now() where id = ${r.sid}` as any);
  } else if (tok.startsWith('lz_test_')) {
    const rows = await admin`select k.id, k.workspace_id, k.prefix, k.name, k.scopes, k.ip_allowlist, w.kind from api_keys k join workspaces w on w.id = k.workspace_id
      where k.key_hash = ${await sha256(tok)} and (k.expires_at is null or k.expires_at > now()) and (w.expires_at is null or w.expires_at > now())`;
    if (!rows.length) throw new ApiError(401, 'unauthorized', 'This key is not valid, has expired, or its sandbox has expired.');
    const k = rows[0];
    const ip = c.req.header('cf-connecting-ip') ?? '';
    if (!ipAllowed(ip, k.ip_allowlist)) throw new ApiError(403, 'ip_not_allowed', `Requests from ${ip || 'this address'} are not on this key's IP allowlist.`);
    if (!(await rateLimit(admin, `key:${k.id}`, 300, 60))) throw new ApiError(429, 'rate_limited', 'More than 300 requests in a minute. Wait a moment and retry.');
    actor = { kind: 'key', id: k.prefix, name: `API key ${k.name} (${k.prefix}…)`, scopes: k.scopes, keyId: k.id };
    ws = k.workspace_id; kind = k.kind;
    bg(c, admin`update api_keys set last_used_at = now() where id = ${k.id}` as any);
  } else {
    throw new ApiError(401, 'unauthorized', 'Sign in, or send an API key as "Authorization: Bearer lz_test_...".');
  }
  c.set('actor', actor); c.set('ws', ws); c.set('wsKind', kind);
  c.set('sql', tenantSql(c.env.DATABASE_URL_TENANT, ws));
  await next();
}

// ---------- Organizations ----------
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'org';
const SANDBOX_TEAM = [
  { key: 'aisha', email: 'aisha.rahman@astervale.example', name: 'Aisha Rahman', title: 'Head of Compliance', role: 'compliance' },
  { key: 'tomas', email: 'tomas.lindqvist@astervale.example', name: 'Tomas Lindqvist', title: 'Funds platform lead', role: 'issuer' },
  { key: 'priya', email: 'priya.nair@astervale.example', name: 'Priya Nair', title: 'Onboarding analyst', role: 'ops' },
];

export const pub = router();

pub.post('/sandboxes', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  if (!(await rateLimit(admin, `sandbox:${await ipHash(c)}`, 10, 3600))) throw new ApiError(429, 'rate_limited', 'You have opened 10 sandboxes in the last hour. Use an existing one or try again later.');
  const [{ n }] = await admin`select count(*)::int as n from workspaces where kind = 'sandbox' and expires_at > now()`;
  if (n >= Number(c.env.MAX_ACTIVE_SANDBOXES)) throw new ApiError(503, 'capacity', 'All sandboxes are in use right now. Try again tomorrow.');
  const { name } = await body(c, z.object({ name: z.string().max(80).optional() }));
  const ws = crypto.randomUUID();
  const key = `lz_test_${rand(32)}`;
  const guest = crypto.randomUUID();
  const team = SANDBOX_TEAM.map((t) => ({ ...t, id: crypto.randomUUID() }));
  const sso = { enabled: true, demo: true, label: 'Aster & Vale workforce sign-in (demo)', issuer: `${c.env.API_URL}/idp`, client_id: DEMO_IDP_CLIENT.id, email_domain: DEMO_IDP_CLIENT.domain, default_role: 'developer' };
  await admin.transaction([
    admin`insert into workspaces (id, name, kind, slug, brand_name, brand_color, sso) values (${ws}, ${name ?? 'Aster & Vale sandbox'}, 'sandbox', ${`sbx-${ws.slice(0, 8)}`}, 'Aster & Vale Private Bank', '#1f3a33', ${JSON.stringify(sso)})`,
    admin`insert into users (id, email, name, title, sandbox_workspace) values (${guest}, ${`guest@${ws.slice(0, 8)}.sandbox`}, 'You (guest)', 'Sandbox visitor', ${ws})`,
    ...team.map((t) => admin`insert into users (id, email, name, title, fictional, sandbox_workspace) values (${t.id}, ${t.email}, ${t.name}, ${t.title}, true, ${ws})`),
    admin`insert into memberships (workspace_id, user_id, role) values (${ws}, ${guest}, 'admin')`,
    ...team.map((t) => admin`insert into memberships (workspace_id, user_id, role) values (${ws}, ${t.id}, ${t.role})`),
    admin`insert into api_keys (workspace_id, prefix, key_hash, name, created_by) values (${ws}, ${key.slice(0, 12)}, ${await sha256(key)}, 'Sandbox key', ${guest})`,
    ...seedQueries(admin, ws),
    admin`insert into audit_events (workspace_id, type, subject, data, actor, actor_name) values (${ws}, 'workspace.created', ${ws}, ${JSON.stringify({ seeded: { investors: 6, funds: 3, teammates: 3 } })}, ${`user:${guest}`}, 'You (guest)')`,
  ]);
  const session = await createSession(c as C, admin, guest, ws, 'sandbox', 24 * 7);
  // First monitoring pass, so the work queue reflects the seeded book from the start.
  bg(c, runMonitor(tenantSql(c.env.DATABASE_URL_TENANT, ws), ws, 'sandbox_created', { admin }));
  const [w] = await admin`select id, name, kind, slug, created_at, expires_at from workspaces where id = ${ws}`;
  return c.json({ workspace: w, api_key: key, session_token: session, note: 'Store the API key now. It is shown once. Everything in this sandbox is fictional and is deleted when it expires.' }, 201);
});

// ---------- Passkey registration and sign-in ----------
const emailZ = z.string().trim().toLowerCase().email().max(160);
pub.post('/auth/register/options', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, z.object({ email: emailZ, name: z.string().trim().min(2).max(80), org_name: z.string().trim().min(2).max(80).optional(), invite_token: z.string().optional(), demo_data: z.boolean().default(true) }));
  if (!(await rateLimit(admin, `register:${await ipHash(c)}`, 8, 3600))) throw new ApiError(429, 'rate_limited', 'Too many sign-up attempts from this network. Try again in an hour.');
  const exists = await admin`select 1 from users where email = ${b.email} and sandbox_workspace is null`;
  if (exists.length) throw new ApiError(409, 'account_exists', 'An account with this email already exists. Sign in with your passkey instead.');
  let invite: any = null;
  if (b.invite_token) {
    [invite] = await admin`select i.*, w.name as org_name from invites i join workspaces w on w.id = i.workspace_id where i.token_hash = ${await sha256(b.invite_token)} and i.accepted_at is null and i.expires_at > now()`;
    if (!invite) throw new ApiError(404, 'invite_invalid', 'This invite link is invalid or has expired. Ask for a new one.');
  } else if (!b.org_name) throw new ApiError(422, 'org_required', 'Name your organization, or use an invite link to join one.');
  const userId = crypto.randomUUID();
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into auth_challenges (challenge, purpose, data) values (${challenge}, 'register', ${JSON.stringify({ ...b, invite_token: undefined, invite_id: invite?.id ?? null, user_id: userId })}) returning id`;
  const uid = new Uint8Array(16); userId.replace(/-/g, '').match(/../g)!.forEach((h, i) => (uid[i] = parseInt(h, 16)));
  return c.json({
    challenge_id: ch.id,
    joining: invite ? { organization: invite.org_name, role: invite.role } : null,
    options: {
      challenge, rp: { name: 'Laissez', id: rpId }, user: { id: b64url(uid), name: b.email, displayName: b.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 120000, attestation: 'none',
    },
  });
});

async function createOrg(admin: Sql, name: string, userId: string, demo: boolean) {
  const ws = crypto.randomUUID();
  const slug = `${slugify(name)}-${rand(4)}`;
  await admin.transaction([
    admin`insert into workspaces (id, name, kind, slug, brand_name, brand_color, expires_at, created_by) values (${ws}, ${name}, 'org', ${slug}, ${name}, '#1f3a33', null, ${userId})`,
    admin`insert into memberships (workspace_id, user_id, role) values (${ws}, ${userId}, 'admin')`,
    ...(demo ? seedQueries(admin, ws) : []),
    admin`insert into audit_events (workspace_id, type, subject, data, actor, actor_name) values (${ws}, 'organization.created', ${ws}, ${JSON.stringify({ name, demo_data: demo })}, ${`user:${userId}`}, ${name})`,
  ]);
  return ws;
}

pub.post('/auth/register/verify', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, z.object({ challenge_id: z.string().uuid(), credential: z.any() }));
  const rows = await admin`delete from auth_challenges where id = ${b.challenge_id} and purpose = 'register' and expires_at > now() returning challenge, data`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This sign-up request expired. Start again.');
  const { challenge, data } = rows[0];
  const pk = verifyRegistration(b.credential as RegistrationResponse, challenge, allowedOrigins(c.env));
  const exists = await admin`select 1 from users where email = ${data.email} and sandbox_workspace is null`;
  if (exists.length) throw new ApiError(409, 'account_exists', 'An account with this email already exists. Sign in instead.');
  await admin.transaction([
    admin`insert into users (id, email, name) values (${data.user_id}, ${data.email}, ${data.name})`,
    admin`insert into passkeys (id, user_id, public_key, alg, transports, name) values (${pk.credentialId}, ${data.user_id}, ${pk.publicKey}, ${pk.alg}, ${pk.transports}, 'First passkey')`,
  ]);
  let ws: string;
  if (data.invite_id) {
    const [inv] = await admin`update invites set accepted_at = now(), accepted_by = ${data.user_id} where id = ${data.invite_id} and accepted_at is null and expires_at > now() returning workspace_id, role`;
    if (!inv) throw new ApiError(410, 'invite_used', 'This invite was already used or expired. Your account exists; ask for a new invite.');
    ws = inv.workspace_id;
    await admin`insert into memberships (workspace_id, user_id, role) values (${ws}, ${data.user_id}, ${inv.role}) on conflict do nothing`;
    await audit(admin, ws, { kind: 'user', id: data.user_id, name: data.name }, 'member.joined', data.user_id, { email: data.email, role: inv.role, via: 'invite' });
  } else {
    ws = await createOrg(admin, data.org_name, data.user_id, data.demo_data);
  }
  const token = await createSession(c as C, admin, data.user_id, ws, 'passkey', 24 * 7);
  return c.json({ session_token: token, workspace_id: ws }, 201);
});

pub.post('/auth/login/options', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into auth_challenges (challenge, purpose) values (${challenge}, 'login') returning id`;
  return c.json({ challenge_id: ch.id, options: { challenge, rpId, userVerification: 'preferred', timeout: 120000, allowCredentials: [] } });
});

pub.post('/auth/login/verify', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, z.object({ challenge_id: z.string().uuid(), credential: z.any(), workspace_id: z.string().uuid().optional() }));
  if (!(await rateLimit(admin, `login:${await ipHash(c)}`, 30, 600))) throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Wait ten minutes.');
  const rows = await admin`delete from auth_challenges where id = ${b.challenge_id} and purpose = 'login' and expires_at > now() returning challenge`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This sign-in request expired. Try again.');
  const cred = b.credential as AssertionResponse;
  const [pk] = await admin`select p.*, u.name from passkeys p join users u on u.id = p.user_id where p.id = ${cred?.id ?? ''}`;
  if (!pk) throw new ApiError(401, 'unknown_passkey', 'This passkey is not registered with Laissez. Create an account first.');
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const res = await verifyAssertion(cred, { public_key: pk.public_key, alg: pk.alg, sign_count: Number(pk.sign_count) }, rows[0].challenge, allowedOrigins(c.env), rpId);
  await admin`update passkeys set sign_count = ${res.counter}, last_used_at = now() where id = ${pk.id}`;
  const orgs = await admin`select m.workspace_id, w.name, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${pk.user_id} and (w.expires_at is null or w.expires_at > now()) order by (m.workspace_id = ${b.workspace_id ?? null}) desc nulls last, m.created_at desc`;
  if (!orgs.length) throw new ApiError(403, 'no_organization', 'Your account is not a member of any organization. Ask an administrator for an invite.');
  const token = await createSession(c as C, admin, pk.user_id, orgs[0].workspace_id, 'passkey', 24 * 7);
  return c.json({ session_token: token, workspace_id: orgs[0].workspace_id, organizations: orgs });
});

pub.get('/auth/invites/:token', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const [inv] = await admin`select i.email, i.role, i.expires_at, w.name as organization, u.name as invited_by from invites i join workspaces w on w.id = i.workspace_id left join users u on u.id = i.created_by
    where i.token_hash = ${await sha256(c.req.param('token'))} and i.accepted_at is null and i.expires_at > now()`;
  if (!inv) throw new ApiError(404, 'invite_invalid', 'This invite link is invalid, used or expired.');
  return c.json({ ...inv, role_label: ROLE_LABEL[inv.role as Role] });
});

// ---------- SSO (OpenID Connect) ----------
pub.get('/auth/sso/start', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const org = c.req.query('org'); const email = (c.req.query('email') ?? '').toLowerCase();
  const rows = org
    ? await admin`select id, name, sso from workspaces where slug = ${org} and (expires_at is null or expires_at > now())`
    : await admin`select id, name, sso from workspaces where kind = 'org' and sso->>'email_domain' = ${email.split('@')[1] ?? '-'} and (sso->>'enabled')::boolean`;
  const w = rows[0];
  if (!w?.sso?.enabled) throw new ApiError(404, 'sso_not_configured', org ? 'Single sign-on is not set up for this organization.' : 'No organization uses single sign-on for that email domain.');
  const disco = await discover(c.env, w.sso.issuer);
  const { verifier, challenge } = await pkce();
  const state = randomB64(24); const nonce = randomB64(16);
  await admin`insert into auth_challenges (challenge, purpose, data) values (${state}, 'sso', ${JSON.stringify({ ws: w.id, nonce, verifier, origin: c.req.query('origin') ?? null })})`;
  const u = new URL(disco.authorization_endpoint);
  const params = { response_type: 'code', client_id: w.sso.client_id, redirect_uri: `${c.env.API_URL}/v1/auth/sso/callback`, scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return c.redirect(u.toString(), 302);
});

pub.get('/auth/sso/callback', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const appUrl = c.env.APP_URL;
  const fail = (msg: string) => c.redirect(`${appUrl}#/sso-error/${encodeURIComponent(msg)}`, 302);
  const q = c.req.query();
  if (q.error) return fail(`The identity provider returned: ${q.error_description ?? q.error}`);
  const rows = await admin`delete from auth_challenges where challenge = ${q.state ?? ''} and purpose = 'sso' and expires_at > now() returning data`;
  if (!rows.length) return fail('This sign-in attempt expired. Start again.');
  const st = rows[0].data;
  try {
    const [w] = await admin`select id, kind, sso from workspaces where id = ${st.ws}`;
    const cfg = w.sso;
    const disco = await discover(c.env, cfg.issuer);
    const secret = cfg.demo ? DEMO_IDP_CLIENT.secret : await unseal(c.env, cfg.client_secret);
    const idToken = await exchangeCode(c.env, disco.token_endpoint, { code: q.code ?? '', redirectUri: `${c.env.API_URL}/v1/auth/sso/callback`, clientId: cfg.client_id, clientSecret: secret, verifier: st.verifier });
    const claims = await verifyIdToken(c.env, idToken, { issuer: cfg.issuer, clientId: cfg.client_id, nonce: st.nonce, jwksUri: disco.jwks_uri });
    const email = claims.email.toLowerCase();
    if (cfg.email_domain && email.split('@')[1] !== cfg.email_domain) return fail(`Only ${cfg.email_domain} accounts can sign in to this organization.`);
    const sandbox = w.kind === 'sandbox';
    let [user] = sandbox
      ? await admin`select id, name from users where email = ${email} and sandbox_workspace = ${w.id}`
      : await admin`select id, name from users where email = ${email} and sandbox_workspace is null`;
    if (!user) {
      const idNew = crypto.randomUUID();
      const person = DEMO_PEOPLE.find((p) => p.email === email);
      await admin`insert into users (id, email, name, title, fictional, sandbox_workspace) values (${idNew}, ${email}, ${claims.name ?? email}, ${person?.title ?? null}, ${sandbox}, ${sandbox ? w.id : null})`;
      user = { id: idNew, name: claims.name ?? email };
    }
    const mem = await admin`select role from memberships where workspace_id = ${w.id} and user_id = ${user.id}`;
    if (!mem.length) {
      await admin`insert into memberships (workspace_id, user_id, role) values (${w.id}, ${user.id}, ${cfg.default_role ?? 'auditor'})`;
      await audit(admin, w.id, { kind: 'user', id: user.id, name: user.name }, 'member.joined', user.id, { email, role: cfg.default_role ?? 'auditor', via: 'sso_jit' });
    }
    await audit(admin, w.id, { kind: 'user', id: user.id, name: user.name }, 'session.sso', user.id, { issuer: cfg.issuer });
    const code = randomB64(24);
    await admin`insert into auth_challenges (challenge, purpose, data, expires_at) values (${code}, 'sso_code', ${JSON.stringify({ user_id: user.id, ws: w.id })}, now() + interval '2 minutes')`;
    return c.redirect(`${st.origin && allowedOrigins(c.env).includes(st.origin) ? st.origin + new URL(appUrl).pathname : appUrl}#/sso/${code}`, 302);
  } catch (e: any) {
    return fail(e instanceof ApiError ? e.message : 'Single sign-on failed. Try again.');
  }
});

pub.post('/auth/sso/exchange', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const { code } = await body(c, z.object({ code: z.string().min(10) }));
  const rows = await admin`delete from auth_challenges where challenge = ${code} and purpose = 'sso_code' and expires_at > now() returning data`;
  if (!rows.length) throw new ApiError(400, 'sso_code_expired', 'This sign-in link expired. Start single sign-on again.');
  const token = await createSession(c as C, admin, rows[0].data.user_id, rows[0].data.ws, 'sso', 12);
  return c.json({ session_token: token, workspace_id: rows[0].data.ws });
});

// ---------- Authenticated account and organization routes ----------
export const acct = router();

acct.get('/me', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  const [w] = await admin`select id, name, kind, slug, brand_name, brand_color, created_at, expires_at, (sso->>'enabled')::boolean as sso_enabled from workspaces where id = ${ws}`;
  if (a.kind !== 'user') return c.json({ actor: a, workspace: w });
  const [me] = await admin`select id, email, name, title, fictional from users where id = ${a.realUserId}`;
  const orgs = await admin`select m.workspace_id, w.name, w.kind, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${a.realUserId} and (w.expires_at is null or w.expires_at > now()) order by w.name`;
  const teammates = w.kind === 'sandbox' ? await admin`select u.id, u.name, u.title, m.role from memberships m join users u on u.id = m.user_id where m.workspace_id = ${ws} and u.fictional order by u.name` : [];
  return c.json({ user: me, acting_as: a.userId !== a.realUserId ? { id: a.userId, name: a.name, role: a.role } : null, role: a.role, role_label: ROLE_LABEL[a.role!], workspace: w, organizations: orgs, teammates });
});

acct.post('/session/act-as', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  if (a.kind !== 'user' || !a.sessionId) throw new ApiError(403, 'human_required', 'Only a signed-in person can switch teammates.');
  if (c.get('wsKind') !== 'sandbox') throw new ApiError(403, 'sandbox_only', 'Acting as a teammate exists only in sandboxes, to try two-person approval alone.');
  const { user_id } = await body(c, z.object({ user_id: z.string().uuid().nullable() }));
  if (user_id) {
    const ok = await admin`select 1 from memberships m join users u on u.id = m.user_id where m.workspace_id = ${ws} and u.id = ${user_id} and u.fictional`;
    if (!ok.length) throw new ApiError(404, 'not_found', 'That teammate is not part of this sandbox.');
  }
  await admin`update sessions set acting_as = ${user_id} where id = ${a.sessionId}`;
  await audit(c.get('sql'), ws, a, 'session.acting_as', user_id, { teammate: user_id });
  return c.json({ acting_as: user_id });
});

acct.post('/session/switch', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in person can switch organizations.');
  const { workspace_id } = await body(c, z.object({ workspace_id: z.string().uuid() }));
  const ok = await admin`select 1 from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${a.realUserId} and m.workspace_id = ${workspace_id} and (w.expires_at is null or w.expires_at > now())`;
  if (!ok.length) throw new ApiError(403, 'not_a_member', 'You are not a member of that organization.');
  await admin`update sessions set revoked_at = now() where id = ${a.sessionId}`;
  return c.json({ session_token: await createSession(c, admin, a.realUserId!, workspace_id, 'switch', 24 * 7), workspace_id });
});

acct.post('/auth/logout', async (c) => {
  const a = c.get('actor');
  if (a.sessionId) await c.get('admin')`update sessions set revoked_at = now() where id = ${a.sessionId}`;
  return c.json({ signed_out: true });
});

acct.post('/auth/invites/:token/accept', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Sign in to accept an invite.');
  const [inv] = await admin`update invites set accepted_at = now(), accepted_by = ${a.realUserId} where token_hash = ${await sha256(c.req.param('token'))} and accepted_at is null and expires_at > now() returning workspace_id, role`;
  if (!inv) throw new ApiError(404, 'invite_invalid', 'This invite link is invalid, used or expired.');
  await admin`insert into memberships (workspace_id, user_id, role) values (${inv.workspace_id}, ${a.realUserId}, ${inv.role}) on conflict do nothing`;
  await audit(admin, inv.workspace_id, a, 'member.joined', a.realUserId!, { role: inv.role, via: 'invite' });
  await admin`update sessions set revoked_at = now() where id = ${a.sessionId}`;
  return c.json({ session_token: await createSession(c, admin, a.realUserId!, inv.workspace_id, 'invite', 24 * 7), workspace_id: inv.workspace_id });
});

acct.get('/sessions', async (c) => {
  const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Sessions belong to people, not API keys.');
  const rows = await c.get('admin')`select s.id, s.method, s.created_at, s.last_seen_at, s.expires_at, s.user_agent, w.name as organization, (s.id = ${a.sessionId ?? null}) as current
    from sessions s join workspaces w on w.id = s.workspace_id where s.user_id = ${a.realUserId} and s.revoked_at is null and s.expires_at > now() order by s.last_seen_at desc limit 50`;
  return c.json({ data: rows });
});
acct.delete('/sessions/:id', async (c) => {
  const a = c.get('actor');
  const r = await c.get('admin')`update sessions set revoked_at = now() where id = ${c.req.param('id')} and user_id = ${a.realUserId ?? null} and revoked_at is null returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No active session with that id.');
  return c.json({ revoked: r[0].id });
});

acct.get('/passkeys', async (c) => {
  const a = c.get('actor');
  return c.json({ data: await c.get('admin')`select id, name, alg, transports, created_at, last_used_at from passkeys where user_id = ${a.realUserId ?? null} order by created_at` });
});
acct.post('/passkeys/options', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user' || c.get('wsKind') === 'sandbox') throw new ApiError(403, 'account_required', 'Passkeys belong to real accounts. Create an account to add one.');
  const [u] = await admin`select id, email, name from users where id = ${a.realUserId}`;
  const existing = await admin`select id from passkeys where user_id = ${u.id}`;
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into auth_challenges (challenge, purpose, data) values (${challenge}, 'add_passkey', ${JSON.stringify({ user_id: u.id })}) returning id`;
  const uid = new Uint8Array(16); u.id.replace(/-/g, '').match(/../g)!.forEach((h: string, i: number) => (uid[i] = parseInt(h, 16)));
  return c.json({ challenge_id: ch.id, options: { challenge, rp: { name: 'Laissez', id: rpId }, user: { id: b64url(uid), name: u.email, displayName: u.name }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 120000, attestation: 'none', excludeCredentials: existing.map((p: any) => ({ type: 'public-key', id: p.id })) } });
});
acct.post('/passkeys/verify', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  const b = await body(c, z.object({ challenge_id: z.string().uuid(), credential: z.any(), name: z.string().max(60).optional() }));
  const rows = await admin`delete from auth_challenges where id = ${b.challenge_id} and purpose = 'add_passkey' and expires_at > now() returning challenge, data`;
  if (!rows.length || rows[0].data.user_id !== a.realUserId) throw new ApiError(400, 'challenge_expired', 'This request expired. Try again.');
  const pk = verifyRegistration(b.credential as RegistrationResponse, rows[0].challenge, allowedOrigins(c.env));
  await admin`insert into passkeys (id, user_id, public_key, alg, transports, name) values (${pk.credentialId}, ${a.realUserId}, ${pk.publicKey}, ${pk.alg}, ${pk.transports}, ${b.name ?? 'Passkey'})`;
  return c.json({ added: pk.credentialId }, 201);
});
acct.delete('/passkeys/:id', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  const [{ n }] = await admin`select count(*)::int as n from passkeys where user_id = ${a.realUserId ?? null}`;
  if (n <= 1) throw new ApiError(422, 'last_passkey', 'This is your only passkey. Add another before removing it.');
  const r = await admin`delete from passkeys where id = ${c.req.param('id')} and user_id = ${a.realUserId ?? null} returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No passkey with that id on your account.');
  return c.json({ removed: r[0].id });
});

// Members and invites
acct.get('/members', async (c) => {
  need(c, 'read');
  const rows = await c.get('admin')`select u.id, u.name, u.email, u.title, u.fictional, u.last_login_at, m.role, m.created_at from memberships m join users u on u.id = m.user_id where m.workspace_id = ${c.get('ws')} order by m.created_at`;
  return c.json({ data: rows.map((r: any) => ({ ...r, role_label: ROLE_LABEL[r.role as Role] })), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r] })) });
});
acct.patch('/members/:id', async (c) => {
  need(c, 'members:admin');
  const admin = c.get('admin'); const ws = c.get('ws');
  const { role } = await body(c, z.object({ role: roleZ }));
  if (role !== 'admin') {
    const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${ws} and role = 'admin' and user_id <> ${c.req.param('id')}`;
    if (n === 0) throw new ApiError(422, 'last_admin', 'An organization needs at least one administrator.');
  }
  const r = await admin`update memberships set role = ${role} where workspace_id = ${ws} and user_id = ${c.req.param('id')} returning user_id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'That person is not a member.');
  await audit(c.get('sql'), ws, c.get('actor'), 'member.role_changed', c.req.param('id'), { role });
  return c.json({ user_id: c.req.param('id'), role });
});
acct.delete('/members/:id', async (c) => {
  need(c, 'members:admin');
  const admin = c.get('admin'); const ws = c.get('ws');
  const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${ws} and role = 'admin' and user_id <> ${c.req.param('id')}`;
  if (n === 0) throw new ApiError(422, 'last_admin', 'An organization needs at least one administrator.');
  const r = await admin`delete from memberships where workspace_id = ${ws} and user_id = ${c.req.param('id')} returning user_id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'That person is not a member.');
  await admin`update sessions set revoked_at = now() where workspace_id = ${ws} and user_id = ${c.req.param('id')} and revoked_at is null`;
  await audit(c.get('sql'), ws, c.get('actor'), 'member.removed', c.req.param('id'));
  return c.json({ removed: c.req.param('id') });
});
acct.get('/invites', async (c) => {
  need(c, 'members:admin');
  return c.json({ data: await c.get('sql')`select id, email, role, created_at, expires_at, accepted_at from invites where workspace_id = ${c.get('ws')} order by created_at desc limit 50` });
});
acct.post('/invites', async (c) => {
  need(c, 'members:admin');
  const sql = c.get('sql'); const ws = c.get('ws'); const a = c.get('actor');
  const b = await body(c, z.object({ email: emailZ, role: roleZ }));
  const token = `inv_${rand(32)}`;
  const [row] = await sql`insert into invites (workspace_id, email, role, token_hash, created_by) values (${ws}, ${b.email}, ${b.role}, ${await sha256(token)}, ${a.realUserId ?? null}) returning id, expires_at`;
  await audit(sql, ws, a, 'member.invited', row.id, { email: b.email, role: b.role });
  return c.json({ id: row.id, email: b.email, role: b.role, expires_at: row.expires_at, link: `${c.env.APP_URL}#/invite/${token}`, note: 'Send this link to the person. It works once and expires in 7 days.' }, 201);
});
acct.delete('/invites/:id', async (c) => {
  need(c, 'members:admin');
  const r = await c.get('sql')`delete from invites where workspace_id = ${c.get('ws')} and id = ${c.req.param('id')} and accepted_at is null returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No open invite with that id.');
  return c.json({ revoked: r[0].id });
});

// Organization settings and SSO
acct.patch('/organization', async (c) => {
  need(c, 'members:admin');
  const b = await body(c, z.object({ name: z.string().trim().min(2).max(80).optional(), brand_name: z.string().trim().min(2).max(80).optional(), brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }));
  const [w] = await c.get('sql')`update workspaces set name = coalesce(${b.name ?? null}, name), brand_name = coalesce(${b.brand_name ?? null}, brand_name), brand_color = coalesce(${b.brand_color ?? null}, brand_color) where id = ${c.get('ws')} returning id, name, brand_name, brand_color`;
  await audit(c.get('sql'), c.get('ws'), c.get('actor'), 'organization.updated', c.get('ws'), b);
  return c.json(w);
});
acct.get('/sso', async (c) => {
  need(c, 'read');
  const [w] = await c.get('admin')`select slug, sso from workspaces where id = ${c.get('ws')}`;
  const s = w.sso ?? null;
  return c.json({ org_slug: w.slug, redirect_uri: `${c.env.API_URL}/v1/auth/sso/callback`, config: s ? { enabled: s.enabled, label: s.label, issuer: s.issuer, client_id: s.client_id, email_domain: s.email_domain, default_role: s.default_role, demo: !!s.demo, has_secret: !!s.client_secret || !!s.demo } : null, start_url: `${c.env.API_URL}/v1/auth/sso/start?org=${w.slug}` });
});
acct.put('/sso', async (c) => {
  need(c, 'members:admin');
  if (c.get('wsKind') === 'sandbox') throw new ApiError(403, 'sandbox_only', 'Sandboxes use the demo identity provider. Create an organization to connect your own.');
  const b = await body(c, z.object({ enabled: z.boolean(), issuer: z.string().url(), client_id: z.string().min(3).max(200), client_secret: z.string().min(8).max(500).optional(), email_domain: z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/), default_role: roleZ.default('auditor'), label: z.string().max(80).optional() }));
  const admin = c.get('admin'); const ws = c.get('ws');
  const [w] = await admin`select sso from workspaces where id = ${ws}`;
  const secret = b.client_secret ? await seal(c.env, b.client_secret) : w.sso?.client_secret;
  if (!secret) throw new ApiError(422, 'secret_required', 'Add the client secret from your identity provider.');
  await discover(c.env, b.issuer);
  const taken = await admin`select 1 from workspaces where kind = 'org' and id <> ${ws} and sso->>'email_domain' = ${b.email_domain} and (sso->>'enabled')::boolean`;
  if (taken.length && b.enabled) throw new ApiError(409, 'domain_taken', `Another organization already uses single sign-on for ${b.email_domain}.`);
  await admin`update workspaces set sso = ${JSON.stringify({ enabled: b.enabled, issuer: b.issuer.replace(/\/$/, ''), client_id: b.client_id, client_secret: secret, email_domain: b.email_domain, default_role: b.default_role, label: b.label ?? 'Company sign-in' })} where id = ${ws}`;
  await audit(c.get('sql'), ws, c.get('actor'), 'sso.configured', ws, { issuer: b.issuer, email_domain: b.email_domain, enabled: b.enabled });
  return c.json({ saved: true });
});

export { auditQ };
