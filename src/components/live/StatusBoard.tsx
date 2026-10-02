import { useState } from 'preact/hooks';
import { API_HOST, type DailyUptime, type Incident, type StatusComponent, type StatusResponse } from './api';
import { useLive, useNow, REFRESH_MS } from './store';
import { UptimeStrip, LEVEL_TEXT, type Level } from './UptimeStrip';
import { fmtAgo, fmtDateTime, fmtDay, fmtDayLong, fmtDuration, fmtInt, fmtTime, fmtUptime, isoDay, joinNames } from './format';

// Plain descriptions of what each check covers. Mirrors the uptime job in api/src/index.ts.
const META: Record<string, { name: string; description: string }> = {
  api: { name: 'API', description: 'Request handling on Cloudflare Workers.' },
  database: { name: 'Database', description: 'Neon Postgres, the system of record.' },
  chain_rpc: { name: 'Chain RPC', description: 'Base Sepolia testnet node used for on-chain settlement.' },
  sanctions_data: { name: 'Sanctions data', description: 'OFAC, UN, EU and UK lists, refreshed daily.' },
  monitoring: { name: 'Monitoring', description: 'Nightly re-check of every holder against current rules.' },
};
const nameOf = (c: { id: string; name: string }) => META[c.id]?.name ?? c.name;

const STATE_TEXT: Record<StatusComponent['status'], string> = { operational: 'Operational', degraded: 'Degraded', unknown: 'No recent data' };
const STATE_CLASS: Record<StatusComponent['status'], string> = { operational: 'ok', degraded: 'bad', unknown: 'idle' };
const DAYS_FALLBACK = 90;

function headline(d: StatusResponse): { text: string; sub: string; tone: 'ok' | 'bad' | 'idle' } {
  const degraded = d.components.filter((c) => c.status === 'degraded').map(nameOf);
  const unknown = d.components.filter((c) => c.status === 'unknown').map(nameOf);
  if (degraded.length) {
    return {
      tone: 'bad',
      text: `${joinNames(degraded)} ${degraded.length === 1 ? 'is' : 'are'} degraded`,
      sub: degraded.length === d.components.length ? 'Every component failed its latest check.' : 'The latest check failed for the components named here. Everything else passed.',
    };
  }
  if (unknown.length === d.components.length) return { tone: 'idle', text: 'No recent checks', sub: 'No component has a check from the last 30 minutes, so this page cannot confirm the current state.' };
  if (unknown.length) {
    return { tone: 'idle', text: `No recent checks for ${joinNames(unknown)}`, sub: 'Its latest check is more than 30 minutes old or missing. Every other component passed its latest check.' };
  }
  return { tone: 'ok', text: 'All systems operational', sub: 'Every component passed its latest check.' };
}

function emptyDays(n: number): DailyUptime[] {
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  return Array.from({ length: n }, (_, i) => ({ date: new Date(today - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10), checks: 0, ok_checks: 0, uptime: null }));
}

export default function StatusBoard() {
  const live = useLive<StatusResponse>('status');
  const now = useNow(15_000);
  const { data, error, loading, updatedAt, failedAt, lastOkAt } = live;

  if (!data && error) return <Unreachable error={error} lastOkAt={lastOkAt} now={now} loading={loading} onRetry={live.refresh} />;
  if (!data) return <Skeleton />;

  const h = headline(data);
  const windowDays = data.daily_window_days ?? DAYS_FALLBACK;
  const lastCheck = data.components.reduce<number | null>((m, c) => (c.last_checked_at ? Math.max(m ?? 0, new Date(c.last_checked_at).getTime()) : m), null);
  // Earliest day with any check, to say plainly how much history the long windows cover.
  const firstDay = Object.values(data.daily ?? {}).flat().filter((x) => x.checks > 0).map((x) => x.date).sort()[0] ?? null;
  const daysCovered = firstDay ? Math.round((Date.parse(isoDay(Date.now())) - Date.parse(firstDay)) / 86_400_000) + 1 : 0;

  return (
    <div class="lv-status">
      <div class={`lv-overall ${h.tone}`}>
        <div class="lv-overall-main">
          <span class={`lv-dot lg ${h.tone}`} aria-hidden="true" />
          <div>
            <h2 class="lv-overall-h" aria-live="polite">{h.text}</h2>
            <p class="lv-overall-sub">{h.sub}</p>
          </div>
        </div>
        <dl class="lv-overall-meta">
          <div><dt>Last check ran</dt><dd>{lastCheck ? <>{fmtAgo(lastCheck, now)} <span class="lv-quiet">({fmtTime(lastCheck)})</span></> : 'No checks yet'}</dd></div>
          <div><dt>Page updated</dt><dd>{updatedAt ? fmtAgo(updatedAt, now) : 'now'} <span class="lv-quiet">(every {REFRESH_MS / 1000} s)</span></dd></div>
          <div class="lv-overall-act"><button type="button" class="btn ghost-sm" onClick={live.refresh} disabled={loading}>{loading ? 'Refreshing' : 'Refresh now'}</button></div>
        </dl>
      </div>

      {error && failedAt && (
        <p class="lv-warn" role="status">
          Could not refresh at {fmtTime(failedAt)}: {error} Showing results from {updatedAt ? fmtTime(updatedAt) : 'the last good response'}.
        </p>
      )}

      {firstDay && daysCovered < windowDays && (
        <p class="lv-coverage">Checks have been recorded since {fmtDayLong(firstDay)}, so the 7-day and {windowDays}-day figures cover {daysCovered} {daysCovered === 1 ? 'day' : 'days'} of history. Days before that show as no data.</p>
      )}

      <ul class="lv-components" aria-label="Components">
        {data.components.map((c) => <ComponentRow key={c.id} c={c} days={data.daily?.[c.id] ?? emptyDays(windowDays)} now={now} />)}
      </ul>

      <ul class="lv-legend" aria-label="Bar colors">
        {(['ok', 'minor', 'major', 'none'] as Level[]).map((l) => <li key={l}><span class={`lv-sw ${l}`} aria-hidden="true" />{LEVEL_TEXT[l]}</li>)}
      </ul>

      <Incidents incidents={data.incidents} windowDays={data.incident_window_days ?? 30} firstDay={firstDay} />

      <Freshness data={data} now={now} />
    </div>
  );
}

