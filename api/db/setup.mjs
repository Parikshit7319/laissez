// Builds a Laissez database from nothing, or brings an existing one up to date.
//
//   DATABASE_URL=postgres://... node api/db/setup.mjs
//
// Order: schema.sql, seed-globals.sql, then every api/db/migrate-*.sql in file order. On a database that already
// has the base tables, schema.sql and seed-globals.sql are skipped and only the (idempotent) migrations run.
// When LAISSEZ_RT_PASSWORD is set the tenant role laissez_rt is created or given that password; otherwise the role
// is created without login so migrate-003 can grant to it, and you set the password later with
//   alter role laissez_rt login password '...';
//
// Reads api/.dev.vars for DATABASE_URL and LAISSEZ_RT_PASSWORD when they are not in the environment.
// Works against local Postgres (docker-compose.yml) and Neon alike over the standard wire protocol (node-postgres).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '..');
const ROOT = path.resolve(API, '..');

if (fs.existsSync(path.join(API, '.dev.vars'))) {
  for (const line of fs.readFileSync(path.join(API, '.dev.vars'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL (the owner connection string). Example: postgres://postgres:laissez@127.0.0.1:5432/laissez'); process.exit(2); }

/** node-postgres from whichever package in the repo has it installed. */
function loadPg() {
  for (const dir of [API, path.join(API, 'chain'), ROOT, HERE]) {
    try { return createRequire(path.join(dir, 'package.json')).call(null, 'pg'); } catch { /* try the next */ }
  }
  console.error('The pg package is not installed. Run: cd api && npm install --no-save pg');
  process.exit(2);
}
const pg = loadPg();

const ssl = /neon\.tech|sslmode=require|sslmode=verify/.test(url) ? { rejectUnauthorized: false } : undefined;
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[a-z-]+/, ''), ssl });
const quoteLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Splits a migration file on the "-- ;" separator lines; schema and seed files run whole. */
function statementsOf(file, text) {
  if (!path.basename(file).startsWith('migrate')) return [text];
  return text.split(/\n-- ;\n/).map((s) => s.replace(/^\s*(--[^\n]*\n)*/g, '').trim()).filter(Boolean);
}
async function runFile(file) {
  const text = fs.readFileSync(path.join(HERE, file), 'utf8');
  const parts = statementsOf(file, text);
  let n = 0;
  for (const s of parts) {
    try { await client.query(s); n++; }
    catch (e) { throw new Error(`${file}, statement ${n + 1}: ${e.message}\n${s.slice(0, 400)}`); }
  }
  return n;
}

const dryRun = process.argv.includes('--dry-run');
try {
  await client.connect();
  const [{ rows: [db] }, { rows: [ext] }] = await Promise.all([
    client.query('select current_database() as name, version() as version'),
    client.query(`select count(*)::int as n from pg_available_extensions where name = 'pg_trgm'`),
  ]);
  console.log(`Database ${db.name}: ${db.version.split(',')[0]}`);
  if (!ext.n) console.warn('warning: the pg_trgm extension is not available on this server. migrate-002 needs it for sanctions name matching.');

  const migrations = fs.readdirSync(HERE).filter((f) => /^migrate-\d+.*\.sql$/.test(f)).sort();
  const { rows: [{ fresh }] } = await client.query(`select to_regclass('public.jurisdictions') is null as fresh`);
  const plan = [...(fresh ? ['schema.sql', 'seed-globals.sql'] : []), ...migrations];
  console.log(`${fresh ? 'Fresh database.' : 'Existing database, base tables present: schema.sql and seed-globals.sql skipped.'} Will run: ${plan.join(', ')}`);
  if (dryRun) process.exit(0);

  // Tenant role. migrate-003 grants to it, so it has to exist before the migrations run.
  const password = process.env.LAISSEZ_RT_PASSWORD;
  const { rows: [{ exists }] } = await client.query(`select exists (select 1 from pg_roles where rolname = 'laissez_rt') as exists`);
  if (!exists) {
    await client.query(password ? `create role laissez_rt login password ${quoteLiteral(password)}` : 'create role laissez_rt nologin');
    console.log(password ? 'Created role laissez_rt with login.' : 'Created role laissez_rt without login. Set LAISSEZ_RT_PASSWORD and rerun, or: alter role laissez_rt login password \'...\';');
  } else if (password) {
    await client.query(`alter role laissez_rt login password ${quoteLiteral(password)}`);
    console.log('Updated the laissez_rt password.');
  }

  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now(), statements int not null)`);
  for (const file of plan) {
    const n = await runFile(file);
    await client.query(`insert into schema_migrations (name, statements) values ($1, $2) on conflict (name) do update set applied_at = now(), statements = excluded.statements`, [file, n]);
    console.log(`  ${file}: ${n} statement${n === 1 ? '' : 's'}`);
  }
  const { rows: [{ tables }] } = await client.query(`select count(*)::int as tables from pg_tables where schemaname = 'public'`);
  console.log(`Done. ${tables} tables in public.`);
} catch (e) {
  console.error(`FAIL  ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
