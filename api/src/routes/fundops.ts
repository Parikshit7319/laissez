// Fund operations API: lifecycle terms, NAV, accruals, distributions, redemption notices,
// fund documents and investor acknowledgments. Mounted under /v1.
import { z } from 'zod';
import { router, need, body, bg, audit, auditQ, type C } from '../http';
import { emit, loadFunds, loadInvestors } from '../ctx';
import { ApiError, id as newId, sha256, today, addDays, daysBetween, canonical } from '../util';
import {
  loadFundRow, fundNow, dealingDate, noticeDealingDate, periodStart, aumOf, lifecycleCtx, strikeNav, runAccruals, payDistribution,
  accruedUnpaid, docApplies, validCutoff, validTimeZone, DOC_TYPES, type FundRow,
} from '../fundops-core';
import * as fundops2 from './fundops2';

export const routes = router();
// Closed-end fund operations (commitments, capital calls, capital distributions) live in ./fundops2 and mount here,
// so index.ts needs no change. Both routers share the /v1 prefix.
routes.route('/', fundops2.routes);

const ticker = (c: C) => c.req.param('ticker')!.toUpperCase();
const dateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD format.').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Not a real date.');
const r2 = (n: number) => Math.round(n * 100) / 100;
const FREQ_TEXT = { daily: 'every business day', monthly: 'on the last business day of each month', quarterly: 'on the last business day of each quarter' } as const;

function termsOf(f: FundRow) {
  return { share_class_type: f.shareClassType, dealing_frequency: f.dealingFrequency, cutoff_time: f.cutoffTime, cutoff_tz: f.cutoffTz, notice_days: f.noticeDays, gate_pct: f.gatePct, yield_bps: f.yieldBps };
}
function notFuture(date: string, what: string) {
  if (date > today()) throw new ApiError(422, 'future_date', `${what} cannot be after today (${today()}).`);
}

// ---------- Lifecycle ----------
routes.get('/funds/:ticker/lifecycle', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const f = await loadFundRow(sql, ws, t);
  const now = new Date();
  const clock = fundNow(f, now);
  const since = addDays(today(), -90);
  const [series, latestRows, dists, notices, held, lc, accrued] = await Promise.all([
    sql`select nav_date::text as date, nav::float8 as nav, daily_yield_bps::float8 as daily_yield_bps from nav_history where workspace_id = ${ws} and ticker = ${t} and nav_date >= ${since}::date order by nav_date`,
    sql`select nav_date::text as date, nav::float8 as nav, daily_yield_bps::float8 as daily_yield_bps, struck_by, struck_at from nav_history where workspace_id = ${ws} and ticker = ${t} order by nav_date desc limit 12`,
    sql`select id, period_start::text as period_start, period_end::text as period_end, paid_on::text as paid_on, total_amount::float8 as total_amount, reinvested_units::float8 as reinvested_units, holders, created_at
        from distributions where workspace_id = ${ws} and ticker = ${t} order by period_end desc limit 12`,
    sql`select n.id, n.investor_id, i.name as investor, n.units::float8 as units, n.notice_date::text as notice_date, n.dealing_date::text as dealing_date
        from redemption_notices n join investors i on i.workspace_id = n.workspace_id and i.id = n.investor_id
        where n.workspace_id = ${ws} and n.ticker = ${t} and n.status = 'pending' order by n.dealing_date, n.created_at`,
    sql`select coalesce(sum(units), 0)::float8 as units, count(*) filter (where units > 0)::int as n from holdings where workspace_id = ${ws} and ticker = ${t}`,
    lifecycleCtx(sql, ws, t, []),
    f.shareClassType === 'distributing' ? accruedUnpaid(sql, ws, t) : Promise.resolve(null),
  ]);
  // Monthly-valued funds have few strikes in 90 days, so show at least the last 6 for a readable chart.
  const navSeries = series.length >= 6 ? series : [...latestRows].slice(0, 6).reverse();
  const latest = latestRows[0] ?? null;
  const first = navSeries[0];
  const dd = dealingDate(f, now);
  const aum = aumOf(f, Number(held[0].units), Number(held[0].n));
  const redeemed = lc.redeemedInPeriod[t] ?? 0;
  const gateLimit = f.gatePct && aum > 0 ? r2((f.gatePct / 100) * aum) : null;
  return c.json({
    ticker: t, name: f.name, short: f.short, currency: f.currency, as_of: today(),
    terms: termsOf(f),
    nav: {
      current: f.nav,
      latest,
      series: navSeries,
      change_bps: latest && first && first.nav > 0 ? r2((latest.nav / first.nav - 1) * 10_000) : null,
      valuation: f.dealingFrequency === 'daily' ? 'Struck every business day' : 'Struck on the last business day of each month',
    },
    dealing: {
      fund_time: { date: clock.date, time: clock.time, tz: clock.tz },
      before_cutoff: clock.beforeCutoff,
      next_dealing_date: dd,
      notice_dealing_date: f.noticeDays > 0 ? noticeDealingDate(f, now) : null,
      period_start: periodStart(f.dealingFrequency, clock.date),
      summary: `Deals ${FREQ_TEXT[f.dealingFrequency]}. Orders received before ${f.cutoffTime} ${f.cutoffTz} deal at that day's NAV.${f.noticeDays > 0 ? ` Redemptions need ${f.noticeDays} days' notice, so a notice filed now deals on ${noticeDealingDate(f, now)}.` : ''}`,
    },
    liquidity: {
      aum, aum_basis: 'Units held by clients of this organization at the latest NAV, scaled to the fund\'s holders of record.',
      holders_here: Number(held[0].n), holders_of_record: f.holders,
      redeemed_in_period: redeemed, gate_limit: gateLimit, gate_used_pct: gateLimit ? r2((redeemed / gateLimit) * 100) : null,
    },
    accrued,
    distributions: dists,
    notices: { pending: notices.length, pending_units: r2(notices.reduce((s: number, n: any) => s + Number(n.units), 0)), data: notices },
  });
});

