/** @jsxImportSource preact */
// Check: the one job the app is built around. Pick a client, a fund and an amount, and the verdict
// appears as you type. Nothing is recorded until "Place this order". Refusals come with the fix as the
// primary action when the fix is a screen in the app.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, money, when, track, trackOnce } from '../api';
import { Btn, Chip, ErrorBox, Loading, Empty, outcomeChip, go } from '../ui';
import { PermBtn, PermNote, useMe } from '../auth';
import type { RouteProps } from '../registry';

// ---------- Session cache: clients and funds are fetched once per page load, in parallel ----------
let cachedInvestors: Promise<any[]> | null = null;
let cachedFunds: Promise<any[]> | null = null;
const loadInvestors = () => (cachedInvestors ??= api('/v1/investors?limit=200').then((d) => d.data ?? []).catch((e) => { cachedInvestors = null; throw e; }));
const loadFunds = () => (cachedFunds ??= api('/v1/funds').then((d) => d.data ?? []).catch((e) => { cachedFunds = null; throw e; }));
/** Called after a client or fund changes elsewhere so the next Check reads fresh lists. */
export const invalidateCheckCache = () => { cachedInvestors = null; cachedFunds = null; };

type Inv = { id: string; name: string; residence_name?: string; kind?: string; credential_status?: string };
type Fund = { ticker: string; short: string; name: string; currency: string; nav: number; assets: string[] };

const ACTIONS: { id: 'subscribe' | 'transfer' | 'redeem'; label: string }[] = [{ id: 'subscribe', label: 'Subscribe' }, { id: 'transfer', label: 'Transfer' }, { id: 'redeem', label: 'Redeem' }];
const VERDICT: Record<string, { word: string; cls: string }> = { ALLOW: { word: 'Admitted', cls: 'allow' }, DENY: { word: 'Refused', cls: 'deny' }, FREEZE: { word: 'Held', cls: 'hold' } };
const LAYERS = ['Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Documents', 'Fund terms', 'Transfer controls', 'Counterparty', 'Global screens'];

