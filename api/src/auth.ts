import { z } from 'zod';
import { adminSql, tenantSql, type Sql } from './db';
import { type Env, ApiError, rand, sha256, randomB64, b64url, rateLimit, rateLimitStatus, requestGeo, parseUa, ipAllowed, seal, unseal, type RateStatus } from './util';
import { type C, type Actor, type Role, router, body, bg, need, audit, auditQ, ROLE_LABEL, STEP_UP_WINDOW_MS, needStepUp } from './http';
import { sendEmail, emailAdmins, templates, deliverable } from './email';
import { rpFor, verifyRegistration, verifyAssertion, type RegistrationResponse, type AssertionResponse } from './webauthn';
import { discover, pkce, verifyIdToken, exchangeCode, DEMO_IDP_CLIENT, DEMO_PEOPLE } from './oidc';
import { seedQueries } from './seed';
import { runMonitor } from './monitor';
import { isProduction, fictionalOnly } from './mode';
import { effectivePolicy, emailAllowed, networkAllowed, type SecurityPolicy } from './security-policy';
import { TERMS_VERSION, mailConfigured, verificationRequired, verifyTurnstile, issueEmailVerification, securityAlert } from './account-security';

const ROLES = ['admin', 'ops', 'compliance', 'legal', 'issuer', 'developer', 'auditor'] as const;
const roleZ = z.enum(ROLES);
const emailZ = z.string().trim().toLowerCase().email().max(160);

// Request bodies, exported so api/src/openapi-gen.ts derives their JSON Schema for the OpenAPI document.
export const sandboxIn = z.object({ name: z.string().max(80).optional() });
export const registerOptionsIn = z.object({ email: emailZ, name: z.string().trim().min(2).max(80), org_name: z.string().trim().min(2).max(80).optional(), invite_token: z.string().optional(), demo_data: z.boolean().default(true), accept_terms: z.boolean().optional(), turnstile_token: z.string().max(2048).optional() });
export const registerVerifyIn = z.object({ challenge_id: z.string().uuid(), credential: z.any() });
export const loginVerifyIn = z.object({ challenge_id: z.string().uuid(), credential: z.any(), workspace_id: z.string().uuid().optional() });
export const ssoExchangeIn = z.object({ code: z.string().min(10) });
export const profileIn = z.object({ name: z.string().trim().min(2).max(80).optional(), email: emailZ.optional(), title: z.string().trim().max(80).nullable().optional() });
export const actAsIn = z.object({ user_id: z.string().uuid().nullable() });
export const switchIn = z.object({ workspace_id: z.string().uuid() });
export const passkeyVerifyIn = z.object({ challenge_id: z.string().uuid(), credential: z.any(), name: z.string().max(60).optional() });
export const memberRoleIn = z.object({ role: roleZ });
export const inviteIn = z.object({ email: emailZ, role: roleZ });
export const organizationIn = z.object({ name: z.string().trim().min(2).max(80).optional(), brand_name: z.string().trim().min(2).max(80).optional(), brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), settlement_mode: z.enum(['full', 'decide_only']).optional() });
export const ssoIn = z.object({ enabled: z.boolean(), issuer: z.string().url(), client_id: z.string().min(3).max(200), client_secret: z.string().min(8).max(500).optional(), email_domain: z.string().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/), default_role: roleZ.default('auditor'), label: z.string().max(80).optional() });
const allowedOrigins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
const ipHash = async (c: C) => sha256(c.req.header('cf-connecting-ip') ?? 'unknown');

// ---------- Sessions ----------
/** Organization policy for a workspace, defaults filled in. Sandboxes never carry one. */
export async function policyFor(admin: Sql, ws: string): Promise<SecurityPolicy> {
  const [w] = await admin`select kind, security_policy from workspaces where id = ${ws}`;
  return effectivePolicy(w?.kind === 'org' ? w.security_policy : null);
}

/**
 * Checks an organization's sign-in policy before a session exists: the network the person is on, whether the
 * organization requires single sign-on (administrators keep passkey sign-in as break-glass) and whether it requires
 * a passkey that verified the person (PIN or biometric). Throws the reason; callers decide what to do next.
 */
export async function assertSignInAllowed(c: C, admin: Sql, o: { userId: string; ws: string; role: string; method: string; userVerified?: boolean }) {
  const policy = await policyFor(admin, o.ws);
  const ip = c.req.header('cf-connecting-ip') ?? '';
  if (!networkAllowed(policy, ip)) throw new ApiError(403, 'network_not_allowed', `This organization only allows sign-in from approved networks, and ${ip || 'this address'} is not one of them.`);
  if (policy.require_sso && (o.method === 'passkey' || o.method === 'recovery') && o.role !== 'admin') throw new ApiError(403, 'sso_sign_in_required', 'This organization requires single sign-on. Use the company sign-in instead of a passkey.');
  if (policy.require_user_verification && o.method === 'passkey' && o.userVerified === false) throw new ApiError(403, 'user_verification_required', 'This organization requires a passkey that confirms it is you with a PIN, fingerprint or face. Unlock the passkey with one of those and try again.');
  return policy;
}

export async function createSession(c: C, admin: Sql, userId: string, ws: string, method: string, maxHours = 24 * 7) {
  const token = `lz_sess_${rand(40)}`;
  const policy = await policyFor(admin, ws);
  maxHours = Math.min(maxHours, policy.session_hours);
  const ip = await ipHash(c);
  const ua = (c.req.header('user-agent') ?? '').slice(0, 200);
  const { country, city } = requestGeo(c.req.raw, (n) => c.req.header(n));
  const { browser, os } = parseUa(ua);
  // A sign-in from a network this account has never used before triggers an alert, except on the very first session.
  const [seen] = await admin`select exists (select 1 from sessions where user_id = ${userId} and ip_hash = ${ip}) as same_network, exists (select 1 from sessions where user_id = ${userId}) as any_session`;
  await admin`insert into sessions (token_hash, user_id, workspace_id, method, expires_at, ip_hash, user_agent, country, city, browser, os)
    values (${await sha256(token)}, ${userId}, ${ws}, ${method}, now() + make_interval(hours => ${maxHours}), ${ip}, ${ua}, ${country}, ${city}, ${browser}, ${os})`;
  await admin`update users set last_login_at = now() where id = ${userId}`;
  if (seen?.any_session && !seen.same_network && method !== 'switch' && method !== 'sandbox') {
    const [u] = await admin`select u.email, u.name, w.name as org, w.brand_name from users u join workspaces w on w.id = ${ws} where u.id = ${userId}`;
    if (u && deliverable(u.email)) {
      const m = templates.newDevice({ name: u.name, org: u.brand_name || u.org, browser, os, country, city, link: `${c.env.APP_URL}#/settings/sessions` });
      bg(c, sendEmail(c.env, admin, { ws, to: u.email, kind: 'new_device', ...m }));
      bg(c, audit(admin, ws, { kind: 'user', id: userId, name: u.name }, 'session.new_device', userId, { browser, os, country, city, method }));
    }
  }
  return token;
}

