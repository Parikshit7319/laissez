// Import pipeline, database-free: CSV and JSON parsing, templates, per-row validation and matching for the three
// entity types a pilot brings in from its existing systems (clients, credentials, holdings). routes/import.ts feeds
// it the organization's reference data through the Lookups interface and applies the rows it returns;
// scripts/test-import.ts runs it against fixed lookups with no database. Every message a row carries is written
// for the person who prepared the file: what is wrong and how to fix it.

export type ImportType = 'clients' | 'credentials' | 'holdings';
export type ImportFormat = 'csv' | 'json';
export type RowStatus = 'create' | 'update' | 'skip' | 'error';
export const IMPORT_TYPES: ImportType[] = ['clients', 'credentials', 'holdings'];

export type ClientData = { external_id: string; name: string; kind: string; residence: string; city: string; booking_center: string; us_person: boolean; email: string | null; wallet: string | null };
export type CredentialData = { client_external_id: string; class_code: string; evidence: Record<string, number | boolean>; evidence_ref: string | null; verified_on: string; expires_on: string; opt_in_on: string | null };
export type HoldingData = { client_external_id: string; ticker: string; units: number; since: string };
export type RowData = ClientData | CredentialData | HoldingData;

export type Match = { investor_id: string; name: string; by: 'external_id' | 'name' };
export type ImportRow = {
  /** 1-based position in the file (header excluded for CSV). */
  n: number;
  status: RowStatus;
  messages: string[];
  /** The normalized row when it parsed, null when it did not. */
  data: RowData | null;
  /** The existing client the row refers to, when one was found. */
  match: Match | null;
  /** Changed fields on an update (clients) or the register units before the import (holdings). */
  changes?: string[];
  register_units?: number | null;
  /** Filled in by apply: what happened to the row. */
  result?: { status: 'done' | 'failed'; message?: string; investor_id?: string; credential_id?: string; lzid?: string } | null;
};
export type Totals = { rows: number; create: number; update: number; skip: number; error: number };

export type ParseResult = { rows: Record<string, unknown>[]; columns: string[]; errors: string[]; warnings: string[] };

/** What the validators need to know about the organization. routes/import.ts loads it; tests build it by hand. */
export type Lookups = {
  /** Jurisdiction code to name. */
  jurisdictions: Record<string, string>;
  /** Jurisdiction code to the comprehensive sanctions program that covers it. */
  sanctioned: Record<string, string>;
  bookingCenters: Record<string, { name: string; jurisdiction: string }>;
  classes: Record<string, { label: string; jurisdiction: string }>;
  funds: Record<string, { name: string }>;
  investors: LookupInvestor[];
  /** Register units keyed by holdingKey(investorId, ticker). */
  holdings: Record<string, number>;
  findTest: (code: string, kind: string) => { check: (e: Record<string, number | boolean | undefined>) => { pass: boolean; reason: string } } | undefined;
  today: string;
  /**
   * The organization's approval policies. Returns the reason an action needs a second person, or null. Imports apply
   * directly, so gated rows are skipped with the reason rather than issued behind the policy's back.
   */
  gate?: (kind: 'credential.issue' | 'investor.update', payload: Record<string, unknown>) => string | null;
};
export type LookupInvestor = {
  id: string; name: string; kind: string; external_id: string | null;
  residence?: string; city?: string; booking_center?: string; us_person?: boolean; email?: string | null; wallet?: string | null;
  /** Active credential id, when the client has one. */
  credential_id?: string | null;
};
export const holdingKey = (investorId: string, ticker: string) => `${investorId}\u0001${ticker}`;

