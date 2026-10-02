// Bulk import: clients, credentials and holdings from CSV or JSON, in three steps. POST /v1/imports parses and
// validates every row against the organization's reference data and stores the preview; POST /v1/imports/{id}/apply
// applies it in chunks (one request per chunk, so a 1,000-row file stays inside the Worker's CPU budget);
// GET /v1/imports and GET /v1/imports/{id} read them back. Credentials go through issueCredential, so an imported
// credential is tested, recorded and audited exactly like one issued by hand. A holdings import ends with a
// reconciliation report against the register as it was and, when on-chain settlement is on, the token balances.
import { z } from 'zod';
import { findTest } from '../../../src/proto/thresholds';
import { ApiError, id, rand, sha256, today } from '../util';
import { type C, type Actor, router, body, bg, need, auditQ } from '../http';
import { loadGlobals, emit } from '../ctx';
import { loadPolicies, policyReason } from '../approvals';
import { chainEnabled, runRecon } from '../chain';
import { issueCredential } from './core';
import {
  IMPORT_TYPES, TEMPLATES, templateCsv, previewImport, detectFormat, holdingKey, totalsOf,
  type ImportType, type ImportFormat, type ImportRow, type Lookups, type ClientData, type CredentialData, type HoldingData, type Totals,
} from '../import-core';

export const routes = router();

const MAX_CONTENT = 5 * 1024 * 1024;
/** Rows applied per request. Credentials issue one at a time through issueCredential, so their chunk is smaller. */
const CHUNK: Record<ImportType, number> = { clients: 200, credentials: 50, holdings: 200 };
const typeZ = z.enum(['clients', 'credentials', 'holdings']);
export const importIn = z.object({
  type: typeZ,
  format: z.enum(['csv', 'json']).optional(),
  content: z.string().min(1).max(MAX_CONTENT, `The file is larger than 5 MB. Split it and import the parts.`),
  file_name: z.string().trim().max(200).optional(),
});
export const applyIn = z.object({ chunk: z.number().int().min(1).max(200).optional() });

/** Imports write clients; a holdings import also changes the register, which is fund data. */
function permFor(c: C, type: ImportType): Actor {
  const a = need(c, 'clients:write');
  if (type === 'holdings') need(c, 'funds:write');
  return a;
}

