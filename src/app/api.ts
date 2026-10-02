// Thin client for the Laissez API. Credentials live in this browser only.
// The session token is the primary credential. The sandbox API key is kept for the API explorer.
/** API base: build-time PUBLIC_API_BASE (local dev), else a per-browser override in localStorage 'laissez-api-base', else the live API. */
export const API_BASE: string = (() => {
  const env = (import.meta as any).env?.PUBLIC_API_BASE as string | undefined;
  if (env) return env.replace(/\/$/, '');
  try { const o = localStorage.getItem('laissez-api-base'); if (o) return o.replace(/\/$/, ''); } catch { /* storage unavailable */ }
  return 'https://laissez-api.laissez.workers.dev';
})();
export const API_VERSION = '2026-10-02';
const SESSION = 'laissez-session';
const KEY = 'laissez-sandbox-key';
const KEY_META = 'laissez-sandbox-meta';
const ANON = 'laissez-anon';

// ---------- Storage (wrapped: private windows and embedded viewers can block it) ----------
const ls = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

export const getSession = (): string | null => ls.get(SESSION);
export const setSession = (t: string | null) => (t ? ls.set(SESSION, t) : ls.del(SESSION));

/** The sandbox API key, used by the API explorer. */
export const getKey = (): string | null => ls.get(KEY);
export const setKey = (k: string | null, meta?: unknown) => {
  if (k) { ls.set(KEY, k); if (meta) ls.set(KEY_META, JSON.stringify(meta)); } else { ls.del(KEY); ls.del(KEY_META); }
};
/** Workspace id the stored sandbox key belongs to, if known. */
export const keyWorkspace = (): string | null => {
  try { const m = JSON.parse(ls.get(KEY_META) ?? 'null'); return m?.workspace?.id ?? m?.id ?? null; } catch { return null; }
};

/** The token sent with requests: the session, else the sandbox key. */
export const getToken = (): string | null => getSession() ?? getKey();
export const hasCredential = () => !!getToken();
export const authHeaders = (): Record<string, string> => {
  const t = getToken();
  return { 'Laissez-Version': API_VERSION, ...(t ? { authorization: `Bearer ${t}` } : {}) };
};

/** Store a new session. Drops the sandbox key when it belongs to a different workspace. */
export function adoptSession(token: string, workspaceId?: string | null) {
  setSession(token);
  const kw = keyWorkspace();
  if (getKey() && workspaceId && kw && kw !== workspaceId) setKey(null);
  if (getKey() && workspaceId && !kw) setKey(null);
}
export function clearCredentials() { setSession(null); setKey(null); }

export const uuid = (): string => {
  try { return crypto.randomUUID(); } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
  }
};

// ---------- Errors and session expiry ----------
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: any) { super(message); }
}
export const AUTH_EVENT = 'laissez:signed-out';
function expire(reason: string) {
  clearCredentials();
  try { window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: reason })); } catch { /* no window */ }
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
export type ApiOpts = { method?: string; body?: unknown; auth?: boolean; raw?: boolean; headers?: Record<string, string>; idempotencyKey?: string };

export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<T> {
  const method = (opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const headers: Record<string, string> = { 'Laissez-Version': API_VERSION, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (MUTATING.has(method)) headers['Idempotency-Key'] = opts.idempotencyKey ?? uuid();
  const token = opts.auth === false ? null : getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the Laissez API. Check your connection and try again.');
  }
  if (opts.raw) return res as unknown as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.code ?? 'error';
    if (res.status === 401 && token && (code === 'session_expired' || code === 'unauthorized')) expire(code);
    throw new ApiError(res.status, code, data?.error?.message ?? `Request failed (${res.status}).`, data?.error?.detail);
  }
  return data as T;
}

// ---------- Product events (fire and forget) ----------
export const anonId = (): string => {
  let id = ls.get(ANON);
  if (!id) { id = uuid(); ls.set(ANON, id); }
  return id;
};
export function track(event: string, props: Record<string, unknown> = {}) {
  try {
    const t = getToken();
    fetch(API_BASE + '/v1/events', {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json', 'Laissez-Version': API_VERSION, ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify({ event, anon_id: anonId(), props }),
    }).catch(() => {});
  } catch { /* never break the app for analytics */ }
}
/** Track an event at most once per browser session. */
export function trackOnce(event: string, props: Record<string, unknown> = {}) {
  const k = `laissez-tracked-${event}`;
  try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* fall through and track */ }
  track(event, props);
}

// ---------- Formatting ----------
export const money = (n: number, ccy = 'USD') => (ccy === 'EUR' ? '€' : '$') + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const compact = (n: number, ccy = 'USD') => (ccy === 'EUR' ? '€' : '$') + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const shortHash = (h?: string | null, n = 10) => (h ? (h.length > n + 2 ? `${h.slice(0, n)}…` : h) : '');
export const txUrl = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
export const JUR: Record<string, string> = { SG: 'Singapore', HK: 'Hong Kong', CH: 'Switzerland', DE: 'Germany (EU)', 'AE-DIFC': 'UAE (DIFC)', US: 'United States', IR: 'Iran', CU: 'Cuba', KP: 'North Korea', GB: 'United Kingdom', JP: 'Japan', 'AE-ADGM': 'UAE (ADGM)', LU: 'Luxembourg', IE: 'Ireland', IN: 'India' };
export const CLASS_LABEL: Record<string, string> = {
  SG_AI: 'SG accredited investor', HK_PI: 'HK professional investor', EU_PRO: 'EU professional client', EU_RETAIL: 'EU retail client', CH_PRO: 'CH professional client', DIFC_PRO: 'DIFC professional client',
  US_AI: 'US accredited investor', US_QP: 'US qualified purchaser', US_QIB: 'US qualified institutional buyer', US_IAI: 'US institutional accredited investor',
  GB_PRO: 'UK professional client (per se)', GB_EPRO: 'UK elective professional client', JP_QII: 'JP qualified institutional investor', ADGM_PRO: 'ADGM professional client',
  IN_AI: 'IN accredited investor (SEBI)', IN_LRS: 'IN resident individual (LRS)', IFSCA_PRO: 'GIFT City accredited investor (IFSCA)',
};
export const BOOKING: Record<string, string> = { HK: 'Hong Kong', SG: 'Singapore', ZRH: 'Zurich', DIFC: 'Dubai (DIFC)', NY: 'New York', LDN: 'London', TYO: 'Tokyo', ADGM: 'Abu Dhabi (ADGM)', GIFT: 'GIFT City (IFSC)' };
