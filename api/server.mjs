// Runs the Laissez API as a plain Node server against any Postgres, with no Cloudflare and no Neon.
//
//   node api/server.mjs            (reads api/.dev.vars or api/.dev.local.vars for DATABASE_URL etc.)
//
// The same Hono app the Worker runs is bundled on the fly with esbuild, and the database layer is switched to
// node-postgres through setDriver(). Scheduled jobs (uptime checks every 10 minutes, cleanup daily) run on timers.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Environment: .dev.local.vars (local database) wins over .dev.vars (cloud secrets) so local work never touches Neon.
const env = { ...process.env };
for (const f of ['.dev.vars', '.dev.local.vars']) {
  const p = path.join(HERE, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
// LZ_OVERRIDE_<NAME> in the process environment wins over both files, so tests can start a second server in another mode.
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LZ_OVERRIDE_')) env[k.slice('LZ_OVERRIDE_'.length)] = v;
const PORT = Number(env.PORT || 8787);
env.API_URL ||= `http://127.0.0.1:${PORT}`;
env.APP_URL ||= 'http://localhost:4321/laissez/app/';
env.ALLOWED_ORIGINS ||= 'http://localhost:4321,http://127.0.0.1:4321,https://parikshit7319.github.io';
env.MAX_ACTIVE_SANDBOXES ||= '500';
env.CHAIN_RPC_URL ||= 'https://sepolia.base.org';
if (!env.DATABASE_URL) { console.error('DATABASE_URL is not set. Run `npm run db:local` first, or set it in api/.dev.local.vars.'); process.exit(2); }

// Bundle the Worker entry for Node (esbuild is a dev dependency at the repo root).
const esbuild = require(path.join(HERE, '..', 'node_modules', 'esbuild'));
const outfile = path.join(HERE, '.local', 'server-bundle.mjs');
fs.mkdirSync(path.dirname(outfile), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(HERE, 'src', 'index.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'warning', target: 'node20',
  external: ['pg', 'pg-native'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
const { app, dailyCleanup, uptimeChecks } = mod;
// Switch the database layer to node-postgres (exported from the bundle for exactly this purpose).
const pg = require(path.join(HERE, 'node_modules', 'pg'));
if (typeof mod.setDriver === 'function' && typeof mod.pgDriver === 'function') mod.setDriver(mod.pgDriver(pg));
else console.warn('setDriver is not exported from the bundle; the Neon HTTP driver will be used.');

const ctx = () => ({ waitUntil: (p) => { Promise.resolve(p).catch((e) => console.error(e)); }, passThroughOnException() {} });

// Minimal Node HTTP bridge around the Fetch API handler.
const http = require('node:http');
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
  const url = `http://${req.headers.host || `127.0.0.1:${PORT}`}${req.url}`;
  const request = new Request(url, { method: req.method, headers, body: body && !['GET', 'HEAD'].includes(req.method) ? body : undefined, redirect: 'manual' });
  try {
    const response = await app.fetch(request, env, ctx());
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'internal_error', message: 'The local server hit an error. See the terminal.' } }));
  }
});
server.listen(PORT, () => {
  console.log(`Laissez API (Node mode) on ${env.API_URL}`);
  console.log(`Database: ${env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
});
setInterval(() => uptimeChecks(env, ctx()).catch((e) => console.error(e)), 10 * 60_000);
setInterval(() => dailyCleanup(env).catch((e) => console.error(e)), 24 * 60 * 60_000);
