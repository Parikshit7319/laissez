// Account security: email confirmation, recovery by email, authenticator app, organization security policy,
// organization verification, and a person's own data export and deletion.
//   publicRoutes  mounted before authentication (confirm an address, recover access, client config)
//   routes        authenticated
import { z } from 'zod';
import { adminSql } from '../db';
import { type C, router, body, need, bg, audit, needStepUp } from '../http';
import { ApiError, rand, sha256, rateLimit, unseal, seal, requestGeo, parseUa, today } from '../util';
import { isProduction, mode } from '../mode';
import { sendEmail, emailAdmins, templates, deliverable } from '../email';
import { createSession, assertSignInAllowed, policyFor } from '../auth';
import { TERMS_VERSION, mailConfigured, verificationRequired, recoveryWaitMinutes, verifyTurnstile, issueEmailVerification, securityAlert } from '../account-security';
import { newTotpSecret, totpUri, verifyTotp } from '../totp';
import { policyIn, effectivePolicy, networkAllowed, emailAllowed, isDefaultPolicy } from '../security-policy';
import { screenNames } from '../sanctions';

export const routes = router();
export const publicRoutes = router();

const ipHash = async (c: C) => sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
const emailZ = z.string().trim().toLowerCase().email().max(160);

// Request bodies, exported so the OpenAPI document derives its schemas from them.
export const tokenIn = z.object({ token: z.string().min(20).max(200) });
export const recoverStartIn = z.object({ email: emailZ, turnstile_token: z.string().max(2048).optional() });
export const recoverCompleteIn = z.object({ code: z.string().max(12).optional() });
export const codeIn = z.object({ code: z.string().min(6).max(12) });
export const verificationIn = z.object({
  legal_name: z.string().trim().min(2).max(160),
  entity_type: z.enum(['bank', 'asset_manager', 'broker_dealer', 'transfer_agent', 'fund_administrator', 'fintech', 'other']),
  registration_number: z.string().trim().min(2).max(60),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as US'),
  regulator: z.string().trim().max(120).optional(),
  license_number: z.string().trim().max(80).optional(),
  website: z.string().trim().url().max(200).optional(),
  address: z.string().trim().min(5).max(300),
  contact_name: z.string().trim().min(2).max(80),
  contact_email: emailZ,
  use_case: z.string().trim().min(20, 'Describe what you will use Laissez for in a sentence or two').max(1500),
  expected_annual_volume_usd: z.number().min(0).max(1e13).optional(),
  attest: z.literal(true, { message: 'Confirm that the details are accurate and that you may act for this organization' }),
});
export const deleteAccountIn = z.object({ confirm_email: emailZ });

const mask = (email: string) => { const [l, d] = email.split('@'); return `${l.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(6, l.length - 1)))}@${d}`; };

// =============================================================================================================
// Public
// =============================================================================================================
publicRoutes.get('/auth/config', (c) => c.json({
  mode: mode(c.env),
  turnstile_site_key: c.env.TURNSTILE_SECRET && c.env.TURNSTILE_SITE_KEY ? c.env.TURNSTILE_SITE_KEY : null,
  verification_required: verificationRequired(c.env),
  signup_open: !(isProduction(c.env) && !mailConfigured(c.env)),
  terms_version: TERMS_VERSION,
  recovery_wait_minutes: recoveryWaitMinutes(c.env),
}));

publicRoutes.post('/auth/verify-email', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  if (!(await rateLimit(admin, `verify:${await ipHash(c)}`, 30, 600))) throw new ApiError(429, 'rate_limited', 'Too many attempts. Wait ten minutes.');
  const { token } = await body(c, tokenIn);
  const [t] = await admin`update email_tokens set used_at = now() where token_hash = ${await sha256(token)} and purpose = 'verify' and used_at is null and cancelled_at is null and expires_at > now() returning user_id, email`;
  if (!t) throw new ApiError(400, 'verify_link_invalid', 'This confirmation link is invalid, already used or expired. Sign in and ask for a new one.');
  const [u] = await admin`update users set email_verified_at = now() where id = ${t.user_id} and email = ${t.email} returning id, name, email`;
  if (!u) throw new ApiError(409, 'verify_email_changed', 'The address on the account changed after this link was sent. Use the newest link.');
  for (const m of await admin`select workspace_id from memberships where user_id = ${u.id}`) await audit(admin, m.workspace_id, { kind: 'user', id: u.id, name: u.name }, 'user.email_verified', u.id, { email: u.email });
  return c.json({ verified: true, email: u.email });
});

