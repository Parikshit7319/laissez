// Investor portal accounts. The link a distributor sends stays the invitation; from it an investor creates an account
// with a passkey (and, if they want, an authenticator app), and from then on signs in at /portal/ without a link.
// Portal sessions are separate from staff sessions: a different token prefix (lz_ps_), a different table, no roles.
//
// Routes (public, under /v1/portal-auth):
//   POST /register/options      with the link token: WebAuthn creation options
//   POST /register/verify       with the link token: creates the account, the passkey and a session
//   POST /login/options         passkey assertion options (no token)
//   POST /login/verify          returns a portal session, or mfa_required when the account has an authenticator app
//   POST /mfa                   second factor: six-digit code
//   GET  /session               who am I, for the portal shell
//   POST /logout
//   POST /totp/setup, /totp/enable, /totp/disable   authenticator app on the account (session)
//   POST /passkeys/options, /passkeys/verify         add another passkey (session)
import { z } from 'zod';
import { router, body, audit } from '../http';
import { adminSql } from '../db';
import { type Env, ApiError, sha256, rand, randomB64, b64url, rateLimit } from '../util';
import { rpFor, verifyRegistration, verifyAssertion, type RegistrationResponse, type AssertionResponse } from '../webauthn';
import { newTotpSecret, totpUri, verifyTotp } from '../totp';
import { seal, unseal } from '../util';

export const publicRoutes = router();

const allowedOrigins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
const ipHash = async (c: any) => sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
const bearer = (c: any) => { const h = c.req.header('authorization') ?? ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
const SESSION_HOURS = 24;
const IDLE_MINUTES = 60;

/** Resolves the link token to its investor. Used for account creation only. */
async function fromLink(c: any) {
  const admin = adminSql(c.env.DATABASE_URL);
  const tok = bearer(c);
  if (!tok.startsWith('lz_inv_')) throw new ApiError(401, 'portal_unauthorized', 'Open the portal from the link your distributor sent you.');
  const [r] = await admin`select pa.workspace_id, pa.investor_id, i.name, i.email, w.name as org_name from portal_access pa join investors i on i.workspace_id = pa.workspace_id and i.id = pa.investor_id join workspaces w on w.id = pa.workspace_id
    where pa.token_hash = ${await sha256(tok)} and pa.revoked_at is null and pa.expires_at > now()`;
  if (!r) throw new ApiError(401, 'portal_link_expired', 'This portal link has expired or was withdrawn. Ask your distributor for a new link.');
  return { admin, ...r };
}

/** Resolves a portal session token (lz_ps_). Exported for the portal router, which accepts either kind of token. */
export async function portalSession(env: Env, tok: string) {
  if (!tok.startsWith('lz_ps_')) return null;
  const admin = adminSql(env.DATABASE_URL);
  const [s] = await admin`select s.id, s.account_id, s.workspace_id, s.investor_id, s.last_seen_at, s.mfa_at, a.totp_enabled_at, a.disabled_at, w.kind, i.name as inv_name
    from portal_sessions s join portal_accounts a on a.id = s.account_id join workspaces w on w.id = s.workspace_id join investors i on i.workspace_id = s.workspace_id and i.id = s.investor_id
    where s.token_hash = ${await sha256(tok)} and s.revoked_at is null and s.expires_at > now() and (w.expires_at is null or w.expires_at > now())`;
  if (!s || s.disabled_at) return null;
  if (Date.now() - new Date(s.last_seen_at).getTime() > IDLE_MINUTES * 60_000) { await admin`update portal_sessions set revoked_at = now() where id = ${s.id}`; return null; }
  if (s.totp_enabled_at && !s.mfa_at) return { ...s, mfa_pending: true };
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) await admin`update portal_sessions set last_seen_at = now() where id = ${s.id}`;
  return { ...s, mfa_pending: false };
}