const termsIn = z.object({
  share_class_type: z.enum(['distributing', 'accumulating']).optional(),
  dealing_frequency: z.enum(['daily', 'monthly', 'quarterly']).optional(),
  cutoff_time: z.string().refine(validCutoff, 'Use a 24-hour time such as 16:00.').optional(),
  cutoff_tz: z.string().min(1).max(64).refine(validTimeZone, 'Use an IANA time zone such as America/New_York.').optional(),
  notice_days: z.number().int().min(0).max(365).optional(),
  gate_pct: z.number().gt(0).max(100).nullable().optional(),
  yield_bps: z.number().min(0).max(5000).nullable().optional(),
}).strict();
const updateTerms = async (c: C) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, termsIn);
  const f = await loadFundRow(sql, ws, t);
  if (!Object.keys(b).length) throw new ApiError(422, 'empty', 'Send at least one term to change.');
  if (b.share_class_type === 'accumulating' && f.shareClassType === 'distributing') {
    const a = await accruedUnpaid(sql, ws, t);
    if (a.total > 0) throw new ApiError(409, 'unpaid_accruals', `${t} has ${a.total.toFixed(2)} ${f.currency} of accrued income not yet paid (${a.from} to ${a.to}). Pay the distribution before switching to an accumulating class.`);
  }
  const before = termsOf(f);
  const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k);
  await sql.transaction([
    sql`update funds set
      share_class_type = coalesce(${b.share_class_type ?? null}, share_class_type),
      dealing_frequency = coalesce(${b.dealing_frequency ?? null}, dealing_frequency),
      cutoff_time = coalesce(${b.cutoff_time ?? null}, cutoff_time),
      cutoff_tz = coalesce(${b.cutoff_tz ?? null}, cutoff_tz),
      notice_days = coalesce(${b.notice_days ?? null}::int, notice_days),
      gate_pct = case when ${has('gate_pct')} then ${b.gate_pct ?? null}::numeric else gate_pct end,
      yield_bps = case when ${has('yield_bps')} then ${b.yield_bps ?? null}::numeric else yield_bps end
      where workspace_id = ${ws} and ticker = ${t}`,
    auditQ(sql, ws, actor, 'fund.terms_updated', t, { before, changes: b }),
  ]);
  const next = await loadFundRow(sql, ws, t);
  bg(c, emit(sql, ws, 'fund.terms_updated', { ticker: t, before, after: termsOf(next) }));
  return c.json({ ticker: t, terms: termsOf(next), next_dealing_date: dealingDate(next), note: 'New terms apply to orders evaluated from now on. Pending redemption notices keep the dealing date they were filed for.' });
};
routes.patch('/funds/:ticker/terms', updateTerms);
// POST alias for clients that cannot send PATCH.
routes.post('/funds/:ticker/terms', updateTerms);