// ---------- Recovery by email ----------
// The answer never says whether an address has an account. The work happens after the response, so timing does not either.
publicRoutes.post('/auth/recover/start', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, recoverStartIn);
  if (!(await rateLimit(admin, `recover-ip:${await ipHash(c)}`, 6, 3600))) throw new ApiError(429, 'rate_limited', 'Too many recovery requests from this network. Try again in an hour.');
  if (!(await rateLimit(admin, `recover-mail:${await sha256(b.email)}`, 3, 3600))) throw new ApiError(429, 'rate_limited', 'Recovery was requested for this address three times in the last hour. Use the link in the newest email, or try again later.');
  await verifyTurnstile(c.env, b.turnstile_token, c.req.header('cf-connecting-ip'));
  const baseWait = recoveryWaitMinutes(c.env);
  const ip = await ipHash(c);
  const ua = (c.req.header('user-agent') ?? '').slice(0, 200);
  const { country } = requestGeo(c.req.raw, (n) => c.req.header(n));
  const work = async () => {
    const [u] = await admin`select id, name, email, totp_enabled_at from users where email = ${b.email} and sandbox_workspace is null and not fictional`;
    if (!u || !deliverable(u.email)) return;
    const wait = u.totp_enabled_at ? 0 : baseWait;
    await admin`update email_tokens set cancelled_at = now() where user_id = ${u.id} and purpose = 'recovery' and used_at is null and cancelled_at is null`;
    const token = `rec_${rand(40)}`;
    const [row] = await admin`insert into email_tokens (token_hash, user_id, email, purpose, available_at, expires_at, ip_hash)
      values (${await sha256(token)}, ${u.id}, ${u.email}, 'recovery', now() + make_interval(mins => ${wait}), now() + make_interval(mins => ${wait}) + interval '24 hours', ${ip}) returning available_at`;
    const { browser, os } = parseUa(ua);
    const m = templates.recovery({ name: u.name, link: `${c.env.APP_URL}#/recover/${token}`, cancelLink: `${c.env.APP_URL}#/recover/${token}/cancel`, waitMinutes: wait, needsCode: !!u.totp_enabled_at, browser, os, country, availableAt: new Date(row.available_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' });
    await sendEmail(c.env, admin, { ws: null, to: u.email, kind: 'recovery', ...m });
    for (const mb of await admin`select workspace_id from memberships where user_id = ${u.id}`) await audit(admin, mb.workspace_id, { kind: 'user', id: u.id, name: u.name }, 'account.recovery_requested', u.id, { wait_minutes: wait, country, browser, os });
  };
  bg(c, work());
  return c.json({ requested: true, wait_minutes: baseWait, message: 'If an account uses that address, a recovery email is on its way. Open the link in it to continue.' }, 202);
});

async function loadRecovery(admin: ReturnType<typeof adminSql>, token: string) {
  const [t] = await admin`select t.id, t.user_id, t.available_at, t.expires_at, t.used_at, t.cancelled_at, u.name, u.email, u.totp_secret, u.totp_enabled_at, u.totp_last_step
    from email_tokens t join users u on u.id = t.user_id where t.token_hash = ${await sha256(token)} and t.purpose = 'recovery'`;
  if (!t) throw new ApiError(404, 'recovery_link_invalid', 'This recovery link is not valid. Ask for a new one from the sign-in screen.');
  return t;
}
const recoveryState = (t: any) => (t.used_at ? 'used' : t.cancelled_at ? 'cancelled' : new Date(t.expires_at).getTime() < Date.now() ? 'expired' : new Date(t.available_at).getTime() > Date.now() ? 'waiting' : 'ready');

publicRoutes.get('/auth/recover/:token', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  if (!(await rateLimit(admin, `recover-get:${await ipHash(c)}`, 60, 600))) throw new ApiError(429, 'rate_limited', 'Too many attempts. Wait ten minutes.');
  const t = await loadRecovery(admin, c.req.param('token'));
  return c.json({ state: recoveryState(t), available_at: t.available_at, expires_at: t.expires_at, needs_code: !!t.totp_enabled_at, email: mask(t.email), name: t.name });
});

