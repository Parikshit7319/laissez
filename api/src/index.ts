// Laissez API: a Cloudflare Worker on Neon Postgres.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { adminSql } from './db';
import { ApiError, type Env } from './util';
import { type Vars, router } from './http';
import { authenticate, pub, acct } from './auth';
import { idp, setSelfFetch } from './oidc';
import { versionMiddleware, LATEST_VERSION, SUPPORTED_VERSIONS } from './version';
import { requestLogging } from './logging';
import { mergedSpec } from './openapi-gen';
import { modeGuard, mode } from './mode';
import * as flags from './flags';
import * as errors from './errors';
import * as integrations from './routes/integrations';
import * as core from './routes/core';
import * as platform from './routes/platform';
import * as compliance from './routes/compliance';
import * as compliance2 from './routes/compliance2';
import * as fundops from './routes/fundops';
import * as network from './routes/network';
import * as portal from './routes/portal';
import * as travel from './routes/travel';
import * as reports from './routes/reports';
import { runScheduledReports } from './routes/reports2';
import * as chainRoutes from './routes/chain';
import * as leads from './routes/leads';
import * as account2 from './routes/account2';
import * as workflow from './routes/workflow';
import * as rules from './routes/rules';
import * as imports from './routes/import';
import { scim } from './scim';
import { sendDigests } from './email';
import * as chainLib from './chain';
import './rulepacks';

type App = Hono<{ Bindings: Env; Variables: Vars }>;
const app: App = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- Middleware for every request ----------
// Logging is outermost so X-Request-Id, X-Response-Time and the JSON log line cover every response, errors included.
app.use('*', requestLogging);
app.use('*', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (o) => (allowed.includes(o) ? o : allowed[0]),
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Laissez-Version', 'X-Request-Id'],
    exposeHeaders: ['Laissez-Version', 'Idempotent-Replayed', 'X-Request-Id', 'X-Response-Time', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Quota-Limit', 'X-Quota-Remaining', 'Retry-After'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next);
});
app.use('*', platform.securityHeaders);
app.use('*', versionMiddleware);
// Deployment mode: in production every fictional route answers 404 or 403 here, before auth or the database.
app.use('*', modeGuard);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const d: any = err.detail ?? {};
      c.header('Retry-After', String(Math.max(1, Number(d.retry_after ?? 60) || 60)));
      if (d.rate) { c.header('X-RateLimit-Limit', String(d.rate.limit)); c.header('X-RateLimit-Remaining', '0'); c.header('X-RateLimit-Reset', String(d.rate.resetAt)); }
    }
    return c.json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status as any);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: { code: 'invalid_request', message: 'The request body is not valid. Fix the fields listed in detail and retry.', detail: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) } }, 400);
  }
  if (err instanceof HTTPException) return c.json({ error: { code: 'http_error', message: err.message || 'The request could not be processed.' } }, err.status);
  console.error(err);
  const requestId = (c as any).get('requestId') as string | undefined;
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong on our side. The request was not applied. Retry, and contact us if it keeps failing.', ...(requestId ? { request_id: requestId } : {}) } }, 500);
});
app.notFound((c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}. See the API overview at GET /.` } }, 404));

// ---------- Public ----------
app.get('/', (c) => c.json({
  name: 'Laissez API', version: LATEST_VERSION, versions: SUPPORTED_VERSIONS, mode: mode(c.env),
  docs: 'https://parikshit7319.github.io/laissez/developers/', ...(mode(c.env) === 'sandbox' ? { sandbox: 'POST /v1/sandboxes' } : {}), status: 'GET /v1/status', errors: 'GET /v1/errors',
}));
app.get('/v1/health', async (c) => {
  await adminSql(c.env.DATABASE_URL)`select 1`;
  return c.json({ ok: true, version: LATEST_VERSION });
});
app.get('/v1/openapi.json', (c) => c.json(mergedSpec() as any));
app.route('/idp', idp);

/** Reads an optional export: modules are written in parallel and some start as stubs. */
const opt = (m: object, name: string): App | null => {
  const r = (m as Record<string, unknown>)[name];
  return r && typeof (r as App).routes !== 'undefined' ? (r as App) : null;
};
const mount = (path: string, r: App | null) => { if (r) app.route(path, r); };
// Public routers must be mounted before the authenticated /v1 router, whose middleware matches every /v1 path.
app.route('/v1', pub);
app.route('/v1', platform.publicRoutes);
app.route('/v1', core.publicRoutes);
app.route('/v1', errors.publicRoutes);
mount('/v1', opt(network, 'publicRoutes'));
mount('/v1', opt(compliance, 'publicRoutes'));
mount('/v1', opt(fundops, 'publicRoutes'));
mount('/v1', opt(reports, 'publicRoutes'));
mount('/v1', opt(chainRoutes, 'publicRoutes'));
mount('/v1', opt(leads, 'publicRoutes'));
mount('/v1/portal', opt(portal, 'publicRoutes'));
mount('/v1', opt(account2, 'publicRoutes'));
mount('/trp', opt(travel, 'publicRoutes'));
// SCIM 2.0 provisioning, authenticated by the organization's SCIM token.
app.route('/scim/v2', scim as unknown as App);

// ---------- Authenticated ----------
const v1 = router();
v1.use('*', authenticate);
v1.use('*', account2.rateLimitHeaders);
v1.use('*', platform.idempotency);
v1.route('/', acct);
v1.route('/', core.routes);
v1.route('/', platform.routes);
v1.route('/', flags.routes);
v1.route('/', integrations.routes);
for (const m of [compliance, compliance2, fundops, network, reports, chainRoutes, travel, portal, account2, workflow, imports, rules]) {
  const r = opt(m, 'routes');
  if (r) v1.route('/', r);
}
app.route('/v1', v1);

// ---------- Scheduled jobs ----------
type Check = { component: string; ok: boolean; latency_ms: number | null; detail: string };
async function timed(component: string, fn: () => Promise<string>): Promise<Check> {
  const start = Date.now();
  try { const detail = await fn(); return { component, ok: true, latency_ms: Date.now() - start, detail }; }
  catch (e: any) { return { component, ok: false, latency_ms: Date.now() - start, detail: String(e?.message ?? e).slice(0, 300) }; }
}

async function uptimeChecks(env: Env, ctx: ExecutionContext) {
  const admin = adminSql(env.DATABASE_URL);
  const checks = await Promise.all([
    timed('api', async () => {
      const res = await app.fetch(new Request(`${env.API_URL}/v1/health`), env, ctx);
      if (!res.ok) throw new Error(`Health check returned ${res.status}.`);
      return 'Health check passed.';
    }),
    timed('database', async () => { await admin`select 1`; return 'select 1 succeeded.'; }),
    ...(env.CHAIN_RPC_URL ? [timed('chain_rpc', async () => {
      const res = await fetch(env.CHAIN_RPC_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(5000) });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof j.result !== 'string') throw new Error(`eth_blockNumber failed${j.error?.message ? `: ${j.error.message}` : ` with status ${res.status}`}.`);
      return `Latest block ${parseInt(j.result, 16)}.`;
    })] : []),
    timed('sanctions_data', async () => {
      const rows = await admin`select source, status, last_fetched_at, (last_fetched_at is null or last_fetched_at < now() - interval '36 hours') as stale from sanctions_sources where source <> 'LAISSEZ-TEST'`;
      const bad = rows.filter((r: any) => r.stale || r.status === 'error');
      if (bad.length) throw new Error(`Not refreshed in the last 36 hours: ${bad.map((r: any) => r.source).join(', ')}.`);
      return `${rows.length} lists refreshed in the last 36 hours.`;
    }),
    timed('monitoring', async () => {
      const [r] = await admin`select max(finished_at) as last, count(*)::int as n from monitor_runs`;
      if (!r.n) return 'No monitoring runs recorded yet.';
      if (!r.last || Date.now() - new Date(r.last).getTime() > 48 * 3_600_000) throw new Error('No monitoring run has finished in the last 48 hours.');
      return `Last run finished ${new Date(r.last).toISOString()}.`;
    }),
  ]);
  await admin.query(
    `insert into uptime_checks (component, ok, latency_ms, detail) values ${checks.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ')}`,
    checks.flatMap((x) => [x.component, x.ok, x.latency_ms, x.detail]),
  );
  const processJobs = (chainLib as Record<string, unknown>)['processPendingChainJobs'];
  if (typeof processJobs === 'function') await processJobs(env, 5);
}