// ---------- NAV ----------
routes.post('/funds/:ticker/nav', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, z.object({ nav: z.number().positive().max(1_000_000), date: dateZ.optional(), daily_yield_bps: z.number().min(-1000).max(5000).nullable().optional(), confirm: z.boolean().optional() }));
  const date = b.date ?? today();
  notFuture(date, 'A NAV date');
  if (daysBetween(date, today()) > 400) throw new ApiError(422, 'too_old', 'NAVs older than 400 days cannot be restruck here.');
  const [prev] = await sql`select nav::float8 as nav, nav_date::text as date from nav_history where workspace_id = ${ws} and ticker = ${t} and nav_date < ${date}::date order by nav_date desc limit 1`;
  if (prev && !b.confirm) {
    const move = Math.abs(b.nav / Number(prev.nav) - 1);
    if (move > 0.02) throw new ApiError(409, 'confirm_large_move', `This NAV is ${(move * 100).toFixed(2)}% away from the ${prev.date} strike of ${Number(prev.nav).toFixed(4)}. Check it, then send confirm: true to strike it.`, [`Previous NAV ${Number(prev.nav).toFixed(6)} on ${prev.date}`, `New NAV ${b.nav.toFixed(6)} on ${date}`]);
  }
  const r = await strikeNav(sql, ws, t, date, b.nav, actor, { dailyYieldBps: b.daily_yield_bps === undefined ? undefined : b.daily_yield_bps, defer: (p) => bg(c, p) });
  return c.json(r, 201);
});

// ---------- Accruals and distributions ----------
routes.post('/funds/:ticker/accruals/run', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, z.object({ date: dateZ.optional() }));
  const date = b.date ?? today();
  notFuture(date, 'An accrual date');
  const f = await loadFundRow(sql, ws, t);
  if (f.shareClassType !== 'distributing') throw new ApiError(409, 'not_distributing', `${f.short} is an accumulating class. Income stays in the NAV, so there are no accruals to run.`);
  if (!f.yieldBps) throw new ApiError(409, 'no_yield', `Set a yield for ${t} in its terms before running accruals.`);
  const [run] = await runAccruals(sql, ws, date, t, actor);
  return c.json({ ...run, currency: f.currency, note: run.skipped ?? (run.inserted ? `Accrued ${run.amount.toFixed(2)} ${f.currency} for ${run.inserted} holder${run.inserted === 1 ? '' : 's'}.` : `Accruals for ${date} were already recorded. Running again changes nothing.`) }, run.inserted ? 201 : 200);
});

routes.post('/funds/:ticker/distributions', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, z.object({ period_start: dateZ, period_end: dateZ }));
  const r = await payDistribution(sql, ws, t, b.period_start, b.period_end, actor, { defer: (p) => bg(c, p) });
  const names = await loadNames(c, r.lines.map((l) => l.investor_id));
  return c.json({ ...r, lines: r.lines.map((l) => ({ ...l, investor: names[l.investor_id] ?? l.investor_id })) }, 201);
});