publicRoutes.post('/auth/recover/:token/complete', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, recoverCompleteIn);
  const tokenParam = c.req.param('token');
  if (!(await rateLimit(admin, `recover-try-ip:${await ipHash(c)}`, 20, 600)) || !(await rateLimit(admin, `recover-try:${await sha256(tokenParam)}`, 8, 600))) throw new ApiError(429, 'rate_limited', 'Too many attempts on this recovery link. Wait ten minutes.');
  const t = await loadRecovery(admin, tokenParam);
  const state = recoveryState(t);
  if (state === 'cancelled') throw new ApiError(410, 'recovery_cancelled', 'This recovery request was cancelled. Ask for a new one if you still need it.');
  if (state === 'used') throw new ApiError(410, 'recovery_used', 'This recovery link was already used. Ask for a new one if you still need it.');
  if (state === 'expired') throw new ApiError(410, 'recovery_expired', 'This recovery link expired. Ask for a new one from the sign-in screen.');
  if (state === 'waiting') throw new ApiError(403, 'recovery_waiting', `The waiting period is not over. This link opens at ${new Date(t.available_at).toISOString()}.`, { available_at: t.available_at });
  let step: number | null = null;
  if (t.totp_enabled_at) {
    if (!b.code) throw new ApiError(422, 'totp_required', 'Enter the six-digit code from your authenticator app.');
    step = await verifyTotp(await unseal(c.env, t.totp_secret), b.code, Date.now(), t.totp_last_step === null ? null : Number(t.totp_last_step));
    if (step === null) throw new ApiError(400, 'totp_invalid', 'That code is not right or was already used. Wait for the next code and try again.');
  }
  const orgs = await admin`select m.workspace_id, w.name, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${t.user_id} and (w.expires_at is null or w.expires_at > now()) order by m.created_at desc`;
  if (!orgs.length) throw new ApiError(403, 'no_organization', 'Your account is not a member of any organization. Ask an administrator for an invite.');
  let chosen: any = null; let firstErr: unknown = null;
  for (const o of orgs) {
    try { await assertSignInAllowed(c as C, admin, { userId: t.user_id, ws: o.workspace_id, role: o.role, method: 'recovery' }); chosen = o; break; }
    catch (e) { firstErr ??= e; }
  }
  if (!chosen) throw firstErr;
  const used = await admin`update email_tokens set used_at = now() where id = ${t.id} and used_at is null and cancelled_at is null returning id`;
  if (!used.length) throw new ApiError(410, 'recovery_used', 'This recovery link was already used. Ask for a new one if you still need it.');
  await admin`update users set email_verified_at = coalesce(email_verified_at, now()), totp_last_step = coalesce(${step}, totp_last_step) where id = ${t.user_id}`;
  // Whoever held the old sessions may be the reason recovery was needed: end them all.
  await admin`update sessions set revoked_at = now() where user_id = ${t.user_id} and revoked_at is null`;
  const session = await createSession(c as C, admin, t.user_id, chosen.workspace_id, 'recovery', 2);
  for (const o of orgs) await audit(admin, o.workspace_id, { kind: 'user', id: t.user_id, name: t.name }, 'account.recovery_used', t.user_id, { second_factor: t.totp_enabled_at ? 'totp' : null });
  bg(c, securityAlert(c.env, admin, { userId: t.user_id, ws: null, type: 'account.recovery_used', title: 'Your account was recovered by email', lines: ['The recovery link for your Laissez account was used and every other session was signed out.', 'The recovery session lasts two hours and can only add a passkey. If this was not you, contact us at once.'] }));
  return c.json({ session_token: session, workspace_id: chosen.workspace_id, recovery_session: true, expires_in_hours: 2, note: 'You are signed in only far enough to add a passkey. Add one now, then sign in with it.' });
});

publicRoutes.post('/auth/recover/:token/cancel', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  if (!(await rateLimit(admin, `recover-cancel:${await ipHash(c)}`, 20, 600))) throw new ApiError(429, 'rate_limited', 'Too many attempts. Wait ten minutes.');
  const t = await loadRecovery(admin, c.req.param('token'));
  const r = await admin`update email_tokens set cancelled_at = now() where id = ${t.id} and used_at is null and cancelled_at is null returning id`;
  if (!r.length) return c.json({ cancelled: false, state: recoveryState(t) });
  for (const o of await admin`select workspace_id from memberships where user_id = ${t.user_id}`) await audit(admin, o.workspace_id, { kind: 'user', id: t.user_id, name: t.name }, 'account.recovery_cancelled', t.user_id, {});
  return c.json({ cancelled: true, state: 'cancelled' });
});

// =============================================================================================================
// Authenticated
// =============================================================================================================
routes.post('/auth/verify-email/resend', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in person has an email address to confirm.');
  const [u] = await admin`select id, email, name, email_verified_at from users where id = ${a.realUserId}`;
  if (u.email_verified_at) return c.json({ verified: true, sent: false, dev_link: null });
  if (!deliverable(u.email)) throw new ApiError(422, 'real_email_required', 'Set a real email address you can receive mail at first.');
  if (!(await rateLimit(admin, `verify-resend:${u.id}`, 5, 3600))) throw new ApiError(429, 'rate_limited', 'You asked for five confirmation emails in the last hour. Use the newest one, or try again later.');
  const v = await issueEmailVerification(c.env, admin, u, await ipHash(c));
  return c.json({ verified: false, sent: v.sent, dev_link: v.dev_link });
});