// ---------- Templates ----------
routes.get('/imports/templates/:type{[a-z]+\\.csv}', async (c) => {
  need(c, 'read');
  const type = c.req.param('type').replace(/\.csv$/, '') as ImportType;
  if (!IMPORT_TYPES.includes(type)) throw new ApiError(404, 'not_found', `No template ${type}. Templates: ${IMPORT_TYPES.map((t) => `${t}.csv`).join(', ')}.`);
  return new Response(templateCsv(type), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="laissez-import-${type}.csv"`, 'cache-control': 'private, no-store' } });
});

// ---------- Lookups from the organization ----------
async function loadLookups(c: C, type: ImportType): Promise<Lookups> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [g, invs, funds, hold, policies] = await Promise.all([
    loadGlobals(sql),
    sql`select id, name, kind, external_id, residence, city, booking_center, us_person, email, wallet,
          (select id from credentials cr where cr.workspace_id = i.workspace_id and cr.investor_id = i.id and cr.status = 'active' order by cr.created_at desc limit 1) as credential_id
        from investors i where workspace_id = ${ws}`,
    sql`select ticker, name from funds where workspace_id = ${ws}`,
    type === 'holdings' ? sql`select investor_id, ticker, units::float8 as units from holdings where workspace_id = ${ws}` : Promise.resolve([] as any[]),
    loadPolicies(sql, ws),
  ]);
  const holdings: Record<string, number> = {};
  for (const h of hold) holdings[holdingKey(h.investor_id, h.ticker)] = Number(h.units);
  return {
    jurisdictions: g.jurName, sanctioned: g.sanctioned,
    bookingCenters: Object.fromEntries(Object.values(g.bookingCenters).map((b) => [b.id, { name: b.name, jurisdiction: b.jur }])),
    classes: Object.fromEntries(Object.entries(g.classInfo).map(([k, v]) => [k, { label: v.label, jurisdiction: v.jur }])),
    funds: Object.fromEntries(funds.map((f: any) => [f.ticker, { name: f.name }])),
    investors: invs.map((i: any) => ({ id: i.id, name: i.name, kind: i.kind, external_id: i.external_id ?? null, residence: i.residence, city: i.city, booking_center: i.booking_center, us_person: !!i.us_person, email: i.email ?? null, wallet: i.wallet ?? null, credential_id: i.credential_id ?? null })),
    holdings, findTest, today: today(),
    gate: (kind, payload) => { const p = policies[kind]; return p ? policyReason(kind, p, payload) : null; },
  };
}

// ---------- Preview ----------
const importOut = (r: any, withRows = true) => ({
  id: r.id, type: r.type, format: r.format, status: r.status, file_name: r.file_name ?? null, source_sha256: r.source_sha256 ?? null,
  totals: r.totals ?? {}, warnings: r.warnings ?? [], applied_rows: Number(r.cursor ?? 0), result: r.result ?? null, error: r.error ?? null,
  created_by: r.created_by, created_at: r.created_at, applied_by: r.applied_by ?? null, applied_at: r.applied_at ?? null,
  ...(withRows ? { rows: r.rows ?? [] } : {}),
  template: TEMPLATES[r.type as ImportType]?.columns ?? [],
});

routes.post('/imports', async (c) => {
  const b = await body(c, importIn);
  const a = permFor(c, b.type);
  const sql = c.get('sql'); const ws = c.get('ws');
  const format: ImportFormat = b.format ?? (b.file_name?.toLowerCase().endsWith('.json') ? 'json' : detectFormat(b.content));
  const l = await loadLookups(c, b.type);
  const p = previewImport(b.type, format, b.content, l);
  if (p.errors.length) throw new ApiError(422, 'import_invalid', `The file could not be read. ${p.errors[0]}`, { errors: p.errors, warnings: p.warnings, columns: p.columns });
  const impId = id('imp', 12);
  const digest = await sha256(b.content);
  const reconPreview = b.type === 'holdings' ? holdingsPreviewReport(p.rows) : null;
  await sql.transaction([
    sql`insert into imports (workspace_id, id, type, format, status, file_name, source_sha256, totals, rows, warnings, result, created_by)
      values (${ws}, ${impId}, ${b.type}, ${format}, 'previewed', ${b.file_name ?? null}, ${digest}, ${JSON.stringify(p.totals)}, ${JSON.stringify(p.rows)}, ${JSON.stringify(p.warnings)}, ${reconPreview ? JSON.stringify(reconPreview) : null}, ${a.name})`,
    auditQ(sql, ws, a, 'import.previewed', impId, { type: b.type, format, file_name: b.file_name ?? null, source_sha256: digest, ...p.totals }),
  ]);
  const [row] = await sql`select * from imports where workspace_id = ${ws} and id = ${impId}`;
  return c.json({ ...importOut(row), columns: p.columns, note: p.totals.error ? `${p.totals.error} row${p.totals.error === 1 ? '' : 's'} will not be applied. Fix the file and import again, or apply the valid rows now.` : 'Every row is valid. Apply to write them.' }, 201);
});

/** What the register will look like against the file, before anything is written. */
function holdingsPreviewReport(rows: ImportRow[]) {
  const differences = rows.filter((r) => r.status === 'update' && r.data).map((r) => {
    const d = r.data as HoldingData;
    return { row: r.n, investor_id: r.match?.investor_id ?? null, investor: r.match?.name ?? null, ticker: d.ticker, register_units: r.register_units ?? 0, imported_units: d.units, difference: +(d.units - (r.register_units ?? 0)).toFixed(2) };
  });
  const matched = rows.filter((r) => r.status === 'skip' && r.register_units != null).length;
  const added = rows.filter((r) => r.status === 'create').length;
  return { stage: 'preview', compared: rows.filter((r) => r.status !== 'error').length, matched, added, differences, chain: null as unknown };
}

// ---------- Apply ----------
type Chunk = { done: ImportRow[]; failed: ImportRow[] };

async function applyClients(c: C, a: Actor, impId: string, rows: ImportRow[]): Promise<Chunk> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const one = (r: ImportRow) => {
    const d = r.data as ClientData;
    if (r.match) {
      const invId = r.match.investor_id;
      return {
        q: [
          sql`update investors set name = ${d.name}, short_name = ${d.name.split(/\s+/).slice(0, 3).join(' ')}, kind = ${d.kind}, residence = ${d.residence}, city = ${d.city}, booking_center = ${d.booking_center},
                us_person = ${d.us_person}, email = coalesce(${d.email}, email), wallet = coalesce(${d.wallet}, wallet), external_id = ${d.external_id} where workspace_id = ${ws} and id = ${invId}`,
          auditQ(sql, ws, a, 'investor.updated', invId, { import: impId, row: r.n, external_id: d.external_id, changed: r.changes ?? [], matched_by: r.match.by, residence: d.residence, booking_center: d.booking_center }),
        ],
        result: { status: 'done' as const, investor_id: invId, message: `Updated ${(r.changes ?? []).join(', ')}.` },
      };
    }
    const invId = id('inv', 10);
    const wallet = d.wallet || `0x${rand(4, '0123456789abcdef')}…${rand(4, '0123456789abcdef')}`;
    return {
      q: [
        sql`insert into investors (workspace_id, id, name, short_name, kind, residence, city, booking_center, us_person, wallet, email, external_id)
          values (${ws}, ${invId}, ${d.name}, ${d.name.split(/\s+/).slice(0, 3).join(' ')}, ${d.kind}, ${d.residence}, ${d.city}, ${d.booking_center}, ${d.us_person}, ${wallet}, ${d.email}, ${d.external_id})`,
        auditQ(sql, ws, a, 'investor.created', invId, { import: impId, row: r.n, external_id: d.external_id, name: d.name, residence: d.residence, booking_center: d.booking_center }),
      ],
      result: { status: 'done' as const, investor_id: invId, message: 'Created.' },
    };
  };
  return runRows(sql, rows, one);
}

async function applyHoldings(c: C, a: Actor, impId: string, rows: ImportRow[]): Promise<Chunk> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const one = (r: ImportRow) => {
    const d = r.data as HoldingData; const invId = r.match!.investor_id;
    const before = r.register_units ?? null;
    const q: any[] = [];
    if (d.units <= 0) {
      q.push(sql`delete from holdings where workspace_id = ${ws} and investor_id = ${invId} and ticker = ${d.ticker}`);
      if (before != null) q.push(sql`update funds set holders = greatest(0, holders - 1) where workspace_id = ${ws} and ticker = ${d.ticker}`);
    } else {
      q.push(sql`insert into holdings (workspace_id, investor_id, ticker, units, since) values (${ws}, ${invId}, ${d.ticker}, ${d.units}, ${d.since})
        on conflict (workspace_id, investor_id, ticker) do update set units = excluded.units, since = least(holdings.since, excluded.since)`);
      if (before == null) q.push(sql`update funds set holders = holders + 1 where workspace_id = ${ws} and ticker = ${d.ticker}`);
    }
    q.push(auditQ(sql, ws, a, 'holding.imported', invId, { import: impId, row: r.n, ticker: d.ticker, from: before, to: d.units, since: d.since }));
    return { q, result: { status: 'done' as const, investor_id: invId, message: before == null ? `Recorded ${d.units.toLocaleString('en-US')} ${d.ticker}.` : `Set to ${d.units.toLocaleString('en-US')} ${d.ticker} (was ${before.toLocaleString('en-US')}).` } };
  };
  return runRows(sql, rows, one);
}

/** Runs every row's statements in one transaction; if that fails, row by row, so one bad row does not block the chunk. */
async function runRows(sql: any, rows: ImportRow[], one: (r: ImportRow) => { q: any[]; result: NonNullable<ImportRow['result']> }): Promise<Chunk> {
  const plans = rows.map((r) => ({ r, ...one(r) }));
  try {
    await sql.transaction(plans.flatMap((p) => p.q));
    for (const p of plans) p.r.result = p.result;
    return { done: rows, failed: [] };
  } catch (e: any) {
    if (plans.length === 1) { plans[0].r.result = { status: 'failed', message: dbMessage(e) }; return { done: [], failed: rows }; }
  }
  const done: ImportRow[] = []; const failed: ImportRow[] = [];
  for (const p of plans) {
    try { await sql.transaction(p.q); p.r.result = p.result; done.push(p.r); }
    catch (e: any) { p.r.result = { status: 'failed', message: dbMessage(e) }; failed.push(p.r); }
  }
  return { done, failed };
}
const dbMessage = (e: any) => {
  const m = String(e?.message ?? e);
  if (e?.code === '23505' && /external_id/.test(m)) return 'Another client already has this external id (it was set after the preview). Preview again.';
  if (e?.code === '23505') return 'A record with the same key already exists. Preview again.';
  if (e?.code === '23503') return 'A referenced client or fund no longer exists. Preview again.';
  return `Database refused the row: ${m.slice(0, 160)}`;
};

async function applyCredentials(c: C, a: Actor, impId: string, rows: ImportRow[]): Promise<Chunk> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const byClient = new Map<string, ImportRow[]>();
  for (const r of rows) { const k = r.match!.investor_id; (byClient.get(k) ?? byClient.set(k, []).get(k)!).push(r); }
  const done: ImportRow[] = []; const failed: ImportRow[] = [];
  for (const [invId, rs] of byClient) {
    const data = rs.map((r) => r.data as CredentialData);
    const start = data.map((d) => d.verified_on).sort()[0];
    const end = data.map((d) => d.expires_on).sort().at(-1)!;
    const months = Math.max(1, Math.min(24, Math.round((new Date(end).getTime() - new Date(start).getTime()) / (30.44 * 86_400_000))));
    try {
      const res = await issueCredential(c, { investor_id: invId, valid_months: months, classifications: data.map((d) => ({ class_code: d.class_code, evidence: d.evidence, ...(d.evidence_ref ? { evidence_ref: d.evidence_ref } : {}) })) }, a);
      // issueCredential dates the credential today; the file carries the real verification dates, so they are set afterwards and audited.
      await sql.transaction([
        sql`update credentials set issued_on = ${start}, expires_on = ${end} where workspace_id = ${ws} and id = ${res.credential_id}`,
        ...data.map((d) => sql`update classifications set verified_on = ${d.verified_on}, expires_on = ${d.expires_on}, opt_in_on = ${d.opt_in_on ?? (d.evidence.opt_in ? d.verified_on : null)} where workspace_id = ${ws} and credential_id = ${res.credential_id} and class_code = ${d.class_code}`),
        auditQ(sql, ws, a, 'credential.imported', res.credential_id, { import: impId, investor: invId, rows: rs.map((r) => r.n), issued_on: start, expires_on: end, classes: data.map((d) => ({ class_code: d.class_code, verified_on: d.verified_on, expires_on: d.expires_on, evidence_ref: d.evidence_ref })) }),
      ]);
      for (const r of rs) { r.result = { status: 'done', investor_id: invId, credential_id: res.credential_id, lzid: res.lzid, message: `Issued on ${res.credential_id}.` }; done.push(r); }
    } catch (e: any) {
      const msg = e instanceof ApiError ? `${e.message}${Array.isArray(e.detail) ? ' ' + e.detail.filter((x: any) => x && x.pass === false).map((x: any) => x.reason).join(' ') : ''}` : dbMessage(e);
      for (const r of rs) { r.result = { status: 'failed', investor_id: invId, message: msg }; failed.push(r); }
    }
  }
  return { done, failed };
}

/** The reconciliation report a holdings import ends with: file against the register as it was, and against the chain when on. */
async function holdingsReport(c: C, a: Actor, rows: ImportRow[]) {
  const applied = rows.filter((r) => r.result?.status === 'done');
  const preview = holdingsPreviewReport(rows);
  const report: Record<string, unknown> = {
    stage: 'applied', compared: preview.compared, matched: preview.matched, added: preview.added,
    adjusted: applied.filter((r) => r.status === 'update').length, failed: rows.filter((r) => r.result?.status === 'failed').length,
    differences: preview.differences.map((d) => ({ ...d, applied: rows.find((r) => r.n === d.row)?.result?.status === 'done' })),
    chain: null as unknown,
    note: 'Differences list every position where the file disagreed with the register before the import. Applied rows now show the imported units.',
  };
  if (!(await chainEnabled(c))) { report.chain_note = 'On-chain settlement is off for this organization, so token balances were not compared.'; return report; }
  try {
    const run = await runRecon(c.get('admin'), c.get('ws'), 'import', c.env, a);
    const tickers = new Set(applied.map((r) => (r.data as HoldingData).ticker));
    const positions = run.positions.filter((p) => tickers.has(p.ticker));
    report.chain = { run: run.run, positions, breaks: positions.filter((p) => p.status === 'break').length, note: 'Positions compare the register (now the imported units) with the token balance on chain. A break opens a work item and a reconciliation break to resolve.' };
  } catch (e: any) {
    report.chain = null; report.chain_note = `Token balances could not be compared: ${e instanceof ApiError ? e.message : String(e?.message ?? e).slice(0, 160)}`;
  }
  return report;
}

routes.post('/imports/:id/apply', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const impId = c.req.param('id');
  const b = await body(c, applyIn);
  const [head] = await sql`select id, type, status from imports where workspace_id = ${ws} and id = ${impId}`;
  if (!head) throw new ApiError(404, 'not_found', `No import ${impId} in this organization.`);
  const type = head.type as ImportType;
  const a = permFor(c, type);
  if (head.status === 'applied') throw new ApiError(409, 'already_applied', 'This import was already applied. Upload the file again to import it a second time.');
  // One request at a time per import: the lock expires after two minutes in case a request died mid-chunk.
  const [imp] = await sql`update imports set status = 'applying', locked_at = now(), applied_by = coalesce(applied_by, ${a.name})
    where workspace_id = ${ws} and id = ${impId} and status in ('previewed', 'applying', 'failed') and (locked_at is null or locked_at < now() - interval '2 minutes') returning *`;
  if (!imp) throw new ApiError(409, 'import_busy', 'Another request is applying this import. Wait for it to finish, then continue.');
  const rows = imp.rows as ImportRow[];
  const total = rows.length;
  const size = Math.min(b.chunk ?? CHUNK[type], CHUNK[type]);
  let cursor = Number(imp.cursor ?? 0);
  const todo: ImportRow[] = [];
  while (cursor < total && todo.length < size) {
    const r = rows[cursor++];
    if (r.status === 'create' || r.status === 'update') todo.push(r);
  }
  const release = (patch: Record<string, unknown>) => sql`update imports set locked_at = null, rows = ${JSON.stringify(rows)}, cursor = ${cursor}, status = ${patch.status ?? 'applying'}, result = ${patch.result != null ? JSON.stringify(patch.result) : imp.result ? JSON.stringify(imp.result) : null}, error = ${patch.error ?? null},
      applied_at = ${patch.status === 'applied' ? new Date().toISOString() : null} where workspace_id = ${ws} and id = ${impId}`;
  let chunk: Chunk;
  try {
    chunk = type === 'clients' ? await applyClients(c, a, impId, todo) : type === 'credentials' ? await applyCredentials(c, a, impId, todo) : await applyHoldings(c, a, impId, todo);
  } catch (e: any) {
    // Rows in this chunk stay unapplied; the next apply call starts from the same cursor.
    cursor = Number(imp.cursor ?? 0);
    const msg = e instanceof ApiError ? e.message : String(e?.message ?? e).slice(0, 200);
    await sql.transaction([release({ status: 'failed', error: msg }), auditQ(sql, ws, a, 'import.failed', impId, { type, at_row: cursor, error: msg })]);
    throw new ApiError(502, 'import_chunk_failed', `The chunk starting at row ${cursor + 1} could not be applied: ${msg} Nothing from that chunk was written. Apply again to retry it.`);
  }
  const finished = cursor >= total;
  const applied = rows.filter((r) => r.result?.status === 'done').length;
  const failedRows = rows.filter((r) => r.result?.status === 'failed').length;
  const counts: Totals & { applied: number; failed: number } = { ...totalsOf(rows), applied, failed: failedRows };
  let result: unknown = imp.result ?? null;
  if (finished) {
    if (type === 'holdings') result = await holdingsReport(c, a, rows);
    else result = { applied, failed: failedRows, skipped: counts.skip, errors: counts.error, created: rows.filter((r) => r.status === 'create' && r.result?.status === 'done').length, updated: rows.filter((r) => r.status === 'update' && r.result?.status === 'done').length, credentials: type === 'credentials' ? [...new Set(rows.map((r) => r.result?.credential_id).filter(Boolean))].length : undefined };
    await sql.transaction([
      release({ status: 'applied', result }),
      auditQ(sql, ws, a, 'import.applied', impId, { type, ...counts, source_sha256: imp.source_sha256 }),
    ]);
    bg(c, emit(sql, ws, 'import.applied', { id: impId, type, ...counts }));
  } else {
    await release({ status: 'applying', result });
  }
  return c.json({
    id: impId, type, status: finished ? 'applied' : 'applying', done: finished,
    progress: { processed: cursor, total, applied, failed: failedRows, remaining: total - cursor, chunk: todo.length, chunk_done: chunk.done.length, chunk_failed: chunk.failed.length },
    rows: todo, result: finished ? result : null,
    next: finished ? null : `/v1/imports/${impId}/apply`,
  });
});

// ---------- Read back ----------
routes.get('/imports', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`select id, type, format, status, file_name, source_sha256, totals, warnings, cursor, result, error, created_by, created_at, applied_by, applied_at
    from imports where workspace_id = ${c.get('ws')} order by created_at desc limit 100`;
  return c.json({ data: rows.map((r: any) => importOut(r, false)), templates: IMPORT_TYPES.map((t) => ({ type: t, columns: TEMPLATES[t].columns, required: TEMPLATES[t].required, notes: TEMPLATES[t].notes, url: `/v1/imports/templates/${t}.csv` })) });
});

routes.get('/imports/:id', async (c) => {
  need(c, 'read');
  const [r] = await c.get('sql')`select * from imports where workspace_id = ${c.get('ws')} and id = ${c.req.param('id')}`;
  if (!r) throw new ApiError(404, 'not_found', `No import ${c.req.param('id')} in this organization.`);
  return c.json(importOut(r));
});

// ---------- OpenAPI operations (merged by api/src/openapi-gen.ts; request bodies come from the zod schemas above) ----------
const T = ['clients', 'credentials', 'holdings'];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
export const OPENAPI_OPS = [
  { method: 'post', path: '/v1/imports', tag: 'Imports', id: 'createImport', sum: 'Upload and preview an import', perm: 'clients:write', body: importIn, ok: 201, err: [422],
    desc: 'Parses a CSV or JSON file of clients, credentials or holdings (up to 5 MB), validates every row against jurisdictions, booking centers, classification thresholds (the same tests credential issuance runs), funds and dates, matches rows to existing clients by external_id (by exact name as a fallback, with a warning) and stores the preview. Nothing is written yet. Rows whose residence is under comprehensive sanctions are refused. A holdings import also needs funds:write. Rows an approval policy would route to a second person are skipped with the reason.',
    ex: { type: 'clients', format: 'csv', content: 'external_id,name,kind,residence,city,booking_center,us_person,email,wallet\nCRM-10021,Harbour Lane Capital Pte. Ltd.,Corporate,SG,Singapore,SG,false,ops@harbourlane.example,\n', file_name: 'clients.csv' },
    res: ref('Import') },
  { method: 'get', path: '/v1/imports', tag: 'Imports', id: 'listImports', sum: 'List imports', perm: 'read', desc: 'The last 100 imports without their rows, plus the template definitions.',
    res: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: ref('ImportSummary') }, templates: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: T }, columns: { type: 'array', items: { type: 'string' } }, required: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } }, url: { type: 'string' } } } } } } },
  { method: 'get', path: '/v1/imports/{id}', tag: 'Imports', id: 'getImport', sum: 'Get an import', perm: 'read', idd: 'Import id.', desc: 'The import with every row, its status and messages, and the result once applied.', res: ref('Import') },
  { method: 'post', path: '/v1/imports/{id}/apply', tag: 'Imports', id: 'applyImport', sum: 'Apply an import, one chunk per call', perm: 'clients:write', idd: 'Import id.', body: applyIn, err: [409, 502],
    desc: 'Applies the next chunk of create and update rows (200 for clients and holdings, 50 for credentials) and returns progress. Call it again until done is true. Clients are created or updated and get their external_id; credentials are issued through the same path as POST /v1/credentials, carrying the evidence and the verification dates from the file; holdings set the register and the holder count. When the last chunk finishes the import is marked applied and a holdings import returns its reconciliation report: the file against the register as it was and, when on-chain settlement is on, a reconciliation run against token balances that opens a break per mismatch. A failed chunk writes nothing and can be retried.',
    res: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: T }, status: { type: 'string', enum: ['applying', 'applied'] }, done: { type: 'boolean' }, progress: { type: 'object', properties: Object.fromEntries(['processed', 'total', 'applied', 'failed', 'remaining', 'chunk', 'chunk_done', 'chunk_failed'].map((k) => [k, { type: 'integer' }])) }, rows: { type: 'array', items: ref('ImportRow') }, result: { description: 'Totals, or the reconciliation report for holdings. Null until the last chunk.' }, next: { type: ['string', 'null'] } } } },
];
