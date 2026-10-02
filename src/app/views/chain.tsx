/** @jsxImportSource preact */
// On-chain settlement: the ERC-3643 contracts on Base Sepolia, recent chain jobs, and reconciliation of token
// balances against the Laissez register.
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, when, shortHash, JUR } from '../api';
import { useApi, Head, Chip, Card, Empty, Loading, ErrorBox, Field, Toast, Hash } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const COUNTRY: Record<number, string> = { 702: 'Singapore', 344: 'Hong Kong', 756: 'Switzerland', 276: 'Germany', 784: 'UAE', 840: 'United States', 826: 'United Kingdom', 392: 'Japan', 442: 'Luxembourg', 372: 'Ireland' };
const JOB_LABEL: Record<string, string> = { settle: 'Settlement', revoke_claim: 'Claim revocation', policy_sync: 'Policy sync', break_demo: 'Simulated break' };
const fmt = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  return { msg, show: (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); } };
}

const jobChip = (s: string) => s === 'confirmed' ? <Chip tone="ok">Confirmed</Chip> : s === 'failed' ? <Chip tone="no">Failed</Chip> : s === 'running' ? <Chip tone="info">Running</Chip> : <Chip tone="warn">Queued</Chip>;

function Ext({ href, children }: { href?: string | null; children: ComponentChildren }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noopener">{children} <span aria-hidden="true">↗</span><span class="sr">(opens the block explorer)</span></a>;
}

