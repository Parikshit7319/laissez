// Per-organization security policy. Stored as jsonb on workspaces.security_policy; every field is optional and the
// defaults reproduce the behaviour before policies existed, so an empty policy changes nothing.
import { z } from 'zod';
import { ipAllowed, validCidr } from './util';

export const DEFAULT_SESSION_HOURS = 24 * 7;
export const DEFAULT_IDLE_MINUTES = 12 * 60;

export const policyIn = z.object({
  /** Members sign in through the organization's identity provider. Administrators keep passkeys as a break-glass path. */
  require_sso: z.boolean().default(false),
  /** Passkeys must prove the person (fingerprint, face or PIN), not only possession of the device. */
  require_user_verification: z.boolean().default(false),
  /** A session ends this many hours after sign-in, whatever its activity. */
  session_hours: z.number().int().min(1).max(24 * 7).default(DEFAULT_SESSION_HOURS),
  /** A session ends after this many minutes without a request. */
  idle_minutes: z.number().int().min(5).max(12 * 60).default(DEFAULT_IDLE_MINUTES),
  /** Invites and sign-ups are limited to these email domains. Empty allows any. */
  allowed_email_domains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Use a domain such as example.com')).max(20).default([]),
  /** People sign in only from these networks (CIDR or single addresses). Empty allows any. */
  session_ip_allowlist: z.array(z.string().trim().refine(validCidr, 'Use an address or CIDR such as 203.0.113.0/24')).max(50).default([]),
  /** Investors must create a portal account (passkey) from their link before the portal opens; links alone no longer work. */
  portal_require_account: z.boolean().default(false),
});
export type SecurityPolicy = z.infer<typeof policyIn>;

/** The stored policy with defaults filled in. Tolerates anything an older version wrote. */
export function effectivePolicy(raw: unknown): SecurityPolicy {
  const parsed = policyIn.safeParse(raw && typeof raw === 'object' ? raw : {});
  return parsed.success ? parsed.data : policyIn.parse({});
}
export const isDefaultPolicy = (p: SecurityPolicy) => JSON.stringify(p) === JSON.stringify(policyIn.parse({}));

export const emailAllowed = (p: SecurityPolicy, email: string) => !p.allowed_email_domains.length || p.allowed_email_domains.includes(email.split('@')[1]?.toLowerCase() ?? '');
export const networkAllowed = (p: SecurityPolicy, ip: string) => !p.session_ip_allowlist.length || ipAllowed(ip, p.session_ip_allowlist);