routes.get('/funds/:ticker/distributions', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const f = await loadFundRow(sql, ws, t);
  const [rows, lines] = await Promise.all([
    sql`select id, period_start::text as period_start, period_end::text as period_end, paid_on::text as paid_on, total_amount::float8 as total_amount, reinvested_units::float8 as reinvested_units, holders, created_at
        from distributions where workspace_id = ${ws} and ticker = ${t} order by period_end desc`,
    sql`select a.distribution_id, a.investor_id, i.name as investor, sum(a.amount)::float8 as amount, count(*)::int as days
        from accruals a join investors i on i.workspace_id = a.workspace_id and i.id = a.investor_id
        where a.workspace_id = ${ws} and a.ticker = ${t} and a.distribution_id is not null group by 1, 2, 3 order by 3`,
  ]);
  return c.json({
    ticker: t, currency: f.currency, share_class_type: f.shareClassType,
    data: rows.map((r: any) => ({ ...r, lines: lines.filter((l: any) => l.distribution_id === r.id).map(({ distribution_id, ...l }: any) => l) })),
  });
});

async function loadNames(c: C, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await c.get('sql')`select id, name from investors where workspace_id = ${c.get('ws')} and id = any(${ids})`;
  return Object.fromEntries(rows.map((r: any) => [r.id, r.name]));
}

// ---------- Redemption notices ----------
routes.post('/redemption-notices', async (c) => {
  const actor = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ investor_id: z.string().min(1), ticker: z.string().min(1), units: z.number().positive() }));
  const t = b.ticker.toUpperCase();
  const f = await loadFundRow(sql, ws, t);
  if (f.noticeDays <= 0) throw new ApiError(409, 'notice_not_required', `${f.short} redeems without notice. Place a redemption order instead.`);
  const [inv] = await sql`select i.id, i.name, h.units::float8 as units, h.since::text as since from investors i
    left join holdings h on h.workspace_id = i.workspace_id and h.investor_id = i.id and h.ticker = ${t}
    where i.workspace_id = ${ws} and i.id = ${b.investor_id}`;
  if (!inv) throw new ApiError(404, 'not_found', `No client with id ${b.investor_id} in this organization.`);
  const held = Number(inv.units ?? 0);
  if (!held) throw new ApiError(422, 'no_holding', `${inv.name} holds no ${t}.`);
  const [{ pending }] = await sql`select coalesce(sum(units), 0)::float8 as pending from redemption_notices where workspace_id = ${ws} and investor_id = ${b.investor_id} and ticker = ${t} and status = 'pending'`;
  const units = r2(b.units);
  if (units + Number(pending) > held + 0.001) {
    throw new ApiError(422, 'insufficient_units', `${inv.name} holds ${held.toLocaleString('en-US')} units of ${t}, and ${Number(pending).toLocaleString('en-US')} are already under notice. At most ${r2(held - Number(pending)).toLocaleString('en-US')} more units can be noticed.`);
  }
  const now = new Date();
  const dealing = noticeDealingDate(f, now);
  const noticeDate = fundNow(f, now).date;
  const warnings: string[] = [];
  if (f.lockupMonths && inv.since) {
    const ends = new Date(inv.since + 'T00:00:00Z'); ends.setUTCMonth(ends.getUTCMonth() + f.lockupMonths);
    const e = ends.toISOString().slice(0, 10);
    if (e > dealing) warnings.push(`The ${f.lockupMonths}-month lock-up ends ${e}, after the dealing date. The redemption will be denied unless the lock-up has ended.`);
  }
  const lc = await lifecycleCtx(sql, ws, t, []);
  const aum = lc.aum[t] ?? 0;
  if (f.gatePct && aum > 0 && units * f.nav > (f.gatePct / 100) * aum) {
    warnings.push(`At today's NAV this notice is worth about ${r2(units * f.nav).toLocaleString('en-US')} ${f.currency}, above the ${f.gatePct}% gate of ${r2((f.gatePct / 100) * aum).toLocaleString('en-US')} ${f.currency} per dealing period. Expect it to be reduced pro rata.`);
  }
  const nid = newId('rn', 12);
  await sql.transaction([
    sql`insert into redemption_notices (workspace_id, id, investor_id, ticker, units, notice_date, dealing_date, status) values (${ws}, ${nid}, ${b.investor_id}, ${t}, ${units}, ${noticeDate}::date, ${dealing}::date, 'pending')`,
    auditQ(sql, ws, actor, 'redemption_notice.filed', nid, { investor_id: b.investor_id, ticker: t, units, notice_date: noticeDate, dealing_date: dealing, notice_days: f.noticeDays }),
  ]);
  const out = { id: nid, investor_id: b.investor_id, investor: inv.name, ticker: t, units, notice_date: noticeDate, dealing_date: dealing, status: 'pending', warnings,
    note: `Notice filed. ${inv.name} can redeem up to ${units.toLocaleString('en-US')} units dealing on ${dealing}, at that day's NAV. Place the redemption order before the ${f.cutoffTime} ${f.cutoffTz} cut-off on that date.` };
  bg(c, emit(sql, ws, 'redemption_notice.filed', out));
  return c.json(out, 201);
});

