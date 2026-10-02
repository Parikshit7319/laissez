// Thin client for the Laissez API. The sandbox key lives in this browser only.
export const API_BASE = 'https://laissez-api.laissez.workers.dev';
const KEY = 'laissez-sandbox-key';
const WS = 'laissez-sandbox-meta';

export const getKey = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setKey = (k: string | null, meta?: unknown) => {
  try { if (k) { localStorage.setItem(KEY, k); if (meta) localStorage.setItem(WS, JSON.stringify(meta)); } else { localStorage.removeItem(KEY); localStorage.removeItem(WS); } } catch { /* storage blocked */ }
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const key = getKey();
  if (opts.auth !== false && key) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the Laissez API. Check your connection and try again.');
  }
  if (opts.raw) return res as unknown as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status}).`, data?.error?.detail);
  return data as T;
}

export const money = (n: number, ccy = 'USD') => (ccy === 'EUR' ? '€' : '$') + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const compact = (n: number, ccy = 'USD') => (ccy === 'EUR' ? '€' : '$') + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const JUR: Record<string, string> = { SG: 'Singapore', HK: 'Hong Kong', CH: 'Switzerland', DE: 'Germany (EU)', 'AE-DIFC': 'UAE (DIFC)', US: 'United States', IR: 'Iran', CU: 'Cuba', KP: 'North Korea', GB: 'United Kingdom' };
export const CLASS_LABEL: Record<string, string> = { SG_AI: 'SG accredited investor', HK_PI: 'HK professional investor', EU_PRO: 'EU professional client', EU_RETAIL: 'EU retail client', CH_PRO: 'CH professional client', DIFC_PRO: 'DIFC professional client', US_AI: 'US accredited investor' };
export const BOOKING: Record<string, string> = { HK: 'Hong Kong', SG: 'Singapore', ZRH: 'Zurich', DIFC: 'Dubai (DIFC)', NY: 'New York' };