async function dailyCleanup(env: Env) {
  await runScheduledReports(env, adminSql(env.DATABASE_URL)).catch((e) => console.error('scheduled reports', e));
  const admin = adminSql(env.DATABASE_URL);
  await admin.transaction([
    // Only sandboxes expire. Organizations and the shared network workspace are never removed here.
    admin`delete from workspaces where kind = 'sandbox' and expires_at is not null and expires_at < now()`,
    admin`delete from rate_limits where window_start < now() - interval '1 day'`,
    admin`delete from auth_challenges where expires_at < now()`,
    admin`delete from idempotency_keys where created_at < now() - interval '24 hours'`,
    admin`delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'`,
    admin`delete from uptime_checks where checked_at < now() - interval '120 days'`,
    admin`delete from request_log_samples where ts < now() - interval '30 days'`,
  ]);
  // Work queue digest to administrators and compliance officers of every organization with open items.
  try { const d = await sendDigests(env, admin); console.log(JSON.stringify({ job: 'work_digest', ...d })); }
  catch (e) { console.error('work digest failed', e); }
}

export { app, dailyCleanup, uptimeChecks };
export { setDriver, pgDriver } from './db';

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    setSelfFetch((r) => Promise.resolve(app.fetch(r, env, ctx)));
    return app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === '17 6 * * *') await dailyCleanup(env);
    else await uptimeChecks(env, ctx);
  },
} satisfies ExportedHandler<Env>;