/** Paths a recovery-code session may use: enough to add a passkey and nothing else. */
const RECOVERY_PATHS = /^\/v1\/(me|passkeys(\/.*)?|auth\/logout|sessions(\/.*)?)$/;

/** Paths an account with an unconfirmed email may use: look at itself, ask for another link, and leave. */
const UNVERIFIED_PATHS = /^\/v1\/(me|auth\/logout|auth\/verify-email\/resend|sessions(\/.*)?)$/;
/** An organization whose billing is suspended may read, view and pay, export its data and leave. Writes elsewhere answer 402. */
const SUSPENDED_OK = /^\/v1\/(billing(\/.*)?|organization\/export|auth\/logout|me|sessions(\/.*)?|account\/export|auth\/step-up(\/.*)?)$/;
/**
 * Redemptions stay open during a billing suspension: an investor's exit is never held hostage to an unpaid invoice.
 * These two routes pass the gate with `suspended` set, and their handlers refuse anything that is not a redemption.
 */
const SUSPENDED_REDEEM_ONLY = /^\/v1\/(decisions|settlements)$/;
/** In decide-only mode the customer settles on its own rails: Laissez decides and keeps the evidence, and never settles. */
const DECIDE_ONLY_CLOSED = /^\/v1\/(settlements(\/.*)?|batches\/[^/]+\/settle|chain\/.*)$/;
/** Until staff verify the organization in production mode, these writes stay closed: they move or could move real value. */
const NEEDS_VERIFIED_ORG = /^\/v1\/(settlements(\/.*)?|api-keys|chain\/.*)$/;

/** Counts the request against the organization's monthly quota. One upsert per request. */
async function checkQuota(admin: Sql, ws: string) {
  const [q] = await admin`insert into quotas (workspace_id, month, count) values (${ws}, date_trunc('month', now())::date, 1)
    on conflict (workspace_id, month) do update set count = quotas.count + 1, updated_at = now()
    returning count, (select monthly_quota from workspaces where id = ${ws}) as quota`;
  const used = Number(q.count); const quota = Number(q.quota);
  if (used > quota) {
    const reset = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    throw new ApiError(429, 'quota_exceeded', `This organization has used its ${quota.toLocaleString('en-US')} requests for the month. The quota resets on ${reset.toISOString().slice(0, 10)}.`, { used, quota, resets_at: reset.toISOString(), retry_after: Math.max(60, Math.floor((reset.getTime() - Date.now()) / 1000)) });
  }
  return { used, quota };
}

/** Records where an API key was used from; the first request from a new network after the first one alerts the administrators. */
async function trackKeyNetwork(c: C, admin: Sql, k: { id: string; workspace_id: string; name: string; prefix: string; known_ip_hashes: string[] | null; last_used_ip_hash: string | null }) {
  const ip = await ipHash(c);
  const ua = (c.req.header('user-agent') ?? '').slice(0, 200);
  const { country } = requestGeo(c.req.raw, (n) => c.req.header(n));
  const known = k.known_ip_hashes ?? [];
  if (known.includes(ip)) {
    if (k.last_used_ip_hash !== ip) await admin`update api_keys set last_used_at = now(), last_used_ip_hash = ${ip}, last_used_country = ${country}, last_used_ua = ${ua} where id = ${k.id}`;
    else await admin`update api_keys set last_used_at = now(), last_used_ua = ${ua}, last_used_country = coalesce(${country}, last_used_country) where id = ${k.id}`;
    return;
  }
  const next = [...known, ip].slice(-20);
  await admin`update api_keys set last_used_at = now(), last_used_ip_hash = ${ip}, last_used_country = ${country}, last_used_ua = ${ua}, known_ip_hashes = ${next} where id = ${k.id}`;
  if (!known.length) return; // the very first use establishes the first network
  const [w] = await admin`select name, brand_name from workspaces where id = ${k.workspace_id}`;
  await audit(admin, k.workspace_id, { kind: 'key', id: k.prefix, name: `API key ${k.name} (${k.prefix}…)` }, 'api_key.new_network', k.prefix, { key_id: k.id, country, user_agent: ua, known_networks: next.length });
  await emailAdmins(c.env, admin, k.workspace_id, 'api_key_new_network', templates.apiKeyNewNetwork({ org: w?.brand_name || w?.name || 'your organization', keyName: k.name, prefix: k.prefix, country, ua, link: `${c.env.APP_URL}#/settings/api-keys` }));
}