routes.get('/account/security', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Security settings belong to people, not API keys.');
  const [u] = await admin`select email, email_verified_at, totp_enabled_at, terms_accepted_at, terms_version from users where id = ${a.realUserId}`;
  const [n] = await admin`select (select count(*)::int from passkeys where user_id = ${a.realUserId}) as passkeys, (select count(*)::int from sessions where user_id = ${a.realUserId} and revoked_at is null and expires_at > now()) as sessions`;
  const [w] = await admin`select kind, security_policy from workspaces where id = ${ws}`;
  return c.json({
    email: u.email, email_verified: !!u.email_verified_at, email_verification_required: verificationRequired(c.env),
    totp: { enabled: !!u.totp_enabled_at, enabled_at: u.totp_enabled_at },
    passkeys: n.passkeys, sessions: n.sessions,
    terms: { accepted_at: u.terms_accepted_at, accepted_version: u.terms_version, current_version: TERMS_VERSION },
    recovery: { by_email: deliverable(u.email), wait_minutes: u.totp_enabled_at ? 0 : recoveryWaitMinutes(c.env), second_factor: u.totp_enabled_at ? 'totp' : null },
    organization_policy: w.kind === 'org' ? effectivePolicy(w.security_policy) : null,
  });
});

// ---------- Authenticator app ----------
routes.post('/account/totp/setup', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user' || a.userId !== a.realUserId) throw new ApiError(403, 'human_required', 'Only you can set up your own authenticator app.');
  const [u] = await admin`select id, email, totp_enabled_at from users where id = ${a.realUserId}`;
  if (!deliverable(u.email)) throw new ApiError(403, 'account_required', 'An authenticator app belongs to a real account. Set a real email address first.');
  if (u.totp_enabled_at) throw new ApiError(409, 'totp_already_enabled', 'An authenticator app is already set up. Turn it off first to set up a new one.');
  const secret = newTotpSecret();
  await admin`update users set totp_secret = ${await seal(c.env, secret)}, totp_last_step = null where id = ${u.id}`;
  return c.json({ secret, uri: totpUri(secret, u.email), digits: 6, period_seconds: 30, note: 'Add the key to an authenticator app, then confirm with the six-digit code it shows. It is not active until you confirm.' }, 201);
});
routes.post('/account/totp/enable', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  if (a.kind !== 'user' || a.userId !== a.realUserId) throw new ApiError(403, 'human_required', 'Only you can set up your own authenticator app.');
  const { code } = await body(c, codeIn);
  if (!(await rateLimit(admin, `totp-enable:${a.realUserId}`, 10, 600))) throw new ApiError(429, 'rate_limited', 'Too many wrong codes. Wait ten minutes.');
  const [u] = await admin`select id, totp_secret, totp_enabled_at from users where id = ${a.realUserId}`;
  if (u.totp_enabled_at) throw new ApiError(409, 'totp_already_enabled', 'The authenticator app is already on.');
  if (!u.totp_secret) throw new ApiError(409, 'totp_not_started', 'Start setup first to get a key.');
  const step = await verifyTotp(await unseal(c.env, u.totp_secret), code);
  if (step === null) throw new ApiError(400, 'totp_invalid', 'That code is not right. Check the time on your phone and try the next code.');
  await admin`update users set totp_enabled_at = now(), totp_last_step = ${step} where id = ${u.id}`;
  bg(c, securityAlert(c.env, admin, { userId: u.id, ws, actor: a, type: 'totp.enabled', title: 'An authenticator app was added to your account', lines: ['An authenticator app now protects account recovery: recovering access by email also needs its six-digit code, and the waiting period is waived.', 'If you did not do this, sign in and turn it off, then review your sessions.'] }));
  return c.json({ enabled: true });
});
routes.post('/account/totp/disable', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor'); const ws = c.get('ws');
  if (a.kind !== 'user' || a.userId !== a.realUserId) throw new ApiError(403, 'human_required', 'Only you can turn off your own authenticator app.');
  const { code } = await body(c, codeIn);
  if (!(await rateLimit(admin, `totp-disable:${a.realUserId}`, 10, 600))) throw new ApiError(429, 'rate_limited', 'Too many wrong codes. Wait ten minutes.');
  const [u] = await admin`select id, totp_secret, totp_enabled_at, totp_last_step from users where id = ${a.realUserId}`;
  if (!u.totp_enabled_at) throw new ApiError(409, 'totp_not_enabled', 'No authenticator app is set up.');
  const step = await verifyTotp(await unseal(c.env, u.totp_secret), code, Date.now(), u.totp_last_step === null ? null : Number(u.totp_last_step));
  if (step === null) throw new ApiError(400, 'totp_invalid', 'That code is not right or was already used. Wait for the next code and try again.');
  await admin`update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = ${u.id}`;
  bg(c, securityAlert(c.env, admin, { userId: u.id, ws, actor: a, type: 'totp.disabled', title: 'The authenticator app was removed from your account', lines: ['Account recovery by email no longer needs an authenticator code and is subject to the waiting period again.', 'If you did not do this, sign in and review your sessions and passkeys at once.'] }));
  return c.json({ enabled: false });
});

