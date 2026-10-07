// Live islands for the metrics page. Each reads the shared store, so the page makes one request per
// endpoint per minute. Shapes: api/src/routes/platform.ts (GET /v1/metrics/public, GET /v1/status)
// and api/src/routes/core.ts (GET /v1/rule-packs).
import type { ComponentChildren } from 'preact';
import { API_HOST, type MetricsResponse, type RulePacksResponse, type StatusResponse } from './api';
import { useLive, useNow, REFRESH_MS, type LiveState } from './store';
import { ColumnChart } from './ColumnChart';
import { fmtAgo, fmtCompact, fmtDateTime, fmtDay, fmtDayLong, fmtDuration, fmtInt, fmtMoney, fmtRate, fmtTime } from './format';

const STEP_LABEL: Record<string, string> = {
  sandbox_opened: 'Opened a sandbox',
  order_placed: 'Placed an order',
  settlement_completed: 'Settled an order',
  policy_published: 'Published a policy change',
};
const SERIES_LABEL: Record<string, { title: string; unit: string }> = {
  sandbox_opened: { title: 'Sandboxes opened', unit: 'opened' },
  order_placed: { title: 'Orders placed', unit: 'placed' },
  settlement_completed: { title: 'Settlements completed', unit: 'completed' },
  policy_published: { title: 'Policy changes published', unit: 'published' },
};

/** Loading and failure placeholders shared by every island. */
function Gate<T>({ live, children, rows = 1 }: { live: LiveState<T>; children: (d: T) => ComponentChildren; rows?: number }) {
  if (live.data) return <>{children(live.data)}</>;
  if (live.error) return <p class="lv-unavail" role="status">Live figures are unavailable right now. {live.error}</p>;
  return <div class="lv-loading" aria-busy="true" aria-label="Loading live figures">{Array.from({ length: rows }, (_, i) => <span key={i} />)}</div>;
}

// ---------- Page stamp: source, freshness and errors ----------
export function MetricsStamp() {
  const live = useLive<MetricsResponse>('metrics');
  const now = useNow(15_000);
  const { data, error, failedAt, lastOkAt, updatedAt, loading } = live;
  if (!data && error) {
    return (
      <div class="lv-stamp bad" role="alert">
        <span class="lv-dot idle" aria-hidden="true" />
        <p>The metrics API at {API_HOST} cannot be reached. {error} {lastOkAt ? `This browser last reached it ${fmtAgo(lastOkAt, now)}, at ${fmtDateTime(lastOkAt)}.` : 'This browser has not reached it before.'} The figures below fill in as soon as it answers; retrying every {REFRESH_MS / 1000} seconds.</p>
        <button type="button" class="btn ghost-sm" onClick={live.refresh} disabled={loading}>{loading ? 'Trying' : 'Try again'}</button>
      </div>
    );
  }
  if (!data) return <div class="lv-stamp"><span class="lv-dot idle" aria-hidden="true" /><p>Loading live figures from the sandbox API.</p></div>;
  return (
    <div class="lv-stamp">
      <span class="lv-dot ok" aria-hidden="true" />
      <p>
        Live from the sandbox API. Computed {fmtAgo(data.generated_at, now)} ({fmtTime(data.generated_at)}), refreshed every {REFRESH_MS / 1000} seconds.
        {error && failedAt ? ` The latest refresh at ${fmtTime(failedAt)} failed, so these are the figures from ${updatedAt ? fmtTime(updatedAt) : 'earlier'}.` : ''}
      </p>
    </div>
  );
}

// ---------- North star ----------
export function NorthStar() {
  const live = useLive<MetricsResponse>('metrics');
  return (
    <Gate live={live} rows={2}>
      {(d) => {
        const rows = d.north_star.by_currency.slice().sort((a, b) => b.all_time - a.all_time);
        const series = d.series;
        if (!rows.length) {
          return <p class="lv-empty">No cross-border settlement has completed yet in a live sandbox or organization. This figure starts moving with the first one.</p>;
        }
        return (
          <div class="lv-ns">
            <div class={`lv-ns-grid n${Math.min(rows.length, 3)}`}>
              {rows.map((r) => (
                <div class="lv-ns-cell" key={r.currency}>
                  <p class="lv-ns-cur">{r.currency}</p>
                  <p class="lv-fig" title={fmtMoney(r.last_30d, r.currency)}>{fmtMoney(r.last_30d, r.currency, r.last_30d >= 100_000)}</p>
                  <p class="lv-fig-cap">settled in the last {d.window_days} days, across {fmtInt(r.settlements_30d)} {r.settlements_30d === 1 ? 'settlement' : 'settlements'}</p>
                  <p class="lv-ns-all"><span class="num" title={fmtMoney(r.all_time, r.currency)}>{fmtMoney(r.all_time, r.currency, r.all_time >= 100_000)}</span> all time, across {fmtInt(r.settlements_all_time)}</p>
                </div>
              ))}
            </div>
            {rows.length > 1 && <p class="lv-note">Each currency is shown on its own. Laissez does not convert between currencies, so there is no single total.</p>}
            {series && (
              <div class={`lv-ns-charts n${Math.min(rows.length, 2)}`}>
                {rows.map((r) => {
                  const values = series.cross_border_settled_value[r.currency] ?? series.days.map(() => 0);
                  return (
                    <figure class="lv-fig-chart" key={r.currency}>
                      <figcaption><span>Daily cross-border settled value, {r.currency}</span><span class="lv-quiet">UTC days</span></figcaption>
                      <ColumnChart title={`Daily cross-border settled value in ${r.currency}`} days={series.days} values={values}
                        format={(v) => fmtMoney(v, r.currency)} tickFormat={(v) => fmtMoney(v, r.currency, true)} unit="settled" />
                    </figure>
                  );
                })}
              </div>
            )}
          </div>
        );
      }}
    </Gate>
  );
}