export function ChainJobs({ limit = 12 }: { limit?: number }) {
  const r = useApi('/v1/chain/jobs');
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const rows = (r.data?.data ?? []).slice(0, limit);
  if (!rows.length) return <Empty title="No chain jobs yet">Settle an allowed decision and its transactions appear here.</Empty>;
  return (
    <div class="tw"><table class="t">
      <thead><tr><th>When</th><th>Job</th><th>Reference</th><th>Status</th><th>Transactions</th></tr></thead>
      <tbody>{rows.map((j: any) => (
        <tr>
          <td class="muted nowrap">{when(j.created_at)}</td>
          <td>{JOB_LABEL[j.kind] ?? j.kind}{j.attempts > 1 ? <div class="small muted">{j.attempts} attempts</div> : null}</td>
          <td><code>{j.ref}</code></td>
          <td>{jobChip(j.status)}{j.error && j.status !== 'confirmed' ? <div class="small muted">{j.error}</div> : null}</td>
          <td class="small mono">{j.transactions.length ? j.transactions.map((t: any) => <div><Ext href={t.url}>{shortHash(t.hash, 14)}</Ext></div>) : <span class="muted">None</span>}{j.block ? <div class="muted">Block {fmt(j.block)}</div> : null}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export function ChainOverview() {
  const r = useApi('/v1/chain');
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const head = <Head title="On-chain settlement" sub="Fund units are ERC-3643 tokens. Laissez is the trusted claim issuer that every fund registry relies on, and settlement is one atomic delivery-versus-payment transaction." />;
  if (!d.network) return <>{head}<div class="note">{d.message}</div></>;
  return (
    <>
      {head}
      {!d.enabled ? <div class="note">Contracts are deployed, but the operator key is not set on this API, so settlements run on the simulated register.</div> : null}
      {d.enabled && d.operator.funded === false ? <div class="note">The operator wallet has no ETH on {d.network_label}, so new transactions cannot be paid for. Fund <code>{d.operator.address}</code> from a faucet.</div> : null}
      <div class="kpis">
        <div class="kpi"><span>Network</span><b>{d.network_label}</b><em>Chain ID {d.chain_id}</em></div>
        <div class="kpi"><span>Operator balance</span><b>{d.operator.balance_eth === null ? 'Unknown' : `${d.operator.balance_eth.toFixed(4)} ETH`}</b><em><Ext href={d.operator.url}>{shortHash(d.operator.address, 12)}</Ext></em></div>
        <div class="kpi"><span>Fund tokens</span><b>{d.funds.length}</b><em>{d.funds.map((f: any) => f.ticker).join(', ')}, 6 decimals</em></div>
        <div class="kpi"><span>Eligibility claim</span><b>Topic {d.claim_topic}</b><em>Signed by <code>{shortHash(d.claim_signer, 12)}</code></em></div>
      </div>
      <Card title="How the trusted claim issuer works">
        <p>Each investor gets an ONCHAINID identity, and Laissez signs its eligibility credential onto that identity as claim {d.claim_topic}.</p>
        <p>Every fund's identity registry trusts only the Laissez claim issuer, so units can never reach a wallet without a valid claim, even if someone bypasses the Laissez API.</p>
        <p>Revoking a credential revokes the claim on-chain, and the next transfer to that investor reverts while redemptions still go through.</p>
      </Card>
      <div class="grid2">
        <Card title="Contracts" pad={false}>
          <div class="tw"><table class="t"><thead><tr><th>Contract</th><th>Address</th></tr></thead>
            <tbody>{d.contracts.map((c: any) => <tr><td><strong>{c.name}</strong><div class="small muted">{c.role}</div></td><td class="small mono nowrap"><Ext href={c.url}>{shortHash(c.address, 12)}</Ext></td></tr>)}</tbody>
          </table></div>
        </Card>
        <Card title="Fund tokens" pad={false}>
          <div class="tw"><table class="t"><thead><tr><th>Fund</th><th>Distribution on-chain</th></tr></thead>
            <tbody>{d.funds.map((f: any) => (
              <tr>
                <td><strong>{f.ticker}</strong> <Chip>{f.currency === 'EUR' ? 'tEUR' : 'tUSD'}</Chip><div class="small mono"><Ext href={f.token_url}>{shortHash(f.token, 12)}</Ext></div><div class="small muted">Treasury <Hash value={f.treasury} n={10} /></div></td>
                <td class="small">{f.countries.map((n: number) => COUNTRY[n] ?? n).join(', ')}<div class="muted">From {f.jurisdictions.map((j: string) => JUR[j] ?? j).join(', ')}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      </div>
      <Card title="Recent chain jobs" pad={false}><ChainJobs /></Card>
      <p class="small muted">Test network only. tUSD and tEUR are test assets with no value. Deployed {when(d.deployed_at)}, blocks {fmt(d.blocks.start)} to {fmt(d.blocks.end)}.</p>
    </>
  );
}

export function Reconciliation() {
  const { isSandbox } = useMe();
  const r = useApi('/v1/reconciliation');
  const investors = useApi(isSandbox ? '/v1/investors' : null);
  const [last, setLast] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sim, setSim] = useState({ investor_id: 'lumen', ticker: 'TWLF' });
  const toast = useToast();

  const run = async () => {
    setBusy('run'); setErr(null);
    try {
      const res = await api('/v1/reconciliation/run', { method: 'POST', body: {} });
      setLast(res); r.reload();
      toast.show(res.run.breaks ? `${res.run.breaks} break${res.run.breaks === 1 ? '' : 's'} found across ${res.run.positions} positions.` : `All ${res.run.positions} positions match the chain.`);
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const resolve = async (id: string, resolution: 'adjust_register' | 'investigated') => {
    setBusy(id + resolution); setErr(null);
    try {
      await api(`/v1/reconciliation/breaks/${id}/resolve`, { method: 'POST', body: { resolution, note: notes[id] || undefined } });
      r.reload();
      toast.show(resolution === 'adjust_register' ? 'Register adjusted to the chain balance.' : 'Break marked as investigated.');
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const simulate = async () => {
    setBusy('sim'); setErr(null);
    try { const res = await api('/v1/reconciliation/simulate-break', { method: 'POST', body: sim }); toast.show(res.message); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };

  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const runs = r.data.runs ?? [];
  const breaks = r.data.breaks ?? [];
  const open = breaks.filter((b: any) => b.status === 'open');
  const latest = runs[0];
  return (
    <>
      <Head title="Reconciliation" sub="Compares every onboarded investor's token balance on-chain with the Laissez register. Each difference opens a break and a work item." actions={<PermBtn perm="compliance:write" kind="primary" onClick={run} busy={busy === 'run'} disabled={!r.data.enabled}>Run reconciliation</PermBtn>} />
      {!r.data.enabled ? <div class="note">On-chain settlement is not configured, so there are no token balances to reconcile yet.</div> : null}
      <PermNote perm="compliance:write" />
      <ErrorBox error={err} />
      <div class="kpis">
        <div class="kpi"><span>Open breaks</span><b>{open.length}</b><em>{open.length ? 'Resolve each one below' : 'Register and chain agree'}</em></div>
        <div class="kpi"><span>Positions compared</span><b>{latest ? fmt(latest.positions) : 'None'}</b><em>{latest ? `Last run ${when(latest.started_at)}` : 'Run reconciliation to start'}</em></div>
        <div class="kpi"><span>Chain block</span><b>{latest?.chain_block ? fmt(latest.chain_block) : 'None'}</b><em>Balances read in one Multicall3 call</em></div>
      </div>

      {last ? (
        <Card title={`Run ${last.run.id}: positions`} pad={false}>
          {last.positions.length ? (
            <div class="tw"><table class="t"><thead><tr><th>Investor</th><th>Fund</th><th class="r">Register</th><th class="r">Chain</th><th>Result</th></tr></thead>
              <tbody>{last.positions.map((p: any) => (
                <tr class={p.status === 'off_chain' ? 'off' : ''}>
                  <td>{p.name}</td><td><code>{p.ticker}</code></td><td class="r">{fmt(p.register)}</td><td class="r">{p.status === 'off_chain' ? 'Not on-chain' : fmt(p.chain)}</td>
                  <td>{p.status === 'matched' ? <Chip tone="ok">Matches</Chip> : p.status === 'break' ? <Chip tone="no">Break {signed(p.chain - p.register)}</Chip> : <Chip>Register only</Chip>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No onboarded investors yet">Investors go on-chain with their first settlement.</Empty>}
        </Card>
      ) : null}

      <Card title="Breaks" pad={false}>
        {breaks.length ? (
          <div class="tw"><table class="t"><thead><tr><th>Investor</th><th>Fund</th><th class="r">Register</th><th class="r">Chain</th><th class="r">Difference</th><th>Status</th></tr></thead>
            <tbody>{breaks.map((b: any) => (
              <tr class={b.status === 'open' ? '' : 'off'}>
                <td>{b.investor ?? b.investor_id}<div class="small muted">Found {when(b.created_at)}</div></td>
                <td><code>{b.ticker}</code></td>
                <td class="r">{fmt(b.register_units)}</td><td class="r">{fmt(b.chain_units)}</td><td class="r">{signed(b.difference)}</td>
                <td>
                  {b.status === 'open' ? (
                    <div class="row-inline tight">
                      <input class="sm" placeholder="Note (optional)" aria-label={`Note for break ${b.id}`} value={notes[b.id] ?? ''} onInput={(e) => setNotes({ ...notes, [b.id]: (e.target as HTMLInputElement).value })} />
                      <PermBtn perm="compliance:write" onClick={() => resolve(b.id, 'adjust_register')} busy={busy === b.id + 'adjust_register'}>Adjust register</PermBtn>
                      <PermBtn perm="compliance:write" kind="ghost" onClick={() => resolve(b.id, 'investigated')} busy={busy === b.id + 'investigated'}>Mark investigated</PermBtn>
                    </div>
                  ) : (
                    <><Chip tone={b.resolution === 'adjust_register' ? 'info' : 'ok'}>{b.resolution === 'adjust_register' ? 'Register adjusted' : b.resolution === 'cleared' ? 'Cleared' : 'Investigated'}</Chip><div class="small muted">{b.resolved_by}{b.note ? `: ${b.note}` : ''}</div></>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No breaks">Every reconciled position matched the chain.</Empty>}
      </Card>

      {isSandbox && r.data.enabled ? (
        <Card title="Simulate a break">
          <p class="small muted">The operator mints 1,000 units straight to the investor's wallet on-chain without touching the register, the way an unrecorded corporate action or a key compromise would. Then run reconciliation to catch it. Sandboxes only.</p>
          <div class="row-inline">
            <Field label="Investor"><select value={sim.investor_id} onChange={(e) => setSim({ ...sim, investor_id: (e.target as HTMLSelectElement).value })}>{(investors.data?.data ?? [{ id: 'lumen', name: 'Lumen Family Office' }]).map((i: any) => <option value={i.id}>{i.name}</option>)}</select></Field>
            <Field label="Fund"><select value={sim.ticker} onChange={(e) => setSim({ ...sim, ticker: (e.target as HTMLSelectElement).value })}>{['TWLF', 'NMEL', 'AGPC'].map((t) => <option value={t}>{t}</option>)}</select></Field>
            <PermBtn perm="compliance:write" onClick={simulate} busy={busy === 'sim'}>Mint 1,000 units on-chain</PermBtn>
          </div>
        </Card>
      ) : null}

      <Card title="Runs" pad={false}>
        {runs.length ? (
          <div class="tw"><table class="t"><thead><tr><th>Run</th><th>Started</th><th>Trigger</th><th class="r">Positions</th><th class="r">Breaks</th><th class="r">Block</th></tr></thead>
            <tbody>{runs.map((x: any) => <tr><td><code>{x.id}</code></td><td class="muted nowrap">{when(x.started_at)}</td><td>{x.trigger === 'manual' ? 'Manual' : 'Scheduled'}</td><td class="r">{fmt(x.positions)}</td><td class="r">{x.breaks ? <Chip tone="no">{x.breaks}</Chip> : '0'}</td><td class="r">{x.chain_block ? fmt(x.chain_block) : ''}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty title="No runs yet">Run reconciliation to compare the register with the chain.</Empty>}
      </Card>
      <Toast msg={toast.msg} />
    </>
  );
}