routes.get('/redemption-notices', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const t = c.req.query('ticker')?.toUpperCase() ?? null;
  const status = c.req.query('status') ?? null;
  const inv = c.req.query('investor_id') ?? null;
  const rows = await sql`select n.id, n.investor_id, i.name as investor, n.ticker, f.short_name as fund, f.currency, f.nav::float8 as nav, n.units::float8 as units,
      n.notice_date::text as notice_date, n.dealing_date::text as dealing_date, n.status, n.created_at
    from redemption_notices n
    join investors i on i.workspace_id = n.workspace_id and i.id = n.investor_id
    join funds f on f.workspace_id = n.workspace_id and f.ticker = n.ticker
    where n.workspace_id = ${ws} and (${t}::text is null or n.ticker = ${t}) and (${status}::text is null or n.status = ${status}) and (${inv}::text is null or n.investor_id = ${inv})
    order by (n.status = 'pending') desc, n.dealing_date, n.created_at desc limit 200`;
  return c.json({ data: rows.map((r: any) => ({ ...r, value: r2(Number(r.units) * Number(r.nav)) })) });
});

routes.delete('/redemption-notices/:id', async (c) => {
  const actor = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const nid = c.req.param('id');
  const [n] = await sql`select id, investor_id, ticker, units::float8 as units, dealing_date::text as dealing_date, status from redemption_notices where workspace_id = ${ws} and id = ${nid}`;
  if (!n) throw new ApiError(404, 'not_found', 'No redemption notice with that id.');
  if (n.status !== 'pending') throw new ApiError(409, 'not_pending', `This notice is already ${n.status}. Only pending notices can be cancelled.`);
  await sql.transaction([
    sql`update redemption_notices set status = 'cancelled' where workspace_id = ${ws} and id = ${nid} and status = 'pending'`,
    auditQ(sql, ws, actor, 'redemption_notice.cancelled', nid, { investor_id: n.investor_id, ticker: n.ticker, units: n.units, dealing_date: n.dealing_date }),
  ]);
  bg(c, emit(sql, ws, 'redemption_notice.cancelled', { id: nid, investor_id: n.investor_id, ticker: n.ticker }));
  return c.json({ id: nid, status: 'cancelled' });
});

// ---------- Documents ----------
const DOC_LIST_COLS = `d.id, d.ticker, d.doc_type, d.title, d.version, d.jurisdiction, d.audience, d.sha256, d.required, d.published_at, d.published_by, d.superseded_at,
  length(d.content) as chars, left(d.content, 240) as excerpt`;

