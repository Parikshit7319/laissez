import type { NeonQueryFunction } from '@neondatabase/serverless';

export type Sql = NeonQueryFunction<false, false>;

export type Env = {
  DATABASE_URL: string;
  ALLOWED_ORIGINS: string;
  MAX_ACTIVE_SANDBOXES: string;
  SIGNING_KEY_JWK?: string;
  ANTHROPIC_API_KEY?: string;
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

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

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
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, new TextEncoder().encode(canonical(receipt)));
  return b64url(sig);
}
export async function publicKey(env: Env) {
  return (await keys(env)).publicJwk;
}
export async function verifyReceipt(env: Env, receipt: Record<string, unknown>, signature: string) {
  const pub = await crypto.subtle.importKey('jwk', (await keys(env)).publicJwk, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, pub, fromB64url(signature), new TextEncoder().encode(canonical(receipt)));
}

// ---------- Rate limiting (fixed window, stored in Postgres) ----------
export async function rateLimit(sql: Sql, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const rows = await sql.query(
    `insert into rate_limits (key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count`,
    [key, windowSeconds],
  );
  return Number(rows[0].count) <= limit;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) { super(message); }
}
