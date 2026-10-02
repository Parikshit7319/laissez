/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { api, API_BASE, authHeaders, when, JUR } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, Json, Hash, TxLink } from '../ui';
import { PermBtn, PermNote } from '../auth';
import { usePaged, LoadMore } from '../paged';

export function RuleLibrary() {
  const packs = useApi('/v1/rule-packs');
  const classes = useApi('/v1/investor-classes');
  const centers = useApi('/v1/booking-centers');
  const [open, setOpen] = useState<string | null>('SG');
  if ((packs.loading && !packs.data) || (classes.loading && !classes.data)) return <Loading />;
  if (packs.error || classes.error) return <ErrorBox error={packs.error ?? classes.error} />;
  const byJur: Record<string, any[]> = {};
  for (const c of classes.data.data) (byJur[c.jurisdiction] ??= []).push(c);
  return (
    <>
      <Head title="Rule library" sub="The rules the resolver applies, with thresholds, citations and versions. Proposals stay as drafts until they become law." />
      <div class="grid2">
        <Card title="Rule packs" pad={false}>
          <div class="tw"><table class="t"><thead><tr><th>Pack</th><th>Version</th><th>Status</th><th>Effective</th></tr></thead>
            <tbody>{packs.data.data.map((p: any) => <tr><td><strong>{p.id}</strong><div class="small muted">{p.summary}</div></td><td><code>{p.version}</code></td><td>{p.status === 'active' ? <Chip tone="ok">Active</Chip> : p.status === 'draft' ? <Chip tone="warn">Draft</Chip> : <Chip>Retired</Chip>}<div class="small muted">{p.approved_by ?? 'not approved'}</div></td><td class="muted">{p.effective_from ?? 'Not in force'}</td></tr>)}</tbody></table></div>
        </Card>
        <Card title="Booking-center licences" pad={false}>
          {centers.data ? <div class="tw"><table class="t"><thead><tr><th>Center</th><th>Rule</th></tr></thead><tbody>{centers.data.data.map((b: any) => <tr><td><strong>{b.name}</strong><div class="small muted">{b.licence}</div></td><td class="small">{b.rule_text} <em class="muted">{b.rule_ref}</em></td></tr>)}</tbody></table></div> : <Loading />}
        </Card>
      </div>
      <Card title="Investor classes and thresholds">
        <div class="tabs" role="tablist">{Object.keys(byJur).map((j) => <button role="tab" aria-selected={open === j} class={open === j ? 'on' : ''} onClick={() => setOpen(j)}>{JUR[j] ?? j}</button>)}</div>
        {open && byJur[open] ? byJur[open].map((c) => (
          <div class="rule">
            <div class="rule-h"><h3>{c.label}</h3><code>{c.code}</code>{c.requires_opt_in ? <Chip tone="info">Opt-in required</Chip> : null}</div>
            <p>{c.threshold}</p>
            <p class="small muted">Source: {c.rule_ref}. <a href={`../sources/#${c.source_id}`} target="_blank" rel="noopener">See citation</a></p>
          </div>
        )) : null}
      </Card>
    </>
  );
}

export function Screening() {
  const list = useApi('/v1/screening-list');
  const [name, setName] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const run = async (e: Event) => { e.preventDefault(); setErr(null); try { setRes(await api('/v1/screening', { body: { name } })); } catch (x) { setErr(x); } };
  return (
    <>
      <Head title="Sanctions screening" sub="Every order screens the investor's name and residence. Comprehensive country programs freeze units in place." />
      <div class="grid2">
        <Card title="Screen a name">
          <form class="row-inline" onSubmit={run}><Field label="Name"><input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Blocked Example Trading LLC" /></Field><Btn type="submit" kind="primary" disabled={name.length < 2}>Screen</Btn></form>
          <ErrorBox error={err} />
          {res ? <p class={`verdict-line ${res.match ? 'warn' : 'ok'}`}>{res.match ? `Potential match: ${res.match.entry} (${res.match.program}). An order for this name would freeze.` : 'Clear. No match on the screening list.'}</p> : null}
          <p class="muted small">The sandbox screens against a fictional sample list, not the live OFAC, UN or EU lists. Country blocks use the real comprehensive OFAC programs: Cuba, Iran, North Korea and occupied regions of Ukraine.</p>
        </Card>
        <Card title="Sample screening list">
          {list.data ? <ul class="plain">{list.data.data.map((s: any) => <li><strong>{s.name}</strong><span class="muted small"> {s.note}</span></li>)}</ul> : <Loading />}
        </Card>
      </div>
    </>
  );
}

