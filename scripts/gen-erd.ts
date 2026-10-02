// Builds docs/erd.md from the SQL: every `create table` in api/db/schema.sql and api/db/migrate-*.sql, with the
// columns added later by `alter table ... add column`, grouped by domain into one Mermaid ER diagram per group.
// Relationships come from `references` clauses and from workspace_id columns (every tenant table hangs off
// workspaces). Run with `npm run docs:erd`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = join(root, 'api', 'db');

type Column = { name: string; type: string; pk: boolean; fk: string | null; notNull: boolean };
type Table = { name: string; columns: Column[]; file: string; pk: string[]; fks: { from: string[]; to: string }[] };
const tables = new Map<string, Table>();

const files = ['schema.sql', ...readdirSync(db).filter((f) => /^migrate-\d+.*\.sql$/.test(f)).sort()];
const SKIP = new Set(['primary', 'unique', 'constraint', 'check', 'foreign', 'exclude']);

/** Splits a column list on top-level commas (parentheses in types and checks stay intact). */
function splitTop(body: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
function parseColumn(def: string): Column | null {
  const m = def.match(/^"?([a-z_][a-z0-9_]*)"?\s+([a-z_]+(?:\s*\([^)]*\))?(?:\[\])?(?:\s+with time zone)?)/i);
  if (!m || SKIP.has(m[1].toLowerCase())) return null;
  const ref = def.match(/references\s+"?([a-z_][a-z0-9_]*)"?/i);
  return { name: m[1], type: m[2].replace(/\s+/g, ' ').toLowerCase(), pk: /primary key/i.test(def), fk: ref ? ref[1] : null, notNull: /not null/i.test(def) || /primary key/i.test(def) };
}

