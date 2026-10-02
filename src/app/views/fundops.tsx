/** @jsxImportSource preact */
// Fund operations: lifecycle terms, NAV, income, redemption notices and fund documents.
// FundLifecycle and FundDocuments embed on the fund detail page; RedemptionNotices is a page.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { api, money, when, JUR } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, ConfirmBtn } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

// ---------- Formatting ----------
/** Formats a YYYY-MM-DD date without shifting it into the viewer's time zone. */
export const fmtDate = (d?: string | null, withYear = true) =>
  d ? new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }) : '';
const navStr = (n: number | null | undefined, dp = 4) => (n == null ? '' : Number(n).toFixed(dp));
const units = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const bps = (n: number | null | undefined) => (n == null ? '' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)} bps`);
/** "up 48.7 bps", "down 1.9 bps" or "unchanged". */
const moved = (n: number | null | undefined) => (n == null ? '' : Math.abs(n) < 0.05 ? 'unchanged' : `${n > 0 ? 'up' : 'down'} ${Math.abs(n).toFixed(1)} bps`);
const whole = (n: number, ccy: string) => money(Math.round(n), ccy);
const pct = (bp: number | null | undefined) => (bp == null ? 'Not set' : `${(Number(bp) / 100).toFixed(2)}%`);
const todayISO = () => new Date().toISOString().slice(0, 10);
const FREQ: Record<string, string> = { daily: 'Daily', monthly: 'Monthly', quarterly: 'Quarterly' };
const FREQ_LONG: Record<string, string> = { daily: 'Every business day', monthly: 'Last business day of each month', quarterly: 'Last business day of each quarter' };
const ZONES = ['America/New_York', 'America/Chicago', 'Europe/London', 'Europe/Dublin', 'Europe/Luxembourg', 'Europe/Zurich', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Dubai', 'UTC'];
export const DOC_TYPES: Record<string, string> = {
  offering_memorandum: 'Offering memorandum', prospectus: 'Prospectus', private_placement_memorandum: 'Private placement memorandum',
  supplement: 'Jurisdiction supplement', kid: 'Key information document', subscription_agreement: 'Subscription agreement',
  factsheet: 'Factsheet', annual_report: 'Annual report', other: 'Other document',
};
const AUDIENCE: Record<string, string> = { all: 'All investors', professional: 'Professional investors', retail: 'Retail clients' };
const val = (e: Event) => (e.target as HTMLInputElement).value;

// ---------- NAV chart ----------
function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
/** Line chart of NAV per unit, drawn to scale: the y axis spans the data with round ticks, the x axis is calendar time. */
export function NavChart({ series, currency, label }: { series: { date: string; nav: number }[]; currency: string; label: string }) {
  // Drawn at the container's real width so axis text stays at 11px on a phone and on a wide screen.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(680);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { const w = Math.round(entries[0].contentRect.width); if (w > 0) setW(Math.max(280, w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (series.length < 2) return <Empty title="Not enough NAV history to chart">Strike at least two NAVs to see a trend.</Empty>;
  const narrow = W < 520;
  const H = narrow ? 200 : 240; const L = 62; const R = 18; const T = 14; const B = 32;
  const navs = series.map((p) => Number(p.nav));
  let lo = Math.min(...navs); let hi = Math.max(...navs);
  if (hi - lo < 1e-9) { lo -= 0.0005; hi += 0.0005; } else { const pad = (hi - lo) * 0.12; lo -= pad; hi += pad; }
  const step = niceStep((hi - lo) / 4);
  const y0 = Math.floor(lo / step) * step; const y1 = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = y0; v <= y1 + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  const dp = Math.max(4, Math.min(6, Math.ceil(-Math.log10(step))));
  const t0 = Date.parse(series[0].date + 'T00:00:00Z'); const t1 = Date.parse(series[series.length - 1].date + 'T00:00:00Z');
  const x = (d: string) => L + ((Date.parse(d + 'T00:00:00Z') - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(Number(p.nav)).toFixed(1)}`).join('');
  const area = `${line}L${x(series[series.length - 1].date).toFixed(1)},${H - B}L${x(series[0].date).toFixed(1)},${H - B}Z`;
  const n = series.length;
  const xIdx = [...new Set(narrow ? [0, Math.round((n - 1) / 2), n - 1] : n <= 6 ? series.map((_, i) => i) : [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])];
  const last = series[n - 1];
  const sparse = n <= 31;
  return (
    <figure ref={box} style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} style={{ display: 'block', width: '100%', height: 'auto', overflow: 'visible' }}>
        <title>{label}</title>
        {ticks.map((v) => (
          <g>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#ece8e1" stroke-width="1" />
            <text x={L - 8} y={y(v) + 3.5} text-anchor="end" font-size="11" fill="#7a7368" style={{ fontVariantNumeric: 'tabular-nums' }}>{v.toFixed(dp)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#cfc8bb" stroke-width="1" />
        {xIdx.map((i) => (
          <g>
            <line x1={x(series[i].date)} x2={x(series[i].date)} y1={H - B} y2={H - B + 4} stroke="#cfc8bb" />
            <text x={x(series[i].date)} y={H - B + 17} text-anchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} font-size="11" fill="#7a7368">{fmtDate(series[i].date, false)}</text>
          </g>
        ))}
        <text x={12} y={T + (H - T - B) / 2} font-size="11" fill="#7a7368" transform={`rotate(-90 12 ${T + (H - T - B) / 2})`} text-anchor="middle">NAV per unit ({currency})</text>
        <path d={area} fill="rgba(201, 169, 110, 0.12)" />
        <path d={line} fill="none" stroke="#8a6a2f" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        {series.map((p) => (
          <g>
            {sparse ? <circle cx={x(p.date)} cy={y(Number(p.nav))} r="3" fill="#fff" stroke="#8a6a2f" stroke-width="1.5" /> : null}
            <circle cx={x(p.date)} cy={y(Number(p.nav))} r="7" fill="transparent"><title>{`${fmtDate(p.date)}: ${navStr(p.nav, 6)} ${currency}`}</title></circle>
          </g>
        ))}
        <circle cx={x(last.date)} cy={y(Number(last.nav))} r="4" fill="#8a6a2f" />
      </svg>
      <figcaption class="sr">{label}</figcaption>
    </figure>
  );
}

// ---------- Lifecycle ----------
export function FundLifecycle({ ticker, onChange }: { ticker: string; onChange?: () => void }) {
  const r = useApi<any>(`/v1/funds/${ticker}/lifecycle`, [ticker]);
  const [msg, setMsg] = useState<string | null>(null);
  if (r.loading && !r.data) return <Card title="Dealing, NAV and income"><Loading /></Card>;
  if (r.error) return <Card title="Dealing, NAV and income"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const L = r.data;
  const ccy = L.currency;
  const changed = (m?: string) => { if (m) setMsg(m); r.reload(); onChange?.(); };
  const distributing = L.terms.share_class_type === 'distributing';
  return (
    <>
      <div class="kpis">
        <div class="kpi"><span>Latest NAV</span><b>{navStr(L.nav.latest?.nav ?? L.nav.current)}</b><em>{L.nav.latest ? `Struck ${fmtDate(L.nav.latest.date)}` : 'No strike recorded'}{L.nav.change_bps != null ? `. ${moved(L.nav.change_bps).replace(/^./, (c) => c.toUpperCase())} across the chart` : ''}</em></div>
        <div class="kpi"><span>Next dealing date</span><b>{fmtDate(L.dealing.next_dealing_date, false)}</b><em>Cut-off {L.terms.cutoff_time} {L.terms.cutoff_tz.replace(/_/g, ' ')}. It is {L.dealing.fund_time.time} there, {L.dealing.before_cutoff ? 'before' : 'after'} cut-off</em></div>
        {distributing
          ? <div class="kpi"><span>Accrued, not yet paid</span><b>{money(L.accrued?.total ?? 0, ccy)}</b><em>{L.accrued?.days ? `${L.accrued.days} day${L.accrued.days === 1 ? '' : 's'} from ${fmtDate(L.accrued.from, false)}, ${L.accrued.holders} holder${L.accrued.holders === 1 ? '' : 's'}` : 'Nothing accrued since the last distribution'}</em></div>
          : <div class="kpi"><span>Income</span><b>In the NAV</b><em>Accumulating class at {pct(L.terms.yield_bps)} a year</em></div>}
        {L.terms.gate_pct
          ? <div class="kpi"><span>Gate used this period</span><b>{L.liquidity.gate_used_pct != null ? `${L.liquidity.gate_used_pct.toFixed(1)}%` : 'None'}</b><em>{L.liquidity.gate_limit != null ? `${whole(L.liquidity.redeemed_in_period, ccy)} of ${whole(L.liquidity.gate_limit, ccy)} since ${fmtDate(L.dealing.period_start, false)}` : 'No holders in this organization'}</em></div>
          : <div class="kpi"><span>Redemption notice</span><b>{L.terms.notice_days ? `${L.terms.notice_days} days` : 'None'}</b><em>{L.terms.gate_pct ? `Gate ${L.terms.gate_pct}%` : 'No redemption gate'}</em></div>}
      </div>
      {msg ? <div class="note" role="status">{msg}</div> : null}
      <TermsCard L={L} onSaved={changed} />
      <NavCard L={L} ticker={ticker} onStruck={changed} />
      {distributing ? <IncomeCard L={L} ticker={ticker} onChange={changed} /> : (
        <Card title="Income">
          <p class="small" style={{ margin: 0 }}>This is an accumulating class. Income is not paid out: it stays in the fund and raises the NAV, so there are no accruals or distributions to run. {L.nav.change_bps != null ? `The NAV is ${moved(L.nav.change_bps)} across the chart above.` : ''}</p>
        </Card>
      )}
      {L.terms.notice_days > 0 || L.notices.pending ? <NoticesSummary L={L} ticker={ticker} /> : null}
    </>
  );
}

function TermsCard({ L, onSaved }: { L: any; onSaved: (m?: string) => void }) {
  const { can } = useMe();
  const t = L.terms;
  const init = () => ({ share_class_type: t.share_class_type, dealing_frequency: t.dealing_frequency, cutoff_time: t.cutoff_time, cutoff_tz: t.cutoff_tz, notice_days: String(t.notice_days ?? 0), gate_pct: t.gate_pct == null ? '' : String(t.gate_pct), yield_bps: t.yield_bps == null ? '' : String(t.yield_bps) });
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(init);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(init()); }, [JSON.stringify(t)]);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const save = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true);
    const next: Record<string, unknown> = {
      share_class_type: f.share_class_type, dealing_frequency: f.dealing_frequency, cutoff_time: f.cutoff_time, cutoff_tz: f.cutoff_tz.trim(),
      notice_days: Number(f.notice_days || 0), gate_pct: f.gate_pct === '' ? null : Number(f.gate_pct), yield_bps: f.yield_bps === '' ? null : Number(f.yield_bps),
    };
    const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== (t as any)[k]));
    if (!Object.keys(diff).length) { setBusy(false); setEdit(false); return; }
    try {
      const res = await api(`/v1/funds/${L.ticker}/terms`, { method: 'PATCH', body: diff });
      setEdit(false); onSaved(`Terms updated. Next dealing date: ${fmtDate(res.next_dealing_date)}. ${res.note}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Dealing and liquidity terms" actions={!edit ? <PermBtn perm="funds:write" kind="ghost" onClick={() => setEdit(true)}>Edit terms</PermBtn> : null}>
      {!edit ? (
        <>
          <dl class="kv wide">
            <div><dt>Share class</dt><dd>{t.share_class_type === 'distributing' ? 'Distributing: income accrues daily and is paid monthly, reinvested in units' : 'Accumulating: income stays in the NAV'}</dd></div>
            <div><dt>Dealing</dt><dd>{FREQ_LONG[t.dealing_frequency]}. Cut-off {t.cutoff_time}, {t.cutoff_tz.replace(/_/g, ' ')}</dd></div>
            <div><dt>Yield</dt><dd>{pct(t.yield_bps)} a year{t.yield_bps != null ? ` (${t.yield_bps} bps)` : ''}</dd></div>
            <div><dt>Redemption notice</dt><dd>{t.notice_days ? `${t.notice_days} days before the dealing date` : 'None. Redemptions deal at the next cut-off'}</dd></div>
            <div><dt>Redemption gate</dt><dd>{t.gate_pct ? `${t.gate_pct}% of assets per dealing period. Assets for the gate: ${whole(L.liquidity.aum, L.currency)}` : 'None'}</dd></div>
          </dl>
          <p class="small muted" style={{ marginBottom: 0 }}>{String(L.dealing.summary).replace(/_/g, ' ')} These are liquidity terms. They decide when an order deals, never whether an investor is eligible.</p>
          <PermNote perm="funds:write" />
        </>
      ) : (
        <form onSubmit={save}>
          <div class="form-grid">
            <Field label="Share class"><select value={f.share_class_type} onChange={(e) => set('share_class_type', val(e))}><option value="distributing">Distributing</option><option value="accumulating">Accumulating</option></select></Field>
            <Field label="Dealing frequency"><select value={f.dealing_frequency} onChange={(e) => set('dealing_frequency', val(e))}><option value="daily">Daily</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></Field>
            <Field label="Cut-off time" hint="Local time in the fund's time zone"><input type="time" required value={f.cutoff_time} onInput={(e) => set('cutoff_time', val(e))} /></Field>
            <Field label="Cut-off time zone" hint="IANA name, such as America/New_York"><input list="fo-zones" required value={f.cutoff_tz} onInput={(e) => set('cutoff_tz', val(e))} /><datalist id="fo-zones">{ZONES.map((z) => <option value={z} />)}</datalist></Field>
            <Field label="Notice period (days)" hint="0 for no notice"><input type="number" min="0" max="365" step="1" value={f.notice_days} onInput={(e) => set('notice_days', val(e))} /></Field>
            <Field label="Redemption gate (% per period)" hint="Leave empty for no gate"><input type="number" min="0.1" max="100" step="0.1" value={f.gate_pct} onInput={(e) => set('gate_pct', val(e))} /></Field>
            <Field label="Yield (bps a year)" hint="390 bps is 3.90%"><input type="number" min="0" max="5000" step="1" value={f.yield_bps} onInput={(e) => set('yield_bps', val(e))} /></Field>
          </div>
          <div class="form-actions"><Btn type="submit" kind="primary" busy={busy} disabled={!can('funds:write')}>Save terms</Btn><Btn kind="ghost" onClick={() => { setEdit(false); setF(init()); setErr(null); }}>Cancel</Btn></div>
          <ErrorBox error={err} />
        </form>
      )}
    </Card>
  );
}

function NavCard({ L, ticker, onStruck }: { L: any; ticker: string; onStruck: (m?: string) => void }) {
  const { can } = useMe();
  const [nav, setNav] = useState('');
  const [date, setDate] = useState(todayISO());
  const [confirm, setConfirm] = useState(false);
  const [needConfirm, setNeedConfirm] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const acc = L.terms.share_class_type === 'accumulating';
  const series = L.nav.series as { date: string; nav: number; daily_yield_bps: number | null }[];
  const strike = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const res = await api(`/v1/funds/${ticker}/nav`, { body: { nav: Number(nav), date, ...(confirm ? { confirm: true } : {}) } });
      setNav(''); setConfirm(false); setNeedConfirm(false);
      onStruck(`NAV ${navStr(res.nav, acc ? 6 : 4)} struck for ${fmtDate(res.date)}${res.change_bps != null ? `, ${bps(res.change_bps)} from the previous strike` : ''}.${res.latest ? ' It is now the fund NAV.' : ' A later strike exists, so the fund NAV is unchanged.'}`);
    } catch (x: any) { if (x.code === 'confirm_large_move') setNeedConfirm(true); setErr(x); } finally { setBusy(false); }
  };
  const recent = [...series].reverse().slice(0, 5);
  return (
    <Card title="NAV" actions={<span class="small muted">{L.nav.valuation}</span>}>
      <NavChart series={series} currency={L.currency} label={`${ticker} NAV per unit from ${fmtDate(series[0]?.date)} to ${fmtDate(series[series.length - 1]?.date)}: ${navStr(series[0]?.nav)} to ${navStr(series[series.length - 1]?.nav)} ${L.currency}.`} />
      <div class="grid2" style={{ marginTop: '1rem' }}>
        <div class="tw"><table class="t">
          <thead><tr><th>Date</th><th class="r">NAV</th><th class="r">Yield</th></tr></thead>
          <tbody>{recent.length ? recent.map((p) => <tr><td>{fmtDate(p.date)}</td><td class="r">{navStr(p.nav, acc ? 6 : 4)}</td><td class="r">{p.daily_yield_bps != null ? pct(p.daily_yield_bps) : ''}</td></tr>) : <tr><td colSpan={3} class="muted">No strikes yet.</td></tr>}</tbody>
        </table></div>
        <form onSubmit={strike}>
          <div class="form-grid two">
            <Field label={`NAV per unit (${L.currency})`}><input inputMode="decimal" required placeholder={navStr(L.nav.current, acc ? 6 : 4)} value={nav} onInput={(e) => { setNav(val(e).replace(/[^0-9.]/g, '')); setNeedConfirm(false); setConfirm(false); }} /></Field>
            <Field label="Valuation date"><input type="date" required max={todayISO()} value={date} onInput={(e) => setDate(val(e))} /></Field>
          </div>
          {needConfirm ? <label class="check" style={{ marginTop: '0.6rem' }}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm((e.target as HTMLInputElement).checked)} /> I checked this NAV. Strike it anyway.</label> : null}
          <div class="form-actions"><Btn type="submit" kind="primary" busy={busy} disabled={!can('funds:write') || !(Number(nav) > 0) || (needConfirm && !confirm)}>Strike NAV</Btn></div>
          <p class="small muted" style={{ margin: '0.5rem 0 0' }}>Striking replaces any NAV already recorded for that date and sends a nav.struck webhook. Moves above 2% need a second confirmation.</p>
          <PermNote perm="funds:write" />
          <ErrorBox error={err} />
        </form>
      </div>
    </Card>
  );
}

function IncomeCard({ L, ticker, onChange }: { L: any; ticker: string; onChange: (m?: string) => void }) {
  const { can } = useMe();
  const ccy = L.currency;
  const a = L.accrued;
  const [accDate, setAccDate] = useState(todayISO());
  const [ps, setPs] = useState(a?.from ?? `${todayISO().slice(0, 7)}-01`);
  const [pe, setPe] = useState(a?.to ?? todayISO());
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, any[]> | null>(null);
  useEffect(() => { if (a?.from) setPs(a.from); if (a?.to) setPe(a.to); }, [a?.from, a?.to]);
  const run = async () => {
    setErr(null); setBusy('run');
    try { const res = await api(`/v1/funds/${ticker}/accruals/run`, { body: { date: accDate } }); setLines(null); onChange(res.note); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const pay = async () => {
    setErr(null); setBusy('pay');
    try {
      const res = await api(`/v1/funds/${ticker}/distributions`, { body: { period_start: ps, period_end: pe } });
      setLines(null);
      onChange(`Paid ${money(res.total_amount, ccy)} to ${res.holders} holder${res.holders === 1 ? '' : 's'} for ${fmtDate(res.period_start, false)} to ${fmtDate(res.period_end)}. ${units(res.reinvested_units)} units reinvested at NAV ${navStr(res.nav)}${res.cash_paid > 0 ? `, ${money(res.cash_paid, ccy)} paid in cash to holders who had exited` : ''}.`);
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const toggle = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!lines) {
      try { const d = await api(`/v1/funds/${ticker}/distributions`); setLines(Object.fromEntries(d.data.map((x: any) => [x.id, x.lines]))); } catch (x) { setErr(x); }
    }
  };
  return (
    <Card title="Income" actions={<span class="small muted">Accrues daily at {pct(L.terms.yield_bps)} a year. Paid monthly as new units</span>}>
      <div class="form-grid">
        <div>
          <span class="f-l">Daily accruals</span>
          <p class="small" style={{ margin: '0.35rem 0 0.6rem' }}>Each holder accrues units x NAV x yield / 365 for the day. Running a date twice changes nothing.</p>
          <div class="row-inline">
            <Field label="Accrual date"><input type="date" max={todayISO()} value={accDate} onInput={(e) => setAccDate(val(e))} /></Field>
            <Btn busy={busy === 'run'} disabled={!can('funds:write')} onClick={run}>Run accruals</Btn>
          </div>
        </div>
        <div>
          <span class="f-l">Distribution</span>
          <p class="small" style={{ margin: '0.35rem 0 0.6rem' }}>{a?.total ? `${money(a.total, ccy)} accrued and unpaid, ${fmtDate(a.from, false)} to ${fmtDate(a.to)}.` : 'No unpaid accruals right now.'} Paying reinvests each holder's income at the latest NAV.</p>
          <div class="row-inline">
            <Field label="From"><input type="date" max={todayISO()} value={ps} onInput={(e) => setPs(val(e))} /></Field>
            <Field label="To"><input type="date" max={todayISO()} value={pe} onInput={(e) => setPe(val(e))} /></Field>
            <Btn kind="primary" busy={busy === 'pay'} disabled={!can('funds:write') || !a?.total} onClick={pay}>Pay distribution</Btn>
          </div>
        </div>
      </div>
      <PermNote perm="funds:write" />
      <ErrorBox error={err} />
      <p class="f-l" style={{ margin: '1.2rem 0 0.2rem' }}>Distributions paid</p>
      {L.distributions.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Period</th><th>Paid</th><th class="r">Total</th><th class="r">Units reinvested</th><th class="r">Holders</th><th /></tr></thead>
          <tbody>{L.distributions.map((d: any) => [
            <tr>
              <td>{fmtDate(d.period_start, false)} to {fmtDate(d.period_end)}</td>
              <td class="muted">{fmtDate(d.paid_on)}</td>
              <td class="r">{money(d.total_amount, ccy)}</td>
              <td class="r">{units(d.reinvested_units)}</td>
              <td class="r">{d.holders}</td>
              <td class="r"><Btn kind="ghost" onClick={() => toggle(d.id)} ariaLabel={`${open === d.id ? 'Hide' : 'Show'} holders for ${d.id}`}>{open === d.id ? 'Hide' : 'Holders'}</Btn></td>
            </tr>,
            open === d.id ? (
              <tr><td colSpan={6} style={{ background: '#faf8f4' }}>
                {!lines ? <Loading label="Loading holders" /> : (lines[d.id] ?? []).length ? (
                  <table class="t"><thead><tr><th>Holder</th><th class="r">Days accrued</th><th class="r">Income</th></tr></thead>
                    <tbody>{lines[d.id].map((l: any) => <tr><td>{l.investor}</td><td class="r">{l.days}</td><td class="r">{money(l.amount, ccy)}</td></tr>)}</tbody></table>
                ) : <span class="muted small">No accrual detail recorded for this distribution.</span>}
              </td></tr>
            ) : null,
          ])}</tbody>
        </table></div>
      ) : <Empty title="No distributions yet">Run accruals for a few days, then pay the period.</Empty>}
    </Card>
  );
}

function NoticesSummary({ L, ticker }: { L: any; ticker: string }) {
  return (
    <Card title="Redemption notices" actions={<a class="small" href={`#/redemption-notices?ticker=${ticker}`}>Manage notices</a>}>
      <p class="small" style={{ marginTop: 0 }}>
        {L.terms.notice_days ? `Redemptions need ${L.terms.notice_days} days' notice. A notice filed today deals on ${fmtDate(L.dealing.notice_dealing_date)}.` : 'This fund no longer requires notice, but pending notices stay on file.'}
        {L.terms.gate_pct ? ` Each dealing period, redemptions are capped at ${L.terms.gate_pct}% of assets.` : ''}
      </p>
      {L.notices.data.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Client</th><th class="r">Units</th><th class="r">Value at today's NAV</th><th>Filed</th><th>Deals on</th></tr></thead>
          <tbody>{L.notices.data.map((n: any) => <tr><td>{n.investor}</td><td class="r">{units(n.units)}</td><td class="r">{money(n.units * L.nav.current, L.currency)}</td><td class="muted">{fmtDate(n.notice_date)}</td><td>{fmtDate(n.dealing_date)}</td></tr>)}</tbody>
        </table></div>
      ) : <Empty title="No pending notices" />}
    </Card>
  );
}

