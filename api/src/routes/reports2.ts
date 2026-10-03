// Report builder: saved report definitions over whitelisted sources (investors, decisions, settlements,
// holdings, audit), run on demand as rows or CSV, or delivered on a schedule by email. The client never sends
// SQL: it names columns and operators from the catalog below, and every value is a bound parameter.
// Mounted by routes/reports.ts under /v1. runScheduledReports is exported for the daily cron (index.ts).
import { csvCell } from '../../../src/proto/csv';
import { z } from 'zod';
import type { Context } from 'hono';
import { router, need, body, auditQ, audit, type C } from '../http';
import type { Sql } from '../db';
import { ApiError, id as newId, today, type Env } from '../util';
import { sendEmail, deliverable, type EmailKind } from '../email';

export const routes = router();

// ---------- Catalog ----------
export type ColType = 'text' | 'number' | 'date' | 'datetime' | 'bool';
type Col = { key: string; label: string; type: ColType; sql: string; /** Numeric columns summed when grouping. */ sum?: boolean };
type Source = { key: string; label: string; perm: string; /** Alias of the base table in `from`, for the tenant filter. */ alias: string; from: string; default: string[]; order: string; columns: Col[] };

const T = (key: string, label: string, sql: string): Col => ({ key, label, type: 'text', sql });
const N = (key: string, label: string, sql: string, sum = true): Col => ({ key, label, type: 'number', sql, sum });
const D = (key: string, label: string, sql: string): Col => ({ key, label, type: 'date', sql });
const DT = (key: string, label: string, sql: string): Col => ({ key, label, type: 'datetime', sql });
const B = (key: string, label: string, sql: string): Col => ({ key, label, type: 'bool', sql });

