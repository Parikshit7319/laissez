// Regulatory and distribution reports: private placement headroom per fund and jurisdiction,
// settled value and decision outcomes by jurisdiction, and CSV exports.
import type { Context } from 'hono';
import { router, need, type C } from '../http';
import { today } from '../util';
import { loadGlobals } from '../ctx';
import { PLACEMENT_LIMITS } from '../placement-limits';

export const routes = router();

type Limit = { jurisdiction: string; basis: string; limit_text: string; number: number | null; unit: string; period: string | null; citation: string; source_url: string; verified: boolean | string };
const LIMITS = PLACEMENT_LIMITS as unknown as Limit[];
const FLAG_AT = 0.8;
const NO_LIMIT = 'No numeric limit for this offering basis';
const HOLDER_CAP = { citation: 'Investment Company Act of 1940, Section 3(c)(1)', source_url: 'https://www.law.cornell.edu/uscode/text/15/80a-3' };

const JUR_ALIASES: Record<string, string[]> = { DE: ['DE', 'EU'], 'AE-DIFC': ['AE-DIFC', 'AE', 'DIFC'] };
const STOP = new Set(['offer', 'offered', 'offering', 'fund', 'funds', 'with', 'under', 'from', 'that', 'this', 'regulation', 'investors', 'investor', 'for', 'and', 'the', 'not', 'only', 'made', 'into', 'sale']);
// "Rule 506(c)" must stay distinct from "Rule 506(b)", so parentheses are dropped before splitting.
const words = (s: string) => new Set(s.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * The placement limit for an offering basis in a jurisdiction: exact basis, then containment, then the best word overlap.
 * A fund domiciled outside the jurisdiction falls back to the rule for foreign funds there, when one exists.
 */
export function limitFor(jur: string, basis: string, foreign = true): Limit | null {
  const codes = JUR_ALIASES[jur] ?? [jur];
  const cands = LIMITS.filter((l) => codes.includes(l.jurisdiction));
  if (!cands.length) return null;
  const b = basis.toLowerCase().trim();
  const exact = cands.find((l) => l.basis.toLowerCase().trim() === b);
  if (exact) return exact;
  const contained = cands.find((l) => { const lb = l.basis.toLowerCase(); return b.includes(lb) || lb.includes(b); });
  if (contained) return contained;
  const bw = words(basis);
  let best: Limit | null = null; let score = 0;
  for (const l of cands) { const s = [...words(l.basis)].filter((w) => bw.has(w)).length; if (s > score) { score = s; best = l; } }
  if (score >= 2 || (score >= 1 && cands.length === 1)) return best;
  return foreign ? cands.find((l) => /\bforeign\b/i.test(l.basis)) ?? null : null;
}
const domesticTo = (domicile: string, jur: string) => {
  const d = domicile.toLowerCase();
  const names: Record<string, string[]> = { US: ['united states', 'delaware'], SG: ['singapore'], HK: ['hong kong'], CH: ['switzerland'], DE: ['germany'], 'AE-DIFC': ['difc', 'dubai'], GB: ['united kingdom', 'england'] };
  return (names[jur] ?? []).some((n) => d.includes(n));
};

/** Look-back window in months for limits counted per period ("12 months", "per year"); null when the limit is a standing count. */
function periodMonths(p: string | null | undefined): number | null {
  if (!p) return null;
  const m = /(\d+)\s*-?\s*month/i.exec(p); if (m) return Number(m[1]);
  const y = /(\d+)\s*-?\s*year/i.exec(p); if (y) return Number(y[1]) * 12;
  if (/annual|per year|calendar year|twelve/i.test(p)) return 12;
  return null;
}
const monthsAgo = (n: number) => { const d = new Date(today() + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

async function placement(c: C) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [[funds, dist, holds], g] = await Promise.all([
    sql.transaction([
      sql`select ticker, name, short_name, domicile, currency, holders, holder_cap from funds where workspace_id = ${ws} order by ticker`,
      sql`select ticker, jurisdiction, basis, accepts from fund_distribution where workspace_id = ${ws} order by ticker, jurisdiction`,
      sql`select h.ticker, h.investor_id, h.since::text as since, i.residence from holdings h join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id where h.workspace_id = ${ws} and h.units > 0`,
    ]),
    loadGlobals(sql),
  ]);
  const rows: any[] = [];
  for (const f of funds) {
    const fundHolds = holds.filter((h: any) => h.ticker === f.ticker);
    if (f.holder_cap) {
      const used = Number(f.holders);
      const util = used / f.holder_cap;
      rows.push({
        ticker: f.ticker, fund: f.short_name, currency: f.currency, jurisdiction: 'ALL', jurisdiction_name: 'All jurisdictions', basis: 'Beneficial-owner limit for the fund',
        holders_in_org: new Set(fundHolds.map((h: any) => h.investor_id)).size, fund_holders_of_record: used,
        limit_text: `${f.holder_cap} beneficial owners across the whole fund`, limit_number: f.holder_cap, unit: 'beneficial owners', period: null,
        counted: used, counted_basis: 'Holders of record across every distributor', headroom: f.holder_cap - used, utilization: util, flag: util > FLAG_AT,
        citation: HOLDER_CAP.citation, source_url: HOLDER_CAP.source_url, verified: true,
      });
    }
    for (const d of dist.filter((x: any) => x.ticker === f.ticker)) {
      const here = fundHolds.filter((h: any) => h.residence === d.jurisdiction);
      const lim = limitFor(d.jurisdiction, d.basis, !domesticTo(f.domicile ?? '', d.jurisdiction));
      const months = periodMonths(lim?.period);
      const counted = months ? new Set(here.filter((h: any) => h.since >= monthsAgo(months)).map((h: any) => h.investor_id)).size : new Set(here.map((h: any) => h.investor_id)).size;
      const n = lim && typeof lim.number === 'number' ? lim.number : null;
      const util = n ? counted / n : null;
      rows.push({
        ticker: f.ticker, fund: f.short_name, currency: f.currency, jurisdiction: d.jurisdiction, jurisdiction_name: g.jurName[d.jurisdiction] ?? d.jurisdiction, basis: d.basis,
        holders_in_org: new Set(here.map((h: any) => h.investor_id)).size, fund_holders_of_record: Number(f.holders),
        limit_text: lim ? lim.limit_text : NO_LIMIT, limit_number: n, unit: lim?.unit ?? null, period: lim?.period ?? null,
        counted, counted_basis: months ? `This organization's holders who first invested in the last ${months} months` : "This organization's current holders",
        headroom: n !== null ? n - counted : null, utilization: util, flag: util !== null && util > FLAG_AT,
        citation: lim?.citation ?? null, source_url: lim?.source_url ?? null, verified: lim ? lim.verified : null,
      });
    }
  }
  return rows;
}

routes.get('/reports/placement', async (c) => {
  need(c, 'read');
  const rows = await placement(c);
  return c.json({
    as_of: today(), flag_threshold: FLAG_AT, data: rows, flagged: rows.filter((r) => r.flag).length,
    note: 'Jurisdiction limits apply to the whole offering, across every distributor. Counts here cover this organization only, so treat headroom as an upper bound and confirm with the issuer before placing near a limit.',
  });
});

routes.get('/reports/distribution', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const settled = (key: string) => sql.query(
    `select ${key} as key, f.currency, coalesce(sum(d.amount), 0)::float8 as value, count(*)::int as n
     from settlements st join decisions d on d.workspace_id = st.workspace_id and d.id = st.decision_id
     join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker
     where st.workspace_id = $1 and st.status = 'settled' group by 1, 2 order by 1, 2`, [ws]);
  const [[byJur, byBooking, byFund, byMonth, decisions, reasons], g] = await Promise.all([
    sql.transaction([
      settled('i.residence'),
      settled('i.booking_center'),
      settled('d.ticker'),
      settled(`to_char(date_trunc('month', st.created_at), 'YYYY-MM')`),
      sql`select i.residence as key, count(*)::int as decisions, count(*) filter (where d.outcome = 'ALLOW')::int as allowed, count(*) filter (where d.outcome = 'DENY')::int as denied, count(*) filter (where d.outcome = 'FREEZE')::int as frozen
        from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id
        where d.workspace_id = ${ws} and coalesce(array_length(d.what_ifs, 1), 0) = 0 group by 1 order by 2 desc`,
      sql`select i.residence as key, ch->>'label' as label, count(*)::int as n
        from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id, jsonb_array_elements(d.checks) ch
        where d.workspace_id = ${ws} and d.outcome <> 'ALLOW' and ch->>'result' = 'fail' and coalesce(array_length(d.what_ifs, 1), 0) = 0 group by 1, 2 order by 1, 3 desc`,
    ]),
    loadGlobals(sql),
  ]);
  const label = (kind: 'jur' | 'booking' | 'fund' | 'month', k: string) => kind === 'jur' ? g.jurName[k] ?? k : kind === 'booking' ? g.bookingCenters[k]?.name ?? k : k;
  const shape = (rows: any[], kind: 'jur' | 'booking' | 'fund' | 'month') => rows.map((r) => ({ key: r.key, label: label(kind, r.key), currency: r.currency, value: r.value, settlements: r.n }));
  return c.json({
    as_of: today(),
    settled_value: { by_jurisdiction: shape(byJur, 'jur'), by_booking_center: shape(byBooking, 'booking'), by_fund: shape(byFund, 'fund'), by_month: shape(byMonth, 'month') },
    decisions_by_jurisdiction: decisions.map((r: any) => ({
      jurisdiction: r.key, jurisdiction_name: g.jurName[r.key] ?? r.key, decisions: r.decisions, allowed: r.allowed, denied: r.denied, frozen: r.frozen,
      allow_rate: r.decisions ? r.allowed / r.decisions : null,
      top_refusal_reasons: reasons.filter((x: any) => x.key === r.key).slice(0, 3).map((x: any) => ({ label: x.label, n: x.n })),
    })),
    note: 'Settled value is gross notional in fund currency for subscriptions, transfers and redemptions. Hypothetical what-if decisions are excluded.',
  });
});

// ---------- CSV exports ----------
const cell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+@\t\r]|^-[^0-9]/.test(s)) s = `'${s}`; // keep spreadsheets from evaluating text as a formula
  return `"${s.replace(/"/g, '""')}"`;
};
const csv = (c: Context, name: string, header: string[], rows: unknown[][]) =>
  c.body([header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n', 200, {
    'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="laissez-${name}-${today()}.csv"`, 'cache-control': 'no-store',
  });