// ---------- Templates ----------
export type Template = { type: ImportType; columns: string[]; required: string[]; example: Record<string, string>[]; notes: string[] };
export const TEMPLATES: Record<ImportType, Template> = {
  clients: {
    type: 'clients',
    columns: ['external_id', 'name', 'kind', 'residence', 'city', 'booking_center', 'us_person', 'email', 'wallet'],
    required: ['external_id', 'name', 'residence', 'city', 'booking_center'],
    example: [
      { external_id: 'CRM-10021', name: 'Harbour Lane Capital Pte. Ltd.', kind: 'Corporate', residence: 'SG', city: 'Singapore', booking_center: 'SG', us_person: 'false', email: 'ops@harbourlane.example', wallet: '' },
      { external_id: 'CRM-10022', name: 'Wen Li', kind: 'Individual', residence: 'HK', city: 'Hong Kong', booking_center: 'HK', us_person: 'false', email: '', wallet: '' },
    ],
    notes: [
      'external_id is your own identifier for the client (CRM id, account number). It is stored on the client and used to match later imports.',
      'residence is a jurisdiction code from GET /v1/jurisdictions; booking_center an id from GET /v1/booking-centers.',
      'kind defaults to Corporate. Use Individual for natural persons: it decides which classification tests apply.',
      'us_person accepts true/false, yes/no or 1/0. A US residence makes the client a U.S. person regardless.',
      'wallet is optional. Leave it empty and Laissez assigns a custodial wallet.',
    ],
  },
  credentials: {
    type: 'credentials',
    columns: ['client_external_id', 'class_code', 'evidence', 'evidence_ref', 'verified_on', 'expires_on', 'opt_in_on'],
    required: ['client_external_id', 'class_code'],
    example: [
      { client_external_id: 'CRM-10021', class_code: 'SG_AI', evidence: '{"net_assets": 25000000, "opt_in": true}', evidence_ref: 'KYC file 2026-03', verified_on: '2026-03-14', expires_on: '2027-03-14', opt_in_on: '2026-03-14' },
      { client_external_id: 'CRM-10022', class_code: 'HK_PI', evidence: '{"portfolio": 12000000}', evidence_ref: 'Portfolio statement', verified_on: '2026-05-02', expires_on: '2027-05-02', opt_in_on: '' },
    ],
    notes: [
      'evidence is a JSON object with the fields of the classification test (GET /v1/investor-classes lists them). You can instead add one column per field named evidence_<field>, for example evidence_net_assets.',
      'Every row is checked against its legal threshold before anything is issued. Rows that do not pass are listed with the reason.',
      'Several rows for the same client go on one credential. Issuing replaces the client\'s active credential.',
      'verified_on defaults to today; expires_on to one year after verified_on. opt_in_on records the opt-in date where the class requires one.',
    ],
  },
  holdings: {
    type: 'holdings',
    columns: ['client_external_id', 'ticker', 'units', 'since'],
    required: ['client_external_id', 'ticker', 'units'],
    example: [
      { client_external_id: 'CRM-10021', ticker: 'TWLF', units: '125000', since: '2026-01-15' },
      { client_external_id: 'CRM-10022', ticker: 'AGPC', units: '40000.5', since: '2026-04-01' },
    ],
    notes: [
      'units is the register position for that client in that fund (two decimals). A row with 0 units removes the holding.',
      'since is the date the client became a holder; it drives lock-ups. It defaults to today.',
      'After applying, Laissez compares the imported units with the register as it was and, when on-chain settlement is on, with the token balances, and opens a break for every mismatch.',
    ],
  },
};

export const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The downloadable template: header row plus the example rows. */
export function templateCsv(type: ImportType): string {
  const t = TEMPLATES[type];
  return [t.columns.join(','), ...t.example.map((r) => t.columns.map((c) => csvCell(r[c] ?? '')).join(','))].join('\r\n') + '\r\n';
}

