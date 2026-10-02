// Daily fund operations for every fund in every active organization and sandbox:
//   1. strike the day's simulated NAV if none is recorded (daily funds on business days, monthly-valued funds at month end),
//   2. run income accruals for distributing funds (idempotent per day and holder),
//   3. on the last calendar day of the month, pay the month's accrued income as a distribution.
// Run from api/: npx tsx jobs/fundops.ts [YYYY-MM-DD]   (the date defaults to today in UTC)
import type { Sql } from '../src/db';
import type { Actor } from '../src/http';
import { ApiError, today } from '../src/util';
import { loadFundRows, simulateNav, strikeNav, runAccruals, payDistribution, isLastDayOfMonth, firstDayOfMonth } from '../src/fundops-core';
import { db, log, pool, fmt } from './lib';

const JOB: Actor = { kind: 'system', id: 'fundops-daily', name: 'Laissez daily fund operations' };

type Result = {
  id: string; name: string; ok: boolean; ms: number; error?: string;
  navs: string[]; accrued: { ticker: string; holders: number; amount: number; currency: string }[];
  paid: { ticker: string; id: string; amount: number; holders: number; currency: string }[]; skipped: string[];
};

async function runWorkspace(sql: Sql, ws: { id: string; name: string }, date: string): Promise<Result> {
  const start = Date.now();
  const r: Result = { id: ws.id, name: ws.name, ok: true, ms: 0, navs: [], accrued: [], paid: [], skipped: [] };
  try {
    const funds = await loadFundRows(sql, ws.id);
    const ccy = Object.fromEntries(funds.map((f) => [f.ticker, f.currency]));
    // 1. NAV
    for (const f of funds) {
      const have = await sql`select 1 from nav_history where workspace_id = ${ws.id} and ticker = ${f.ticker} and nav_date = ${date}::date`;
      if (have.length) continue;
      const [prev] = await sql`select nav_date::text as date, nav::float8 as nav from nav_history where workspace_id = ${ws.id} and ticker = ${f.ticker} and nav_date < ${date}::date order by nav_date desc limit 1`;
      const sim = simulateNav(f, date, prev ? { date: prev.date, nav: Number(prev.nav) } : null);
      if (!sim) continue;
      const s = await strikeNav(sql, ws.id, f.ticker, date, sim.nav, JOB, { dailyYieldBps: sim.dailyYieldBps });
      r.navs.push(`${f.ticker} ${s.nav}`);
    }
    // 2. Accruals
    for (const a of await runAccruals(sql, ws.id, date, undefined, JOB)) {
      if (a.skipped) r.skipped.push(`${a.ticker}: ${a.skipped}`);
      else if (a.inserted) r.accrued.push({ ticker: a.ticker, holders: a.inserted, amount: a.amount, currency: ccy[a.ticker] });
    }
    // 3. Month-end distributions
    if (isLastDayOfMonth(date)) {
      for (const f of funds.filter((x) => x.shareClassType === 'distributing')) {
        try {
          const d = await payDistribution(sql, ws.id, f.ticker, firstDayOfMonth(date), date, JOB);
          r.paid.push({ ticker: f.ticker, id: d.id, amount: d.total_amount, holders: d.holders, currency: f.currency });
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'nothing_to_pay' || e.code === 'no_nav')) r.skipped.push(`${f.ticker}: ${e.message}`);
          else throw e;
        }
      }
    }
  } catch (e: any) {
    r.ok = false; r.error = e?.message ?? String(e);
  }
  r.ms = Date.now() - start;
  return r;
}

const arg = process.argv[2];
if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) { console.error(`Expected a date in YYYY-MM-DD format, got "${arg}".`); process.exit(2); }
const date = arg ?? today();
if (date > today()) { console.error(`${date} is in the future. Fund operations only run for today or earlier.`); process.exit(2); }

const started = Date.now();
const sql = db();
const workspaces = await sql`select id, name from workspaces where expires_at is null or expires_at > now() order by created_at`;
log(`Daily fund operations for ${date}: ${workspaces.length} active workspace${workspaces.length === 1 ? '' : 's'}${isLastDayOfMonth(date) ? ', month end so distributions are paid' : ''}`);
const results = await pool(workspaces as { id: string; name: string }[], 4, (w) => runWorkspace(sql, w, date));

const money = (n: number, c: string) => `${c} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
for (const r of results) {
  if (!r.ok) { log(`  ${r.name.slice(0, 40).padEnd(40)} FAILED: ${r.error}`); continue; }
  const parts = [
    r.navs.length ? `NAV ${r.navs.join(', ')}` : 'NAV already struck or not a valuation day',
    r.accrued.length ? `accrued ${r.accrued.map((a) => `${a.ticker} ${money(a.amount, a.currency)} (${a.holders})`).join(', ')}` : 'no new accruals',
    ...(r.paid.length ? [`paid ${r.paid.map((p) => `${p.ticker} ${money(p.amount, p.currency)} to ${p.holders} as ${p.id}`).join(', ')}`] : []),
  ];
  log(`  ${r.name.slice(0, 40).padEnd(40)} ${parts.join('; ')}  ${r.ms} ms`);
  for (const s of r.skipped) log(`      skipped ${s}`);
}
const ok = results.filter((r) => r.ok);
const failed = results.length - ok.length;
const navCount = ok.reduce((n, r) => n + r.navs.length, 0);
const accrualRows = ok.reduce((n, r) => n + r.accrued.reduce((m, a) => m + a.holders, 0), 0);
const paidCount = ok.reduce((n, r) => n + r.paid.length, 0);
log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${fmt(ok.length)} workspaces, ${fmt(navCount)} NAVs struck, ${fmt(accrualRows)} accrual rows, ${fmt(paidCount)} distributions paid${failed ? `, ${failed} failed` : ''}.`);
if (failed) {
  console.error(`${failed} workspace${failed === 1 ? '' : 's'} failed. See the errors above; the others were updated.`);
  process.exit(1);
}