routes.get('/funds/:ticker/documents', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  await loadFundRow(sql, ws, t);
  const rows = await sql.query(
    `select ${DOC_LIST_COLS}, (select count(*)::int from doc_acknowledgments a where a.workspace_id = d.workspace_id and a.document_id = d.id and a.sha256 = d.sha256) as acknowledgments
     from fund_documents d where d.workspace_id = $1 and d.ticker = $2 order by d.doc_type, d.jurisdiction nulls first, d.version desc`, [ws, t]);
  const data = rows.map((r: any) => ({ ...r, status: r.superseded_at ? 'superseded' : 'current', type_label: DOC_TYPES[r.doc_type] ?? r.doc_type }));
  return c.json({ ticker: t, current: data.filter((d: any) => d.status === 'current').length, superseded: data.filter((d: any) => d.status === 'superseded').length, data });
});

const docIn = z.object({
  doc_type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use a lowercase type such as offering_memorandum.'),
  title: z.string().trim().min(3).max(140),
  jurisdiction: z.string().max(12).nullable().optional(),
  audience: z.enum(['all', 'retail', 'professional']).default('all'),
  content: z.string().min(50, 'Document content is too short.').max(200_000),
  required: z.boolean().optional(),
});
routes.post('/funds/:ticker/documents', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, docIn);
  await loadFundRow(sql, ws, t);
  const jur = b.jurisdiction ? b.jurisdiction : null;
  if (jur) {
    const [j] = await sql`select code from jurisdictions where code = ${jur}`;
    if (!j) throw new ApiError(422, 'unknown_jurisdiction', `Unknown jurisdiction ${jur}. Leave it empty for a document that applies everywhere.`);
  }
  const required = b.required ?? b.doc_type !== 'factsheet';
  const hash = await sha256(b.content);
  const [cur] = await sql`select id, version, sha256 from fund_documents where workspace_id = ${ws} and ticker = ${t} and doc_type = ${b.doc_type} and jurisdiction is not distinct from ${jur} and superseded_at is null`;
  if (cur && cur.sha256 === hash) throw new ApiError(409, 'unchanged', `This content is identical to version ${cur.version}. Nothing was published.`);
  const [{ v }] = await sql`select coalesce(max(version), 0)::int as v from fund_documents where workspace_id = ${ws} and ticker = ${t} and doc_type = ${b.doc_type} and jurisdiction is not distinct from ${jur}`;
  const version = Number(v) + 1;
  const docId = newId('doc', 12);
  const q: any[] = [];
  if (cur) q.push(sql`update fund_documents set superseded_at = now() where workspace_id = ${ws} and id = ${cur.id} and superseded_at is null`);
  q.push(sql`insert into fund_documents (workspace_id, id, ticker, doc_type, title, version, jurisdiction, audience, content, sha256, required, published_by)
    values (${ws}, ${docId}, ${t}, ${b.doc_type}, ${b.title}, ${version}, ${jur}, ${b.audience}, ${b.content}, ${hash}, ${required}, ${actor.name})`);
  q.push(auditQ(sql, ws, actor, 'document.published', docId, { ticker: t, doc_type: b.doc_type, title: b.title, version, jurisdiction: jur, audience: b.audience, required, sha256: hash, supersedes: cur?.id ?? null }));
  await sql.transaction(q);
  // Holders in this organization who must acknowledge the new version before their next subscription.
  const holders = await sql`select investor_id from holdings where workspace_id = ${ws} and ticker = ${t} and units > 0`;
  const [funds, invs] = await Promise.all([loadFunds(sql, ws, t), loadInvestors(sql, ws, holders.map((h: any) => h.investor_id))]);
  const fund = funds[t];
  const affected = required && fund ? Object.values(invs).filter((i) => docApplies(i, fund, { jurisdiction: jur, audience: b.audience, required })).map((i) => ({ investor_id: i.id, name: i.name })) : [];
  const out = {
    id: docId, ticker: t, doc_type: b.doc_type, title: b.title, version, jurisdiction: jur, audience: b.audience, required, sha256: hash, supersedes: cur?.id ?? null,
    holders_to_acknowledge: affected,
    note: required
      ? `Version ${version} is now current.${cur ? ` It replaces version ${cur.version}.` : ''} Holders must acknowledge version ${version} before their next subscription or incoming transfer. ${affected.length} holder${affected.length === 1 ? '' : 's'} in this organization ${affected.length === 1 ? 'is' : 'are'} affected. Redemptions are never blocked by documents.`
      : `Version ${version} is now current. It is for information only, so no acknowledgment is needed.`,
  };
  bg(c, emit(sql, ws, 'document.published', { id: docId, ticker: t, doc_type: b.doc_type, title: b.title, version, jurisdiction: jur, audience: b.audience, required, sha256: hash, supersedes: cur?.id ?? null }));
  return c.json(out, 201);
});