/** Resolves a session token or API key into an organization, an actor and a tenant connection. */
export async function authenticate(c: C, next: () => Promise<void>) {
  const admin = adminSql(c.env.DATABASE_URL);
  c.set('admin', admin);
  const h = c.req.header('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  let actor: Actor; let ws: string; let kind: string; let rate: RateStatus;
  let billing = 'none'; let orgVerification = 'verified'; let idleTouchMs = 300_000; let settlementMode = 'full';
  const path = new URL(c.req.url).pathname;
  if (tok.startsWith('lz_sess_')) {
    const rows = await admin`select s.id as sid, s.user_id, s.acting_as, s.workspace_id, s.last_seen_at, s.method, w.kind, w.security_policy, w.billing_status, w.verification_status, w.settlement_mode, s.stepped_up_at, s.created_at as session_created_at, u.name, u.email_verified_at, m.role, au.name as act_name, am.role as act_role
      from sessions s join users u on u.id = s.user_id join workspaces w on w.id = s.workspace_id
      join memberships m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
      left join users au on au.id = s.acting_as left join memberships am on am.workspace_id = s.workspace_id and am.user_id = s.acting_as
      where s.token_hash = ${await sha256(tok)} and s.revoked_at is null and s.expires_at > now()
        and (w.expires_at is null or w.expires_at > now()) and (w.kind = 'sandbox' or s.last_seen_at > now() - interval '12 hours')`;
    if (!rows.length) throw new ApiError(401, 'session_expired', 'Your session has ended. Sign in again.');
    const r = rows[0];
    // A recovery-code session exists to add a passkey. Everything else needs a full sign-in.
    if (r.method === 'recovery' && !RECOVERY_PATHS.test(path)) throw new ApiError(403, 'recovery_session', 'You signed in with a recovery code. Add a passkey on the Security page, then sign in with it to continue.');
    const acting = r.acting_as && r.act_role;
    actor = { kind: 'user', id: acting ? r.acting_as : r.user_id, userId: acting ? r.acting_as : r.user_id, realUserId: r.user_id, name: acting ? r.act_name : r.name, role: (acting ? r.act_role : r.role) as Role, sessionId: r.sid };
    ws = r.workspace_id; kind = r.kind; billing = r.billing_status; orgVerification = r.verification_status; settlementMode = r.settlement_mode ?? 'full';
    // A session is fresh when it was just created (passkey or SSO sign-in) or after a step-up assertion.
    c.set('steppedUpAt', Math.max(r.stepped_up_at ? new Date(r.stepped_up_at).getTime() : 0, new Date(r.session_created_at).getTime())); c.set('sessionId', r.sid);
    if (kind === 'org') {
      // Organization policy: idle timeout and approved networks. Sandboxes carry no policy.
      const policy = effectivePolicy(r.security_policy);
      if (Date.now() - new Date(r.last_seen_at).getTime() > policy.idle_minutes * 60_000) throw new ApiError(401, 'session_idle', `You were signed out after ${policy.idle_minutes} minutes without activity, as your organization requires. Sign in again.`);
      const sessIp = c.req.header('cf-connecting-ip') ?? '';
      if (!networkAllowed(policy, sessIp)) throw new ApiError(403, 'network_not_allowed', `This organization only allows access from approved networks, and ${sessIp || 'this address'} is not one of them.`);
      if (!r.email_verified_at && verificationRequired(c.env) && !UNVERIFIED_PATHS.test(path)) throw new ApiError(403, 'email_not_verified', 'Confirm your email address first. We sent a link; you can ask for another from the sign-in screen.');
      idleTouchMs = policy.idle_minutes < 720 ? 60_000 : 300_000;
    }
    rate = await rateLimitStatus(admin, `sess:${r.sid}`, 600, 60);
    if (!rate.allowed) throw new ApiError(429, 'rate_limited', 'More than 600 requests in a minute. Wait a moment and retry.', { retry_after: rate.retryAfter, rate });
    if (Date.now() - new Date(r.last_seen_at).getTime() > idleTouchMs) bg(c, admin`update sessions set last_seen_at = now() where id = ${r.sid}` as any);
  } else if (tok.startsWith('lz_test_')) {
    const rows = await admin`select k.id, k.workspace_id, k.prefix, k.name, k.scopes, k.ip_allowlist, k.known_ip_hashes, k.last_used_ip_hash, w.kind, w.billing_status, w.verification_status, w.settlement_mode from api_keys k join workspaces w on w.id = k.workspace_id
      where k.key_hash = ${await sha256(tok)} and (k.expires_at is null or k.expires_at > now()) and (w.expires_at is null or w.expires_at > now())`;
    if (!rows.length) throw new ApiError(401, 'unauthorized', 'This key is not valid, has expired, or its sandbox has expired.');
    const k = rows[0];
    const ip = c.req.header('cf-connecting-ip') ?? '';
    if (!ipAllowed(ip, k.ip_allowlist)) throw new ApiError(403, 'ip_not_allowed', `Requests from ${ip || 'this address'} are not on this key's IP allowlist.`);
    rate = await rateLimitStatus(admin, `key:${k.id}`, 300, 60);
    if (!rate.allowed) throw new ApiError(429, 'rate_limited', 'More than 300 requests in a minute. Wait a moment and retry.', { retry_after: rate.retryAfter, rate });
    actor = { kind: 'key', id: k.prefix, name: `API key ${k.name} (${k.prefix}…)`, scopes: k.scopes, keyId: k.id };
    ws = k.workspace_id; kind = k.kind; billing = k.billing_status; orgVerification = k.verification_status; settlementMode = k.settlement_mode ?? 'full';
    bg(c, trackKeyNetwork(c, admin, k));
  } else {
    throw new ApiError(401, 'unauthorized', 'Sign in, or send an API key as "Authorization: Bearer lz_test_...".');
  }
  // Billing and organization-verification gates apply to people and API keys alike. Sandboxes are exempt.
  if (kind === 'org') {
    const m = c.req.method.toUpperCase();
    if (billing === 'suspended' && m !== 'GET' && m !== 'HEAD' && !SUSPENDED_OK.test(path)) {
      if (m === 'POST' && SUSPENDED_REDEEM_ONLY.test(path)) c.set('suspended', true);
      else throw new ApiError(402, 'billing_suspended', 'This organization is suspended for an unpaid invoice. Reads and redemptions still work. Pay the open invoice under Settings, Billing, or contact billing to restore write access.');
    }
    if (settlementMode === 'decide_only' && m !== 'GET' && m !== 'HEAD' && DECIDE_ONLY_CLOSED.test(path)) throw new ApiError(403, 'decide_only_mode', 'This organization runs in decide-only mode: Laissez returns decisions and evidence, and settlement happens on your own rails. An administrator can change the mode under Settings, Organization.');
    if (isProduction(c.env) && orgVerification !== 'verified' && m !== 'GET' && m !== 'HEAD' && NEEDS_VERIFIED_ORG.test(path)) throw new ApiError(403, 'org_not_verified', 'Your organization is not verified yet, so settlements, API keys and chain actions are closed. Submit the verification form under Settings, Verification.', { verification_status: orgVerification });
  }
  const quota = await checkQuota(admin, ws);
  (c.set as any)('rate', { ...rate, quota });
  c.set('actor', actor); c.set('ws', ws); c.set('wsKind', kind); c.set('settlementMode', settlementMode);
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
  // Sandboxes are fictional: a production deployment has none (api/src/mode.ts).
  fictionalOnly(c.env, 'The sandbox');
  const admin = adminSql(c.env.DATABASE_URL);
  if (!(await rateLimit(admin, `sandbox:${await ipHash(c)}`, 10, 3600))) throw new ApiError(429, 'rate_limited', 'You have opened 10 sandboxes in the last hour. Use an existing one or try again later.');
  const [{ n }] = await admin`select count(*)::int as n from workspaces where kind = 'sandbox' and expires_at > now()`;
  if (n >= Number(c.env.MAX_ACTIVE_SANDBOXES)) throw new ApiError(503, 'capacity', 'All sandboxes are in use right now. Try again tomorrow.');
  const { name } = await body(c, sandboxIn);
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
pub.post('/auth/register/options', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, registerOptionsIn);
  if (!(await rateLimit(admin, `register:${await ipHash(c)}`, 8, 3600))) throw new ApiError(429, 'rate_limited', 'Too many sign-up attempts from this network. Try again in an hour.');
  if (!b.accept_terms) throw new ApiError(422, 'terms_required', 'Accept the Terms of Service and the Privacy Policy to create an account.');
  await verifyTurnstile(c.env, b.turnstile_token, c.req.header('cf-connecting-ip'));
  // A production deployment that cannot send mail cannot verify anyone, so it refuses sign-up instead of creating accounts nobody can confirm.
  if (isProduction(c.env) && !mailConfigured(c.env)) throw new ApiError(503, 'email_not_configured', 'Sign-up is closed until outgoing email is configured on this deployment. Contact the operator.');
  const exists = await admin`select 1 from users where email = ${b.email} and sandbox_workspace is null`;
  if (exists.length) throw new ApiError(409, 'account_exists', 'An account with this email already exists. Sign in with your passkey instead.');
  let invite: any = null;
  if (b.invite_token) {
    [invite] = await admin`select i.*, w.name as org_name from invites i join workspaces w on w.id = i.workspace_id where i.token_hash = ${await sha256(b.invite_token)} and i.accepted_at is null and i.expires_at > now()`;
    if (!invite) throw new ApiError(404, 'invite_invalid', 'This invite link is invalid or has expired. Ask for a new one.');
    const [iw] = await admin`select kind, security_policy from workspaces where id = ${invite.workspace_id}`;
    if (iw?.kind === 'org' && !emailAllowed(effectivePolicy(iw.security_policy), b.email)) throw new ApiError(403, 'email_domain_not_allowed', 'This organization only accepts people with a company email address. Use the address your administrator allows.');
  } else if (!b.org_name) throw new ApiError(422, 'org_required', 'Name your organization, or use an invite link to join one.');
  const userId = crypto.randomUUID();
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into auth_challenges (challenge, purpose, data) values (${challenge}, 'register', ${JSON.stringify({ ...b, invite_token: undefined, turnstile_token: undefined, invite_id: invite?.id ?? null, invite_email: invite?.email ?? null, user_id: userId })}) returning id`;
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

async function createOrg(admin: Sql, name: string, userId: string, demo: boolean, env?: Env) {
  // Fictional seed data never lands in a production organization, whatever the sign-up form asked for.
  if (env && isProduction(env)) demo = false;
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
  const b = await body(c, registerVerifyIn);
  const rows = await admin`delete from auth_challenges where id = ${b.challenge_id} and purpose = 'register' and expires_at > now() returning challenge, data`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This sign-up request expired. Start again.');
  const { challenge, data } = rows[0];
  const pk = verifyRegistration(b.credential as RegistrationResponse, challenge, allowedOrigins(c.env));
  const exists = await admin`select 1 from users where email = ${data.email} and sandbox_workspace is null`;
  if (exists.length) throw new ApiError(409, 'account_exists', 'An account with this email already exists. Sign in instead.');
  // A person who arrives through an invite sent to this very address has already shown they can read that mailbox.
  const viaInviteMail = !!data.invite_id && String(data.invite_email ?? '').toLowerCase() === data.email;
  await admin.transaction([
    admin`insert into users (id, email, name, terms_accepted_at, terms_version, email_verified_at) values (${data.user_id}, ${data.email}, ${data.name}, now(), ${TERMS_VERSION}, ${viaInviteMail ? new Date().toISOString() : null})`,
    admin`insert into passkeys (id, user_id, public_key, alg, transports, name) values (${pk.credentialId}, ${data.user_id}, ${pk.publicKey}, ${pk.alg}, ${pk.transports}, 'First passkey')`,
  ]);
  let ws: string;
  if (data.invite_id) {
    const [inv] = await admin`update invites set accepted_at = now(), accepted_by = ${data.user_id} where id = ${data.invite_id} and accepted_at is null and expires_at > now() returning workspace_id, role`;
    if (!inv) throw new ApiError(410, 'invite_used', 'This invite was already used or expired. Your account exists; ask for a new invite.');
    ws = inv.workspace_id;
    const policy = await policyFor(admin, ws);
    if (!emailAllowed(policy, data.email)) throw new ApiError(403, 'email_domain_not_allowed', 'This organization only accepts people with a company email address. Your account exists; ask the administrator to allow your address.');
    await admin`insert into memberships (workspace_id, user_id, role) values (${ws}, ${data.user_id}, ${inv.role}) on conflict do nothing`;
    await audit(admin, ws, { kind: 'user', id: data.user_id, name: data.name }, 'member.joined', data.user_id, { email: data.email, role: inv.role, via: 'invite' });
  } else {
    ws = await createOrg(admin, data.org_name, data.user_id, data.demo_data, c.env);
  }
  const token = await createSession(c as C, admin, data.user_id, ws, 'passkey', 24 * 7);
  // Every new account gets a confirmation link, even when the deployment cannot require it, so the Outbox shows what a person would receive.
  let verification: { required: boolean; verified: boolean; sent: boolean; dev_link: string | null } = { required: verificationRequired(c.env), verified: viaInviteMail, sent: false, dev_link: null };
  if (!viaInviteMail) {
    const v = await issueEmailVerification(c.env, admin, { id: data.user_id, email: data.email, name: data.name }, await ipHash(c));
    verification = { ...verification, sent: v.sent, dev_link: v.dev_link };
  }
  return c.json({ session_token: token, workspace_id: ws, verification }, 201);
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
  const b = await body(c, loginVerifyIn);
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
  // The first organization whose sign-in policy this passkey sign-in satisfies. If none does, the first organization's reason is the answer.
  let chosen: (typeof orgs)[number] | null = null; let firstErr: unknown = null;
  for (const o of orgs) {
    try { await assertSignInAllowed(c as C, admin, { userId: pk.user_id, ws: o.workspace_id, role: o.role, method: 'passkey', userVerified: res.userVerified }); chosen = o; break; }
    catch (e) { firstErr ??= e; }
  }
  if (!chosen) throw firstErr;
  const token = await createSession(c as C, admin, pk.user_id, chosen.workspace_id, 'passkey', 24 * 7);
  return c.json({ session_token: token, workspace_id: chosen.workspace_id, organizations: orgs });
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
    if (!sandbox) {
      const policy = effectivePolicy((await admin`select security_policy from workspaces where id = ${w.id}`)[0]?.security_policy);
      if (!emailAllowed(policy, email)) return fail('Your email domain is not allowed by this organization\'s security policy.');
      if (!networkAllowed(policy, c.req.header('cf-connecting-ip') ?? '')) return fail('This organization only allows sign-in from approved networks.');
    }
    let [user] = sandbox
      ? await admin`select id, name from users where email = ${email} and sandbox_workspace = ${w.id}`
      : await admin`select id, name from users where email = ${email} and sandbox_workspace is null`;
    if (!user) {
      const idNew = crypto.randomUUID();
      const person = DEMO_PEOPLE.find((p) => p.email === email);
      await admin`insert into users (id, email, name, title, fictional, sandbox_workspace, email_verified_at) values (${idNew}, ${email}, ${claims.name ?? email}, ${person?.title ?? null}, ${sandbox}, ${sandbox ? w.id : null}, now())`;
      user = { id: idNew, name: claims.name ?? email };
    } else if (!sandbox) {
      // The identity provider vouches for the address (verifyIdToken rejects email_verified false), so SSO also confirms it here.
      await admin`update users set email_verified_at = coalesce(email_verified_at, now()) where id = ${user.id}`;
    }
    // Group to role mapping: the first configured group the person belongs to decides the role, listed order wins.
    const groupClaim: string = cfg.group_claim || 'groups';
    const rawGroups = (claims as any)[groupClaim];
    const groups: string[] = Array.isArray(rawGroups) ? rawGroups.map(String) : typeof rawGroups === 'string' ? rawGroups.split(/[,\s]+/).filter(Boolean) : [];
    const mapping: { group: string; role: Role }[] = Array.isArray(cfg.group_roles) ? cfg.group_roles : [];
    const mapped = mapping.find((m) => groups.some((g) => g.toLowerCase() === String(m.group).toLowerCase()))?.role ?? null;
    const mem = await admin`select role from memberships where workspace_id = ${w.id} and user_id = ${user.id}`;
    if (!mem.length) {
      const role = mapped ?? cfg.default_role ?? 'auditor';
      await admin`insert into memberships (workspace_id, user_id, role) values (${w.id}, ${user.id}, ${role})`;
      await audit(admin, w.id, { kind: 'user', id: user.id, name: user.name }, 'member.joined', user.id, { email, role, via: 'sso_jit', matched_group: mapped ? mapping.find((m) => m.role === mapped)?.group : null });
    } else if (mapped && mapped !== mem[0].role) {
      const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${w.id} and role = 'admin' and user_id <> ${user.id}`;
      if (mapped === 'admin' || n > 0) {
        await admin`update memberships set role = ${mapped} where workspace_id = ${w.id} and user_id = ${user.id}`;
        await audit(admin, w.id, { kind: 'user', id: user.id, name: user.name }, 'member.role_changed', user.id, { role: mapped, from: mem[0].role, via: 'sso_group', groups });
      }
    }
    await audit(admin, w.id, { kind: 'user', id: user.id, name: user.name }, 'session.sso', user.id, { issuer: cfg.issuer, groups: groups.slice(0, 20) });
    const code = randomB64(24);
    await admin`insert into auth_challenges (challenge, purpose, data, expires_at) values (${code}, 'sso_code', ${JSON.stringify({ user_id: user.id, ws: w.id })}, now() + interval '2 minutes')`;
    return c.redirect(`${st.origin && allowedOrigins(c.env).includes(st.origin) ? st.origin + new URL(appUrl).pathname : appUrl}#/sso/${code}`, 302);
  } catch (e: any) {
    return fail(e instanceof ApiError ? e.message : 'Single sign-on failed. Try again.');
  }
});

