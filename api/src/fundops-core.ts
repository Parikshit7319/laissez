// Fund operations core: dealing calendar, NAV strikes, income accruals, distributions,
// redemption notices and fund documents. Shared by the API routes, the seed and the daily job.
// Nothing here touches Hono, so the Node job can import it directly.
import type { Sql } from './db';
import type { DocReq, Notice, CapitalCallCtx } from '../../src/proto/engine';
import { dealingDateFor, fundClock, type Holidays } from '../../src/proto/engine';
import { holidaysFor } from './calendars';
import type { Investor, Fund } from '../../src/proto/data';
import { type Actor, auditQ, audit } from './http';
import { emit } from './ctx';
import { ApiError, addDays, daysBetween, id as newId, today } from './util';

// ---------- Types ----------
export type DealingFrequency = 'daily' | 'monthly' | 'quarterly';
export type ShareClassType = 'distributing' | 'accumulating';
export type TermsLike = { cutoffTime?: string | null; cutoffTz?: string | null; dealingFrequency?: string | null; noticeDays?: number | null };
export type FundRow = {
  ticker: string; name: string; short: string; currency: 'USD' | 'EUR'; nav: number; holders: number; holderCap: number | null;
  shareClassType: ShareClassType; cutoffTime: string; cutoffTz: string; dealingFrequency: DealingFrequency;
  noticeDays: number; gatePct: number | null; yieldBps: number | null; lockupMonths: number | null;
};
/** Schedules work after the response (route) or inline (job). Defaults to awaiting the promise. */
export type Defer = (p: Promise<unknown>) => void | Promise<unknown>;
const inline: Defer = (p) => p;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export const normFreq = (f?: string | null): DealingFrequency => (f === 'monthly' || f === 'quarterly' ? f : 'daily');