// ---------- Redemption notices page ----------
export function RedemptionNotices({ query, ticker: fixed }: { query?: URLSearchParams; ticker?: string }) {
  const { can } = useMe();
  const initial = fixed ?? query?.get('ticker') ?? '';
  const [filter, setFilter] = useState<string>(initial);
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const qs = new URLSearchParams();
  if (filter) qs.set('ticker', filter);
  if (status === 'pending') qs.set('status', 'pending');
  const list = useApi<any>(`/v1/redemption-notices${qs.toString() ? `?${qs}` : ''}`, [filter, status]);
  const funds = useApi<any>('/v1/funds');
  const invs = useApi<any>('/v1/investors');
  const noticeFunds = (funds.data?.data ?? []).filter((f: any) => (f.noticeDays ?? 0) > 0);
  const [form, setForm] = useState({ investor_id: '', ticker: initial, units: '' });
  const [err, setErr] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!form.ticker && noticeFunds[0]) setForm((f) => ({ ...f, ticker: noticeFunds[0].ticker })); }, [noticeFunds.length]);
  const fund = noticeFunds.find((f: any) => f.ticker === form.ticker);
  const holders = (invs.data?.data ?? []).filter((i: any) => form.ticker && i.holdings?.[form.ticker]?.units > 0);
  const inv = holders.find((i: any) => i.id === form.investor_id);
  const already = (list.data?.data ?? []).filter((n: any) => n.status === 'pending' && n.investor_id === form.investor_id && n.ticker === form.ticker).reduce((s: number, n: any) => s + n.units, 0);
  const file = async (e: Event) => {
    e.preventDefault(); setErr(null); setRes(null); setBusy(true);
    try { const r = await api('/v1/redemption-notices', { body: { investor_id: form.investor_id, ticker: form.ticker, units: Number(form.units) } }); setRes(r); setForm({ ...form, units: '' }); list.reload(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    setErr(null);
    try { await api(`/v1/redemption-notices/${id}`, { method: 'DELETE' }); list.reload(); } catch (x) { setErr(x); }
  };
  const rows = list.data?.data ?? [];
  return (
    <>
      {fixed ? null : <Head title="Redemption notices" sub="Funds with a notice period only redeem units that were noticed in advance. A notice reserves a dealing date; the redemption order itself is still checked when it is placed." />}
      <Card title="File a notice">
        {funds.loading && !funds.data ? <Loading /> : !noticeFunds.length ? <Empty title="No fund in this organization requires notice">Set a notice period in a fund's terms to use notices.</Empty> : (
          <form onSubmit={file}>
            <div class="form-grid">
              <Field label="Fund"><select value={form.ticker} onChange={(e) => setForm({ ...form, ticker: val(e), investor_id: '' })}>{noticeFunds.map((f: any) => <option value={f.ticker}>{f.ticker}: {f.short}</option>)}</select></Field>
              <Field label="Client" hint={holders.length ? undefined : 'No client in this organization holds this fund.'}>
                <select required value={form.investor_id} onChange={(e) => setForm({ ...form, investor_id: val(e) })}>
                  <option value="">Choose a holder</option>
                  {holders.map((i: any) => <option value={i.id}>{i.name}</option>)}
                </select>
              </Field>
              <Field label="Units to redeem" hint={inv ? `Holds ${units(inv.holdings[form.ticker].units)} units${already ? `, ${units(already)} already under notice` : ''}.` : undefined}>
                <input inputMode="decimal" required value={form.units} onInput={(e) => setForm({ ...form, units: val(e).replace(/[^0-9.]/g, '') })} placeholder="200000" />
              </Field>
              <div class="f"><span class="f-l">Terms</span><span class="small">{fund ? `${fund.noticeDays} days' notice. Deals ${FREQ[fund.dealingFrequency ?? 'daily']?.toLowerCase()}, cut-off ${fund.cutoffTime} ${String(fund.cutoffTz ?? '').replace(/_/g, ' ')}.${fund.gatePct ? ` Gate ${fund.gatePct}% per period.` : ''}` : ''}</span></div>
            </div>
            <div class="form-actions"><Btn type="submit" kind="primary" busy={busy} disabled={!can('orders:write') || !form.investor_id || !(Number(form.units) > 0)}>File notice</Btn></div>
            <PermNote perm="orders:write" />
          </form>
        )}
        {res ? (
          <div class="note" role="status" style={{ marginTop: '1rem', marginBottom: 0 }}>
            <strong>{res.note}</strong>
            {res.warnings?.length ? <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>{res.warnings.map((w: string) => <li>{w}</li>)}</ul> : null}
          </div>
        ) : null}
        <ErrorBox error={err} />
      </Card>
      <Card pad={false} title="Notices" actions={
        <div class="row-inline tight">
          {fixed ? null : <select class="sm" aria-label="Filter by fund" value={filter} onChange={(e) => setFilter(val(e))} style={{ width: 'auto' }}><option value="">All funds</option>{(funds.data?.data ?? []).map((f: any) => <option value={f.ticker}>{f.ticker}</option>)}</select>}
          <div class="seg-c" role="group" aria-label="Status" style={{ margin: 0 }}>
            <button type="button" class={status === 'pending' ? 'on' : ''} aria-pressed={status === 'pending'} onClick={() => setStatus('pending')}>Pending</button>
            <button type="button" class={status === 'all' ? 'on' : ''} aria-pressed={status === 'all'} onClick={() => setStatus('all')}>All</button>
          </div>
        </div>
      }>
        {list.loading && !list.data ? <div style={{ padding: '0 1.35rem' }}><Loading /></div> : list.error ? <div style={{ padding: '0 1.35rem' }}><ErrorBox error={list.error} onRetry={list.reload} /></div> : rows.length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Client</th><th>Fund</th><th class="r">Units</th><th class="r">Value at today's NAV</th><th>Filed</th><th>Deals on</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((n: any) => (
              <tr class={n.status === 'pending' ? '' : 'off'}>
                <td><a href={`#/clients/${n.investor_id}`}>{n.investor}</a></td>
                <td><a href={`#/funds/${n.ticker}`}><code>{n.ticker}</code></a></td>
                <td class="r">{units(n.units)}</td>
                <td class="r">{money(n.value, n.currency)}</td>
                <td class="muted">{fmtDate(n.notice_date)}</td>
                <td>{fmtDate(n.dealing_date)}</td>
                <td>{n.status === 'pending' ? <Chip tone="info">Pending</Chip> : n.status === 'executed' ? <Chip tone="ok">Executed</Chip> : <Chip>Cancelled</Chip>}</td>
                <td class="r">{n.status === 'pending' && can('orders:write') ? <ConfirmBtn kind="ghost" confirm="Cancel notice" onConfirm={() => cancel(n.id)}>Cancel</ConfirmBtn> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div style={{ padding: '0 1.35rem' }}><Empty title={status === 'pending' ? 'No pending notices' : 'No notices yet'}>File a notice above when a holder asks to redeem from a fund with a notice period.</Empty></div>}
      </Card>
    </>
  );
}

// ---------- Documents ----------
/** Minimal, safe markdown renderer for fund documents: headings, paragraphs, lists, tables, quotes, bold and code. No raw HTML. */
function inline(text: string): (string | VNode)[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part) =>
    part.startsWith('**') && part.endsWith('**') ? <strong>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code>{part.slice(1, -1)}</code> : part);
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: VNode[] = [];
  let i = 0;
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const size = ['1.25rem', '1.02rem', '0.92rem', '0.88rem'][h[1].length - 1];
      out.push(<p role="heading" aria-level={h[1].length + 2} style={{ fontWeight: h[1].length === 1 ? 400 : 620, fontFamily: h[1].length === 1 ? 'var(--f-display)' : undefined, fontSize: size, margin: h[1].length === 1 ? '0 0 0.2rem' : '1rem 0 0.35rem', color: '#171512' }}>{inline(h[2])}</p>);
      i++; continue;
    }
    if (l.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(<div class="note" style={{ margin: '0.6rem 0' }}>{inline(buf.join(' '))}</div>);
      continue;
    }
    if (l.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { const r = cells(lines[i++]); if (!r.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(r); }
      const [head, ...body] = rows;
      out.push(<div class="tw"><table class="t" style={{ margin: '0.4rem 0' }}><thead><tr>{head.map((c) => <th>{inline(c)}</th>)}</tr></thead><tbody>{body.map((r) => <tr>{r.map((c) => <td>{inline(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const lis = items.map((t) => <li style={{ margin: '0.2rem 0' }}>{inline(t)}</li>);
      out.push(ordered ? <ol style={{ paddingLeft: '1.3rem', margin: '0.4rem 0' }}>{lis}</ol> : <ul style={{ paddingLeft: '1.2rem', margin: '0.4rem 0' }}>{lis}</ul>);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++].trim());
    out.push(<p style={{ margin: '0.45rem 0', lineHeight: 1.6 }}>{inline(buf.join(' '))}</p>);
  }
  return <div class="md" style={{ fontSize: '0.9rem', color: '#2b2620' }}>{out}</div>;
}

function DocViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/v1/documents/${id}`, [id]);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { try { top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* old browsers */ } }, [id]);
  return (
    <div ref={top} style={{ scrollMarginTop: '1rem' }}><Card title={d.data ? `${d.data.title}, version ${d.data.version}` : 'Document'} actions={<Btn kind="ghost" onClick={onClose}>Close</Btn>}>
      {d.loading && !d.data ? <Loading /> : d.error ? <ErrorBox error={d.error} /> : (
        <>
          <div class="row-inline tight" style={{ marginBottom: '0.8rem', flexWrap: 'wrap' }}>
            {d.data.status === 'current' ? <Chip tone="ok">Current</Chip> : <Chip tone="warn">Superseded</Chip>}
            <Chip>{d.data.type_label}</Chip>
            <Chip>{d.data.jurisdiction ? JUR[d.data.jurisdiction] ?? d.data.jurisdiction : 'All jurisdictions'}</Chip>
            <Chip>{AUDIENCE[d.data.audience] ?? d.data.audience}</Chip>
            {d.data.required ? <Chip tone="info">Acknowledgment required</Chip> : <Chip>For information</Chip>}
            <span class="small muted">SHA-256 <code title={d.data.sha256}>{d.data.sha256.slice(0, 16)}…</code></span>
          </div>
          <div style={{ border: '1px solid #efebe4', borderRadius: '10px', padding: '1rem 1.2rem', maxHeight: '32rem', overflowY: 'auto', background: '#fffdf9' }}>
            <Markdown text={d.data.content} />
          </div>
          <p class="small muted" style={{ margin: '0.7rem 0 0' }}>Published {when(d.data.published_at)} by {d.data.published_by ?? 'the issuer'}. {d.data.acknowledgments.filter((a: any) => a.matches).length} acknowledgment{d.data.acknowledgments.filter((a: any) => a.matches).length === 1 ? '' : 's'} of this exact version on file.</p>
        </>
      )}
    </Card></div>
  );
}

export function FundDocuments({ ticker }: { ticker: string }) {
  const docs = useApi<any>(`/v1/funds/${ticker}/documents`, [ticker]);
  const matrix = useApi<any>(`/v1/funds/${ticker}/acknowledgments`, [ticker]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, boolean>>({});
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState<any>(null);
  const reload = () => { docs.reload(); matrix.reload(); };
  const all = docs.data?.data ?? [];
  const groups: { key: string; current: any; older: any[] }[] = [];
  for (const d of all) {
    const key = `${d.doc_type}|${d.jurisdiction ?? ''}`;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, current: null, older: [] }; groups.push(g); }
    if (d.status === 'current') g.current = d; else g.older.push(d);
  }
  return (
    <>
      <Card title="Fund documents" actions={<PermBtn perm="funds:write" kind={publishing ? 'ghost' : 'default'} onClick={() => setPublishing(!publishing)}>{publishing ? 'Close form' : 'Publish new version'}</PermBtn>}>
        <p class="small muted" style={{ marginTop: 0 }}>Each version is hashed. An investor's acknowledgment counts only for the exact version they acknowledged, so a new version must be acknowledged before the holder's next subscription or incoming transfer. Redemptions are never blocked by documents.</p>
        {msg ? (
          <div class="note" role="status">
            <strong>{msg.note}</strong>
            {msg.holders_to_acknowledge?.length ? <div class="small" style={{ marginTop: '0.3rem' }}>Needs acknowledgment: {msg.holders_to_acknowledge.map((h: any) => h.name).join(', ')}.</div> : null}
          </div>
        ) : null}
        {publishing ? <PublishForm ticker={ticker} groups={groups} onDone={(r) => { setMsg(r); setPublishing(false); reload(); }} /> : null}
        {docs.loading && !docs.data ? <Loading /> : docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : groups.length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Document</th><th>Applies to</th><th>Version</th><th class="r">Acknowledged</th><th>Published</th><th /></tr></thead>
            <tbody>{groups.map((g) => {
              const d = g.current ?? g.older[0];
              return [
                <tr>
                  <td><strong>{d.title}</strong><div class="small muted">{d.type_label}{d.required ? '' : '. For information only'}</div></td>
                  <td class="small">{d.jurisdiction ? JUR[d.jurisdiction] ?? d.jurisdiction : 'All jurisdictions'}<div class="muted">{AUDIENCE[d.audience] ?? d.audience}</div></td>
                  <td>v{d.version} {g.current ? null : <Chip tone="warn">Withdrawn</Chip>}{g.older.length ? <div><button type="button" class="link small" style={{ color: '#6d5222' }} aria-expanded={!!history[g.key]} onClick={() => setHistory({ ...history, [g.key]: !history[g.key] })}>{history[g.key] ? 'Hide' : 'Show'} {g.older.length} earlier version{g.older.length === 1 ? '' : 's'}</button></div> : null}</td>
                  <td class="r">{d.required ? d.acknowledgments : <span class="muted">Not needed</span>}</td>
                  <td class="muted small">{when(d.published_at)}</td>
                  <td class="r"><Btn kind="ghost" onClick={() => setViewing(d.id)} ariaLabel={`Read ${d.title} version ${d.version}`}>Read</Btn></td>
                </tr>,
                ...(history[g.key] ? g.older.filter((o) => o !== d).map((o) => (
                  <tr class="off">
                    <td class="small">{o.title}</td>
                    <td class="small">Superseded {when(o.superseded_at)}</td>
                    <td class="small">v{o.version}</td>
                    <td class="r small">{o.acknowledgments}</td>
                    <td class="small">{when(o.published_at)}</td>
                    <td class="r"><Btn kind="ghost" onClick={() => setViewing(o.id)} ariaLabel={`Read ${o.title} version ${o.version}`}>Read</Btn></td>
                  </tr>
                )) : []),
              ];
            })}</tbody>
          </table></div>
        ) : <Empty title="No documents published for this fund">Publish the offering document and subscription agreement so investors can acknowledge them.</Empty>}
        <PermNote perm="funds:write" />
      </Card>
      {viewing ? <DocViewer id={viewing} onClose={() => setViewing(null)} /> : null}
      <AckMatrix ticker={ticker} m={matrix} onRecorded={matrix.reload} />
    </>
  );
}

function PublishForm({ ticker, groups, onDone }: { ticker: string; groups: { key: string; current: any; older: any[] }[]; onDone: (r: any) => void }) {
  const first = groups.find((g) => g.current)?.current;
  const [f, setF] = useState({ doc_type: first?.doc_type ?? 'offering_memorandum', jurisdiction: first?.jurisdiction ?? '', title: first?.title ?? '', audience: first?.audience ?? 'all', required: first?.required ?? true, content: '' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [loadingCur, setLoadingCur] = useState(false);
  const cur = groups.find((g) => g.key === `${f.doc_type}|${f.jurisdiction}`)?.current;
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const startFrom = async () => {
    if (!cur) return;
    setLoadingCur(true); setErr(null);
    try { const d = await api(`/v1/documents/${cur.id}`); setF((x) => ({ ...x, content: d.content, title: d.title, audience: d.audience, required: d.required })); }
    catch (e) { setErr(e); } finally { setLoadingCur(false); }
  };
  const submit = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { onDone(await api(`/v1/funds/${ticker}/documents`, { body: { ...f, jurisdiction: f.jurisdiction || null } })); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} style={{ borderTop: '1px solid #efebe4', borderBottom: '1px solid #efebe4', padding: '1rem 0', margin: '0 0 1rem' }}>
      <div class="form-grid">
        <Field label="Document type"><select value={f.doc_type} onChange={(e) => { const t = val(e); setF((x) => ({ ...x, doc_type: t, required: t !== 'factsheet' })); }}>{Object.entries(DOC_TYPES).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
        <Field label="Jurisdiction" hint="Leave as all for a document every investor receives"><select value={f.jurisdiction} onChange={(e) => set('jurisdiction', val(e))}><option value="">All jurisdictions</option>{Object.entries(JUR).filter(([k]) => !['IR', 'CU', 'KP'].includes(k)).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
        <Field label="Title"><input required minLength={3} value={f.title} onInput={(e) => set('title', val(e))} placeholder="Offering memorandum" /></Field>
        <Field label="Audience"><select value={f.audience} onChange={(e) => set('audience', val(e))}>{Object.entries(AUDIENCE).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
        <div class="span2">
          <Field label="Content (markdown)" hint={cur ? `Publishing replaces version ${cur.version} of this document. Holders must acknowledge the new version before they can add units.` : 'This will be version 1 of this document.'}>
            <textarea required rows={14} minLength={50} value={f.content} onInput={(e) => set('content', (e.target as HTMLTextAreaElement).value)} placeholder={'# Fund name\n## Offering memorandum\n\n> Fictional document for the Laissez sandbox.\n\n### Summary of terms\n...'} style={{ fontFamily: 'var(--f-mono)', fontSize: '0.82rem' }} />
          </Field>
        </div>
        <label class="check span2"><input type="checkbox" checked={f.required} onChange={(e) => set('required', (e.target as HTMLInputElement).checked)} /> Investors must acknowledge this document before receiving units</label>
      </div>
      <div class="form-actions">
        <Btn type="submit" kind="primary" busy={busy} disabled={f.content.trim().length < 50 || f.title.trim().length < 3}>Publish version {cur ? cur.version + 1 : 1}</Btn>
        {cur ? <Btn kind="ghost" busy={loadingCur} onClick={startFrom}>Start from version {cur.version}</Btn> : null}
      </div>
      <ErrorBox error={err} />
    </form>
  );
}

const CELL: Record<string, { tone: 'ok' | 'no' | 'warn' | 'muted'; label: string }> = {
  acknowledged: { tone: 'ok', label: 'Acknowledged' }, outdated: { tone: 'warn', label: 'Older version' }, missing: { tone: 'no', label: 'Missing' },
  not_applicable: { tone: 'muted', label: 'Not needed' }, optional: { tone: 'muted', label: 'Optional' },
};

type ApiState = { data: any; error: any; loading: boolean; reload: () => void };
function AckMatrix({ ticker, m, onRecorded }: { ticker: string; m: ApiState; onRecorded: () => void }) {
  const { can, why } = useMe();
  const [rec, setRec] = useState<{ inv: string; doc: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [onlyHolders, setOnlyHolders] = useState(false);
  const save = async (e: Event) => {
    e.preventDefault();
    if (!rec) return;
    setBusy(true); setErr(null);
    try { await api(`/v1/documents/${rec.doc}/acknowledge`, { body: { investor_id: rec.inv, signed_name: name, method: 'ops_attested' } }); setRec(null); onRecorded(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const M = m.data;
  const docs = (M?.documents ?? []) as any[];
  const invs = ((M?.investors ?? []) as any[]).filter((i) => !onlyHolders || i.holder);
  return (
    <Card pad={false} title="Acknowledgments" actions={M ? <label class="check small"><input type="checkbox" checked={onlyHolders} onChange={(e) => setOnlyHolders((e.target as HTMLInputElement).checked)} /> Holders only</label> : null}>
      <div style={{ padding: '0 1.35rem' }}>
        {M ? <p class="small" style={{ margin: '0 0 0.6rem' }}><strong>{M.summary.acknowledged} of {M.summary.required_acknowledgments}</strong> required acknowledgments on file. {M.summary.ready_investors} of {M.summary.investors} clients can receive {ticker} units today on documents alone.{M.summary.outdated ? ` ${M.summary.outdated} acknowledgment${M.summary.outdated === 1 ? ' is' : 's are'} for an older version.` : ''}</p> : null}
        <ErrorBox error={err} />
      </div>
      {m.loading && !M ? <div style={{ padding: '0 1.35rem' }}><Loading /></div> : m.error ? <div style={{ padding: '0 1.35rem' }}><ErrorBox error={m.error} onRetry={m.reload} /></div> : !docs.length ? (
        <div style={{ padding: '0 1.35rem' }}><Empty title="No current documents to acknowledge" /></div>
      ) : (
        <div class="tw"><table class="t matrix">
          <thead><tr><th>Client</th>{docs.map((d) => <th title={`${d.type_label}, SHA-256 ${d.sha256.slice(0, 12)}…`}>{d.title}<div class="small muted" style={{ fontWeight: 400 }}>v{d.version}{d.jurisdiction ? `, ${d.jurisdiction} only` : ''}{d.required ? '' : ', optional'}</div></th>)}</tr></thead>
          <tbody>{invs.map((i) => (
            <tr>
              <td style={{ minWidth: '12rem' }}><a href={`#/clients/${i.id}`}>{i.name}</a><div class="small muted">{JUR[i.residence] ?? i.residence}{i.holder ? `. Holds ${units(i.units)} units` : ''}</div>{i.ready ? null : <Chip tone="warn">Action needed</Chip>}</td>
              {docs.map((d) => {
                const c = M.cells[i.id]?.[d.id] ?? { status: 'not_applicable' };
                const s = CELL[c.status] ?? CELL.not_applicable;
                const open = rec?.inv === i.id && rec?.doc === d.id;
                return (
                  <td>
                    <Chip tone={s.tone} title={c.acknowledged_at ? `${c.status === 'outdated' ? `Version ${c.version_acknowledged} acknowledged` : 'Acknowledged'} ${when(c.acknowledged_at)}` : undefined}>{c.status === 'outdated' ? `v${c.version_acknowledged} on file` : s.label}</Chip>
                    {c.acknowledged_at && c.status === 'acknowledged' ? <div class="small muted">{fmtDate(c.acknowledged_at)}</div> : null}
                    {(c.status === 'missing' || c.status === 'outdated') && !open ? (
                      <div><Btn kind="ghost" disabled={!can('clients:write')} title={can('clients:write') ? undefined : why('clients:write')} onClick={() => { setRec({ inv: i.id, doc: d.id }); setName(i.name); setErr(null); }} ariaLabel={`Record acknowledgment of ${d.title} for ${i.name}`}>Record acknowledgment</Btn></div>
                    ) : null}
                    {open ? (
                      <form onSubmit={save} style={{ display: 'grid', gap: '0.35rem', marginTop: '0.4rem' }}>
                        <input class="sm" required minLength={2} value={name} onInput={(e) => setName(val(e))} aria-label="Signed name" style={{ width: '100%' }} />
                        <span class="small muted">Ops attests the client acknowledged v{d.version}.</span>
                        <div class="row-inline tight"><Btn type="submit" kind="primary" busy={busy}>Save</Btn><Btn kind="ghost" onClick={() => setRec(null)}>Cancel</Btn></div>
                      </form>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <div style={{ padding: '0 1.35rem 1rem' }}><PermNote perm="clients:write" /></div>
    </Card>
  );
}

/** Small wrapper for embedding: lifecycle first, documents after. */
export function FundOps({ ticker, onChange }: { ticker: string; onChange?: () => void }): VNode {
  return <><FundLifecycle ticker={ticker} onChange={onChange} /><FundDocuments ticker={ticker} /></>;
}