pub.post('/auth/sso/exchange', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const { code } = await body(c, ssoExchangeIn);
  const rows = await admin`delete from auth_challenges where challenge = ${code} and purpose = 'sso_code' and expires_at > now() returning data`;
  if (!rows.length) throw new ApiError(400, 'sso_code_expired', 'This sign-in link expired. Start single sign-on again.');
  const token = await createSession(c as C, admin, rows[0].data.user_id, rows[0].data.ws, 'sso', 12);
  return c.json({ session_token: token, workspace_id: rows[0].data.ws });
});

// ---------- Authenticated account and organization routes ----------
export const acct = router();

acct.get('/me', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  const [w] = await admin`select id, name, kind, slug, brand_name, brand_color, created_at, expires_at, (sso->>'enabled')::boolean as sso_enabled, billing_status, verification_status, settlement_mode from workspaces where id = ${ws}`;
  if (a.kind !== 'user') return c.json({ actor: a, workspace: w });
  const [me0] = await admin`select id, email, name, title, fictional, email_verified_at, totp_enabled_at from users where id = ${a.realUserId}`;
  const { email_verified_at, totp_enabled_at, ...me } = me0;
  const orgs = await admin`select m.workspace_id, w.name, w.kind, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${a.realUserId} and (w.expires_at is null or w.expires_at > now()) order by w.name`;
  const teammates = w.kind === 'sandbox' ? await admin`select u.id, u.name, u.title, m.role from memberships m join users u on u.id = m.user_id where m.workspace_id = ${ws} and u.fictional order by u.name` : [];
  const [sess] = a.sessionId ? await admin`select method from sessions where id = ${a.sessionId}` : [null];
  return c.json({ user: me, acting_as: a.userId !== a.realUserId ? { id: a.userId, name: a.name, role: a.role } : null, role: a.role, role_label: ROLE_LABEL[a.role!], workspace: w, organizations: orgs, teammates, session_method: sess?.method ?? null, recovery_session: sess?.method === 'recovery',
    email_verified: !!email_verified_at, verification_required: verificationRequired(c.env) && w.kind === 'org' && !email_verified_at, totp_enabled: !!totp_enabled_at });
});

