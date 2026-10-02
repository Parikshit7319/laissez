/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Credential } from './Credential';
import {
  investors, funds, bookingCenters, jurName, ASSET_INFO, investorNotes, SIM_TIME, SIM_DATE, DISTRIBUTOR,
  type InvestorId, type FundId, type Jur,
} from './data';
import {
  evaluate, issuerImpact, inputsHash, money, WHAT_IFS, NETWORK_POOL,
  type Action, type WhatIf, type Decision, type Check, type Layer, type Order,
} from './engine';
import '../styles/proto.css';

type Props = { sourcesHref: string };

const LAYER_ORDER: Layer[] = ['Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Transfer controls', 'Counterparty', 'Global screens'];
const LAYER_NOTE: Record<Layer, string> = {
  Credential: 'Is this the investor we verified, and are they clear of sanctions lists?',
  'Fund policy': 'What the issuer allows: where the fund is offered, to whom, and how it settles.',
  'Residence law': 'What the investor’s home jurisdiction requires before this fund can be offered to them.',
  'Booking-center licence': 'What the distributor’s licence in the booking location allows.',
  'Transfer controls': 'Balances, lock-ups and who may send units out.',
  Counterparty: 'The receiving investor must pass the same eligibility tests as a new subscriber.',
  'Global screens': 'Sanctions programs and Travel Rule data that apply everywhere.',
  Documents: 'The offering documents the investor must have acknowledged, at their current version.',
  'Fund terms': 'Dealing cut-offs, notice periods and redemption gates set by the fund.',
};

const defaultAmount = (fundId: FundId, action: Action) =>
  action === 'subscribe' ? (fundId === 'TWLF' ? 2_000_000 : fundId === 'NMEL' ? 1_000_000 : 500_000) : action === 'transfer' ? 500_000 : 500_000;

type TourState = {
  view: 'distributor' | 'issuer';
  investorId: InvestorId; fundId: FundId; action: Action; amount: number; asset: string;
  counterpartyId?: InvestorId; whatIfs: WhatIf[]; offered?: Jur[];
};
type TourStep = { title: string; body: string; state: TourState; run?: 'check' | 'settle' };

const BASE: TourState = { view: 'distributor', investorId: 'lumen', fundId: 'TWLF', action: 'subscribe', amount: 2_000_000, asset: 'USDC', whatIfs: [] };

const TOUR: TourStep[] = [
  {
    title: 'Meet the client',
    body: 'Lumen Family Office lives in Singapore and banks through Aster & Vale’s Hong Kong booking center. It was verified once, and its Laissez credential carries two stamps: Singapore accredited investor with opt-in, and Hong Kong professional investor.',
    state: BASE,
  },
  {
    title: 'Place the order',
    body: 'Subscribe $2,000,000 into Tidewell Treasury Liquidity, a fictional tokenized Treasury fund domiciled in the BVI and sold under Regulation S. Payment in USDC on Ethereum.',
    state: BASE,
  },
  {
    title: 'Run the check',
    body: 'Laissez evaluates four layers: the credential, the issuer’s policy, Singapore law and the Hong Kong licence. Two rules bind. Singapore requires an opt-in, which is stricter than the fund’s own policy, and Hong Kong requires professional investor status.',
    state: BASE, run: 'check',
  },
  {
    title: 'Settle it',
    body: 'Cash and fund units move in one transaction, or nothing moves. The decision is signed and only its hash goes on-chain, never personal data.',
    state: BASE, run: 'settle',
  },
  {
    title: 'Break it',
    body: 'Now Lumen’s eligibility lapses. The same order is denied, and the trace says exactly which rules failed and what fixes them. No ticket to compliance, no email chain.',
    state: { ...BASE, whatIfs: ['expired'] }, run: 'check',
  },
  {
    title: 'Exit still works',
    body: 'Lumen asks to redeem $500,000. Laissez allows it. A holder whose status lapses can always leave; they just cannot add. That is a product decision, explained on the Decisions page.',
    state: { ...BASE, action: 'redeem', amount: 500_000, whatIfs: ['expired'] }, run: 'check',
  },
  {
    title: 'Switch sides',
    body: 'You are now the issuer. The UAE has been removed from Tidewell’s distribution list as a draft change. Laissez shows who is affected before anything is published: holders move to redemption-only, nobody is force-redeemed.',
    state: { ...BASE, view: 'issuer', offered: ['SG', 'HK', 'CH', 'DE'] },
  },
];

