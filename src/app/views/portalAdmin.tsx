/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { api, money, when, day, JUR } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Card, Copy, Hash, outcomeChip } from '../ui';

const reqChip = (s: string) => s === 'submitted' ? <Chip tone="info">Waiting for review</Chip> : s === 'approved' ? <Chip tone="ok">Approved</Chip> : <Chip tone="no">Rejected</Chip>;
const evChip = (s: string) => s === 'submitted' ? <Chip tone="info">Waiting for review</Chip> : s === 'accepted' ? <Chip tone="ok">Accepted</Chip> : <Chip tone="no">Rejected</Chip>;

function Tabs({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <div class="tabs" role="tablist">{options.map(([v, l]) => <button type="button" role="tab" aria-selected={value === v} class={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

// ---------- Invite button for the client detail page ----------
export function PortalInvite({ investorId, investorName }: { investorId: string; investorName?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const create = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api(`/v1/investors/${investorId}/portal-invite`, { body: {} })); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div class="portal-invite">
      {!res ? <Btn onClick={create} busy={busy} title={`Create a private investor portal link${investorName ? ` for ${investorName}` : ''}`}>Invite to investor portal</Btn> : (
        <div class="reveal" role="status">
          <span class="f-l">Investor portal link{investorName ? ` for ${investorName}` : ''}</span>
          <div class="reveal-row"><code class="break">{res.link}</code><Copy text={res.link} /></div>
          <p class="small muted">{res.note} Expires {day(res.expires_at)}.</p>
          <div class="row-inline tight">
            <a class="b b-default" href={res.link} target="_blank" rel="noopener">Open the portal <span aria-hidden="true">↗</span></a>
            <Btn kind="ghost" onClick={() => setRes(null)}>Done</Btn>
          </div>
        </div>
      )}
      <ErrorBox error={err} />
    </div>
  );
}

// ---------- Subscription requests signed in the portal ----------
function SignatureDetails({ r }: { r: any }) {
  const s = r.signature ?? {};
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try { setCheck(await api('/v1/receipts/verify', { body: { receipt: s.payload, signature: s.laissez_signature }, auth: false })); }
    catch (x: any) { setCheck({ valid: false, message: x.message }); } finally { setBusy(false); }
  };
  return (
    <div class="small" style={{ display: 'grid', gap: '0.6rem', padding: '0.4rem 0 0.2rem' }}>
      <dl class="kv">
        <div><dt>Signed by</dt><dd>{s.signed_name} <span class="muted">(typed name)</span></dd></div>
        <div><dt>Signed at</dt><dd>{s.signed_at ? new Date(s.signed_at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Unknown'}</dd></div>
        <div><dt>Statement</dt><dd>{s.payload?.statement ?? 'I have read the documents and request this subscription.'}</dd></div>
        <div><dt>Payload hash</dt><dd><Hash value={s.payload_sha256} n={16} /> <span class="muted">SHA-256 of the canonical request</span></dd></div>
        <div><dt>Laissez seal</dt><dd>{s.laissez_signature ? <><Hash value={s.laissez_signature} n={16} /> <span class="muted">Ed25519</span></> : <span class="muted">Not sealed (signing key not configured)</span>}</dd></div>
      </dl>
      {s.document_hashes?.length ? (
        <div><span class="f-l">Documents acknowledged before signing</span>
          <ul class="plain" style={{ marginTop: '0.35rem', gap: '0.25rem' }}>{s.document_hashes.map((d: any) => <li>{d.title} v{d.version} <Hash value={d.sha256} n={12} /></li>)}</ul>
        </div>
      ) : <p class="muted" style={{ margin: 0 }}>No fund document required an acknowledgment.</p>}
      {s.laissez_signature && s.payload ? (
        <div class="row-inline tight">
          <Btn kind="ghost" onClick={verify} busy={busy}>Verify the seal</Btn>
          {check ? <span class={check.valid ? 'ok-text' : 'muted'}>{check.message}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function RequestRow({ r, onChange }: { r: any; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<any>(null);
  const approve = async () => {
    setBusy('approve'); setErr(null);
    try { const x = await api(`/v1/portal-requests/${r.id}/approve`, { body: {} }); setResult(x); onChange(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const reject = async (e: Event) => {
    e.preventDefault(); setBusy('reject'); setErr(null);
    try { await api(`/v1/portal-requests/${r.id}/reject`, { body: { note } }); setRejecting(false); onChange(); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const decisionId = result?.decision?.id ?? r.decision_id;
  const outcome = result?.decision?.outcome ?? r.outcome;
  return (
    <section class="card" style={{ marginBottom: '0.9rem' }}>
      <div class="card-h" style={{ marginBottom: '0.4rem' }}>
        <div>
          <h2>{r.investor_name} <span class="muted" style={{ fontWeight: 450 }}>subscribes to {r.fund_name ?? r.ticker}</span></h2>
          <p class="small muted" style={{ margin: '0.2rem 0 0' }}>{money(r.amount, r.currency)} in {r.asset}. Signed in the investor portal {when(r.created_at)}. {JUR[r.residence] ?? r.residence} resident.</p>
        </div>
        <div class="row-inline tight">{reqChip(r.status)}{outcome ? outcomeChip(outcome) : null}</div>
      </div>
      {r.note ? <p class="small" style={{ margin: '0.3rem 0' }}>{r.note}{r.decided_by ? <span class="muted"> ({r.decided_by})</span> : null}</p> : null}
      {decisionId ? <p class="small" style={{ margin: '0.3rem 0' }}>Decision <a href={`#/decisions/${decisionId}`}><code>{decisionId}</code></a>{result?.decision?.headline ? `: ${result.decision.headline}` : r.headline ? `: ${r.headline}` : ''}</p> : null}
      <div class="row-inline tight" style={{ marginTop: '0.5rem' }}>
        {r.status === 'submitted' && !result ? (
          <>
            <Btn kind="primary" onClick={approve} busy={busy === 'approve'} disabled={!!busy}>Approve and run pre-trade check</Btn>
            {!rejecting ? <Btn kind="ghost" onClick={() => setRejecting(true)} disabled={!!busy}>Reject</Btn> : null}
          </>
        ) : null}
        <Btn kind="ghost" onClick={() => setOpen(!open)}>{open ? 'Hide signature' : 'Signature details'}</Btn>
      </div>
      {rejecting ? (
        <form class="row-inline" onSubmit={reject}>
          <input class="grow" required minLength={3} maxLength={500} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="Tell the client why, in a sentence" aria-label="Reason shown to the client" />
          <Btn type="submit" kind="danger" busy={busy === 'reject'}>Reject request</Btn>
          <Btn kind="ghost" onClick={() => setRejecting(false)}>Cancel</Btn>
        </form>
      ) : null}
      {result ? <p class={`verdict-line ${result.decision.outcome === 'ALLOW' ? 'ok' : 'warn'}`}>{result.request.note} <a href={`#/decisions/${result.decision.id}`}>Open the decision</a>{result.decision.outcome === 'ALLOW' ? ' to settle it.' : '.'}</p> : null}
      <ErrorBox error={err} />
      {open ? <SignatureDetails r={r} /> : null}
    </section>
  );
}

export function PortalRequests() {
  const [status, setStatus] = useState('submitted');
  const r = useApi(`/v1/portal-requests${status ? `?status=${status}` : ''}`, [status]);
  const rows: any[] = r.data?.data ?? [];
  return (
    <>
      <Head title="Portal requests" sub="Subscriptions your clients signed in the investor portal. Approving runs the same pre-trade check as an order you place yourself, and records the decision." />
      <Tabs value={status} onChange={setStatus} options={[['submitted', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']]} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? (
        <Empty title={status === 'submitted' ? 'Nothing waiting for review' : 'No requests here'}>Invite a client to the investor portal from their client page. Requests they sign appear here.</Empty>
      ) : rows.map((x) => <RequestRow key={x.id} r={x} onChange={r.reload} />)}
    </>
  );
}

// ---------- Evidence submitted for a classification ----------
function EvidenceRow({ e, onChange }: { e: any; onChange: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const review = async (status: 'accepted' | 'rejected') => {
    setBusy(status); setErr(null);
    try { setDone(await api(`/v1/evidence/${e.id}/review`, { body: { status, note: note || undefined } })); onChange(); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const [months, setMonths] = useState(12);
  const acceptAndIssue = async () => {
    setBusy('issue'); setErr(null);
    try { setDone({ ...(await api(`/v1/evidence/${e.id}/accept-and-issue`, { body: { valid_months: months, note: note || undefined } })), status: 'accepted', issued: true }); onChange(); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const fieldLabel = (k: string) => e.fields?.find((f: any) => f.key === k);
  const fmt = (k: string, v: unknown) => {
    const f = fieldLabel(k);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return `${f?.unit ?? ''}${v.toLocaleString('en-US')}`;
    return String(v);
  };
  return (
    <section class="card" style={{ marginBottom: '0.9rem' }}>
      <div class="card-h" style={{ marginBottom: '0.4rem' }}>
        <div>
          <h2>{e.investor_name} <span class="muted" style={{ fontWeight: 450 }}>for {e.label} ({JUR[e.jurisdiction] ?? e.jurisdiction})</span></h2>
          <p class="small muted" style={{ margin: '0.2rem 0 0' }}>Submitted in the investor portal {when(e.created_at)}{e.reference ? `. Reference: ${e.reference}` : ''}.</p>
        </div>
        <div class="row-inline tight">{evChip(done?.status ?? e.status)}{e.precheck ? <Chip tone={e.precheck.pass ? 'ok' : 'warn'}>{e.precheck.pass ? 'Meets the threshold' : 'Below the threshold'}</Chip> : null}</div>
      </div>
      <div class="grid2" style={{ gap: '1rem' }}>
        <dl class="kv small">{Object.entries(e.evidence ?? {}).map(([k, v]) => <div><dt>{fieldLabel(k)?.label ?? k.replace(/_/g, ' ')}</dt><dd>{fmt(k, v)}</dd></div>)}</dl>
        <div class="small">
          {e.precheck ? <p style={{ margin: '0 0 0.4rem' }}><strong>Threshold test:</strong> {e.precheck.reason}</p> : null}
          {e.threshold ? <p class="muted" style={{ margin: 0 }}>{e.threshold}</p> : null}
        </div>
      </div>
      {e.status === 'submitted' && !done ? (
        <div class="row-inline" style={{ marginTop: '0.7rem' }}>
          <input class="grow" maxLength={500} value={note} onInput={(x) => setNote((x.target as HTMLInputElement).value)} placeholder="Note for the record (optional)" aria-label="Review note" />
          <Btn kind="primary" onClick={() => review('accepted')} busy={busy === 'accepted'} disabled={!!busy}>Accept</Btn>
          <Btn kind="danger" onClick={() => review('rejected')} busy={busy === 'rejected'} disabled={!!busy}>Reject</Btn>
          <span class="row-inline tight" style={{ marginLeft: 'auto' }}>
            <select value={months} onChange={(x) => setMonths(Number((x.target as HTMLSelectElement).value))} aria-label="Credential validity" disabled={!!busy}>{[6, 12, 18, 24].map((m) => <option value={m}>{m} months</option>)}</select>
            <Btn kind="default" onClick={acceptAndIssue} busy={busy === 'issue'} disabled={!!busy || e.precheck?.pass === false} title={e.precheck?.pass === false ? 'The figures do not meet the threshold.' : `Accept and issue a credential with ${e.label} for ${months} months`}>Accept and issue credential</Btn>
          </span>
        </div>
      ) : e.review_note ? <p class="small muted" style={{ marginTop: '0.5rem' }}>Note: {e.review_note}{e.reviewed_by ? ` (${e.reviewed_by})` : ''}</p> : null}
      {done?.issued ? <p class="verdict-line ok">Accepted and issued credential <a href={`#/clients/${e.investor_id}`}><code>{done.credential_id}</code></a>, valid to {done.expires_on}{done.carried_classes?.length ? `, keeping ${done.carried_classes.join(', ')}` : ''}.</p>
        : done?.next ? <p class="verdict-line ok">Accepted. Figures alone do not change eligibility: <a href={`#${done.next.path}`}>{done.next.label}</a>.</p> : null}
      <ErrorBox error={err} />
    </section>
  );
}

export function EvidenceReview() {
  const [status, setStatus] = useState('submitted');
  const r = useApi(`/v1/evidence${status ? `?status=${status}` : ''}`, [status]);
  const rows: any[] = r.data?.data ?? [];
  return (
    <>
      <Head title="Evidence review" sub="Figures clients submitted in the investor portal to support a classification. Check them against the source documents, then issue an updated credential." />
      <Tabs value={status} onChange={setStatus} options={[['submitted', 'Waiting'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['', 'All']]} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? (
        <Empty title={status === 'submitted' ? 'Nothing waiting for review' : 'No submissions here'}>Clients submit figures from the Evidence tab of the investor portal.</Empty>
      ) : rows.map((x) => <EvidenceRow key={x.id} e={x} onChange={r.reload} />)}
    </>
  );
}