// ---------- Calendar (business days are Monday to Friday, matching the engine) ----------
export const isBusinessDay = (d: string) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6; };
export const lastDayOfMonth = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10);
export const firstDayOfMonth = (d: string) => `${d.slice(0, 7)}-01`;
export function lastBusinessDayOfMonth(d: string): string {
  let x = lastDayOfMonth(d);
  while (!isBusinessDay(x)) x = addDays(x, -1);
  return x;
}
export const isLastDayOfMonth = (d: string) => lastDayOfMonth(d) === d;
/** First day of the dealing period that contains `date`: the day itself, its month or its quarter. */
export function periodStart(freq: DealingFrequency, date: string): string {
  if (freq === 'daily') return date;
  if (freq === 'monthly') return firstDayOfMonth(date);
  const m = Number(date.slice(5, 7));
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${date.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`;
}

const parseHHMM = (s?: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const validCutoff = (s: string) => parseHHMM(s) !== null;
export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; }
}

/** Wall-clock date and time at the fund's cut-off time zone, and whether the cut-off has passed. */
export function fundNow(fund: TermsLike, now: Date = new Date()) {
  const clock = fundClock(now.toISOString(), fund.cutoffTz || 'UTC');
  const cut = parseHHMM(fund.cutoffTime);
  const date = clock?.date ?? now.toISOString().slice(0, 10);
  return { date, time: clock?.hhmm ?? now.toISOString().slice(11, 16), tz: clock?.tz ?? 'UTC', beforeCutoff: clock && cut !== null ? clock.minutes < cut : true };
}

/** Public holidays for the fund's cut-off time zone (api/src/calendars.ts), or none for an unknown zone. */
export const fundHolidays = (fund: TermsLike): string[] => holidaysFor(fund.cutoffTz);
/**
 * Dealing date for an order received at `now`. Same rules as the engine: daily funds deal today if it is a
 * business day and the cut-off has not passed, else the next business day; monthly funds on the last business
 * day of the month; quarterly funds on the last business day of the quarter. `holidays` defaults to the
 * calendar of the fund's cut-off time zone; pass null to use weekends only.
 */
export function dealingDate(fund: TermsLike, now: Date = new Date(), holidays: Holidays = fundHolidays(fund)): string {
  const n = fundNow(fund, now);
  return dealingDateFor(normFreq(fund.dealingFrequency), n.date, n.beforeCutoff, holidays);
}
/** First dealing date on or after `from` (a date, not an instant). */
export function nextDealingDate(fund: TermsLike, from: string, holidays: Holidays = fundHolidays(fund)): string {
  return dealingDateFor(normFreq(fund.dealingFrequency), from, true, holidays);
}
/** Earliest dealing date for a redemption notice filed at `now`: at least notice_days away, never before the current dealing date. */
export function noticeDealingDate(fund: TermsLike, now: Date = new Date(), holidays: Holidays = fundHolidays(fund)): string {
  const dd = dealingDate(fund, now, holidays);
  const days = fund.noticeDays ?? 0;
  if (days <= 0) return dd;
  const fromNotice = nextDealingDate(fund, addDays(fundNow(fund, now).date, days), holidays);
  return fromNotice > dd ? fromNotice : dd;
}
/**
 * The day a distribution falls due for the period containing `date`: the last calendar day of the month for
 * daily and monthly funds, the last calendar day of the quarter for quarterly funds. The daily job pays when
 * `date` equals this day.
 */
export function distributionDueOn(fund: Pick<TermsLike, 'dealingFrequency'>, date: string): string {
  if (normFreq(fund.dealingFrequency) !== 'quarterly') return lastDayOfMonth(date);
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7));
  const endM = Math.ceil(m / 3) * 3;
  return lastDayOfMonth(`${y}-${String(endM).padStart(2, '0')}-01`);
}
/** First day of the distribution period that ends on distributionDueOn(fund, date). */
export function distributionPeriodStart(fund: Pick<TermsLike, 'dealingFrequency'>, date: string): string {
  return periodStart(normFreq(fund.dealingFrequency) === 'quarterly' ? 'quarterly' : 'monthly', date);
}

// ---------- Fund rows ----------
const FUND_COLS = `ticker, name, short_name, currency, nav::float8 as nav, holders, holder_cap, share_class_type, cutoff_time, cutoff_tz, dealing_frequency,
  notice_days, gate_pct::float8 as gate_pct, yield_bps::float8 as yield_bps, lockup_months`;
const toFundRow = (f: any): FundRow => ({
  ticker: f.ticker, name: f.name, short: f.short_name, currency: f.currency, nav: Number(f.nav), holders: Number(f.holders), holderCap: f.holder_cap,
  shareClassType: f.share_class_type === 'accumulating' ? 'accumulating' : 'distributing', cutoffTime: f.cutoff_time, cutoffTz: f.cutoff_tz,
  dealingFrequency: normFreq(f.dealing_frequency), noticeDays: Number(f.notice_days ?? 0), gatePct: f.gate_pct == null ? null : Number(f.gate_pct),
  yieldBps: f.yield_bps == null ? null : Number(f.yield_bps), lockupMonths: f.lockup_months,
});
export async function loadFundRow(sql: Sql, ws: string, ticker: string): Promise<FundRow> {
  const [f] = await sql.query(`select ${FUND_COLS} from funds where workspace_id = $1 and ticker = $2`, [ws, ticker]);
  if (!f) throw new ApiError(404, 'not_found', `No fund with ticker ${ticker} in this organization.`);
  return toFundRow(f);
}
export async function loadFundRows(sql: Sql, ws: string): Promise<FundRow[]> {
  return (await sql.query(`select ${FUND_COLS} from funds where workspace_id = $1 order by ticker`, [ws])).map(toFundRow);
}

// ---------- Engine context loaders ----------
/** Current (not superseded) documents for the tickers, and each investor's acknowledgments as document id to sha256. */
export async function docsCtx(sql: Sql, ws: string, tickers: string[], investorIds: string[]): Promise<{ documents: Record<string, DocReq[]>; acks: Record<string, Record<string, string>> }> {
  const [docs, acks] = await Promise.all([
    tickers.length
      ? sql`select id, ticker, title, doc_type, version, sha256, jurisdiction, audience, required from fund_documents
          where workspace_id = ${ws} and ticker = any(${tickers}) and superseded_at is null order by ticker, doc_type, jurisdiction nulls first`
      : Promise.resolve([] as any[]),
    investorIds.length
      ? sql`select investor_id, document_id, sha256 from doc_acknowledgments where workspace_id = ${ws} and investor_id = any(${investorIds})`
      : Promise.resolve([] as any[]),
  ]);
  const documents: Record<string, DocReq[]> = Object.fromEntries(tickers.map((t) => [t, [] as DocReq[]]));
  for (const d of docs) {
    (documents[d.ticker] ??= []).push({
      id: d.id, ticker: d.ticker, title: d.title, docType: d.doc_type, version: Number(d.version), sha256: d.sha256,
      jurisdiction: d.jurisdiction ?? null, audience: d.audience === 'retail' || d.audience === 'professional' ? d.audience : 'all', required: !!d.required,
    });
  }
  const out: Record<string, Record<string, string>> = Object.fromEntries(investorIds.map((i) => [i, {} as Record<string, string>]));
  for (const a of acks) (out[a.investor_id] ??= {})[a.document_id] = a.sha256;
  return { documents, acks: out };
}

/**
 * Liquidity state for the Fund terms layer.
 * AUM: an organization only sees its own clients' units, so the value held here (units x NAV) is scaled up by
 * holders of record over holders in this organization. A sandbox with 3 of a fund's 97 holders then gates against
 * the whole fund, not 3% of it. With no holders here, AUM is 0 and the engine skips the gate.
 * redeemedInPeriod: redemption decisions settled (or settling) since the start of the current dealing period.
 */
export async function lifecycleCtx(sql: Sql, ws: string, ticker: string, investorIds: string[]): Promise<{ aum: Record<string, number>; redeemedInPeriod: Record<string, number>; notices: Record<string, Notice[]> }> {
  const [f] = await sql.query(`select ${FUND_COLS} from funds where workspace_id = $1 and ticker = $2`, [ws, ticker]);
  if (!f) return { aum: {}, redeemedInPeriod: {}, notices: {} };
  const fund = toFundRow(f);
  const start = periodStart(fund.dealingFrequency, fundNow(fund).date);
  const [held, red, notes] = await Promise.all([
    sql`select coalesce(sum(units), 0)::float8 as units, count(*) filter (where units > 0)::int as n from holdings where workspace_id = ${ws} and ticker = ${ticker}`,
    sql`select coalesce(sum(d.amount), 0)::float8 as total from decisions d
        join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id and s.status in ('settled', 'pending')
        where d.workspace_id = ${ws} and d.ticker = ${ticker} and d.action = 'redeem' and s.created_at >= ${start}::date`,
    investorIds.length
      ? sql`select investor_id, units::float8 as units, dealing_date::text as dealing_date from redemption_notices
          where workspace_id = ${ws} and ticker = ${ticker} and status = 'pending' and investor_id = any(${investorIds}) order by dealing_date`
      : Promise.resolve([] as any[]),
  ]);
  const notices: Record<string, Notice[]> = {};
  for (const n of notes) (notices[`${n.investor_id}:${ticker}`] ??= []).push({ units: Number(n.units), dealingDate: n.dealing_date });
  return { aum: { [ticker]: aumOf(fund, Number(held[0].units), Number(held[0].n)) }, redeemedInPeriod: { [ticker]: r2(Number(red[0].total)) }, notices };
}
export function aumOf(fund: Pick<FundRow, 'nav' | 'holders'>, unitsHere: number, holdersHere: number): number {
  if (!holdersHere || unitsHere <= 0) return 0;
  return r2(unitsHere * fund.nav * Math.max(1, fund.holders / holdersHere));
}

// ---------- Simulated NAV (sandbox market data for the daily job and the seed) ----------
export type SimFund = { ticker: string; nav: number; shareClassType?: string | null; dealingFrequency?: string | null; yieldBps?: number | null };
/** Accumulating classes compound from a launch NAV. NMEL launched its tokenized class at 1.000000. */
export const NAV_ANCHORS: Record<string, { date: string; nav: number }> = { NMEL: { date: '2025-01-02', nav: 1 } };
/** Monthly-valued funds drift around a fixed base so the series stays within +/- 0.2% of it. */
export const NAV_BASE: Record<string, number> = { AGPC: 1.0412 };

function unit(key: string): number {
  // FNV-1a hash mapped to [-1, 1). Deterministic per key, no state.
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  // murmur3 finalizer, so keys that differ only in their last characters still land far apart.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}
/** Daily-dealing funds value every business day; others value on the last business day of each month. */
export function isValuationDay(fund: Pick<SimFund, 'dealingFrequency'>, date: string): boolean {
  return normFreq(fund.dealingFrequency) === 'daily' ? isBusinessDay(date) : lastBusinessDayOfMonth(date) === date;
}
/**
 * Simulated NAV for `date`, or null when the fund does not value that day.
 * - Distributing, daily dealing (TWLF): stable NAV, income paid out; the day's yield moves within +/- 2 bps of the fund yield.
 * - Accumulating (NMEL): income stays in the NAV, which compounds daily at the fund yield from the previous strike.
 * - Distributing, monthly valuation (AGPC): NAV drifts within +/- 0.2% of its base, deterministically by month.
 */
export function simulateNav(fund: SimFund, date: string, prev?: { date: string; nav: number } | null): { nav: number; dailyYieldBps: number | null } | null {
  if (!isValuationDay(fund, date)) return null;
  const y = fund.yieldBps ?? 0;
  if (fund.shareClassType === 'accumulating') {
    const anchor = prev && prev.date < date ? prev : NAV_ANCHORS[fund.ticker];
    const nav = anchor ? anchor.nav * Math.pow(1 + y / 10_000 / 365, Math.max(0, daysBetween(anchor.date, date))) : fund.nav;
    return { nav: r6(nav), dailyYieldBps: y || null };
  }
  if (normFreq(fund.dealingFrequency) === 'daily') {
    const nav = prev?.nav ?? fund.nav;
    return { nav: r4(nav), dailyYieldBps: y ? r2(y + 2 * unit(`${fund.ticker}:${date}`)) : null };
  }
  const base = NAV_BASE[fund.ticker] ?? prev?.nav ?? fund.nav;
  return { nav: r4(base * (1 + 0.002 * unit(`${fund.ticker}:${date.slice(0, 7)}`))), dailyYieldBps: y || null };
}

// ---------- NAV strikes ----------
export type StrikeResult = { ticker: string; date: string; nav: number; previous: { date: string; nav: number } | null; change_bps: number | null; daily_yield_bps: number | null; latest: boolean; replaced: boolean };
/** Record the NAV for a date. Updates funds.nav when this is the most recent strike. Audits and emits nav.struck. */
export async function strikeNav(sql: Sql, ws: string, ticker: string, date: string, nav: number, actor: Actor, opts: { dailyYieldBps?: number | null; defer?: Defer } = {}): Promise<StrikeResult> {
  const fund = await loadFundRow(sql, ws, ticker);
  if (!(nav > 0) || nav > 1_000_000) throw new ApiError(422, 'invalid_nav', 'NAV must be a positive number.');
  const [prevRows, sameRows, laterRows] = await Promise.all([
    sql`select nav_date::text as date, nav::float8 as nav from nav_history where workspace_id = ${ws} and ticker = ${ticker} and nav_date < ${date}::date order by nav_date desc limit 1`,
    sql`select nav::float8 as nav from nav_history where workspace_id = ${ws} and ticker = ${ticker} and nav_date = ${date}::date`,
    sql`select 1 from nav_history where workspace_id = ${ws} and ticker = ${ticker} and nav_date > ${date}::date limit 1`,
  ]);
  const previous = prevRows[0] ? { date: prevRows[0].date, nav: Number(prevRows[0].nav) } : null;
  const latest = !laterRows.length;
  let dy = opts.dailyYieldBps;
  if (dy === undefined) {
    if (fund.shareClassType === 'accumulating' && previous && previous.nav > 0) {
      const days = Math.max(1, daysBetween(previous.date, date));
      dy = r2(((nav / previous.nav - 1) * 365 * 10_000) / days);
    } else dy = fund.yieldBps;
  }
  const stored = r6(nav);
  const by = actor.name;
  const changeBps = previous ? r2((stored / previous.nav - 1) * 10_000) : null;
  const q: any[] = [
    sql`insert into nav_history (workspace_id, ticker, nav_date, nav, daily_yield_bps, struck_by, struck_at) values (${ws}, ${ticker}, ${date}::date, ${stored}, ${dy ?? null}, ${by}, now())
        on conflict (workspace_id, ticker, nav_date) do update set nav = excluded.nav, daily_yield_bps = excluded.daily_yield_bps, struck_by = excluded.struck_by, struck_at = now()`,
  ];
  if (latest) q.push(sql`update funds set nav = ${stored} where workspace_id = ${ws} and ticker = ${ticker}`);
  q.push(auditQ(sql, ws, actor, 'nav.struck', ticker, { date, nav: stored, previous, change_bps: changeBps, daily_yield_bps: dy ?? null, replaced: sameRows.length > 0 }));
  await sql.transaction(q);
  const out: StrikeResult = { ticker, date, nav: stored, previous, change_bps: changeBps, daily_yield_bps: dy ?? null, latest, replaced: sameRows.length > 0 };
  await (opts.defer ?? inline)(emit(sql, ws, 'nav.struck', { ticker, date, nav: stored, currency: fund.currency, change_bps: changeBps, daily_yield_bps: dy ?? null }));
  return out;
}

/** Most recent NAV on or before a date, falling back to the fund's current NAV. */
export async function navOn(sql: Sql, ws: string, ticker: string, date: string): Promise<{ date: string | null; nav: number; dailyYieldBps: number | null }> {
  const [row] = await sql`select nav_date::text as date, nav::float8 as nav, daily_yield_bps::float8 as dy from nav_history where workspace_id = ${ws} and ticker = ${ticker} and nav_date <= ${date}::date order by nav_date desc limit 1`;
  if (row) return { date: row.date, nav: Number(row.nav), dailyYieldBps: row.dy == null ? null : Number(row.dy) };
  const [f] = await sql`select nav::float8 as nav from funds where workspace_id = ${ws} and ticker = ${ticker}`;
  return { date: null, nav: Number(f?.nav ?? 0), dailyYieldBps: null };
}

// ---------- Accruals ----------
export type AccrualRun = { ticker: string; date: string; nav: number; rate_bps: number; holders: number; inserted: number; amount: number; skipped?: string };
/**
 * Daily income accrual for distributing funds: units x NAV x yield / 10,000 / 365 per holder.
 * Idempotent per date and holder. The rate is the yield struck with that day's NAV, else the fund yield.
 * Days already inside a paid distribution period are skipped.
 */
export async function runAccruals(sql: Sql, ws: string, date: string, ticker?: string, actor: Actor | null = null): Promise<AccrualRun[]> {
  const funds = (await loadFundRows(sql, ws)).filter((f) => (!ticker || f.ticker === ticker) && f.shareClassType === 'distributing' && (f.yieldBps ?? 0) > 0);
  const out: AccrualRun[] = [];
  for (const f of funds) {
    const [n, paid] = await Promise.all([
      navOn(sql, ws, f.ticker, date),
      sql`select id from distributions where workspace_id = ${ws} and ticker = ${f.ticker} and ${date}::date between period_start and period_end limit 1`,
    ]);
    const rate = n.date === date && n.dailyYieldBps != null ? n.dailyYieldBps : (f.yieldBps ?? 0);
    if (paid.length) { out.push({ ticker: f.ticker, date, nav: n.nav, rate_bps: rate, holders: 0, inserted: 0, amount: 0, skipped: `Already paid in distribution ${paid[0].id}.` }); continue; }
    const rows = await sql`insert into accruals (workspace_id, ticker, accrual_date, investor_id, units, rate_bps, amount)
      select h.workspace_id, h.ticker, ${date}::date, h.investor_id, h.units, ${rate}, round(h.units * ${n.nav}::numeric * ${rate}::numeric / 3650000, 6)
      from holdings h where h.workspace_id = ${ws} and h.ticker = ${f.ticker} and h.units > 0 and h.since <= ${date}::date
      on conflict (workspace_id, ticker, accrual_date, investor_id) do nothing
      returning investor_id, amount::float8 as amount`;
    const [{ holders }] = await sql`select count(*)::int as holders from holdings where workspace_id = ${ws} and ticker = ${f.ticker} and units > 0 and since <= ${date}::date`;
    const amount = r6(rows.reduce((s: number, r: any) => s + Number(r.amount), 0));
    const run: AccrualRun = { ticker: f.ticker, date, nav: n.nav, rate_bps: rate, holders: Number(holders), inserted: rows.length, amount };
    if (rows.length) await audit(sql, ws, actor, 'accruals.run', f.ticker, run);
    out.push(run);
  }
  return out;
}

// ---------- Distributions ----------
export type DistributionLine = { investor_id: string; amount: number; units: number; reinvested: boolean };
export type DistributionResult = {
  id: string; ticker: string; period_start: string; period_end: string; paid_on: string; currency: string; nav: number;
  total_amount: number; reinvested_units: number; cash_paid: number; holders: number; lines: DistributionLine[];
};
/**
 * Pays unpaid accruals for a period. Income is reinvested as new units at the current NAV for holders who still
 * hold the fund, and paid in cash to holders who have fully redeemed. One statement marks the accruals, writes
 * the distribution and credits holdings, so a concurrent second call finds nothing left to pay.
 */
export async function payDistribution(sql: Sql, ws: string, ticker: string, periodStart: string, periodEnd: string, actor: Actor, opts: { defer?: Defer } = {}): Promise<DistributionResult> {
  const fund = await loadFundRow(sql, ws, ticker);
  if (fund.shareClassType !== 'distributing') throw new ApiError(409, 'not_distributing', `${fund.short} is an accumulating class. Income stays in the NAV, so there is nothing to distribute.`);
  if (periodStart > periodEnd) throw new ApiError(422, 'invalid_period', 'The period must start on or before the day it ends.');
  const paidOn = today();
  if (periodEnd > paidOn) throw new ApiError(422, 'invalid_period', `The period cannot end after today (${paidOn}).`);
  const nav = (await navOn(sql, ws, ticker, paidOn)).nav;
  if (!(nav > 0)) throw new ApiError(409, 'no_nav', `Strike a NAV for ${ticker} before paying a distribution.`);
  const dstId = newId('dst', 12);
  const rows = await sql.query(
    `with marked as (
       update accruals set distribution_id = $2
       where workspace_id = $1 and ticker = $3 and accrual_date between $4::date and $5::date and distribution_id is null
       returning investor_id, amount
     ), per as (
       select m.investor_id, sum(m.amount) as amount,
         exists (select 1 from holdings h where h.workspace_id = $1 and h.ticker = $3 and h.investor_id = m.investor_id) as holds
       from marked m group by m.investor_id
     ), ins as (
       insert into distributions (workspace_id, id, ticker, period_start, period_end, paid_on, total_amount, reinvested_units, holders)
       select $1, $2, $3, $4::date, $5::date, $6::date, sum(amount), coalesce(sum(case when holds then round(amount / $7::numeric, 2) else 0 end), 0), count(*)
       from per having count(*) > 0
       returning id
     ), upd as (
       update holdings h set units = h.units + round(per.amount / $7::numeric, 2)
       from per where h.workspace_id = $1 and h.ticker = $3 and h.investor_id = per.investor_id
       returning h.investor_id
     )
     select per.investor_id, per.amount::float8 as amount, per.holds,
       (case when per.holds then round(per.amount / $7::numeric, 2) else 0 end)::float8 as units,
       (select count(*) from ins)::int as inserted, (select count(*) from upd)::int as credited
     from per order by per.investor_id`,
    [ws, dstId, ticker, periodStart, periodEnd, paidOn, nav],
  );
  if (!rows.length) throw new ApiError(409, 'nothing_to_pay', `No unpaid accruals for ${ticker} between ${periodStart} and ${periodEnd}. Run accruals first, or check whether the period was already paid.`);
  const lines: DistributionLine[] = rows.map((r: any) => ({ investor_id: r.investor_id, amount: r6(Number(r.amount)), units: r2(Number(r.units)), reinvested: !!r.holds }));
  const total = r6(lines.reduce((s, l) => s + l.amount, 0));
  const result: DistributionResult = {
    id: dstId, ticker, period_start: periodStart, period_end: periodEnd, paid_on: paidOn, currency: fund.currency, nav,
    total_amount: total, reinvested_units: r2(lines.reduce((s, l) => s + l.units, 0)), cash_paid: r6(lines.filter((l) => !l.reinvested).reduce((s, l) => s + l.amount, 0)),
    holders: lines.length, lines,
  };
  await audit(sql, ws, actor, 'distribution.paid', dstId, { ticker, period_start: periodStart, period_end: periodEnd, total_amount: total, reinvested_units: result.reinvested_units, cash_paid: result.cash_paid, holders: lines.length, nav });
  await (opts.defer ?? inline)(emit(sql, ws, 'distribution.paid', result));
  return result;
}

/** Unpaid accrued income for a fund: total, date range and holders. */
export async function accruedUnpaid(sql: Sql, ws: string, ticker: string) {
  const [r] = await sql`select coalesce(sum(amount), 0)::float8 as total, min(accrual_date)::text as from_date, max(accrual_date)::text as to_date,
      count(distinct accrual_date)::int as days, count(distinct investor_id)::int as holders
    from accruals where workspace_id = ${ws} and ticker = ${ticker} and distribution_id is null`;
  return { total: r6(Number(r.total)), from: r.from_date as string | null, to: r.to_date as string | null, days: Number(r.days), holders: Number(r.holders) };
}

// ---------- Redemption notices ----------
/**
 * Marks pending notices executed after a redemption settles, oldest first, until `units` are covered.
 * Call from the settlement flow; returns the queries so they can join its transaction.
 */
export async function noticeExecutionQueries(sql: Sql, ws: string, investorId: string, ticker: string, units: number, dealingDateLimit: string): Promise<any[]> {
  const rows = await sql`select id, units::float8 as units from redemption_notices where workspace_id = ${ws} and investor_id = ${investorId} and ticker = ${ticker}
    and status = 'pending' and dealing_date <= ${dealingDateLimit}::date order by dealing_date, created_at`;
  const q: any[] = [];
  let left = units;
  for (const r of rows) {
    if (left <= 0.0001) break;
    q.push(sql`update redemption_notices set status = 'executed' where workspace_id = ${ws} and id = ${r.id}`);
    left -= Number(r.units);
  }
  return q;
}

// ---------- Documents ----------
export type DocLike = { jurisdiction: string | null; audience: string; required: boolean };
/**
 * Whether a document needs this investor's acknowledgment for the fund. Mirrors the engine's Documents layer:
 * jurisdiction must be empty or match residence; retail documents apply to investors who reach the fund as retail
 * clients; professional documents apply to investors with a current professional classification.
 */
export function docApplies(inv: Investor, fund: Fund, d: DocLike, asOf: string = today()): boolean {
  if (d.jurisdiction != null && d.jurisdiction !== inv.residence) return false;
  if (d.audience === 'all') return true;
  const dist = fund.distribution[inv.residence];
  const valid = (code: string) => inv.classifications.some((c) => c.code === code && c.expires >= asOf);
  const proForFund = (dist?.accepts ?? []).some((c) => c !== 'EU_RETAIL' && valid(c));
  const retailOnly = !!dist?.accepts.includes('EU_RETAIL') && !proForFund;
  const professional = !retailOnly && inv.classifications.some((c) => c.code !== 'EU_RETAIL' && c.expires >= asOf);
  return d.audience === 'retail' ? retailOnly : d.audience === 'professional' ? professional : false;
}

// ---------- Closed-end funds ----------
export type FundType = 'open_ended' | 'closed_end';
/**
 * Fund type and, when an order answers a capital call, the call context the engine reads. Open-ended funds
 * return no call. The call's amount is the notice amount for the investor, so the engine can insist on it.
 */
export async function closedEndCtx(sql: Sql, ws: string, ticker: string, investorId: string | null, capitalCallId: string | null | undefined): Promise<{ fundType: FundType; capitalCall: CapitalCallCtx | null }> {
  const [f] = await sql`select fund_type from funds where workspace_id = ${ws} and ticker = ${ticker}`;
  const fundType: FundType = f?.fund_type === 'closed_end' ? 'closed_end' : 'open_ended';
  if (!capitalCallId) return { fundType, capitalCall: null };
  const [call] = await sql`select id, ticker, call_number, due_on::text as due_on, status from capital_calls where workspace_id = ${ws} and id = ${capitalCallId}`;
  if (!call) throw new ApiError(404, 'not_found', `No capital call ${capitalCallId} in this organization.`);
  const [n] = investorId
    ? await sql`select amount::float8 as amount, status from call_notices where workspace_id = ${ws} and capital_call_id = ${capitalCallId} and investor_id = ${investorId}`
    : [null];
  return { fundType, capitalCall: { id: call.id, ticker: call.ticker, callNumber: Number(call.call_number), dueOn: call.due_on, status: call.status, amount: n ? Number(n.amount) : null } };
}

export const DOC_TYPES: Record<string, string> = {
  offering_memorandum: 'Offering memorandum', prospectus: 'Prospectus', private_placement_memorandum: 'Private placement memorandum',
  supplement: 'Jurisdiction supplement', kid: 'Key information document', subscription_agreement: 'Subscription agreement',
  factsheet: 'Factsheet', annual_report: 'Annual report', other: 'Other document',
};