function ComponentRow({ c, days, now }: { c: StatusComponent; days: DailyUptime[]; now: number }) {
  const meta = META[c.id];
  const name = nameOf(c);
  const withData = days.filter((d) => d.checks > 0);
  return (
    <li class="lv-comp">
      <div class="lv-comp-top">
        <div class="lv-comp-id">
          <h3 class="lv-comp-name">{name}</h3>
          <span class={`lv-pill ${STATE_CLASS[c.status]}`}><span class={`lv-dot ${STATE_CLASS[c.status]}`} aria-hidden="true" />{STATE_TEXT[c.status]}</span>
          {meta && <p class="lv-comp-desc">{meta.description}</p>}
        </div>
        <dl class="lv-comp-stats">
          <div><dt>Latency</dt><dd>{c.latency_ms != null ? `${fmtInt(c.latency_ms)} ms` : 'n/a'}</dd></div>
          <div><dt>24 h</dt><dd>{fmtUptime(c.uptime['24h'])}</dd></div>
          <div><dt>7 d</dt><dd>{fmtUptime(c.uptime['7d'])}</dd></div>
          <div><dt>90 d</dt><dd>{fmtUptime(c.uptime['90d'])}</dd></div>
        </dl>
      </div>
      <UptimeStrip name={name} days={days} />
      <div class="lv-comp-foot">
        <p class="lv-check"><span class="lv-quiet">Latest check{c.last_checked_at ? `, ${fmtAgo(c.last_checked_at, now)}` : ''}:</span> <code>{c.detail ?? 'No detail recorded.'}</code></p>
        {withData.length > 0 && (
          <details class="lv-details">
            <summary>Daily table</summary>
            <div class="table-wrap">
              <table class="grid lv-table">
                <caption class="lv-sr">{name}: uptime by UTC day, newest first. Days without checks are omitted.</caption>
                <thead><tr><th scope="col">Day</th><th scope="col">Uptime</th><th scope="col">Checks passed</th></tr></thead>
                <tbody>
                  {withData.slice().reverse().map((d) => (
                    <tr key={d.date}><td>{fmtDay(d.date)}</td><td class="num">{fmtUptime(d.uptime)}</td><td class="num">{fmtInt(d.ok_checks)} of {fmtInt(d.checks)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </li>
  );
}

function incidentWindow(i: Incident): string {
  const start = fmtDateTime(i.started_at);
  if (!i.ended_at) return `Since ${start}`;
  const sameDay = isoDay(i.started_at) === isoDay(i.ended_at);
  return `${start} to ${sameDay ? fmtTime(i.ended_at) : fmtDateTime(i.ended_at)}`;
}

function Incidents({ incidents, windowDays, firstDay }: { incidents?: Incident[]; windowDays: number; firstDay: string | null }) {
  const [all, setAll] = useState(false);
  const SHOW = 6;
  if (!incidents) return null;
  const list = all ? incidents : incidents.slice(0, SHOW);
  return (
    <section class="lv-block" aria-labelledby="lv-inc-h">
      <div class="lv-block-head">
        <h2 id="lv-inc-h" class="lv-block-h">Recent incidents</h2>
        <p class="lv-quiet">Last {windowDays} days. An incident starts at the first failed check and ends at the next passing one.</p>
      </div>
      {!incidents.length ? (
        <p class="lv-empty">No incidents in the last {windowDays} days{firstDay && Date.parse(firstDay) > Date.now() - windowDays * 86_400_000 ? `, counting from when checks began on ${fmtDayLong(firstDay)}` : ''}.</p>
      ) : (
        <>
          <ol class="lv-incidents">
            {list.map((i) => (
              <li key={`${i.component}-${i.started_at}`} class="lv-inc">
                <div class="lv-inc-head">
                  <h3 class="lv-inc-name">{META[i.component]?.name ?? i.name}</h3>
                  {i.ongoing ? <span class="lv-pill bad"><span class="lv-dot bad" aria-hidden="true" />Ongoing</span> : <span class="lv-pill idle">Resolved</span>}
                </div>
                <p class="lv-inc-when">{incidentWindow(i)}</p>
                <p class="lv-inc-facts"><span>{i.ongoing ? `${fmtDuration(i.duration_seconds)} so far` : fmtDuration(i.duration_seconds)}</span><span>{fmtInt(i.failed_checks)} failed {i.failed_checks === 1 ? 'check' : 'checks'}</span></p>
                {i.detail && <p class="lv-check"><code>{i.detail}</code></p>}
              </li>
            ))}
          </ol>
          {incidents.length > SHOW && <button type="button" class="lv-more" onClick={() => setAll(!all)} aria-expanded={all}>{all ? 'Show fewer' : `Show all ${incidents.length} incidents`}</button>}
        </>
      )}
    </section>
  );
}

function Freshness({ data, now }: { data: StatusResponse; now: number }) {
  const lists = data.sanctions.sources.filter((s) => s.source !== 'LAISSEZ-TEST');
  const hasTest = data.sanctions.sources.some((s) => s.source === 'LAISSEZ-TEST');
  return (
    <section class="lv-block" aria-labelledby="lv-fresh-h">
      <div class="lv-block-head">
        <h2 id="lv-fresh-h" class="lv-block-h">Data freshness</h2>
        <p class="lv-quiet">Sanctions data turns degraded if any list is more than 36 hours old or its last load failed.</p>
      </div>
      {lists.length ? (
        <div class="table-wrap">
          <table class="grid lv-table">
            <thead><tr><th scope="col">List</th><th scope="col">Names loaded</th><th scope="col">Publisher date</th><th scope="col">Refreshed</th><th scope="col">Load</th></tr></thead>
            <tbody>
              {lists.map((s) => (
                <tr key={s.source}>
                  <td>{s.name}</td>
                  <td class="num">{fmtInt(s.entries)}</td>
                  <td class="lv-quiet">{s.last_published ?? 'Not stated'}</td>
                  <td>{s.last_fetched_at ? fmtAgo(s.last_fetched_at, now) : 'Never'}</td>
                  <td>{s.status === 'error' ? <span class="lv-pill bad">Failed</span> : s.status === 'pending' ? <span class="lv-pill idle">Pending</span> : <span class="lv-pill ok">Loaded</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p class="lv-empty">No sanctions lists have been loaded yet.</p>}
      <p class="lv-note">
        {hasTest ? 'A short list of fictional test names, used in demos, is loaded alongside these and excluded here. ' : ''}
        Holder monitoring {data.monitoring.last_run_finished_at ? `last finished ${fmtAgo(data.monitoring.last_run_finished_at, now)} (${fmtDateTime(data.monitoring.last_run_finished_at)})` : 'has not finished a run yet'}, with {fmtInt(data.monitoring.runs_24h)} {data.monitoring.runs_24h === 1 ? 'run' : 'runs'} started in the last 24 hours.
      </p>
    </section>
  );
}

function Unreachable({ error, lastOkAt, now, loading, onRetry }: { error: string; lastOkAt: number | null; now: number; loading: boolean; onRetry: () => void }) {
  return (
    <div class="lv-status">
      <div class="lv-overall idle" role="alert">
        <div class="lv-overall-main">
          <span class="lv-dot lg idle" aria-hidden="true" />
          <div>
            <h2 class="lv-overall-h">The status API cannot be reached</h2>
            <p class="lv-overall-sub">This browser got no usable answer from {API_HOST}. {error} That can mean the API is down, or that a network, firewall or browser extension is blocking it.</p>
            <p class="lv-overall-sub">{lastOkAt ? `Last reached from this browser ${fmtAgo(lastOkAt, now)}, at ${fmtDateTime(lastOkAt)}.` : 'This browser has not reached it before, so there is no earlier reading to show.'} Retrying every {REFRESH_MS / 1000} seconds.</p>
          </div>
        </div>
        <div class="lv-overall-meta"><div class="lv-overall-act"><button type="button" class="btn ghost-sm" onClick={onRetry} disabled={loading}>{loading ? 'Trying' : 'Try again'}</button></div></div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div class="lv-status" aria-busy="true">
      <div class="lv-overall idle">
        <div class="lv-overall-main">
          <span class="lv-dot lg idle" aria-hidden="true" />
          <div><h2 class="lv-overall-h">Loading live status</h2><p class="lv-overall-sub">Reading the latest checks from the public status endpoint.</p></div>
        </div>
      </div>
      <ul class="lv-components" aria-hidden="true">
        {Object.entries(META).map(([id, m]) => (
          <li key={id} class="lv-comp sk">
            <div class="lv-comp-top"><div class="lv-comp-id"><h3 class="lv-comp-name">{m.name}</h3><p class="lv-comp-desc">{m.description}</p></div></div>
            <div class="lv-strip-wrap"><div class="lv-strip">{emptyDays(DAYS_FALLBACK).map((d) => <span key={d.date} class="lv-bar none" />)}</div></div>
          </li>
        ))}
      </ul>
    </div>
  );
}