export default function Console({ sourcesHref }: Props) {
  const [view, setView] = useState<'distributor' | 'issuer'>('distributor');
  const [tour, setTour] = useState<number | null>(0);
  const [investorId, setInvestor] = useState<InvestorId>('lumen');
  const [fundId, setFundRaw] = useState<FundId>('TWLF');
  const [action, setActionRaw] = useState<Action>('subscribe');
  const [amount, setAmount] = useState<number>(2_000_000);
  const [asset, setAsset] = useState<string>('USDC');
  const [counterpartyId, setCounterparty] = useState<InvestorId>('qamar');
  const [whatIfs, setWhatIfs] = useState<WhatIf[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'decided' | 'settling' | 'settled'>('idle');
  const [settleStep, setSettleStep] = useState(0);
  const [hash, setHash] = useState('');
  const [offered, setOffered] = useState<Jur[]>(['SG', 'HK', 'CH', 'DE', 'AE-DIFC']);
  const timers = useRef<number[]>([]);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const inv = investors[investorId];
  const fund = funds[fundId];

  const clearTimers = () => { timers.current.forEach((t) => clearTimeout(t)); timers.current = []; };
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, reduced ? 0 : ms)); };

  const reset = () => { clearTimers(); setDecision(null); setPhase('idle'); setRevealed(0); setSettleStep(0); setHash(''); };

  const setFund = (id: FundId) => { setFundRaw(id); setAsset(funds[id].assets[0]); setAmount(defaultAmount(id, action)); };
  const setAction = (a: Action) => { setActionRaw(a); setAmount(defaultAmount(fundId, a)); };

  // Inputs changed by the user invalidate the decision
  const touch = () => { if (decision) reset(); };

  const settle = (d: Decision) => {
    setPhase('settling');
    setSettleStep(0);
    const steps = d.order.action === 'redeem' ? 4 : 5;
    for (let i = 1; i <= steps; i++) later(() => { setSettleStep(i); if (i === steps) setPhase('settled'); }, i * 650);
  };

  const runWith = (order: Order, w: WhatIf[], settleNow = false) => {
    clearTimers();
    const d = evaluate(order, w);
    setDecision(d);
    setSettleStep(0);
    inputsHash(d).then(setHash);
    if (settleNow && d.outcome === 'ALLOW') {
      setRevealed(d.checks.length);
      settle(d);
      return;
    }
    setPhase('checking');
    setRevealed(0);
    d.checks.forEach((_, i) => later(() => setRevealed(i + 1), 70 * (i + 1)));
    later(() => setPhase('decided'), 70 * (d.checks.length + 1));
  };

  const run = () => runWith({ action, investorId, fundId, amount, asset, counterpartyId: action === 'transfer' ? counterpartyId : undefined }, whatIfs);

  // Re-evaluate instantly when what-ifs change after a decision exists
  const toggleWhatIf = (w: WhatIf) => {
    const next = whatIfs.includes(w) ? whatIfs.filter((x) => x !== w) : [...whatIfs, w];
    setWhatIfs(next);
    if (decision) {
      clearTimers();
      const d = evaluate({ ...decision.order, asset }, next);
      setDecision(d); setRevealed(d.checks.length); setPhase('decided'); setSettleStep(0);
      inputsHash(d).then(setHash);
    }
  };

  // Each tour step declares its full state, so it never depends on what the visitor did before.
  useEffect(() => {
    if (tour === null) return;
    const step = TOUR[tour];
    const st = step.state;
    setView(st.view); setInvestor(st.investorId); setFundRaw(st.fundId); setActionRaw(st.action);
    setAmount(st.amount); setAsset(st.asset); setWhatIfs(st.whatIfs);
    if (st.counterpartyId) setCounterparty(st.counterpartyId);
    setOffered(st.offered ?? ['SG', 'HK', 'CH', 'DE', 'AE-DIFC']);
    if (step.run) {
      runWith({ action: st.action, investorId: st.investorId, fundId: st.fundId, amount: st.amount, asset: st.asset, counterpartyId: st.action === 'transfer' ? st.counterpartyId : undefined }, st.whatIfs, step.run === 'settle');
    } else {
      reset();
    }
  }, [tour]);

  useEffect(() => () => clearTimers(), []);

  const counterpartyOptions = (Object.keys(investors) as InvestorId[]).filter((id) => id !== investorId);
  useEffect(() => { if (counterpartyId === investorId) setCounterparty(counterpartyOptions[0]); }, [investorId]);

  const src = (id?: string) => (id ? `${sourcesHref}${id}` : undefined);

  return (
    <div class="console-shell">
      {tour !== null ? (
        <div class="tour" role="region" aria-label="Guided tour">
          <div class="tour-meta">
            <span class="tour-count">Step {tour + 1} of {TOUR.length}</span>
            <button type="button" class="link-btn" onClick={() => setTour(null)}>Exit tour and explore freely</button>
          </div>
          <h3 class="tour-title">{TOUR[tour].title}</h3>
          <p class="tour-body">{TOUR[tour].body}</p>
          <div class="tour-nav">
            <button type="button" class="btn" disabled={tour === 0} onClick={() => setTour(Math.max(0, tour - 1))}>Back</button>
            {tour < TOUR.length - 1 ? (
              <button type="button" class="btn primary" onClick={() => setTour(tour + 1)}>Next: {TOUR[tour + 1].title}</button>
            ) : (
              <button type="button" class="btn primary" onClick={() => { setTour(null); setView('distributor'); }}>Finish and explore freely</button>
            )}
          </div>
          <div class="tour-progress" aria-hidden="true"><span style={{ width: `${((tour + 1) / TOUR.length) * 100}%` }} /></div>
        </div>
      ) : (
        <div class="tour tour-off">
          <p>Free mode. Pick any client, fund and action, then toggle the what-ifs.</p>
          <button type="button" class="btn" onClick={() => setTour(0)}>Restart the guided tour</button>
        </div>
      )}

      <div class="console" data-view={view}>
        <div class="console-bar">
          <div class="console-brand">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" stroke-width="1.3" /><circle cx="9" cy="9" r="3.4" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
            Laissez Console
          </div>
          <div class="role-tabs" role="tablist" aria-label="Signed in as">
            <button role="tab" type="button" aria-selected={view === 'distributor'} onClick={() => setView('distributor')}>
              Distributor<span>{DISTRIBUTOR}</span>
            </button>
            <button role="tab" type="button" aria-selected={view === 'issuer'} onClick={() => setView('issuer')}>
              Issuer<span>Tidewell Asset Management</span>
            </button>
          </div>
          <span class="sim-badge" title="All entities and data in this console are fictional">Simulated</span>
        </div>

        {view === 'distributor' ? (
          <div class="console-grid">
            {/* Clients */}
            <section class="pane clients" aria-label="Clients">
              <h4 class="pane-h">Clients</h4>
              <ul class="client-list">
                {(Object.keys(investors) as InvestorId[]).map((id) => {
                  const i = investors[id];
                  const lapsed = i.expires < SIM_DATE || i.classifications.some((c) => c.expires < SIM_DATE);
                  return (
                    <li>
                      <button type="button" class="client" aria-pressed={id === investorId} onClick={() => { setInvestor(id); touch(); }}>
                        <span class="c-name">{i.short}</span>
                        <span class="c-meta">{i.kind}, {i.city}</span>
                        <span class="c-tags">
                          <span class="jur">{i.residence === 'AE-DIFC' ? 'AE' : i.residence}</span>
                          {lapsed ? <span class="status warn">Lapsed</span> : i.classifications.length ? <span class="status info">{i.classifications.length} stamp{i.classifications.length > 1 ? 's' : ''}</span> : <span class="status">KYC only</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div class="cred-slot">
                <Credential inv={inv} compact />
                {investorNotes[investorId] ? <p class="inv-note">{investorNotes[investorId]}</p> : null}
              </div>
            </section>

            {/* Order + decision */}
            <section class="pane work" aria-label="Order and decision">
              <h4 class="pane-h">Order ticket</h4>
              <div class="ticket">
                <fieldset class="seg">
                  <legend>Action</legend>
                  {(['subscribe', 'transfer', 'redeem'] as Action[]).map((a) => (
                    <label class={a === action ? 'on' : ''}>
                      <input type="radio" name="action" value={a} checked={a === action} onChange={() => { setAction(a); touch(); }} />
                      {a === 'subscribe' ? 'Subscribe' : a === 'transfer' ? 'Transfer' : 'Redeem'}
                    </label>
                  ))}
                </fieldset>
                <label class="field">
                  <span>Fund</span>
                  <select value={fundId} onChange={(e) => { setFund((e.target as HTMLSelectElement).value as FundId); touch(); }}>
                    {(Object.keys(funds) as FundId[]).map((f) => <option value={f}>{funds[f].short} ({funds[f].ticker})</option>)}
                  </select>
                  <small>{fund.domicile}. {fund.structure}.</small>
                </label>
                <div class="row2">
                  <label class="field">
                    <span>Amount ({fund.currency})</span>
                    <input type="text" inputMode="numeric" value={amount.toLocaleString('en-US')} onInput={(e) => {
                      const n = Number((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''));
                      if (!Number.isNaN(n)) { setAmount(n); touch(); }
                    }} />
                    <small>{(amount / fund.nav).toLocaleString('en-US', { maximumFractionDigits: 2 })} units at NAV {fund.nav.toFixed(4)}</small>
                  </label>
                  <label class="field">
                    <span>{action === 'redeem' ? 'Paid out in' : 'Settle in'}</span>
                    <select value={asset} onChange={(e) => { setAsset((e.target as HTMLSelectElement).value); touch(); }}>
                      {fund.assets.map((a) => <option value={a}>{a}</option>)}
                    </select>
                    <small>{ASSET_INFO[asset]?.kind}</small>
                  </label>
                </div>
                {action === 'transfer' ? (
                  <label class="field">
                    <span>Transfer to</span>
                    <select value={counterpartyId} onChange={(e) => { setCounterparty((e.target as HTMLSelectElement).value as InvestorId); touch(); }}>
                      {counterpartyOptions.map((id) => <option value={id}>{investors[id].short} ({jurName[investors[id].residence]}, booked {bookingCenters[investors[id].booking].name})</option>)}
                    </select>
                    <small>Buyer pays {asset}; units and cash swap atomically.</small>
                  </label>
                ) : null}
                <div class="ticket-actions">
                  <button type="button" class="btn primary" onClick={() => run()} disabled={phase === 'checking' || phase === 'settling'}>
                    {decision ? 'Check again' : 'Check order'}
                  </button>
                  {decision?.outcome === 'ALLOW' && (phase === 'decided') ? (
                    <button type="button" class="btn settle" onClick={() => settle(decision)}>Settle now</button>
                  ) : null}
                  <span class="ticket-hint">Pre-trade checks are free and instant. Settlement is the commit.</span>
                </div>
              </div>

              <div class="whatifs" aria-label="What-if scenarios">
                <span class="wi-label">What if</span>
                {WHAT_IFS.map((w) => {
                  const on = whatIfs.includes(w.id);
                  const na = on && decision && !decision.appliedWhatIfs.includes(w.id);
                  return (
                    <button type="button" class={`wi ${on ? 'on' : ''}`} aria-pressed={on} title={w.hint} onClick={() => toggleWhatIf(w.id)}>
                      <span class="sw" aria-hidden="true" />{w.label}{na ? <em> (not applicable here)</em> : null}
                    </button>
                  );
                })}
              </div>

              <div class="decision-area" aria-live="polite">
                {!decision ? (
                  <div class="empty">
                    <p><strong>No decision yet.</strong> Choose a client and an order, then run the check. Every rule that applies is evaluated and explained.</p>
                  </div>
                ) : (
                  <DecisionView d={decision} revealed={revealed} phase={phase} settleStep={settleStep} hash={hash} src={src} />
                )}
              </div>
            </section>
          </div>
        ) : (
          <IssuerView offered={offered} setOffered={setOffered} />
        )}
      </div>
    </div>
  );
}

function icon(r: Check['result']) {
  if (r === 'pass') return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (r === 'fail') return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>;
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>;
}

function DecisionView({ d, revealed, phase, settleStep, hash, src }: { d: Decision; revealed: number; phase: string; settleStep: number; hash: string; src: (id?: string) => string | undefined }) {
  const done = phase !== 'checking';
  const shown = d.checks.slice(0, revealed);
  const groups = LAYER_ORDER.map((l) => ({ layer: l, items: shown.filter((c) => c.layer === l) })).filter((g) => g.items.length);
  const passCount = d.checks.filter((c) => c.result === 'pass').length;
  const failCount = d.checks.filter((c) => c.result === 'fail').length;
  const label = d.outcome === 'ALLOW' ? (d.redemptionOnly ? 'Allowed, redemption-only' : 'Allowed') : d.outcome === 'DENY' ? 'Denied' : 'Frozen';

  return (
    <div class={`decision ${done ? 'done' : ''} out-${d.outcome.toLowerCase()}`}>
      {done ? (
        <div class="verdict">
          <div class="verdict-stamp" aria-hidden="true">{d.outcome === 'ALLOW' ? 'Admitted' : d.outcome === 'DENY' ? 'Refused' : 'Frozen'}</div>
          <div>
            <p class="verdict-label">{label}</p>
            <p class="verdict-text">{d.headline}</p>
            <p class="verdict-counts">{passCount} checks passed{failCount ? `, ${failCount} failed` : ''}. {d.appliedWhatIfs.length ? `What-ifs applied: ${d.appliedWhatIfs.map((w) => WHAT_IFS.find((x) => x.id === w)!.label.toLowerCase()).join('; ')}.` : ''}</p>
          </div>
        </div>
      ) : (
        <div class="verdict pending"><p class="verdict-label">Evaluating {d.checks.length} rules…</p></div>
      )}

      {done && d.remedies.length ? (
        <div class="remedies">
          <h5>How to fix it</h5>
          <ul>{[...new Set(d.remedies)].map((r) => <li>{r}</li>)}</ul>
        </div>
      ) : null}

      {done && d.resolved.length ? (
        <div class="resolved">
          <h5>Rules that bind this order</h5>
          <ul>
            {d.resolved.map((r) => <li><strong>{r.text}</strong><span>{r.layer}, {r.ruleRef}</span></li>)}
          </ul>
          <p class="small">Every layer must pass. Where two layers test the same jurisdiction, the stricter test binds.</p>
        </div>
      ) : null}

      <div class="trace">
        <h5>Policy trace</h5>
        {groups.map((g) => (
          <div class="layer">
            <div class="layer-h"><span>{g.layer}</span><small>{LAYER_NOTE[g.layer]}</small></div>
            <ul>
              {g.items.map((c) => (
                <li class={`chk r-${c.result} ${c.binding ? 'binding' : ''}`}>
                  <span class="chk-ic">{icon(c.result)}<span class="sr">{c.result === 'pass' ? 'Passed' : c.result === 'fail' ? 'Failed' : 'Note'}</span></span>
                  <div class="chk-main">
                    <div class="chk-top">
                      <span class="chk-label">{c.subject && g.layer === 'Counterparty' ? `${c.subject}: ` : ''}{c.label}</span>
                      {c.binding ? <span class="bind-tag">Binding</span> : null}
                      {c.ruleRef ? (c.source ? <a class="rule" href={src(c.source)} target="_blank" rel="noopener">{c.ruleRef}</a> : <span class="rule">{c.ruleRef}</span>) : null}
                    </div>
                    <p class="chk-detail">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {done ? <Settlement d={d} step={settleStep} phase={phase} /> : null}
      {done ? <Receipt d={d} hash={hash} /> : null}
    </div>
  );
}

function Settlement({ d, step, phase }: { d: Decision; step: number; phase: string }) {
  const f = d.fund;
  const amt = money(d.notional, f.currency);
  const units = d.units.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (d.outcome === 'DENY') {
    return (
      <div class="settle none">
        <h5>Settlement</h5>
        <p>Nothing moved. No cash was locked and no units changed hands, because the check runs before either leg is committed.</p>
      </div>
    );
  }
  if (d.outcome === 'FREEZE') {
    return (
      <div class="settle none">
        <h5>Settlement</h5>
        <p>Units stay frozen in {d.investor.short}’s wallet through the issuer’s registry controls. Compliance is notified with the full trace.</p>
      </div>
    );
  }
  const a = d.order.action;
  const cp = d.counterparty;
  const steps =
    a === 'subscribe'
      ? [
          ['Decision signed', 'Resolver key laissez-resolver-03 signs the decision. Its hash is the only thing that will go on-chain.', '+0.2s'],
          ['Cash leg locked', `${amt} ${d.order.asset} moves from ${d.investor.short}’s wallet into the settlement contract.`, 'block 1, about 12s'],
          ['Registry confirms', `Tidewell’s identity registry accepts Laissez’s claim for wallet ${d.investor.wallet} (ERC-3643 isVerified).`, 'same block'],
          ['Atomic swap', `${units} ${f.ticker} minted to ${d.investor.short}; ${amt} ${d.order.asset} released to the fund. Both legs in one transaction, or neither.`, 'same block'],
          ['Final', 'Ethereum finalizes after two epochs. The evidence receipt is filed for the auditor.', 'about 13 min'],
        ]
      : a === 'transfer'
        ? [
            ['Decision signed', 'Both parties checked. Travel Rule data delivered. Decision hash prepared for the chain.', '+0.2s'],
            ['Cash leg locked', `${cp!.short} locks ${amt} ${d.order.asset} in the settlement contract.`, 'block 1, about 12s'],
            ['Registry confirms', `Registry accepts Laissez’s claim for the receiving wallet ${cp!.wallet}.`, 'same block'],
            ['Atomic swap', `${units} ${f.ticker} move from ${d.investor.short} to ${cp!.short}; ${amt} ${d.order.asset} goes to ${d.investor.short}. Both legs or neither.`, 'same block'],
            ['Final', 'Ethereum finality. Register and receipts updated for both distributors.', 'about 13 min'],
          ]
        : [
            ['Decision signed', 'Redemption approved under the always-open exit rule.', '+0.2s'],
            ['Units locked', `${units} ${f.ticker} locked for burn at NAV ${f.nav.toFixed(4)}.`, 'block 1, about 12s'],
            ['Atomic payout', `Units burned and ${amt} ${d.order.asset} paid to ${d.investor.short} in the same transaction.`, 'same block'],
            ['Final', 'Ethereum finality. Register updated.', 'about 13 min'],
          ];
  const started = phase === 'settling' || phase === 'settled';
  return (
    <div class="settle">
      <h5>Settlement {started ? '' : <span class="small">(press Settle now)</span>}</h5>
      <ol class="settle-steps">
        {steps.map(([t, body, when], i) => (
          <li class={step > i ? 'done' : step === i && started ? 'active' : ''}>
            <span class="s-dot" aria-hidden="true" />
            <div><span class="s-t">{t}</span><span class="s-when">{when}</span><p>{body}</p></div>
          </li>
        ))}
      </ol>
      <p class="small">Simulated and time-compressed. Block time and finality reflect Ethereum mainnet.</p>
    </div>
  );
}

function Receipt({ d, hash }: { d: Decision; hash: string }) {
  const receipt = {
    decision_id: `dec_${(hash || '0'.repeat(12)).slice(0, 12)}`,
    issued_at: SIM_TIME,
    outcome: d.outcome,
    action: d.order.action,
    fund: d.fund.ticker,
    amount: `${d.notional} ${d.fund.currency}`,
    binding_rules: d.resolved.map((r) => `${r.text} (${r.ruleRef})`),
    rule_packs: d.rulePacks,
    inputs_sha256: hash || 'computing…',
    signer: 'laissez-resolver-03',
    on_chain: ['outcome', 'inputs_sha256', 'rule_packs'],
  };
  return (
    <details class="receipt">
      <summary>Evidence receipt <span>what an auditor or regulator sees</span></summary>
      <pre><code>{JSON.stringify(receipt, null, 2)}</code></pre>
      <p class="small">Personal data stays with the distributor. The chain stores the outcome, the input hash and the rule-pack versions, so anyone holding the inputs can prove the decision later.</p>
    </details>
  );
}

const ALL_JUR: Jur[] = ['SG', 'HK', 'CH', 'DE', 'AE-DIFC'];

function IssuerView({ offered, setOffered }: { offered: Jur[]; setOffered: (j: Jur[]) => void }) {
  const [signoff, setSignoff] = useState(false);
  const [published, setPublished] = useState(false);
  const impact = useMemo(() => issuerImpact(offered), [offered]);
  const usd = (n: number) => '$' + (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M';
  const reach = ALL_JUR.filter((j) => offered.includes(j)).reduce((s, j) => s + (NETWORK_POOL[j] ?? 0), 0);
  const toggle = (j: Jur) => { setPublished(false); setSignoff(false); setOffered(offered.includes(j) ? offered.filter((x) => x !== j) : [...offered, j]); };

  return (
    <div class="issuer">
      <div class="issuer-head">
        <div>
          <h4 class="pane-h">Distribution policy: Tidewell Treasury Liquidity Fund (TWLF)</h4>
          <p class="small">Simulated register: {impact.totalHolders} holders, {usd(impact.totalUnits)} outstanding. Toggle a jurisdiction to preview the effect before publishing.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data jur-table">
          <thead><tr><th>Offered in</th><th class="r">Holders</th><th class="r">Units held</th><th class="r">Credentialed investors on network</th><th>Status</th></tr></thead>
          <tbody>
            {impact.byJur.map((r) => (
              <tr class={r.offered ? '' : 'off'}>
                <td>
                  <label class="jur-toggle">
                    <input type="checkbox" checked={r.offered} onChange={() => toggle(r.jur)} />
                    <span class="sw" aria-hidden="true" />{jurName[r.jur]}
                  </label>
                </td>
                <td class="r">{r.holders}</td>
                <td class="r">{usd(r.units)}</td>
                <td class="r">{r.network.toLocaleString('en-US')}</td>
                <td>{r.offered ? <span class="status ok">Offered</span> : <span class="status warn">Redemption-only</span>}</td>
              </tr>
            ))}
            <tr class="off">
              <td><span class="jur-toggle disabled"><span class="sw" aria-hidden="true" />United Kingdom</span></td>
              <td class="r">0</td><td class="r">$0M</td><td class="r">Not yet</td>
              <td><span class="status info">Rule pack in draft</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="impact" aria-live="polite">
        {impact.removed.length ? (
          <>
            <h5>Impact if you publish</h5>
            <p class="impact-big"><strong>{impact.holders} holders</strong> with <strong>{usd(impact.units)}</strong> in {impact.removed.map((j) => jurName[j]).join(' and ')} move to redemption-only.</p>
            <ul>
              <li>They keep their units and can redeem at any time.</li>
              <li>They cannot subscribe more or receive transfers.</li>
              <li>No forced redemptions. Laissez notifies each holder’s distributor with the rule change and effective date.</li>
            </ul>
            <label class="signoff"><input type="checkbox" checked={signoff} onChange={(e) => setSignoff((e.target as HTMLInputElement).checked)} /> Legal sign-off recorded (a second approver is required to publish)</label>
            <button type="button" class="btn primary" disabled={!signoff || published} onClick={() => setPublished(true)}>{published ? 'Published' : 'Publish policy change'}</button>
            {published ? <p class="status ok" role="status">Published as fund/TWLF@2026.10.0. Distributors notified.</p> : null}
          </>
        ) : (
          <>
            <h5>Network reach</h5>
            <p class="impact-big"><strong>{reach.toLocaleString('en-US')} investors</strong> already hold Laissez credentials with an accepted classification in the jurisdictions you offer. They can subscribe without re-onboarding.</p>
            <p class="small">This is the network effect the product depends on: each distributor’s verification becomes reusable reach for every issuer. Figures simulated.</p>
          </>
        )}
      </div>

      <div class="agent">
        <h5>Regulatory change queue</h5>
        <p class="small">Drafted by the regulatory change agent. Nothing goes live without legal review.</p>
        <ul class="agent-list">
          <li>
            <span class="status info">Draft diff ready</span>
            <div><strong>UK: FCA CP25/36</strong> proposes a £10M investable-assets route for elective professional clients. A UK rule pack is drafted against the proposal. It stays inactive because the proposal is not final.</div>
          </li>
          <li>
            <span class="status warn">Watching</span>
            <div><strong>Singapore: draft stablecoin legislation</strong> published Sep 1, 2026, consultation closing Oct 16, 2026. Would affect which SGD stablecoins the settlement-asset rules accept.</div>
          </li>
          <li>
            <span class="status ok">Applied</span>
            <div><strong>OFAC: Syria program removed</strong> (Aug 25, 2025). Country block list updated; screening of listed persons continues.</div>
          </li>
        </ul>
      </div>
    </div>
  );
}
