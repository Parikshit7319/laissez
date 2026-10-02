// Cursor pagination for list endpoints. The cursor is the base64url of "created_at|id" of the last row on the
// page, so a page is stable while new rows arrive. Lists order by (created_at desc, id desc) and read limit + 1
// rows to know whether another page exists. Responses are { data, next_cursor }.
import type { Context } from 'hono';
import { ApiError } from './util';

export type Cursor = { at: string; id: string };
export type Page = { limit: number; cursor: Cursor | null; /** Bound values for the SQL predicate: null when there is no cursor. */ at: string | null; id: string | null };

// Cursors hold an ISO timestamp and a row id, both ASCII, so plain base64 is enough.
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export function encodeCursor(at: string | Date, id: string | number): string {
  const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  return b64url(`${iso}|${id}`);
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  let text: string;
  try { text = fromB64url(raw); } catch { throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid. Use the next_cursor value from the previous page.'); }
  const i = text.indexOf('|');
  if (i < 1) throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid. Use the next_cursor value from the previous page.');
  const at = text.slice(0, i); const id = text.slice(i + 1);
  if (Number.isNaN(Date.parse(at)) || !id) throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid. Use the next_cursor value from the previous page.');
  return { at, id };
}

/** Reads ?limit and ?cursor. limit defaults to 50 and is capped at 200. */
export function pageParams(c: Context, def = 50, max = 200): Page {
  const n = Number(c.req.query('limit') ?? def);
  const limit = Math.max(1, Math.min(max, Number.isFinite(n) ? Math.floor(n) : def));
  const cursor = decodeCursor(c.req.query('cursor'));
  return { limit, cursor, at: cursor?.at ?? null, id: cursor?.id ?? null };
}

/**
 * Builds the page from limit + 1 rows: drops the extra row and returns the cursor of the last row kept.
 * `key` names the created_at and id fields of a row (defaults: created_at, id).
 */
export function pageOut<T extends Record<string, any>>(rows: T[], page: Page, key: { at?: string; id?: string } = {}): { data: T[]; next_cursor: string | null; limit: number } {
  const atKey = key.at ?? 'created_at'; const idKey = key.id ?? 'id';
  const more = rows.length > page.limit;
  const data = more ? rows.slice(0, page.limit) : rows;
  const last = data[data.length - 1];
  return { data, next_cursor: more && last ? encodeCursor(last[atKey], last[idKey]) : null, limit: page.limit };
}
