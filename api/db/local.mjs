// Starts an embedded Postgres 17 for local development (no Docker, no admin rights), builds the schema on first run,
// and writes api/.dev.local.vars so `node api/server.mjs` and the jobs use it.
//
//   node api/db/local.mjs          start (keeps running; Ctrl+C stops it)
//   node api/db/local.mjs reset    wipe the local database and start fresh
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '..');
const DATA = path.join(API, '.local', 'pgdata');
const PORT = Number(process.env.PGPORT || 54329);
const fresh = process.argv.includes('reset') || !fs.existsSync(DATA);
if (process.argv.includes('reset')) fs.rmSync(DATA, { recursive: true, force: true });

const pg = new EmbeddedPostgres({ databaseDir: DATA, user: 'postgres', password: 'laissez', port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('laissez');

const owner = `postgres://postgres:laissez@127.0.0.1:${PORT}/laissez`;
const tenant = `postgres://laissez_rt:laissez_rt@127.0.0.1:${PORT}/laissez`;
const vars = path.join(API, '.dev.local.vars');
const keep = fs.existsSync(vars) ? fs.readFileSync(vars, 'utf8').split('\n').filter((l) => l && !/^(DATABASE_URL|DATABASE_URL_TENANT)=/.test(l)) : [];
if (!keep.some((l) => l.startsWith('SIGNING_KEY_JWK='))) {
  const { webcrypto } = await import('node:crypto');
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  keep.push(`SIGNING_KEY_JWK=${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d })}`);
  const ec = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const ej = await webcrypto.subtle.exportKey('jwk', ec.privateKey);
  keep.push(`DEMO_IDP_JWK=${JSON.stringify({ kty: ej.kty, crv: ej.crv, x: ej.x, y: ej.y, d: ej.d })}`);
  keep.push(`SSO_ENC_KEY=${Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`);
  keep.push(`INTERNAL_TOKEN=${Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`);
}
fs.writeFileSync(vars, [...keep, `DATABASE_URL=${owner}`, `DATABASE_URL_TENANT=${tenant}`, ''].join('\n'), { mode: 0o600 });

if (fresh) {
  console.log('Building the schema (schema, globals, 12 migrations)...');
  const r = spawnSync(process.execPath, [path.join(HERE, 'setup.mjs')], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: owner, LAISSEZ_RT_PASSWORD: 'laissez_rt' } });
  if (r.status !== 0) { console.error('Schema setup failed.'); await pg.stop(); process.exit(1); }
}
console.log(`Local Postgres ready on port ${PORT}. Owner: ${owner}`);
console.log('Settings written to api/.dev.local.vars. Start the API with: npm run api:local');
const stop = async () => { console.log('\nStopping local Postgres'); await pg.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
