// Formatting for live figures. All dates are shown in UTC, matching how the API buckets days.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export const toMs = (v: string | number | Date) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime());

/** "Sep 29" from YYYY-MM-DD. */
export function fmtDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
/** "Sep 29, 2026" from YYYY-MM-DD. */
export function fmtDayLong(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
/** "14:32 UTC". */
export function fmtTime(v: string | number | Date): string {
  const d = new Date(toMs(v));
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
/** "Oct 2, 14:32 UTC". */
export function fmtDateTime(v: string | number | Date): string {
  const d = new Date(toMs(v));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
export const isoDay = (v: string | number | Date) => new Date(toMs(v)).toISOString().slice(0, 10);

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function fmtAgo(v: string | number | Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - toMs(v)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

/** "45 s", "4 min 12 s", "1 h 10 min", "2 days 3 h". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} days ${h % 24} h` : `${d} days`;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Uptime percentage, floored so 99.999 never shows as 100. */
export function fmtUptime(p: number | null | undefined): string {
  if (p == null) return 'No data';
  if (p >= 100) return '100%';
  return `${(Math.floor(p * 100) / 100).toFixed(2)}%`;
}

/** A 0 to 1 rate as a percentage with one decimal, trimmed: 0.382 -> "38.2%", 1 -> "100%". */
export function fmtRate(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return 'n/a';
  const v = Math.round(r * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

export function fmtMoney(v: number, currency: string, compact = false): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? (Math.abs(v) >= 1000 ? 1 : 0) : 0,
    }).format(v);
  } catch {
    return `${fmtInt(v)} ${currency}`;
  }
}

export function fmtCompact(v: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

/** Joins names: "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
