// Pure parsers for the scheduled jobs: sanctions list files and regulator feeds.
// No network or database access here, so every function is unit-tested with inline fixtures.
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { normName } from '../src/sanctions';

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

/**
 * Parse delimited text into rows of fields. Handles quoted fields with embedded delimiters,
 * doubled quotes and line breaks, CRLF, LF or CR line endings, a UTF-8 byte-order mark,
 * and the MS-DOS end-of-file byte (0x1A) that OFAC files still end with.
 * A trailing line break does not produce an empty final row.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const text = input.replace(/^\uFEFF/, '').replace(/\u001a/g, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field.length === 0) { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++; continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Map header names to column indexes, case- and punctuation-insensitive. */
function headerIndex(header: string[]) {
  const key = (s: string) => s.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = new Map<string, number>();
  header.forEach((h, i) => { const k = key(h); if (!map.has(k)) map.set(k, i); });
  return (...names: string[]): number => {
    for (const nm of names) { const i = map.get(key(nm)); if (i !== undefined) return i; }
    return -1;
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** Normalize a list date (dd/mm/yyyy, yyyy-mm-dd, dd-Mon-yyyy or an ISO timestamp) to YYYY-MM-DD. Returns null when empty. */
export function isoDate(input: string | null | undefined): string | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  return s;
}

const TZ: Record<string, string> = { JST: '+0900', KST: '+0900', HKT: '+0800', SGT: '+0800', CET: '+0100', CEST: '+0200', BST: '+0100', GST: '+0400', IST: '+0530', AEST: '+1000', AEDT: '+1100' };

/** Parse a feed date (RFC 822, ISO 8601, or the looser forms some regulators publish). Returns an ISO timestamp or null. */
export function parseFeedDate(input: string | null | undefined): string | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  const direct = /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  // "Wednesday, September 30, 2026 - 17:17" (Drupal) and similar.
  s = s.replace(/\s+-\s+(?=\d{1,2}:\d{2})/, ' ');
  s = s.replace(/\b([A-Z]{3,4})$/, (abbr) => TZ[abbr] ?? abbr);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT))\s*$/.test(s);
  for (const candidate of hasZone ? [s] : [`${s} UTC`, s]) {
    const t = Date.parse(candidate);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const d = isoDate(s);
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T00:00:00.000Z`;
  return null;
}

// ---------------------------------------------------------------------------
// Sanctions lists
// ---------------------------------------------------------------------------

export type EntryType = 'individual' | 'entity' | 'vessel' | 'aircraft';
export type SanctionEntry = {
  uid: string;
  primary: string;
  aliases: string[];
  type: EntryType;
  programs: string;
  country: string | null;
  listedOn: string | null;
};
export type ParsedList = { entries: SanctionEntry[]; published: string | null; warnings: string[] };
export type EntryRow = {
  source_uid: string; name: string; name_norm: string; is_alias: boolean; primary_name: string;
  entry_type: EntryType; programs: string | null; country: string | null; listed_on: string | null;
};

/** One row per distinct name (primary plus aliases). Names that normalize to nothing are dropped. */
export function toRows(entries: SanctionEntry[]): EntryRow[] {
  const out: EntryRow[] = [];
  for (const e of entries) {
    const seen = new Set<string>();
    const names: [string, boolean][] = [[e.primary, false], ...e.aliases.map((a): [string, boolean] => [a, true])];
    for (const [raw, alias] of names) {
      const name = raw.replace(/\s+/g, ' ').trim();
      const norm = normName(name);
      if (norm.length < 2 || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ source_uid: e.uid, name, name_norm: norm, is_alias: alias, primary_name: e.primary.replace(/\s+/g, ' ').trim(), entry_type: e.type, programs: e.programs || null, country: e.country, listed_on: e.listedOn });
    }
  }
  return out;
}

/** Fail loudly when too many rows have the wrong number of columns: that means the format changed. */
function checkShape(file: string, rows: string[][], expected: number, warnings: string[]): string[][] {
  const good = rows.filter((r) => r.length === expected);
  const bad = rows.length - good.length;
  if (bad > Math.max(2, rows.length * 0.01)) {
    throw new Error(`${file}: ${bad} of ${rows.length} rows do not have ${expected} columns. The file format may have changed; the previous list was kept.`);
  }
  if (bad) warnings.push(`${file}: skipped ${bad} malformed row${bad === 1 ? '' : 's'}.`);
  return good;
}

const ofacNull = (v: string | undefined) => { const t = (v ?? '').trim(); return !t || t === '-0-' ? null : t; };
/** "SDGT] [IFSR" becomes "SDGT, IFSR". */
const ofacPrograms = (v: string | null) => (v ? v.replace(/^\[|\]$/g, '').split(/\]\s*\[/).map((p) => p.trim()).filter(Boolean).join(', ') : '');

/**
 * OFAC SDN legacy CSV files (no header row, "-0-" means empty).
 * SDN.CSV: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks.
 * ALT.CSV: ent_num, alt_num, alt_type, alt_name, alt_remarks. ADD.CSV (optional): ent_num, add_num, address, city, country, add_remarks.
 */
export function parseOfac(sdnCsv: string, altCsv: string | null, addCsv?: string | null): ParsedList {
  const warnings: string[] = [];
  const byId = new Map<string, SanctionEntry>();
  for (const r of checkShape('SDN.CSV', parseCsv(sdnCsv), 12, warnings)) {
    const uid = ofacNull(r[0]);
    const name = ofacNull(r[1]);
    if (!uid || !name) continue;
    const t = (ofacNull(r[2]) ?? '').toLowerCase();
    const type: EntryType = t === 'individual' ? 'individual' : t === 'vessel' ? 'vessel' : t === 'aircraft' ? 'aircraft' : 'entity';
    const flag = ofacNull(r[9]);
    byId.set(uid, { uid, primary: name, aliases: [], type, programs: ofacPrograms(ofacNull(r[3])), country: type === 'vessel' ? flag : null, listedOn: null });
  }
  if (addCsv) {
    for (const r of checkShape('ADD.CSV', parseCsv(addCsv), 6, warnings)) {
      const e = byId.get((r[0] ?? '').trim());
      const country = ofacNull(r[4]);
      if (e && country && !e.country) e.country = country;
    }
  }
  if (altCsv) {
    let orphans = 0;
    for (const r of checkShape('ALT.CSV', parseCsv(altCsv), 5, warnings)) {
      const e = byId.get((r[0] ?? '').trim());
      const name = ofacNull(r[3]);
      if (!name) continue;
      if (!e) { orphans++; continue; }
      e.aliases.push(name);
    }
    if (orphans) warnings.push(`ALT.CSV: ${orphans} alias${orphans === 1 ? '' : 'es'} pointed to entries not in SDN.CSV and were skipped.`);
  }
  return { entries: [...byId.values()], published: null, warnings };
}

const xmlArrays = new Set(['INDIVIDUAL', 'ENTITY', 'INDIVIDUAL_ALIAS', 'ENTITY_ALIAS', 'NATIONALITY', 'VALUE', 'ENTITY_ADDRESS', 'INDIVIDUAL_ADDRESS']);
const text = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object' && '#text' in (v as any)) return String((v as any)['#text']).trim();
  return '';
};

/**
 * UN Security Council Consolidated List XML: CONSOLIDATED_LIST[@dateGenerated] with
 * INDIVIDUALS/INDIVIDUAL (FIRST_NAME to FOURTH_NAME, INDIVIDUAL_ALIAS/ALIAS_NAME, NATIONALITY/VALUE)
 * and ENTITIES/ENTITY (FIRST_NAME, ENTITY_ALIAS/ALIAS_NAME, ENTITY_ADDRESS/COUNTRY).
 * Aliases the UN grades as "Low" quality are skipped: they are mostly single common names.
 */
export function parseUn(xml: string): ParsedList {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, isArray: (name) => xmlArrays.has(name) });
  const doc = parser.parse(xml);
  const root = doc?.CONSOLIDATED_LIST;
  if (!root) throw new Error('UN XML: no CONSOLIDATED_LIST element. The file format may have changed; the previous list was kept.');
  const warnings: string[] = [];
  const entries: SanctionEntry[] = [];
  const aliases = (list: any[] | undefined) => {
    const out: string[] = [];
    let low = 0;
    for (const a of list ?? []) {
      const nm = text(a?.ALIAS_NAME);
      if (!nm) continue;
      if (/^(low|weak)/i.test(text(a?.QUALITY))) { low++; continue; }
      out.push(nm);
    }
    return { out, low };
  };
  let lowTotal = 0;
  for (const p of root.INDIVIDUALS?.INDIVIDUAL ?? []) {
    const name = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((k) => text(p[k])).filter(Boolean).join(' ');
    const uid = text(p.REFERENCE_NUMBER) || text(p.DATAID);
    if (!name || !uid) continue;
    const a = aliases(p.INDIVIDUAL_ALIAS);
    lowTotal += a.low;
    const original = text(p.NAME_ORIGINAL_SCRIPT);
    entries.push({ uid, primary: name, aliases: original ? [...a.out, original] : a.out, type: 'individual', programs: text(p.UN_LIST_TYPE), country: text(p.NATIONALITY?.[0]?.VALUE?.[0]) || null, listedOn: isoDate(text(p.LISTED_ON)) });
  }
  for (const e of root.ENTITIES?.ENTITY ?? []) {
    const name = text(e.FIRST_NAME);
    const uid = text(e.REFERENCE_NUMBER) || text(e.DATAID);
    if (!name || !uid) continue;
    const a = aliases(e.ENTITY_ALIAS);
    lowTotal += a.low;
    entries.push({ uid, primary: name, aliases: a.out, type: 'entity', programs: text(e.UN_LIST_TYPE), country: text(e.ENTITY_ADDRESS?.[0]?.COUNTRY) || null, listedOn: isoDate(text(e.LISTED_ON)) });
  }
  if (lowTotal) warnings.push(`UN: skipped ${lowTotal} low-quality aliases.`);
  const generated = text(root['@_dateGenerated']);
  return { entries, published: generated || null, warnings };
}

/**
 * EU Consolidated Financial Sanctions List, CSV version 1.1 (semicolon-separated, one row per
 * name, address, birth date or identifier, all repeating the entity columns).
 * Columns used: fileGenerationDate, Entity_LogicalId, Entity_SubjectType_ClassificationCode,
 * Entity_Regulation_Programme, Entity_DesignationDate, NameAlias_WholeName (or first, middle and last name),
 * Citizenship_CountryDescription, Address_CountryDescription.
 */
export function parseEu(csv: string): ParsedList {
  const rows = parseCsv(csv, ';');
  if (rows.length < 2) throw new Error('EU CSV: the file has no data rows. The previous list was kept.');
  const col = headerIndex(rows[0]);
  const ix = {
    gen: col('fileGenerationDate'),
    id: col('Entity_LogicalId'),
    subject: col('Entity_SubjectType_ClassificationCode'),
    subjectShort: col('Entity_SubjectType'),
    programme: col('Entity_Regulation_Programme'),
    designated: col('Entity_DesignationDate'),
    published: col('Entity_Regulation_PublicationDate'),
    whole: col('NameAlias_WholeName'),
    first: col('NameAlias_FirstName'),
    middle: col('NameAlias_MiddleName'),
    last: col('NameAlias_LastName'),
    citizenship: col('Citizenship_CountryDescription'),
    addressCountry: col('Address_CountryDescription'),
  };
  if (ix.id < 0 || (ix.whole < 0 && ix.last < 0)) {
    throw new Error('EU CSV: the header has no Entity_LogicalId or NameAlias_WholeName column. The file format may have changed; the previous list was kept.');
  }
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const byId = new Map<string, SanctionEntry & { progs: Set<string> }>();
  let generated: string | null = null;
  const warnings: string[] = [];
  let short = 0;
  for (const r of rows.slice(1)) {
    if (r.length < rows[0].length * 0.5) { short++; continue; }
    const uid = get(r, ix.id);
    if (!uid) continue;
    generated ??= get(r, ix.gen) || null;
    const whole = get(r, ix.whole) || [get(r, ix.first), get(r, ix.middle), get(r, ix.last)].filter(Boolean).join(' ');
    let e = byId.get(uid);
    if (!e) {
      const code = (get(r, ix.subject) || get(r, ix.subjectShort)).toLowerCase();
      const type: EntryType = code === 'person' || code === 'p' ? 'individual' : code.startsWith('vessel') ? 'vessel' : 'entity';
      e = { uid, primary: '', aliases: [], type, programs: '', progs: new Set(), country: null, listedOn: isoDate(get(r, ix.designated)) ?? isoDate(get(r, ix.published)) };
      byId.set(uid, e);
    }
    const prog = get(r, ix.programme);
    if (prog) e.progs.add(prog);
    e.country ??= get(r, ix.citizenship) || get(r, ix.addressCountry) || null;
    if (whole) {
      if (!e.primary) e.primary = whole;
      else if (whole !== e.primary && !e.aliases.includes(whole)) e.aliases.push(whole);
    }
  }
  if (short) warnings.push(`EU CSV: skipped ${short} truncated rows.`);
  const entries: SanctionEntry[] = [];
  for (const e of byId.values()) {
    if (!e.primary) continue;
    const { progs, ...rest } = e;
    entries.push({ ...rest, programs: [...progs].join(', ') });
  }
  return { entries, published: generated ? isoDate(generated) : null, warnings };
}

/**
 * UK Sanctions List (FCDO) CSV. Optional report-date lines may come before the header row.
 * Columns used: Unique ID, Name 1 to Name 6 (Name 6 is the surname or the full entity name), Name type
 * (Primary Name, Primary Name Variation, Alias), Alias strength, Regime Name, "Individual, Entity, Ship",
 * Date Designated (dd/mm/yyyy), Nationality(/ies), Address Country, Last Updated.
 * Aliases the FCDO marks as weak or low quality are skipped.
 */
export function parseUk(csv: string): ParsedList {
  const rows = parseCsv(csv, ',');
  const h = rows.findIndex((r, i) => i < 10 && r.some((c) => c.trim().toLowerCase() === 'unique id'));
  if (h < 0) throw new Error('UK CSV: no header row with a "Unique ID" column. The file format may have changed; the previous list was kept.');
  const col = headerIndex(rows[h]);
  const ix = {
    uid: col('Unique ID'),
    names: ['Name 1', 'Name 2', 'Name 3', 'Name 4', 'Name 5', 'Name 6'].map((n) => col(n)),
    nameType: col('Name type'),
    strength: col('Alias strength'),
    regime: col('Regime Name', 'Regime'),
    kind: col('Individual, Entity, Ship', 'Designation Type', 'Entity type'),
    designated: col('Date Designated'),
    nationality: col('Nationality(/ies)', 'Nationality'),
    country: col('Address Country'),
    updated: col('Last Updated'),
  };
  if (ix.uid < 0 || ix.names[5] < 0) throw new Error('UK CSV: the header has no "Name 6" column. The file format may have changed; the previous list was kept.');
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  let published: string | null = null;
  for (const r of rows.slice(0, h)) {
    const m = r.join(' ').match(/(\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{1,2}-[A-Za-z]{3}-\d{4}|\d{4}-\d{2}-\d{2})/);
    if (m) { published = isoDate(m[1]); break; }
  }
  const byId = new Map<string, SanctionEntry & { progs: Set<string> }>();
  const pending: [string, string][] = [];
  let latest = '';
  let weak = 0;
  for (const r of rows.slice(h + 1)) {
    const uid = get(r, ix.uid);
    if (!uid) continue;
    const name = ix.names.map((i) => get(r, i)).filter(Boolean).join(' ');
    const type = get(r, ix.nameType).toLowerCase();
    const upd = isoDate(get(r, ix.updated)) ?? '';
    if (upd > latest) latest = upd;
    let e = byId.get(uid);
    if (!e) {
      const k = get(r, ix.kind).toLowerCase();
      e = { uid, primary: '', aliases: [], type: k.startsWith('ind') ? 'individual' : k === 'ship' || k.startsWith('vessel') ? 'vessel' : 'entity', programs: '', progs: new Set(), country: null, listedOn: isoDate(get(r, ix.designated)) };
      byId.set(uid, e);
    }
    const regime = get(r, ix.regime);
    if (regime) e.progs.add(regime);
    e.country ??= get(r, ix.nationality) || get(r, ix.country) || null;
    if (!name) continue;
    if (type === 'primary name' && !e.primary) { e.primary = name; continue; }
    if (type === 'alias' && /weak|low/i.test(get(r, ix.strength))) { weak++; continue; }
    pending.push([uid, name]);
  }
  for (const [uid, name] of pending) {
    const e = byId.get(uid)!;
    if (!e.primary) { e.primary = name; continue; }
    if (name !== e.primary && !e.aliases.includes(name)) e.aliases.push(name);
  }
  const entries: SanctionEntry[] = [];
  for (const e of byId.values()) {
    if (!e.primary) continue;
    const { progs, ...rest } = e;
    entries.push({ ...rest, programs: [...progs].join(', ') });
  }
  return { entries, published: published ?? (latest || null), warnings: weak ? [`UK: skipped ${weak} weak aliases.`] : [] };
}

// ---------------------------------------------------------------------------
// Regulator feeds
// ---------------------------------------------------------------------------

export type FeedItem = { title: string; url: string; published: string | null; summary: string | null };

/** Stable publication id: the first 24 hex characters of the SHA-256 of its URL. */
export const pubId = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 24);

const NAMED: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 32, rsquo: 8217, lsquo: 8216, rdquo: 8221, ldquo: 8220,
  ndash: 8211, mdash: 8212, hellip: 8230, euro: 8364, pound: 163, copy: 169, reg: 174, trade: 8482, middot: 183, bull: 8226,
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    const cp = NAMED[e.toLowerCase()];
    return cp ? String.fromCodePoint(cp) : m;
  });
}

/** Plain text from an HTML page or fragment: drops scripts, styles and markup, collapses whitespace. */
export function htmlToText(html: string, max = 8000): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i) ?? s.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i);
  if (main && main[1].replace(/<[^>]+>/g, '').trim().length > 200) s = main[1];
  else s = s.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ').replace(/<(nav|header|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|blockquote)\b[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

const feedArrays = new Set(['item', 'entry', 'link']);
/** RSS 2.0, RSS 1.0 (RDF) and Atom. Relative links resolve against the feed URL. */
export function parseFeed(xml: string, baseUrl?: string): FeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: true, isArray: (name) => feedArrays.has(name) });
  const doc = parser.parse(xml);
  const abs = (u: string) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };
  const clean = (v: unknown, max: number) => { const t = htmlToText(text(v), max); return t || null; };
  const out: FeedItem[] = [];
  const rssItems: any[] = doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item ?? doc?.RDF?.item ?? [];
  for (const it of rssItems) {
    const link = text(it.link?.[0] ?? it.link) || (/^https?:/.test(text(it.guid)) ? text(it.guid) : '');
    const title = clean(it.title, 500);
    if (!link || !title) continue;
    out.push({ title, url: abs(link), published: parseFeedDate(text(it.pubDate) || text(it['dc:date']) || text(it.date)), summary: clean(it.description ?? it['content:encoded'] ?? it.summary, 1000) });
  }
  for (const en of doc?.feed?.entry ?? []) {
    const links: any[] = en.link ?? [];
    const best = links.find((l) => !l?.['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
    const link = typeof best === 'string' ? best : best?.['@_href'] ?? '';
    const title = clean(en.title, 500);
    if (!link || !title) continue;
    out.push({ title, url: abs(link), published: parseFeedDate(text(en.published) || text(en.updated)), summary: clean(en.summary ?? en.content, 1000) });
  }
  return out;
}

/** Topics that make a publication relevant to tokenized fund distribution. Matching is case-insensitive. */
export const TOPICS: { topic: string; re: RegExp }[] = [
  { topic: 'tokenization', re: /tokeni[sz]/i },
  { topic: 'digital asset', re: /digital[- ]assets?/i },
  { topic: 'stablecoin', re: /stable[- ]?coins?/i },
  { topic: 'fund', re: /\bfunds?\b/i },
  { topic: 'collective investment', re: /collective investment/i },
  { topic: 'accredited investor', re: /\baccredited\b/i },
  { topic: 'professional investor', re: /professional (investors?|clients?)/i },
  { topic: 'qualified investor', re: /qualified (investors?|purchasers?)/i },
  { topic: 'private placement', re: /private placements?/i },
  { topic: 'crypto', re: /crypto/i },
  { topic: 'virtual asset', re: /virtual[- ]assets?/i },
  { topic: 'travel rule', re: /travel rule/i },
  { topic: 'AIF', re: /\bAIF(s|M|MD|Ms)?\b/ },
  { topic: 'UCITS', re: /\bUCITS\b/i },
  { topic: 'money market', re: /money[- ]market/i },
];
export function matchTopics(...parts: (string | null | undefined)[]): string[] {
  const hay = parts.filter(Boolean).join(' \n ');
  return TOPICS.filter((t) => t.re.test(hay)).map((t) => t.topic);
}

// ---------------------------------------------------------------------------
// OpenSanctions "simple" CSV (targets.simple.csv): one row per entity with ';'-separated multi-values.
// Used for politically exposed persons (datasets such as us_cia_world_leaders and peps). Not a sanctions list:
// a match means enhanced due diligence, never a block, so these rows are screened by screenPeps(), not screenNames().
// ---------------------------------------------------------------------------
export function parseOpenSanctionsSimple(csv: string, opts: { countries?: Set<string>; datasetLabel?: string } = {}): ParsedList {
  const rows = parseCsv(csv, ',');
  if (!rows.length) throw new Error('OpenSanctions CSV: empty file. The previous list was kept.');
  const col = headerIndex(rows[0]);
  const ix = { id: col('id'), schema: col('schema'), name: col('name'), aliases: col('aliases'), countries: col('countries'), dataset: col('dataset'), first: col('first_seen'), change: col('last_change') };
  if (ix.id < 0 || ix.name < 0 || ix.schema < 0) throw new Error('OpenSanctions CSV: expected id, schema and name columns. The format may have changed; the previous list was kept.');
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const entries: SanctionEntry[] = [];
  let published: string | null = null;
  let skipped = 0;
  for (const r of rows.slice(1)) {
    if (!r.length || !get(r, ix.id)) continue;
    const schema = get(r, ix.schema);
    const type: EntryType = schema === 'Person' ? 'individual' : schema === 'Vessel' ? 'vessel' : schema === 'Airplane' ? 'aircraft' : 'entity';
    const countries = get(r, ix.countries).split(';').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (opts.countries && countries.length && !countries.some((x) => opts.countries!.has(x))) { skipped++; continue; }
    const primary = get(r, ix.name);
    if (!primary) continue;
    const aliases = get(r, ix.aliases).split(';').map((x) => x.trim()).filter((x) => x && x !== primary);
    const change = get(r, ix.change);
    if (change && (!published || change > published)) published = change;
    entries.push({ uid: get(r, ix.id), primary, aliases, type, programs: opts.datasetLabel ?? get(r, ix.dataset) ?? 'OpenSanctions', country: countries[0] ?? null, listedOn: get(r, ix.first).slice(0, 10) || null });
  }
  const warnings = skipped ? [`${skipped} entries outside the configured countries were skipped.`] : [];
  return { entries, published: published ? new Date(published).toISOString() : null, warnings };
}