routes.get('/reports/register-by-jurisdiction.csv', async (c) => {
  need(c, 'audit:export');
  const rows = await c.get('sql')`select i.residence, j.name as jurisdiction_name, h.ticker, f.name as fund, i.id as investor_id, i.name as investor, i.kind, i.booking_center,
      h.units::float8 as units, round(h.units * f.nav, 2)::float8 as value, f.currency, h.since::text as since, hs.status as holder_status, (i.relied_share is not null) as relied_credential
    from holdings h join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id join funds f on f.workspace_id = h.workspace_id and f.ticker = h.ticker
    left join jurisdictions j on j.code = i.residence left join holder_status hs on hs.workspace_id = h.workspace_id and hs.investor_id = h.investor_id and hs.ticker = h.ticker
    where h.workspace_id = ${c.get('ws')} and h.units > 0 order by i.residence, h.ticker, i.name`;
  return csv(c, 'register-by-jurisdiction', ['jurisdiction', 'jurisdiction_name', 'ticker', 'fund', 'investor_id', 'investor', 'investor_type', 'booking_center', 'units', 'value', 'currency', 'holder_since', 'holder_status', 'relied_credential'],
    rows.map((r: any) => [r.residence, r.jurisdiction_name, r.ticker, r.fund, r.investor_id, r.investor, r.kind, r.booking_center, r.units, r.value, r.currency, r.since, r.holder_status, r.relied_credential]));
});