// ---------- Organization security policy ----------
routes.get('/security-policy', async (c) => {
  need(c, 'read');
  const [w] = await c.get('admin')`select kind, security_policy, (sso->>'enabled')::boolean as sso_enabled from workspaces where id = ${c.get('ws')}`;
  const policy = effectivePolicy(w.kind === 'org' ? w.security_policy : null);
  return c.json({ policy, defaults: policyIn.parse({}), is_default: isDefaultPolicy(policy), applies: w.kind === 'org', sso_enabled: !!w.sso_enabled, your_network: c.req.header('cf-connecting-ip') ?? null });
});
routes.put('/security-policy', async (c) => {
  need(c, 'members:admin');
  needStepUp(c, 'change the security policy');
  const admin = c.get('admin'); const ws = c.get('ws'); const a = c.get('actor');
  const [w] = await admin`select kind, security_policy, (sso->>'enabled')::boolean as sso_enabled from workspaces where id = ${ws}`;
  if (w.kind !== 'org') throw new ApiError(403, 'sandbox_only', 'Security policies apply to organizations. Sandboxes keep the defaults.');
  const next = await body(c, policyIn);
  const before = effectivePolicy(w.security_policy);
  const ip = c.req.header('cf-connecting-ip') ?? '';
  if (!networkAllowed(next, ip)) throw new ApiError(422, 'policy_locks_you_out', `This allowlist does not include your own address (${ip || 'unknown'}), so saving it would lock you out. Add your network first.`);
  const [me] = await admin`select email from users where id = ${a.realUserId ?? null}`;
  if (me && !emailAllowed(next, me.email)) throw new ApiError(422, 'policy_locks_you_out', `The allowed email domains do not include yours (${me.email.split('@')[1]}). Add it first.`);
  if (next.require_sso && !w.sso_enabled) throw new ApiError(422, 'sso_not_enabled', 'Turn on single sign-on for this organization before requiring it.');
  await admin`update workspaces set security_policy = ${JSON.stringify(next)} where id = ${ws}`;
  // A shorter session lifetime applies to sessions that already exist, not only to new ones.
  const shortened = await admin`update sessions set expires_at = least(expires_at, created_at + make_interval(hours => ${next.session_hours})) where workspace_id = ${ws} and revoked_at is null and expires_at > now() + make_interval(hours => ${next.session_hours}) returning id`;
  await audit(c.get('sql'), ws, a, 'security.policy_updated', ws, { before, after: next, sessions_shortened: shortened.length });
  bg(c, emailAdmins(c.env, admin, ws, 'security_alert', templates.securityAlert({ title: 'The organization security policy changed', lines: [`${a.name} changed the sign-in policy: ${next.require_sso ? 'single sign-on required, ' : ''}${next.require_user_verification ? 'verified passkeys required, ' : ''}sessions last ${next.session_hours} hours with a ${next.idle_minutes} minute idle timeout${next.allowed_email_domains.length ? `, email limited to ${next.allowed_email_domains.join(', ')}` : ''}${next.session_ip_allowlist.length ? `, ${next.session_ip_allowlist.length} approved network${next.session_ip_allowlist.length === 1 ? '' : 's'}` : ''}.`], link: `${c.env.APP_URL}#/settings/security`, button: 'Review the policy' })));
  return c.json({ policy: next, sessions_shortened: shortened.length });
});

// ---------- Organization verification ----------
routes.get('/organization/verification', async (c) => {
  need(c, 'read');
  const [w] = await c.get('admin')`select kind, verification_status, verification_profile, verification_note, verification_submitted_at, verified_at from workspaces where id = ${c.get('ws')}`;
  const profile = w.verification_profile ? { ...w.verification_profile, screening: undefined } : null;
  return c.json({ status: w.kind === 'org' ? w.verification_status : 'not_applicable', required: isProduction(c.env) && w.kind === 'org', profile, note: w.verification_note, submitted_at: w.verification_submitted_at, verified_at: w.verified_at });
});
routes.put('/organization/verification', async (c) => {
  need(c, 'members:admin');
  const admin = c.get('admin'); const ws = c.get('ws'); const a = c.get('actor');
  const [w] = await admin`select name, kind, verification_status from workspaces where id = ${ws}`;
  if (w.kind !== 'org') throw new ApiError(403, 'sandbox_only', 'Verification applies to organizations. Sandboxes are fictional and need none.');
  if (w.verification_status === 'verified') throw new ApiError(409, 'already_verified', 'This organization is verified. Contact support to change its legal details.');
  const { attest, ...profile } = await body(c, verificationIn);
  void attest;
  // The legal name is screened against the loaded sanctions lists. A hit does not refuse the form; it goes to the reviewer.
  const hits = await screenNames(c.get('sql'), ws, [profile.legal_name]).catch(() => ({} as Record<string, unknown>));
  const screening = hits[profile.legal_name] ?? null;
  await admin`update workspaces set verification_status = 'pending', verification_profile = ${JSON.stringify({ ...profile, screening, submitted_by: a.name })}, verification_note = null, verification_submitted_at = now() where id = ${ws}`;
  await audit(c.get('sql'), ws, a, 'organization.verification_submitted', ws, { legal_name: profile.legal_name, country: profile.country, entity_type: profile.entity_type, screening_hit: !!screening });
  const staff = c.env.STAFF_EMAIL || (c.env as any).LEADS_EMAIL || 'parikshit.ambhore@rice.edu';
  bg(c, sendEmail(c.env, admin, { ws, to: staff, kind: 'security_alert', ...templates.securityAlert({ title: `Verification to review: ${profile.legal_name}`, lines: [`${a.name} submitted ${profile.legal_name} (${profile.entity_type}, ${profile.country}, registration ${profile.registration_number}) for verification.`, screening ? 'The legal name matched a sanctions list entry. Review before approving.' : 'The legal name did not match any loaded sanctions list.', `Workspace ${ws}. Decide with: node scripts/staff.mjs verification decide ${ws} approve|reject`], link: `${c.env.APP_URL}#/settings/verification`, button: 'Open the organization' }) }));
  return c.json({ status: 'pending', submitted_at: new Date().toISOString(), note: 'Submitted. Someone at Laissez reviews it, usually within one business day, and you get an email either way.' });
});

