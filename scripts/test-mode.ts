// Checks the production mode guard without a database: imports the Hono app with LAISSEZ_MODE=production and a
// database driver that throws on first use, then asserts every fictional route answers 404 or 403 before any
// query runs, while the public metrics route still reaches its handler. Run with `npm run test:mode`.
import { app, setDriver } from '../api/src/index';
import { mode, FICTIONAL_ROUTES, SANDBOX_ONLY_ROUTES } from '../api/src/mode';

let failures = 0;
// The app logs one JSON line per request and the stub's stack traces; keep the test output to its own lines.
const out = (s: string) => process.stdout.write(s + '\n');
const errOut = (s: string) => process.stderr.write(s + '\n');
console.log = () => {}; console.error = () => {}; console.warn = () => {};
const fail = (msg: string) => { failures++; errOut(`FAIL  ${msg}`); };
const pass = (msg: string) => out(`ok    ${msg}`);

// Any query is a failure: the stub throws instead of connecting. The request logger samples 1 in 20 requests
// into Postgres, so Math.random is pinned above the sampling threshold to keep the run deterministic.
let dbCalls = 0;
setDriver(() => {
  const boom = (): never => { dbCalls++; throw new Error('database access in a guarded production route'); };
  const f: any = () => boom();
  f.query = () => boom();
  f.transaction = () => boom();
  return f;
});
Math.random = () => 0.999;

const base = 'https://api.test';
const env: any = {
  LAISSEZ_MODE: 'production', DATABASE_URL: 'postgres://stub', DATABASE_URL_TENANT: 'postgres://stub',
  ALLOWED_ORIGINS: 'https://app.test', MAX_ACTIVE_SANDBOXES: '500', APP_URL: 'https://app.test/app/', API_URL: base,
};
const ctx: any = { waitUntil: () => {}, passThroughOnException: () => {} };
const req = (method: string, path: string, body?: unknown) => app.fetch(new Request(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);

async function expect(method: string, path: string, status: number, code: string, body?: unknown) {
  const before = dbCalls;
  const res = await req(method, path, body);
  const j: any = await res.json().catch(() => ({}));
  if (res.status !== status) fail(`${method} ${path}: expected ${status} ${code}, got ${res.status} ${j?.error?.code ?? ''}`);
  else if (j?.error?.code !== code) fail(`${method} ${path}: expected code ${code}, got ${j?.error?.code}`);
  else if (dbCalls !== before) fail(`${method} ${path}: answered ${status} but touched the database first`);
  else pass(`${method} ${path} -> ${status} ${code}, no database access`);
}

if (mode(env) !== 'production') fail('mode(env) did not read LAISSEZ_MODE=production');
if (mode({}) !== 'sandbox') fail('mode({}) should default to sandbox');
if (mode({ LAISSEZ_MODE: 'Production' }) !== 'sandbox') fail('only the exact string production selects production mode');

await expect('POST', '/v1/sandboxes', 404, 'not_found', { name: 'x' });
await expect('GET', '/idp/.well-known/openid-configuration', 404, 'not_found');
await expect('GET', '/idp/jwks', 404, 'not_found');
await expect('GET', '/idp/authorize?client_id=laissez-sandbox', 404, 'not_found');
await expect('POST', '/idp/authorize', 404, 'not_found', {});
await expect('POST', '/idp/token', 404, 'not_found', {});
await expect('GET', '/v1/network/demo-ids', 404, 'not_found');
await expect('POST', '/v1/session/act-as', 403, 'sandbox_only', { user_id: null });
// A session token must not change the answer: the guard runs before authentication.
{
  const before = dbCalls;
  const res = await app.fetch(new Request(`${base}/v1/session/act-as`, { method: 'POST', headers: { authorization: 'Bearer lz_sess_abc', 'content-type': 'application/json' }, body: '{"user_id":null}' }), env, ctx);
  if (res.status !== 403 || dbCalls !== before) fail(`POST /v1/session/act-as with a token: expected 403 before auth, got ${res.status} with ${dbCalls - before} database call(s)`);
  else pass('POST /v1/session/act-as with a session token -> 403 before authentication');
}

// The guard list and the routes above must agree, so a route added to one is not forgotten in the other.
if (FICTIONAL_ROUTES.length !== 3 || SANDBOX_ONLY_ROUTES.length !== 1) fail(`guard lists changed (${FICTIONAL_ROUTES.length} fictional, ${SANDBOX_ONLY_ROUTES.length} sandbox-only): add the new routes to this test`);

// Public, non-fictional routes still reach their handlers (and therefore the database, which the stub reports).
{
  const before = dbCalls;
  const res = await req('GET', '/v1/metrics/public');
  const j: any = await res.json().catch(() => ({}));
  if (dbCalls === before) fail(`GET /v1/metrics/public never reached its handler (status ${res.status}, ${j?.error?.code ?? ''})`);
  else if (res.status !== 500) fail(`GET /v1/metrics/public: expected the stub database to fail the request with 500, got ${res.status}`);
  else pass('GET /v1/metrics/public still reaches its handler in production mode');
}
{
  const res = await req('GET', '/');
  const j: any = await res.json();
  if (j.mode !== 'production') fail(`GET / reports mode ${j.mode}, expected production`);
  else if ('sandbox' in j) fail('GET / still advertises POST /v1/sandboxes in production mode');
  else pass('GET / reports production mode and no sandbox link');
}
{
  const res = await req('GET', '/v1/errors');
  const j: any = await res.json();
  if (res.status !== 200 || !Array.isArray(j.data) || !j.data.find((e: any) => e.code === 'sandbox_only')) fail('GET /v1/errors did not return the catalogue');
  else pass(`GET /v1/errors serves ${j.data.length} codes`);
}
// Sandbox mode keeps the fictional routes reachable (they fail on the stub database, which proves the guard let them through).
{
  const sandboxEnv = { ...env, LAISSEZ_MODE: 'sandbox' };
  const before = dbCalls;
  const res = await app.fetch(new Request(`${base}/v1/sandboxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), sandboxEnv, ctx);
  if (dbCalls === before || res.status === 404) fail(`sandbox mode: POST /v1/sandboxes was blocked (status ${res.status})`);
  else pass('sandbox mode: POST /v1/sandboxes reaches its handler');
}

if (failures) { errOut(`\n${failures} check(s) failed.`); process.exit(1); }
out('\nAll mode checks passed.');
