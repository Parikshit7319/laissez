// Public holiday calendars for the dealing centers Laissez funds use, keyed by IANA time zone (funds.cutoff_tz).
// The engine's dealingDateFor skips these dates on top of weekends. Dates are ISO strings. Weekend holidays are
// listed where the source lists them; they change nothing, since weekends are never dealing days.
//
// Sources (all read Oct 2, 2026; ids refer to src/data/sources.ts):
//   New York     cal-sifma (2026), cal-nyse-2027 (2027, SIFMA had not published; Columbus Day and Veterans Day added from the federal calendar)
//   London       cal-uk (GOV.UK bank holidays, England and Wales)
//   Dublin       cal-ie (Citizens Information) plus Good Friday, which Euronext Dublin observes
//   Luxembourg   cal-lu (Guichet.lu statutory list; dates derived)
//   Zurich       cal-ch (BX Swiss market calendar, same closed days as SIX and the SNB; 2027 derived)
//   Frankfurt    cal-target2 (TARGET closing days: the euro payment calendar)
//   Singapore    cal-sg (Ministry of Manpower)
//   Hong Kong    cal-hk-2026, cal-hk-2027 (Government gazette announcements)
//   Dubai, Abu Dhabi  cal-uae (federal list; Islamic dates for 2027 are provisional)
//   Tokyo        cal-jpx (Japan Exchange Group)
//   Mumbai       cal-nse (NSE capital market list for 2026; 2027 provisional)
// `provisional` marks years whose dates were estimated or not yet gazetted when read.

export type Calendar = { key: string; name: string; source: string; holidays: Record<string, string[]>; provisional?: string[] };