// ---------- Parsing ----------
/** RFC 4180 CSV: quoted fields with commas, newlines and doubled quotes; CRLF or LF; a leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false; let i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; endRow(); i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) endRow();
  // Blank lines (an empty trailing line, or spacing in the file) carry no data.
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const normHeader = (h: string) => h.trim().toLowerCase().replace(/^﻿/, '').replace(/[\s-]+/g, '_');

/** Parses CSV or JSON into uniform records keyed by the template column names. Structural problems are errors; unknown columns are warnings. */
export function parseInput(type: ImportType, format: ImportFormat, content: string): ParseResult {
  const t = TEMPLATES[type];
  const known = new Set(t.columns);
  const errors: string[] = []; const warnings: string[] = [];
  let rows: Record<string, unknown>[] = []; let columns: string[] = [];
  if (!content || !content.trim()) return { rows, columns, errors: ['The file is empty.'], warnings };
  if (format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content); }
    catch (e: any) { return { rows, columns, errors: [`The content is not valid JSON: ${String(e?.message ?? e).slice(0, 120)}.`], warnings }; }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).rows) ? (parsed as any).rows : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).data) ? (parsed as any).data : null;
    if (!list) return { rows, columns, errors: ['JSON must be an array of objects, or an object with a rows array.'], warnings };
    const seen = new Set<string>();
    list.forEach((item: unknown, i: number) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`Item ${i + 1} is not an object.`); return; }
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) { const key = normHeader(k); rec[key] = v; seen.add(key); }
      rows.push(rec);
    });
    columns = [...seen];
  } else {
    const table = parseCsv(content);
    if (!table.length) return { rows, columns, errors: ['The file has no rows.'], warnings };
    columns = table[0].map(normHeader);
    if (columns.every((c) => !known.has(c) && !c.startsWith('evidence_'))) return { rows, columns, errors: [`The first line must be a header row with these columns: ${t.columns.join(', ')}. Download the template to start from.`], warnings };
    const dupCols = columns.filter((c, i) => c && columns.indexOf(c) !== i);
    if (dupCols.length) errors.push(`Duplicate column${dupCols.length === 1 ? '' : 's'}: ${[...new Set(dupCols)].join(', ')}.`);
    table.slice(1).forEach((cells, i) => {
      if (cells.length > columns.length && cells.slice(columns.length).some((x) => x.trim() !== '')) {
        errors.push(`Row ${i + 1} has ${cells.length} values for ${columns.length} columns. Quote any value that contains a comma.`);
        return;
      }
      const rec: Record<string, unknown> = {};
      columns.forEach((c, j) => { if (c) rec[c] = (cells[j] ?? '').trim(); });
      rows.push(rec);
    });
  }
  // For JSON the columns are the keys seen; a file whose items were all rejected has no columns to judge.
  const missing = format === 'json' && !rows.length ? [] : t.required.filter((c) => !columns.includes(c));
  if (missing.length) errors.unshift(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. The ${type} template has: ${t.columns.join(', ')}.`);
  const unknown = columns.filter((c) => c && !known.has(c) && !(type === 'credentials' && c.startsWith('evidence_')));
  if (unknown.length) warnings.push(`Ignored column${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  if (!errors.length && !rows.length) errors.push('The file has a header but no data rows.');
  return { rows, columns, errors, warnings };
}

// ---------- Field readers ----------
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const TRUE = new Set(['true', 'yes', 'y', '1', 't']); const FALSE = new Set(['false', 'no', 'n', '0', 'f', '']);
function readBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  const x = s(v).toLowerCase();
  if (TRUE.has(x)) return true;
  if (FALSE.has(x)) return false;
  return undefined;
}
function readNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const x = s(v).replace(/[,\s_]/g, '').replace(/^[A-Za-z$€£]+\s*/, '');
  if (!x) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD. Returns null for empty, undefined for invalid. */