routes.get('/documents/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const docId = c.req.param('id');
  const [d] = await sql`select id, ticker, doc_type, title, version, jurisdiction, audience, content, sha256, required, published_at, published_by, superseded_at from fund_documents where workspace_id = ${ws} and id = ${docId}`;
  if (!d) throw new ApiError(404, 'not_found', 'No document with that id.');
  const [acks, versions] = await Promise.all([
    sql`select a.investor_id, i.name, a.sha256, a.method, a.signed_name, a.acknowledged_at from doc_acknowledgments a join investors i on i.workspace_id = a.workspace_id and i.id = a.investor_id
        where a.workspace_id = ${ws} and a.document_id = ${docId} order by a.acknowledged_at desc`,
    sql`select id, version, published_at, superseded_at, sha256 from fund_documents where workspace_id = ${ws} and ticker = ${d.ticker} and doc_type = ${d.doc_type} and jurisdiction is not distinct from ${d.jurisdiction} order by version desc`,
  ]);
  return c.json({
    ...d, status: d.superseded_at ? 'superseded' : 'current', type_label: DOC_TYPES[d.doc_type] ?? d.doc_type,
    acknowledgments: acks.map((a: any) => ({ ...a, matches: a.sha256 === d.sha256 })),
    versions: versions.map((v: any) => ({ ...v, status: v.superseded_at ? 'superseded' : 'current' })),
  });
});

routes.post('/documents/:id/acknowledge', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const docId = c.req.param('id');
  const b = await body(c, z.object({ investor_id: z.string().min(1), signed_name: z.string().trim().min(2).max(140), method: z.literal('ops_attested').default('ops_attested') }));
  const [d] = await sql`select id, ticker, doc_type, title, version, jurisdiction, sha256, superseded_at from fund_documents where workspace_id = ${ws} and id = ${docId}`;
  if (!d) throw new ApiError(404, 'not_found', 'No document with that id.');
  if (d.superseded_at) {
    const [cur] = await sql`select id, version from fund_documents where workspace_id = ${ws} and ticker = ${d.ticker} and doc_type = ${d.doc_type} and jurisdiction is not distinct from ${d.jurisdiction} and superseded_at is null`;
    throw new ApiError(409, 'superseded', `Version ${d.version} was replaced${cur ? ` by version ${cur.version}` : ''}. Record the acknowledgment against the current version${cur ? ` (${cur.id})` : ''}.`);
  }
  const [inv] = await sql`select id, name from investors where workspace_id = ${ws} and id = ${b.investor_id}`;
  if (!inv) throw new ApiError(404, 'not_found', `No client with id ${b.investor_id} in this organization.`);
  const at = new Date().toISOString();
  // Evidence digest: binds who attested, for whom, which exact document bytes, and when.
  const evidence = await sha256(canonical({ document_id: docId, sha256: d.sha256, investor_id: inv.id, signed_name: b.signed_name, method: b.method, attested_by: actor.name, at }));
  await sql.transaction([
    sql`insert into doc_acknowledgments (workspace_id, investor_id, document_id, sha256, method, signed_name, signature, acknowledged_at)
      values (${ws}, ${inv.id}, ${docId}, ${d.sha256}, ${b.method}, ${b.signed_name}, ${evidence}, ${at})
      on conflict (workspace_id, investor_id, document_id) do update set sha256 = excluded.sha256, method = excluded.method, signed_name = excluded.signed_name, signature = excluded.signature, acknowledged_at = excluded.acknowledged_at`,
    auditQ(sql, ws, actor, 'document.acknowledged', docId, { investor_id: inv.id, ticker: d.ticker, title: d.title, version: d.version, sha256: d.sha256, method: b.method, signed_name: b.signed_name, evidence }),
  ]);
  bg(c, emit(sql, ws, 'document.acknowledged', { document_id: docId, investor_id: inv.id, ticker: d.ticker, version: d.version, sha256: d.sha256, method: b.method }));
  return c.json({ document_id: docId, investor_id: inv.id, investor: inv.name, title: d.title, version: d.version, sha256: d.sha256, method: b.method, signed_name: b.signed_name, evidence, acknowledged_at: at }, 201);
});