export const SOURCES: Source[] = [
  {
    key: 'investors', label: 'Clients', perm: 'read', alias: 'i', order: 'i.created_at desc',
    from: `investors i
      left join lateral (select c.id as cred_id, c.lzid, c.expires_on from credentials c where c.workspace_id = i.workspace_id and c.investor_id = i.id and c.status = 'active' order by c.created_at desc limit 1) c on true
      left join jurisdictions j on j.code = i.residence`,
    default: ['id', 'name', 'kind', 'residence', 'booking_center', 'credential_expires'],
    columns: [
      T('id', 'Client id', 'i.id'), T('name', 'Name', 'i.name'), T('kind', 'Type', 'i.kind'), T('residence', 'Residence', 'i.residence'), T('residence_name', 'Residence name', 'j.name'),
      T('city', 'City', 'i.city'), T('booking_center', 'Booking center', 'i.booking_center'), B('us_person', 'U.S. person', 'i.us_person'), T('email', 'Email', 'i.email'),
      T('credential_id', 'Credential', 'c.cred_id'), T('lzid', 'Passport number', 'c.lzid'), D('credential_expires', 'Credential expires', 'c.expires_on'),
      B('relied_credential', 'Relies on another distributor', '(i.relied_share is not null)'), DT('created_at', 'Created', 'i.created_at'),
    ],
  },
  {
    key: 'decisions', label: 'Decisions', perm: 'read', alias: 'd', order: 'd.created_at desc',
    from: `decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id`,
    default: ['created_at', 'id', 'action', 'investor', 'residence', 'ticker', 'amount', 'outcome', 'settlement_status'],
    columns: [
      DT('created_at', 'Decided', 'd.created_at'), T('id', 'Decision id', 'd.id'), T('action', 'Action', 'd.action'), T('investor_id', 'Client id', 'd.investor_id'), T('investor', 'Client', 'i.name'),
      T('residence', 'Residence', 'i.residence'), T('booking_center', 'Booking center', 'i.booking_center'), T('counterparty_id', 'Counterparty id', 'd.counterparty_id'), T('ticker', 'Fund', 'd.ticker'),
      N('amount', 'Amount', 'd.amount::float8'), T('asset', 'Settlement asset', 'd.asset'), T('outcome', 'Outcome', 'd.outcome'), T('headline', 'Headline', 'd.headline'), D('dealing_date', 'Dealing date', 'd.dealing_date'),
      B('hypothetical', 'What-if', '(coalesce(array_length(d.what_ifs, 1), 0) > 0)'), T('rule_packs', 'Rule packs', `array_to_string(d.rule_packs, ' ')`), T('inputs_sha256', 'Inputs hash', 'd.inputs_sha256'),
      T('actor', 'Requested by', 'd.actor'), T('settlement_id', 'Settlement id', 's.id'), T('settlement_status', 'Settlement status', 's.status'), T('capital_call_id', 'Capital call', 'd.capital_call_id'),
    ],
  },
  {
    key: 'settlements', label: 'Settlements', perm: 'read', alias: 's', order: 's.created_at desc',
    from: `settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker`,
    default: ['created_at', 'id', 'status', 'action', 'investor', 'ticker', 'amount', 'currency'],
    columns: [
      DT('created_at', 'Settled at', 's.created_at'), T('id', 'Settlement id', 's.id'), T('decision_id', 'Decision id', 's.decision_id'), T('status', 'Status', 's.status'), T('action', 'Action', 'd.action'),
      T('investor_id', 'Client id', 'd.investor_id'), T('investor', 'Client', 'i.name'), T('residence', 'Residence', 'i.residence'), T('booking_center', 'Booking center', 'i.booking_center'), T('ticker', 'Fund', 'd.ticker'),
      T('currency', 'Currency', 'f.currency'), N('amount', 'Amount', 'd.amount::float8'), N('units', 'Units', 'd.units::float8'), T('asset', 'Settlement asset', 'd.asset'),
      B('simulated', 'Simulated', `coalesce((s.steps->>'simulated')::boolean, true)`), T('tx_hash', 'Transaction hash', `s.chain->>'tx_hash'`),
    ],
  },
  {
    key: 'holdings', label: 'Holdings', perm: 'read', alias: 'h', order: 'h.ticker, i.name',
    from: `holdings h join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id join funds f on f.workspace_id = h.workspace_id and f.ticker = h.ticker
      left join holder_status hs on hs.workspace_id = h.workspace_id and hs.investor_id = h.investor_id and hs.ticker = h.ticker left join jurisdictions j on j.code = i.residence`,
    default: ['ticker', 'investor', 'residence', 'units', 'value', 'currency', 'since', 'holder_status'],
    columns: [
      T('ticker', 'Fund', 'h.ticker'), T('fund', 'Fund name', 'f.name'), T('investor_id', 'Client id', 'h.investor_id'), T('investor', 'Client', 'i.name'), T('kind', 'Client type', 'i.kind'),
      T('residence', 'Residence', 'i.residence'), T('residence_name', 'Residence name', 'j.name'), T('booking_center', 'Booking center', 'i.booking_center'),
      N('units', 'Units', 'h.units::float8'), N('value', 'Value', 'round(h.units * f.nav, 2)::float8'), T('currency', 'Currency', 'f.currency'), N('nav', 'NAV', 'f.nav::float8', false),
      D('since', 'Holder since', 'h.since'), T('holder_status', 'Holder status', 'hs.status'), T('holder_reason', 'Status reason', 'hs.reason'),
    ],
  },
  {
    key: 'audit', label: 'Audit log', perm: 'audit:export', alias: 'a', order: 'a.seq desc nulls last, a.created_at desc',
    from: `audit_events a`,
    default: ['created_at', 'seq', 'type', 'subject', 'actor_name'],
    columns: [
      DT('created_at', 'When', 'a.created_at'), N('seq', 'Sequence', 'a.seq::float8', false), T('type', 'Event', 'a.type'), T('subject', 'Subject', 'a.subject'), T('actor', 'Actor', 'a.actor'),
      T('actor_name', 'Actor name', 'a.actor_name'), T('hash', 'Hash', 'a.hash'), T('prev_hash', 'Previous hash', 'a.prev_hash'), T('data', 'Data (JSON)', 'a.data::text'),
    ],
  },
];
const sourceOf = (key: string) => SOURCES.find((s) => s.key === key);

