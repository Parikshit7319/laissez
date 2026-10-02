/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, money, compact, when, JUR, CLASS_LABEL, BOOKING } from '../api';
import { useApi, Head, Btn, Chip, outcomeChip, statusChip, ErrorBox, Loading, Empty, Field, Card, Json, go, Copy } from '../ui';
import { Credential } from '../../proto/Credential';
import { TESTS, findTest, subjectOf } from '../../proto/thresholds';
import { WHAT_IFS } from '../../proto/engine';

// ---------- Overview ----------
export function Overview() {
  const m = useApi('/v1/metrics');
  const a = useApi('/v1/audit-events');
  if (m.loading && !m.data) return <Loading />;
  if (m.error) return <ErrorBox error={m.error} onRetry={m.reload} />;
  const d = m.data;
  const days = [...new Set((d.daily as any[]).map((r) => r.day))];
  const byDay = days.map((day) => ({ day, allow: d.daily.find((r: any) => r.day === day && r.outcome === 'ALLOW')?.n ?? 0, deny: d.daily.filter((r: any) => r.day === day && r.outcome !== 'ALLOW').reduce((s: number, r: any) => s + r.n, 0) }));
  const max = Math.max(1, ...byDay.map((x) => x.allow + x.deny));
  const settledUsd = (d.settled_value as any[]).find((x) => x.currency === 'USD');
  const settledEur = (d.settled_value as any[]).find((x) => x.currency === 'EUR');
  return (
    <>
      <Head title="Overview" sub="Live numbers from this sandbox. Every order you place below shows up here." actions={<><Btn kind="primary" onClick={() => go('/orders/new')}>New order</Btn><Btn onClick={() => go('/clients')}>Clients</Btn></>} />
      <div class="kpis">
        <div class="kpi"><span>Decisions</span><b>{d.totals.decisions}</b><em>{d.totals.allowed} allowed, {d.totals.denied} denied, {d.totals.frozen} frozen</em></div>
        <div class="kpi"><span>Allow rate</span><b>{d.totals.allow_rate === null ? 'No orders yet' : `${Math.round(d.totals.allow_rate * 100)}%`}</b><em>share of pre-trade checks that passed</em></div>
        <div class="kpi"><span>Value settled</span><b>{settledUsd ? compact(settledUsd.value) : '$0'}{settledEur ? ` + ${compact(settledEur.value, 'EUR')}` : ''}</b><em>{(d.settled_value as any[]).reduce((s, x) => s + x.n, 0)} atomic settlements</em></div>
        <div class="kpi"><span>Credential reuse</span><b>{d.credential_reuse.rate === null ? 'No data yet' : `${Math.round(d.credential_reuse.rate * 100)}%`}</b><em>clients cleared for 2 or more funds on one credential</em></div>
        <div class="kpi"><span>Expiring in 30 days</span><b>{d.credentials_expiring_30d}</b><em>credentials to renew</em></div>
      </div>
      <div class="grid2">
        <Card title="Decisions per day">
          {byDay.length ? (
            <div class="bars" role="img" aria-label="Decisions per day, allowed versus refused">
              {byDay.map((x) => (
                <div class="bar-col" title={`${x.day}: ${x.allow} allowed, ${x.deny} refused`}>
                  <div class="bar-stack" style={{ height: `${((x.allow + x.deny) / max) * 100}%` }}>
                    <span class="seg-deny" style={{ flex: x.deny }} /><span class="seg-allow" style={{ flex: x.allow }} />
                  </div>
                  <small>{x.day.slice(5)}</small>
                </div>
              ))}
            </div>
          ) : <Empty title="No decisions yet">Place an order to see it here.</Empty>}
          <div class="legend"><span><i class="lg-allow" />Allowed</span><span><i class="lg-deny" />Denied or frozen</span></div>
        </Card>
        <Card title="Top refusal reasons">
          {(d.top_refusal_reasons as any[]).length ? (
            <ol class="reasons">{d.top_refusal_reasons.map((r: any) => <li><span>{r.label}</span><b>{r.n}</b></li>)}</ol>
          ) : <Empty title="No refusals yet">Try an order that should fail, like Mei Tan buying Tidewell.</Empty>}
        </Card>
      </div>
      <Card title="Recent activity" actions={<Btn kind="ghost" onClick={() => go('/audit')}>Audit log</Btn>}>
        {a.data ? <ul class="feed">{(a.data.data as any[]).slice(0, 8).map((e) => <li><code>{e.type}</code><span>{e.subject}</span><time>{when(e.created_at)}</time></li>)}</ul> : <Loading />}
      </Card>
    </>
  );
}