export function RuleDrafts() {
  const r = useApi('/v1/rule-drafts');
  const [f, setF] = useState({ source_text: '', source_url: '', jurisdiction: 'GB' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const submit = async (e: Event) => { e.preventDefault(); setBusy('new'); setErr(null); try { await api('/v1/rule-drafts', { body: { ...f, source_url: f.source_url || undefined } }); r.reload(); } catch (x) { setErr(x); } finally { setBusy(null); } };
  const decide = async (id: string, d: 'approve' | 'reject', force = false) => { setBusy(id + d); setErr(null); try { await api(`/v1/rule-drafts/${id}/${d}`, { body: force ? { force: true } : {} }); r.reload(); } catch (x) { setErr(x); } finally { setBusy(null); } };
  const [reg, setReg] = useState<Record<string, any>>({});
  const runRegression = async (id: string) => { setBusy(id + 'reg'); setErr(null); try { const x = await api(`/v1/rule-drafts/${id}/regression`, { body: {} }); setReg((m) => ({ ...m, [id]: x })); } catch (x) { setErr(x); } finally { setBusy(null); } };
  const regressionCell = (d: any) => {
    const x = reg[d.id] ?? (d.regression ? { regression: d.regression, warnings: d.warnings ?? [] } : null);
    if (!x) return <span class="small muted">Not run</span>;
    const g = x.regression;
    return <>{g.failed ? <Chip tone="no">{g.failed} of {g.total} fail</Chip> : <Chip tone="ok">{g.passed} of {g.total} pass</Chip>}<div class="small muted">{g.pack}</div></>;
  };
  const enabled = r.data?.agent_enabled;
  return (
    <>
      <Head title="Regulatory change agent" sub="Paste a regulator publication. The agent drafts a rule-pack change with citations. A reviewer approves or rejects it; nothing goes live on its own." />
      {r.data && !enabled ? <div class="note">The drafting agent is built but switched off here until an Anthropic API key is connected. Drafting stays available as an API call once it is.</div> : null}
      <PermNote perm="compliance:write" />
      <Card title="New draft">
        <form class="form-grid" onSubmit={submit}>
          <Field label="Jurisdiction"><select value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: (e.target as HTMLSelectElement).value })}>{['GB', 'SG', 'HK', 'CH', 'DE', 'LU', 'IE', 'AE-DIFC', 'AE-ADGM', 'JP', 'IN', 'AU', 'CA', 'BR', 'KR', 'US'].map((j) => <option value={j}>{JUR[j]}</option>)}</select></Field>
          <Field label="Source link" hint="Optional"><input value={f.source_url} onInput={(e) => setF({ ...f, source_url: (e.target as HTMLInputElement).value })} placeholder="https://www.fca.org.uk/publication/consultation/cp25-36.pdf" /></Field>
          <div class="span2"><Field label="Regulator text"><textarea rows={6} value={f.source_text} onInput={(e) => setF({ ...f, source_text: (e.target as HTMLTextAreaElement).value })} placeholder="Paste the relevant section, at least a paragraph." /></Field></div>
          <div class="form-actions"><PermBtn perm="compliance:write" type="submit" kind="primary" busy={busy === 'new'} disabled={f.source_text.length < 40 || !enabled}>{busy === 'new' ? 'Drafting' : 'Draft rule change'}</PermBtn></div>
        </form>
        <ErrorBox error={err} />
      </Card>
      <Card title="Drafts">
        {r.loading && !r.data ? <Loading /> : (r.data?.data ?? []).length ? r.data.data.map((d: any) => (
          <div class="rule">
            <div class="rule-h"><h3>{d.draft.summary ?? d.id}</h3>{d.status === 'draft' ? <Chip tone="warn">Draft</Chip> : d.status === 'approved' ? <Chip tone="ok">Approved by {d.reviewer}</Chip> : <Chip tone="no">Rejected by {d.reviewer}</Chip>}{d.draft.source_status ? <Chip tone="info">Source: {d.draft.source_status}</Chip> : null}</div>
            <Json value={d.draft.changes ?? d.draft} />
            <div class="tw"><table class="t" style={{ marginBottom: '0.5rem' }}>
              <thead><tr><th>Jurisdiction</th><th>Regression</th><th>Warnings</th></tr></thead>
              <tbody><tr>
                <td>{d.jurisdiction ? JUR[d.jurisdiction] ?? d.jurisdiction : <span class="muted">Not set</span>}</td>
                <td>{regressionCell(d)}{(reg[d.id]?.regression ?? d.regression)?.cases?.some((c: any) => !c.ok) ? <ul class="plain small" style={{ marginTop: '0.3rem' }}>{(reg[d.id]?.regression ?? d.regression).cases.filter((c: any) => !c.ok).map((c: any) => <li><strong>{c.id}</strong> {c.message}</li>)}</ul> : null}</td>
                <td class="small">{(reg[d.id]?.warnings ?? d.warnings ?? []).length ? <ul class="plain">{(reg[d.id]?.warnings ?? d.warnings).map((w: string) => <li><Chip tone="warn">Check</Chip> {w}</li>)}</ul> : <span class="muted">None</span>}</td>
              </tr></tbody>
            </table></div>
            {d.status === 'draft' ? <div class="row-inline"><PermBtn perm="compliance:write" kind="primary" busy={busy === d.id + 'approve'} onClick={() => decide(d.id, 'approve', !!(reg[d.id]?.regression ?? d.regression)?.failed)}>{(reg[d.id]?.regression ?? d.regression)?.failed ? 'Approve despite failures' : 'Approve draft'}</PermBtn><PermBtn perm="compliance:write" kind="ghost" busy={busy === d.id + 'reject'} onClick={() => decide(d.id, 'reject')}>Reject draft</PermBtn><Btn kind="ghost" busy={busy === d.id + 'reg'} onClick={() => runRegression(d.id)}>Run regression</Btn><span class="small muted">Approval runs the golden cases for the jurisdiction; your name is recorded as the reviewer.</span></div> : null}
          </div>
        )) : <Empty title="No drafts yet" />}
      </Card>
    </>
  );
}