export const OPERATORS: Record<ColType, string[]> = {
  text: ['eq', 'neq', 'in', 'contains', 'starts_with', 'is_null', 'not_null'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'last_days', 'is_null', 'not_null'],
  datetime: ['gt', 'gte', 'lt', 'lte', 'between', 'last_days', 'is_null', 'not_null'],
  bool: ['eq', 'is_null', 'not_null'],
};
const SCHEDULES = ['daily', 'weekly', 'monthly'] as const;
const ROW_LIMIT = 5000;

const filterZ = z.object({ column: z.string().min(1).max(40), op: z.string().min(1).max(20), value: z.unknown().optional() });
const sortZ = z.object({ column: z.string().min(1).max(40), dir: z.enum(['asc', 'desc']).default('asc') });
export const definitionIn = z.object({
  name: z.string().trim().min(2).max(120),
  source: z.enum(['investors', 'decisions', 'settlements', 'holdings', 'audit']),
  columns: z.array(z.string().min(1).max(40)).min(1).max(30),
  filters: z.array(filterZ).max(20).default([]),
  group_by: z.array(z.string().min(1).max(40)).max(5).default([]),
  sort: z.array(sortZ).max(3).default([]),
  schedule: z.enum(SCHEDULES).nullable().optional(),
  recipients: z.array(z.string().trim().toLowerCase().email().max(160)).max(20).default([]),
});
export type DefinitionIn = z.infer<typeof definitionIn>;

