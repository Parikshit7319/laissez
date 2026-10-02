/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { api, money, compact, when, JUR, CLASS_LABEL, track } from '../api';
import { useApi, Head, Btn, Chip, statusChip, outcomeChip, ErrorBox, Loading, Empty, Field, Card, go } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';
import { FundOps } from './fundops';
import { PolicyDiff } from './policydiff';

const JURS = ['SG', 'HK', 'CH', 'DE', 'LU', 'IE', 'GB', 'AE-DIFC', 'AE-ADGM', 'JP', 'IN', 'AU', 'CA', 'BR', 'KR', 'US'];
const ACCEPTS: Record<string, string[]> = { SG: ['SG_AI'], HK: ['HK_PI'], CH: ['CH_PRO'], DE: ['EU_PRO', 'EU_RETAIL'], 'AE-DIFC': ['DIFC_PRO'], US: ['US_AI', 'US_QP', 'US_QIB', 'US_IAI'], IN: ['IN_AI', 'IN_LRS', 'IFSCA_PRO'], LU: ['EU_PRO'], IE: ['EU_PRO'], GB: ['GB_PRO', 'GB_EPRO'], 'AE-ADGM': ['ADGM_PRO'], JP: ['JP_QII'], AU: ['AU_WHOLESALE', 'AU_PRO'], CA: ['CA_AI', 'CA_PC', 'CA_MIN'], BR: ['BR_QUAL', 'BR_PRO'], KR: ['KR_PRO', 'KR_QPI'] };

