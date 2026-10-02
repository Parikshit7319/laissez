// Fetch helpers for the investor portal and the consent page. These pages never send the
// staff session or sandbox key: the portal uses its own link token, the consent page none.
import { API_BASE, API_VERSION } from '../app/api';

export class PortalError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: any) { super(message); }
}

const memory: Record<string, string> = {};
/** Reads a token from the URL fragment once, keeps it for this browser tab, and removes it from the address bar. */
export function captureToken(prefix: string, key: string): string | null {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith(prefix)) {
    memory[key] = h;
    try { sessionStorage.setItem(key, h); } catch { /* storage blocked: keep it in memory */ }
    try { history.replaceState(null, '', `${location.pathname}${location.search}#/`); } catch { location.hash = '#/'; }
    return h;
  }
  try { return sessionStorage.getItem(key) ?? memory[key] ?? null; } catch { return memory[key] ?? null; }
}
export function forgetToken(key: string) {
  delete memory[key];
  try { sessionStorage.removeItem(key); } catch { /* storage blocked */ }
}

export async function call<T = any>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Laissez-Version': API_VERSION };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new PortalError(0, 'network', 'We could not reach the server. Check your connection and try again.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new PortalError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `The request failed (${res.status}). Try again.`, data?.error?.detail);
  return data as T;
}

export const fmtMoney = (n: number, ccy = 'USD') => `${ccy === 'EUR' ? '€' : ccy === 'USD' ? '$' : `${ccy} `}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
export const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Readable text color on a brand color. */
export function onColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#14130f' : '#ffffff';
}