// ---------- Query compiler ----------
type Compiled = { text: string; params: unknown[]; header: { key: string; label: string; type: ColType }[]; grouped: boolean };
const esc = (s: string) => s.replace(/"/g, '""');
/**
 * Compiles a definition into one parameterized SQL statement. Columns, operators, group-by and sort keys must
 * come from the catalog; anything else is refused with a 422 that names the offending key.
 */
export function compile(def: DefinitionIn, ws: string, limit = ROW_LIMIT): Compiled {
  const src = sourceOf(def.source);
  if (!src) throw new ApiError(422, 'unknown_source', `Unknown report source ${def.source}.`);
  const col = (k: string, what: string) => {
    const c = src.columns.find((x) => x.key === k);
    if (!c) throw new ApiError(422, 'unknown_column', `${what} ${k} is not a column of ${src.label}. See GET /v1/reports/catalog.`);
    return c;
  };
  const params: unknown[] = [ws];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [`${src.alias}.workspace_id = $1`];
  for (const f of def.filters) {
    const c = col(f.column, 'Filter column');
    if (!OPERATORS[c.type].includes(f.op)) throw new ApiError(422, 'unknown_operator', `Operator ${f.op} does not apply to ${c.label} (${c.type}). Allowed: ${OPERATORS[c.type].join(', ')}.`);
    const v = f.value;
    const num = (x: unknown) => { const n = Number(x); if (!Number.isFinite(n)) throw new ApiError(422, 'invalid_value', `${c.label} needs a number, got ${JSON.stringify(x)}.`); return n; };
    const dat = (x: unknown) => { const s = String(x ?? ''); if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s) || Number.isNaN(Date.parse(s))) throw new ApiError(422, 'invalid_value', `${c.label} needs a date like 2026-10-01, got ${JSON.stringify(x)}.`); return s; };
    const scalar = (x: unknown) => c.type === 'number' ? num(x) : c.type === 'date' || c.type === 'datetime' ? dat(x) : c.type === 'bool' ? (x === true || x === 'true') : String(x ?? '');
    const cast = c.type === 'date' ? '::date' : c.type === 'datetime' ? '::timestamptz' : c.type === 'number' ? '::float8' : c.type === 'bool' ? '::boolean' : '::text';
    switch (f.op) {
      case 'eq': where.push(`${c.sql} = ${p(scalar(v))}${cast}`); break;
      case 'neq': where.push(`${c.sql} is distinct from ${p(scalar(v))}${cast}`); break;
      case 'gt': where.push(`${c.sql} > ${p(scalar(v))}${cast}`); break;
      case 'gte': where.push(`${c.sql} >= ${p(scalar(v))}${cast}`); break;
      case 'lt': where.push(`${c.sql} < ${p(scalar(v))}${cast}`); break;
      case 'lte': where.push(`${c.sql} <= ${p(scalar(v))}${cast}`); break;
      case 'between': {
        const [a, b] = Array.isArray(v) ? v : [];
        if (a === undefined || b === undefined) throw new ApiError(422, 'invalid_value', `${c.label} between needs a two-element array [from, to].`);
        where.push(`${c.sql} between ${p(scalar(a))}${cast} and ${p(scalar(b))}${cast}`); break;
      }
      case 'in': {
        const list = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
        if (!list.length) throw new ApiError(422, 'invalid_value', `${c.label} in needs at least one value.`);
        where.push(`${c.sql} = any(${p(list)}::text[])`); break;
      }
      case 'contains': where.push(`${c.sql} ilike ${p(`%${String(v ?? '').replace(/[%_\\]/g, (m) => `\\${m}`)}%`)}`); break;
      case 'starts_with': where.push(`${c.sql} ilike ${p(`${String(v ?? '').replace(/[%_\\]/g, (m) => `\\${m}`)}%`)}`); break;
      case 'last_days': { const n = Math.max(1, Math.min(3650, Math.floor(num(v)))); where.push(`${c.sql} >= now() - make_interval(days => ${p(n)}::int)`); break; }
      case 'is_null': where.push(`${c.sql} is null`); break;
      case 'not_null': where.push(`${c.sql} is not null`); break;
    }
  }
  const groups = def.group_by.map((k) => col(k, 'Group-by column'));
  const grouped = groups.length > 0;
  let select: string[]; let header: Compiled['header'];
  if (grouped) {
    const sums = def.columns.map((k) => col(k, 'Column')).filter((c) => c.sum && !groups.some((g) => g.key === c.key));
    select = [...groups.map((g) => `${g.sql} as "${esc(g.key)}"`), `count(*)::int as "count"`, ...sums.map((c) => `coalesce(sum(${c.sql}), 0)::float8 as "sum_${esc(c.key)}"`)];
    header = [...groups.map((g) => ({ key: g.key, label: g.label, type: g.type })), { key: 'count', label: 'Count', type: 'number' as ColType }, ...sums.map((c) => ({ key: `sum_${c.key}`, label: `Total ${c.label.toLowerCase()}`, type: 'number' as ColType }))];
  } else {
    const cols = def.columns.map((k) => col(k, 'Column'));
    select = cols.map((c) => `${c.sql} as "${esc(c.key)}"`);
    header = cols.map((c) => ({ key: c.key, label: c.label, type: c.type }));
  }
  const allowedSort = new Set(header.map((h) => h.key));
  const order = def.sort.length
    ? def.sort.map((s) => { if (!allowedSort.has(s.column)) throw new ApiError(422, 'unknown_column', `Sort column ${s.column} is not in the report's output. Sort by one of: ${[...allowedSort].join(', ')}.`); return `"${esc(s.column)}" ${s.dir === 'desc' ? 'desc nulls last' : 'asc nulls first'}`; }).join(', ')
    : grouped ? `"count" desc` : src.order;
  const text = `select ${select.join(', ')} from ${src.from} where ${where.join(' and ')}${grouped ? ` group by ${groups.map((g) => g.sql).join(', ')}` : ''} order by ${order} limit ${Math.max(1, Math.min(ROW_LIMIT, limit))}`;
  return { text, params, header, grouped };
}

