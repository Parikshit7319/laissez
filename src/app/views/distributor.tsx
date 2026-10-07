/** @jsxImportSource preact */
import { csvRow } from '../../proto/csv';
import { KycCard } from './kyc';
import { ReviewsCard } from './reviews';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, money, when, day, JUR, CLASS_LABEL, BOOKING, track, trackOnce } from '../api';
import { useApi, Head, Btn, Chip, outcomeChip, statusChip, ErrorBox, Loading, Empty, Field, Card, Json, go, Hash, TxLink, ConfirmBtn, Copy } from '../ui';
import { PermBtn, PermNote, useMe } from '../auth';
import { Credential } from '../../proto/Credential';
import { TESTS, findTest, subjectOf } from '../../proto/thresholds';
import { WHAT_IFS } from '../../proto/engine';
import { PortalInvite } from './portalAdmin';
import { EditClient, RevisionHistory, SuitabilityCard, TaxCard } from './clients2';
import { NetworkCard } from './network';

// ---------- Cursor pagination ----------
/** Loads a paginated list ({ data, next_cursor }) and appends further pages on demand. */
function usePaged<T = any>(path: string | null, deps: unknown[] = []) {
  const [rows, setRows] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<any>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true; setLoading(true);
    api(path).then((d) => { if (!live) return; setRows(d.data ?? []); setNext(d.next_cursor ?? null); setError(null); }).catch((e) => { if (live) setError(e); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, n, ...deps]);
  const loadMore = async () => {
    if (!next || !path) return;
    setMore(true);
    try { const d = await api(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}`); setRows((r) => [...r, ...(d.data ?? [])]); setNext(d.next_cursor ?? null); }
    catch (e) { setError(e); } finally { setMore(false); }
  };
  return { rows, next, loading, more, error, loadMore, reload: () => setN((x) => x + 1), setRows };
}
function LoadMore({ p, what = 'rows' }: { p: { next: string | null; more: boolean; loadMore: () => void; rows: any[] }; what?: string }) {
  if (!p.next) return p.rows.length > 50 ? <p class="small muted" style={{ marginTop: '0.6rem' }}>All {p.rows.length} {what} loaded.</p> : null;
  return <div class="row-inline" style={{ justifyContent: 'center', marginTop: '0.8rem' }}><Btn kind="ghost" busy={p.more} onClick={p.loadMore}>{p.more ? 'Loading' : `Load more ${what}`}</Btn><span class="small muted">{p.rows.length} loaded</span></div>;
}
const qs = (o: Record<string, string | undefined | null>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) u.set(k, v); const str = u.toString(); return str ? `?${str}` : ''; };
/** Debounced copy of a value, for search boxes that query the API as you type. */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value]);
  return v;
}

// ---------- Overview ----------
// The old Overview is now Home (views/home.tsx). The name stays exported for anything that imports it.
export { Home as Overview } from './home';

// ---------- Clients ----------
const credChip = (s: string) => s === 'active' ? <Chip tone="ok">Active</Chip> : s === 'none' ? <Chip>None</Chip> : s === 'share_pending' ? <Chip tone="info">Consent pending</Chip> : s === 'relied_invalid' ? <Chip tone="no">Share ended</Chip> : <Chip tone="warn">{s === 'lapsed' ? 'Lapsed' : 'Partly lapsed'}</Chip>;
export function Clients() {
  const [f, setF] = useState({ q: '', residence: '', booking_center: '', credential_status: '' });
  const q = useDebounced(f.q.trim(), 300);
  const path = `/v1/investors${qs({ q, residence: f.residence, booking_center: f.booking_center, credential_status: f.credential_status })}`;
  const r = usePaged(path);
  const [adding, setAdding] = useState(false);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const filtered = !!(q || f.residence || f.booking_center || f.credential_status);
  return (
    <>
      <Head title="Clients" sub="Investors you have onboarded. Each holds at most one active Laissez-passer." actions={<PermBtn perm="clients:write" kind="primary" onClick={() => setAdding(true)}>Add client</PermBtn>} />
      {adding ? <AddClient onDone={(id) => { setAdding(false); if (id) go(`/clients/${id}`); else r.reload(); }} /> : null}
      <div class="toolbar" style={{ flexWrap: 'wrap' }}>
        <input class="search" placeholder="Search by name, city, id or passport number" value={f.q} onInput={(e) => set('q', (e.target as HTMLInputElement).value)} aria-label="Search clients" />
        <select value={f.residence} onChange={(e) => set('residence', (e.target as HTMLSelectElement).value)} aria-label="Residence"><option value="">Any residence</option>{Object.entries(JUR).map(([k, v]) => <option value={k}>{v}</option>)}</select>
        <select value={f.booking_center} onChange={(e) => set('booking_center', (e.target as HTMLSelectElement).value)} aria-label="Booking center"><option value="">Any booking center</option>{Object.entries(BOOKING).map(([k, v]) => <option value={k}>{v}</option>)}</select>
        <select value={f.credential_status} onChange={(e) => set('credential_status', (e.target as HTMLSelectElement).value)} aria-label="Credential status"><option value="">Any credential</option><option value="active">Active</option><option value="lapsed">Lapsed</option><option value="none">None</option><option value="share_pending">Consent pending</option></select>
        {filtered ? <Btn kind="ghost" onClick={() => setF({ q: '', residence: '', booking_center: '', credential_status: '' })}>Clear</Btn> : null}
      </div>
      {r.loading && !r.rows.length ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.rows.length ? <Empty title={filtered ? 'No clients match these filters' : 'No clients yet'}>{filtered ? 'Widen the search or clear the filters.' : 'Add a client to start.'}</Empty> : (
        <>
          <div class="tw"><table class="t">
            <thead><tr><th>Client</th><th>Type</th><th>Residence</th><th>Booked in</th><th>Credential</th><th>Classifications</th></tr></thead>
            <tbody>{r.rows.map((i: any) => (
              <tr class="click" onClick={() => go(`/clients/${i.id}`)}>
                <td><a href={`#/clients/${i.id}`}>{i.name}</a>{i.lzid ? <div class="small muted mono">{i.lzid}</div> : null}</td><td>{i.kind}</td><td>{i.residence_name}</td><td>{BOOKING[i.booking] ?? i.booking}</td>
                <td>{credChip(i.credential_status)}</td>
                <td class="muted">{i.classifications.map((c: any) => CLASS_LABEL[c.code] ?? c.code).join(', ') || 'KYC only'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <LoadMore p={r} what="clients" />
        </>
      )}
    </>
  );
}

