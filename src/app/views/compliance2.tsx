/** @jsxImportSource preact */
// Compliance operations: work queue, screening hits, sanctions lists, monitoring and the regulator feed.
import { useState } from 'preact/hooks';
import { api, when, day, JUR } from '../api';
import { useApi, Head, Btn, Chip, Card, Empty, Loading, ErrorBox, Field, Toast, statusChip } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const pct = (score: number) => `${Math.round(Number(score) * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const jur = (code?: string | null) => (code ? JUR[code] ?? code : '');

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const show = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };
  return { msg, show };
}

function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="tabs" role="tablist" aria-label={label}>
      {options.map(([v, l]) => <button role="tab" type="button" aria-selected={value === v} class={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work queue
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  holder_status: 'Holder status', credential_expiring: 'Credential renewal', credential_lapsed: 'Lapsed credential', screening_hit: 'Screening match',
};
const SEVERITY: [string, string, 'no' | 'warn' | 'muted'][] = [['high', 'High priority', 'no'], ['medium', 'Medium priority', 'warn'], ['low', 'Low priority', 'muted']];

function WorkItem({ item, onDone }: { item: any; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const resolve = async (status: 'done' | 'dismissed') => {
    setBusy(status); setErr(null);
    try {
      await api(`/v1/work-items/${item.id}/resolve`, { body: { status, note: note.trim() || undefined } });
      onDone(status === 'done' ? 'Marked done.' : 'Dismissed. Laissez will not reopen it unless the facts change.');
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <div class="rule">
      <div class="rule-h">
        <h3>{item.link ? <a href={item.link}>{item.title}</a> : item.title}</h3>
        <Chip tone="muted">{KIND_LABEL[item.kind] ?? item.kind}</Chip>
        {item.ticker ? <Chip tone="info">{item.ticker}</Chip> : null}
        {item.due_on ? <Chip tone="warn">Due {day(item.due_on + 'T00:00:00Z')}</Chip> : null}
      </div>
      <p>{item.detail}</p>
      <p class="small muted">
        {item.investor_name ? <>Client: <a href={`#/clients/${item.investor_id}`}>{item.investor_name}</a>. </> : null}
        Opened {when(item.created_at)}.
        {item.status !== 'open' ? <> {item.status === 'done' ? 'Done' : 'Dismissed'} by {item.resolved_by} {item.resolved_at ? when(item.resolved_at) : ''}.</> : null}
      </p>
      {item.status === 'open' ? (
        open ? (
          <div class="row-inline">
            <Field label="Note" hint="Optional. Saved to the audit log."><input value={note} maxLength={1000} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="What you did or why it needs no action" /></Field>
            <PermBtn perm="work:write" kind="primary" busy={busy === 'done'} disabled={!!busy} onClick={() => resolve('done')}>Mark done</PermBtn>
            <PermBtn perm="work:write" kind="ghost" busy={busy === 'dismissed'} disabled={!!busy} onClick={() => resolve('dismissed')}>Dismiss</PermBtn>
            <Btn kind="ghost" onClick={() => setOpen(false)} disabled={!!busy}>Cancel</Btn>
          </div>
        ) : <div class="row-inline tight">{item.link ? <a class="b b-default" href={item.link}>Open</a> : null}<PermBtn perm="work:write" kind="ghost" onClick={() => setOpen(true)}>Resolve</PermBtn></div>
      ) : null}
      <ErrorBox error={err} />
    </div>
  );
}