async function newSession(admin: any, account: { id: string; workspace_id: string; investor_id: string }, mfaDone: boolean) {
  const token = `lz_ps_${rand(40)}`;
  await admin`insert into portal_sessions (token_hash, account_id, workspace_id, investor_id, expires_at, mfa_at) values (${await sha256(token)}, ${account.id}, ${account.workspace_id}, ${account.investor_id}, now() + make_interval(hours => ${SESSION_HOURS}), ${mfaDone ? new Date() : null})`;
  await admin`update portal_accounts set last_login_at = now() where id = ${account.id}`;
  return token;
}

const credIn = z.object({ challenge_id: z.string().uuid(), credential: z.any() });

// ---------- Account creation from the link ----------
publicRoutes.post('/register/options', async (c) => {
  const { admin, workspace_id, investor_id, name, email } = await fromLink(c);
  const [existing] = await admin`select id from portal_accounts where workspace_id = ${workspace_id} and investor_id = ${investor_id}`;
  if (existing) throw new ApiError(409, 'account_exists', 'This client already has a portal account. Sign in with the passkey instead.');
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into portal_challenges (challenge, purpose, data) values (${challenge}, 'register', ${JSON.stringify({ workspace_id, investor_id })}) returning id`;
  const uid = crypto.getRandomValues(new Uint8Array(16));
  return c.json({ challenge_id: ch.id, options: {
    challenge, rp: { name: 'Laissez investor portal', id: rpId }, user: { id: b64url(uid), name: email || investor_id, displayName: name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 120000, attestation: 'none',
  } });
});

publicRoutes.post('/register/verify', async (c) => {
  const { admin, workspace_id, investor_id, name, email } = await fromLink(c);
  const b = await body(c, credIn);
  const rows = await admin`delete from portal_challenges where id = ${b.challenge_id} and purpose = 'register' and expires_at > now() returning challenge, data`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This request expired. Start again.');
  if (rows[0].data?.investor_id !== investor_id) throw new ApiError(400, 'challenge_expired', 'This request belongs to a different link. Start again.');
  const pk = verifyRegistration(b.credential as RegistrationResponse, rows[0].challenge, allowedOrigins(c.env));
  const [acct] = await admin`insert into portal_accounts (workspace_id, investor_id, email, created_by) values (${workspace_id}, ${investor_id}, ${email ?? ''}, 'portal-link') on conflict (workspace_id, investor_id) do nothing returning id`;
  if (!acct) throw new ApiError(409, 'account_exists', 'This client already has a portal account. Sign in with the passkey instead.');
  await admin`insert into portal_passkeys (id, account_id, public_key, alg, transports, label) values (${pk.credentialId}, ${acct.id}, ${pk.publicKey}, ${pk.alg}, ${pk.transports}, 'First passkey')`;
  const token = await newSession(admin, { id: acct.id, workspace_id, investor_id }, true);
  await audit(admin, workspace_id, { kind: 'investor', id: investor_id, name: `${name} (investor portal)` } as any, 'portal.account_created', investor_id, { passkey: pk.credentialId });
  return c.json({ session_token: token, account_id: acct.id }, 201);
});

// ---------- Sign-in with a passkey, then an optional second factor ----------
publicRoutes.post('/login/options', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await admin`insert into portal_challenges (challenge, purpose) values (${challenge}, 'login') returning id`;
  return c.json({ challenge_id: ch.id, options: { challenge, rpId, userVerification: 'preferred', timeout: 120000, allowCredentials: [] } });
});

publicRoutes.post('/login/verify', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, credIn);
  if (!(await rateLimit(admin, `portal-login:${await ipHash(c)}`, 30, 600))) throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Wait ten minutes.');
  const rows = await admin`delete from portal_challenges where id = ${b.challenge_id} and purpose = 'login' and expires_at > now() returning challenge`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This sign-in request expired. Try again.');
  const cred = b.credential as AssertionResponse;
  const [pk] = await admin`select p.*, a.workspace_id, a.investor_id, a.totp_enabled_at, a.disabled_at from portal_passkeys p join portal_accounts a on a.id = p.account_id where p.id = ${cred?.id ?? ''}`;
  if (!pk) throw new ApiError(401, 'unknown_passkey', 'This passkey is not registered with the portal. Open the link your distributor sent to create your account.');
  if (pk.disabled_at) throw new ApiError(403, 'account_disabled', 'This portal account was disabled by your distributor.');
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const res = await verifyAssertion(cred, { public_key: pk.public_key, alg: pk.alg, sign_count: Number(pk.sign_count) }, rows[0].challenge, allowedOrigins(c.env), rpId);
  await admin`update portal_passkeys set sign_count = ${res.counter}, last_used_at = now() where id = ${pk.id}`;
  const token = await newSession(admin, { id: pk.account_id, workspace_id: pk.workspace_id, investor_id: pk.investor_id }, !pk.totp_enabled_at);
  return c.json({ session_token: token, mfa_required: !!pk.totp_enabled_at });
});

publicRoutes.post('/mfa', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const tok = bearer(c);
  const [s] = tok.startsWith('lz_ps_') ? await admin`select s.id, s.account_id, a.totp_secret, a.totp_last_step from portal_sessions s join portal_accounts a on a.id = s.account_id where s.token_hash = ${await sha256(tok)} and s.revoked_at is null and s.expires_at > now()` : [];
  if (!s) throw new ApiError(401, 'portal_unauthorized', 'Sign in with your passkey first.');
  if (!(await rateLimit(admin, `portal-mfa:${s.id}`, 8, 600))) throw new ApiError(429, 'rate_limited', 'Too many codes. Wait ten minutes.');
  const { code } = await body(c, z.object({ code: z.string().regex(/^\d{6}$/) }));
  const step = s.totp_secret ? await verifyTotp(await unseal(c.env, s.totp_secret), code, Date.now(), s.totp_last_step ? Number(s.totp_last_step) : null) : null;
  if (step === null) throw new ApiError(401, 'bad_code', 'That code is not right, or was already used. Open your authenticator app and try the current one.');
  await admin`update portal_accounts set totp_last_step = ${step} where id = ${s.account_id}`;
  await admin`update portal_sessions set mfa_at = now() where id = ${s.id}`;
  return c.json({ ok: true });
});

// ---------- Session routes ----------
async function requireSession(c: any) {
  const s = await portalSession(c.env, bearer(c));
  if (!s) throw new ApiError(401, 'portal_unauthorized', 'Sign in with your passkey first.');
  if (s.mfa_pending) throw new ApiError(403, 'mfa_required', 'Enter the code from your authenticator app to finish signing in.');
  return { admin: adminSql(c.env.DATABASE_URL), ...s };
}

publicRoutes.get('/session', async (c) => {
  const s = await portalSession(c.env, bearer(c));
  if (!s) throw new ApiError(401, 'portal_unauthorized', 'Sign in with your passkey first.');
  const admin = adminSql(c.env.DATABASE_URL);
  const keys = await admin`select id, label, created_at, last_used_at from portal_passkeys where account_id = ${s.account_id} order by created_at`;
  return c.json({ investor_id: s.investor_id, name: s.inv_name, mfa_pending: s.mfa_pending, totp_enabled: !!s.totp_enabled_at, passkeys: keys });
});

publicRoutes.post('/logout', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const tok = bearer(c);
  if (tok.startsWith('lz_ps_')) await admin`update portal_sessions set revoked_at = now() where token_hash = ${await sha256(tok)}`;
  return c.json({ signed_out: true });
});

publicRoutes.post('/totp/setup', async (c) => {
  const s = await requireSession(c);
  const secret = newTotpSecret();
  await s.admin`update portal_accounts set totp_secret = ${await seal(c.env, secret)}, totp_enabled_at = null where id = ${s.account_id}`;
  return c.json({ secret, uri: totpUri(secret, s.inv_name, 'Laissez investor portal') });
});

publicRoutes.post('/totp/enable', async (c) => {
  const s = await requireSession(c);
  const { code } = await body(c, z.object({ code: z.string().regex(/^\d{6}$/) }));
  const [a] = await s.admin`select totp_secret from portal_accounts where id = ${s.account_id}`;
  if (!a?.totp_secret) throw new ApiError(409, 'totp_not_set_up', 'Set up the authenticator app first.');
  const step = await verifyTotp(await unseal(c.env, a.totp_secret), code);
  if (step === null) throw new ApiError(401, 'bad_code', 'That code is not right. Check the time on your phone and try the current code.');
  await s.admin`update portal_accounts set totp_enabled_at = now(), totp_last_step = ${step} where id = ${s.account_id}`;
  await s.admin`update portal_sessions set mfa_at = now() where id = ${s.id}`;
  await audit(s.admin, s.workspace_id, { kind: 'investor', id: s.investor_id, name: `${s.inv_name} (investor portal)` } as any, 'portal.totp_enabled', s.investor_id, {});
  return c.json({ enabled: true });
});

publicRoutes.post('/totp/disable', async (c) => {
  const s = await requireSession(c);
  const { code } = await body(c, z.object({ code: z.string().regex(/^\d{6}$/) }));
  const [a] = await s.admin`select totp_secret, totp_last_step from portal_accounts where id = ${s.account_id}`;
  const step = a?.totp_secret ? await verifyTotp(await unseal(c.env, a.totp_secret), code, Date.now(), a.totp_last_step ? Number(a.totp_last_step) : null) : null;
  if (step === null) throw new ApiError(401, 'bad_code', 'Enter a current code from the app to turn it off.');
  await s.admin`update portal_accounts set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = ${s.account_id}`;
  await audit(s.admin, s.workspace_id, { kind: 'investor', id: s.investor_id, name: `${s.inv_name} (investor portal)` } as any, 'portal.totp_disabled', s.investor_id, {});
  return c.json({ enabled: false });
});

publicRoutes.post('/passkeys/options', async (c) => {
  const s = await requireSession(c);
  const challenge = randomB64(32);
  const { rpId } = rpFor(c.req.header('origin'), allowedOrigins(c.env));
  const [ch] = await s.admin`insert into portal_challenges (challenge, purpose, data) values (${challenge}, 'add-passkey', ${JSON.stringify({ account_id: s.account_id })}) returning id`;
  const uid = crypto.getRandomValues(new Uint8Array(16));
  return c.json({ challenge_id: ch.id, options: {
    challenge, rp: { name: 'Laissez investor portal', id: rpId }, user: { id: b64url(uid), name: s.investor_id, displayName: s.inv_name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, timeout: 120000, attestation: 'none',
  } });
});

publicRoutes.post('/passkeys/verify', async (c) => {
  const s = await requireSession(c);
  const b = await body(c, credIn.extend({ label: z.string().trim().max(60).optional() }));
  const rows = await s.admin`delete from portal_challenges where id = ${b.challenge_id} and purpose = 'add-passkey' and data->>'account_id' = ${s.account_id} and expires_at > now() returning challenge`;
  if (!rows.length) throw new ApiError(400, 'challenge_expired', 'This request expired. Try again.');
  const pk = verifyRegistration(b.credential as RegistrationResponse, rows[0].challenge, allowedOrigins(c.env));
  await s.admin`insert into portal_passkeys (id, account_id, public_key, alg, transports, label) values (${pk.credentialId}, ${s.account_id}, ${pk.publicKey}, ${pk.alg}, ${pk.transports}, ${b.label ?? 'Passkey'})`;
  return c.json({ id: pk.credentialId }, 201);
});