for (const file of files) {
  const sql = stripComments(readFileSync(join(db, file), 'utf8'));
  for (const m of sql.matchAll(/create table(?: if not exists)?\s+"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\)\s*(?:;|\n\s*\n|$)/gi)) {
    const name = m[1];
    const parts = splitTop(m[2]);
    const t: Table = tables.get(name) ?? { name, columns: [], file, pk: [], fks: [] };
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.startsWith('primary key')) { t.pk = splitTop(p.slice(p.indexOf('(') + 1, p.lastIndexOf(')'))).map((x) => x.replace(/"/g, '')); continue; }
      if (low.startsWith('foreign key')) { const cols = splitTop(p.slice(p.indexOf('(') + 1, p.indexOf(')'))).map((x) => x.replace(/"/g, '')); const to = p.match(/references\s+"?([a-z_][a-z0-9_]*)"?/i); if (to) t.fks.push({ from: cols, to: to[1] }); continue; }
      const c = parseColumn(p);
      if (!c) continue;
      if (!t.columns.some((x) => x.name === c.name)) t.columns.push(c);
      if (c.pk) t.pk.push(c.name);
      if (c.fk) t.fks.push({ from: [c.name], to: c.fk });
    }
    tables.set(name, t);
  }
  for (const m of sql.matchAll(/alter table(?: if exists)?\s+"?([a-z_][a-z0-9_]*)"?\s+((?:add column[^;]*?)(?=;|\n\s*\n|$))/gi)) {
    const t = tables.get(m[1]);
    if (!t) continue;
    for (const add of m[2].split(/,\s*add column/i)) {
      const c = parseColumn(add.replace(/^\s*add column(?: if not exists)?\s+/i, ''));
      if (c && !t.columns.some((x) => x.name === c.name)) { t.columns.push(c); if (c.fk) t.fks.push({ from: [c.name], to: c.fk }); }
    }
  }
}

// ---------- Domains ----------
const DOMAINS: [string, string, RegExp][] = [
  ['Tenancy and access', 'Organizations, people, sessions, keys and provisioning.', /^(workspaces|users|memberships|sessions|passkeys|invites|auth_challenges|api_keys|quotas|rate_limits|idempotency_keys|scim_tokens|recovery_codes|email_outbox|workspace_flags|feature_flags|leads|waitlist|org_deletions)$/],
  ['Clients and credentials', 'Investors, their eligibility credentials and the network of shared credentials.', /^(investors|credentials|classifications|credential_shares|portal_|investor_|evidence|consent|suitability|tax_)/],
  ['Funds and policy', 'Funds, distribution rules, policy changes, documents and fund operations.', /^(funds?$|fund_|policy_|documents?$|document_|doc_|nav|distributions?$|distribution_|redemption_|accruals?$|holdings|capital_|call_notices|commitments|concentration|dealing_|cutoff)/],
  ['Decisions and settlement', 'Pre-trade decisions, settlements, travel rule messages and batches.', /^(decisions|settlements|settlement_|travel_|trp_|batches|batch_|orders?$|order_|approvals?$|approval_)/],
  ['Compliance operations', 'Screening, monitoring, the work queue, rule packs and the regulatory feed.', /^(screening_|sanctions_|monitor_|work_items|hit_notes|holder_status|rule_|reg_|placement_|jurisdictions|investor_classes|booking_centers|calendars?$|calendar_|notifications?$|notification_)/],
  ['Audit and platform', 'The hash-chained audit log, webhooks, product analytics, status checks and the chain.', /^(audit_|webhooks|webhook_|product_events|uptime_checks|request_log_samples|schema_migrations|chain_|recon_|report_|anchors?$|versions?$|search_)/],
];
const domainOf = (name: string) => DOMAINS.find(([, , re]) => re.test(name))?.[0] ?? 'Other';

const mermaidType = (t: string) => t.replace(/\s*\([^)]*\)/g, '').replace(/\[\]/g, '_array').replace(/\s+/g, '_').replace(/timestamp_with_time_zone/, 'timestamptz');
function entity(t: Table): string {
  const lines = t.columns.map((c) => {
    const keys = [t.pk.includes(c.name) ? 'PK' : null, t.fks.some((f) => f.from.includes(c.name)) ? 'FK' : null].filter(Boolean).join(',');
    return `    ${mermaidType(c.type)} ${c.name}${keys ? ` ${keys}` : ''}`;
  });
  return `  ${t.name} {\n${lines.join('\n')}\n  }`;
}
function relations(group: Table[], all: Map<string, Table>): string[] {
  const names = new Set(group.map((t) => t.name));
  const out = new Set<string>();
  for (const t of group) {
    for (const f of t.fks) {
      if (!all.has(f.to) || f.to === t.name) continue;
      const label = f.from.join('_');
      // Relationships to a table in another group are drawn as a reference to keep each diagram readable.
      if (!names.has(f.to)) out.add(`  ${f.to} ||--o{ ${t.name} : ${label}`);
      else out.add(`  ${f.to} ||--o{ ${t.name} : ${label}`);
    }
    if (!t.fks.some((f) => f.to === 'workspaces') && t.columns.some((c) => c.name === 'workspace_id') && t.name !== 'workspaces') out.add(`  workspaces ||--o{ ${t.name} : workspace_id`);
  }
  return [...out];
}

const groups = new Map<string, Table[]>();
for (const t of [...tables.values()].sort((a, b) => a.name.localeCompare(b.name))) (groups.get(domainOf(t.name)) ?? groups.set(domainOf(t.name), []).get(domainOf(t.name))!).push(t);
const order = [...DOMAINS.map(([n]) => n), 'Other'].filter((n) => groups.has(n));

const md: string[] = [
  '# Data model',
  '',
  `Generated from \`api/db/schema.sql\` and the migrations by \`npm run docs:erd\`. ${tables.size} tables in ${order.length} domains. Every tenant table carries \`workspace_id\` and a row-level security policy (\`migrate-003-rls.sql\`); admin-only tables have no grant to \`laissez_rt\`.`,
  '',
  'Column types are Postgres types with lengths and checks removed. PK marks primary key columns, FK columns that reference another table. Cross-domain references are drawn with the referenced table repeated in the diagram.',
  '',
  '## Domains',
  '',
  ...order.map((n) => `- ${n}: ${groups.get(n)!.map((t) => `\`${t.name}\``).join(', ')}`),
  '',
];
for (const n of order) {
  const group = groups.get(n)!;
  const desc = DOMAINS.find(([d]) => d === n)?.[1] ?? 'Tables that do not fit another domain.';
  const rels = relations(group, tables);
  // Tables referenced from outside the group appear as stubs so Mermaid can draw the edge.
  const stubs = [...new Set(rels.map((r) => r.trim().split(' ')[0]))].filter((name) => !group.some((t) => t.name === name) && tables.has(name));
  md.push(`## ${n}`, '', desc, '', '```mermaid', 'erDiagram', ...group.map(entity), ...stubs.map((s) => `  ${s} {\n    ${mermaidType(tables.get(s)!.columns[0]?.type ?? 'uuid')} ${tables.get(s)!.columns[0]?.name ?? 'id'} PK\n  }`), ...rels, '```', '');
  md.push('| Table | Defined in | Columns |', '| --- | --- | --- |', ...group.map((t) => `| \`${t.name}\` | \`api/db/${t.file}\` | ${t.columns.length} |`), '');
}
writeFileSync(join(root, 'docs', 'erd.md'), md.join('\n'));
console.log(`ok    ${tables.size} tables in ${order.length} domains from ${files.length} SQL files`);
console.log('ok    wrote docs/erd.md');
