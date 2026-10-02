/** @jsxImportSource preact */
// Closed-end fund operations on the fund detail page: commitments, the capital call schedule, settling a call
// notice by notice through the ordinary decision path, and distributions back to investors.
import { useState } from 'preact/hooks';
import { api, money, JUR } from '../api';
import { useApi, Chip, ErrorBox, Loading, Empty, Field, Card, go } from '../ui';
import { PermBtn, PermNote } from '../auth';
import { fmtDate } from './fundops';

const val = (e: Event) => (e.target as HTMLInputElement).value;
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '0%');

function callChip(s: string) {
  return s === 'settled' ? <Chip tone="ok">Settled</Chip> : s === 'settling' ? <Chip tone="info">Settling</Chip> : s === 'cancelled' ? <Chip>Cancelled</Chip> : <Chip tone="warn">Issued</Chip>;
}
function noticeChip(s: string) {
  return s === 'settled' ? <Chip tone="ok">Paid in</Chip> : s === 'failed' ? <Chip tone="no">Failed</Chip> : s === 'cancelled' ? <Chip>Cancelled</Chip> : <Chip tone="warn">Due</Chip>;
}

export function Commitments({ ticker, currency, onChange }: { ticker: string; currency: string; onChange?: () => void }) {
  const r = useApi<any>(`/v1/funds/${ticker}/commitments`, [ticker]);
  const clients = useApi<any>('/v1/investors?limit=200');
  const [f, setF] = useState({ investor_id: '', committed: '' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true); setMsg(null);
    try {
      const res = await api(`/v1/funds/${ticker}/commitments`, { body: { investor_id: f.investor_id, committed: Number(f.committed) } });
      setMsg(res.note); setF({ investor_id: '', committed: '' }); r.reload(); onChange?.();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const t = r.data?.totals;
  return (
    <Card title="Commitments" actions={t ? <span class="muted small">{t.investors} investor{t.investors === 1 ? '' : 's'}; {money(t.uncalled, currency)} uncalled</span> : null}>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          {t && t.committed > 0 ? (
            <div class="kpis" style={{ marginBottom: '1rem' }}>
              <div class="kpi"><span>Committed</span><b>{money(t.committed, currency)}</b><em>{t.investors} investor{t.investors === 1 ? '' : 's'}</em></div>
              <div class="kpi"><span>Called</span><b>{money(t.called, currency)}</b><em>{pct(t.called, t.committed)} of commitments</em></div>
              <div class="kpi"><span>Paid in</span><b>{money(t.paid_in, currency)}</b><em>{t.outstanding ? `${money(t.outstanding, currency)} still due` : 'Nothing outstanding'}</em></div>
              <div class="kpi"><span>Returned</span><b>{money(t.distributed, currency)}</b><em>{t.paid_in ? `${pct(t.distributed, t.paid_in)} of paid-in capital` : 'No distributions yet'}</em></div>
            </div>
          ) : null}
          {r.data.data.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>Investor</th><th>Residence</th><th class="r">Committed</th><th class="r">Called</th><th class="r">Paid in</th><th class="r">Uncalled</th><th class="r">Returned</th></tr></thead>
              <tbody>{r.data.data.map((m: any) => (
                <tr class="click" onClick={() => go(`/clients/${m.investor_id}`)}>
                  <td>{m.investor}</td><td class="muted">{JUR[m.residence] ?? m.residence}</td>
                  <td class="r">{money(m.committed, currency)}</td><td class="r">{money(m.called, currency)}</td><td class="r">{money(m.paid_in, currency)}{m.outstanding ? <div class="small muted">{money(m.outstanding, currency)} due</div> : null}</td>
                  <td class="r">{money(m.uncalled, currency)}</td><td class="r">{money(m.distributed, currency)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No commitments yet">Record what each investor has committed. Nothing moves until you issue a capital call.</Empty>}
          {msg ? <div class="note" role="status" style={{ marginTop: '0.8rem' }}>{msg}</div> : null}
          <form onSubmit={save} style={{ marginTop: '1rem' }}>
            <div class="form-grid">
              <Field label="Investor">
                <select required value={f.investor_id} onChange={(e) => setF({ ...f, investor_id: val(e) })}>
                  <option value="">Choose a client</option>
                  {(clients.data?.data ?? []).map((i: any) => <option value={i.id}>{i.name} ({JUR[i.residence] ?? i.residence})</option>)}
                </select>
              </Field>
              <Field label={`Commitment (${currency})`} hint="Replaces an existing commitment for the same investor. It cannot go below what has already been called."><input required type="number" min="1" step="any" value={f.committed} onInput={(e) => setF({ ...f, committed: val(e) })} /></Field>
            </div>
            <div class="form-actions"><PermBtn perm="funds:write" type="submit" kind="primary" busy={busy}>Record commitment</PermBtn></div>
          </form>
          <ErrorBox error={err} />
          <PermNote perm="funds:write" />
        </>
      )}
    </Card>
  );
}

export function CapitalCalls({ ticker, currency, onChange }: { ticker: string; currency: string; onChange?: () => void }) {
  const r = useApi<any>(`/v1/funds/${ticker}/capital-calls`, [ticker]);
  const [f, setF] = useState({ pct: '25', due_on: addDaysISO(todayISO(), 10) });
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const changed = (m?: string) => { if (m) setMsg(m); r.reload(); onChange?.(); };
  const issue = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy('issue'); setMsg(null);
    try { const res = await api(`/v1/funds/${ticker}/capital-calls`, { body: { pct: Number(f.pct), due_on: f.due_on } }); setOpen(res.id); changed(res.note); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const settle = async (id: string, retry = false) => {
    setErr(null); setBusy(id); setMsg(null);
    try {
      let res = await api(`/v1/capital-calls/${id}/settle`, { body: { limit: 10, retry_failed: retry } });
      // Keep going while notices remain, so one click settles the whole call.
      while (res.run?.remaining > 0) res = await api(`/v1/capital-calls/${id}/settle`, { body: { limit: 10 } });
      setOpen(id); changed(res.note);
    } catch (x) { setErr(x); r.reload(); } finally { setBusy(null); }
  };
  const cancel = async (id: string) => {
    setErr(null); setBusy(id);
    try { const res = await api(`/v1/capital-calls/${id}/cancel`, { body: {} }); changed(res.note); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const calls: any[] = r.data?.data ?? [];
  const live = calls.some((k) => k.status === 'issued' || k.status === 'settling');
  const t = r.data?.totals;
  const preview = t && f.pct ? Math.min(t.uncalled, (t.committed * Number(f.pct)) / 100) : 0;
  return (
    <Card title="Capital calls" actions={r.data ? <span class="muted small">{r.data.note}</span> : null}>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          {msg ? <div class="note" role="status">{msg}</div> : null}
          {calls.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>Call</th><th>Issued</th><th>Due</th><th class="r">Called</th><th class="r">Paid in</th><th>Status</th><th></th></tr></thead>
              <tbody>{calls.map((k) => (
                <>
                  <tr class="click" onClick={() => setOpen(open === k.id ? null : k.id)} aria-expanded={open === k.id}>
                    <td><strong>Call {k.call_number}</strong><div class="small muted">{k.pct}% of commitments</div></td>
                    <td class="muted">{fmtDate(k.created_at)}</td><td>{fmtDate(k.due_on)}</td>
                    <td class="r">{money(k.total_called, currency)}</td>
                    <td class="r">{money(k.paid_in, currency)}<div class="small muted">{k.settled_notices} of {k.notices} notices{k.failed_notices ? `, ${k.failed_notices} failed` : ''}</div></td>
                    <td>{callChip(k.status)}</td>
                    <td class="r nowrap" onClick={(e) => e.stopPropagation()}>
                      {k.status === 'issued' || k.status === 'settling' ? <PermBtn perm="orders:write" kind="primary" busy={busy === k.id} onClick={() => settle(k.id, k.failed_notices > 0)}>{k.failed_notices > 0 && k.settled_notices + k.failed_notices === k.notices ? 'Retry failed notices' : 'Settle notices'}</PermBtn> : null}
                      {k.status === 'issued' || k.status === 'settling' ? <> <PermBtn perm="funds:write" kind="ghost" busy={busy === k.id} onClick={() => cancel(k.id)}>Cancel</PermBtn></> : null}
                    </td>
                  </tr>
                  {open === k.id ? <tr><td colSpan={7} style={{ padding: 0 }}><CallNotices id={k.id} currency={currency} /></td></tr> : null}
                </>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No capital calls yet">Issue a call to draw a percentage of every commitment. Each investor gets a notice that settles through the normal decision and settlement path.</Empty>}
          <form onSubmit={issue} style={{ marginTop: '1rem' }}>
            <div class="form-grid">
              <Field label="Percentage of each commitment" hint={t ? `About ${money(Math.round(preview), currency)} across ${t.investors} investor${t.investors === 1 ? '' : 's'}, never beyond what is uncalled.` : undefined}><input required type="number" min="0.01" max="100" step="any" value={f.pct} onInput={(e) => setF({ ...f, pct: val(e) })} /></Field>
              <Field label="Due date"><input required type="date" min={todayISO()} value={f.due_on} onInput={(e) => setF({ ...f, due_on: val(e) })} /></Field>
            </div>
            <div class="form-actions">
              <PermBtn perm="funds:write" type="submit" kind="primary" busy={busy === 'issue'} disabled={live || !t?.uncalled}>Issue call {r.data?.next_call_number ?? ''}</PermBtn>
              {live ? <span class="small muted">Settle or cancel the open call before issuing another.</span> : !t?.uncalled ? <span class="small muted">Record commitments first.</span> : null}
            </div>
          </form>
          <ErrorBox error={err} />
        </>
      )}
    </Card>
  );
}

function CallNotices({ id, currency }: { id: string; currency: string }) {
  const r = useApi<any>(`/v1/capital-calls/${id}`, [id]);
  if (r.loading && !r.data) return <div class="pad"><Loading /></div>;
  if (r.error) return <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div>;
  const c = r.data;
  return (
    <div style={{ padding: '0.5rem 1rem 1rem', background: 'var(--paper-sunk, #f5f2ec)' }}>
      <p class="small muted" style={{ margin: '0.4rem 0 0.6rem' }}>{c.summary.settled} paid in, {c.summary.issued} due, {c.summary.failed} failed. {money(c.summary.paid_in, currency)} received of {money(c.total_called, currency)} called.</p>
      <div class="tw"><table class="t small">
        <thead><tr><th>Investor</th><th class="r">Amount</th><th>Status</th><th>Decision</th><th>Detail</th></tr></thead>
        <tbody>{c.notices.map((n: any) => (
          <tr>
            <td><a href={`#/clients/${n.investor_id}`}>{n.investor}</a></td>
            <td class="r">{money(n.amount, currency)}</td>
            <td>{noticeChip(n.status)}</td>
            <td>{n.decision_id ? <a href={`#/decisions/${n.decision_id}`} class="mono small">{n.decision_id}</a> : <span class="muted">None yet</span>}</td>
            <td class="small">{n.status === 'failed' ? <span style={{ color: 'var(--red, #b3261e)' }}>{n.error}</span> : n.status === 'settled' ? <span class="muted">Settled {fmtDate(n.settled_at)}{n.settlement_id ? <>, <a href={`#/settlements/${n.settlement_id}`} class="mono">{n.settlement_id}</a></> : ''}</span> : <span class="muted">Due {fmtDate(n.due_on)}</span>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

export function CapitalDistributions({ ticker, currency, onChange }: { ticker: string; currency: string; onChange?: () => void }) {
  const r = useApi<any>(`/v1/funds/${ticker}/capital-distributions`, [ticker]);
  const [f, setF] = useState({ amount: '', kind: 'return_of_capital' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<any>(null);
  const pay = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { const res = await api(`/v1/funds/${ticker}/capital-distributions`, { body: { amount: Number(f.amount), kind: f.kind } }); setLast(res); setF({ ...f, amount: '' }); r.reload(); onChange?.(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Distributions to investors">
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          {r.data.data.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>Paid</th><th>Kind</th><th class="r">Amount</th><th class="r">Investors</th></tr></thead>
              <tbody>{r.data.data.map((d: any) => <tr><td>{fmtDate(d.paid_on)}</td><td>{d.kind === 'return_of_capital' ? 'Return of capital' : 'Income'}</td><td class="r">{money(d.total_amount, currency)}</td><td class="r">{d.investors}</td></tr>)}</tbody>
            </table></div>
          ) : <Empty title="Nothing distributed yet">Return capital or pay income pro rata to what each investor has paid in.</Empty>}
          {last ? (
            <div class="note" role="status" style={{ marginTop: '0.8rem' }}>
              {last.note}
              <ul class="plain small" style={{ marginTop: '0.4rem' }}>{last.lines.map((l: any) => <li>{l.investor}: {money(l.amount, currency)}</li>)}</ul>
            </div>
          ) : null}
          <form onSubmit={pay} style={{ marginTop: '1rem' }}>
            <div class="form-grid">
              <Field label={`Amount (${currency})`}><input required type="number" min="1" step="any" value={f.amount} onInput={(e) => setF({ ...f, amount: val(e) })} /></Field>
              <Field label="Kind" hint="Return of capital reduces what is outstanding to each investor. Income is recorded without touching paid-in capital.">
                <select value={f.kind} onChange={(e) => setF({ ...f, kind: val(e) })}><option value="return_of_capital">Return of capital</option><option value="income">Income</option></select>
              </Field>
            </div>
            <div class="form-actions"><PermBtn perm="funds:write" type="submit" kind="primary" busy={busy}>Record distribution</PermBtn></div>
          </form>
          <ErrorBox error={err} />
        </>
      )}
    </Card>
  );
}

/** Everything a closed-end fund shows in place of dealing, NAV and income. */
export function ClosedEndOps({ ticker, currency, onChange }: { ticker: string; currency: string; onChange?: () => void }) {
  return (
    <>
      <div class="note">This is a closed-end fund. Investors commit capital and pay it in when a call is issued; a free subscription is refused by the engine. Each call notice settles through the same decision and settlement path as any order, so every check and receipt applies.</div>
      <Commitments ticker={ticker} currency={currency} onChange={onChange} />
      <CapitalCalls ticker={ticker} currency={currency} onChange={onChange} />
      <CapitalDistributions ticker={ticker} currency={currency} onChange={onChange} />
    </>
  );
}
