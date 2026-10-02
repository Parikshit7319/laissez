/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { api, API_BASE, getKey, when, JUR } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, Json } from '../ui';

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
  const [busy, setBusy] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const submit = async (e: Event) => { e.preventDefault(); setBusy(true); setErr(null); try { await api('/v1/rule-drafts', { body: { ...f, source_url: f.source_url || undefined } }); r.reload(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const decide = async (id: string, d: 'approve' | 'reject') => { try { await api(`/v1/rule-drafts/${id}/${d}`, { body: { reviewer } }); r.reload(); } catch (x) { setErr(x); } };
  const enabled = r.data?.agent_enabled;
  return (
    <>
      <Head title="Regulatory change agent" sub="Paste a regulator publication. The agent drafts a rule-pack change with citations. A reviewer approves or rejects it; nothing goes live on its own." />
      {r.data && !enabled ? <div class="note">The drafting agent is built but switched off in this sandbox until an Anthropic API key is connected. Drafting stays available as an API call once it is.</div> : null}
      <Card title="New draft">
        <form class="form-grid" onSubmit={submit}>
          <Field label="Jurisdiction"><select value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: (e.target as HTMLSelectElement).value })}>{['GB', 'SG', 'HK', 'CH', 'DE', 'AE-DIFC', 'US'].map((j) => <option value={j}>{JUR[j]}</option>)}</select></Field>
          <Field label="Source link" hint="Optional"><input value={f.source_url} onInput={(e) => setF({ ...f, source_url: (e.target as HTMLInputElement).value })} placeholder="https://www.fca.org.uk/publication/consultation/cp25-36.pdf" /></Field>
          <div class="span2"><Field label="Regulator text"><textarea rows={6} value={f.source_text} onInput={(e) => setF({ ...f, source_text: (e.target as HTMLTextAreaElement).value })} placeholder="Paste the relevant section, at least a paragraph." /></Field></div>
          <div class="form-actions"><Btn type="submit" kind="primary" disabled={busy || f.source_text.length < 40 || !enabled}>{busy ? 'Drafting' : 'Draft rule change'}</Btn></div>
        </form>
        <ErrorBox error={err} />
      </Card>
      <Card title="Drafts" actions={<input class="sm" placeholder="Reviewer name" value={reviewer} onInput={(e) => setReviewer((e.target as HTMLInputElement).value)} aria-label="Reviewer name" />}>
        {r.loading && !r.data ? <Loading /> : (r.data?.data ?? []).length ? r.data.data.map((d: any) => (
          <div class="rule">
            <div class="rule-h"><h3>{d.draft.summary ?? d.id}</h3>{d.status === 'draft' ? <Chip tone="warn">Draft</Chip> : d.status === 'approved' ? <Chip tone="ok">Approved by {d.reviewer}</Chip> : <Chip tone="no">Rejected by {d.reviewer}</Chip>}{d.draft.source_status ? <Chip tone="info">Source: {d.draft.source_status}</Chip> : null}</div>
            <Json value={d.draft.changes ?? d.draft} />
            {d.status === 'draft' ? <div class="row-inline"><Btn kind="primary" disabled={reviewer.length < 2} onClick={() => decide(d.id, 'approve')}>Approve</Btn><Btn kind="ghost" disabled={reviewer.length < 2} onClick={() => decide(d.id, 'reject')}>Reject</Btn></div> : null}
          </div>
        )) : <Empty title="No drafts yet" />}
      </Card>
    </>
  );
}

export function AuditLog() {
  const [type, setType] = useState('');
  const r = useApi(`/v1/audit-events${type ? `?type=${type}` : ''}`, [type]);
  const [err, setErr] = useState<any>(null);
  const exportCsv = async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/audit-events.csv`, { headers: { authorization: `Bearer ${getKey()}` } });
      if (!res.ok) throw new Error('Export failed. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'laissez-audit-log.csv'; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setErr(e); }
  };
  return (
    <>
      <Head title="Audit log" sub="A permanent record of every action in this sandbox." actions={<Btn onClick={exportCsv}>Export CSV</Btn>} />
      <div class="toolbar"><select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)} aria-label="Filter by event type"><option value="">All events</option>{['decision', 'settlement', 'credential', 'policy', 'investor', 'fund', 'webhook', 'api_key', 'screening', 'rule_draft', 'eligibility'].map((t) => <option value={t}>{t}</option>)}</select></div>
      <ErrorBox error={err} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : (
        <div class="tw"><table class="t"><thead><tr><th>When</th><th>Event</th><th>Subject</th><th>Details</th></tr></thead>
          <tbody>{r.data.data.map((e: any) => <tr><td class="muted nowrap">{when(e.created_at)}</td><td><code>{e.type}</code></td><td><code>{e.subject}</code></td><td class="small mono clamp">{JSON.stringify(e.data)}</td></tr>)}</tbody></table></div>
      )}
    </>
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