/** Name and email. In a sandbox, setting a real email is the first step of keeping the sandbox as an organization. */
acct.patch('/me', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in person has a profile to edit.');
  if (a.userId !== a.realUserId) throw new ApiError(403, 'acting_as', 'Switch back to yourself before editing your profile.');
  const b = await body(c, profileIn);
  if (b.email) {
    if (b.email.endsWith('.sandbox') || b.email.endsWith('.example')) throw new ApiError(422, 'real_email_required', 'Use a real email address you can receive mail at.');
    const taken = await admin`select 1 from users where email = ${b.email} and sandbox_workspace is null and id <> ${a.realUserId}`;
    if (taken.length) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Sign in with it instead.');
  }
  const [before] = await admin`select email from users where id = ${a.realUserId}`;
  const emailChanged = !!b.email && b.email !== before?.email;
  const [me] = await admin`update users set name = coalesce(${b.name ?? null}, name), email = coalesce(${b.email ?? null}, email), title = case when ${b.title !== undefined} then ${b.title ?? null} else title end,
      email_verified_at = case when ${emailChanged} then null else email_verified_at end
    where id = ${a.realUserId} returning id, email, name, title, fictional, sandbox_workspace`;
  await audit(admin, c.get('ws'), a, 'user.profile_updated', a.realUserId!, { name: b.name ?? undefined, email: b.email ?? undefined });
  if (emailChanged) {
    // A new address must be confirmed, and the old one is told, so a hijacked session cannot quietly redirect the account.
    if (deliverable(me.email)) bg(c, issueEmailVerification(c.env, admin, { id: me.id, email: me.email, name: me.name }, await ipHash(c)));
    if (before?.email && deliverable(before.email)) {
      const m = templates.securityAlert({ title: 'The email address on your Laissez account changed', lines: [`The address for ${me.name} changed from ${before.email} to ${me.email}.`, 'If you did this, no action is needed; the new address has been sent a confirmation link. If you did not, sign in and review your passkeys and sessions at once.'], link: `${c.env.APP_URL}#/settings/security` });
      bg(c, sendEmail(c.env, admin, { ws: c.get('ws'), to: before.email, kind: 'security_alert', ...m }));
    }
  }
  return c.json({ user: me, conversion_ready: !!me.sandbox_workspace && deliverable(me.email), verification_sent: emailChanged });
});