// ---------- Activation funnel ----------
export function Funnel() {
  const live = useLive<MetricsResponse>('metrics');
  return (
    <Gate live={live} rows={4}>
      {(d) => {
        const steps = d.funnel;
        const top = Math.max(1, ...steps.map((s) => s.subjects));
        return (
          <div class="lv-funnel">
            <ol class="lv-steps">
              {steps.map((s, i) => {
                const prev = i > 0 ? steps[i - 1].subjects : null;
                const conv = prev ? s.subjects / prev : null;
                return (
                  <li key={s.event} class="lv-step">
                    {i > 0 && (
                      <p class="lv-conv"><span aria-hidden="true" class="lv-conv-arrow" />{prev ? `${fmtRate(conv)} of the step before` : 'No one reached the step before'}</p>
                    )}
                    <div class="lv-step-row">
                      <p class="lv-step-name"><span class="lv-step-n">{i + 1}</span>{STEP_LABEL[s.event] ?? s.event}</p>
                      <div class="lv-step-bar" aria-hidden="true"><span style={{ width: `${s.subjects ? Math.max(0.6, (s.subjects / top) * 100) : 0}%` }} /></div>
                      <p class="lv-step-val"><strong class="num">{fmtInt(s.subjects)}</strong>{i > 0 && <span class="lv-quiet"> {fmtRate(s.conversion_from_start)} of step 1</span>}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <p class="lv-note">Distinct visitors or workspaces that reached each step in the last {d.window_days} days. Each step is counted on its own rather than as a strict cohort, so someone who opened a sandbox {d.window_days + 1} days ago and settled yesterday counts at step 3 only.</p>
          </div>
        );
      }}
    </Gate>
  );
}

// ---------- Guardrails ----------
export function Guardrails() {
  const metrics = useLive<MetricsResponse>('metrics');
  const status = useLive<StatusResponse>('status');
  const packs = useLive<RulePacksResponse>('rulepacks');
  const now = useNow(30_000);
  return (
    <div class="lv-guards">
      <div class="lv-guard">
        <h3 class="lv-guard-h">Settlements executed without an ALLOW at settlement time</h3>
        <Gate live={metrics}>
          {(d) => {
            const g = d.guardrail;
            const held = g.settled_without_allow <= g.target;
            return (
              <>
                <div class="lv-guard-fig"><p class="lv-fig">{fmtInt(g.settled_without_allow)}</p><Verdict ok={held} /></div>
                <p class="lv-fig-cap">Target {g.target}. Counts any settlement whose decision was not ALLOW, or whose re-check at settlement time was not ALLOW.</p>
                <p class="lv-guard-sub"><strong class="num">{fmtInt(g.rechecked_at_settlement)}</strong> of {fmtInt(g.settlements)} settlements carry a recorded re-check{g.settlements ? ` (${fmtRate(g.rechecked_at_settlement / g.settlements)})` : ''}.</p>
              </>
            );
          }}
        </Gate>
      </div>
      <div class="lv-guard">
        <h3 class="lv-guard-h">Sanctions list freshness</h3>
        <Gate live={status}>
          {(d) => {
            const h = d.sanctions.oldest_list_hours;
            const lists = d.sanctions.sources.filter((s) => s.source !== 'LAISSEZ-TEST');
            const failed = lists.filter((s) => s.status === 'error');
            const ok = h != null && h <= 36 && !failed.length;
            return (
              <>
                <div class="lv-guard-fig"><p class="lv-fig">{h == null ? 'n/a' : `${h < 10 ? h.toFixed(1) : Math.round(h)} h`}</p>{h != null && <Verdict ok={ok} />}</div>
                <p class="lv-fig-cap">Age of the oldest of {lists.length} official lists. The limit is 36 hours; lists refresh daily.</p>
                {failed.length > 0 && <p class="lv-guard-sub">Last load failed for {failed.map((s) => s.source).join(', ')}.</p>}
              </>
            );
          }}
        </Gate>
      </div>
      <div class="lv-guard">
        <h3 class="lv-guard-h">Rule-pack freshness</h3>
        <Gate live={packs}>
          {(d) => {
            const sanc = d.data.filter((p) => p.id === 'global/sanctions' && p.effective_from).sort((a, b) => (b.effective_from! > a.effective_from! ? 1 : -1))[0];
            const active = d.data.filter((p) => p.status === 'active');
            const latestById = new Map<string, typeof active[number]>();
            for (const p of active) if (!latestById.has(p.id)) latestById.set(p.id, p);
            const current = [...latestById.values()];
            const pending = current.filter((p) => /pending/i.test(p.approved_by ?? '') || !p.approved_by).length;
            const ageDays = sanc ? Math.floor((now - Date.parse(`${sanc.effective_from}T00:00:00Z`)) / 86_400_000) : null;
            return (
              <>
                <div class="lv-guard-fig"><p class="lv-fig">{sanc ? fmtDay(sanc.effective_from!) : 'n/a'}</p></div>
                <p class="lv-fig-cap">Effective date of the newest sanctions rule-pack version{ageDays != null ? `, ${ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`}` : ''}. Each daily list refresh records one, so every decision cites the list state it used.</p>
                <p class="lv-guard-sub"><strong class="num">{pending}</strong> of {current.length} rule packs in force are still awaiting counsel review. Counsel sign-off is a condition of production access.</p>
              </>
            );
          }}
        </Gate>
      </div>
    </div>
  );
}

function Verdict({ ok }: { ok: boolean }) {
  return ok
    ? <span class="lv-pill ok"><span class="lv-dot ok" aria-hidden="true" />Within limit</span>
    : <span class="lv-pill bad"><span class="lv-dot bad" aria-hidden="true" />Breached</span>;
}

// ---------- Credential reuse and time to first settlement ----------
export function Adoption() {
  const live = useLive<MetricsResponse>('metrics');
  return (
    <Gate live={live} rows={2}>
      {(d) => {
        const r = d.credential_reuse; const t = d.time_to_first_settlement;
        return (
          <div class="lv-adopt">
            <div class="lv-tile">
              <h3 class="lv-tile-h">Credential reuse rate</h3>
              <p class="lv-fig">{fmtRate(r.multi_fund_rate)}</p>
              <p class="lv-fig-cap"><strong class="num">{fmtInt(r.multi_fund)}</strong> of {fmtInt(r.investors_with_allowed_orders)} investors with an allowed order were cleared for two or more funds on one credential.</p>
              <p class="lv-guard-sub">Across institutions: <strong class="num">{fmtInt(r.relied_on_network)}</strong> ({fmtRate(r.network_rate)}) relied on a credential issued by another distributor.</p>
            </div>
            <div class="lv-tile">
              <h3 class="lv-tile-h">Median time from sandbox opened to first settlement</h3>
              <p class="lv-fig">{t.median_seconds == null ? 'n/a' : fmtDuration(t.median_seconds)}</p>
              <p class="lv-fig-cap"><strong class="num">{fmtInt(t.workspaces_settled)}</strong> of {fmtInt(t.workspaces_opened_30d)} sandboxes opened in the last {d.window_days} days have settled an order{t.workspaces_opened_30d ? ` (${fmtRate(t.workspaces_settled / t.workspaces_opened_30d)})` : ''}. The median covers those that did.</p>
            </div>
          </div>
        );
      }}
    </Gate>
  );
}

// ---------- 30-day small multiples ----------
export function SeriesGrid() {
  const live = useLive<MetricsResponse>('metrics');
  return (
    <Gate live={live} rows={3}>
      {(d) => {
        const s = d.series;
        if (!s) return <p class="lv-unavail">The daily series is not available from this version of the API yet.</p>;
        const charts = [
          ...Object.keys(SERIES_LABEL).map((k) => ({ key: k, ...SERIES_LABEL[k], values: s.events[k] ?? s.days.map(() => 0) })),
          { key: 'xb', title: 'Cross-border settlements', unit: 'settled', values: s.cross_border_settlements },
        ];
        return (
          <div>
            <div class="lv-multiples">
              {charts.map((c) => {
                const total = c.values.reduce((a, b) => a + b, 0);
                return (
                  <figure class="lv-fig-chart" key={c.key}>
                    <figcaption><span>{c.title}</span><span class="lv-quiet"><strong class="num">{fmtInt(total)}</strong> in {s.window_days} days</span></figcaption>
                    <ColumnChart title={`${c.title} per day`} days={s.days} values={c.values} format={fmtInt} tickFormat={(v) => (v >= 10_000 ? fmtCompact(v) : fmtInt(v))} unit={c.unit} />
                  </figure>
                );
              })}
            </div>
            <details class="lv-details wide">
              <summary>Show these series as a table</summary>
              <div class="table-wrap">
                <table class="grid lv-table">
                  <caption class="lv-sr">Daily counts for the last {s.window_days} UTC days, newest first.</caption>
                  <thead><tr><th scope="col">Day</th>{charts.map((c) => <th scope="col" key={c.key}>{c.title}</th>)}</tr></thead>
                  <tbody>
                    {s.days.map((day, i) => ({ day, i })).reverse().map(({ day, i }) => (
                      <tr key={day}><td>{fmtDayLong(day)}</td>{charts.map((c) => <td class="num" key={c.key}>{fmtInt(c.values[i] ?? 0)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <p class="lv-note">{d.note} Event charts count events, not distinct visitors. Days are UTC.</p>
          </div>
        );
      }}
    </Gate>
  );
}
