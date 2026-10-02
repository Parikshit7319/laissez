// Structured request logging. Every response carries X-Request-Id and X-Response-Time; every request writes one
// JSON line to the Workers log; one request in twenty is sampled into request_log_samples for the status page's
// p95 latency and error budget. Samples hold the route path, status and duration only: no tenant, actor or body.
import type { MiddlewareHandler } from 'hono';
import { adminSql } from './db';
import type { Env } from './util';
import type { Vars } from './http';

export const SAMPLE_RATE = 20;

// Crockford base32, as ULIDs use: 10 time characters then 16 random ones. Sorts by time, safe in headers and logs.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A ULID-shaped request id: 26 characters, time-ordered, 80 random bits. */
export function requestId(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rnd = '';
  for (let i = 0; i < 16; i++) rnd += B32[bytes[i] % 32];
  return time + rnd;
}

const ID_OK = /^[A-Za-z0-9_-]{8,64}$/;

/** Collapses ids in the path so samples group by route: /v1/decisions/dec_abc -> /v1/decisions/:id. */
export function routePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg, i) => (i > 1 && (/^[a-z]{1,8}_[A-Za-z0-9]{6,}$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(seg) || /^\d+$/.test(seg) || /^LZ-[A-Z0-9-]+$/.test(seg) || seg.length > 40) ? ':id' : seg))
    .join('/')
    .slice(0, 120);
}

export type LogLine = { ts: string; id: string; method: string; path: string; status: number; ms: number; ws?: string; actor?: string; version?: string; ray?: string; colo?: string; err?: string };

/**
 * Assigns the request id, times the handler, sets both headers, logs a JSON line and samples into Postgres.
 * Mount first, so the timing covers CORS, versioning and auth too.
 */
export const requestLogging: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const start = Date.now();
  const incoming = c.req.header('x-request-id');
  const id = incoming && ID_OK.test(incoming) ? incoming : requestId(start);
  (c as any).set('requestId', id);
  let thrown: unknown = null;
  try { await next(); }
  catch (e) { thrown = e; throw e; }
  finally {
    const ms = Date.now() - start;
    const apply = (h: Headers) => {
      h.set('X-Request-Id', id);
      h.set('X-Response-Time', `${ms}ms`);
    };
    if (c.res) {
      try { apply(c.res.headers); }
      catch { c.res = new Response(c.res.body, c.res); apply(c.res.headers); }
    }
    const status = c.res?.status ?? (thrown ? 500 : 0);
    const url = new URL(c.req.url);
    const actor = c.get('actor');
    const line: LogLine = {
      ts: new Date(start).toISOString(), id, method: c.req.method, path: url.pathname, status, ms,
      ...(c.get('ws') ? { ws: c.get('ws') } : {}),
      ...(actor ? { actor: actor.kind } : {}),
      ...(c.get('version') ? { version: c.get('version') } : {}),
      ...(c.req.header('cf-ray') ? { ray: c.req.header('cf-ray') } : {}),
      ...((c.req.raw as any).cf?.colo ? { colo: String((c.req.raw as any).cf.colo) } : {}),
      ...(thrown ? { err: String((thrown as any)?.message ?? thrown).slice(0, 200) } : {}),
    };
    console.log(JSON.stringify(line));
    // Sample 1 in 20 requests. Preflight and the status endpoint itself are left out so the page does not measure itself.
    if (c.req.method !== 'OPTIONS' && url.pathname !== '/v1/status' && Math.random() * SAMPLE_RATE < 1) {
      const sample = adminSql(c.env.DATABASE_URL)`insert into request_log_samples (ts, path, status, ms) values (${line.ts}, ${routePath(url.pathname)}, ${status}, ${ms})`;
      try { c.executionCtx.waitUntil(Promise.resolve(sample).then(() => undefined, () => undefined)); }
      catch { /* no execution context (tests): drop the sample */ }
    }
  }
};