/** Where a remedy sentence leads inside the app, when it leads somewhere. */
function remedyAction(remedies: string[], o: { investor_id: string; fund: string }, live: any): { label: string; go?: string; kind?: 'waitlist' } | null {
  const text = remedies.join(' ');
  if (live?.waitlist_eligible) return { label: 'Join the waitlist', kind: 'waitlist' };
  if (/issue a credential|renew the credential|re-verify|issue your own credential|classify the client as/i.test(text)) return { label: /renew|re-verify/i.test(text) ? 'Renew the credential' : 'Issue a credential', go: `/clients/${o.investor_id}/credential` };
  if (/approve the share|share again/i.test(text)) return { label: 'Open the network', go: '/network' };
  if (/acknowledg|to the investor in the portal/i.test(text)) return { label: 'Acknowledge documents', go: `/funds/${o.fund}` };
  if (/suitability|reassess/i.test(text)) return { label: 'Record suitability', go: `/clients/${o.investor_id}` };
  if (/tax profile|W-8|W-9/i.test(text)) return { label: 'Record the tax profile', go: `/clients/${o.investor_id}` };
  if (/record the (investor|client)'s/i.test(text)) return { label: 'Open the client', go: `/clients/${o.investor_id}` };
  if (/distribution list|policy change|raise it/i.test(text)) return { label: 'Open the fund policy', go: `/funds/${o.fund}` };
  if (/redemption notice/i.test(text)) return { label: 'File a redemption notice', go: `/redemption-notices?ticker=${o.fund}` };
  if (/compliance confirms|compliance is alerted|pending review/i.test(text)) return { label: 'Open the work queue', go: '/work' };
  return null;
}

const fmtAmount = (n: number) => n.toLocaleString('en-US');
const parseAmount = (s: string) => { const v = Number(s.replace(/[^0-9.]/g, '')); return Number.isFinite(v) ? v : 0; };

/** Searchable client picker. Filters the cached list as you type and asks the API when the list may be longer. */
function ClientPicker({ id, label, value, all, exclude, onPick, autoFocus }: { id: string; label: string; value: Inv | null; all: Inv[]; exclude?: string; onPick: (i: Inv) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [remote, setRemote] = useState<Inv[] | null>(null);
  const [searching, setSearching] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const s = q.trim().toLowerCase();
  // The API search runs only when the cached page may not hold every client (200 or more) and the query is real.
  useEffect(() => {
    if (!open || s.length < 2 || all.length < 200) { setRemote(null); return; }
    let live = true; setSearching(true);
    const t = window.setTimeout(() => {
      api(`/v1/investors?q=${encodeURIComponent(s)}&limit=20`).then((d) => { if (live) setRemote(d.data ?? []); }).catch(() => { if (live) setRemote(null); }).finally(() => { if (live) setSearching(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); setSearching(false); };
  }, [s, open, all.length]);
  const hits = useMemo(() => {
    const pool = remote ?? all;
    const f = pool.filter((i) => i.id !== exclude && (!s || `${i.name} ${i.residence_name ?? ''} ${i.id} ${i.kind ?? ''}`.toLowerCase().includes(s)));
    return f.slice(0, 8);
  }, [s, all, remote, exclude]);
  useEffect(() => { setHi(0); }, [s, open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const pick = (i: Inv) => { onPick(i); setQ(''); setOpen(false); ref.current?.blur(); };
  // Keyboard-ready on wide screens; on a phone the keyboard would cover the verdict.
  useEffect(() => { if (autoFocus && window.innerWidth >= 720) ref.current?.focus(); }, []);
  const listId = `${id}-list`;
  return (
    <div class="ck-f" ref={wrap}>
      <label class="f-l" for={id}>{label}</label>
      <div class="ck-combo">
        <input
          id={id} ref={ref} type="text" role="combobox" autoComplete="off" spellcheck={false}
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && hits[hi] ? `${id}-opt-${hits[hi].id}` : undefined}
          placeholder={value ? value.name : 'Type a name, city or passport number'}
          value={open ? q : value?.name ?? ''}
          onFocus={() => { setOpen(true); setQ(''); }}
          onInput={(e) => { setQ((e.target as HTMLInputElement).value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, hits.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && open) { e.preventDefault(); e.stopPropagation(); if (hits[hi]) pick(hits[hi]); }
            else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ(''); }
            else if (e.key === 'Tab') setOpen(false);
          }}
        />
        {value && !open ? <span class="ck-combo-meta">{value.residence_name}</span> : null}
        {open ? (
          <ul id={listId} role="listbox" class="ck-list" aria-label={label}>
            {hits.map((i, n) => (
              <li id={`${id}-opt-${i.id}`} role="option" aria-selected={n === hi} class={n === hi ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setHi(n)}>
                <span>{i.name}</span><em>{[i.kind, i.residence_name].filter(Boolean).join(', ')}{i.credential_status === 'none' ? ', no credential' : i.credential_status === 'lapsed' ? ', credential lapsed' : ''}</em>
              </li>
            ))}
            {!hits.length ? <li class="none" aria-disabled="true">{searching ? 'Searching' : s ? 'No client matches. Add them under Clients.' : 'No clients yet.'}</li> : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function Check({ query }: RouteProps) {
  const { can } = useMe();
  const canOrder = can('orders:write');
  const [invs, setInvs] = useState<Inv[] | null>(null);
  const [funds, setFunds] = useState<Fund[] | null>(null);
  const [loadErr, setLoadErr] = useState<any>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true; setLoadErr(null);
    Promise.all([loadInvestors(), loadFunds()]).then(([i, f]) => { if (live) { setInvs(i); setFunds(f); } }).catch((e) => { if (live) setLoadErr(e); });
    return () => { live = false; };
  }, [n]);

  const [action, setAction] = useState<'subscribe' | 'transfer' | 'redeem'>((query.get('action') as any) || 'subscribe');
  const [client, setClient] = useState<Inv | null>(null);
  const [counterparty, setCounterparty] = useState<Inv | null>(null);
  const [fund, setFund] = useState<string>(query.get('fund') ?? '');
  const [amount, setAmount] = useState<number>(Number(query.get('amount')) || 2_000_000);
  const [amountText, setAmountText] = useState<string>(fmtAmount(Number(query.get('amount')) || 2_000_000));
  const [asset, setAsset] = useState<string>('');
  // Defaults once the lists arrive: the client named in the URL, the first fund, the fund's first settlement asset.
  useEffect(() => {
    if (!invs || !funds) return;
    const qi = query.get('investor');
    if (qi && !client) { const i = invs.find((x) => x.id === qi); if (i) setClient(i); }
    const qc = query.get('counterparty');
    if (qc && !counterparty) { const i = invs.find((x) => x.id === qc); if (i) setCounterparty(i); }
    if (!funds.some((f) => f.ticker === fund) && funds.length) setFund(funds[0].ticker);
  }, [invs, funds]);
  const f = (funds ?? []).find((x) => x.ticker === fund) ?? null;
  useEffect(() => { if (f && !f.assets.includes(asset)) setAsset(f.assets[0]); }, [f?.ticker]);

  const ready = !!(client && f && amount > 0 && asset && (action !== 'transfer' || (counterparty && counterparty.id !== client.id)));
  const body = (extra: Record<string, unknown> = {}) => ({ action, investor_id: client!.id, fund: f!.ticker, amount, settle_with: asset, ...(action === 'transfer' ? { counterparty_id: counterparty!.id } : {}), ...extra });

  // Live verdict, 250 ms after the last change. persist: false evaluates without recording anything.
  const [live, setLive] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [liveErr, setLiveErr] = useState<any>(null);
  const key = ready ? JSON.stringify(body()) : '';
  useEffect(() => {
    if (!ready || !canOrder) { setLive(null); setChecking(false); return; }
    let alive = true; setChecking(true);
    const t = window.setTimeout(() => {
      api('/v1/decisions', { body: body({ persist: false }) })
        .then((d) => { if (!alive) return; setLive(d); setLiveErr(null); trackOnce('order_previewed', { action, fund: f!.ticker, via: 'check' }); })
        .catch((e) => { if (!alive) return; setLiveErr(e); setLive(null); })
        .finally(() => { if (alive) setChecking(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [key, canOrder]);

  // Placing: a persisted decision, then the decision page. Large orders come back pending a second person.
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<any>(null);
  const [placeErr, setPlaceErr] = useState<any>(null);
  const [waitlisted, setWaitlisted] = useState<any>(null);
  const [recentN, setRecentN] = useState(0);
  useEffect(() => { setPending(null); setWaitlisted(null); setPlaceErr(null); }, [key]);
  const place = async () => {
    if (!ready || busy) return;
    setBusy(true); setPlaceErr(null);
    try {
      const d = await api('/v1/decisions', { body: body() });
      if (d.pending) { setPending(d); setRecentN((x) => x + 1); return; }
      track('order_placed', { action, fund: f!.ticker, outcome: d.outcome, via: 'check' });
      go(`/decisions/${d.id}`);
    } catch (e) { setPlaceErr(e); } finally { setBusy(false); }
  };
  const joinWaitlist = async () => {
    setBusy(true); setPlaceErr(null);
    try { setWaitlisted(await api('/v1/waitlist', { body: { ticker: f!.ticker, investor_id: client!.id, amount, asset } })); }
    catch (e) { setPlaceErr(e); } finally { setBusy(false); }
  };
  // Enter places the order when it is allowed. Pickers stop the key while their list is open.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || (t.getAttribute && t.getAttribute('aria-expanded') === 'true'))) return;
    if (live?.outcome === 'ALLOW' && canOrder && !busy && !pending) { e.preventDefault(); place(); }
  };

  if (loadErr) return <ErrorBox error={loadErr} onRetry={() => setN((x) => x + 1)} />;
  if (!invs || !funds) return <Loading label="Loading clients and funds" />;
  if (!invs.length || !funds.length) {
    return (
      <div class="ck">
        <header class="ck-head"><h1>Check</h1><p>Can this client buy this fund?</p></header>
        <Empty title={!invs.length ? 'Add a client first' : 'Create a fund first'}>{!invs.length ? <a href="#/clients">Go to clients</a> : <a href="#/funds/new">Create a fund</a>}</Empty>
      </div>
    );
  }
  const v = live ? VERDICT[live.outcome] ?? VERDICT.FREEZE : null;
  const binding: any[] = live?.binding_rules ?? [];
  const checks: any[] = live?.checks ?? [];
  const remedies: string[] = live?.remedies ?? [];
  const remedy = live && live.outcome !== 'ALLOW' ? remedyAction(remedies, { investor_id: client!.id, fund: f!.ticker }, live) : null;
  const units = f && amount > 0 ? amount / f.nav : 0;
  const verb = action === 'subscribe' ? 'buy' : action === 'transfer' ? 'transfer' : 'redeem';

  return (
    <div class="ck" onKeyDown={onKey}>
      <header class="ck-head">
        <h1>Check</h1>
        <p>Can this client {verb} this fund? The answer updates as you type. Nothing is recorded until you place the order.</p>
      </header>

      <section class="ck-form" aria-label="Order">
        <div class="seg-c ck-seg" role="radiogroup" aria-label="Action">{ACTIONS.map((a) => <button type="button" role="radio" aria-checked={action === a.id} class={action === a.id ? 'on' : ''} onClick={() => setAction(a.id)}>{a.label}</button>)}</div>
        <div class="ck-grid">
          <ClientPicker id="ck-client" label="Client" value={client} all={invs} onPick={setClient} autoFocus={!client} />
          {action === 'transfer' ? <ClientPicker id="ck-cp" label="Transfer to" value={counterparty} all={invs} exclude={client?.id} onPick={setCounterparty} /> : null}
          <div class="ck-f">
            <label class="f-l" for="ck-fund">Fund</label>
            <select id="ck-fund" value={fund} onChange={(e) => setFund((e.target as HTMLSelectElement).value)}>{funds.map((x) => <option value={x.ticker}>{x.short} ({x.ticker})</option>)}</select>
          </div>
          <div class="ck-f ck-amount">
            <label class="f-l" for="ck-amount">Amount{f ? ` (${f.currency})` : ''}</label>
            <div class="ck-amount-row">
              <input id="ck-amount" inputMode="numeric" value={amountText} onInput={(e) => { const raw = (e.target as HTMLInputElement).value; const n = parseAmount(raw); setAmountText(raw); setAmount(n); }} onBlur={() => setAmountText(amount ? fmtAmount(amount) : '')} />
              <select aria-label={action === 'redeem' ? 'Paid out in' : 'Settle in'} value={asset} onChange={(e) => setAsset((e.target as HTMLSelectElement).value)}>{(f?.assets ?? []).map((a) => <option>{a}</option>)}</select>
            </div>
            {f && amount > 0 ? <span class="f-h">{units.toLocaleString('en-US', { maximumFractionDigits: 2 })} units at NAV {f.nav.toFixed(4)}</span> : null}
          </div>
        </div>
        {!canOrder ? <PermNote perm="orders:write" /> : null}
      </section>

      <section class={`ck-verdict ${v ? `v-${v.cls}` : 'v-none'}`} aria-live="polite" aria-atomic="true">
        {!ready ? (
          <div class="ck-wait"><p class="ck-big muted">{client ? action === 'transfer' && !counterparty ? 'Pick who receives the units.' : 'Enter an amount.' : 'Pick a client to see the answer.'}</p></div>
        ) : !canOrder ? (
          <div class="ck-wait"><p class="ck-big muted">The live check needs permission to place orders.</p></div>
        ) : liveErr && !live ? (
          <ErrorBox error={liveErr} />
        ) : !live ? (
          <div class="ck-wait"><Loading label="Checking" /></div>
        ) : (
          <>
            <div class="ck-top">
              <span class={`ck-stamp s-${v!.cls}`}>{v!.word}</span>
              {checking ? <span class="ck-rechecking"><span class="spin sm" aria-hidden="true" />Rechecking</span> : null}
              {live.hypothetical ? <Chip tone="info">Hypothetical</Chip> : null}
            </div>
            <p class="ck-headline">{live.headline}</p>
            {binding.length ? (
              <ul class="ck-binding" aria-label="Rules that bind">
                {binding.map((b: any) => <li><strong>{b.text}</strong><span>{[b.layer, b.ruleRef].filter(Boolean).join(', ')}</span></li>)}
              </ul>
            ) : null}
            {remedies.length && live.outcome !== 'ALLOW' ? <div class="ck-remedy"><h3>How to fix it</h3><ul>{remedies.map((r) => <li>{r}</li>)}</ul></div> : null}
            <div class="ck-actions">
              {remedy && !waitlisted ? (
                remedy.kind === 'waitlist'
                  ? <PermBtn perm="orders:write" kind="primary" busy={busy} onClick={joinWaitlist}>{remedy.label}</PermBtn>
                  : <Btn kind="primary" onClick={() => go(remedy.go!)}>{remedy.label}</Btn>
              ) : null}
              {pending ? null : <PermBtn perm="orders:write" kind={remedy && !waitlisted ? 'default' : 'primary'} busy={busy} disabled={!live} onClick={place}>{busy ? 'Placing' : live.outcome === 'ALLOW' ? 'Place this order' : 'Record this refusal'}</PermBtn>}
              <Btn kind="ghost" onClick={() => go(`/orders/new?investor=${client!.id}&fund=${f!.ticker}&amount=${amount}`)}>Full order ticket</Btn>
              {live.outcome === 'ALLOW' && canOrder && !pending ? <span class="ck-hint">Enter places it. The order settles from its decision page.</span> : null}
            </div>
            <ErrorBox error={placeErr} />
            {pending ? <div class="note" role="status"><b>Waiting for approval.</b> {pending.reason} Request <a href={`#/approvals/${pending.approval_id}`}>{pending.approval_id}</a> is in the approvals queue. When another person approves it, the order is decided and settled under their name.</div> : null}
            {waitlisted ? <div class="note" role="status"><b>On the waitlist</b> as {waitlisted.id}, position {waitlisted.position}. {waitlisted.note} <a href="#/waitlist">View the waitlist</a>.</div> : null}
            <details class="ck-trace">
              <summary>See all {checks.length} checks</summary>
              <div class="ck-trace-body">
                {LAYERS.map((L) => { const items = checks.filter((c: any) => c.layer === L); return items.length ? (
                  <div class="tl"><h3>{L}</h3><ul>{items.map((c: any) => <li class={`r-${c.result}`}><i aria-hidden="true">{c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '•'}</i><div><span class="tl-l">{c.subject && L === 'Counterparty' ? `${c.subject}: ` : ''}{c.label}{c.binding ? <Chip tone="info">Binding</Chip> : null}{c.ruleRef ? <em>{c.ruleRef}</em> : null}</span><p>{c.detail}</p></div></li>)}</ul></div>
                ) : null; })}
                {checks.some((c: any) => !LAYERS.includes(c.layer)) ? <div class="tl"><h3>Other</h3><ul>{checks.filter((c: any) => !LAYERS.includes(c.layer)).map((c: any) => <li class={`r-${c.result}`}><i aria-hidden="true">{c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '•'}</i><div><span class="tl-l">{c.label}{c.ruleRef ? <em>{c.ruleRef}</em> : null}</span><p>{c.detail}</p></div></li>)}</ul></div> : null}
                {(live.rule_packs ?? []).length ? <p class="small muted">Rule packs: {live.rule_packs.join(', ')}</p> : null}
              </div>
            </details>
          </>
        )}
      </section>

      <RecentChecks refresh={recentN} onPick={(d) => {
        const i = invs.find((x) => x.id === d.investor_id); if (i) setClient(i);
        const cp = d.counterparty_id ? invs.find((x) => x.id === d.counterparty_id) : null; if (cp) setCounterparty(cp);
        if (funds.some((x) => x.ticker === d.ticker)) setFund(d.ticker);
        setAction(d.action); setAmount(Number(d.amount)); setAmountText(fmtAmount(Number(d.amount)));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }} />
    </div>
  );
}

/** The last ten recorded decisions, compact. Picking one loads it back into the form. */
function RecentChecks({ refresh, onPick }: { refresh: number; onPick: (d: any) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    let live = true;
    api('/v1/decisions?limit=10').then((d) => { if (live) { setRows(d.data ?? []); setErr(null); } }).catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [refresh]);
  return (
    <section class="ck-recent" aria-labelledby="ck-recent-h">
      <div class="ck-recent-head"><h2 id="ck-recent-h">Recent checks</h2><a href="#/decisions">All decisions</a></div>
      {err ? <ErrorBox error={err} /> : rows === null ? <Loading /> : !rows.length ? <p class="small muted">Nothing recorded yet. The first order you place appears here.</p> : (
        <ul class="ck-recent-list">
          {rows.map((d) => (
            <li>
              <button type="button" class="ck-recent-row" onClick={() => onPick(d)} title="Load this order into the form">
                <span class="ck-recent-who"><b>{d.investor}</b><span class="muted">{d.action} {d.ticker}{d.counterparty_id ? ' to another holder' : ''}</span></span>
                <span class="ck-recent-amt">{money(Number(d.amount), d.asset === 'EURC' || d.asset === 'AVB-EUR' ? 'EUR' : 'USD')}</span>
                <span class="ck-recent-out">{outcomeChip(d.outcome)}{d.settlement_id ? <Chip tone="ok">Settled</Chip> : null}</span>
                <time class="muted small">{when(d.created_at)}</time>
              </button>
              <a class="ck-recent-open" href={`#/decisions/${d.id}`} aria-label={`Open decision ${d.id}`}>Open</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
