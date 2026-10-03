// Shared account-security helpers: email verification, security alerts and bot protection. Kept free of routes so
// auth.ts and routes/security.ts can both import it without a cycle.
import type { Sql } from './db';
import { ApiError, rand, sha256, type Env } from './util';
import { isProduction } from './mode';
import { sendEmail, templates, deliverable } from './email';
import { audit, type Actor } from './http';

export const TERMS_VERSION = '2026-10-02';
export const VERIFY_HOURS = 48;

export const mailConfigured = (env: Env) => !!(env.RESEND_API_KEY && env.EMAIL_FROM);
/**
 * Whether a new account must prove its email address. Always in production; in sandbox mode only when mail can
 * actually be delivered, because otherwise nobody could ever receive the link.
 */
export const verificationRequired = (env: Env) => isProduction(env) || mailConfigured(env);
/** Minutes a recovery link stays closed after it is requested. Zero when the account has an authenticator app. */
export const recoveryWaitMinutes = (env: Env) => (isProduction(env) ? 24 * 60 : 1);

/** Cloudflare Turnstile. A no-op until TURNSTILE_SECRET is set; then a missing or failed token is a 400. */
export async function verifyTurnstile(env: Env, token: string | undefined | null, ip: string | undefined) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) throw new ApiError(400, 'bot_check_required', 'Complete the security check and try again.');
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(6000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j.success) throw new ApiError(400, 'bot_check_failed', 'The security check did not pass. Reload the page and try again.');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(503, 'bot_check_unavailable', 'The security check could not be reached. Try again in a minute.');
  }
}

/** Creates a verification token and emails it. Returns the link only when no mail provider could carry it. */
export async function issueEmailVerification(env: Env, admin: Sql, user: { id: string; email: string; name: string }, ip?: string | null): Promise<{ sent: boolean; dev_link: string | null }> {
  const token = `ver_${rand(40)}`;
  await admin`update email_tokens set cancelled_at = now() where user_id = ${user.id} and purpose = 'verify' and used_at is null and cancelled_at is null`;
  await admin`insert into email_tokens (token_hash, user_id, email, purpose, expires_at, ip_hash) values (${await sha256(token)}, ${user.id}, ${user.email}, 'verify', now() + make_interval(hours => ${VERIFY_HOURS}), ${ip ?? null})`;
  const link = `${env.APP_URL}#/verify-email/${token}`;
  const m = await sendEmail(env, admin, { ws: null, to: user.email, kind: 'verify_email', ...templates.verifyEmail({ name: user.name, link, expiresHours: VERIFY_HOURS }) });
  return { sent: m.status === 'sent', dev_link: m.status === 'sent' || isProduction(env) ? null : link };
}

/**
 * Tells a person that something protecting their account changed, and records it in the audit log of the
 * organization they were in. Skipped quietly for fictional teammates and addresses that cannot receive mail.
 */
export async function securityAlert(env: Env, admin: Sql, o: { userId: string; ws?: string | null; actor?: Actor | null; type: string; title: string; lines: string[]; data?: unknown; button?: string; path?: string }) {
  const [u] = await admin`select u.email, u.name, u.fictional, w.name as org, w.brand_name from users u left join workspaces w on w.id = ${o.ws ?? null} where u.id = ${o.userId}`;
  if (o.ws) await audit(admin, o.ws, o.actor ?? { kind: 'user', id: o.userId, name: u?.name ?? 'User' }, o.type, o.userId, o.data ?? {});
  if (!u || u.fictional || !deliverable(u.email)) return;
  const m = templates.securityAlert({ title: o.title, lines: o.lines, org: u.brand_name || u.org || null, link: `${env.APP_URL}${o.path ?? '#/settings/security'}`, button: o.button });
  await sendEmail(env, admin, { ws: o.ws ?? null, to: u.email, kind: 'security_alert', ...m });
}