routes.get('/reports/placement.csv', async (c) => {
  need(c, 'audit:export');
  const rows = await placement(c);
  return csv(c, 'placement', ['ticker', 'fund', 'jurisdiction', 'offering_basis', 'holders_in_organization', 'fund_holders_of_record', 'limit', 'limit_number', 'unit', 'period', 'counted', 'headroom', 'utilization_pct', 'above_80_pct', 'citation', 'source_url'],
    rows.map((r) => [r.ticker, r.fund, r.jurisdiction, r.basis, r.holders_in_org, r.fund_holders_of_record, r.limit_text, r.limit_number, r.unit, r.period, r.counted, r.headroom, r.utilization === null ? null : Math.round(r.utilization * 1000) / 10, r.flag, r.citation, r.source_url]));
});

routes.get('/reports/decisions.csv', async (c) => {
  need(c, 'audit:export');
  const rows = await c.get('sql')`select d.created_at, d.id, d.action, d.investor_id, i.name as investor, i.residence, i.booking_center, d.counterparty_id, d.ticker, d.amount::float8 as amount, d.asset,
      d.outcome, d.headline, array_to_string(d.rule_packs, ' ') as rule_packs, array_to_string(d.what_ifs, ' ') as what_ifs, d.inputs_sha256, s.id as settlement_id, s.status as settlement_status
    from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id
    where d.workspace_id = ${c.get('ws')} order by d.created_at desc limit 10000`;
  return csv(c, 'decisions', ['created_at', 'decision_id', 'action', 'investor_id', 'investor', 'residence', 'booking_center', 'counterparty_id', 'ticker', 'amount', 'asset', 'outcome', 'headline', 'rule_packs', 'what_ifs', 'inputs_sha256', 'settlement_id', 'settlement_status'],
    rows.map((r: any) => [new Date(r.created_at).toISOString(), r.id, r.action, r.investor_id, r.investor, r.residence, r.booking_center, r.counterparty_id, r.ticker, r.amount, r.asset, r.outcome, r.headline, r.rule_packs, r.what_ifs, r.inputs_sha256, r.settlement_id, r.settlement_status]));
});
