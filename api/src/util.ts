import type { Sql } from './db';
export type { Sql } from './db';

export type Env = {
  DATABASE_URL: string;
  DATABASE_URL_TENANT: string;
  ALLOWED_ORIGINS: string;
  MAX_ACTIVE_SANDBOXES: string;
  APP_URL: string;
  API_URL: string;
  SIGNING_KEY_JWK?: string;
  ANTHROPIC_API_KEY?: string;
  SSO_ENC_KEY?: string;
  DEMO_IDP_JWK?: string;
  INTERNAL_TOKEN?: string;
  CHAIN_RPC_URL?: string;
  CHAIN_OPERATOR_KEY?: string;
  CHAIN_CLAIM_KEY?: string;
  CHAIN_CUSTODY_SEED?: string;
  /** Optional. sandbox (default) or production. Production disables every fictional path: see api/src/mode.ts. */
  LAISSEZ_MODE?: 'sandbox' | 'production' | string;
  /** Optional. Resend API key; without it every email lands in the outbox only. */
  RESEND_API_KEY?: string;
  /** Optional. Sender for outgoing email, for example "Laissez <no-reply@laissez.example>". */
  EMAIL_FROM?: string;
  /** Optional. Cloudflare Turnstile secret and public site key; the sign-up and recovery forms require a passing check once set. */
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Optional. Stripe secret key and webhook signing secret; invoices get a hosted payment page once set. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Optional. Seller details printed on invoices. */
  SELLER_NAME?: string;
  SELLER_ADDRESS?: string;
  SELLER_TAX_ID?: string;
  /** Optional. Where staff notifications (organization verification, quote requests) are sent. */
  STAFF_EMAIL?: string;
};

const ALPHA = 'abcdefghijkmnopqrstuvwxyz23456789';
export function rand(n: number, alphabet = ALPHA): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
export const id = (prefix: string, n = 14) => `${prefix}_${rand(n)}`;
export const digits = (n: number) => rand(n, '0123456789');
export const lzid = () => `LZ-${rand(4, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789')}-${rand(4, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789')}-${rand(4, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789')}`;

export const enc = new TextEncoder();
export const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(text: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? enc.encode(text) : text));
}
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}
export async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

export const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = new Uint8Array(buf as ArrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const randomB64 = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const today = () => new Date().toISOString().slice(0, 10);
export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86_400_000);
}

// ---------- Receipt signing (Ed25519) ----------
export function canonical(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') return `{${Object.keys(obj as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((obj as any)[k])}`).join(',')}}`;
  return JSON.stringify(obj);
}

let signingKey: CryptoKey | null = null;
let publicJwk: JsonWebKey | null = null;
async function keys(env: Env) {
  if (signingKey && publicJwk) return { signingKey, publicJwk };
  if (!env.SIGNING_KEY_JWK) throw new Error('signing_not_configured');
  const raw = JSON.parse(env.SIGNING_KEY_JWK) as JsonWebKey;
  // Keep only the key material: runtimes disagree on the "alg" label for Ed25519.
  const jwk: JsonWebKey = { kty: raw.kty, crv: raw.crv, x: raw.x, d: raw.d };
  signingKey = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return { signingKey, publicJwk };
}
export async function signReceipt(env: Env, receipt: Record<string, unknown>) {
  const { signingKey } = await keys(env);
  return b64url(await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, enc.encode(canonical(receipt))));
}
export async function publicKey(env: Env) {
  return (await keys(env)).publicJwk;
}
export async function verifyReceipt(env: Env, receipt: Record<string, unknown>, signature: string) {
  const pub = await crypto.subtle.importKey('jwk', (await keys(env)).publicJwk, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, pub, fromB64url(signature), enc.encode(canonical(receipt)));
}

// ---------- Secret-at-rest encryption (AES-GCM) for SSO client secrets ----------
async function aesKey(env: Env) {
  if (!env.SSO_ENC_KEY) throw new ApiError(501, 'not_configured', 'Encryption key is not configured.');
  return crypto.subtle.importKey('raw', fromB64url(env.SSO_ENC_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env: Env, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plain));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function unseal(env: Env, sealed: string) {
  const [iv, ct] = sealed.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await aesKey(env), fromB64url(ct)));
}

// ---------- IP allowlists ----------
function ipToBig(ip: string): { v: 4 | 6; n: bigint } | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) };
  }
  if (ip.includes(':')) {
    let [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    if (groups.length !== 8) return null;
    let n = 0n;
    for (const g of groups) n = (n << 16n) + BigInt(parseInt(g || '0', 16));
    return { v: 6, n };
  }
  return null;
}
export function ipAllowed(ip: string, list: string[] | null | undefined): boolean {
  if (!list?.length) return true;
  const a = ipToBig(ip);
  if (!a) return false;
  return list.some((entry) => {
    const [base, bitsS] = entry.split('/');
    const b = ipToBig(base);
    if (!b || b.v !== a.v) return false;
    const total = a.v === 4 ? 32 : 128;
    const bits = bitsS === undefined ? total : Number(bitsS);
    if (!(bits >= 0 && bits <= total)) return false;
    const shift = BigInt(total - bits);
    return a.n >> shift === b.n >> shift;
  });
}
export const validCidr = (s: string) => {
  const [base, bits] = s.split('/');
  const b = ipToBig(base);
  return !!b && (bits === undefined || (Number(bits) >= 0 && Number(bits) <= (b.v === 4 ? 32 : 128)));
};

// ---------- Rate limiting (fixed window, stored in Postgres) ----------
export type RateStatus = { allowed: boolean; limit: number; remaining: number; /** Unix seconds when the window resets. */ resetAt: number; retryAfter: number };
/** Counts one request against a fixed window and reports what is left. The headers middleware reads the result from c.get('rate'). */
export async function rateLimitStatus(sql: Sql, key: string, limit: number, windowSeconds: number): Promise<RateStatus> {
  const rows = await sql.query(
    `insert into rate_limits (key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count, extract(epoch from window_start)::float8 as started`,
    [key, windowSeconds],
  );
  const count = Number(rows[0].count);
  const resetAt = Math.ceil(Number(rows[0].started) + windowSeconds);
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt, retryAfter: Math.max(1, resetAt - Math.floor(Date.now() / 1000)) };
}
/** Boolean form kept for the many callers that only need allowed or not. */
export async function rateLimit(sql: Sql, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await rateLimitStatus(sql, key, limit, windowSeconds)).allowed;
}

// ---------- Request origin: country, city, browser, operating system ----------
export function requestGeo(req: Request & { cf?: any }, header: (n: string) => string | undefined) {
  const cf = (req as any).cf ?? {};
  const country = (header('cf-ipcountry') ?? cf.country ?? '').toUpperCase().slice(0, 2) || null;
  const city = (typeof cf.city === 'string' ? cf.city : '').slice(0, 80) || null;
  return { country: country === 'XX' || country === 'T1' ? null : country, city };
}
export function parseUa(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : ua ? 'Browser' : 'Unknown';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  return { browser, os };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) { super(message); }
}