acct.post('/session/act-as', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  if (a.kind !== 'user' || !a.sessionId) throw new ApiError(403, 'human_required', 'Only a signed-in person can switch teammates.');
  if (isProduction(c.env)) throw new ApiError(403, 'sandbox_only', 'Acting as a teammate exists only in sandboxes. This deployment runs in production mode.');
  if (c.get('wsKind') !== 'sandbox') throw new ApiError(403, 'sandbox_only', 'Acting as a teammate exists only in sandboxes, to try two-person approval alone.');
  const { user_id } = await body(c, actAsIn);
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
  const { workspace_id } = await body(c, switchIn);
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
  const [peek] = await admin`select workspace_id from invites where token_hash = ${await sha256(c.req.param('token'))} and accepted_at is null and expires_at > now()`;
  if (peek) {
    const [me] = await admin`select email from users where id = ${a.realUserId}`;
    if (!emailAllowed(await policyFor(admin, peek.workspace_id), me?.email ?? '')) throw new ApiError(403, 'email_domain_not_allowed', 'This organization only accepts people with a company email address. Your address is not on its list.');
  }
  const [inv] = await admin`update invites set accepted_at = now(), accepted_by = ${a.realUserId} where token_hash = ${await sha256(c.req.param('token'))} and accepted_at is null and expires_at > now() returning workspace_id, role`;
  if (!inv) throw new ApiError(404, 'invite_invalid', 'This invite link is invalid, used or expired.');
  await admin`insert into memberships (workspace_id, user_id, role) values (${inv.workspace_id}, ${a.realUserId}, ${inv.role}) on conflict do nothing`;
  await audit(admin, inv.workspace_id, a, 'member.joined', a.realUserId!, { role: inv.role, via: 'invite' });
  await admin`update sessions set revoked_at = now() where id = ${a.sessionId}`;
  return c.json({ session_token: await createSession(c, admin, a.realUserId!, inv.workspace_id, 'invite', 24 * 7), workspace_id: inv.workspace_id });
});