// ---------- Clients ----------
export function Clients() {
  const r = useApi('/v1/investors');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const rows = (r.data?.data ?? []).filter((i: any) => !q || `${i.name} ${i.residence_name} ${i.kind}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Head title="Clients" sub="Investors you have onboarded. Each holds at most one active Laissez-passer." actions={<Btn kind="primary" onClick={() => setAdding(true)}>Add client</Btn>} />
      {adding ? <AddClient onDone={(id) => { setAdding(false); if (id) go(`/clients/${id}`); else r.reload(); }} /> : null}
      <div class="toolbar"><input class="search" placeholder="Search by name, country or type" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search clients" /></div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <div class="tw"><table class="t">
          <thead><tr><th>Client</th><th>Type</th><th>Residence</th><th>Booked in</th><th>Credential</th><th>Classifications</th></tr></thead>
          <tbody>{rows.map((i: any) => (
            <tr class="click" onClick={() => go(`/clients/${i.id}`)}>
              <td><a href={`#/clients/${i.id}`}>{i.name}</a></td><td>{i.kind}</td><td>{i.residence_name}</td><td>{BOOKING[i.booking] ?? i.booking}</td>
              <td>{i.credential_status === 'active' ? <Chip tone="ok">Active</Chip> : i.credential_status === 'none' ? <Chip>None</Chip> : <Chip tone="warn">{i.credential_status === 'lapsed' ? 'Lapsed' : 'Partly lapsed'}</Chip>}</td>
              <td class="muted">{i.classifications.map((c: any) => CLASS_LABEL[c.code] ?? c.code).join(', ') || 'KYC only'}</td>
            </tr>
          ))}</tbody>
        </table></div>
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
        <Field label="Residence"><select value={f.residence} onChange={(e) => set('residence', (e.target as HTMLSelectElement).value)}>{['SG', 'HK', 'CH', 'DE', 'AE-DIFC', 'US', 'GB'].map((j) => <option value={j}>{JUR[j]}</option>)}</select></Field>
        <Field label="City"><input required value={f.city} onInput={(e) => set('city', (e.target as HTMLInputElement).value)} /></Field>
        <Field label="Booking center"><select value={f.booking_center} onChange={(e) => set('booking_center', (e.target as HTMLSelectElement).value)}>{Object.entries(BOOKING).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
        <Field label="U.S. person"><label class="check"><input type="checkbox" checked={f.us_person || f.residence === 'US'} disabled={f.residence === 'US'} onChange={(e) => set('us_person', (e.target as HTMLInputElement).checked)} /> Resident in the United States (Regulation S)</label></Field>
        <div class="form-actions"><Btn type="submit" kind="primary" disabled={busy}>{busy ? 'Saving' : 'Add client'}</Btn><Btn kind="ghost" onClick={() => onDone()}>Cancel</Btn></div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

export function ClientDetail({ id }: { id: string }) {
  const r = useApi(`/v1/investors/${id}`, [id]);
  const [msg, setMsg] = useState<string | null>(null);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const i = r.data;
  const revoke = async () => { try { await api(`/v1/credentials/${i.credentialId}/revoke`, { body: {} }); setMsg('Credential revoked. Holdings move to redemption-only.'); r.reload(); } catch (e: any) { setMsg(e.message); } };
  return (
    <>
      <Head title={i.name} sub={<>{i.kind}, {i.city}. Resident in {JUR[i.residence]}, booked in {BOOKING[i.booking]}.</>} actions={<><Btn kind="primary" onClick={() => go(`/orders/new?investor=${i.id}`)}>New order</Btn><Btn onClick={() => go(`/clients/${i.id}/credential`)}>{i.credentialId ? 'Renew credential' : 'Issue credential'}</Btn>{i.credentialId ? <Btn kind="danger" onClick={revoke}>Revoke</Btn> : null}</>} />
      {msg ? <div class="note">{msg}</div> : null}
      <div class="grid2">
        <div class="app">{i.credentialId ? <Credential inv={i} /> : <Empty title="No credential yet">Issue a Laissez-passer to record this client’s classifications.</Empty>}</div>
        <Card title="Holdings">
          {i.holdings_detail.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>Fund</th><th class="r">Units</th><th class="r">Value</th><th>Status</th></tr></thead>
              <tbody>{i.holdings_detail.map((h: any) => <tr><td>{h.fund} <span class="muted">{h.ticker}</span>{h.lockup_ends ? <div class="muted small">Lock-up to {h.lockup_ends}</div> : null}</td><td class="r">{h.units.toLocaleString('en-US')}</td><td class="r">{money(h.value, h.currency)}</td><td title={h.reason}>{statusChip(h.status)}</td></tr>)}</tbody>
            </table></div>
          ) : <Empty title="No holdings">Subscribe to a fund to create one.</Empty>}
        </Card>
      </div>
      <Card title="Recent decisions">
        {i.recent_decisions.length ? <DecisionTable rows={i.recent_decisions} /> : <Empty title="No decisions yet" />}
      </Card>
    </>
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
      await api('/v1/credentials', { body: { investor_id: inv.id, valid_months: months, classifications: Object.entries(sel).map(([class_code, s]) => ({ class_code, evidence: s.evidence, evidence_ref: s.ref || undefined })) } });
      go(`/clients/${inv.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const relevant = new Set([inv.residence === 'AE-DIFC' ? 'DIFC' : inv.residence, inv.booking === 'DIFC' ? 'DIFC' : inv.booking === 'ZRH' ? 'CH' : inv.booking === 'NY' ? 'US' : inv.booking]);
  return (
    <>
      <Head title={`${inv.credentialId ? 'Renew' : 'Issue'} credential`} sub={<>For {inv.name}. Each classification is checked against its legal threshold before anything is issued. {inv.credentialId ? `This replaces ${inv.credentialId}.` : ''}</>} />
      <Card title="1. Choose classifications">
        <div class="pick">
          {available.map((t) => {
            const jur = t.code.split('_')[0];
            return <label class={`pick-i ${sel[t.code] ? 'on' : ''}`}><input type="checkbox" checked={!!sel[t.code]} onChange={() => toggle(t.code)} /><span>{CLASS_LABEL[t.code]}</span>{relevant.has(jur === 'EU' ? 'DE' : jur) ? <Chip tone="info">Relevant</Chip> : null}</label>;
          })}
        </div>
      </Card>
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
          <Btn kind="primary" disabled={!allPass || busy} onClick={submit}>{busy ? 'Issuing' : 'Issue Laissez-passer'}</Btn>
          {!allPass ? <span class="muted">Every selected classification must meet its threshold.</span> : null}
        </div>
        <ErrorBox error={err} />
      </Card>
    </>
  );
}

// ---------- Order ticket with live pre-trade decision ----------
export function NewOrder({ params }: { params: URLSearchParams }) {
  const invs = useApi('/v1/investors');
  const funds = useApi('/v1/funds');
  const [o, setO] = useState({ action: 'subscribe', investor_id: params.get('investor') ?? 'lumen', fund: 'TWLF', amount: 2_000_000, settle_with: 'USDC', counterparty_id: 'qamar', what_ifs: [] as string[] });
  const [live, setLive] = useState<any>(null);
  const [liveErr, setLiveErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>(0);
  const fund = (funds.data?.data ?? []).find((f: any) => f.ticker === o.fund);
  useEffect(() => { if (fund && !fund.assets.includes(o.settle_with)) setO((x) => ({ ...x, settle_with: fund.assets[0] })); }, [o.fund, funds.data]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const b: any = { ...o, persist: false }; if (o.action !== 'transfer') delete b.counterparty_id;
      api('/v1/decisions', { body: b }).then((d) => { setLive(d); setLiveErr(null); }).catch((e) => { setLiveErr(e); setLive(null); });
    }, 350);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(o)]);
  const place = async () => {
    setBusy(true);
    try { const b: any = { ...o }; if (o.action !== 'transfer') delete b.counterparty_id; const d = await api('/v1/decisions', { body: b }); go(`/decisions/${d.id}`); }
    catch (e) { setLiveErr(e); } finally { setBusy(false); }
  };
  const set = (k: string, v: any) => setO({ ...o, [k]: v });
  if ((invs.loading && !invs.data) || (funds.loading && !funds.data)) return <Loading />;
  return (
    <>
      <Head title="New order" sub="The decision updates as you type. Nothing is recorded until you place the order." />
      <div class="grid-order">
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
          <div class="form-actions"><Btn kind="primary" disabled={busy || !live} onClick={place}>{busy ? 'Placing' : 'Place order'}</Btn>{o.what_ifs.length ? <span class="muted">What-ifs make the decision hypothetical: it records, but cannot settle.</span> : null}</div>
        </Card>
        <div>
          <ErrorBox error={liveErr} />
          {live ? <DecisionPanel d={live} /> : !liveErr ? <Loading label="Checking" /> : null}
        </div>
      </div>
    </>
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
  const [step, setStep] = useState(0);
  const [err, setErr] = useState<any>(null);
  const [verify, setVerify] = useState<any>(null);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const canSettle = d.outcome === 'ALLOW' && !(d.what_ifs ?? []).length && !d.settlement_id && !stl && Date.now() - new Date(d.created_at).getTime() < 15 * 60_000;
  const settle = async () => {
    setErr(null);
    try { const s = await api('/v1/settlements', { body: { decision_id: d.id } }); setStl(s); s.steps.forEach((_: any, i: number) => setTimeout(() => setStep(i + 1), 450 * (i + 1))); }
    catch (e) { setErr(e); }
  };
  const doVerify = async () => { setVerify(await api('/v1/receipts/verify', { body: { receipt: d.receipt, signature: d.signature }, auth: false }).catch((e) => ({ valid: false, message: e.message }))); };
  const labels: Record<string, string> = { decision_signed: 'Decision signed', cash_locked: 'Cash leg locked', registry_confirmed: 'Registry confirms the claim', atomic_swap: 'Atomic swap', units_locked: 'Units locked', atomic_payout: 'Atomic payout', final: 'Final on Ethereum' };
  return (
    <>
      <Head title={`Decision ${d.id}`} sub={<>{d.action[0].toUpperCase() + d.action.slice(1)} {money(d.amount, d.asset === 'EURC' || d.asset === 'AVB-EUR' ? 'EUR' : 'USD')} of {d.ticker} for {d.investor_name}{d.counterparty_name ? ` to ${d.counterparty_name}` : ''}. {when(d.created_at)}.</>} actions={canSettle ? <Btn kind="primary" onClick={settle}>Settle now</Btn> : d.settlement_id ? <Chip tone="ok">Settled</Chip> : null} />
      <ErrorBox error={err} />
      {stl ? (
        <Card title="Settlement" actions={<Chip tone={step >= stl.steps.length ? 'ok' : 'info'}>{step >= stl.steps.length ? 'Settled' : 'Settling'}</Chip>}>
          <ol class="steps2">{stl.steps.map((s: any, i: number) => <li class={step > i ? 'done' : ''}><b>{labels[s.step] ?? s.step}</b><span>{s.block ? `block ${s.block}, ` : ''}{new Date(s.at).toLocaleTimeString()}</span></li>)}</ol>
          <p class="muted small">Simulated on Ethereum timings. Holdings were updated in one database transaction, so both legs moved or neither did.</p>
        </Card>
      ) : null}
      <DecisionPanel d={{ ...d, binding_rules: d.resolved }} />
      <div class="grid2">
        <Card title="Signed receipt" actions={d.signature ? <Btn kind="ghost" onClick={doVerify}>Verify signature</Btn> : null}>
          {d.receipt ? <><Json value={d.receipt} /><p class="small mono break">signature: {d.signature}</p></> : <Empty title="Receipt signing is not configured" />}
          {verify ? <p class={`verdict-line ${verify.valid ? 'ok' : 'warn'}`}>{verify.message}</p> : null}
        </Card>
        {d.action === 'transfer' ? <TravelRuleCard d={d} /> : <Card title="On-chain record"><p>Only three fields would be written on-chain: the outcome, the input hash and the rule-pack versions. No names, no balances.</p><Json value={{ outcome: d.outcome, inputs_sha256: d.inputs_sha256, rule_packs: d.rule_packs }} /></Card>}
      </div>
    </>
  );
}
function TravelRuleCard({ d }: { d: any }) {
  return <Card title="Travel Rule message (IVMS101)"><p class="muted">Sent between distributors before settlement for transfers of USD/EUR 1,000 or more.</p><Json value={{ originator: d.investor_name, beneficiary: d.counterparty_name, amount: d.amount, asset: d.ticker, standard: 'IVMS101', rule: 'FATF R.16' }} /></Card>;
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
  const r = useApi('/v1/decisions');
  return <><Head title="Decisions" sub="Every pre-trade check placed in this sandbox, newest first." actions={<Btn kind="primary" onClick={() => go('/orders/new')}>New order</Btn>} />{r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : r.data.data.length ? <DecisionTable rows={r.data.data} /> : <Empty title="No decisions yet">Place your first order.</Empty>}</>;
}
export function Settlements() {
  const r = useApi('/v1/settlements');
  return (
    <>
      <Head title="Settlements" sub="Atomic delivery versus payment. Both legs or neither." />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : r.data.data.length ? (
        <div class="tw"><table class="t"><thead><tr><th>Settlement</th><th>Decision</th><th>Client</th><th>Action</th><th class="r">Amount</th><th>Status</th><th>When</th></tr></thead>
          <tbody>{r.data.data.map((s: any) => <tr><td><code>{s.id}</code></td><td><a href={`#/decisions/${s.decision_id}`}><code>{s.decision_id}</code></a></td><td>{s.investor}</td><td>{s.action} {s.ticker}</td><td class="r">{Number(s.amount).toLocaleString('en-US')} {s.asset}</td><td>{s.status === 'settled' ? <Chip tone="ok">Settled</Chip> : <Chip tone="no">Reverted</Chip>}</td><td class="muted">{when(s.created_at)}</td></tr>)}</tbody></table></div>
      ) : <Empty title="Nothing settled yet">Allowed decisions can be settled from their decision page.</Empty>}
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
export function Bulk() {
  const [csv, setCsv] = useState(SAMPLE);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => csv.trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const [name, kind, residence, booking_center, classes] = l.split(',').map((x) => (x ?? '').trim()); return { name, kind: kind || 'Corporate', residence, booking_center, classes: (classes || '').split(';').map((c) => c.trim()).filter(Boolean) }; }), [csv]);
  const run = async () => { setBusy(true); setErr(null); try { setRes(await api('/v1/eligibility/bulk', { body: { rows } })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const onFile = (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) f.text().then(setCsv); };
  return (
    <>
      <Head title="Bulk eligibility check" sub="Paste or upload a client list and see which funds each client can buy, and why. Nothing is saved except an audit entry." />
      <Card title="Client list (CSV)" actions={<><label class="b b-ghost file">Upload CSV<input type="file" accept=".csv,text/csv" onChange={onFile} /></label><Btn kind="ghost" onClick={() => setCsv(SAMPLE)}>Load sample</Btn></>}>
        <textarea class="csv" rows={8} value={csv} onInput={(e) => setCsv((e.target as HTMLTextAreaElement).value)} aria-label="CSV input" />
        <p class="muted small">Columns: name, kind, residence (SG, HK, CH, DE, AE-DIFC, US), booking_center (HK, SG, ZRH, DIFC, NY), classes separated by semicolons (SG_AI, HK_PI, EU_PRO, CH_PRO, DIFC_PRO, US_AI). {rows.length} rows.</p>
        <Btn kind="primary" onClick={run} disabled={busy || !rows.length}>{busy ? 'Checking' : `Check ${rows.length} clients`}</Btn>
        <ErrorBox error={err} />
      </Card>
      {res ? (
        <Card title="Results" pad={false}>
          <div class="tw"><table class="t matrix">
            <thead><tr><th>Client</th>{res.funds.map((f: string) => <th>{f}</th>)}</tr></thead>
            <tbody>{res.data.map((r: any) => <tr><td><strong>{r.name}</strong><div class="small muted">{JUR[r.residence] ?? r.residence}</div></td>{r.results.map((x: any) => <td title={x.reason}>{outcomeChip(x.outcome)}<div class="small muted clamp">{x.reason}</div></td>)}</tr>)}</tbody>
          </table></div>
        </Card>
      ) : null}
    </>
  );
}
