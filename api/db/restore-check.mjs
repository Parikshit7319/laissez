// Checks a database after a restore or a restore drill. Read-only.
//
//   DATABASE_URL=<owner url of the restored branch> node db/restore-check.mjs
//
// It answers four questions a restore has to answer before traffic goes back:
//   1. Is every table the migrations create present?
//   2. Is row-level security still on for every table that carries a workspace_id?
//   3. Does every organization's audit chain still verify, hash by hash?
//   4. How far back did the restore land (newest audit event, newest settlement, newest invoice)?
// Exit code 0 when 1 to 3 pass, 1 otherwise. Print the output into the drill record.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL to the owner connection string of the database to check.'); process.exit(2); }

// Neon speaks HTTP in the Worker; a local Postgres needs the wire protocol. Use whichever fits the host.
let query;
if (/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  const pg = createRequire(path.join(here, '..', 'package.json'))('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  query = async (text) => (await client.query(text)).rows;
  process.on('exit', () => client.end().catch(() => {}));
} else {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  query = (text) => sql.query(text);
}

let failed = 0;
const ok = (msg) => console.log(`PASS  ${msg}`);
const bad = (msg) => { failed++; console.log(`FAIL  ${msg}`); };

// 1. Tables from the migrations
const expected = new Set();
for (const f of fs.readdirSync(here).filter((n) => /^(schema|migrate-\d+.*)\.sql$/.test(n))) {
  const text = fs.readFileSync(path.join(here, f), 'utf8');
  for (const m of text.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) expected.add(m[1].toLowerCase());
}
const have = new Set((await query(`select tablename from pg_tables where schemaname = 'public'`)).map((r) => r.tablename));
const missing = [...expected].filter((t) => !have.has(t));
missing.length ? bad(`${missing.length} table(s) missing: ${missing.join(', ')}`) : ok(`all ${expected.size} tables created by the migrations exist`);

// 2. Row-level security
const noRls = await query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)
  order by 1`);
// A table without a policy is only a problem when the tenant role can read it. Owner-only tables get no grant.
const exposed = noRls.map((r) => r.relname);
const tenantGrants = exposed.length ? await query(`select table_name from information_schema.role_table_grants where grantee = 'laissez_rt' and table_schema = 'public' and table_name in (${exposed.map((t) => `'${t}'`).join(',')}) group by 1`) : [];
const exposedWithGrant = tenantGrants.map((r) => r.table_name);
exposedWithGrant.length ? bad(`row-level security is off on tables the tenant role can read: ${exposedWithGrant.join(', ')}`) : ok('every table the tenant role can read has row-level security on');
const role = await query(`select rolname, rolbypassrls, rolsuper from pg_roles where rolname = 'laissez_rt'`);
if (!role.length) bad('the tenant role laissez_rt does not exist: run api/db/setup.mjs to recreate it, then set its password');
else if (role[0].rolbypassrls || role[0].rolsuper) bad('laissez_rt can bypass row-level security');
else ok('laissez_rt exists and cannot bypass row-level security');

// 3. Audit chains, every organization
const [chain] = await query(`
  with e as (
    select workspace_id, seq, hash, prev_hash,
      audit_hash(seq, workspace_id, type, subject, data, actor, created_at, prev_hash) as calc,
      lag(hash) over (partition by workspace_id order by seq) as lag_hash,
      lag(seq) over (partition by workspace_id order by seq) as lag_seq
    from audit_events
  )
  select count(*)::int as events, count(distinct workspace_id)::int as organizations,
    count(*) filter (where calc is distinct from hash)::int as bad_hashes,
    count(*) filter (where case when lag_seq is null then seq <> 1 or prev_hash is distinct from repeat('0', 64) else seq <> lag_seq + 1 or prev_hash is distinct from lag_hash end)::int as broken_links
  from e`);
if (chain.bad_hashes || chain.broken_links) bad(`audit chain broken: ${chain.bad_hashes} bad hash(es), ${chain.broken_links} broken link(s) across ${chain.events} events`);
else ok(`audit chains verify: ${chain.events} events across ${chain.organizations} organizations`);

// 4. How far back did it land
const [latest] = await query(`select
  (select max(created_at)::text from audit_events) as audit,
  (select max(created_at)::text from settlements) as settlement,
  (select max(created_at)::text from invoices) as invoice,
  (select count(*)::int from workspaces where kind = 'org') as organizations,
  (select count(*)::int from users) as users`);
console.log(`INFO  newest audit event ${latest.audit ?? 'none'}, newest settlement ${latest.settlement ?? 'none'}, newest invoice ${latest.invoice ?? 'none'}`);
console.log(`INFO  ${latest.organizations} organizations, ${latest.users} users`);
console.log(failed ? `\n${failed} check(s) failed. Do not send traffic to this database.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