function readDate(v: unknown): string | null | undefined {
  if (v instanceof Date) v = v.toISOString().slice(0, 10);
  const x = s(v);
  if (!x) return null;
  const m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return undefined;
  return iso;
}
export function addDaysIso(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A program name or a sentence from the jurisdictions table, ended with a full stop either way. */
const sentence = (x: string) => (/[.!?]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`);
export const normName = (n: string) => n.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

// ---------- Matching ----------
type Found = { inv: LookupInvestor; by: 'external_id' | 'name' } | { error: string } | null;
/** Finds the client a row refers to: by external_id first, then by exact name (case and spacing ignored) as a fallback. */
function findInvestor(l: Lookups, externalId: string, name: string | null): Found {
  if (externalId) {
    const byId = l.investors.find((i) => i.external_id === externalId);
    if (byId) return { inv: byId, by: 'external_id' };
  }
  if (!name) return null;
  const key = normName(name);
  const byName = l.investors.filter((i) => normName(i.name) === key);
  if (!byName.length) return null;
  if (byName.length > 1) return { error: `${byName.length} existing clients are named "${name}" (${byName.map((i) => i.id).join(', ')}). Set external_id on the right one from its client page, then import again.` };
  const inv = byName[0];
  if (externalId && inv.external_id && inv.external_id !== externalId) return { error: `"${name}" matches client ${inv.id}, which already has external id ${inv.external_id}. Use that id, or rename one of them.` };
  return { inv, by: 'name' };
}

// ---------- Validators ----------
const row = (n: number): ImportRow => ({ n, status: 'create', messages: [], data: null, match: null });
const fail = (r: ImportRow, msg: string) => { r.status = 'error'; r.messages.push(msg); return r; };

export function validateClients(rows: Record<string, unknown>[], l: Lookups): ImportRow[] {
  const seenExt = new Map<string, number>();
  const seenName = new Map<string, number>();
  return rows.map((rec, i) => {
    const r = row(i + 1);
    const external_id = s(rec.external_id); const name = s(rec.name).replace(/\s+/g, ' ');
    const kind = s(rec.kind) || 'Corporate'; const residence = s(rec.residence).toUpperCase(); const city = s(rec.city);
    const booking_center = s(rec.booking_center).toUpperCase(); const email = s(rec.email).toLowerCase() || null; const wallet = s(rec.wallet) || null;
    const usRaw = readBool(rec.us_person);
    if (!external_id) fail(r, 'external_id is empty. Every client needs your identifier so later imports can find it.');
    if (external_id.length > 80) fail(r, 'external_id is longer than 80 characters.');
    if (name.length < 2) fail(r, 'name is missing or shorter than 2 characters.');
    if (name.length > 120) fail(r, 'name is longer than 120 characters.');
    if (kind.length < 2 || kind.length > 60) fail(r, 'kind must be 2 to 60 characters, for example Corporate or Individual.');
    if (!residence) fail(r, 'residence is empty. Use a jurisdiction code such as SG or AE-DIFC.');
    else if (!l.jurisdictions[residence] || residence === 'GLOBAL') fail(r, `Residence ${residence} is not a supported jurisdiction. Supported: ${Object.keys(l.jurisdictions).filter((j) => j !== 'GLOBAL' && !l.sanctioned[j]).sort().join(', ')}.`);
    else if (l.sanctioned[residence]) fail(r, `Refused: ${l.jurisdictions[residence]} is under comprehensive sanctions. ${sentence(l.sanctioned[residence])} Laissez does not create clients resident there. Remove the row.`);
    if (!city) fail(r, 'city is empty.');
    if (city.length > 80) fail(r, 'city is longer than 80 characters.');
    if (!booking_center) fail(r, 'booking_center is empty. Use an id from GET /v1/booking-centers.');
    else if (!l.bookingCenters[booking_center]) fail(r, `Booking center ${booking_center} does not exist. Known: ${Object.keys(l.bookingCenters).sort().join(', ')}.`);
    if (usRaw === undefined) fail(r, `us_person "${s(rec.us_person)}" is not a yes/no value. Use true or false.`);
    if (email && (!EMAIL.test(email) || email.length > 160)) fail(r, `email "${email}" is not a valid address.`);
    if (wallet && wallet.length > 80) fail(r, 'wallet is longer than 80 characters.');
    if (external_id) {
      const first = seenExt.get(external_id);
      if (first !== undefined) fail(r, `Duplicate external_id ${external_id}: first seen on row ${first}. Keep one row per client.`);
      else seenExt.set(external_id, r.n);
    }
    if (name.length >= 2) {
      const first = seenName.get(normName(name));
      if (first !== undefined && r.status !== 'error') r.messages.push(`Same name as row ${first}. Both rows are kept because their external ids differ.`);
      else if (first === undefined) seenName.set(normName(name), r.n);
    }
    const us_person = (usRaw ?? false) || residence === 'US';
    r.data = { external_id, name, kind, residence, city, booking_center, us_person, email, wallet } as ClientData;
    if (r.status === 'error') return r;
    const found = findInvestor(l, external_id, name);
    if (found && 'error' in found) return fail(r, found.error);
    if (!found) { r.status = 'create'; return r; }
    r.match = { investor_id: found.inv.id, name: found.inv.name, by: found.by };
    const inv = found.inv;
    const changes: string[] = [];
    if (inv.name !== name) changes.push('name');
    if (inv.kind !== undefined && inv.kind !== kind) changes.push('kind');
    if (inv.residence !== undefined && inv.residence !== residence) changes.push('residence');
    if (inv.city !== undefined && inv.city !== city) changes.push('city');
    if (inv.booking_center !== undefined && inv.booking_center !== booking_center) changes.push('booking_center');
    if (inv.us_person !== undefined && inv.us_person !== us_person) changes.push('us_person');
    if (inv.email !== undefined && (inv.email ?? null) !== email && email !== null) changes.push('email');
    if (inv.wallet !== undefined && wallet && inv.wallet !== wallet) changes.push('wallet');
    if (found.by === 'name') { changes.push('external_id'); r.messages.push(`Matched by name to existing client ${inv.id}; external id ${external_id} will be recorded on it. Check it is the same client.`); }
    r.changes = changes;
    if (!changes.length) { r.status = 'skip'; r.messages.push(`Already up to date (client ${inv.id}).`); return r; }
    const gated = l.gate?.('investor.update', { changed_fields: changes.filter((f) => f !== 'external_id') });
    if (gated) { r.status = 'skip'; r.messages.push(`Not applied: ${gated} Make this change from the client page so it goes through approval.`); return r; }
    r.status = 'update';
    r.messages.push(`Updates ${changes.join(', ')} on client ${inv.id}.`);
    return r;
  });
}

/** Reads evidence from the evidence column (JSON object or already an object) merged with flattened evidence_<field> columns. */
function readEvidence(rec: Record<string, unknown>): { evidence: Record<string, number | boolean>; error?: string } {
  const out: Record<string, number | boolean> = {};
  const raw = rec.evidence;
  if (raw !== undefined && raw !== null && s(raw) !== '') {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch { return { evidence: out, error: `evidence is not a JSON object: ${raw.slice(0, 60)}${raw.length > 60 ? '…' : ''}. Example: {"net_assets": 25000000, "opt_in": true}.` }; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { evidence: out, error: 'evidence must be a JSON object keyed by test field.' };
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
      else { const n = readNumber(v); const b = typeof v === 'string' ? readBool(v) : undefined; if (n !== undefined) out[k] = n; else if (b !== undefined && s(v) !== '') out[k] = b; else if (s(v) !== '') return { evidence: out, error: `evidence.${k} is "${s(v)}", which is neither a number nor true/false.` }; }
    }
  }
  for (const [k, v] of Object.entries(rec)) {
    if (!k.startsWith('evidence_') || k === 'evidence_ref') continue;
    const field = k.slice('evidence_'.length);
    if (!field || s(v) === '') continue;
    const n = readNumber(v); const b = readBool(v);
    if (typeof v === 'boolean') out[field] = v;
    else if (n !== undefined) out[field] = n;
    else if (b !== undefined) out[field] = b;
    else return { evidence: out, error: `${k} is "${s(v)}", which is neither a number nor true/false.` };
  }
  return { evidence: out };
}

export function validateCredentials(rows: Record<string, unknown>[], l: Lookups): ImportRow[] {
  const seen = new Map<string, number>();
  const out = rows.map((rec, i) => {
    const r = row(i + 1);
    const client_external_id = s(rec.client_external_id); const class_code = s(rec.class_code).toUpperCase();
    const evidence_ref = s(rec.evidence_ref) || null;
    const verified = readDate(rec.verified_on); const expires = readDate(rec.expires_on); const optIn = readDate(rec.opt_in_on);
    if (!client_external_id) fail(r, 'client_external_id is empty. Use the external_id the client was imported with.');
    if (!class_code) fail(r, 'class_code is empty. Use a code from GET /v1/investor-classes, for example SG_AI.');
    else if (!l.classes[class_code]) fail(r, `Unknown classification ${class_code}. Known: ${Object.keys(l.classes).sort().join(', ')}.`);
    if (verified === undefined) fail(r, `verified_on "${s(rec.verified_on)}" is not a date. Use YYYY-MM-DD.`);
    if (expires === undefined) fail(r, `expires_on "${s(rec.expires_on)}" is not a date. Use YYYY-MM-DD.`);
    if (optIn === undefined) fail(r, `opt_in_on "${s(rec.opt_in_on)}" is not a date. Use YYYY-MM-DD.`);
    const verified_on = verified ?? l.today;
    const expires_on = expires ?? addDaysIso(verified_on, 365);
    if (verified && verified > l.today) fail(r, `verified_on ${verified} is in the future.`);
    if (expires !== undefined && verified !== undefined && expires_on <= verified_on) fail(r, `expires_on ${expires_on} is not after verified_on ${verified_on}.`);
    if (expires !== undefined && expires_on <= l.today) fail(r, `expires_on ${expires_on} has already passed. An expired credential cannot be issued; verify the client again.`);
    const ev = readEvidence(rec);
    if (ev.error) fail(r, ev.error);
    const evidence = ev.evidence;
    if (optIn && evidence.opt_in === undefined) evidence.opt_in = true;
    r.data = { client_external_id, class_code, evidence, evidence_ref, verified_on, expires_on, opt_in_on: optIn ?? null } as CredentialData;
    if (r.status === 'error') return r;
    const found = findInvestor(l, client_external_id, null) ?? findInvestor(l, '', client_external_id);
    if (found && 'error' in found) return fail(r, found.error);
    if (!found) return fail(r, `No client with external id ${client_external_id}. Import the client first (clients template), or check the id.`);
    r.match = { investor_id: found.inv.id, name: found.inv.name, by: found.by };
    if (found.by === 'name') r.messages.push(`No client has external id ${client_external_id}; matched by name to ${found.inv.id} instead. Check it is the same client.`);
    const dupKey = `${found.inv.id}|${class_code}`;
    const first = seen.get(dupKey);
    if (first !== undefined) return fail(r, `Duplicate: ${class_code} for this client already appears on row ${first}.`);
    seen.set(dupKey, r.n);
    const test = l.findTest(class_code, found.inv.kind);
    if (!test) return fail(r, `${l.classes[class_code].label} (${class_code}) is not available to ${/^[aeiou]/i.test(found.inv.kind) ? 'an' : 'a'} ${found.inv.kind.toLowerCase()}. Check the client's kind.`);
    const res = test.check(evidence);
    if (!res.pass) return fail(r, `Threshold not met: ${res.reason}`);
    r.messages.push(res.reason);
    if (found.inv.credential_id) r.messages.push(`Replaces the active credential ${found.inv.credential_id}.`);
    r.status = 'create';
    return r;
  });
  // Maker-checker: rows the organization's policy would route to a second person are skipped, per client, with the reason.
  if (l.gate) {
    const byClient = new Map<string, ImportRow[]>();
    for (const r of out) if (r.status === 'create' && r.match) (byClient.get(r.match.investor_id) ?? byClient.set(r.match.investor_id, []).get(r.match.investor_id)!).push(r);
    for (const [invId, rs] of byClient) {
      const inv = l.investors.find((i) => i.id === invId);
      const reason = l.gate('credential.issue', { investor_kind: inv?.kind ?? '', classes: rs.map((r) => (r.data as CredentialData).class_code) });
      if (!reason) continue;
      for (const r of rs) { r.status = 'skip'; r.messages.push(`Not issued: ${reason} Issue it from the client page so it goes through approval.`); }
    }
  }
  return out;
}