export function AuditLog() {
  const [type, setType] = useState('');
  const r = usePaged(`/v1/audit-events?limit=100${type ? `&type=${type}` : ''}`, [type]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`${API_BASE}/v1/audit-events.csv`, { headers: authHeaders() });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error?.message ?? `Export failed (${res.status}). Try again.`); }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'laissez-audit-log.csv'; a.click(); URL.revokeObjectURL(url);
    } catch (e: any) { setErr(e instanceof TypeError ? new Error('Could not reach the Laissez API. Check your connection and try again.') : e); } finally { setBusy(false); }
  };
  return (
    <>
      <Head title="Audit log" sub="A permanent, hash-chained record of every action. Each event includes the hash of the one before it, so a change anywhere breaks every hash after it." actions={<PermBtn perm="audit:export" busy={busy} onClick={exportCsv}>Export CSV</PermBtn>} />
      <VerifyChain />
      <div class="toolbar"><select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)} aria-label="Filter by event type"><option value="">All events</option>{['decision', 'settlement', 'credential', 'policy', 'investor', 'fund', 'member', 'session', 'sso', 'organization', 'webhook', 'api_key', 'screening', 'rule_draft', 'eligibility'].map((t) => <option value={t}>{t}</option>)}</select></div>
      <ErrorBox error={err} />
      {r.loading && !r.rows.length ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <div class="tw"><table class="t">
          <thead><tr><th class="r">Seq</th><th>When</th><th>Event</th><th>Actor</th><th>Subject</th><th>Details</th><th>Hash</th></tr></thead>
          <tbody>{r.rows.map((e: any) => (
            <tr>
              <td class="r mono small">{e.seq ?? ''}</td>
              <td class="muted nowrap">{when(e.created_at)}</td>
              <td><code>{e.type}</code></td>
              <td class="small">{e.actor_name ?? 'Laissez'}{e.actor && /^key:/.test(e.actor) ? <div class="muted">API key</div> : null}</td>
              <td><code>{e.subject}</code></td>
              <td class="small mono clamp">{JSON.stringify(e.data)}</td>
              <td><Hash value={e.hash} n={8} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {!r.error ? <LoadMore p={r} what="events" /> : null}
    </>
  );
}

/** Recomputes the audit hash chain on the server and shows whether it is intact. */
function VerifyChain() {
  const [v, setV] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setErr(null); try { setV(await api('/v1/audit-events/verify')); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const intact = v ? !!(v.valid ?? v.intact) : null;
  const anchor = v?.latest_anchor ?? null;
  const brk = v ? (v.first_break_seq ?? v.first_break ?? null) : null;
  return (
    <Card class="verify" title="Verify the chain" actions={<Btn kind={v ? 'ghost' : 'primary'} busy={busy} onClick={run}>{v ? 'Verify again' : 'Verify chain'}</Btn>}>
      {!v && !err ? <p class="muted small">Laissez recomputes every event's hash from its contents and the previous hash, checks that each event links to the one before it, and compares the result with the latest anchor written on-chain.</p> : null}
      <ErrorBox error={err} />
      {v ? (
        <div class="verify-grid">
          <div class={`verify-stamp ${intact ? 'ok' : 'bad'}`}>
            <b>{intact ? 'Intact' : 'Broken'}</b>
            <span>{v.message ?? (intact ? 'Every hash matches.' : 'At least one event was changed after it was written.')}</span>
          </div>
          <dl class="kv wide">
            <div><dt>Events checked</dt><dd>{Number(v.events ?? 0).toLocaleString('en-US')}{v.head_seq ? <span class="muted small"> (1 to {v.head_seq})</span> : null}</dd></div>
            <div><dt>Head hash</dt><dd><Hash value={v.head_hash} n={20} /></dd></div>
            {brk !== null && brk !== undefined ? <div><dt>First break</dt><dd>Event {typeof brk === 'object' ? brk.seq : brk}{v.bad_hashes ? <span class="muted small">. {v.bad_hashes} altered hash{v.bad_hashes === 1 ? '' : 'es'}</span> : null}{v.broken_links ? <span class="muted small">. {v.broken_links} broken link{v.broken_links === 1 ? '' : 's'}</span> : null}</dd></div> : null}
            {anchor ? (
              <div><dt>Latest anchor</dt><dd>
                {anchor.anchor_date ? new Date(anchor.anchor_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Anchored'}, covering events up to {anchor.seq}
                {anchor.merkle_root ? <div class="small muted">Merkle root <Hash value={anchor.merkle_root} n={14} /></div> : null}
                {anchor.tx_hash ? <div><TxLink hash={anchor.tx_hash} />{anchor.block ? <span class="small muted"> block {Number(anchor.block).toLocaleString('en-US')}</span> : null}</div> : <div class="small muted">{anchor.status === 'pending' ? 'Waiting to be written on-chain.' : 'Not on-chain yet.'}</div>}
                {anchor.matches_log === true ? <div class="small ok-text">The anchored head still matches the log.</div> : anchor.matches_log === false ? <div class="small" style={{ color: '#a3302a' }}>The anchored head no longer matches the log.</div> : null}
              </dd></div>
            ) : <div><dt>Latest anchor</dt><dd class="muted">None yet. Laissez anchors every organization's chain head once a day.</dd></div>}
          </dl>
        </div>
      ) : null}
    </Card>
  );
}

export function ReceiptChecker() {
  const [receipt, setReceipt] = useState('');
  const [sig, setSig] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const run = async (e: Event) => {
    e.preventDefault(); setErr(null); setRes(null);
    let parsed: any;
    try { parsed = JSON.parse(receipt); } catch { setErr(new Error('The receipt is not valid JSON. Paste the full receipt object.')); return; }
    try { setRes(await api('/v1/receipts/verify', { body: { receipt: parsed, signature: sig.trim() }, auth: false })); } catch (x) { setErr(x); }
  };
  return (
    <>
      <Head title="Receipt checker" sub="Paste a decision receipt and its signature. Laissez checks the Ed25519 signature against its public key, so any edit to the receipt shows up." />
      <Card>
        <form class="form-grid" onSubmit={run}>
          <div class="span2"><Field label="Receipt (JSON)"><textarea rows={10} value={receipt} onInput={(e) => setReceipt((e.target as HTMLTextAreaElement).value)} placeholder='{"decision_id": "dec_...", ...}' /></Field></div>
          <div class="span2"><Field label="Signature"><input value={sig} onInput={(e) => setSig((e.target as HTMLInputElement).value)} placeholder="Base64url signature from the decision page" /></Field></div>
          <div class="form-actions"><Btn type="submit" kind="primary">Verify</Btn></div>
        </form>
        <ErrorBox error={err} />
        {res ? <p class={`verdict-line ${res.valid ? 'ok' : 'warn'}`}>{res.message}</p> : null}
        <p class="muted small">Try it: open any decision, copy its receipt and signature here, then change one character in the receipt and verify again.</p>
      </Card>
    </>
  );
}
