/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { api, money, compact, when, JUR, CLASS_LABEL, track } from '../api';
import { useApi, Head, Btn, Chip, statusChip, outcomeChip, ErrorBox, Loading, Empty, Field, Card, go } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';
import { FundOps } from './fundops';

const JURS = ['SG', 'HK', 'CH', 'DE', 'LU', 'IE', 'GB', 'AE-DIFC', 'AE-ADGM', 'JP', 'US'];
const ACCEPTS: Record<string, string[]> = { SG: ['SG_AI'], HK: ['HK_PI'], CH: ['CH_PRO'], DE: ['EU_PRO', 'EU_RETAIL'], 'AE-DIFC': ['DIFC_PRO'], US: ['US_AI'], LU: ['EU_PRO'], IE: ['EU_PRO'], GB: ['GB_PRO', 'GB_EPRO'], 'AE-ADGM': ['ADGM_PRO'], JP: ['JP_QII'] };

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
          {preview.holders_affected.length ? (
            <>
              <p><strong>{preview.holders_affected.length} holder{preview.holders_affected.length > 1 ? 's' : ''}</strong> with <strong>{money(preview.value_affected, preview.currency)}</strong> change status.</p>
              <ul>{preview.holders_affected.map((h: any) => <li>{h.name}: {h.from} to {h.to}</li>)}</ul>
            </>
          ) : <p>No existing holder in this workspace changes status.</p>}
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

export function PolicyChangeList({ rows, onChange }: { rows: any[]; onChange: () => void }) {
  const { me, can, why, isSandbox, actorId, actAs } = useMe();
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
          return (
            <tr>
              <td><code>{p.id}</code> <span class="small muted">{p.ticker}</span><div class="small muted">Proposed by {p.proposed_by ?? 'unknown'}, {when(p.created_at)}</div></td>
              <td class="small">{p.impact.removed.length ? `Removes ${p.impact.removed.map((j: string) => JUR[j]).join(', ')}. ` : ''}{p.impact.added.length ? `Adds ${p.impact.added.map((j: string) => JUR[j]).join(', ')}. ` : ''}{p.impact.holders_affected.length} holder{p.impact.holders_affected.length === 1 ? '' : 's'} affected.</td>
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

export function CreateFund() {
  const [f, setF] = useState({ ticker: '', name: '', domicile: 'Luxembourg', structure: 'Money market fund, tokenized share class', currency: 'USD', nav: 1, reg_s: true, min_subscription: 100000, holder_cap: '', lockup_months: '', assets: 'USDC', chains: 'Ethereum', issuer: '' });
  const [dist, setDist] = useState<Record<string, string[]>>({ SG: ['SG_AI'], HK: ['HK_PI'] });
  const [err, setErr] = useState<any>(null);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const submit = async (e: Event) => {
    e.preventDefault(); setErr(null);
    try {
      const body = { ...f, ticker: f.ticker.toUpperCase(), nav: Number(f.nav), min_subscription: Number(f.min_subscription), holder_cap: f.holder_cap ? Number(f.holder_cap) : null, lockup_months: f.lockup_months ? Number(f.lockup_months) : null, assets: f.assets.split(',').map((s) => s.trim()).filter(Boolean), chains: f.chains.split(',').map((s) => s.trim()).filter(Boolean), distribution: Object.entries(dist).filter(([, a]) => a.length).map(([jurisdiction, accepts]) => ({ jurisdiction, accepts })) };
      const r = await api('/v1/funds', { body }); go(`/funds/${r.ticker}`);
    } catch (x) { setErr(x); }
  };
  return (
    <>
      <Head title="Create a tokenized fund" sub="Register the fund and its first distribution policy. Law rules for each jurisdiction come from the launch rule packs." />
      <Card>
        <form class="form-grid" onSubmit={submit}>
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
          <Field label="Chains" hint="Comma-separated"><input value={f.chains} onInput={(e) => set('chains', (e.target as HTMLInputElement).value)} /></Field>
          <Field label="Regulation S"><label class="check"><input type="checkbox" checked={f.reg_s} onChange={(e) => set('reg_s', (e.target as HTMLInputElement).checked)} /> Offered to non-U.S. persons only</label></Field>
          <div class="span2"><span class="f-l">Offered in</span>
            <div class="pick">{JURS.filter((j) => !(j === 'US' && f.reg_s)).map((j) => ACCEPTS[j].map((code) => <label class={`pick-i ${(dist[j] ?? []).includes(code) ? 'on' : ''}`}><input type="checkbox" checked={(dist[j] ?? []).includes(code)} onChange={() => { const cur = dist[j] ?? []; setDist({ ...dist, [j]: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] }); }} /><span>{JUR[j]}: {CLASS_LABEL[code]}</span></label>))}</div>
          </div>
          <div class="form-actions"><PermBtn perm="funds:write" type="submit" kind="primary">Create fund</PermBtn><Btn kind="ghost" onClick={() => go('/funds')}>Cancel</Btn></div>
        </form>
        <PermNote perm="funds:write" />
        <ErrorBox error={err} />
      </Card>
    </>
  );
}