// ---------- Step-up: a fresh passkey assertion for sensitive actions ----------
acct.post('/auth/step-up/options', async (c) => {
  const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Step-up confirmation is for signed-in people, not API keys.');
  const admin = c.get('admin');
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const keys = await admin`select id from passkeys where user_id = ${a.realUserId}`;
  const [ch] = await admin`insert into auth_challenges (challenge, purpose, data) values (${challenge}, 'step-up', ${JSON.stringify({ user_id: a.realUserId })}) returning id`;
  return c.json({ challenge_id: ch.id, options: { challenge, rpId, userVerification: 'preferred', timeout: 120000, allowCredentials: keys.map((k: any) => ({ id: k.id, type: 'public-key' })) } });
});
acct.post('/auth/step-up/verify', async (c) => {
  const a = c.get('actor');
  if (a.kind !== 'user' || !a.sessionId) throw new ApiError(403, 'human_required', 'Step-up confirmation is for signed-in people, not API keys.');
  const admin = c.get('admin');
  const b = await body(c, loginVerifyIn);
  if (!(await rateLimit(admin, `stepup:${a.realUserId}`, 20, 600))) throw new ApiError(429, 'rate_limited', 'Too many confirmation attempts. Wait ten minutes.');
  const rows = await admin`delete from auth_challenges where id = ${b.challenge_id} and purpose = 'step-up' and data->>'user_id' = ${a.realUserId ?? ''} and expires_at > now() returning challenge`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This confirmation request expired. Try again.');
  const cred = b.credential as AssertionResponse;
  const [pk] = await admin`select * from passkeys where id = ${cred?.id ?? ''} and user_id = ${a.realUserId}`;
  if (!pk) throw new ApiError(401, 'unknown_passkey', 'That passkey does not belong to your account.');
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const res = await verifyAssertion(cred, { public_key: pk.public_key, alg: pk.alg, sign_count: Number(pk.sign_count) }, rows[0].challenge, allowedOrigins(c.env), rpId);
  await admin`update passkeys set sign_count = ${res.counter}, last_used_at = now() where id = ${pk.id}`;
  await admin`update sessions set stepped_up_at = now() where id = ${a.sessionId}`;
  await audit(admin, c.get('ws'), a, 'auth.step_up', a.realUserId ?? null, { passkey: pk.id, user_verified: res.userVerified });
  return c.json({ ok: true, valid_for_seconds: STEP_UP_WINDOW_MS / 1000 });
});