export function WorkQueue() {
  const [status, setStatus] = useState<'open' | 'done' | 'dismissed' | 'all'>('open');
  const r = useApi(`/v1/work-items?status=${status}`, [status]);
  const toast = useToast();
  const counts = r.data?.open_counts ?? {};
  const items: any[] = r.data?.data ?? [];
  const done = (m: string) => { toast.show(m); r.reload(); };
  return (
    <>
      <Head title="Work queue" sub="Everything monitoring found that needs a person: holders whose standing changed, credentials to renew, lapsed credentials and screening matches. Items close themselves when the condition is gone." />
      <div class="kpis">
        <div class="kpi"><span>High priority</span><b>{counts.high ?? 0}</b><em>Frozen or redemption-only holders, lapsed credentials, matches</em></div>
        <div class="kpi"><span>Medium priority</span><b>{counts.medium ?? 0}</b><em>Credentials expiring within 30 days</em></div>
        <div class="kpi"><span>Low priority</span><b>{counts.low ?? 0}</b><em>Housekeeping</em></div>
      </div>
      <Tabs label="Filter work items" value={status} onChange={setStatus} options={[['open', 'Open'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']]} />
      <PermNote perm="work:write" />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !items.length ? (
        <Card><Empty title={status === 'open' ? 'Nothing needs attention' : 'No items here'}>{status === 'open' ? 'Monitoring runs every night and after each sanctions list update. New items appear here.' : 'Switch the filter to see other items.'}</Empty></Card>
      ) : status === 'open' ? (
        SEVERITY.map(([sev, label, tone]) => {
          const group = items.filter((i) => i.severity === sev);
          return group.length ? <Card title={<>{label} <Chip tone={tone}>{group.length}</Chip></>}>{group.map((i) => <WorkItem key={i.id} item={i} onDone={done} />)}</Card> : null;
        })
      ) : <Card>{items.map((i) => <WorkItem key={i.id} item={i} onDone={done} />)}</Card>}
      <Toast msg={toast.msg} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Screening hits
// ---------------------------------------------------------------------------

const CONTEXT_LABEL: Record<string, string> = { monitoring: 'Found by monitoring', order: 'Found on an order', onboarding: 'Found at onboarding', manual: 'Manual screen' };

function Hit({ hit, onDone }: { hit: any; onDone: (msg: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const decide = async (status: 'false_positive' | 'confirmed') => {
    setBusy(status); setErr(null);
    try {
      await api(`/v1/screening-hits/${hit.id}/decide`, { body: { status, note: note.trim() || undefined } });
      onDone(status === 'confirmed' ? 'Match confirmed. The holder stays frozen; monitoring is updating the work queue.' : 'Marked a false positive. Laissez will not flag this pair again; monitoring is updating standings.');
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const alias = hit.matched_name !== hit.primary_name;
  return (
    <div class="rule">
      <div class="rule-h">
        <h3>{hit.screened_name}</h3>
        <Chip tone={hit.status === 'open' ? 'warn' : hit.status === 'confirmed' ? 'no' : 'ok'}>{hit.status === 'open' ? 'Open' : hit.status === 'confirmed' ? 'Confirmed match' : 'False positive'}</Chip>
        <Chip tone="info">{pct(hit.score)} similar</Chip>
        <Chip tone="muted">{CONTEXT_LABEL[hit.context] ?? hit.context}</Chip>
      </div>
      <div class="tw"><table class="t">
        <thead><tr><th>Screened name</th><th>Matched list entry</th><th>List and programs</th></tr></thead>
        <tbody><tr>
          <td><strong>{hit.screened_name}</strong>{hit.investor_id ? <div class="small"><a href={`#/clients/${hit.investor_id}`}>{hit.investor_name ?? hit.investor_id}</a></div> : null}</td>
          <td><strong>{hit.matched_name}</strong>{alias ? <div class="small muted">Alias of {hit.primary_name}</div> : null}<div class="small muted mono">{hit.source_uid}</div></td>
          <td><Chip tone="muted">{hit.source}</Chip><div class="small">{hit.programs ?? 'No program given'}</div></td>
        </tr></tbody>
      </table></div>
      <p class="small muted">Flagged {when(hit.created_at)}.{hit.decided_at ? <> Decided by {hit.decided_by} {when(hit.decided_at)}.{hit.note ? <> Note: {hit.note}</> : null}</> : null}</p>
      {hit.status === 'open' ? (
        <div class="row-inline">
          <Field label="Note" hint="Optional. Recorded with the decision in the audit log."><input value={note} maxLength={1000} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="Different date of birth and nationality" /></Field>
          <PermBtn perm="compliance:write" busy={busy === 'false_positive'} disabled={!!busy} onClick={() => decide('false_positive')}>False positive</PermBtn>
          <PermBtn perm="compliance:write" kind="danger" busy={busy === 'confirmed'} disabled={!!busy} onClick={() => decide('confirmed')}>Confirm match</PermBtn>
        </div>
      ) : null}
      <ErrorBox error={err} />
    </div>
  );
}

export function ScreeningHits() {
  const [status, setStatus] = useState<'open' | 'false_positive' | 'confirmed' | 'all'>('open');
  const r = useApi(`/v1/screening-hits?status=${status}`, [status]);
  const toast = useToast();
  const counts = r.data?.counts ?? {};
  const rows: any[] = r.data?.data ?? [];
  return (
    <>
      <Head title="Screening hits" sub="Names that matched a sanctions list entry closely enough to hold. A false positive clears the pair for good; a confirmed match keeps the holder frozen." actions={<a class="b b-ghost" href="#/sanctions-lists">Screen a name</a>} />
      <Tabs label="Filter screening hits" value={status} onChange={setStatus}
        options={[['open', `Open (${counts.open ?? 0})`], ['false_positive', `False positives (${counts.false_positive ?? 0})`], ['confirmed', `Confirmed (${counts.confirmed ?? 0})`], ['all', 'All']]} />
      <PermNote perm="compliance:write" />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : rows.length ? (
        <Card>{rows.map((h) => <Hit key={h.id} hit={h} onDone={(m) => { toast.show(m); r.reload(); }} />)}</Card>
      ) : <Card><Empty title={status === 'open' ? 'No open hits' : 'Nothing here yet'}>{status === 'open' ? 'Every match has a decision. New matches from orders and monitoring appear here.' : 'Switch the filter to see other hits.'}</Empty></Card>}
      <Toast msg={toast.msg} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sanctions lists and ad hoc screening
// ---------------------------------------------------------------------------

function sourceStatus(s: any) {
  if (s.status === 'error') return <Chip tone="no" title={s.error ?? undefined}>Last refresh failed</Chip>;
  if (s.status === 'pending') return <Chip tone="muted">Not loaded yet</Chip>;
  if (s.static) return <Chip tone="info">Demo entries</Chip>;
  return s.fresh ? <Chip tone="ok">Current</Chip> : <Chip tone="warn">Stale</Chip>;
}

function ScreenName({ threshold }: { threshold: number }) {
  const [name, setName] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setRes(await api('/v1/screening', { body: { name: name.trim() } })); } catch (x) { setErr(x); setRes(null); } finally { setBusy(false); }
  };
  return (
    <Card title="Screen a name">
      <form class="row-inline" onSubmit={run}>
        <Field label="Full legal name"><input value={name} maxLength={200} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Blocked Example Trading LLC" /></Field>
        <Btn type="submit" kind="primary" busy={busy} disabled={name.trim().length < 2}>Screen</Btn>
      </form>
      <ErrorBox error={err} />
      {res ? (
        <>
          <p class={`verdict-line ${res.result === 'clear' ? 'ok' : 'warn'}`}>
            {res.result === 'potential_match' ? `Potential match. An order for this name would be held for review (score ${pct(threshold)} or higher).`
              : res.result === 'near_miss' ? `Near miss only. Nothing reaches the ${pct(threshold)} hold threshold, so an order would not be held.`
              : `Clear. No list entry is ${pct(res.near_miss_floor)} similar or more.`}
          </p>
          {res.candidates.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>List entry</th><th>List</th><th>Programs</th><th class="r">Similarity</th><th>Outcome</th></tr></thead>
              <tbody>{res.candidates.map((c: any) => (
                <tr>
                  <td><strong>{c.matched_name}</strong>{c.is_alias ? <div class="small muted">Alias of {c.primary_name}</div> : null}<div class="small muted">{[c.entry_type, c.country, c.listed_on ? `listed ${c.listed_on}` : null].filter(Boolean).join(', ')}</div></td>
                  <td><Chip tone="muted">{c.source}</Chip><div class="small muted mono">{c.source_uid}</div></td>
                  <td class="small">{c.programs ?? 'None given'}</td>
                  <td class="r">{pct(c.score)}</td>
                  <td>{c.prior_decision === 'false_positive' ? <Chip tone="ok">Cleared earlier</Chip> : c.would_hold ? <Chip tone="no">Would hold</Chip> : <Chip tone="muted">Near miss</Chip>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

export function SanctionsLists() {
  const r = useApi('/v1/sanctions/sources');
  const m = r.data?.matching;
  const threshold = m?.threshold ?? 0.72;
  const live = (r.data?.data ?? []).filter((s: any) => !s.static);
  return (
    <>
      <Head title="Sanctions lists" sub="The official lists Laissez screens every client and counterparty against. Lists refresh daily; a failed download keeps the last good copy." />
      <div class="note">Matching compares normalized names by trigram similarity, so word order and company suffixes such as Ltd or LLC do not matter. A score of {pct(threshold)} or higher holds the order for review. Scores from {pct(m?.near_miss_floor ?? 0.5)} show here as near misses.</div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          <div class="kpis">
            <div class="kpi"><span>Names screened against</span><b>{Number(r.data.total_entries).toLocaleString('en-US')}</b><em>Primary names and aliases across all lists</em></div>
            <div class="kpi"><span>Lists current</span><b>{live.filter((s: any) => s.fresh).length} of {live.length}</b><em>Refreshed within {m?.stale_after_hours ?? 36} hours</em></div>
            <div class="kpi"><span>Refresh schedule</span><b>Daily</b><em>{m?.refresh ?? 'Daily'}</em></div>
          </div>
          <Card title="Lists" pad={false}>
            <div class="tw"><table class="t">
              <thead><tr><th>List</th><th class="r">Names</th><th>Last loaded</th><th>Published by source</th><th>Status</th></tr></thead>
              <tbody>{r.data.data.map((s: any) => (
                <tr>
                  <td><strong>{s.name}</strong><div class="small muted"><code>{s.source}</code> {s.static ? 'Fictional entries for the demo.' : <a href={s.url} target="_blank" rel="noopener">Official file</a>}</div></td>
                  <td class="r">{Number(s.entries).toLocaleString('en-US')}</td>
                  <td class="nowrap">{s.last_fetched_at ? <>{when(s.last_fetched_at)}<div class="small muted">{s.age_hours < 1 ? 'Under an hour ago' : `${Math.round(s.age_hours)} hours ago`}</div></> : <span class="muted">Never</span>}</td>
                  <td class="small">{s.last_published ? (/^\d{4}-\d{2}-\d{2}/.test(s.last_published) ? day(s.last_published.length === 10 ? `${s.last_published}T00:00:00Z` : s.last_published) : s.last_published) : <span class="muted">Not given</span>}</td>
                  <td>{sourceStatus(s)}{s.status === 'error' && s.error ? <div class="small muted clamp">{s.error}</div> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        </>
      )}
      <ScreenName threshold={threshold} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

const TRIGGER_LABEL: Record<string, string> = {
  nightly: 'Nightly sweep', sanctions_update: 'Sanctions list update', manual: 'Run by hand', screening_decision: 'After a screening decision', test: 'Test',
};

export function Monitoring() {
  const r = useApi('/v1/monitoring');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [last, setLast] = useState<any>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setLast(await api('/v1/monitoring/run', { body: {} })); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const counts = r.data?.counts ?? {};
  const lastRun = r.data?.last_run;
  return (
    <>
      <Head title="Monitoring" sub="Laissez re-checks every existing holder against the current lists, credentials and fund policies: nightly, after each sanctions list update, and whenever you ask."
        actions={<PermBtn perm="compliance:write" kind="primary" busy={busy} onClick={run}>Run monitoring now</PermBtn>} />
      <PermNote perm="compliance:write" />
      <ErrorBox error={err} />
      {last ? <p class="verdict-line ok" role="status">Checked {plural(last.holders_checked, 'holding')}: {plural(last.changes, 'status change')}, {plural(last.items_opened, 'work item')} opened, {last.items_closed} closed. <a href="#/work">Open the work queue</a></p> : null}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          <div class="kpis">
            <div class="kpi"><span>Eligible</span><b>{counts.eligible ?? 0}</b><em>Can subscribe, transfer and redeem</em></div>
            <div class="kpi"><span>Redemption-only</span><b>{counts['redemption-only'] ?? 0}</b><em>Can only redeem</em></div>
            <div class="kpi"><span>Frozen</span><b>{counts.frozen ?? 0}</b><em>No movement until cleared</em></div>
            <div class="kpi"><span>Last run</span><b>{lastRun ? when(lastRun.finished_at ?? lastRun.started_at) : 'Never'}</b><em>{lastRun ? TRIGGER_LABEL[lastRun.trigger] ?? lastRun.trigger : 'Run monitoring to record standings'}</em></div>
          </div>
          <Card title="Holder status" pad={false}>
            {r.data.holders.length ? (
              <div class="tw"><table class="t">
                <thead><tr><th>Client</th><th>Fund</th><th>Status</th><th>Reason</th><th>Since</th></tr></thead>
                <tbody>{r.data.holders.map((h: any) => (
                  <tr>
                    <td><a href={`#/clients/${h.investor_id}`}>{h.investor_name ?? h.investor_id}</a></td>
                    <td><a href={`#/funds/${h.ticker}`}><code>{h.ticker}</code></a><div class="small muted">{h.fund_name}</div></td>
                    <td>{statusChip(h.status)}</td>
                    <td class="small">{h.reason}</td>
                    <td class="small muted nowrap">{when(h.updated_at)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <div style="padding: 0 1.35rem"><Empty title="No standings recorded yet">Run monitoring to record the standing of every holder.</Empty></div>}
          </Card>
          <Card title="Recent runs" pad={false}>
            {r.data.runs.length ? (
              <div class="tw"><table class="t">
                <thead><tr><th>Finished</th><th>Trigger</th><th class="r">Holdings checked</th><th class="r">Status changes</th><th class="r">Items opened</th><th class="r">Time</th></tr></thead>
                <tbody>{r.data.runs.map((x: any) => (
                  <tr>
                    <td class="nowrap">{when(x.finished_at ?? x.started_at)}</td>
                    <td>{TRIGGER_LABEL[x.trigger] ?? x.trigger}</td>
                    <td class="r">{x.holders_checked}</td>
                    <td class="r">{x.changes ? <strong>{x.changes}</strong> : 0}</td>
                    <td class="r">{x.items_opened}</td>
                    <td class="r muted">{x.duration_ms != null ? `${(x.duration_ms / 1000).toFixed(1)} s` : ''}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <div style="padding: 0 1.35rem"><Empty title="No runs yet">The nightly sweep runs at 06:40 UTC.</Empty></div>}
          </Card>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Regulator feed
// ---------------------------------------------------------------------------

function Publication({ p, agent, note, onDrafted }: { p: any; agent: boolean; note: string | null; onDrafted: (msg: string) => void }) {
  const { can, why } = useMe();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const draft = async () => {
    setBusy(true); setErr(null);
    try { const d = await api(`/v1/reg-publications/${p.id}/draft`, { body: {} }); onDrafted(`Draft ${d.id} created. Review it in the change agent.`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const allowed = can('compliance:write');
  const reason = !agent ? note ?? 'The drafting agent is not configured.' : !allowed ? why('compliance:write') : !p.has_excerpt && !p.summary ? 'Laissez has not read this publication yet. Try after the next feed run.' : null;
  return (
    <div class="rule">
      <div class="rule-h">
        <Chip tone="info">{p.regulator}</Chip>
        {p.jurisdiction ? <span class="small muted">{jur(p.jurisdiction)}</span> : null}
        <span class="small muted">{p.published_at ? day(p.published_at) : `Seen ${day(p.fetched_at)}`}</span>
        {p.draft_status === 'approved' ? <Chip tone="ok">Rule change approved</Chip> : p.draft_status === 'draft' ? <Chip tone="warn">Draft waiting for review</Chip> : p.draft_status === 'rejected' ? <Chip tone="muted">Draft rejected</Chip> : null}
      </div>
      <h3 style="margin: 0.45rem 0 0"><a href={p.url} target="_blank" rel="noopener">{p.title}</a></h3>
      {p.summary ? <p class="small clamp" style="max-width: 48rem">{p.summary}</p> : null}
      {p.topics?.length ? <p>{p.topics.map((t: string) => <Chip tone="muted">{t}</Chip>)}</p> : null}
      <div class="row-inline tight">
        {p.draft_status === 'draft' || p.draft_status === 'approved' ? <a class="b b-ghost" href="#/drafts">Open the draft</a>
          : <Btn kind="default" busy={busy} disabled={!!reason} title={reason ?? undefined} onClick={draft}>Draft rule change</Btn>}
        {reason && p.draft_status !== 'draft' && p.draft_status !== 'approved' ? <span class="small muted">{reason}</span> : null}
      </div>
      <ErrorBox error={err} />
    </div>
  );
}

export function RegFeed() {
  const [relevant, setRelevant] = useState<'true' | 'all'>('true');
  const r = useApi(`/v1/reg-publications${relevant === 'true' ? '?relevant=true' : ''}`, [relevant]);
  const f = useApi('/v1/rule-freshness');
  const toast = useToast();
  const g = f.data?.guardrail;
  const c = f.data?.counts;
  return (
    <>
      <Head title="Regulator feed" sub="Publications from MAS, SFC, FCA, FINMA, DFSA, ESMA, the SEC and Japan's FSA, read every six hours. Laissez flags the ones that touch tokenized funds and investor eligibility." />
      {r.data && !r.data.agent_enabled ? <div class="note">{r.data.agent_note}</div> : null}
      {f.data ? (
        <div class="kpis">
          <div class="kpi"><span>Rule-pack update lag</span><b>{g.met ? 'On target' : plural(c.overdue, 'overdue')}</b><em>Target: an approved rule change within {g.max_business_days} business days</em></div>
          <div class="kpi"><span>Relevant, last {g.window_days} days</span><b>{c.relevant}</b><em>{c.approved} approved, {c.drafted_not_approved} in review</em></div>
          <div class="kpi"><span>Inside the window</span><b>{c.within_window}</b><em>Published within {g.max_business_days} business days</em></div>
        </div>
      ) : f.error ? <ErrorBox error={f.error} /> : null}
      {f.data?.data?.length ? (
        <Card title="Past the 5-business-day target">
          <ul class="plain">{f.data.data.slice(0, 8).map((x: any) => (
            <li><Chip tone="no">{x.business_days} business days</Chip> <strong>{x.regulator}</strong> <a href={x.url} target="_blank" rel="noopener">{x.title}</a>{x.draft_status ? <span class="small muted"> Draft {x.draft_status}.</span> : null}</li>
          ))}</ul>
          {f.data.data.length > 8 ? <p class="small muted">And {f.data.data.length - 8} more.</p> : null}
        </Card>
      ) : null}
      <Tabs label="Filter publications" value={relevant} onChange={setRelevant} options={[['true', 'Relevant'], ['all', 'All publications']]} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.data.data.length ? (
        <Card>
          {r.data.data.map((p: any) => <Publication key={p.id} p={p} agent={!!r.data.agent_enabled} note={r.data.agent_note} onDrafted={(m) => { toast.show(m); r.reload(); f.reload(); }} />)}
          <p class="small muted">{r.data.newest_fetched_at ? `Newest item seen ${when(r.data.newest_fetched_at)}. ` : ''}{plural(r.data.total ?? 0, 'publication')} on file, {r.data.relevant ?? 0} relevant.</p>
        </Card>
      ) : <Card><Empty title="No publications yet">The feed job runs every six hours. Publications appear here after its first run.</Empty></Card>}
      <Toast msg={toast.msg} />
    </>
  );
}
