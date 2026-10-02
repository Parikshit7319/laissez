/** @jsxImportSource preact */
// Workflow screens: the approvals queue, approval policies, the holder-cap waitlist and order batches.
import { useEffect, useState } from 'preact/hooks';
import { api, money, when, day } from '../api';
import { useApi, Head, Btn, Chip, outcomeChip, ErrorBox, Loading, Empty, Field, Card, Json, go, ConfirmBtn, Copy } from '../ui';
import { PermBtn, PermNote, useMe } from '../auth';

const KIND_LABEL: Record<string, string> = { 'credential.issue': 'Credential issuance', 'order.large': 'Large order', 'settings.change': 'Settings change', 'investor.update': 'Client record change' };
const statusChip = (s: string) => s === 'pending' ? <Chip tone="warn">Pending</Chip> : s === 'approved' ? <Chip tone="ok">Approved</Chip> : s === 'rejected' ? <Chip tone="no">Rejected</Chip> : <Chip>Expired</Chip>;

// ---------- Approvals queue ----------
export function Approvals({ id }: { id?: string }) {
  const [status, setStatus] = useState('pending');
  const [kind, setKind] = useState('');
  const qs = new URLSearchParams(); if (status) qs.set('status', status); if (kind) qs.set('kind', kind);
  const r = useApi(`/v1/approvals?${qs}`, [status, kind]);
  const [open, setOpen] = useState<string | null>(id ?? null);
  useEffect(() => { setOpen(id ?? null); }, [id]);
  const rows: any[] = r.data?.data ?? [];
  const counts = r.data?.counts;
  return (
    <>
      <Head title="Approvals" sub="Actions that need a second person before they run: credentials for individuals, large orders, eligibility-affecting client edits and settings changes. The requester cannot approve their own." actions={<Btn kind="ghost" onClick={() => go('/approval-policies')}>Policies</Btn>} />
      {counts ? <div class="kpis">
        <div class="kpi"><span>Pending</span><b>{counts.pending}</b><em>waiting for a decision</em></div>
        <div class="kpi"><span>Approved</span><b>{counts.approved}</b><em>executed</em></div>
        <div class="kpi"><span>Rejected</span><b>{counts.rejected}</b><em>nothing changed</em></div>
        <div class="kpi"><span>Expired</span><b>{counts.expired}</b><em>not decided in 72 hours</em></div>
      </div> : null}
      <div class="toolbar">
        <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Status"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="expired">Expired</option><option value="">All</option></select>
        <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)} aria-label="Kind"><option value="">Every kind</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option value={k}>{v}</option>)}</select>
      </div>
      {open ? <ApprovalDetail id={open} onClose={() => { setOpen(null); if (id) go('/approvals'); }} onChange={r.reload} /> : null}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? <Empty title={status === 'pending' ? 'Nothing waiting for approval' : 'No requests match'}>{status === 'pending' ? 'Requests appear here when a policy routes an action to a second person.' : 'Change the filters.'}</Empty> : (
        <div class="tw"><table class="t">
          <thead><tr><th>Request</th><th>Kind</th><th>Requested by</th><th>Approvals</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr class="click" onClick={() => setOpen(x.id)}>
              <td><a href={`#/approvals/${x.id}`} onClick={(e) => { e.preventDefault(); setOpen(x.id); }}>{x.title}</a><div class="small muted mono">{x.id}</div></td>
              <td>{x.label ?? KIND_LABEL[x.kind] ?? x.kind}</td>
              <td>{x.requested_by}{x.requested_by_me ? <Chip tone="info">You</Chip> : null}</td>
              <td>{x.approvals.length} / {x.required_approvals}{x.can_decide ? <Chip tone="brass">Your decision</Chip> : null}</td>
              <td>{statusChip(x.status)}{x.error ? <div class="small" style={{ color: '#9a3412' }}>Last attempt failed</div> : null}</td>
              <td class="muted nowrap">{when(x.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function ApprovalDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { me } = useMe();
  const r = useApi(`/v1/approvals/${id}`, [id]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  if (r.loading && !r.data) return <Card title="Approval request"><Loading /></Card>;
  if (r.error) return <Card title="Approval request"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const x = done ?? r.data;
  const mine = x.requested_by_user ? x.requested_by_user === me?.user?.id || x.requested_by_user === me?.acting_as?.id : x.requested_by === (me?.acting_as?.name ?? me?.user?.name);
  const act = async (what: 'approve' | 'reject') => {
    setBusy(what); setErr(null);
    try { const res = await api(`/v1/approvals/${id}/${what}`, { body: { note: note || undefined } }); setDone(res); onChange(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const p = x.payload ?? {};
  return (
    <Card title={x.title} actions={<><span class="small muted mono">{x.id}</span><Btn kind="ghost" onClick={onClose}>Close</Btn></>}>
      <div class="row-inline tight" style={{ marginBottom: '0.6rem' }}>{statusChip(x.status)}<Chip>{x.label ?? KIND_LABEL[x.kind] ?? x.kind}</Chip><span class="small muted">Requested by {x.requested_by} {when(x.created_at)}. {x.status === 'pending' ? `Expires ${when(x.expires_at)}.` : x.decided_at ? `Decided ${when(x.decided_at)}.` : ''}</span></div>
      <PayloadSummary kind={x.kind} p={p} />
      {x.approvals.length ? <p class="small">Approved by {x.approvals.map((a: any) => `${a.name}${a.note ? ` ("${a.note}")` : ''}`).join(', ')}. {x.approvals.length} of {x.required_approvals} needed.</p> : <p class="small muted">No approvals yet. {x.required_approvals} needed.</p>}
      {x.rejection ? <p class="small">Rejected by {x.rejection.name}{x.rejection.note ? `: ${x.rejection.note}` : ''}.</p> : null}
      {x.error ? <div class="err" role="alert"><strong>The last approval ran the action but it failed.</strong> {x.error} The request stays open; fix the cause and approve again.</div> : null}
      {x.status === 'approved' && x.result ? <ResultSummary kind={x.kind} result={x.result} /> : null}
      {x.status === 'pending' ? (
        <div style={{ marginTop: '0.8rem' }}>
          {mine ? <p class="note">You requested this, so someone else has to decide it.{me?.workspace?.kind === 'sandbox' ? ' Switch teammate from the top bar to try it.' : ''}</p> : null}
          <Field label="Note (optional)"><input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="Checked the KYC file, figures match" maxLength={500} /></Field>
          <div class="form-actions">
            <Btn kind="primary" busy={busy === 'approve'} disabled={mine || !!busy} onClick={() => act('approve')}>{busy === 'approve' ? 'Running' : x.approvals.length + 1 >= x.required_approvals ? 'Approve and run' : 'Approve'}</Btn>
            <ConfirmBtn kind="danger" confirm="Reject this request" disabled={mine || !!busy} onConfirm={() => act('reject')}>Reject</ConfirmBtn>
          </div>
          <ErrorBox error={err} />
        </div>
      ) : null}
    </Card>
  );
}

function PayloadSummary({ kind, p }: { kind: string; p: any }) {
  if (kind === 'credential.issue') return <p>Issue a credential to <b>{p.investor_name ?? p.input?.investor_id}</b> ({p.investor_kind}) with {(p.classes ?? []).join(', ') || 'no classifications'}, valid {p.input?.valid_months ?? 12} months.</p>;
  if (kind === 'order.large') return <p><b>{p.input?.action}</b> {money(p.amount, p.currency)} of {p.input?.fund} for <b>{p.investor_name}</b>, settling in {p.input?.settle_with}. Preview at request time: {outcomeChip(p.preview_outcome ?? 'ALLOW')} <span class="muted small">{p.headline}</span></p>;
  if (kind === 'investor.update') return (
    <div><p>Change the record of <b>{p.investor_name}</b>:</p>
      <ul class="small">{Object.entries(p.changes ?? {}).map(([k, v]: any) => <li><b>{k.replace('_', ' ')}</b>: {String(v.from ?? 'empty')} to <b>{String(v.to ?? 'empty')}</b></li>)}</ul>
    </div>
  );
  if (kind === 'settings.change') {
    const ch = p.change ?? {};
    if (ch.action === 'member.role') return <p>Change the role of member <code>{ch.user_id}</code> to <b>{ch.role}</b>.</p>;
    if (ch.action === 'api_key.create') return <p>Create API key <b>{ch.name}</b> with scopes {ch.scopes?.join(', ')}{ch.expires_in_days ? `, expiring in ${ch.expires_in_days} days` : ''}{ch.ip_allowlist?.length ? `, allowed from ${ch.ip_allowlist.join(', ')}` : ''}.</p>;
    return <p>{ch.enabled ? 'Enable' : 'Disable'} single sign-on.</p>;
  }
  return <Json value={p} />;
}

function ResultSummary({ kind, result }: { kind: string; result: any }) {
  if (kind === 'credential.issue' && result.credential_id) return <p class="verdict-line ok">Issued {result.credential_id} ({result.lzid}), valid to {result.expires_on}.</p>;
  if (kind === 'order.large') return <p class="verdict-line ok">Decision <a href={`#/decisions/${result.decision?.id}`}>{result.decision?.id}</a> {result.decision?.outcome}. {result.settlement ? <>Settled as <a href={`#/settlements/${result.settlement.id}`}>{result.settlement.id}</a>.</> : result.settlement_error ?? result.note}</p>;
  if (kind === 'investor.update') return <p class="verdict-line ok">Applied as revision {result.revision}.{result.monitoring_rechecked ? ' Monitoring re-checked the holder.' : ''}</p>;
  if (kind === 'settings.change') {
    if (result.secret) return <div class="reveal" role="status"><span class="f-l">API key (shown once, to you)</span><div class="reveal-row"><code class="break">{result.secret}</code><Copy text={result.secret} /></div><p class="small muted">{result.note}</p></div>;
    if (result.secret_note) return <p class="small muted">Done. {result.secret_note}</p>;
    return <p class="verdict-line ok">Applied.</p>;
  }
  return <Json value={result} />;
}

// ---------- Approval policies ----------
export function ApprovalPolicies() {
  const r = useApi('/v1/approval-policies');
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (r.data) setDraft(Object.fromEntries(r.data.data.map((p: any) => [p.kind, { enabled: p.enabled, threshold: JSON.parse(JSON.stringify(p.threshold)), required_approvals: p.required_approvals, roles: [...p.roles] }]))); }, [r.data]);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const roles: { id: string; label: string }[] = r.data.roles;
  const set = (kind: string, patch: any) => setDraft({ ...draft, [kind]: { ...draft[kind], ...patch } });
  const setT = (kind: string, patch: any) => set(kind, { threshold: { ...draft[kind].threshold, ...patch } });
  const changed = r.data.data.some((p: any) => draft[p.kind] && JSON.stringify(draft[p.kind]) !== JSON.stringify({ enabled: p.enabled, threshold: p.threshold, required_approvals: p.required_approvals, roles: p.roles }));
  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const policies = r.data.data.filter((p: any) => JSON.stringify(draft[p.kind]) !== JSON.stringify({ enabled: p.enabled, threshold: p.threshold, required_approvals: p.required_approvals, roles: p.roles })).map((p: any) => ({ kind: p.kind, ...draft[p.kind] }));
      const res = await api('/v1/approval-policies', { method: 'PUT', body: { policies } });
      r.setData(res); setMsg('Policies saved. They apply to the next request.');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <>
      <Head title="Approval policies" sub="When an action needs a second person. Each organization starts with these defaults; administrators change them here and the change is audited." actions={<Btn kind="ghost" onClick={() => go('/approvals')}>Queue</Btn>} />
      <PermNote perm="members:admin" />
      {msg ? <div class="note" role="status">{msg}</div> : null}
      {r.data.data.map((p: any) => {
        const d = draft[p.kind]; if (!d) return null;
        return (
          <Card title={p.label} actions={<label class="check"><input type="checkbox" checked={d.enabled} onChange={(e) => set(p.kind, { enabled: (e.target as HTMLInputElement).checked })} /> Enabled</label>}>
            <p class="muted small">{p.description}</p>
            <div class="form-grid">
              {p.kind === 'order.large' ? <>
                <Field label="USD threshold"><input inputMode="numeric" value={Number(d.threshold.amount?.USD ?? 0).toLocaleString('en-US')} onInput={(e) => { const v = Number((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, '')); if (Number.isFinite(v)) setT(p.kind, { amount: { ...d.threshold.amount, USD: v } }); }} /></Field>
                <Field label="EUR threshold"><input inputMode="numeric" value={Number(d.threshold.amount?.EUR ?? 0).toLocaleString('en-US')} onInput={(e) => { const v = Number((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, '')); if (Number.isFinite(v)) setT(p.kind, { amount: { ...d.threshold.amount, EUR: v } }); }} /></Field>
              </> : null}
              {p.kind === 'credential.issue' ? <>
                <Field label="Client types that need approval" hint="Comma separated. Leave empty for every client type."><input value={(d.threshold.investor_kinds ?? []).join(', ')} onInput={(e) => setT(p.kind, { investor_kinds: (e.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
                <Field label="Minimum classifications"><input type="number" min={0} max={10} value={d.threshold.min_classes ?? 1} onInput={(e) => setT(p.kind, { min_classes: Number((e.target as HTMLInputElement).value) })} /></Field>
              </> : null}
              {p.kind === 'investor.update' ? <Field label="Fields that need approval">
                <div class="pick">{['name', 'kind', 'residence', 'city', 'booking_center', 'us_person', 'email', 'wallet'].map((f) => <label class={`pick-i ${(d.threshold.fields ?? []).includes(f) ? 'on' : ''}`}><input type="checkbox" checked={(d.threshold.fields ?? []).includes(f)} onChange={(e) => setT(p.kind, { fields: (e.target as HTMLInputElement).checked ? [...(d.threshold.fields ?? []), f] : (d.threshold.fields ?? []).filter((x: string) => x !== f) })} /><span>{f.replace('_', ' ')}</span></label>)}</div>
              </Field> : null}
              {p.kind === 'settings.change' ? <Field label="Actions that need approval">
                <div class="pick">{[['member.role', 'Member role changes'], ['api_key.create', 'API keys with a gated scope'], ['sso', 'Single sign-on changes']].map(([f, l]) => <label class={`pick-i ${(d.threshold.actions ?? []).includes(f) ? 'on' : ''}`}><input type="checkbox" checked={(d.threshold.actions ?? []).includes(f)} onChange={(e) => setT(p.kind, { actions: (e.target as HTMLInputElement).checked ? [...(d.threshold.actions ?? []), f] : (d.threshold.actions ?? []).filter((x: string) => x !== f) })} /><span>{l}</span></label>)}</div>
              </Field> : null}
              <Field label="Approvals required"><select value={d.required_approvals} onChange={(e) => set(p.kind, { required_approvals: Number((e.target as HTMLSelectElement).value) })}>{[1, 2, 3].map((n) => <option value={n}>{n}</option>)}</select></Field>
              <Field label="Who can approve">
                <div class="pick">{roles.map((ro) => <label class={`pick-i ${d.roles.includes(ro.id) ? 'on' : ''}`}><input type="checkbox" checked={d.roles.includes(ro.id)} onChange={(e) => set(p.kind, { roles: (e.target as HTMLInputElement).checked ? [...d.roles, ro.id] : d.roles.filter((x: string) => x !== ro.id) })} /><span>{ro.label}</span></label>)}</div>
              </Field>
            </div>
            {p.updated_by ? <p class="small muted">Last changed by {p.updated_by} {p.updated_at ? when(p.updated_at) : ''}.</p> : <p class="small muted">Default policy, not yet edited.</p>}
          </Card>
        );
      })}
      <div class="form-actions"><PermBtn perm="members:admin" kind="primary" disabled={!changed} busy={busy} onClick={save}>{busy ? 'Saving' : 'Save policies'}</PermBtn>{changed ? <Btn kind="ghost" onClick={() => r.reload()}>Discard changes</Btn> : null}</div>
      <ErrorBox error={err} />
    </>
  );
}

// ---------- Waitlist ----------
export function Waitlist() {
  const [status, setStatus] = useState('waiting');
  const r = useApi(`/v1/waitlist?status=${status}`, [status]);
  const [err, setErr] = useState<any>(null);
  const rows: any[] = r.data?.data ?? [];
  const cancel = async (id: string) => { setErr(null); try { await api(`/v1/waitlist/${id}`, { method: 'DELETE' }); r.reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <Head title="Waitlist" sub="Subscriptions refused only by a holder limit (Section 3(c)(1) cap, placement limit or the 12(g) threshold). When a holder fully redeems, the oldest entry that now passes becomes a decision and operations are told to settle it." />
      <div class="toolbar"><select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Status"><option value="waiting">Waiting</option><option value="released">Released</option><option value="cancelled">Cancelled</option><option value="all">All</option></select></div>
      <ErrorBox error={err} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? <Empty title="Nobody is waiting">When an order is refused by a holder cap, the order ticket offers a Join the waitlist button.</Empty> : (
        <div class="tw"><table class="t">
          <thead><tr><th>#</th><th>Client</th><th>Fund</th><th class="r">Amount</th><th>Holders</th><th>Status</th><th>Since</th><th /></tr></thead>
          <tbody>{rows.map((w) => (
            <tr>
              <td class="muted">{w.position ?? ''}</td>
              <td><a href={`#/clients/${w.investor_id}`}>{w.investor}</a><div class="small muted">{w.residence}</div></td>
              <td>{w.fund} <span class="muted">{w.ticker}</span></td>
              <td class="r">{money(w.amount, w.currency)} <span class="muted small">{w.asset}</span></td>
              <td>{w.holders}{w.holder_cap ? ` / ${w.holder_cap}` : ''}</td>
              <td>{w.status === 'waiting' ? <Chip tone="warn">Waiting</Chip> : w.status === 'released' ? <Chip tone="ok">Released</Chip> : <Chip>{w.status}</Chip>}{w.released_decision_id ? <div class="small"><a href={`#/decisions/${w.released_decision_id}`}>{w.released_decision_id}</a></div> : null}</td>
              <td class="muted nowrap">{day(w.created_at)}</td>
              <td>{w.status === 'waiting' ? <ConfirmBtn kind="ghost" confirm="Remove from waitlist" onConfirm={() => cancel(w.id)}>Cancel</ConfirmBtn> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

// ---------- Order batches ----------
const batchChip = (s: string) => s === 'open' ? <Chip tone="info">Open</Chip> : s === 'closed' ? <Chip tone="warn">Closed</Chip> : <Chip tone="ok">Settled</Chip>;
export function Batches({ id }: { id?: string }) {
  const [status, setStatus] = useState('');
  const r = useApi(`/v1/batches${status ? `?status=${status}` : ''}`, [status]);
  const rows: any[] = r.data?.data ?? [];
  if (id) return <BatchDetail id={id} />;
  return (
    <>
      <Head title="Order batches" sub="Subscriptions and redemptions dealing on a later date are held in a batch per fund and dealing date. Close it after the cut-off to fix the totals, then settle every allowed order in it." />
      <div class="toolbar"><select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Status"><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option><option value="settled">Settled</option></select></div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? <Empty title="No batches yet">A batch opens when an order is placed after the cut-off or for a monthly or quarterly dealing date.</Empty> : (
        <div class="tw"><table class="t">
          <thead><tr><th>Batch</th><th>Fund</th><th>Dealing date</th><th>Cut-off</th><th class="r">Orders</th><th class="r">Net</th><th>Status</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr class="click" onClick={() => go(`/batches/${b.id}`)}>
              <td><a href={`#/batches/${b.id}`}>{b.id}</a></td><td>{b.fund} <span class="muted">{b.ticker}</span></td><td>{b.dealing_date}</td><td class="muted nowrap">{when(b.cutoff_at)}</td>
              <td class="r">{b.orders} <span class="muted small">({b.allowed} allowed)</span></td><td class="r">{b.totals ? money(b.totals.net, b.currency) : <span class="muted">open</span>}</td><td>{batchChip(b.status)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function BatchDetail({ id }: { id: string }) {
  const r = useApi(`/v1/batches/${id}`, [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [auto, setAuto] = useState(false);
  const b = r.data;
  const close = async (force = false) => { setBusy('close'); setErr(null); try { await api(`/v1/batches/${id}/close`, { body: { force } }); r.reload(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const settleOnce = async () => {
    setBusy('settle'); setErr(null);
    try { const res = await api(`/v1/batches/${id}/settle`, { body: {} }); setRuns((x) => [...x, res]); r.reload(); return res; } catch (e) { setErr(e); setAuto(false); return null; } finally { setBusy(null); }
  };
  useEffect(() => {
    if (!auto) return;
    let live = true;
    (async () => { while (live) { const res = await settleOnce(); if (!res || res.done || !res.chunk.length) { setAuto(false); return; } await new Promise((ok) => setTimeout(ok, 400)); } })();
    return () => { live = false; };
  }, [auto]);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const t = b.totals ?? b.live_totals; const p = b.progress;
  const pct = p && p.allowed ? Math.round(((p.settled + p.failed) / p.allowed) * 100) : 0;
  return (
    <>
      <Head title={`Batch ${b.id}`} sub={<>{b.fund} ({b.ticker}), dealing {b.dealing_date}. Cut-off {when(b.cutoff_at)}{b.after_cutoff ? ', passed' : ', not yet reached'}.</>}
        actions={<>
          <Btn kind="ghost" onClick={() => go('/batches')}>All batches</Btn>
          {b.status === 'open' ? (b.after_cutoff ? <PermBtn perm="funds:write" kind="primary" busy={busy === 'close'} onClick={() => close(false)}>Close batch</PermBtn> : <ConfirmBtn kind="default" confirm="Close before the cut-off" onConfirm={() => close(true)}>Close early</ConfirmBtn>) : null}
          {b.status === 'closed' && p?.remaining > 0 ? <PermBtn perm="orders:write" kind="primary" busy={!!auto || busy === 'settle'} onClick={() => setAuto(true)}>{auto ? 'Settling' : `Settle ${p.remaining} order${p.remaining === 1 ? '' : 's'}`}</PermBtn> : null}
        </>} />
      <div class="row-inline tight" style={{ marginBottom: '0.8rem' }}>{batchChip(b.status)}{b.closed_by ? <span class="small muted">Closed by {b.closed_by} {when(b.closed_at)}.</span> : null}{b.settled_at ? <span class="small muted">Settled {when(b.settled_at)}.</span> : null}</div>
      <ErrorBox error={err} />
      <div class="kpis">
        <div class="kpi"><span>Gross subscriptions</span><b>{money(t.gross_subscriptions, b.currency)}</b><em>{Number(t.subscription_units).toLocaleString('en-US')} units</em></div>
        <div class="kpi"><span>Gross redemptions</span><b>{money(t.gross_redemptions, b.currency)}</b><em>{Number(t.redemption_units).toLocaleString('en-US')} units</em></div>
        <div class="kpi"><span>Net flow</span><b>{money(t.net, b.currency)}</b><em>{t.net >= 0 ? 'net inflow' : 'net outflow'}</em></div>
        <div class="kpi"><span>Orders</span><b>{t.orders}</b><em>{t.allowed} allowed, {t.refused} refused</em></div>
      </div>
      {p && b.status !== 'open' ? (
        <Card title="Settlement progress">
          <div style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden', marginBottom: '0.5rem' }}><div style={{ width: `${pct}%`, height: '100%', background: p.failed ? '#b45309' : '#0f5c4a', transition: 'width 0.3s' }} /></div>
          <p class="small">{p.settled} settled, {p.failed} failed, {p.remaining} remaining of {p.allowed} allowed. Each call settles up to 10 orders; the page keeps calling until done.</p>
          {runs.length ? <ul class="small">{runs.flatMap((x) => x.chunk).map((ch: any) => <li><a href={`#/decisions/${ch.decision_id}`}>{ch.decision_id}</a>: {ch.status}{ch.settlement_id ? <> as <a href={`#/settlements/${ch.settlement_id}`}>{ch.settlement_id}</a></> : ''}{ch.error ? <span class="muted"> {ch.error}</span> : null}</li>)}</ul> : null}
        </Card>
      ) : null}
      <Card title="Orders in this batch">
        {b.orders.length ? <div class="tw"><table class="t">
          <thead><tr><th>Decision</th><th>Action</th><th>Client</th><th class="r">Amount</th><th class="r">Units</th><th>Outcome</th><th>Settlement</th></tr></thead>
          <tbody>{b.orders.map((o: any) => <tr class="click" onClick={() => go(`/decisions/${o.id}`)}><td><a href={`#/decisions/${o.id}`}>{o.id}</a></td><td>{o.action}</td><td>{o.investor}</td><td class="r">{money(o.amount, b.currency)}</td><td class="r">{Number(o.units).toLocaleString('en-US')}</td><td>{outcomeChip(o.outcome)}</td><td>{o.settlement_id ? <a href={`#/settlements/${o.settlement_id}`}>{o.settlement_status}</a> : <span class="muted">none</span>}</td></tr>)}</tbody>
        </table></div> : <Empty title="No orders yet" />}
      </Card>
    </>
  );
}
