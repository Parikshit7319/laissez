// Shared helpers for the scheduled jobs. Jobs run in Node 22 (GitHub Actions) from the api/ directory
// and connect with DATABASE_URL, the owner role, which bypasses row-level security.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { adminSql, setDriver, pgDriver, type Sql } from '../src/db';

/** Read DATABASE_URL from the environment, or from api/.dev.vars for local runs. */
export function db(): Sql {
  if (!process.env.DATABASE_URL && fs.existsSync('.dev.vars')) {
    for (const line of fs.readFileSync('.dev.vars', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Export the owner connection string (or add it to api/.dev.vars) and run the job again.');
    process.exit(2);
  }
  // A local Postgres (embedded or Docker) speaks the wire protocol, not Neon's HTTP: switch the driver like server.mjs does.
  if (/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    const pg = createRequire(import.meta.url)('pg');
    setDriver(pgDriver(pg));
  }
  return adminSql(url);
}

const CONTACT = process.env.FEEDS_CONTACT ? ` ${process.env.FEEDS_CONTACT}` : '';
/** Some publishers (the SEC in particular) require a descriptive user agent with a contact address. */
export const USER_AGENT = `Laissez compliance jobs (+https://parikshit7319.github.io/laissez/)${CONTACT}`;

export type Fetched = { text: string; status: number; lastModified: string | null; contentType: string; url: string };

/** GET a URL as text with a timeout and one retry on network errors or 5xx responses. Throws on any other non-2xx status. */
export async function fetchText(url: string, opts: { timeoutMs?: number; accept?: string; retries?: number } = {}): Promise<Fetched> {
  const { timeoutMs = 120_000, accept = '*/*', retries = 1 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500) { lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`); continue; }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { fatal: true });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { text: new TextDecoder('utf-8').decode(buf), status: res.status, lastModified: res.headers.get('last-modified'), contentType: res.headers.get('content-type') ?? '', url: res.url || url };
    } catch (e: any) {
      if (e?.fatal) throw e;
      lastErr = e?.name === 'TimeoutError' ? new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${new URL(url).host}`) : e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export const log = (...args: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
export const fmt = (n: number) => n.toLocaleString('en-US');

/** Run async work over items with bounded concurrency, collecting results in order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}