export async function runDefinition(sql: Sql, ws: string, def: DefinitionIn, limit = ROW_LIMIT) {
  const q = compile(def, ws, limit);
  const rows = await sql.query(q.text, q.params);
  return { header: q.header, grouped: q.grouped, rows: rows as Record<string, unknown>[], truncated: rows.length >= Math.min(ROW_LIMIT, limit), limit: Math.min(ROW_LIMIT, limit) };
}

// ---------- CSV ----------
const cell = csvCell;
export const toCsv = (header: { key: string; label: string }[], rows: Record<string, unknown>[]) =>
  [header.map((h) => cell(h.label)).join(','), ...rows.map((r) => header.map((h) => cell(r[h.key])).join(','))].join('\r\n') + '\r\n';
const wantsCsv = (c: Context) => /text\/csv/i.test(c.req.header('accept') ?? '') || c.req.query('format') === 'csv';
const csvResponse = (c: Context, name: string, text: string) =>
  c.body(text, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="laissez-${name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${today()}.csv"`, 'cache-control': 'no-store' });

// ---------- Routes ----------
routes.get('/reports/catalog', async (c) => {
  need(c, 'read');
  return c.json({
    sources: SOURCES.map((s) => ({ key: s.key, label: s.label, permission: s.perm, default_columns: s.default, columns: s.columns.map(({ key, label, type, sum }) => ({ key, label, type, summable: !!sum })) })),
    operators: OPERATORS, schedules: SCHEDULES, row_limit: ROW_LIMIT,
    note: 'Columns, operators, group-by and sort keys must come from this catalog. Values are bound parameters; the client never sends SQL.',
  });
});

const defOut = (r: any) => ({ id: r.id, name: r.name, source: r.source, columns: r.columns, filters: r.filters ?? [], group_by: r.group_by ?? [], sort: r.sort ?? [], schedule: r.schedule ?? null, recipients: r.recipients ?? [], created_by: r.created_by, last_run_at: r.last_run_at, last_sent_at: r.last_sent_at, created_at: r.created_at, updated_at: r.updated_at });

function checkDefinition(c: C, def: DefinitionIn) {
  const src = sourceOf(def.source)!;
  need(c, src.perm);
  if (def.schedule && def.recipients.length) need(c, 'audit:export');
  if (def.schedule && !def.recipients.length) throw new ApiError(422, 'recipients_required', 'A scheduled report needs at least one recipient email address.');
  compile(def, c.get('ws'), 1); // validates columns, filters and sort without running anything
}

routes.get('/reports/definitions', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`select * from report_definitions where workspace_id = ${c.get('ws')} order by updated_at desc`;
  return c.json({ data: rows.map(defOut) });
});

routes.post('/reports/definitions', async (c) => {
  const actor = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const def = await body(c, definitionIn);
  checkDefinition(c, def);
  const id = newId('rpt', 10);
  await sql.transaction([
    sql`insert into report_definitions (workspace_id, id, name, source, columns, filters, group_by, sort, schedule, recipients, created_by)
      values (${ws}, ${id}, ${def.name}, ${def.source}, ${def.columns}, ${JSON.stringify(def.filters)}, ${def.group_by}, ${JSON.stringify(def.sort)}, ${def.schedule ?? null}, ${def.recipients}, ${actor.name})`,
    auditQ(sql, ws, actor, 'report.saved', id, { name: def.name, source: def.source, columns: def.columns.length, filters: def.filters.length, schedule: def.schedule ?? null, recipients: def.recipients.length }),
  ]);
  const [row] = await sql`select * from report_definitions where workspace_id = ${ws} and id = ${id}`;
  return c.json(defOut(row), 201);
});

routes.get('/reports/definitions/:id', async (c) => {
  need(c, 'read');
  const [row] = await c.get('sql')`select * from report_definitions where workspace_id = ${c.get('ws')} and id = ${c.req.param('id')}`;
  if (!row) throw new ApiError(404, 'not_found', 'No saved report with that id.');
  return c.json(defOut(row));
});

routes.put('/reports/definitions/:id', async (c) => {
  const actor = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const id = c.req.param('id');
  const def = await body(c, definitionIn);
  checkDefinition(c, def);
  const [r] = await sql.transaction([
    sql`update report_definitions set name = ${def.name}, source = ${def.source}, columns = ${def.columns}, filters = ${JSON.stringify(def.filters)}, group_by = ${def.group_by}, sort = ${JSON.stringify(def.sort)},
        schedule = ${def.schedule ?? null}, recipients = ${def.recipients}, updated_at = now() where workspace_id = ${ws} and id = ${id} returning *`,
    auditQ(sql, ws, actor, 'report.updated', id, { name: def.name, source: def.source, schedule: def.schedule ?? null, recipients: def.recipients.length }),
  ]);
  if (!r.length) throw new ApiError(404, 'not_found', 'No saved report with that id.');
  return c.json(defOut(r[0]));
});

routes.delete('/reports/definitions/:id', async (c) => {
  const actor = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const id = c.req.param('id');
  const [r] = await sql.transaction([
    sql`delete from report_definitions where workspace_id = ${ws} and id = ${id} returning name`,
    auditQ(sql, ws, actor, 'report.deleted', id, {}),
  ]);
  if (!r.length) throw new ApiError(404, 'not_found', 'No saved report with that id.');
  return c.json({ id, deleted: true });
});

/** Runs an unsaved definition, for the builder's preview. Same rules as a saved report, capped lower by default. */
routes.post('/reports/preview', async (c) => {
  need(c, 'read');
  const def = await body(c, definitionIn.extend({ limit: z.number().int().min(1).max(ROW_LIMIT).default(200) }));
  checkDefinition(c, def);
  const out = await runDefinition(c.get('sql'), c.get('ws'), def, def.limit);
  if (wantsCsv(c)) return csvResponse(c, def.name, toCsv(out.header, out.rows));
  return c.json({ name: def.name, source: def.source, ...out, as_of: new Date().toISOString() });
});

routes.post('/reports/definitions/:id/run', async (c) => {
  const actor = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const id = c.req.param('id');
  const [row] = await sql`select * from report_definitions where workspace_id = ${ws} and id = ${id}`;
  if (!row) throw new ApiError(404, 'not_found', 'No saved report with that id.');
  const def = definitionIn.parse({ ...defOut(row), schedule: row.schedule ?? null });
  need(c, sourceOf(def.source)!.perm);
  const out = await runDefinition(sql, ws, def, ROW_LIMIT);
  await sql.transaction([
    sql`update report_definitions set last_run_at = now() where workspace_id = ${ws} and id = ${id}`,
    auditQ(sql, ws, actor, 'report.run', id, { name: def.name, source: def.source, rows: out.rows.length, format: wantsCsv(c) ? 'csv' : 'json' }),
  ]);
  if (wantsCsv(c)) return csvResponse(c, def.name, toCsv(out.header, out.rows));
  return c.json({ id, name: def.name, source: def.source, ...out, as_of: new Date().toISOString(), note: out.truncated ? `Only the first ${out.limit} rows are returned. Narrow the filters or group the report.` : undefined });
});

// ---------- Scheduled delivery ----------
const PERIOD_HOURS: Record<string, number> = { daily: 20, weekly: 6 * 24 + 20, monthly: 27 * 24 + 20 };
const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/**
 * Sends every due scheduled report to its recipients. Called from the daily cron (api/src/index.ts dailyCleanup;
 * wire it there). Each email carries the CSV inline (up to 200 rows) and a link to the saved report in the app, and
 * is written to email_outbox first, so sandboxes without a mail provider still show it on the Outbox page.
 */
export async function runScheduledReports(env: Env, admin: Sql): Promise<{ reports: number; emails: number; failed: number }> {
  const due = await admin`select r.*, w.name as org_name, w.brand_name, w.email_footer from report_definitions r join workspaces w on w.id = r.workspace_id
    where r.schedule is not null and cardinality(r.recipients) > 0 and (w.expires_at is null or w.expires_at > now())
      and (r.last_sent_at is null or r.last_sent_at < now() - make_interval(hours => case r.schedule when 'daily' then ${PERIOD_HOURS.daily} when 'weekly' then ${PERIOD_HOURS.weekly} else ${PERIOD_HOURS.monthly} end))
    order by r.workspace_id, r.name`;
  let emails = 0; let failed = 0;
  for (const r of due) {
    try {
      const def = definitionIn.parse({ ...defOut(r), schedule: r.schedule ?? null });
      const out = await runDefinition(admin, r.workspace_id, def, 200);
      const csv = toCsv(out.header, out.rows);
      const org = r.brand_name || r.org_name;
      const link = `${env.APP_URL}#/reports/builder/${r.id}`;
      const subject = `${def.name}: ${out.rows.length}${out.truncated ? '+' : ''} row${out.rows.length === 1 ? '' : 's'} (${today()})`;
      const footer = r.email_footer || `Sent by Laissez on behalf of ${org}. You receive this because a teammate scheduled the report "${def.name}" for you.`;
      const table = `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px;width:100%"><tr>${out.header.map((h) => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd6c9;color:#8a8377;font-weight:600">${escHtml(h.label)}</th>`).join('')}</tr>${out.rows.slice(0, 50).map((row) => `<tr>${out.header.map((h) => `<td style="padding:6px 8px;border-bottom:1px solid #eee8dc;color:#2a2722">${escHtml(row[h.key] instanceof Date ? (row[h.key] as Date).toISOString() : row[h.key])}</td>`).join('')}</tr>`).join('')}</table>`;
      const html = `<!doctype html><html><body style="margin:0;background:#f1eee8;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#fff;border:1px solid #ddd6c9;border-radius:14px"><tr><td style="padding:28px 30px 8px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8377">${escHtml(org)}</div><h1 style="margin:6px 0 16px;font-size:21px;line-height:1.3;color:#151412">${escHtml(def.name)}</h1><p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#2a2722">${out.rows.length}${out.truncated ? ' or more' : ''} row${out.rows.length === 1 ? '' : 's'} from ${escHtml(sourceOf(def.source)!.label.toLowerCase())}, run ${escHtml(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC. The first ${Math.min(50, out.rows.length)} rows are below; the CSV text follows for pasting into a spreadsheet.</p>${table}<p style="margin:22px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#1f3a33;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:9px;font-size:15px">Open the report</a></p><pre style="font-size:11px;line-height:1.4;color:#4a4540;white-space:pre-wrap;word-break:break-all;background:#f7f5f0;padding:12px;border-radius:8px">${escHtml(csv.slice(0, 60_000))}</pre></td></tr><tr><td style="padding:14px 30px 24px;border-top:1px solid #eee8dc;font-size:12px;line-height:1.5;color:#8a8377">${escHtml(footer)}</td></tr></table></td></tr></table></body></html>`;
      const text = [def.name, '', `${out.rows.length} rows, run ${new Date().toISOString()}.`, `Open the report: ${link}`, '', csv.slice(0, 60_000), '', footer].join('\n');
      for (const to of r.recipients as string[]) {
        if (!deliverable(to)) continue;
        await sendEmail(env, admin, { ws: r.workspace_id, to, kind: 'report' as EmailKind, subject, html, text, link });
        emails++;
      }
      await admin`update report_definitions set last_sent_at = now(), last_run_at = now() where workspace_id = ${r.workspace_id} and id = ${r.id}`;
      await audit(admin, r.workspace_id, null, 'report.delivered', r.id, { name: def.name, rows: out.rows.length, recipients: (r.recipients as string[]).filter(deliverable).length, schedule: r.schedule });
    } catch (e: any) {
      failed++;
      console.error('scheduled report failed', r.id, e?.message ?? e);
    }
  }
  return { reports: due.length, emails, failed };
}
