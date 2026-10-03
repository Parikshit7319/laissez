// One CSV writer for the Worker and the browser. Two jobs: RFC 4180 quoting, and keeping a spreadsheet from running a
// cell as a formula. Names, subjects and free text in Laissez come from other people (a client list, an identity
// provider, a counterparty), so a cell that starts with = + - @ tab or carriage return gets a leading apostrophe,
// the guard OWASP recommends. Genuine negative numbers stay numbers.

const FORMULA = /^[\t\r ]*(?:[=+@]|-(?!\d+(?:\.\d+)?\s*$))|^[\t\r]/;

export function csvText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Text that a spreadsheet would read as a formula, prefixed so it reads as text. Numbers and booleans pass untouched. */
export function neutralize(s: string, v: unknown = s): string {
  if (typeof v === 'string' && FORMULA.test(s)) return `'${s}`;
  // JSON of an object or array starts with { or [ and is safe; a string that looks like a formula is the only risk.
  return s;
}

/** One quoted cell, safe to open in Excel, Numbers and Sheets. */
export function csvCell(v: unknown): string {
  return `"${neutralize(csvText(v), v).replace(/"/g, '""')}"`;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');
/** Rows joined with CRLF and a trailing newline, as RFC 4180 asks. */
export const csvTable = (rows: unknown[][]) => rows.map(csvRow).join('\r\n') + '\r\n';