function AddClient({ onDone }: { onDone: (id?: string) => void }) {
  const [f, setF] = useState({ name: '', kind: 'Corporate', residence: 'SG', city: '', booking_center: 'SG', us_person: false });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const inv = await api('/v1/investors', { body: f }); onDone(inv.id); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Add a client">
      <form class="form-grid" onSubmit={submit}>
        <Field label="Legal name"><input required value={f.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} placeholder="Harbourline Capital Pte. Ltd." /></Field>
        <Field label="Type"><select value={f.kind} onChange={(e) => set('kind', (e.target as HTMLSelectElement).value)}>{['Corporate', 'Family office', 'Pension fund', 'Holding company', 'Individual'].map((k) => <option>{k}</option>)}</select></Field>
        <Field label="Residence"><select value={f.residence} onChange={(e) => set('residence', (e.target as HTMLSelectElement).value)}>{['SG', 'HK', 'CH', 'DE', 'LU', 'IE', 'GB', 'AE-DIFC', 'AE-ADGM', 'JP', 'IN', 'AU', 'CA', 'BR', 'KR', 'US'].map((j) => <option value={j}>{JUR[j]}</option>)}</select></Field>
        <Field label="City"><input required value={f.city} onInput={(e) => set('city', (e.target as HTMLInputElement).value)} /></Field>
        <Field label="Booking center"><select value={f.booking_center} onChange={(e) => set('booking_center', (e.target as HTMLSelectElement).value)}>{Object.entries(BOOKING).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
        <Field label="U.S. person"><label class="check"><input type="checkbox" checked={f.us_person || f.residence === 'US'} disabled={f.residence === 'US'} onChange={(e) => set('us_person', (e.target as HTMLInputElement).checked)} /> Resident in the United States (Regulation S)</label></Field>
        <div class="form-actions"><PermBtn perm="clients:write" type="submit" kind="primary" busy={busy}>{busy ? 'Saving' : 'Add client'}</PermBtn><Btn kind="ghost" onClick={() => onDone()}>Cancel</Btn></div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

export function ClientDetail({ id }: { id: string }) {
  const r = useApi(`/v1/investors/${id}`, [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rev, setRev] = useState(0);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const i = r.data;
  const revoke = async () => { try { await api(`/v1/credentials/${i.credentialId}/revoke`, { body: {} }); setMsg('Credential revoked. Holdings move to redemption-only.'); r.reload(); } catch (e: any) { setMsg(e.message); } };
  return (
    <>
      <Head title={i.name} sub={<>{i.kind}, {i.city}. Resident in {JUR[i.residence]}, booked in {BOOKING[i.booking]}.</>} actions={<><PermBtn perm="orders:write" kind="primary" onClick={() => go(`/orders/new?investor=${i.id}`)}>New order</PermBtn><PermBtn perm="clients:write" onClick={() => go(`/clients/${i.id}/credential`)}>{i.credentialId ? 'Renew credential' : 'Issue credential'}</PermBtn>{i.credentialId ? <PermBtn perm="clients:write" kind="danger" onClick={revoke}>Revoke credential</PermBtn> : null}<PermBtn perm="clients:write" kind="ghost" onClick={() => setEditing(true)}>Edit record</PermBtn></>} />
      <PermNote perm="clients:write" />
      {editing ? <EditClient inv={i} onDone={(m) => { setEditing(false); if (m) { setMsg(m); r.reload(); } setRev((n) => n + 1); }} /> : null}
      {msg ? <div class="note">{msg}</div> : null}
      <div class="grid2">
        <div class="app">{i.credentialId ? <Credential inv={i} /> : <Empty title="No credential yet">Issue a Laissez-passer to record this client’s classifications.</Empty>}</div>
        <div>
        <NetworkCard investorId={i.id} />
        <Card title="Holdings">
          {i.holdings_detail.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>Fund</th><th class="r">Units</th><th class="r">Value</th><th>Status</th></tr></thead>
              <tbody>{i.holdings_detail.map((h: any) => <tr><td>{h.fund} <span class="muted">{h.ticker}</span>{h.lockup_ends ? <div class="muted small">Lock-up to {h.lockup_ends}</div> : null}</td><td class="r">{h.units.toLocaleString('en-US')}</td><td class="r">{money(h.value, h.currency)}</td><td title={h.reason}>{statusChip(h.status)}</td></tr>)}</tbody>
            </table></div>
          ) : <Empty title="No holdings">Subscribe to a fund to create one.</Empty>}
        </Card>
        </div>
      </div>
      {i.reliedShare ? <div class="note">This client's credential was issued by {i.issuer}. Laissez reads it live from the issuing distributor, so a revocation there applies here at once.</div> : null}
      <Card title="Investor portal">
        <p class="muted small">Give the client a private link to read fund documents, acknowledge them, submit evidence and request subscriptions, redemptions and transfers under your brand.</p>
        <PortalInvite investorId={i.id} investorName={i.name} />
        <PortalAccessList investorId={i.id} />
        <PortalAccounts investorId={i.id} />
      </Card>
      <div class="grid2">
        <SuitabilityCard investorId={i.id} />
        <TaxCard investorId={i.id} />
      </div>
      <div class="grid2">
        <KycCard investorId={i.id} />
        <ReviewsCard investorId={i.id} />
      </div>
      <RevisionHistory investorId={i.id} refresh={rev} />
      <Card title="Recent decisions">
        {i.recent_decisions.length ? <DecisionTable rows={i.recent_decisions} /> : <Empty title="No decisions yet" />}
      </Card>
    </>
  );
}

/** Portal accounts the client created from their links. */
function PortalAccounts({ investorId }: { investorId: string }) {
  const r = useApi(`/v1/investors/${investorId}/portal-accounts`, [investorId]);
  const [err, setErr] = useState<any>(null);
  const rows = r.data?.data ?? [];
  if (!rows.length) return null;
  const toggle = async (a: any) => { setErr(null); try { await api(`/v1/investors/${investorId}/portal-accounts/${a.id}/${a.disabled_at ? 'enable' : 'disable'}`, { body: {} }); r.reload(); } catch (e) { setErr(e); } };
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <p class="small muted" style={{ margin: '0 0 0.35rem' }}>Portal account</p>
      <ErrorBox error={err} />
      <ul class="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>{rows.map((a: any) => <li key={a.id}>{a.disabled_at ? <Chip tone="no">Disabled</Chip> : <Chip tone="ok">Active</Chip>} {a.passkeys} passkey{a.passkeys === 1 ? '' : 's'}{a.totp_enabled ? ', authenticator app on' : ''}, created {when(a.created_at)}{a.last_login_at ? `, last sign-in ${when(a.last_login_at)}` : ''}{a.active_sessions ? `, ${a.active_sessions} active session${a.active_sessions === 1 ? '' : 's'}` : ''} <PermBtn perm="clients:write" kind="ghost" onClick={() => toggle(a)}>{a.disabled_at ? 'Enable' : 'Disable'}</PermBtn></li>)}</ul>
    </div>
  );
}

/** Every portal link issued for a client, with revoke-all and reissue. */
function PortalAccessList({ investorId }: { investorId: string }) {
  const r = useApi(`/v1/investors/${investorId}/portal-access`, [investorId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [issued, setIssued] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const revokeAll = async () => {
    setBusy('revoke'); setErr(null);
    try { const x = await api(`/v1/investors/${investorId}/portal-access`, { method: 'DELETE' }); setMsg(`${x.revoked_links} link${x.revoked_links === 1 ? '' : 's'} withdrawn. The client can no longer open the portal until you issue a new link.`); setIssued(null); r.reload(); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const reissue = async () => {
    setBusy('reissue'); setErr(null); setMsg(null);
    try { const x = await api(`/v1/investors/${investorId}/portal-access/reissue`, { body: {} }); setIssued(x); r.reload(); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  if (r.loading && !r.data) return null;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const rows: any[] = r.data?.data ?? [];
  const active = r.data?.active ?? 0;
  const tone = (s: string) => s === 'active' ? <Chip tone="ok">Active</Chip> : s === 'revoked' ? <Chip>Withdrawn</Chip> : <Chip tone="warn">Expired</Chip>;
  return (
    <div style={{ marginTop: '1rem' }}>
      <div class="row-inline tight" style={{ justifyContent: 'space-between' }}>
        <span class="small"><b>{active}</b> active link{active === 1 ? '' : 's'}{r.data?.investor?.email ? <span class="muted">, client email {r.data.investor.email}{r.data.investor.email_deliverable ? '' : ' (placeholder, not emailed)'}</span> : <span class="muted">, no client email on file</span>}</span>
        <span class="row-inline tight">
          <PermBtn perm="clients:write" kind="ghost" busy={busy === 'reissue'} onClick={reissue}>{active ? 'Reissue link' : 'Issue new link'}</PermBtn>
          {active ? <ConfirmBtn kind="ghost" confirm={`Withdraw ${active} link${active === 1 ? '' : 's'}`} onConfirm={revokeAll}>Withdraw all links</ConfirmBtn> : null}
        </span>
      </div>
      {msg ? <p class="note small" role="status">{msg}</p> : null}
      <ErrorBox error={err} />
      {issued ? (
        <div class="reveal" role="status">
          <span class="f-l">New investor portal link</span>
          <div class="reveal-row"><code class="break">{issued.link}</code><Copy text={issued.link} /></div>
          <p class="small muted">{issued.note} Expires {day(issued.expires_at)}.</p>
        </div>
      ) : null}
      {rows.length ? (
        <div class="tw" style={{ marginTop: '0.6rem' }}><table class="t">
          <thead><tr><th>Link</th><th>Issued</th><th>Expires</th><th>Last used</th><th>Status</th></tr></thead>
          <tbody>{rows.map((x) => <tr class={x.status === 'active' ? '' : 'off'}><td><code>{x.id}…</code><div class="small muted">{String(x.created_by ?? '').replace(/^user:|^key:/, '')}</div></td><td class="muted nowrap">{when(x.created_at)}</td><td class="muted nowrap">{day(x.expires_at)}</td><td class="muted nowrap">{x.last_used_at ? when(x.last_used_at) : 'Never'}</td><td>{tone(x.status)}{x.revoked_at ? <div class="small muted">{when(x.revoked_at)}</div> : null}</td></tr>)}</tbody>
        </table></div>
      ) : <p class="small muted" style={{ marginTop: '0.6rem' }}>No portal link has been issued for this client yet.</p>}
    </div>
  );
}

// ---------- Credential issuance ----------
export function IssueCredential({ id }: { id: string }) {
  const r = useApi(`/v1/investors/${id}`, [id]);
  const [sel, setSel] = useState<Record<string, { evidence: Record<string, any>; ref: string }>>({});
  const [months, setMonths] = useState(12);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} />;
  const inv = r.data;
  const subject = subjectOf(inv.kind);
  const available = TESTS.filter((t) => t.subject === subject);
  const toggle = (code: string) => { const n = { ...sel }; if (n[code]) delete n[code]; else n[code] = { evidence: {}, ref: '' }; setSel(n); };
  const setEv = (code: string, k: string, v: any) => setSel({ ...sel, [code]: { ...sel[code], evidence: { ...sel[code].evidence, [k]: v } } });
  const results = Object.entries(sel).map(([code, s]) => ({ code, ...findTest(code, inv.kind)!.check(s.evidence) }));
  const allPass = results.length > 0 && results.every((x) => x.pass);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api('/v1/credentials', { body: { investor_id: inv.id, valid_months: months, classifications: Object.entries(sel).map(([class_code, s]) => ({ class_code, evidence: s.evidence, evidence_ref: s.ref || undefined })) } });
      track('credential_issued', { credential: r.credential_id, classes: Object.keys(sel).length });
      go(`/clients/${inv.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const BOOK_JUR: Record<string, string> = { HK: 'HK', SG: 'SG', ZRH: 'CH', DIFC: 'AE-DIFC', NY: 'US', LDN: 'GB', TYO: 'JP', ADGM: 'AE-ADGM' };
  const CLASS_JUR: Record<string, string> = { EU: 'DE', DIFC: 'AE-DIFC', ADGM: 'AE-ADGM' };
  const resJur = ['LU', 'IE'].includes(inv.residence) ? 'DE' : inv.residence;
  const relevant = new Set([resJur, BOOK_JUR[inv.booking] ?? inv.booking]);
  return (
    <>
      <Head title={`${inv.credentialId ? 'Renew' : 'Issue'} credential`} sub={<>For {inv.name}{/\.$/.test(inv.name) ? '' : '.'} Each classification is checked against its legal threshold before anything is issued. {inv.credentialId ? `This replaces ${inv.credentialId}.` : ''}</>} />
      <Card title="1. Choose classifications">
        <div class="pick">
          {available.map((t) => {
            const jur = t.code.split('_')[0];
            return <label class={`pick-i ${sel[t.code] ? 'on' : ''}`}><input type="checkbox" checked={!!sel[t.code]} onChange={() => toggle(t.code)} /><span>{CLASS_LABEL[t.code]}</span>{relevant.has(CLASS_JUR[jur] ?? jur) ? <Chip tone="info">Relevant</Chip> : null}</label>;
          })}
        </div>
      </Card>
      {Object.keys(sel).length === 0 ? <Card title="2. Evidence"><p class="muted">Choose a classification above. Laissez then asks for the figures its legal test needs, such as net assets, portfolio size or income.</p></Card> : null}
      {Object.keys(sel).map((code) => {
        const t = findTest(code, inv.kind)!;
        const res = t.check(sel[code].evidence);
        return (
          <Card title={`2. Evidence for ${CLASS_LABEL[code]}`} actions={res.pass ? <Chip tone="ok">Meets threshold</Chip> : <Chip tone="warn">Not yet</Chip>}>
            <div class="form-grid">
              {t.fields.map((fd) => fd.kind === 'bool'
                ? <Field label={fd.label}><label class="check"><input type="checkbox" checked={!!sel[code].evidence[fd.key]} onChange={(e) => setEv(code, fd.key, (e.target as HTMLInputElement).checked)} /> Yes</label></Field>
                : <Field label={`${fd.label} (${fd.unit?.trim()})`}><input inputMode="numeric" placeholder="0" value={sel[code].evidence[fd.key] ?? ''} onInput={(e) => { const v = Number((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, '')); setEv(code, fd.key, Number.isFinite(v) ? v : 0); }} /></Field>)}
              <Field label="Evidence reference" hint="A pointer to the document in your KYC system, never the document itself."><input value={sel[code].ref} onInput={(e) => setSel({ ...sel, [code]: { ...sel[code], ref: (e.target as HTMLInputElement).value } })} placeholder="KYC-2026-0412, audited accounts FY2025" /></Field>
            </div>
            <p class={`verdict-line ${res.pass ? 'ok' : 'warn'}`}>{res.reason}</p>
          </Card>
        );
      })}
      <Card title="3. Issue">
        <div class="row-inline">
          <Field label="Valid for"><select value={months} onChange={(e) => setMonths(Number((e.target as HTMLSelectElement).value))}>{[6, 12, 18, 24].map((m) => <option value={m}>{m} months</option>)}</select></Field>
          <PermBtn perm="clients:write" kind="primary" disabled={!allPass} busy={busy} onClick={submit}>{busy ? 'Issuing' : 'Issue Laissez-passer'}</PermBtn>
          {!allPass ? <span class="muted">{Object.keys(sel).length ? 'Every selected classification must meet its threshold.' : 'Choose at least one classification.'}</span> : null}
        </div>
        <PermNote perm="clients:write" />
        <ErrorBox error={err} />
      </Card>
    </>
  );
}

// ---------- Order ticket with live pre-trade decision ----------
export function NewOrder({ params }: { params: URLSearchParams }) {
  const { can, why } = useMe();
  const canOrder = can('orders:write');
  const invs = useApi('/v1/investors?limit=200');
  const funds = useApi('/v1/funds');
  const [o, setO] = useState({ action: 'subscribe', investor_id: params.get('investor') ?? 'lumen', fund: params.get('fund') ?? 'TWLF', amount: Number(params.get('amount')) || 2_000_000, settle_with: 'USDC', counterparty_id: 'qamar', what_ifs: [] as string[] });
  const [live, setLive] = useState<any>(null);
  const [liveErr, setLiveErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>(0);
  const fund = (funds.data?.data ?? []).find((f: any) => f.ticker === o.fund);
  const orderBody = (extra: Record<string, unknown> = {}) => { const b: any = { ...o, ...extra }; if (o.action !== 'transfer') delete b.counterparty_id; return b; };
  useEffect(() => { if (fund && !fund.assets.includes(o.settle_with)) setO((x) => ({ ...x, settle_with: fund.assets[0] })); }, [o.fund, funds.data]);
  // Fall back to the first client and fund when the demo defaults do not exist in this workspace.
  useEffect(() => {
    const iv: any[] = invs.data?.data ?? []; const fs: any[] = funds.data?.data ?? [];
    if (!iv.length || !fs.length) return;
    setO((x) => {
      const investor_id = iv.some((i) => i.id === x.investor_id) ? x.investor_id : iv[0].id;
      const counterparty_id = iv.some((i) => i.id === x.counterparty_id && i.id !== investor_id) ? x.counterparty_id : (iv.find((i) => i.id !== investor_id)?.id ?? x.counterparty_id);
      const f = fs.find((y) => y.ticker === x.fund) ?? fs[0];
      return investor_id === x.investor_id && counterparty_id === x.counterparty_id && f.ticker === x.fund ? x : { ...x, investor_id, counterparty_id, fund: f.ticker };
    });
  }, [invs.data, funds.data]);
  const ready = !!(invs.data?.data ?? []).some((i: any) => i.id === o.investor_id) && !!(funds.data?.data ?? []).some((f: any) => f.ticker === o.fund);
  useEffect(() => {
    if (!ready || !canOrder) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api('/v1/decisions', { body: orderBody({ persist: false }) }).then((d) => { setLive(d); setLiveErr(null); trackOnce('order_previewed', { action: o.action, fund: o.fund }); }).catch((e) => { setLiveErr(e); setLive(null); });
    }, 350);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(o), ready]);
  const [pending, setPending] = useState<any>(null);
  const [waitlisted, setWaitlisted] = useState<any>(null);
  const [wlBusy, setWlBusy] = useState(false);
  const place = async () => {
    setBusy(true);
    try {
      const d = await api('/v1/decisions', { body: orderBody() });
      // Above the large-order threshold the order is stored for a second person instead of being decided now.
      if (d.pending) { setPending(d); return; }
      track('order_placed', { action: o.action, fund: o.fund, outcome: d.outcome, hypothetical: o.what_ifs.length > 0 }); go(`/decisions/${d.id}`);
    }
    catch (e) { setLiveErr(e); } finally { setBusy(false); }
  };
  const joinWaitlist = async () => {
    setWlBusy(true); setLiveErr(null);
    try { setWaitlisted(await api('/v1/waitlist', { body: { ticker: o.fund, investor_id: o.investor_id, amount: o.amount, asset: o.settle_with } })); }
    catch (e) { setLiveErr(e); } finally { setWlBusy(false); }
  };
  useEffect(() => { setPending(null); setWaitlisted(null); }, [JSON.stringify(o)]);
  const set = (k: string, v: any) => setO({ ...o, [k]: v });
  if ((invs.loading && !invs.data) || (funds.loading && !funds.data)) return <Loading />;
  if (invs.error || funds.error) return <ErrorBox error={invs.error ?? funds.error} onRetry={() => { invs.reload(); funds.reload(); }} />;
  if (!invs.data.data.length || !funds.data.data.length) return <><Head title="New order" /><Empty title={!invs.data.data.length ? 'Add a client first' : 'Create a fund first'}>{!invs.data.data.length ? <a href="#/clients">Go to clients</a> : <a href="#/funds/new">Create a fund</a>}</Empty></>;
  return (
    <>
      <Head title="New order" sub="The decision updates as you type. Nothing is recorded until you place the order." />
      <div class="grid-order">
        <div>
          <Card title="Order ticket">
            <div class="seg-c" role="radiogroup" aria-label="Action">{['subscribe', 'transfer', 'redeem'].map((a) => <button type="button" role="radio" aria-checked={o.action === a} class={o.action === a ? 'on' : ''} onClick={() => set('action', a)}>{a[0].toUpperCase() + a.slice(1)}</button>)}</div>
            <Field label="Client"><select value={o.investor_id} onChange={(e) => set('investor_id', (e.target as HTMLSelectElement).value)}>{invs.data.data.map((i: any) => <option value={i.id}>{i.name} ({i.residence_name})</option>)}</select></Field>
            <Field label="Fund"><select value={o.fund} onChange={(e) => set('fund', (e.target as HTMLSelectElement).value)}>{funds.data.data.map((f: any) => <option value={f.ticker}>{f.short} ({f.ticker})</option>)}</select></Field>
            <div class="form-grid two">
              <Field label={`Amount (${fund?.currency ?? 'USD'})`} hint={fund ? `${(o.amount / fund.nav).toLocaleString('en-US', { maximumFractionDigits: 2 })} units at NAV ${fund.nav.toFixed(4)}` : ''}><input inputMode="numeric" value={o.amount.toLocaleString('en-US')} onInput={(e) => { const v = Number((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, '')); if (Number.isFinite(v)) set('amount', v); }} /></Field>
              <Field label={o.action === 'redeem' ? 'Paid out in' : 'Settle in'}><select value={o.settle_with} onChange={(e) => set('settle_with', (e.target as HTMLSelectElement).value)}>{[...(fund?.assets ?? []), 'USDT'].map((a: string) => <option>{a}</option>)}</select></Field>
            </div>
            {o.action === 'transfer' ? <Field label="Transfer to"><select value={o.counterparty_id} onChange={(e) => set('counterparty_id', (e.target as HTMLSelectElement).value)}>{invs.data.data.filter((i: any) => i.id !== o.investor_id).map((i: any) => <option value={i.id}>{i.name}</option>)}</select></Field> : null}
            <fieldset class="wis"><legend>What if</legend>{WHAT_IFS.map((w) => <label title={w.hint}><input type="checkbox" checked={o.what_ifs.includes(w.id)} onChange={(e) => set('what_ifs', (e.target as HTMLInputElement).checked ? [...o.what_ifs, w.id] : o.what_ifs.filter((x) => x !== w.id))} /> {w.label}</label>)}</fieldset>
            <div class="form-actions"><PermBtn perm="orders:write" kind="primary" disabled={!live} busy={busy} onClick={place}>{busy ? 'Placing' : 'Place order'}</PermBtn>{live?.waitlist_eligible && !waitlisted ? <PermBtn perm="orders:write" busy={wlBusy} onClick={joinWaitlist}>Join the waitlist</PermBtn> : null}{o.what_ifs.length ? <span class="muted">What-ifs make the decision hypothetical: it records, but cannot settle.</span> : null}</div>
            <PermNote perm="orders:write" />
            {pending ? <div class="note" role="status"><b>Waiting for approval.</b> {pending.reason} Request <a href={`#/approvals/${pending.approval_id}`}>{pending.approval_id}</a> is in the approvals queue. When another person approves it the order is decided and settled under their name.</div> : null}
            {waitlisted ? <div class="note" role="status"><b>On the waitlist</b> as {waitlisted.id}, position {waitlisted.position}. {waitlisted.note} <a href="#/waitlist">View the waitlist</a>.</div> : live?.waitlist_eligible && !waitlisted ? <p class="small muted">Refused only by a holder limit. Join the waitlist and the order is re-evaluated when a holder fully redeems.</p> : null}
          </Card>
          <AsOfCard body={orderBody} live={live} />
        </div>
        <div>
          <ErrorBox error={liveErr} />
          {!canOrder ? <Card title="Live check is off"><p class="muted">{why('orders:write')} The live pre-trade check runs as an order preview, so it needs the same permission. You can still evaluate this order as of a past date.</p></Card> : live ? <DecisionPanel d={live} /> : !liveErr ? <Loading label="Checking" /> : null}
        </div>
      </div>
    </>
  );
}

/** Re-runs the order against the rules and data as they stood on a past date. */
function AsOfCard({ body, live }: { body: (extra?: Record<string, unknown>) => any; live: any }) {
  const ago = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(ago);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setRes(null);
    try { const b = body(); delete b.persist; setRes(await api('/v1/evaluate/as-of', { body: { ...b, as_of: date } })); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const d = res ? res.decision ?? res : null;
  const packs: string[] = d ? (d.rule_packs ?? d.rulePacks ?? []) : [];
  const binding: any[] = d ? (d.binding_rules ?? d.resolved ?? []) : [];
  return (
    <Card title="Evaluate as of a past date">
      <p class="small muted">Run this exact order against the rule packs, fund policy and credentials in force on an earlier date. Useful when a regulator asks why a trade was allowed at the time. Nothing is recorded.</p>
      <form class="row-inline" onSubmit={run}>
        <Field label="As of"><input type="date" required max={today} value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
        <Btn type="submit" busy={busy}>Evaluate on this date</Btn>
      </form>
      <ErrorBox error={err} />
      {d ? (
        <div class="asof">
          <div class="row-inline tight">{outcomeChip(d.outcome)}<span class="small muted">on {new Date((res.as_of ?? date) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>{live && live.outcome !== d.outcome ? <Chip tone="warn">Today: {live.outcome === 'ALLOW' ? 'allowed' : live.outcome === 'DENY' ? 'denied' : 'frozen'}</Chip> : live ? <Chip>Same as today</Chip> : null}</div>
          {d.headline ? <p class="asof-h">{d.headline}</p> : null}
          {binding.length ? <ul class="asof-l">{binding.map((b: any) => <li>{b.text} <span class="muted small">{b.ruleRef ?? b.rule_ref}</span></li>)}</ul> : null}
          {packs.length ? <p class="small muted">Rule packs in force: {packs.join(', ')}</p> : null}
          {res.policy_version_used ? <p class="small muted">Fund policy version {res.policy_version_used.version}{res.policy_version_used.published_by ? `, published by ${res.policy_version_used.published_by}` : ''}{res.policy_version_used.effective_at ? ` on ${new Date(res.policy_version_used.effective_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}.</p> : null}
          {res.note ? <p class="small muted">{res.note}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

const LAYERS = ['Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Transfer controls', 'Counterparty', 'Global screens'];
export function DecisionPanel({ d }: { d: any }) {
  const checks = d.checks ?? [];
  const binding = d.binding_rules ?? d.resolved ?? [];
  return (
    <div class={`dpanel o-${String(d.outcome).toLowerCase()}`}>
      <div class="dv"><span class="dv-stamp">{d.outcome === 'ALLOW' ? 'Admitted' : d.outcome === 'DENY' ? 'Refused' : 'Frozen'}</span><div><p class="dv-h">{d.headline}</p>{d.hypothetical || (d.what_ifs ?? []).length ? <Chip tone="info">Hypothetical</Chip> : null}</div></div>
      {(d.remedies ?? []).length ? <div class="remedy"><h3>How to fix it</h3><ul>{d.remedies.map((r: string) => <li>{r}</li>)}</ul></div> : null}
      {binding.length ? <div class="binding"><h3>Rules that bind</h3><ul>{binding.map((b: any) => <li><strong>{b.text}</strong><span>{b.layer}, {b.ruleRef}</span></li>)}</ul></div> : null}
      <div class="trace2">
        {LAYERS.map((L) => { const items = checks.filter((c: any) => c.layer === L); return items.length ? (
          <div class="tl"><h3>{L}</h3><ul>{items.map((c: any) => <li class={`r-${c.result}`}><i aria-hidden="true">{c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '•'}</i><div><span class="tl-l">{c.subject && L === 'Counterparty' ? `${c.subject}: ` : ''}{c.label}{c.binding ? <Chip tone="info">Binding</Chip> : null}{c.ruleRef ? <em>{c.ruleRef}</em> : null}</span><p>{c.detail}</p></div></li>)}</ul></div>
        ) : null; })}
      </div>
    </div>
  );
}

// ---------- Decision detail with settlement and receipt ----------
export function DecisionDetail({ id }: { id: string }) {
  const r = useApi(`/v1/decisions/${id}`, [id]);
  const [stl, setStl] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [verify, setVerify] = useState<any>(null);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const canSettle = d.outcome === 'ALLOW' && !(d.what_ifs ?? []).length && !d.settlement_id && !stl && Date.now() - new Date(d.created_at).getTime() < 15 * 60_000;
  const settle = async (force = false) => {
    setErr(null); setBusy(true);
    try {
      const s = await api('/v1/settlements', { body: { decision_id: d.id, ...(force ? { force: true } : {}) } });
      setStl(s);
      if (s.status === 'settled') track('settlement_completed', { settlement: s.id, action: d.action, fund: d.ticker });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const doVerify = async () => { setVerify(await api('/v1/receipts/verify', { body: { receipt: d.receipt, signature: d.signature }, auth: false }).catch((e) => ({ valid: false, message: e.message }))); };
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true); setErr(null);
    try {
      const res: Response = await api(`/v1/decisions/${d.id}/receipt.pdf`, { raw: true });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error?.message ?? `Could not build the receipt (${res.status}).`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `laissez-receipt-${d.id}.pdf`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      track('receipt_pdf_downloaded', { decision: d.id });
    } catch (e) { setErr(e); } finally { setPdfBusy(false); }
  };
  return (
    <>
      <Head title={`Decision ${d.id}`} sub={<>{d.action[0].toUpperCase() + d.action.slice(1)} {money(d.amount, d.asset === 'EURC' || d.asset === 'AVB-EUR' ? 'EUR' : 'USD')} of {d.ticker} for {d.investor_name}{d.counterparty_name ? ` to ${d.counterparty_name}` : ''}{/\.$/.test(d.counterparty_name ?? d.investor_name ?? '') ? '' : '.'} {when(d.created_at)}.</>}
        actions={canSettle ? <PermBtn perm="orders:write" kind="primary" busy={busy} onClick={() => settle(false)}>{busy ? 'Settling' : 'Settle now'}</PermBtn> : d.settlement_id ? <Btn onClick={() => go(`/settlements/${d.settlement_id}`)}>View settlement</Btn> : null} />
      {canSettle ? <PermNote perm="orders:write" /> : null}
      <ErrorBox error={err} />
      {err?.code === 'in_batch' ? <div class="form-actions" style={{ marginBottom: '0.75rem' }}><Btn onClick={() => go(`/batches/${err.detail?.batch_id}`)}>Open the batch</Btn><PermBtn perm="orders:write" kind="primary" busy={busy} onClick={() => settle(true)}>Settle this order alone</PermBtn></div> : null}
      {stl ? <SettlementCard initial={stl} animate /> : null}
      <DecisionPanel d={{ ...d, binding_rules: d.resolved }} />
      <div class="grid2">
        <Card title="Signed receipt" actions={<><Btn kind="ghost" busy={pdfBusy} onClick={downloadPdf}>Download receipt (PDF)</Btn>{d.signature ? <Btn kind="ghost" onClick={doVerify}>Verify signature</Btn> : null}</>}>
          {d.receipt ? <><Json value={d.receipt} /><p class="small mono break">signature: {d.signature}</p></> : <Empty title="Receipt signing is not configured" />}
          {verify ? <p class={`verdict-line ${verify.valid ? 'ok' : 'warn'}`}>{verify.message}</p> : null}
        </Card>
        <div>
          <ReplayCard id={d.id} replayable={d.replayable} />
          {d.action === 'transfer' ? <TravelRuleCard d={d} /> : <Card title="On-chain record"><p>Only three fields would be written on-chain: the outcome, the input hash and the rule-pack versions. No names, no balances.</p><Json value={{ outcome: d.outcome, inputs_sha256: d.inputs_sha256, rule_packs: d.rule_packs }} /></Card>}
        </div>
      </div>
    </>
  );
}

const humanKey = (k: string) => { const s = k.replace(/sha256/g, 'SHA-256').replace(/[._]/g, ' ').trim(); return s[0].toUpperCase() + s.slice(1); };
function hashFields(obj: any, prefix = '', depth = 0): [string, string][] {
  if (!obj || typeof obj !== 'object' || depth > 2) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix} ${k}` : k;
    if (typeof v === 'string' && /hash|sha256|digest/i.test(k)) out.push([key, v]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...hashFields(v, key, depth + 1));
  }
  return out;
}

/** Re-runs a stored decision from its snapshot and checks that it comes out the same. */
function ReplayCard({ id, replayable }: { id: string; replayable?: boolean }) {
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setErr(null); try { setRes(await api(`/v1/decisions/${id}/replay`)); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const ok = res ? !!(res.reproduced ?? res.match) : null;
  const word = (o: string) => (o === 'ALLOW' ? 'Allowed' : o === 'DENY' ? 'Denied' : o === 'FREEZE' ? 'Frozen' : o);
  const extra = res && !('stored_hash' in res) ? hashFields(res) : [];
  return (
    <Card title="Replay" actions={replayable === false ? <Chip>Not replayable</Chip> : <Btn kind="ghost" busy={busy} onClick={run}>{res ? 'Replay again' : 'Replay this decision'}</Btn>}>
      <p class="small muted">{replayable === false ? 'This decision was made before Laissez stored decision snapshots, so it cannot be replayed. Decisions made from now on can.' : 'Laissez re-runs the decision from the inputs stored with it, with the rule-pack versions that applied at the time, then compares the outcome and input hash with the original.'}</p>
      <ErrorBox error={err} />
      {res ? (
        <>
          <p class={`verdict-line ${ok ? 'ok' : 'warn'}`}>{ok ? 'Reproduced. Same outcome, same input hash.' : 'Not reproduced. The replay differs from the original decision.'}</p>
          <dl class="kv wide hashes">
            {res.stored_outcome ? <div><dt>Outcome</dt><dd>{word(res.stored_outcome)} then, {word(res.replayed_outcome).toLowerCase()} on replay</dd></div> : null}
            {res.stored_hash ? <div><dt>Stored hash</dt><dd><Hash value={res.stored_hash} n={16} /></dd></div> : null}
            {res.replayed_hash ? <div><dt>Replayed hash</dt><dd><Hash value={res.replayed_hash} n={16} /></dd></div> : null}
            {(res.rule_packs ?? []).length ? <div><dt>Rule packs</dt><dd class="small">{res.rule_packs.join(', ')}</dd></div> : null}
            {extra.map(([k, v]) => <div><dt>{humanKey(k)}</dt><dd><Hash value={v} n={16} /></dd></div>)}
          </dl>
          {res.live ? (
            <div class="replay-diff">
              <h3>Then and now</h3>
              <p class="small muted">{res.live_note} Live outcome: {word(res.live.outcome)}.</p>
              {(res.diff ?? []).length ? (
                <div class="tw"><table class="t">
                  <thead><tr><th>Check</th><th>At decision</th><th>Now</th></tr></thead>
                  <tbody>{res.diff.map((x: any) => (
                    <tr>
                      <td><strong>{x.label}</strong><div class="small muted">{x.layer}</div></td>
                      <td>{x.before ? <><Chip tone={x.before.result === 'pass' ? 'ok' : x.before.result === 'fail' ? 'no' : 'muted'}>{x.before.result}</Chip><div class="small muted clamp">{x.before.detail}</div></> : <span class="muted small">not evaluated</span>}</td>
                      <td>{x.after ? <><Chip tone={x.after.result === 'pass' ? 'ok' : x.after.result === 'fail' ? 'no' : 'muted'}>{x.after.result}</Chip><div class="small muted clamp">{x.after.detail}</div></> : <span class="muted small">not evaluated</span>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <p class="small">Every check comes out the same today as it did at decision time.</p>}
            </div>
          ) : res.live_note ? <p class="small muted">{res.live_note}</p> : null}
          <details class="more"><summary>Full replay response</summary><Json value={res} /></details>
        </>
      ) : null}
    </Card>
  );
}

function TravelRuleCard({ d }: { d: any }) {
  return <Card title="Travel Rule message (IVMS101)"><p class="muted">Sent between distributors before settlement for transfers of USD/EUR 1,000 or more.</p><Json value={{ originator: d.investor_name, beneficiary: d.counterparty_name, amount: d.amount, asset: d.ticker, standard: 'IVMS101', rule: 'FATF R.16' }} /></Card>;
}

// ---------- Settlement ----------
const STEP_LABEL: Record<string, string> = { decision_signed: 'Settlement instruction signed', cash_locked: 'Cash leg locked', registry_confirmed: 'Registry confirms the claim', atomic_swap: 'Atomic swap', units_locked: 'Units locked', atomic_payout: 'Atomic payout', final: 'Final on chain', submitted: 'Transaction submitted', confirmed: 'Confirmed on chain', travel_rule: 'Travel Rule approved' };
const stepsOf = (s: any): any[] => (Array.isArray(s?.steps) ? s.steps : Array.isArray(s?.steps?.steps) ? s.steps.steps : []);
function txsOf(s: any): string[] {
  const c = s?.chain ?? {};
  const all = [c.tx_hash, c.tx, c.hash, ...(c.tx_hashes ?? []), ...((c.txs ?? []).map((t: any) => t?.hash ?? t)), s?.tx_hash, ...(s?.tx_hashes ?? []), ...stepsOf(s).map((x) => x.tx_hash ?? x.tx)];
  return [...new Set(all.filter((h) => typeof h === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(h)))];
}
const stlChip = (status: string, job?: any): any => status === 'settled' ? <Chip tone="ok">Settled</Chip>
  : status === 'pending' ? (job?.status === 'failed' ? <Chip tone="warn">Pending, job failed</Chip> : job?.status === 'running' ? <Chip tone="info">Sending on chain</Chip> : job?.status === 'queued' && job.attempts > 0 ? <Chip tone="info">Pending, retrying</Chip> : <Chip tone="info">Pending</Chip>)
    : status === 'reverted' ? <Chip tone="no">Reverted</Chip> : status === 'cancelled' ? <Chip>Cancelled</Chip> : <Chip>{status}</Chip>;
const JOB_WORD: Record<string, string> = { queued: 'queued', running: 'running', failed: 'failed', confirmed: 'confirmed', cancelled: 'cancelled' };

/** Retry and Cancel for a settlement, shown only when the API says the action is available right now. */
function SettlementActions({ s, onChange, compact: small }: { s: any; onChange: (next: any) => void; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  if (!s?.retryable && !s?.cancellable) return err ? <ErrorBox error={err} /> : null;
  const run = async (what: 'retry' | 'cancel') => {
    setBusy(what); setErr(null);
    try { const next = await api(`/v1/settlements/${s.id}/${what}`, { body: {} }); onChange(next); track(what === 'retry' ? 'settlement_retried' : 'settlement_cancelled', { settlement: s.id }); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  return (
    <span class="row-inline tight" onClick={(e) => e.stopPropagation()}>
      {s.retryable ? <PermBtn perm="orders:write" kind={small ? 'ghost' : 'primary'} busy={busy === 'retry'} onClick={() => run('retry')}>{busy === 'retry' ? 'Retrying' : 'Retry'}</PermBtn> : null}
      {s.cancellable ? <ConfirmBtn kind="ghost" confirm="Cancel settlement" onConfirm={() => run('cancel')} title="Only possible before anything is sent on chain">Cancel</ConfirmBtn> : null}
      {!small ? <ErrorBox error={err} /> : null}
    </span>
  );
}

/** Shows a settlement and polls it every 2 seconds while it is pending. */
function SettlementCard({ initial, animate, id }: { initial?: any; animate?: boolean; id?: string }) {
  const [s, setS] = useState<any>(initial ?? null);
  const [err, setErr] = useState<any>(null);
  const [shown, setShown] = useState(animate ? 0 : 99);
  const sid = id ?? initial?.id;
  useEffect(() => {
    if (!sid) return;
    let stop = false; let t = 0; let last = initial?.status;
    const tick = async () => {
      try {
        const x = await api(`/v1/settlements/${sid}`);
        if (stop) return;
        setS((prev: any) => ({ ...prev, ...x }));
        setErr(null);
        if (last === 'pending' && x.status === 'settled') track('settlement_completed', { settlement: sid });
        last = x.status;
        if (x.status === 'pending') t = window.setTimeout(tick, x.job?.status === 'failed' ? 10_000 : 2000);
      } catch (e) { if (!stop) { setErr(e); t = window.setTimeout(tick, 4000); } }
    };
    if (!initial || initial.status === 'pending') tick();
    return () => { stop = true; clearTimeout(t); };
  }, [sid]);
  const steps = stepsOf(s);
  useEffect(() => {
    if (!animate || !steps.length) return;
    const ts = steps.map((_, i) => window.setTimeout(() => setShown((n) => Math.max(n, i + 1)), 450 * (i + 1)));
    return () => ts.forEach(clearTimeout);
  }, [steps.length]);
  if (!s) return err ? <ErrorBox error={err} /> : <Loading />;
  const txs = txsOf(s);
  const status = s.status ?? 'pending';
  const simulated = s.simulated ?? s.steps?.simulated;
  const done = (x: any, i: number) => i < shown && (status === 'settled' || x.done === true || ['done', 'confirmed', 'complete'].includes(x.status) || !!x.tx_hash || (status !== 'pending' && status !== 'reverted'));
  return (
    <Card title={`Settlement ${s.id ?? ''}`} actions={<span class="row-inline tight">{stlChip(status, s.job)}<SettlementActions s={s} compact onChange={(next) => setS((prev: any) => ({ ...prev, ...next }))} /></span>}>
      {steps.length ? <ol class="steps2">{steps.map((x: any, i: number) => <li class={done(x, i) ? 'done' : ''}><b>{STEP_LABEL[x.step] ?? x.label ?? x.step}</b><span>{x.block ? `block ${x.block}, ` : ''}{x.at ? new Date(x.at).toLocaleTimeString() : ''}</span></li>)}</ol> : null}
      {status === 'pending' ? (
        s.job?.status === 'failed'
          ? <p class="verdict-line warn">The chain job failed after {s.job.attempts} attempt{s.job.attempts === 1 ? '' : 's'}: {s.job.error ?? 'no reason recorded'}. Retry re-checks the decision and queues it again; Cancel is possible while nothing has been sent.</p>
          : <p class="poll" aria-live="polite"><span class="spin sm" aria-hidden="true" />{s.job ? `Chain job ${JOB_WORD[s.job.status] ?? s.job.status}${s.job.attempts > 1 ? ` (attempt ${s.job.attempts})` : ''}${s.job.error ? `: ${s.job.error}` : ''}.` : s.chain?.status === 'queued' ? 'Queued for the chain.' : s.chain?.status ? `Chain job ${s.chain.status}.` : 'Waiting for the chain.'} Checking every 2 seconds.</p>
      ) : null}
      {status === 'cancelled' ? <p class="verdict-line warn">{s.chain?.reason ?? s.steps?.reason ?? 'Cancelled before anything was sent on chain.'} Nothing moved. Request a new decision to settle this order.</p> : null}
      {txs.length ? (
        <dl class="kv wide">
          <div><dt>Network</dt><dd>{s.chain?.network ?? s.chain?.chain ?? 'Base Sepolia'}</dd></div>
          {txs.map((h, i) => <div><dt>{txs.length > 1 ? `Transaction ${i + 1}` : 'Transaction'}</dt><dd><TxLink hash={h} /></dd></div>)}
          {s.chain?.block ? <div><dt>Block</dt><dd>{Number(s.chain.block).toLocaleString('en-US')}</dd></div> : null}
        </dl>
      ) : null}
      {status === 'reverted' ? <p class="verdict-line warn">{s.chain?.reason ?? s.chain?.error ?? s.steps?.reason ?? s.reason ?? 'A leg failed, so both legs reverted. Nothing moved.'}{s.chain?.stage ? <span class="muted"> (stage: {s.chain.stage})</span> : null}</p> : null}
      {simulated && !txs.length ? <p class="muted small">Simulated on Ethereum timings. Holdings were updated in one database transaction, so both legs moved or neither did.</p> : null}
      {err && status === 'pending' ? <p class="small muted">Could not refresh: {err.message} Retrying.</p> : null}
    </Card>
  );
}

export function SettlementDetail({ id }: { id: string }) {
  const r = useApi(`/v1/settlements/${id}`, [id]);
  const [key, setKey] = useState(0);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const s = r.data;
  const onChange = (next: any) => { r.setData({ ...s, ...next }); setKey((k) => k + 1); };
  return (
    <>
      <Head title={`Settlement ${s.id}`} sub={<>Delivery versus payment for decision <a href={`#/decisions/${s.decision_id}`}><code>{s.decision_id}</code></a>. Both legs move together or neither does.</>}
        actions={<><SettlementActions s={s} onChange={onChange} /><Btn onClick={() => go(`/decisions/${s.decision_id}`)}>View decision</Btn></>} />
      {s.retryable ? <PermNote perm="orders:write" /> : null}
      <SettlementCard key={key} initial={s} id={s.id} />
      {s.job ? (
        <Card title="Chain job">
          <dl class="kv wide">
            <div><dt>Job</dt><dd><code>{s.job.id}</code></dd></div>
            <div><dt>Status</dt><dd>{JOB_WORD[s.job.status] ?? s.job.status}{s.job.attempts ? `, ${s.job.attempts} attempt${s.job.attempts === 1 ? '' : 's'}` : ''}</dd></div>
            {s.job.error ? <div><dt>Last message</dt><dd>{s.job.error}</dd></div> : null}
            {(s.job.tx_hashes ?? []).map((h: string, i: number) => <div><dt>{s.job.tx_hashes.length > 1 ? `Transaction ${i + 1}` : 'Transaction'}</dt><dd><TxLink hash={h} /></dd></div>)}
          </dl>
          <p class="small muted">Every chain job for this organization is listed under <a href="#/chain">On-chain</a>.</p>
        </Card>
      ) : null}
    </>
  );
}

function DecisionTable({ rows }: { rows: any[] }) {
  return (
    <div class="tw"><table class="t">
      <thead><tr><th>Decision</th><th>Action</th><th>Fund</th><th class="r">Amount</th><th>Outcome</th><th>When</th></tr></thead>
      <tbody>{rows.map((d) => <tr class="click" onClick={() => go(`/decisions/${d.id}`)}><td><a href={`#/decisions/${d.id}`}><code>{d.id}</code></a>{d.investor ? <div class="small muted">{d.investor}</div> : null}</td><td>{d.action}</td><td>{d.ticker}</td><td class="r">{Number(d.amount).toLocaleString('en-US')}</td><td>{outcomeChip(d.outcome)}{(d.what_ifs ?? []).length ? <Chip tone="info">What-if</Chip> : null}{d.settlement_id ? <Chip tone="ok">Settled</Chip> : null}</td><td class="muted">{when(d.created_at)}</td></tr>)}</tbody>
    </table></div>
  );
}
export function Decisions() {
  const funds = useApi('/v1/funds');
  const [f, setF] = useState({ outcome: '', fund: '', action: '', from: '', to: '' });
  const r = usePaged(`/v1/decisions${qs(f)}`);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const filtered = Object.values(f).some(Boolean);
  return (
    <>
      <Head title="Decisions" sub="Every pre-trade check placed in this workspace, newest first." actions={<PermBtn perm="orders:write" kind="primary" onClick={() => go('/orders/new')}>New order</PermBtn>} />
      <div class="toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <select value={f.outcome} onChange={(e) => set('outcome', (e.target as HTMLSelectElement).value)} aria-label="Outcome"><option value="">Any outcome</option><option value="ALLOW">Allowed</option><option value="DENY">Denied</option><option value="FREEZE">Frozen</option></select>
        <select value={f.fund} onChange={(e) => set('fund', (e.target as HTMLSelectElement).value)} aria-label="Fund"><option value="">Any fund</option>{(funds.data?.data ?? []).map((x: any) => <option value={x.ticker}>{x.ticker}</option>)}</select>
        <select value={f.action} onChange={(e) => set('action', (e.target as HTMLSelectElement).value)} aria-label="Action"><option value="">Any action</option><option value="subscribe">Subscribe</option><option value="transfer">Transfer</option><option value="redeem">Redeem</option></select>
        <label class="f" style={{ margin: 0 }}><span class="f-l">From</span><input type="date" value={f.from} onInput={(e) => set('from', (e.target as HTMLInputElement).value)} /></label>
        <label class="f" style={{ margin: 0 }}><span class="f-l">To</span><input type="date" value={f.to} onInput={(e) => set('to', (e.target as HTMLInputElement).value)} /></label>
        {filtered ? <Btn kind="ghost" onClick={() => setF({ outcome: '', fund: '', action: '', from: '', to: '' })}>Clear</Btn> : null}
      </div>
      {r.loading && !r.rows.length ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.rows.length ? <><DecisionTable rows={r.rows} /><LoadMore p={r} what="decisions" /></> : <Empty title={filtered ? 'No decisions match these filters' : 'No decisions yet'}>{filtered ? 'Widen the dates or clear the filters.' : 'Place your first order.'}</Empty>}
    </>
  );
}
export function Settlements() {
  const [status, setStatus] = useState('');
  const r = usePaged(`/v1/settlements${qs({ status })}`);
  const update = (next: any) => r.setRows((rows: any[]) => rows.map((x) => (x.id === next.id ? { ...x, ...next } : x)));
  const pending = r.rows.filter((x: any) => x.status === 'pending').length;
  const failed = r.rows.filter((x: any) => x.status === 'pending' && x.job?.status === 'failed').length;
  return (
    <>
      <Head title="Settlements" sub="Atomic delivery versus payment. Both legs or neither. Pending settlements show their chain job; a failed job can be retried or cancelled." />
      <div class="toolbar" style={{ alignItems: 'center' }}>
        <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Status"><option value="">Any status</option><option value="pending">Pending</option><option value="settled">Settled</option><option value="reverted">Reverted</option><option value="cancelled">Cancelled</option></select>
        {pending ? <span class="small muted">{pending} pending on this page{failed ? `, ${failed} with a failed job` : ''}</span> : null}
      </div>
      {r.loading && !r.rows.length ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.rows.length ? (
        <>
          <div class="tw"><table class="t"><thead><tr><th>Settlement</th><th>Decision</th><th>Client</th><th>Action</th><th class="r">Amount</th><th>Status</th><th>When</th><th /></tr></thead>
            <tbody>{r.rows.map((s: any) => (
              <tr class="click" onClick={() => go(`/settlements/${s.id}`)}>
                <td><a href={`#/settlements/${s.id}`}><code>{s.id}</code></a></td>
                <td><a href={`#/decisions/${s.decision_id}`} onClick={(e) => e.stopPropagation()}><code>{s.decision_id}</code></a></td>
                <td>{s.investor}</td><td>{s.action} {s.ticker}</td><td class="r">{Number(s.amount).toLocaleString('en-US')} {s.asset}</td>
                <td>{stlChip(s.status, s.job)}{txsOf(s).length ? <Chip tone="info">On chain</Chip> : null}{s.status === 'pending' && s.job ? <div class="small muted">Job {JOB_WORD[s.job.status] ?? s.job.status}{s.job.attempts > 1 ? `, ${s.job.attempts} attempts` : ''}{s.job.status === 'failed' && s.job.error ? `: ${s.job.error}` : ''}</div> : null}{s.status === 'reverted' && s.chain?.reason ? <div class="small muted clamp">{s.chain.reason}</div> : null}</td>
                <td class="muted">{when(s.created_at)}</td>
                <td class="r"><SettlementActions s={s} compact onChange={update} /></td>
              </tr>
            ))}</tbody></table></div>
          <LoadMore p={r} what="settlements" />
        </>
      ) : <Empty title={status ? `No ${status} settlements` : 'Nothing settled yet'}>Allowed decisions can be settled from their decision page.</Empty>}
    </>
  );
}

// ---------- Bulk eligibility ----------
const SAMPLE = `name,kind,residence,booking_center,classes
Harbourline Capital Pte Ltd,Corporate,SG,HK,SG_AI;HK_PI
Rhein Industrie Treasury GmbH,Corporate,DE,ZRH,EU_PRO;CH_PRO
Aurelia Pensionskasse,Pension fund,CH,ZRH,CH_PRO
Wen Li,Individual,HK,HK,
Al Safa Holdings,Holding company,AE-DIFC,DIFC,DIFC_PRO
Marcus Hale,Individual,US,NY,US_AI`;
function downloadText(name: string, text: string, type = 'text/csv') {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* download blocked */ }
}
export function Bulk() {
  const [csv, setCsv] = useState(SAMPLE);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const jurs = useApi('/v1/jurisdictions');
  const bcs = useApi('/v1/booking-centers');
  const jurList: any[] = (jurs.data?.data ?? []).filter((j: any) => j.code !== 'GLOBAL' && !j.comprehensive_sanctions);
  const bcList: any[] = bcs.data?.data ?? [];
  const rows = useMemo(() => csv.trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const [name, kind, residence, booking_center, classes] = l.split(',').map((x) => (x ?? '').trim()); return { name, kind: kind || 'Corporate', residence, booking_center, classes: (classes || '').split(';').map((c) => c.trim()).filter(Boolean) }; }), [csv]);
  const run = async () => { setBusy(true); setErr(null); try { setRes(await api('/v1/eligibility/bulk', { body: { rows } })); track('bulk_checked', { rows: rows.length }); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const onFile = (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) f.text().then(setCsv); };
  // Template: one example row per jurisdiction the database knows, booked in the matching booking center where there is one.
  const template = () => {
    const bcFor = (code: string) => bcList.find((b) => b.jurisdiction === code)?.id ?? bcList[0]?.id ?? 'SG';
    const classFor = (code: string) => bcList.find((b) => b.jurisdiction === code)?.requires_class ?? '';
    const lines = ['name,kind,residence,booking_center,classes', ...jurList.map((j) => `Example ${j.name.replace(/[,()]/g, '')} client,Corporate,${j.code},${bcFor(j.code)},${classFor(j.code)}`)];
    setCsv(lines.join('\n'));
  };
  const downloadTemplate = () => {
    const header = `# residence codes: ${jurList.map((j) => `${j.code} (${j.name})`).join('; ')}\n# booking centers: ${bcList.map((b) => `${b.id} (${b.name}${b.requires_class ? `, requires ${b.requires_class}` : ''})`).join('; ')}\n`;
    downloadText('laissez-bulk-template.csv', header + csv.trim() + '\n');
  };
  const downloadResults = () => {
    if (!res) return;
    const head = ['row', 'name', 'residence', 'screening_match', ...res.funds.flatMap((f: string) => [`${f}_outcome`, `${f}_reason`, `${f}_binding_rules`])];
    const body = res.data.map((r: any) => [r.row, r.name, r.residence, r.screening ? `${r.screening.entry} (${r.screening.program}, ${Math.round(r.screening.score * 100)}%)` : '', ...r.results.flatMap((x: any) => [x.outcome, x.reason, (x.binding ?? []).join('; ')])]);
    downloadText(`laissez-bulk-results-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...body].map((line: unknown[]) => csvRow(line)).join('\r\n') + '\r\n');
    track('bulk_results_downloaded', { rows: res.data.length });
  };
  const resHint = jurList.length ? jurList.map((j) => j.code).join(', ') : 'SG, HK, CH, DE, AE-DIFC, US';
  const bcHint = bcList.length ? bcList.map((b) => b.id).join(', ') : 'HK, SG, ZRH, DIFC, NY';
  return (
    <>
      <Head title="Bulk eligibility check" sub="Paste or upload a client list and see which funds each client can buy, and why. Nothing is saved except an audit entry." />
      <Card title="Client list (CSV)" actions={<><label class="b b-ghost file">Upload CSV<input type="file" accept=".csv,text/csv" onChange={onFile} /></label><Btn kind="ghost" onClick={template} disabled={!jurList.length} title="One example row per jurisdiction in the database">Template, every jurisdiction</Btn><Btn kind="ghost" onClick={downloadTemplate}>Download CSV</Btn><Btn kind="ghost" onClick={() => setCsv(SAMPLE)}>Load sample</Btn></>}>
        <textarea class="csv" rows={8} value={csv} onInput={(e) => setCsv((e.target as HTMLTextAreaElement).value)} aria-label="CSV input" />
        <p class="muted small">Columns: name, kind, residence ({resHint}), booking_center ({bcHint}), classes separated by semicolons ({Object.keys(CLASS_LABEL).join(', ')}). {rows.length} rows.</p>
        {bcList.length ? <details class="more"><summary class="small">Booking centers and the classification each requires</summary><ul class="small muted" style={{ columns: 2 }}>{bcList.map((b) => <li><code>{b.id}</code> {b.name}, {JUR[b.jurisdiction] ?? b.jurisdiction}{b.requires_class ? `, requires ${CLASS_LABEL[b.requires_class] ?? b.requires_class}` : ''}</li>)}</ul></details> : null}
        <Btn kind="primary" onClick={run} disabled={busy || !rows.length}>{busy ? 'Checking' : `Check ${rows.length} clients`}</Btn>
        <ErrorBox error={err} />
      </Card>
      {res ? (
        <Card title="Results" pad={false} actions={<Btn kind="ghost" onClick={downloadResults}>Download results CSV</Btn>}>
          <div class="tw"><table class="t matrix">
            <thead><tr><th>Client</th>{res.funds.map((f: string) => <th>{f}</th>)}</tr></thead>
            <tbody>{res.data.map((r: any) => <tr><td><strong>{r.name}</strong><div class="small muted">{JUR[r.residence] ?? r.residence}</div>{r.screening ? <div class="small"><Chip tone="warn">Screening match</Chip></div> : null}</td>{r.results.map((x: any) => <td title={x.reason}>{outcomeChip(x.outcome)}<div class="small muted clamp">{x.reason}</div></td>)}</tr>)}</tbody>
          </table></div>
          {res.note ? <p class="small muted" style={{ padding: '0 1.35rem 1rem' }}>{res.note}</p> : null}
        </Card>
      ) : null}
    </>
  );
}