// ---------- A person's own data: export and deletion ----------
routes.get('/account/export', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user' || a.userId !== a.realUserId) throw new ApiError(403, 'human_required', 'Only you can export your own data.');
  const id = a.realUserId!;
  const [u] = await admin`select id, email, name, title, created_at, last_login_at, email_verified_at, terms_accepted_at, terms_version, totp_enabled_at from users where id = ${id}`;
  const [memberships, passkeys, sessions, events, tokens] = await Promise.all([
    admin`select m.workspace_id, w.name as organization, m.role, m.created_at from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${id}`,
    admin`select id, name, alg, transports, created_at, last_used_at from passkeys where user_id = ${id}`,
    admin`select method, created_at, last_seen_at, expires_at, revoked_at, user_agent, country, city from sessions where user_id = ${id} order by created_at desc limit 200`,
    admin`select workspace_id, type, subject, data, created_at from audit_events where actor = ${`user:${id}`} order by id desc limit 5000`,
    admin`select purpose, created_at, used_at, cancelled_at from email_tokens where user_id = ${id} order by created_at desc limit 100`,
  ]);
  return c.json({ exported_at: new Date().toISOString(), format_version: 1, user: u, memberships, passkeys, sessions, audit_events_by_you: events, email_tokens: tokens, notes: ['Passkey public keys, session tokens and the authenticator secret are never exported.', 'Audit events are shared records of an organization and are kept when an account is deleted.'] });
});

routes.delete('/account', async (c) => {
  const admin = c.get('admin'); const a = c.get('actor');
  if (a.kind !== 'user' || a.userId !== a.realUserId) throw new ApiError(403, 'human_required', 'Only you can delete your own account.');
  if (c.get('wsKind') === 'sandbox') throw new ApiError(403, 'sandbox_only', 'A sandbox deletes itself when it expires. There is no account to delete.');
  const { confirm_email } = await body(c, deleteAccountIn);
  const id = a.realUserId!;
  const [u] = await admin`select id, email, name from users where id = ${id}`;
  if (confirm_email !== u.email) throw new ApiError(422, 'confirmation_mismatch', 'Type your account email exactly to confirm.');
  // An organization must keep someone who can run it. Sole administrators hand over or delete the organization first.
  const blocking = await admin`select w.name from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${id} and m.role = 'admin' and w.kind = 'org'
    and not exists (select 1 from memberships o where o.workspace_id = m.workspace_id and o.role = 'admin' and o.user_id <> ${id})`;
  if (blocking.length) throw new ApiError(409, 'sole_admin', `You are the only administrator of ${blocking.map((b: any) => b.name).join(', ')}. Make someone else an administrator, or delete the organization, first.`, { organizations: blocking.map((b: any) => b.name) });
  const orgs = await admin`select workspace_id from memberships where user_id = ${id}`;
  for (const o of orgs) await audit(admin, o.workspace_id, { kind: 'user', id, name: 'A member' }, 'member.account_deleted', id, {});
  await admin.transaction([
    admin`delete from sessions where user_id = ${id}`,
    admin`delete from passkeys where user_id = ${id}`,
    admin`delete from email_tokens where user_id = ${id}`,
    admin`delete from memberships where user_id = ${id}`,
    admin`update users set email = ${`deleted+${id}@deleted.invalid`}, name = 'Deleted user', title = null, totp_secret = null, totp_enabled_at = null, totp_last_step = null, email_verified_at = null where id = ${id}`,
  ]);
  const m = templates.securityAlert({ title: 'Your Laissez account was deleted', lines: ['Your account, passkeys and sessions are gone and your name and email were removed from our user records.', 'Audit entries your organizations recorded stay in their audit logs, because those logs are hash-linked records the organization must keep.'], link: c.env.APP_URL, button: 'Open Laissez' });
  bg(c, sendEmail(c.env, admin, { ws: null, to: u.email, kind: 'security_alert', ...m }));
  return c.json({ deleted: true, kept: 'Audit entries in your organizations keep your user id and the actions you took.' });
});