const NEW_YORK: Calendar = {
  key: 'America/New_York', name: 'New York (SIFMA)', source: 'cal-sifma',
  holidays: {
    '2026': ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    '2027': ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24'],
  },
  provisional: ['2027'],
};
const LONDON: Calendar = {
  key: 'Europe/London', name: 'London', source: 'cal-uk',
  holidays: {
    '2026': ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'],
    '2027': ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28'],
  },
};
const DUBLIN: Calendar = {
  key: 'Europe/Dublin', name: 'Dublin', source: 'cal-ie',
  holidays: {
    '2026': ['2026-01-01', '2026-02-02', '2026-03-17', '2026-04-03', '2026-04-06', '2026-05-04', '2026-06-01', '2026-08-03', '2026-10-26', '2026-12-25', '2026-12-26'],
    '2027': ['2027-01-01', '2027-02-01', '2027-03-17', '2027-03-26', '2027-03-29', '2027-05-03', '2027-06-07', '2027-08-02', '2027-10-25', '2027-12-25', '2027-12-26'],
  },
};
const LUXEMBOURG: Calendar = {
  key: 'Europe/Luxembourg', name: 'Luxembourg', source: 'cal-lu',
  holidays: {
    '2026': ['2026-01-01', '2026-04-06', '2026-05-01', '2026-05-09', '2026-05-14', '2026-05-25', '2026-06-23', '2026-08-15', '2026-11-01', '2026-12-25', '2026-12-26'],
    '2027': ['2027-01-01', '2027-03-29', '2027-05-01', '2027-05-09', '2027-05-06', '2027-05-17', '2027-06-23', '2027-08-15', '2027-11-01', '2027-12-25', '2027-12-26'],
  },
};
const ZURICH: Calendar = {
  key: 'Europe/Zurich', name: 'Zurich (SIX)', source: 'cal-ch',
  holidays: {
    '2026': ['2026-01-01', '2026-01-02', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-12-24', '2026-12-25', '2026-12-31'],
    '2027': ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-06', '2027-05-17', '2027-12-24', '2027-12-31'],
  },
  provisional: ['2027'],
};
const FRANKFURT: Calendar = {
  key: 'Europe/Berlin', name: 'Frankfurt (TARGET2)', source: 'cal-target2',
  holidays: {
    '2026': ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25', '2026-12-26'],
    '2027': ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-01', '2027-12-25', '2027-12-26'],
  },
};
const SINGAPORE: Calendar = {
  key: 'Asia/Singapore', name: 'Singapore', source: 'cal-sg',
  holidays: {
    '2026': ['2026-01-01', '2026-02-17', '2026-02-18', '2026-03-21', '2026-04-03', '2026-05-01', '2026-05-27', '2026-05-31', '2026-06-01', '2026-08-09', '2026-08-10', '2026-11-08', '2026-11-09', '2026-12-25'],
    '2027': ['2027-01-01', '2027-02-06', '2027-02-07', '2027-02-08', '2027-03-10', '2027-03-26', '2027-05-01', '2027-05-17', '2027-05-20', '2027-08-09', '2027-10-28', '2027-12-25'],
  },
};
const HONG_KONG: Calendar = {
  key: 'Asia/Hong_Kong', name: 'Hong Kong', source: 'cal-hk-2026',
  holidays: {
    '2026': ['2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-04', '2026-04-06', '2026-04-07', '2026-05-01', '2026-05-25', '2026-06-19', '2026-07-01', '2026-09-26', '2026-10-01', '2026-10-19', '2026-12-25'],
    '2027': ['2027-01-01', '2027-02-06', '2027-02-08', '2027-02-09', '2027-03-26', '2027-03-27', '2027-03-29', '2027-04-05', '2027-05-01', '2027-05-13', '2027-06-09', '2027-07-01', '2027-09-16', '2027-10-01', '2027-10-08', '2027-12-25', '2027-12-27'],
  },
};
// UAE federal holidays. 2026 per the Cabinet list; 2027 Islamic dates are astronomical estimates pending moon sighting.
const UAE_2026 = ['2026-01-01', '2026-03-20', '2026-03-21', '2026-03-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-06-16', '2026-08-25', '2026-12-02', '2026-12-03'];
const UAE_2027 = ['2027-01-01', '2027-03-09', '2027-03-10', '2027-03-11', '2027-05-15', '2027-05-16', '2027-05-17', '2027-05-18', '2027-06-06', '2027-08-14', '2027-12-02', '2027-12-03'];
const DUBAI: Calendar = { key: 'Asia/Dubai', name: 'Dubai (DIFC)', source: 'cal-uae', holidays: { '2026': UAE_2026, '2027': UAE_2027 }, provisional: ['2027'] };
/** Abu Dhabi shares the Asia/Dubai zone; ADGM follows the same federal list. Registered under its own key for funds that name it. */
const ABU_DHABI: Calendar = { key: 'Asia/Abu_Dhabi', name: 'Abu Dhabi (ADGM)', source: 'cal-uae', holidays: { '2026': UAE_2026, '2027': UAE_2027 }, provisional: ['2027'] };
const TOKYO: Calendar = {
  key: 'Asia/Tokyo', name: 'Tokyo (JPX)', source: 'cal-jpx',
  holidays: {
    '2026': ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23', '2026-12-31'],
    '2027': ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22', '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23', '2027-12-31'],
  },
};
const MUMBAI: Calendar = {
  key: 'Asia/Kolkata', name: 'Mumbai (NSE)', source: 'cal-nse',
  holidays: {
    '2026': ['2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25'],
    '2027': ['2027-01-26', '2027-03-22', '2027-03-26', '2027-04-14', '2027-04-15', '2027-05-17', '2027-06-16', '2027-09-03', '2027-10-08', '2027-10-29', '2027-11-24'],
  },
  provisional: ['2027'],
};

export const CALENDARS: Calendar[] = [NEW_YORK, LONDON, DUBLIN, LUXEMBOURG, ZURICH, FRANKFURT, SINGAPORE, HONG_KONG, DUBAI, ABU_DHABI, TOKYO, MUMBAI];
const byKey = new Map(CALENDARS.map((c) => [c.key, c]));
/** Zones that share a center's calendar. */
const ALIASES: Record<string, string> = { 'Europe/Paris': 'Europe/Berlin', 'Europe/Amsterdam': 'Europe/Berlin', 'Europe/Brussels': 'Europe/Berlin', 'Europe/Madrid': 'Europe/Berlin', 'Europe/Rome': 'Europe/Berlin', 'Asia/Muscat': 'Asia/Dubai', 'Asia/Calcutta': 'Asia/Kolkata', UTC: 'Europe/London' };

export function calendarFor(tz: string | null | undefined): Calendar | null {
  if (!tz) return null;
  return byKey.get(tz) ?? byKey.get(ALIASES[tz] ?? '') ?? null;
}
/** Every holiday date for a calendar across the years it covers. */
export function holidaysFor(tz: string | null | undefined): string[] {
  const c = calendarFor(tz);
  return c ? Object.values(c.holidays).flat() : [];
}
/** Engine context slice: { [cutoffTz]: holidays }. Returns an empty object for an unknown zone so the engine falls back to weekends only. */
export function calendarsCtx(tz: string | null | undefined): Record<string, string[]> {
  const days = holidaysFor(tz);
  return tz && days.length ? { [tz]: days } : {};
}
/** Monday to Friday and not a holiday in the calendar. Unknown calendars skip weekends only. */
export function isBusinessDay(date: string, calendar: string | Calendar | null | undefined): boolean {
  const w = new Date(date + 'T00:00:00Z').getUTCDay();
  if (w === 0 || w === 6) return false;
  const c = typeof calendar === 'string' ? calendarFor(calendar) : calendar;
  if (!c) return true;
  const year = c.holidays[date.slice(0, 4)];
  return !year || !year.includes(date);
}