routes.get('/funds/:ticker/acknowledgments', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const [funds, invs, docs, acks] = await Promise.all([
    loadFunds(sql, ws, t),
    loadInvestors(sql, ws, null),
    sql`select id, doc_type, title, version, jurisdiction, audience, required, sha256 from fund_documents where workspace_id = ${ws} and ticker = ${t} and superseded_at is null and required order by doc_type, jurisdiction nulls first`,
    sql`select a.investor_id, a.document_id, a.sha256, a.acknowledged_at, a.method, d.doc_type, d.jurisdiction, d.version
        from doc_acknowledgments a join fund_documents d on d.workspace_id = a.workspace_id and d.id = a.document_id
        where a.workspace_id = ${ws} and d.ticker = ${t}`,
  ]);
  const fund = funds[t];
  if (!fund) throw new ApiError(404, 'not_found', `No fund with ticker ${t} in this organization.`);
  const asOf = today();
  const cells: Record<string, Record<string, { status: 'acknowledged' | 'outdated' | 'missing' | 'not_applicable'; acknowledged_at?: string; version_acknowledged?: number }>> = {};
  let needed = 0; let done = 0; let outdated = 0;
  const investors = Object.values(invs).map((i) => {
    const row: (typeof cells)[string] = {};
    let ready = true;
    for (const d of docs) {
      const ack = acks.find((a: any) => a.investor_id === i.id && a.document_id === d.id);
      const older = acks.filter((a: any) => a.investor_id === i.id && a.doc_type === d.doc_type && (a.jurisdiction ?? null) === (d.jurisdiction ?? null) && a.document_id !== d.id)
        .sort((x: any, y: any) => Number(y.version) - Number(x.version))[0];
      const applies = docApplies(i, fund, { jurisdiction: d.jurisdiction, audience: d.audience, required: d.required }, asOf);
      if (ack && ack.sha256 === d.sha256) { row[d.id] = { status: 'acknowledged', acknowledged_at: ack.acknowledged_at, version_acknowledged: Number(d.version) }; if (applies) { needed++; done++; } continue; }
      if (!applies) { row[d.id] = { status: 'not_applicable' }; continue; }
      needed++; ready = false;
      if (older) { outdated++; row[d.id] = { status: 'outdated', acknowledged_at: older.acknowledged_at, version_acknowledged: Number(older.version) }; }
      else row[d.id] = { status: 'missing' };
    }
    cells[i.id] = row;
    const h = i.holdings[t];
    return { id: i.id, name: i.name, residence: i.residence, holder: !!h, units: h?.units ?? 0, ready, offered: !!fund.distribution[i.residence] };
  }).sort((a, b) => Number(b.holder) - Number(a.holder) || a.name.localeCompare(b.name));
  return c.json({
    ticker: t, as_of: asOf,
    documents: docs.map((d: any) => ({ ...d, version: Number(d.version), type_label: DOC_TYPES[d.doc_type] ?? d.doc_type })),
    investors, cells,
    summary: { required_acknowledgments: needed, acknowledged: done, missing: needed - done - outdated, outdated, ready_investors: investors.filter((i) => i.ready).length, investors: investors.length },
  });
});