acct.get('/sessions', async (c) => {
  const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Sessions belong to people, not API keys.');
  const rows = await c.get('admin')`select s.id, s.method, s.created_at, s.last_seen_at, s.expires_at, s.user_agent, s.country, s.city, s.browser, s.os, w.name as organization, (s.id = ${a.sessionId ?? null}) as current
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
  if (a.kind !== 'user') throw new ApiError(403, 'account_required', 'Passkeys belong to real accounts. Create an account to add one.');
  const [u] = await admin`select id, email, name from users where id = ${a.realUserId}`;
  // Sandbox guests get a passkey only once they have set a real email, which is how a sandbox becomes an organization.
  if (c.get('wsKind') === 'sandbox' && !deliverable(u?.email)) throw new ApiError(403, 'account_required', 'Passkeys belong to real accounts. Set your name and email under Organization, Keep this sandbox, then add one.');
  const existing = await admin`select id from passkeys where user_id = ${u.id}`;
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into auth_challenges (challenge, purpose, data) values (${challenge}, 'add_passkey', ${JSON.stringify({ user_id: u.id })}) returning id`;
  const uid = new Uint8Array(16); u.id.replace(/-/g, '').match(/../g)!.forEach((h: string, i: number) => (uid[i] = parseInt(h, 16)));
  return c.json({ challenge_id: ch.id, options: { challenge, rp: { name: 'Laissez', id: rpId }, user: { id: b64url(uid), name: u.email, displayName: u.name }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 120000, attestation: 'none', excludeCredentials: existing.map((p: any) => ({ type: 'public-key', id: p.id })) } });
});
acct.post('/passkeys/verify', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  const b = await body(c, passkeyVerifyIn);
  const rows = await admin`delete from auth_challenges where id = ${b.challenge_id} and purpose = 'add_passkey' and expires_at > now() returning challenge, data`;
  if (!rows.length || rows[0].data.user_id !== a.realUserId) throw new ApiError(400, 'challenge_expired', 'This request expired. Try again.');
  const pk = verifyRegistration(b.credential as RegistrationResponse, rows[0].challenge, allowedOrigins(c.env));
  await admin`insert into passkeys (id, user_id, public_key, alg, transports, name) values (${pk.credentialId}, ${a.realUserId}, ${pk.publicKey}, ${pk.alg}, ${pk.transports}, ${b.name ?? 'Passkey'})`;
  bg(c, securityAlert(c.env, admin, { userId: a.realUserId!, ws: c.get('ws'), actor: a, type: 'passkey.added', title: 'A passkey was added to your account', lines: [`A new passkey named "${b.name ?? 'Passkey'}" can now sign in to your Laissez account.`, 'If you did not add it, remove it and review your sessions at once.'], data: { name: b.name ?? 'Passkey' } }));
  return c.json({ added: pk.credentialId }, 201);
});
acct.delete('/passkeys/:id', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  const [{ n }] = await admin`select count(*)::int as n from passkeys where user_id = ${a.realUserId ?? null}`;
  if (n <= 1) throw new ApiError(422, 'last_passkey', 'This is your only passkey. Add another before removing it.');
  const r = await admin`delete from passkeys where id = ${c.req.param('id')} and user_id = ${a.realUserId ?? null} returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No passkey with that id on your account.');
  bg(c, securityAlert(c.env, admin, { userId: a.realUserId!, ws: c.get('ws'), actor: a, type: 'passkey.removed', title: 'A passkey was removed from your account', lines: ['One of the passkeys that could sign in to your Laissez account was removed.', 'If you did not remove it, review your sessions and remaining passkeys at once.'], data: { id: r[0].id } }));
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
  needStepUp(c, 'change a member');
  const admin = c.get('admin'); const ws = c.get('ws');
  const { role } = await body(c, memberRoleIn);
  if (role !== 'admin') {
    const [{ n }] = await admin`select count(*)::int as n from memberships where workspace_id = ${ws} and role = 'admin' and user_id <> ${c.req.param('id')}`;
    if (n === 0) throw new ApiError(422, 'last_admin', 'An organization needs at least one administrator.');
  }
  const r = await admin`update memberships set role = ${role} where workspace_id = ${ws} and user_id = ${c.req.param('id')} returning user_id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'That person is not a member.');
  await audit(c.get('sql'), ws, c.get('actor'), 'member.role_changed', c.req.param('id'), { role });
  bg(c, securityAlert(c.env, admin, { userId: c.req.param('id'), ws: null, type: 'member.role_changed', title: 'Your role changed', lines: [`An administrator changed your role to ${ROLE_LABEL[role]}. What you can see and do in Laissez follows the new role from your next request.`], path: '#/settings/members' }));
  return c.json({ user_id: c.req.param('id'), role });
});
acct.delete('/members/:id', async (c) => {
  need(c, 'members:admin');
  needStepUp(c, 'remove a member');
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
  const b = await body(c, inviteIn);
  if (!emailAllowed(await policyFor(c.get('admin'), ws), b.email)) throw new ApiError(422, 'invite_domain_not_allowed', 'Your security policy only allows invitations to the email domains it lists. Add the domain under Settings, Security, or invite a company address.');
  const token = `inv_${rand(32)}`;
  const [row] = await sql`insert into invites (workspace_id, email, role, token_hash, created_by) values (${ws}, ${b.email}, ${b.role}, ${await sha256(token)}, ${a.realUserId ?? null}) returning id, expires_at`;
  await audit(sql, ws, a, 'member.invited', row.id, { email: b.email, role: b.role });
  const link = `${c.env.APP_URL}#/invite/${token}`;
  const [w] = await c.get('admin')`select name, brand_name from workspaces where id = ${ws}`;
  const mail = await sendEmail(c.env, c.get('admin'), { ws, to: b.email, kind: 'invite', ...templates.invite({ org: w.brand_name || w.name, role: ROLE_LABEL[b.role], invitedBy: a.kind === 'user' ? a.name : null, link }) });
  return c.json({
    id: row.id, email: b.email, role: b.role, expires_at: row.expires_at, link, email_status: mail.status, outbox_id: mail.id,
    note: mail.status === 'sent' ? `Emailed to ${b.email}. The link works once and expires in 7 days.` : 'The invite email is in the Outbox (no mail provider is connected here). Send this link to the person yourself. It works once and expires in 7 days.',
  }, 201);
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
  const b = await body(c, organizationIn);
  if (b.settlement_mode) needStepUp(c, 'change the settlement mode');
  const [w] = await c.get('sql')`update workspaces set name = coalesce(${b.name ?? null}, name), brand_name = coalesce(${b.brand_name ?? null}, brand_name), brand_color = coalesce(${b.brand_color ?? null}, brand_color), settlement_mode = coalesce(${b.settlement_mode ?? null}, settlement_mode) where id = ${c.get('ws')} returning id, name, brand_name, brand_color, settlement_mode`;
  await audit(c.get('sql'), c.get('ws'), c.get('actor'), 'organization.updated', c.get('ws'), b);
  return c.json(w);
});
acct.get('/sso', async (c) => {
  need(c, 'read');
  const [w] = await c.get('admin')`select slug, sso from workspaces where id = ${c.get('ws')}`;
  const s = w.sso ?? null;
  return c.json({ org_slug: w.slug, redirect_uri: `${c.env.API_URL}/v1/auth/sso/callback`, config: s ? { enabled: s.enabled, label: s.label, issuer: s.issuer, client_id: s.client_id, email_domain: s.email_domain, default_role: s.default_role, demo: !!s.demo, has_secret: !!s.client_secret || !!s.demo, group_claim: s.group_claim ?? 'groups', group_roles: Array.isArray(s.group_roles) ? s.group_roles : [] } : null, start_url: `${c.env.API_URL}/v1/auth/sso/start?org=${w.slug}` });
});
acct.put('/sso', async (c) => {
  need(c, 'members:admin');
  needStepUp(c, 'change single sign-on');
  if (c.get('wsKind') === 'sandbox') throw new ApiError(403, 'sandbox_only', 'Sandboxes use the demo identity provider. Create an organization to connect your own.');
  const b = await body(c, ssoIn);
  const admin = c.get('admin'); const ws = c.get('ws');
  const [w] = await admin`select sso from workspaces where id = ${ws}`;
  const secret = b.client_secret ? await seal(c.env, b.client_secret) : w.sso?.client_secret;
  if (!secret) throw new ApiError(422, 'secret_required', 'Add the client secret from your identity provider.');
  await discover(c.env, b.issuer);
  const taken = await admin`select 1 from workspaces where kind = 'org' and id <> ${ws} and sso->>'email_domain' = ${b.email_domain} and (sso->>'enabled')::boolean`;
  if (taken.length && b.enabled) throw new ApiError(409, 'domain_taken', `Another organization already uses single sign-on for ${b.email_domain}.`);
  await admin`update workspaces set sso = ${JSON.stringify({ enabled: b.enabled, issuer: b.issuer.replace(/\/$/, ''), client_id: b.client_id, client_secret: secret, email_domain: b.email_domain, default_role: b.default_role, label: b.label ?? 'Company sign-in', group_claim: w.sso?.group_claim ?? 'groups', group_roles: w.sso?.group_roles ?? [] })} where id = ${ws}`;
  await audit(c.get('sql'), ws, c.get('actor'), 'sso.configured', ws, { issuer: b.issuer, email_domain: b.email_domain, enabled: b.enabled });
  bg(c, emailAdmins(c.env, admin, ws, 'security_alert', templates.securityAlert({ title: 'Single sign-on settings changed', lines: [`${c.get('actor').name} ${b.enabled ? 'saved and enabled' : 'saved and disabled'} single sign-on with ${b.issuer} for ${b.email_domain}.`, 'If this was not expected, review the change in Settings and the audit log.'], link: `${c.env.APP_URL}#/settings/sso`, button: 'Review single sign-on' })));
  return c.json({ saved: true });
});

export { auditQ };