// ---------- OpenAPI ----------
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const bool = { type: 'boolean' };
const str = { type: 'string' };
export const OPENAPI_SCHEMAS = {
  SecurityPolicy: { type: 'object', description: 'Per-organization sign-in policy. Every field has a default that reproduces the behaviour before policies existed.', properties: { require_sso: { ...bool, description: 'Members sign in through the identity provider. Administrators keep passkeys as a break-glass path.' }, require_user_verification: { ...bool, description: 'Passkeys must prove the person (PIN, fingerprint or face).' }, session_hours: { type: 'integer', minimum: 1, maximum: 168 }, idle_minutes: { type: 'integer', minimum: 5, maximum: 720 }, allowed_email_domains: { type: 'array', items: str }, session_ip_allowlist: { type: 'array', items: str } } },
};
export const OPENAPI_OPS = [
  { method: 'get', path: '/v1/auth/config', tag: 'Security', id: 'getAuthConfig', sum: 'Sign-in configuration for clients', perm: 'public', desc: 'What a sign-up or sign-in screen needs: the deployment mode, the Turnstile site key when a bot check is required, whether email confirmation is required, whether sign-up is open and the current terms version.',
    res: { type: 'object', properties: { mode: { type: 'string', enum: ['sandbox', 'production'] }, turnstile_site_key: { type: ['string', 'null'] }, verification_required: bool, signup_open: bool, terms_version: str, recovery_wait_minutes: { type: 'integer' } } } },
  { method: 'post', path: '/v1/auth/verify-email', tag: 'Security', id: 'verifyEmail', sum: 'Confirm an email address', perm: 'public', body: tokenIn, err: [429], desc: 'Uses the single-use token from the confirmation email. Until an account confirms its address, a production deployment lets it only look at itself, ask for another link and sign out.', res: { type: 'object', properties: { verified: bool, email: str } } },
  { method: 'post', path: '/v1/auth/recover/start', tag: 'Security', id: 'startRecovery', sum: 'Ask for a recovery email', perm: 'public', body: recoverStartIn, ok: 202, err: [429],
    desc: 'Starts email recovery for someone who lost every passkey. The answer is the same whether or not an account uses the address. The emailed link opens after a waiting period (24 hours in production, none when the account has an authenticator app, which then asks for its code) and can be cancelled from the same email. Recovery signs in only far enough to add a passkey.', res: { type: 'object', properties: { requested: bool, wait_minutes: { type: 'integer' }, message: str } } },
  { method: 'get', path: '/v1/auth/recover/{token}', tag: 'Security', id: 'getRecovery', sum: 'Check a recovery link', perm: 'public', pathParam: ['token', 'Token from the recovery email.'], err: [429], desc: 'Reports whether the link is waiting, ready, used, cancelled or expired, and whether an authenticator code is needed.', res: { type: 'object', properties: { state: { type: 'string', enum: ['waiting', 'ready', 'used', 'cancelled', 'expired'] }, available_at: str, expires_at: str, needs_code: bool, email: str, name: str } } },
  { method: 'post', path: '/v1/auth/recover/{token}/complete', tag: 'Security', id: 'completeRecovery', sum: 'Finish recovery', perm: 'public', pathParam: ['token', 'Token from the recovery email.'], body: recoverCompleteIn, err: [403, 410, 422, 429],
    desc: 'After the waiting period, signs the person in with a two-hour recovery session that can only add a passkey. Every other session of the account is ended, the address is marked confirmed and the person is told by email. Accounts with an authenticator app must send its six-digit code.', res: { type: 'object', properties: { session_token: str, workspace_id: str, recovery_session: bool, expires_in_hours: { type: 'integer' }, note: str } } },
  { method: 'post', path: '/v1/auth/recover/{token}/cancel', tag: 'Security', id: 'cancelRecovery', sum: 'Cancel a recovery request', perm: 'public', pathParam: ['token', 'Token from the recovery email.'], err: [429], desc: 'The cancel link in the recovery email. Use it when you did not ask for recovery.', res: { type: 'object', properties: { cancelled: bool, state: str } } },
  { method: 'post', path: '/v1/auth/verify-email/resend', tag: 'Security', id: 'resendVerification', sum: 'Send another confirmation email', perm: 'read', human: true, err: [422, 429], desc: 'Replaces the open confirmation link. Five a hour.', res: { type: 'object', properties: { verified: bool, sent: bool, dev_link: { type: ['string', 'null'], description: 'Only outside production and only when no mail provider could carry the message.' } } } },
  { method: 'get', path: '/v1/account/security', tag: 'Security', id: 'getAccountSecurity', sum: 'Your security status', perm: 'read', human: true, desc: 'Email confirmation, authenticator app, passkeys and sessions, terms accepted, recovery path and the policy of the current organization.', res: { type: 'object', properties: { email: str, email_verified: bool, totp: { type: 'object', properties: { enabled: bool, enabled_at: { type: ['string', 'null'] } } }, passkeys: { type: 'integer' }, sessions: { type: 'integer' }, terms: { type: 'object' }, recovery: { type: 'object' }, organization_policy: { anyOf: [ref('SecurityPolicy'), { type: 'null' }] } } } },
  { method: 'post', path: '/v1/account/totp/setup', tag: 'Security', id: 'setupTotp', sum: 'Start authenticator app setup', perm: 'read', human: true, ok: 201, err: [409], desc: 'Creates a secret and returns it with an otpauth URI for a QR code. It is not active until confirmed with a code. The secret is stored encrypted.', res: { type: 'object', properties: { secret: str, uri: str, digits: { type: 'integer' }, period_seconds: { type: 'integer' }, note: str } } },
  { method: 'post', path: '/v1/account/totp/enable', tag: 'Security', id: 'enableTotp', sum: 'Confirm the authenticator app', perm: 'read', human: true, body: codeIn, err: [409, 429], desc: 'Confirms setup with a current six-digit code. Afterwards recovery by email also needs a code and the waiting period is waived. A code works once.', res: { type: 'object', properties: { enabled: bool } } },
  { method: 'post', path: '/v1/account/totp/disable', tag: 'Security', id: 'disableTotp', sum: 'Turn off the authenticator app', perm: 'read', human: true, body: codeIn, err: [409, 429], desc: 'Needs a current code. Recovery by email returns to the waiting period.', res: { type: 'object', properties: { enabled: bool } } },
  { method: 'get', path: '/v1/security-policy', tag: 'Security', id: 'getSecurityPolicy', sum: 'Get the organization security policy', perm: 'read', desc: 'The policy with defaults filled in, the defaults, whether SSO is available to require and the network address the request came from.', res: { type: 'object', properties: { policy: ref('SecurityPolicy'), defaults: ref('SecurityPolicy'), is_default: bool, applies: bool, sso_enabled: bool, your_network: { type: ['string', 'null'] } } } },
  { method: 'put', path: '/v1/security-policy', tag: 'Security', id: 'putSecurityPolicy', sum: 'Set the organization security policy', perm: 'members:admin', body: policyIn, err: [403, 422],
    desc: 'Replaces the policy. Refuses a policy that would lock out the person saving it (their own network or email domain) and refuses to require single sign-on before it is set up. A shorter session lifetime applies to sessions that already exist. Every change is audited and emailed to the administrators.', res: { type: 'object', properties: { policy: ref('SecurityPolicy'), sessions_shortened: { type: 'integer' } } } },
  { method: 'get', path: '/v1/organization/verification', tag: 'Security', id: 'getOrganizationVerification', sum: 'Organization verification status', perm: 'read', desc: 'The business check that gates settlements, API keys and chain actions in production mode: unverified, pending, verified or rejected, with the submitted profile and the reviewer note.', res: { type: 'object', properties: { status: { type: 'string', enum: ['unverified', 'pending', 'verified', 'rejected', 'not_applicable'] }, required: bool, profile: { type: ['object', 'null'] }, note: { type: ['string', 'null'] }, submitted_at: { type: ['string', 'null'] }, verified_at: { type: ['string', 'null'] } } } },
  { method: 'put', path: '/v1/organization/verification', tag: 'Security', id: 'submitOrganizationVerification', sum: 'Submit the organization for verification', perm: 'members:admin', body: verificationIn, err: [403, 409],
    desc: 'Sends the legal entity details for review. The legal name is screened against the loaded sanctions lists and a hit goes to the reviewer rather than refusing the form. Resubmitting after a rejection replaces the earlier submission.', res: { type: 'object', properties: { status: str, submitted_at: str, note: str } } },
  { method: 'get', path: '/v1/account/export', tag: 'Security', id: 'exportAccount', sum: 'Export your own data', perm: 'read', human: true, desc: 'Your profile, memberships, passkey metadata, sessions, the audit events you authored and confirmation history. Secrets are never included.', res: { type: 'object', properties: { exported_at: str, user: { type: 'object' }, memberships: { type: 'array', items: { type: 'object' } }, passkeys: { type: 'array', items: { type: 'object' } }, sessions: { type: 'array', items: { type: 'object' } }, audit_events_by_you: { type: 'array', items: { type: 'object' } } } } },
  { method: 'delete', path: '/v1/account', tag: 'Security', id: 'deleteAccount', sum: 'Delete your account', perm: 'read', human: true, body: deleteAccountIn, err: [409, 422],
    desc: 'Removes your passkeys, sessions and memberships and strips your name and email from the user record. Refused while you are the only administrator of an organization. Audit entries an organization already recorded stay, because those logs are hash-linked.', res: { type: 'object', properties: { deleted: bool, kept: str } } },
];
void today;