export function validateHoldings(rows: Record<string, unknown>[], l: Lookups): ImportRow[] {
  const seen = new Map<string, number>();
  return rows.map((rec, i) => {
    const r = row(i + 1);
    const client_external_id = s(rec.client_external_id); const ticker = s(rec.ticker).toUpperCase();
    const unitsRaw = readNumber(rec.units); const since = readDate(rec.since);
    if (!client_external_id) fail(r, 'client_external_id is empty. Use the external_id the client was imported with.');
    if (!ticker) fail(r, 'ticker is empty.');
    else if (!l.funds[ticker]) fail(r, `No fund ${ticker} in this organization. Funds: ${Object.keys(l.funds).sort().join(', ') || 'none yet'}. Create the fund first.`);
    if (unitsRaw === undefined) fail(r, `units "${s(rec.units)}" is not a number.`);
    else if (unitsRaw < 0) fail(r, `units ${unitsRaw} is negative. A register position cannot be below zero.`);
    else if (unitsRaw > 1e15) fail(r, `units ${unitsRaw} is implausibly large. Check the file.`);
    if (since === undefined) fail(r, `since "${s(rec.since)}" is not a date. Use YYYY-MM-DD.`);
    if (since && since > l.today) fail(r, `since ${since} is in the future.`);
    const units = Math.round((unitsRaw ?? 0) * 100) / 100;
    if (unitsRaw !== undefined && Math.abs(units - unitsRaw) > 1e-9) r.messages.push(`units rounded to two decimals (${units}).`);
    r.data = { client_external_id, ticker, units, since: since ?? l.today } as HoldingData;
    if (r.status === 'error') return r;
    const found = findInvestor(l, client_external_id, null) ?? findInvestor(l, '', client_external_id);
    if (found && 'error' in found) return fail(r, found.error);
    if (!found) return fail(r, `No client with external id ${client_external_id}. Import the client first (clients template), or check the id.`);
    r.match = { investor_id: found.inv.id, name: found.inv.name, by: found.by };
    if (found.by === 'name') r.messages.push(`No client has external id ${client_external_id}; matched by name to ${found.inv.id} instead. Check it is the same client.`);
    const dupKey = `${found.inv.id}|${ticker}`;
    const first = seen.get(dupKey);
    if (first !== undefined) return fail(r, `Duplicate: ${ticker} for this client already appears on row ${first}. One row per client and fund.`);
    seen.set(dupKey, r.n);
    const current = l.holdings[holdingKey(found.inv.id, ticker)];
    r.register_units = current ?? null;
    if (current === undefined) {
      if (units === 0) { r.status = 'skip'; r.messages.push('0 units and no existing holding: nothing to record.'); }
      else { r.status = 'create'; r.messages.push(`New holding of ${units.toLocaleString('en-US')} ${ticker}.`); }
      return r;
    }
    if (Math.abs(current - units) < 0.005) { r.status = 'skip'; r.messages.push(`Register already shows ${current.toLocaleString('en-US')} units.`); return r; }
    r.status = 'update';
    const diff = +(units - current).toFixed(2);
    r.messages.push(units === 0 ? `Removes the holding; the register shows ${current.toLocaleString('en-US')} units.` : `Register shows ${current.toLocaleString('en-US')}, file has ${units.toLocaleString('en-US')} (difference ${diff > 0 ? '+' : ''}${diff.toLocaleString('en-US')}).`);
    return r;
  });
}