export function Funds() {
  const r = useApi('/v1/funds');
  return (
    <>
      <Head title="Funds" sub="Tokenized funds in this workspace. Open one to edit its distribution policy and see its register." actions={<PermBtn perm="funds:write" kind="primary" onClick={() => go('/funds/new')}>Create fund</PermBtn>} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : (
        <div class="fund-grid">
          {r.data.data.map((f: any) => (
            <a class="fund" href={`#/funds/${f.ticker}`}>
              <div class="fund-top"><code>{f.ticker}</code><Chip>{f.currency}</Chip>{f.regS ? <Chip tone="info">Reg S</Chip> : null}</div>
              <h3>{f.short}</h3>
              <p class="muted small">{f.domicile}. {f.structure}.</p>
              <dl class="fund-dl"><div><dt>Offered in</dt><dd>{Object.keys(f.distribution).map((j) => JUR[j] ?? j).join(', ')}</dd></div><div><dt>Minimum</dt><dd>{money(f.minSubscription, f.currency)}</dd></div><div><dt>Holders</dt><dd>{f.holders}{f.holderCap ? ` of ${f.holderCap}` : ''}</dd></div></dl>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

export function FundDetail({ ticker }: { ticker: string }) {
  const f = useApi(`/v1/funds/${ticker}`, [ticker]);
  const reg = useApi(`/v1/funds/${ticker}/register`, [ticker]);
  const pcs = useApi('/v1/policy-changes', [ticker]);
  if (f.loading && !f.data) return <Loading />;
  if (f.error) return <ErrorBox error={f.error} />;
  const fund = f.data;
  const reload = () => { f.reload(); reg.reload(); pcs.reload(); };
  return (
    <>
      <Head title={fund.name} sub={<>{fund.domicile}. {fund.structure}. Issuer: {fund.issuer}.</>} />
      <div class="kpis">
        <div class="kpi"><span>NAV per unit</span><b>{fund.nav.toFixed(4)}</b><em>{fund.currency}</em></div>
        <div class="kpi"><span>Holders of record</span><b>{fund.holders}{fund.holderCap ? ` / ${fund.holderCap}` : ''}</b><em>{fund.holderCap ? `${Math.round((fund.holders / fund.holderCap) * 100)}% of the Section 3(c)(1) limit` : 'No holder cap'}</em></div>
        <div class="kpi"><span>Minimum</span><b>{compact(fund.minSubscription, fund.currency)}</b><em>per subscription</em></div>
        <div class="kpi"><span>Lock-up</span><b>{fund.lockupMonths ? `${fund.lockupMonths} months` : 'None'}</b><em>settles in {fund.assets.join(', ')}</em></div>
      </div>
      <PolicyEditor fund={fund} onPublished={reload} />
      <Card title="Policy changes" actions={<Chip>{(pcs.data?.data ?? []).filter((p: any) => p.ticker === ticker && p.status === 'draft').length} awaiting approval</Chip>}>
        <PolicyChangeList rows={(pcs.data?.data ?? []).filter((p: any) => p.ticker === ticker)} onChange={reload} />
      </Card>
      <ConcentrationCard ticker={ticker} currency={fund.currency} />
      <FundOps ticker={ticker} onChange={reload} />
      <Card title="Register" actions={reg.data ? <span class="muted small">{reg.data.sandbox_holders} holders in this workspace; {reg.data.total_holders_of_record} holders of record in total</span> : null}>
        {reg.loading && !reg.data ? <Loading /> : reg.error ? <ErrorBox error={reg.error} /> : reg.data.data.length ? (
          <div class="tw"><table class="t"><thead><tr><th>Holder</th><th>Residence</th><th class="r">Units</th><th class="r">Value</th><th>Since</th><th>Status</th></tr></thead>
            <tbody>{reg.data.data.map((h: any) => <tr class="click" onClick={() => go(`/clients/${h.investor_id}`)}><td>{h.name}</td><td>{JUR[h.residence] ?? h.residence}</td><td class="r">{h.units.toLocaleString('en-US')}</td><td class="r">{money(h.value, fund.currency)}</td><td class="muted">{h.since}</td><td title={h.reason}>{statusChip(h.status)}</td></tr>)}</tbody></table></div>
        ) : <Empty title="No holders yet" />}
      </Card>
    </>
  );
}

/** Concentration limits: largest holder against the per-investor and share-of-assets caps, with an edit form. */
function ConcentrationCard({ ticker, currency }: { ticker: string; currency: string }) {
  const r = useApi(`/v1/funds/${ticker}/concentration`, [ticker]);
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState('');
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [note, setNote] = useState<string | null>(null);
  if (r.loading && !r.data) return <Card title="Concentration limits"><Loading /></Card>;
  if (r.error) return <Card title="Concentration limits"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const d = r.data; const top = d.largest_holder;
  const start = () => { setPct(d.max_holder_pct ? String(d.max_holder_pct) : ''); setAmt(d.max_holding_per_investor ? Number(d.max_holding_per_investor).toLocaleString('en-US') : ''); setEditing(true); setNote(null); };
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await api(`/v1/funds/${ticker}/concentration`, { method: 'PATCH', body: { max_holder_pct: pct ? Number(pct) : null, max_holding_per_investor: amt ? Number(amt.replace(/[^0-9.]/g, '')) : null } });
      setNote(res.note); setEditing(false); r.reload();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const pctUsed = top && d.max_holder_pct ? Math.min(100, Math.round((top.pct / d.max_holder_pct) * 100)) : null;
  return (
    <Card title="Concentration limits" actions={<>{d.breached ? <Chip tone="no">Breached</Chip> : d.max_holder_pct || d.max_holding_per_investor ? <Chip tone="ok">Within limits</Chip> : <Chip>No limits set</Chip>}{!editing ? <PermBtn perm="funds:write" kind="ghost" onClick={start}>Edit limits</PermBtn> : null}</>}>
      <div class="kpis">
        <div class="kpi"><span>Largest holder</span><b>{top ? `${top.pct.toFixed(1)}%` : 'None'}</b><em>{top ? `${top.name}, ${money(top.value, currency)}` : 'no holdings in this workspace'}</em></div>
        <div class="kpi"><span>Single-holder cap</span><b>{d.max_holder_pct ? `${d.max_holder_pct}%` : 'None'}</b><em>{pctUsed !== null ? `${pctUsed}% of the cap used` : 'of fund assets'}</em></div>
        <div class="kpi"><span>Per-investor cap</span><b>{d.max_holding_per_investor ? compact(d.max_holding_per_investor, currency) : 'None'}</b><em>{top && d.max_holding_per_investor ? `largest holds ${Math.round((top.value / d.max_holding_per_investor) * 100)}% of it` : 'maximum holding value'}</em></div>
        <div class="kpi"><span>Assets</span><b>{compact(d.aum, currency)}</b><em>{d.holders_here} holder{d.holders_here === 1 ? '' : 's'} here, scaled to holders of record</em></div>
      </div>
      {note ? <p class="note small">{note}</p> : null}
      {editing ? (
        <form class="row-inline" onSubmit={save} style={{ alignItems: 'flex-end' }}>
          <Field label="Max share of assets (%)" hint="Empty for no cap"><input inputMode="decimal" value={pct} onInput={(e) => setPct((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''))} placeholder="10" /></Field>
          <Field label={`Max holding per investor (${currency})`} hint="Empty for no cap"><input inputMode="numeric" value={amt} onInput={(e) => setAmt((e.target as HTMLInputElement).value)} placeholder="25,000,000" /></Field>
          <PermBtn perm="funds:write" type="submit" kind="primary" busy={busy}>{busy ? 'Saving' : 'Save limits'}</PermBtn>
          <Btn kind="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
        </form>
      ) : null}
      <ErrorBox error={err} />
      {d.top_holders?.length > 1 ? <details class="small" style={{ marginTop: '0.5rem' }}><summary>Top holders</summary><ul>{d.top_holders.map((h: any) => <li>{h.name}: {money(h.value, currency)} ({h.pct.toFixed(1)}%)</li>)}</ul></details> : null}
      <p class="small muted" style={{ marginTop: '0.5rem' }}>Subscriptions and transfers that would push a holder past either limit fail the concentration check. Limits apply directly here with an audit event; the production path is a policy change with a second approver.</p>
    </Card>
  );
}

function PolicyEditor({ fund, onPublished }: { fund: any; onPublished: () => void }) {
  const init = () => Object.fromEntries(JURS.map((j) => [j, fund.distribution[j]?.accepts ?? []]));
  const [dist, setDist] = useState<Record<string, string[]>>(init);
  const [minSub, setMin] = useState<number>(fund.minSubscription);
  const [cap, setCap] = useState<string>(fund.holderCap ? String(fund.holderCap) : '');
  const [preview, setPreview] = useState<any>(null);
  const [backtest, setBacktest] = useState<any>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setDist(init()); setMin(fund.minSubscription); setCap(fund.holderCap ? String(fund.holderCap) : ''); }, [fund.ticker, JSON.stringify(fund.distribution)]);
  const payload = () => ({ distribution: Object.entries(dist).filter(([, a]) => a.length).map(([jurisdiction, accepts]) => ({ jurisdiction, accepts })), min_subscription: minSub, holder_cap: cap ? Number(cap) : null });
  const changed = JSON.stringify(payload()) !== JSON.stringify({ distribution: JURS.filter((j) => fund.distribution[j]).map((j) => ({ jurisdiction: j, accepts: fund.distribution[j].accepts })), min_subscription: fund.minSubscription, holder_cap: fund.holderCap ?? null });
  useEffect(() => {
    setBacktest(null);
    if (!changed) { setPreview(null); return; }
    const t = setTimeout(() => api(`/v1/funds/${fund.ticker}/policy/preview`, { body: payload() }).then((p) => { setPreview(p); setErr(null); }).catch(setErr), 300);
    return () => clearTimeout(t);
  }, [JSON.stringify(dist), minSub, cap]);
  const toggle = (j: string, code: string) => { const cur = dist[j] ?? []; setDist({ ...dist, [j]: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] }); };
  const propose = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await api(`/v1/funds/${fund.ticker}/policy/changes`, { body: payload() });
      track('policy_proposed', { ticker: fund.ticker, change: r.id });
      setMsg(`Proposed as ${r.id}. Someone else must approve it before it applies.`); onPublished();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const runBacktest = async () => {
    setBtBusy(true); setErr(null);
    try { setBacktest(await api(`/v1/funds/${fund.ticker}/policy/backtest`, { body: { ...payload(), days: 90 } })); } catch (e) { setErr(e); } finally { setBtBusy(false); }
  };
  return (
    <Card title="Distribution policy" actions={<Chip tone="info">Edits create a draft</Chip>}>
      <div class="tw"><table class="t policy">
        <thead><tr><th>Jurisdiction</th><th>Accepted investor classes</th><th>Status</th></tr></thead>
        <tbody>{JURS.map((j) => {
          const disabled = j === 'US' && fund.regS;
          const on = (dist[j] ?? []).length > 0;
          return (
            <tr class={on ? '' : 'off'}>
              <td><strong>{JUR[j]}</strong>{disabled ? <div class="small muted">Not available for a Regulation S fund</div> : null}</td>
              <td>{ACCEPTS[j].map((code) => <label class="check inline"><input type="checkbox" disabled={disabled} checked={(dist[j] ?? []).includes(code)} onChange={() => toggle(j, code)} /> {CLASS_LABEL[code]}</label>)}</td>
              <td>{on ? <Chip tone="ok">Offered</Chip> : fund.distribution[j] ? <Chip tone="warn">Removing</Chip> : <Chip>Not offered</Chip>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <div class="form-grid two" style={{ marginTop: '1rem' }}>
        <Field label={`Minimum subscription (${fund.currency})`}><input inputMode="numeric" value={minSub} onInput={(e) => setMin(Number((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, '')) || 0)} /></Field>
        <Field label="Holder cap" hint="Leave empty for no cap."><input inputMode="numeric" value={cap} onInput={(e) => setCap((e.target as HTMLInputElement).value.replace(/[^0-9]/g, ''))} /></Field>
      </div>
      {preview ? (
        <div class="impact2">
          <h3>Impact before you publish</h3>
          <PolicyDiff
            before={{ distribution: fund.distribution, min_subscription: fund.minSubscription, holder_cap: fund.holderCap ?? null, lockup_months: fund.lockupMonths ?? null }}
            after={{ ...payload(), lockup_months: fund.lockupMonths ?? null }}
            impact={preview} currency={fund.currency} />
          {preview.added.length ? <p>Opens the fund to credentialed investors in {preview.added.map((j: string) => JUR[j]).join(', ')} without new onboarding.</p> : null}
          <p class="muted small">{preview.note}</p>
          {backtest ? <Backtest r={backtest} currency={fund.currency} /> : null}
          <div class="row-inline">
            <PermBtn perm="funds:write" kind="primary" busy={busy} onClick={propose}>Propose change</PermBtn>
            <Btn busy={btBusy} onClick={runBacktest}>{backtest ? 'Run backtest again' : 'Backtest against past orders'}</Btn>
          </div>
          <PermNote perm="funds:write" />
        </div>
      ) : <p class="muted small">Change a jurisdiction, a class, the minimum or the cap to preview the effect on current holders and backtest it against the last 90 days of orders.</p>}
      {msg ? <div class="note">{msg}</div> : null}
      <ErrorBox error={err} />
    </Card>
  );
}

const OUT: Record<string, string> = { ALLOW: 'allowed', DENY: 'denied', FREEZE: 'frozen' };
/** Lists past orders whose outcome would flip under the proposed policy. */
function Backtest({ r, currency }: { r: any; currency: string }) {
  const flips: any[] = r.flips ?? r.changed ?? r.outcome_flips ?? [];
  const checked = r.decisions_checked ?? r.orders_checked ?? r.checked;
  const days = r.window_days ?? r.days ?? 90;
  return (
    <div class="backtest">
      <h3>Backtest: last {days} days</h3>
      <p>{checked !== undefined ? <><strong>{checked}</strong> past order{checked === 1 ? '' : 's'} re-run. </> : null}{flips.length ? <><strong>{flips.length}</strong> would have had a different outcome.</> : 'No outcome would have changed.'}</p>
      {flips.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Order</th><th>Client</th><th class="r">Amount</th><th>Then</th><th>Under this policy</th></tr></thead>
          <tbody>{flips.map((f) => {
            const from = f.from ?? f.before ?? f.original_outcome ?? f.outcome_before;
            const to = f.to ?? f.after ?? f.new_outcome ?? f.outcome_after;
            const idv = f.decision_id ?? f.id;
            return (
              <tr>
                <td>{idv ? <a href={`#/decisions/${idv}`}><code>{idv}</code></a> : null}<div class="small muted">{f.action ?? ''} {f.created_at ? when(f.created_at) : ''}</div></td>
                <td>{f.investor_name ?? f.investor ?? f.name ?? ''}</td>
                <td class="r">{f.amount !== undefined ? money(f.amount, currency) : ''}</td>
                <td>{from ? outcomeChip(from) : null}</td>
                <td>{to ? outcomeChip(to) : null}{f.reason ? <div class="small muted clamp">{f.reason}</div> : null}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : null}
      {r.truncated ? <p class="small muted">Only the most recent {checked} orders were re-run.</p> : null}
      {flips.some((f) => (f.to ?? f.after) && (f.to ?? f.after) !== 'ALLOW') ? <p class="small muted">Orders that would now be {OUT.DENY} were placed and may have settled. Publishing does not undo them; holders move to redemption-only instead.</p> : null}
      {r.note ? <p class="small muted">{r.note}</p> : null}
    </div>
  );
}

/** Current policy of a fund, fetched once per ticker when a change row is expanded. Null while loading or when unavailable. */
function useFundPolicy(ticker: string | null) {
  const [funds, setFunds] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!ticker || funds[ticker] !== undefined) return;
    api(`/v1/funds/${ticker}`).then((f) => setFunds((cur) => ({ ...cur, [ticker]: f }))).catch(() => setFunds((cur) => ({ ...cur, [ticker]: null })));
  }, [ticker]);
  return ticker ? funds[ticker] ?? null : null;
}

export function PolicyChangeList({ rows, onChange }: { rows: any[]; onChange: () => void }) {
  const { me, can, why, isSandbox, actorId, actAs } = useMe();
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const openRow = rows.find((p) => p.id === open) ?? null;
  const fund = useFundPolicy(openRow?.ticker ?? null);
  const actorName = me?.acting_as?.name ?? me?.user?.name;
  const act = async (id: string, kind: 'approve' | 'reject', ticker?: string) => {
    setErr(null); setBusy(id + kind);
    try { await api(`/v1/policy-changes/${id}/${kind}`, { body: {} }); if (kind === 'approve') track('policy_published', { change: id, ticker }); onChange(); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  // Sandbox helper: who else could approve. Prefer the issuer admin, then compliance, then you.
  const ownRole = me?.organizations?.find((o) => o.workspace_id === me.workspace.id)?.role ?? 'admin';
  const people = [...(me?.teammates ?? []).map((t) => ({ id: t.id as string | null, name: t.name, role: t.role })), { id: null as string | null, name: me?.user?.name ?? 'You', role: ownRole }];
  const rank: Record<string, number> = { issuer: 0, compliance: 1, admin: 2 };
  const approverFor = (p: any) => people
    .filter((x) => (x.id ?? me?.user?.id) !== (p.proposed_by_user ?? '') && x.name !== p.proposed_by && (x.id ?? me?.user?.id) !== actorId && x.role in rank)
    .sort((a, b) => rank[a.role] - rank[b.role])[0];
  const switchTo = async (x: { id: string | null }) => { setErr(null); try { await actAs(x.id); } catch (e) { setErr(e); } };
  if (!rows.length) return <Empty title="No policy changes yet">Edit a fund's distribution policy to propose one.</Empty>;
  return (
    <>
      <ErrorBox error={err} />
      <div class="tw"><table class="t">
        <thead><tr><th>Change</th><th>What changes</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((p) => {
          const mine = p.status === 'draft' && (p.proposed_by_user ? p.proposed_by_user === actorId : !!actorName && p.proposed_by === actorName);
          const cannot = !can('policy:approve');
          const helper = isSandbox && p.status === 'draft' && (mine || cannot) ? approverFor(p) : null;
          const expanded = open === p.id;
          return (
            <>
            <tr>
              <td><code>{p.id}</code> <span class="small muted">{p.ticker}</span><div class="small muted">Proposed by {p.proposed_by ?? 'unknown'}, {when(p.created_at)}</div></td>
              <td class="small">
                {p.impact.removed.length ? `Removes ${p.impact.removed.map((j: string) => JUR[j]).join(', ')}. ` : ''}{p.impact.added.length ? `Adds ${p.impact.added.map((j: string) => JUR[j]).join(', ')}. ` : ''}{p.impact.holders_affected.length} holder{p.impact.holders_affected.length === 1 ? '' : 's'} affected.
                <div><Btn kind="ghost" onClick={() => setOpen(expanded ? null : p.id)}>{expanded ? 'Hide diff' : 'Show diff'}</Btn></div>
              </td>
              <td>{p.status === 'draft' ? <Chip tone="warn">Awaiting approval</Chip> : p.status === 'published' ? <Chip tone="ok">Published by {p.approved_by}</Chip> : <Chip tone="no">Rejected by {p.approved_by}</Chip>}</td>
              <td class="approve-cell">{p.status === 'draft' ? (
                <>
                  <div class="row-inline tight">
                    <Btn kind="primary" disabled={mine || cannot} busy={busy === p.id + 'approve'} title={mine ? 'You proposed this. Another person must approve it.' : cannot ? why('policy:approve') : undefined} onClick={() => act(p.id, 'approve', p.ticker)}>Approve and publish</Btn>
                    <Btn kind="ghost" disabled={mine || cannot} busy={busy === p.id + 'reject'} title={mine ? 'You proposed this. Another person must decide on it.' : cannot ? why('policy:approve') : undefined} onClick={() => act(p.id, 'reject')}>Reject</Btn>
                  </div>
                  {mine ? <p class="perm-note">You proposed this. Another person must approve it.</p> : cannot ? <p class="perm-note">{why('policy:approve')}</p> : null}
                  {helper ? <Btn kind="ghost" class="switch-btn" onClick={() => switchTo(helper)}>{helper.id ? `Switch to ${helper.name.split(' ')[0]} to approve` : 'Switch back to you to approve'}</Btn> : null}
                </>
              ) : null}</td>
            </tr>
            {expanded ? (
              <tr class="expand">
                <td colSpan={4}>
                  <PolicyDiff
                    before={p.status === 'draft' && fund ? { distribution: fund.distribution, min_subscription: fund.minSubscription, holder_cap: fund.holderCap ?? null, lockup_months: fund.lockupMonths ?? null } : null}
                    after={p.changes}
                    impact={p.impact} currency={fund?.currency ?? p.impact?.currency} />
                  <p class="small muted">{p.status === 'draft' ? 'Before: the policy in force now. After: this proposal.' : `Decided ${p.decided_at ? when(p.decided_at) : ''}. Before is not shown for a decided change; the impact recorded at proposal time lists what it removed, added and whose standing it changed.`}</p>
                </td>
              </tr>
            ) : null}
            </>
          );
        })}</tbody>
      </table></div>
    </>
  );
}

export function PolicyChanges() {
  const r = useApi('/v1/policy-changes');
  return <><Head title="Policy changes" sub="Every distribution change needs a second person. Whoever proposed a change cannot approve it, and API keys can propose but never approve." />{r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : <Card pad={false}><PolicyChangeList rows={r.data.data} onChange={r.reload} /></Card>}</>;
}

const CHAIN_OPTIONS = ['Ethereum', 'Base', 'Polygon', 'Arbitrum', 'Avalanche', 'Solana', 'Canton', 'Stellar'];
const TZ_OPTIONS = ['America/New_York', 'Europe/London', 'Europe/Luxembourg', 'Europe/Dublin', 'Europe/Zurich', 'Europe/Frankfurt', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Dubai', 'Asia/Tokyo', 'UTC'];
const INITIAL_DOC_TYPES: Record<string, string> = { offering_memorandum: 'Offering memorandum', subscription_agreement: 'Subscription agreement', kid: 'Key information document (KID)', factsheet: 'Factsheet', risk_disclosure: 'Risk disclosure', privacy_notice: 'Privacy notice' };
type Doc = { doc_type: string; title: string; content: string; jurisdiction: string; audience: 'all' | 'retail' | 'professional'; required: boolean };

export function CreateFund() {
  const [f, setF] = useState({ ticker: '', name: '', domicile: 'Luxembourg', structure: 'Money market fund, tokenized share class', currency: 'USD', nav: 1, reg_s: true, min_subscription: 100000, holder_cap: '', lockup_months: '', assets: 'USDC', issuer: '' });
  const [terms, setTerms] = useState({ cutoff_time: '16:00', cutoff_tz: 'America/New_York', dealing_frequency: 'daily', notice_days: '0', gate_pct: '', yield_bps: '', share_class_type: 'distributing' });
  const [chains, setChains] = useState<string[]>(['Ethereum']);
  const [otherChain, setOtherChain] = useState('');
  const [docs, setDocs] = useState<Doc[]>([]);
  const [dist, setDist] = useState<Record<string, string[]>>({ SG: ['SG_AI'], HK: ['HK_PI'] });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const setT = (k: string, v: any) => setTerms({ ...terms, [k]: v });
  const toggleChain = (c: string) => setChains(chains.includes(c) ? chains.filter((x) => x !== c) : [...chains, c]);
  const addDoc = () => setDocs([...docs, { doc_type: 'offering_memorandum', title: '', content: '', jurisdiction: '', audience: 'all', required: true }]);
  const setDoc = (i: number, k: keyof Doc, v: any) => setDocs(docs.map((d, j) => (j === i ? { ...d, [k]: v, ...(k === 'doc_type' ? { required: v !== 'factsheet', title: d.title || INITIAL_DOC_TYPES[v] || d.title } : {}) } : d)));
  const allChains = [...chains, ...otherChain.split(',').map((x) => x.trim()).filter(Boolean)];
  const docProblems = docs.map((d) => (!d.title.trim() ? 'needs a title' : d.content.trim().length < 50 ? 'content is too short (50 characters at least)' : null));
  const submit = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const body = {
        ...f, ticker: f.ticker.toUpperCase(), nav: Number(f.nav), min_subscription: Number(f.min_subscription), holder_cap: f.holder_cap ? Number(f.holder_cap) : null, lockup_months: f.lockup_months ? Number(f.lockup_months) : null,
        assets: f.assets.split(',').map((x) => x.trim()).filter(Boolean), chains: allChains,
        distribution: Object.entries(dist).filter(([, a]) => a.length).map(([jurisdiction, accepts]) => ({ jurisdiction, accepts })),
        cutoff_time: terms.cutoff_time, cutoff_tz: terms.cutoff_tz, dealing_frequency: terms.dealing_frequency, notice_days: Number(terms.notice_days) || 0,
        gate_pct: terms.gate_pct ? Number(terms.gate_pct) : null, yield_bps: terms.yield_bps ? Math.round(Number(terms.yield_bps) * 100) : null, share_class_type: terms.share_class_type,
        documents: docs.map((d) => ({ doc_type: d.doc_type, title: d.title.trim(), content: d.content, jurisdiction: d.jurisdiction || null, audience: d.audience, required: d.required })),
      };
      const r = await api('/v1/funds', { body });
      track('fund_created', { ticker: r.ticker, documents: docs.length, chains: allChains.length });
      go(`/funds/${r.ticker}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <>
      <Head title="Create a tokenized fund" sub="Register the fund, its dealing terms, its first documents and its first distribution policy. Law rules for each jurisdiction come from the launch rule packs." />
      <form onSubmit={submit}>
        <Card title="1. Fund">
          <div class="form-grid">
            <Field label="Ticker" hint="3 to 6 capital letters"><input required value={f.ticker} onInput={(e) => set('ticker', (e.target as HTMLInputElement).value.toUpperCase())} placeholder="ORLF" /></Field>
            <Field label="Fund name"><input required value={f.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} placeholder="Orla Liquidity Fund, Tokenized Class" /></Field>
            <Field label="Issuer"><input required value={f.issuer} onInput={(e) => set('issuer', (e.target as HTMLInputElement).value)} placeholder="Orla Asset Management (fictional)" /></Field>
            <Field label="Domicile"><input value={f.domicile} onInput={(e) => set('domicile', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Structure"><input value={f.structure} onInput={(e) => set('structure', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Currency"><select value={f.currency} onChange={(e) => set('currency', (e.target as HTMLSelectElement).value)}><option>USD</option><option>EUR</option></select></Field>
            <Field label="NAV per unit"><input inputMode="decimal" value={f.nav} onInput={(e) => set('nav', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Minimum subscription"><input inputMode="numeric" value={f.min_subscription} onInput={(e) => set('min_subscription', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Holder cap" hint="Optional"><input inputMode="numeric" value={f.holder_cap} onInput={(e) => set('holder_cap', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Lock-up (months)" hint="Optional"><input inputMode="numeric" value={f.lockup_months} onInput={(e) => set('lockup_months', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Accepted cash assets" hint="Comma-separated"><input value={f.assets} onInput={(e) => set('assets', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Regulation S"><label class="check"><input type="checkbox" checked={f.reg_s} onChange={(e) => set('reg_s', (e.target as HTMLInputElement).checked)} /> Offered to non-U.S. persons only</label></Field>
          </div>
        </Card>

        <Card title="2. Dealing terms">
          <div class="form-grid">
            <Field label="Dealing frequency"><select value={terms.dealing_frequency} onChange={(e) => setT('dealing_frequency', (e.target as HTMLSelectElement).value)}><option value="daily">Daily</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></Field>
            <Field label="Cut-off time" hint="Orders after the cut-off deal on the next dealing day"><input type="time" required value={terms.cutoff_time} onInput={(e) => setT('cutoff_time', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Time zone"><input list="tz-options" required value={terms.cutoff_tz} onInput={(e) => setT('cutoff_tz', (e.target as HTMLInputElement).value)} placeholder="America/New_York" /><datalist id="tz-options">{TZ_OPTIONS.map((z) => <option value={z} />)}</datalist></Field>
            <Field label="Redemption notice (days)" hint="0 for none"><input inputMode="numeric" value={terms.notice_days} onInput={(e) => setT('notice_days', (e.target as HTMLInputElement).value.replace(/[^0-9]/g, ''))} /></Field>
            <Field label="Redemption gate (% of AUM per period)" hint="Optional"><input inputMode="decimal" value={terms.gate_pct} onInput={(e) => setT('gate_pct', (e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''))} placeholder="10" /></Field>
            <Field label="Target yield (% a year)" hint="Optional, shown to investors in the portal"><input inputMode="decimal" value={terms.yield_bps} onInput={(e) => setT('yield_bps', (e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''))} placeholder="4.85" /></Field>
            <Field label="Share class type"><select value={terms.share_class_type} onChange={(e) => setT('share_class_type', (e.target as HTMLSelectElement).value)}><option value="distributing">Distributing (pays income out)</option><option value="accumulating">Accumulating (income stays in the NAV)</option></select></Field>
          </div>
        </Card>

        <Card title="3. Chains">
          <p class="small muted">Where the fund's units are issued. Settlement on Laissez runs on Base Sepolia for test funds; this list is what investors and counterparties see.</p>
          <div class="pick">{CHAIN_OPTIONS.map((c) => <label class={`pick-i ${chains.includes(c) ? 'on' : ''}`}><input type="checkbox" checked={chains.includes(c)} onChange={() => toggleChain(c)} /><span>{c}</span></label>)}</div>
          <Field label="Other chains" hint="Comma-separated"><input value={otherChain} onInput={(e) => setOtherChain((e.target as HTMLInputElement).value)} placeholder="Tezos, Hedera" /></Field>
          {!allChains.length ? <p class="verdict-line warn">Pick at least one chain.</p> : null}
        </Card>

        <Card title="4. Initial documents" actions={<Btn kind="ghost" onClick={addDoc} disabled={docs.length >= 12}>Add document</Btn>}>
          <p class="small muted">Published as version 1 with the fund. Required documents must be acknowledged by each investor before they subscribe; later versions are published from the fund page.</p>
          {!docs.length ? <p class="muted small">No documents yet. A fund can launch without them, but investors then have nothing to read in the portal.</p> : null}
          {docs.map((d, i) => (
            <div class="form-grid" style={{ borderTop: i ? '1px solid var(--line, #ddd6c9)' : 'none', paddingTop: i ? '0.8rem' : 0, marginTop: i ? '0.8rem' : 0 }}>
              <Field label="Type"><select value={d.doc_type} onChange={(e) => setDoc(i, 'doc_type', (e.target as HTMLSelectElement).value)}>{Object.entries(INITIAL_DOC_TYPES).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
              <Field label="Title"><input required value={d.title} onInput={(e) => setDoc(i, 'title', (e.target as HTMLInputElement).value)} placeholder={INITIAL_DOC_TYPES[d.doc_type]} /></Field>
              <Field label="Jurisdiction" hint="Empty applies everywhere"><select value={d.jurisdiction} onChange={(e) => setDoc(i, 'jurisdiction', (e.target as HTMLSelectElement).value)}><option value="">Everywhere</option>{JURS.map((j) => <option value={j}>{JUR[j]}</option>)}</select></Field>
              <Field label="Audience"><select value={d.audience} onChange={(e) => setDoc(i, 'audience', (e.target as HTMLSelectElement).value)}><option value="all">All investors</option><option value="professional">Professional only</option><option value="retail">Retail only</option></select></Field>
              <Field label="Acknowledgment"><label class="check"><input type="checkbox" checked={d.required} onChange={(e) => setDoc(i, 'required', (e.target as HTMLInputElement).checked)} /> Required before subscribing</label></Field>
              <div class="span2"><Field label="Content" hint={docProblems[i] ? `This document ${docProblems[i]}.` : `${d.content.length.toLocaleString('en-US')} characters. Plain text; paragraphs separated by a blank line, headings with #.`}><textarea rows={6} required minLength={50} value={d.content} onInput={(e) => setDoc(i, 'content', (e.target as HTMLTextAreaElement).value)} /></Field></div>
              <div class="form-actions"><Btn kind="ghost" onClick={() => setDocs(docs.filter((_, j) => j !== i))}>Remove</Btn></div>
            </div>
          ))}
        </Card>

        <Card title="5. Offered in">
          <div class="pick">{JURS.filter((j) => !(j === 'US' && f.reg_s)).map((j) => ACCEPTS[j].map((code) => <label class={`pick-i ${(dist[j] ?? []).includes(code) ? 'on' : ''}`}><input type="checkbox" checked={(dist[j] ?? []).includes(code)} onChange={() => { const cur = dist[j] ?? []; setDist({ ...dist, [j]: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] }); }} /><span>{JUR[j]}: {CLASS_LABEL[code]}</span></label>))}</div>
          <div class="form-actions"><PermBtn perm="funds:write" type="submit" kind="primary" busy={busy} disabled={!allChains.length || docProblems.some(Boolean)}>{busy ? 'Creating' : 'Create fund'}</PermBtn><Btn kind="ghost" onClick={() => go('/funds')}>Cancel</Btn></div>
          <PermNote perm="funds:write" />
          <ErrorBox error={err} />
        </Card>
      </form>
    </>
  );
}
