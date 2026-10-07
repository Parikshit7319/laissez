// Daily sanctions list ingest: OFAC SDN, UN Security Council, EU and UK (FCDO) lists.
// Run from api/:  npx tsx jobs/sanctions-ingest.ts [OFAC-SDN] [UN] [EU] [UK] [OS-PEP] [--with-pep] [--dry-run] [--no-monitor]
//
// For each source: download, parse into one row per name, refuse a result under half of the last good load
// (a broken or truncated download must never empty a list), stage the rows, then swap them into
// sanctions_entries inside one transaction so screening never sees a half-loaded list.
// Afterwards: re-normalize the fictional test entries, record a dated global/sanctions rule-pack version,
// and re-run monitoring in every active workspace.
import type { Sql } from '../src/db';
import { normName } from '../src/sanctions';
import { db, fetchText, fmt, log } from './lib';
import { parseEu, parseOfac, parseUk, parseUn, parseOpenSanctionsSimple, toRows, type EntryRow, type ParsedList } from './parsers';
import { printResults, runMonitorAll } from './run-monitor-all';

type SourceDef = { name: string; url: string; load: () => Promise<ParsedList> };

const OFAC_BASE = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports';
const httpDate = (h: string | null) => { const t = h ? Date.parse(h) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export const SOURCES: Record<string, SourceDef> = {
  'OFAC-SDN': {
    name: 'OFAC Specially Designated Nationals (U.S. Treasury)',
    url: `${OFAC_BASE}/SDN.CSV`,
    async load() {
      // ALT.CSV is required: without aliases the list would shrink by half and screening would miss known names.
      const [sdn, alt, add] = await Promise.all([
        fetchText(`${OFAC_BASE}/SDN.CSV`),
        fetchText(`${OFAC_BASE}/ALT.CSV`),
        fetchText(`${OFAC_BASE}/ADD.CSV`).catch((e) => { log(`  OFAC ADD.CSV unavailable (${e.message}); loading without address countries.`); return null; }),
      ]);
      const parsed = parseOfac(sdn.text, alt.text, add?.text ?? null);
      return { ...parsed, published: parsed.published ?? httpDate(sdn.lastModified) };
    },
  },
  UN: {
    name: 'UN Security Council Consolidated List',
    url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
    async load() {
      const res = await fetchText(this.url, { accept: 'application/xml,text/xml' });
      const parsed = parseUn(res.text);
      return { ...parsed, published: parsed.published ?? httpDate(res.lastModified) };
    },
  },
  EU: {
    name: 'EU Consolidated Financial Sanctions List',
    url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
    async load() {
      const res = await fetchText(this.url, { accept: 'text/csv,*/*' });
      const parsed = parseEu(res.text);
      return { ...parsed, published: parsed.published ?? httpDate(res.lastModified) };
    },
  },
  UK: {
    // The FCDO UK Sanctions List is the only UK list since the OFSI Consolidated List closed on 28 January 2026.
    name: 'UK Sanctions List (FCDO)',
    url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv',
    async load() {
      const res = await fetchText(this.url, { accept: 'text/csv,*/*' });
      const parsed = parseUk(res.text);
      return { ...parsed, published: parsed.published ?? httpDate(res.lastModified) };
    },
  },
  // Politically exposed persons. Not a sanctions list: screened separately (screenPeps), a match opens a review, never a
  // block. Default dataset is the US CIA World Leaders list (about 5,000 names, public domain source). PEP_DATASETS
  // can add OpenSanctions datasets such as peps (180 MB, every PEP) filtered by PEP_COUNTRIES (ISO alpha-2, comma
  // separated). OpenSanctions bulk data is CC BY-NC 4.0: a commercial deployment needs their licence or a provider.
  'OS-PEP': {
    name: 'Politically exposed persons (OpenSanctions)',
    url: 'https://data.opensanctions.org/datasets/latest/',
    async load() {
      const datasets = (process.env.PEP_DATASETS || 'us_cia_world_leaders').split(',').map((x) => x.trim()).filter(Boolean);
      const countries = process.env.PEP_COUNTRIES ? new Set(process.env.PEP_COUNTRIES.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) : undefined;
      const all: ParsedList = { entries: [], published: null, warnings: [] };
      for (const d of datasets) {
        // PEP_FILE points at a downloaded targets.simple.csv for offline runs and tests.
        const res = process.env.PEP_FILE
          ? { text: (await import('node:fs')).readFileSync(process.env.PEP_FILE, 'utf8'), lastModified: null as string | null }
          : await fetchText(`https://data.opensanctions.org/datasets/latest/${d}/targets.simple.csv`, { accept: 'text/csv,*/*' });
        const parsed = parseOpenSanctionsSimple(res.text, { countries, datasetLabel: `PEP ${d}` });
        all.entries.push(...parsed.entries);
        all.warnings.push(...parsed.warnings.map((w) => `${d}: ${w}`));
        const pub = parsed.published ?? httpDate(res.lastModified);
        if (pub && (!all.published || pub > all.published)) all.published = pub;
      }
      return all;
    },
  },
};

/** Sources the status page treats as sanctions lists that must stay fresh. PEP data is screened differently and refreshed weekly. */
export const SANCTIONS_SOURCES = ['OFAC-SDN', 'UN', 'EU', 'UK'];

const BATCH = 500;
const BATCHES_PER_REQUEST = 10;
const COLUMNS = 'source, source_uid, name, name_norm, is_alias, primary_name, entry_type, programs, country, listed_on';

function insertBatch(sql: Sql, source: string, rows: EntryRow[]) {
  return sql.query(
    `insert into sanctions_entries_staging (${COLUMNS})
     select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::bool[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])`,
    [source, rows.map((r) => r.source_uid), rows.map((r) => r.name), rows.map((r) => r.name_norm), rows.map((r) => r.is_alias), rows.map((r) => r.primary_name),
      rows.map((r) => r.entry_type), rows.map((r) => r.programs), rows.map((r) => r.country), rows.map((r) => r.listed_on)],
  );
}

/** Stage every row, then replace the live rows for this source in a single transaction. */
async function swapIn(sql: Sql, source: string, def: SourceDef, rows: EntryRow[], published: string | null) {
  await sql.query(`create table if not exists sanctions_entries_staging (like sanctions_entries including defaults)`);
  await sql.query(`delete from sanctions_entries_staging where source = $1`, [source]);
  const batches: EntryRow[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  for (let i = 0; i < batches.length; i += BATCHES_PER_REQUEST) {
    await sql.transaction(batches.slice(i, i + BATCHES_PER_REQUEST).map((b) => insertBatch(sql, source, b)));
  }
  const [{ n }] = await sql.query(`select count(*)::int as n from sanctions_entries_staging where source = $1`, [source]);
  if (n !== rows.length) throw new Error(`Staged ${fmt(n)} rows but parsed ${fmt(rows.length)}. The previous list was kept.`);
  await sql.transaction([
    sql.query(`delete from sanctions_entries where source = $1`, [source]),
    sql.query(`insert into sanctions_entries (${COLUMNS}) select ${COLUMNS} from sanctions_entries_staging where source = $1`, [source]),
    sql.query(`delete from sanctions_entries_staging where source = $1`, [source]),
    sql.query(`update sanctions_sources set name = $2, url = $3, status = 'active', entries = $4, last_fetched_at = now(), last_published = $5, error = null where source = $1`,
      [source, def.name, def.url, rows.length, published]),
  ]);
}

type Outcome = { source: string; ok: boolean; rows?: number; previous?: number; published?: string | null; error?: string; warnings?: string[]; ms: number };

async function ingest(sql: Sql | null, source: string, download: Promise<ParsedList>): Promise<Outcome> {
  const def = SOURCES[source];
  const start = Date.now();
  let previous = 0;
  try {
    if (sql) {
      await sql`insert into sanctions_sources (source, name, url, status) values (${source}, ${def.name}, ${def.url}, 'pending') on conflict (source) do nothing`;
      const [row] = await sql`select count(*)::int as n from sanctions_entries where source = ${source}`;
      previous = row?.n ?? 0;
    }
    const parsed = await download;
    const rows = toRows(parsed.entries);
    for (const w of parsed.warnings) log(`  ${source}: ${w}`);
    if (!rows.length) throw new Error('The download parsed to zero names. The previous list was kept.');
    if (previous > 0 && rows.length < previous * 0.5) {
      throw new Error(`Parsed ${fmt(rows.length)} names, fewer than half of the ${fmt(previous)} in the last good load. The download may be truncated, so the previous list was kept.`);
    }
    if (sql) await swapIn(sql, source, def, rows, parsed.published);
    return { source, ok: true, rows: rows.length, previous, published: parsed.published, warnings: parsed.warnings, ms: Date.now() - start };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 500);
    if (sql) await sql`update sanctions_sources set status = 'error', error = ${error} where source = ${source}`.then(() => {}, () => {});
    return { source, ok: false, previous, error, ms: Date.now() - start };
  }
}

/** The fictional demo entries were normalized in SQL by the migration; use the same function as screening. */
async function renormalizeTestEntries(sql: Sql) {
  const rows = await sql`select id, name from sanctions_entries where source = 'LAISSEZ-TEST'`;
  if (!rows.length) return 0;
  await sql.query(`update sanctions_entries e set name_norm = u.norm from unnest($1::bigint[], $2::text[]) as u(id, norm) where e.id = u.id`,
    [rows.map((r: any) => r.id), rows.map((r: any) => normName(r.name))]);
  await sql`update sanctions_sources set entries = ${rows.length}, last_fetched_at = now() where source = 'LAISSEZ-TEST'`;
  return rows.length;
}

/**
 * Record today's list state as a dated global/sanctions rule-pack version, so every decision can cite
 * which list load it screened against. rule_packs.jurisdiction must reference jurisdictions(code):
 * the pack reuses the jurisdiction of its existing versions (US) rather than adding a pseudo-country.
 */
async function recordRulePack(sql: Sql) {
  const version = new Date().toISOString().slice(0, 10);
  const [latest] = await sql`select jurisdiction, summary from rule_packs where id = 'global/sanctions' order by effective_from desc nulls last, created_at desc limit 1`;
  const counts = await sql`select source, entries, status from sanctions_sources where source not in ('LAISSEZ-TEST', 'OS-PEP') and entries > 0 order by source`;
  const base = String(latest?.summary ?? 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, occupied regions of Ukraine.').split(' Name screening lists')[0].trim();
  const lists = counts.map((r: any) => `${r.source === 'OFAC-SDN' ? 'OFAC SDN' : r.source} ${fmt(Number(r.entries))}${r.status === 'error' ? ' (refresh failed, previous load kept)' : ''}`).join(', ');
  const summary = `${base} Name screening lists loaded ${version}: ${lists || 'none'} names.`;
  let jurisdiction = latest?.jurisdiction ?? 'US';
  const [exists] = await sql`select 1 as ok from jurisdictions where code = ${jurisdiction}`;
  if (!exists) jurisdiction = 'US';
  await sql`insert into rule_packs (id, version, jurisdiction, status, summary, effective_from, approved_by)
    values ('global/sanctions', ${version}, ${jurisdiction}, 'active', ${summary}, ${version}::date, 'Automated daily list refresh')
    on conflict (id, version) do update set summary = excluded.summary, status = 'active'`;
  return { version, summary };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noMonitor = args.includes('--no-monitor');
  const requested = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
  const unknown = requested.filter((s) => !SOURCES[s]);
  if (unknown.length) {
    console.error(`Unknown source ${unknown.join(', ')}. Use any of: ${Object.keys(SOURCES).join(', ')}.`);
    process.exit(2);
  }
  const sql = dryRun ? null : db();
  // The daily run loads the four sanctions lists. PEP data is weekly: it loads when asked for (OS-PEP or --with-pep), or
  // when the last load is more than six days old, so no workflow change is needed to keep it fresh.
  let pepDue = args.includes('--with-pep');
  if (!pepDue && !requested.length && sql) {
    const [row] = await sql`select last_fetched_at from sanctions_sources where source = 'OS-PEP'`;
    pepDue = !row?.last_fetched_at || Date.now() - new Date(row.last_fetched_at).getTime() > 6 * 86_400_000;
  }
  const sources = requested.length ? requested : Object.keys(SOURCES).filter((s) => s !== 'OS-PEP' || pepDue);
  log(`Sanctions ingest${dryRun ? ' (dry run, nothing is written)' : ''}: ${sources.join(', ')}`);

  // Download everything in parallel, then load one source at a time.
  const downloads = Object.fromEntries(sources.map((s) => {
    const p = SOURCES[s].load();
    p.catch(() => {}); // handled in ingest()
    return [s, p];
  }));
  const outcomes: Outcome[] = [];
  for (const s of sources) {
    const o = await ingest(sql, s, downloads[s]);
    outcomes.push(o);
    if (o.ok) log(`${s}: ${fmt(o.rows!)} names${o.previous ? ` (was ${fmt(o.previous)})` : ''}, published ${o.published ?? 'date not given'}, ${o.ms} ms`);
    else log(`${s}: FAILED. ${o.error}`);
  }
  const loaded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);

  if (sql) {
    const n = await renormalizeTestEntries(sql);
    if (n) log(`LAISSEZ-TEST: re-normalized ${n} fictional entries.`);
    // The sanctions pack version records sanctions list loads only; a PEP refresh is not a sanctions change.
    if (loaded.some((o) => o.source !== 'OS-PEP')) {
      const pack = await recordRulePack(sql);
      log(`Rule pack global/sanctions@${pack.version}: ${pack.summary}`);
      if (!noMonitor) printResults(await runMonitorAll(sql, 'sanctions_update'));
    }
  }

  log(`Finished: ${loaded.length} loaded, ${failed.length} failed.`);
  if (failed.length) {
    console.error(`Failed sources: ${failed.map((f) => `${f.source} (${f.error})`).join('; ')}`);
    process.exit(1);
  }
}

await main();