export function validateRows(type: ImportType, rows: Record<string, unknown>[], l: Lookups): ImportRow[] {
  if (type === 'clients') return validateClients(rows, l);
  if (type === 'credentials') return validateCredentials(rows, l);
  return validateHoldings(rows, l);
}

export function totalsOf(rows: ImportRow[]): Totals {
  const t: Totals = { rows: rows.length, create: 0, update: 0, skip: 0, error: 0 };
  for (const r of rows) t[r.status]++;
  return t;
}

/** Parse plus validate in one call: what POST /v1/imports stores and returns. */
export function previewImport(type: ImportType, format: ImportFormat, content: string, l: Lookups): { rows: ImportRow[]; totals: Totals; errors: string[]; warnings: string[]; columns: string[] } {
  const parsed = parseInput(type, format, content);
  if (parsed.errors.length) return { rows: [], totals: totalsOf([]), errors: parsed.errors, warnings: parsed.warnings, columns: parsed.columns };
  const rows = validateRows(type, parsed.rows, l);
  return { rows, totals: totalsOf(rows), errors: [], warnings: parsed.warnings, columns: parsed.columns };
}

/** Guesses the format from the content when the caller did not say. */
export function detectFormat(content: string): ImportFormat {
  const c = content.replace(/^﻿/, '').trimStart();
  return c.startsWith('[') || c.startsWith('{') ? 'json' : 'csv';
}
