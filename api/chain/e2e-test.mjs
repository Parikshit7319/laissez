// End-to-end proof for the API side: runs api/src/chain.ts and api/src/routes/chain.ts against a local Hardhat
// node and a throwaway Postgres 16 cluster loaded with api/db/schema.sql and every migration.
// Usage (as root on a machine with PostgreSQL 16 server binaries): node api/chain/e2e-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from './compile.mjs';
import { deploy, deploymentSql } from './deploy.mjs';
import { startNode, DEV_KEYS } from './localnode.mjs';
import { HERE } from './lib.mjs';
import { newPool } from './e2e/pg-sql.mjs';

const API = path.resolve(HERE, '..');
const ROOT = path.resolve(API, '..');
const PG_BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin'].find((d) => fs.existsSync(path.join(d, 'initdb')));
if (!PG_BIN) { console.log('SKIP  PostgreSQL server binaries were not found, so the end-to-end test cannot run here.'); process.exit(0); }
const PORT = 55433;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laissez-e2e-'));
const data = path.join(tmp, 'pg');
const asPostgres = (bin, args) => {
  const r = spawnSync('runuser', ['-u', 'postgres', '--', path.join(PG_BIN, bin), ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
let pgStarted = false;
let node = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (node) node.stop();
  if (pgStarted) { try { asPostgres('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']); } catch { /* already stopped */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

try {
  // 1. Postgres with the real schema and migrations.
  fs.mkdirSync(data);
  execFileSync('chown', ['-R', 'postgres:postgres', tmp]);
  asPostgres('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--no-sync']);
  asPostgres('pg_ctl', ['-D', data, '-o', `-p ${PORT} -k ${data} -c fsync=off -c listen_addresses=127.0.0.1`, '-l', path.join(tmp, 'pg.log'), '-w', 'start']);
  pgStarted = true;
  const base = `postgres://postgres@127.0.0.1:${PORT}`;
  const boot = newPool(`${base}/postgres`);
  await boot.query('create database laissez');
  await boot.end();
  const url = `${base}/laissez`;
  const pool = newPool(url);
  const runFile = async (f) => {
    const text = fs.readFileSync(path.join(API, 'db', f), 'utf8');
    const parts = f.startsWith('migrate') ? text.split(/\n-- ;\n/).map((s) => s.replace(/^\s*(--[^\n]*\n)*/g, '').trim()).filter(Boolean) : [text];
    for (const s of parts) {
      try { await pool.query(s); } catch (e) { throw new Error(`${f}: ${e.message}\n${s.slice(0, 300)}`); }
    }
  };
  await runFile('schema.sql');
  // Tables the production database has from before migrate-002 that schema.sql does not define. Test stand-ins only.
  await pool.query(`
    create table if not exists screening_list (name text primary key, program text not null, note text);
    create table if not exists rate_limits (key text primary key, window_start timestamptz not null, count int not null);
    create table if not exists webhooks (workspace_id uuid not null references workspaces(id) on delete cascade, id text not null, url text not null, secret text not null, events text[] not null, created_at timestamptz not null default now(), primary key (workspace_id, id));
    create table if not exists webhook_deliveries (id bigserial primary key, workspace_id uuid not null references workspaces(id) on delete cascade, webhook_id text not null, event text not null, status int, attempts int, response_ms int, payload text, created_at timestamptz not null default now());
    create table if not exists policy_changes (workspace_id uuid not null references workspaces(id) on delete cascade, id text not null, ticker text not null, proposed_by text, status text not null default 'draft', changes jsonb not null default '{}', impact jsonb, approved_by text, decided_at timestamptz, created_at timestamptz not null default now(), primary key (workspace_id, id));
    create table if not exists rule_drafts (workspace_id uuid not null references workspaces(id) on delete cascade, id text not null, source text, jurisdiction text, draft jsonb not null default '{}', status text not null default 'draft', reviewer text, created_at timestamptz not null default now(), primary key (workspace_id, id));
  `);
  if (fs.existsSync(path.join(API, 'db', 'seed-globals.sql'))) await runFile('seed-globals.sql');
  await pool.query("create role laissez_rt login password 'e2e'");
  for (const f of fs.readdirSync(path.join(API, 'db')).filter((x) => /^migrate-\d+.*\.sql$/.test(x)).sort()) await runFile(f);
  console.log('ok    Postgres ready with schema and migrations');

  // 2. Hardhat node and the full contract stack.
  compile();
  node = await startNode(8547);
  const seed = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const d = await deploy({ rpcUrl: node.url, operatorKey: DEV_KEYS.operator, claimKey: DEV_KEYS.claim, custodySeed: seed, outFile: path.join(tmp, 'deployment.json'), log: () => {} });
  for (const s of deploymentSql(d)) await pool.query(s);
  await pool.end();
  console.log('ok    Contracts deployed and recorded in chain_config\n');

  // 3. Bundle the TypeScript harness (it imports the real API modules) and run it.
  const outDir = path.join(HERE, '.e2e');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'harness.mjs');
  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
  execFileSync(esbuild, [path.join(HERE, 'e2e', 'harness.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${out}`, '--log-level=warning'], { stdio: 'inherit' });
  const r = spawnSync(process.execPath, [out], {
    stdio: 'inherit',
    env: { ...process.env, E2E_PG_URL: url, CHAIN_RPC_URL: node.url, CHAIN_OPERATOR_KEY: DEV_KEYS.operator, CHAIN_CLAIM_KEY: DEV_KEYS.claim, CHAIN_CUSTODY_SEED: seed },
  });
  process.exitCode = r.status ?? 1;
} catch (e) {
  console.error(`FAIL  ${e.message}`);
  process.exitCode = 1;
}
// The Hardhat child keeps the event loop alive, so stop everything and exit explicitly.
cleanup();
process.exit(process.exitCode ?? 0);
