/** @jsxImportSource preact */
// On-chain settlement: the ERC-3643 contracts on Base Sepolia, recent chain jobs, and reconciliation of token
// balances against the Laissez register.
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, when, shortHash, JUR } from '../api';
import { useApi, Head, Btn, Chip, Card, Empty, Loading, ErrorBox, Field, Toast, Hash, ConfirmBtn } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const COUNTRY: Record<number, string> = { 702: 'Singapore', 344: 'Hong Kong', 756: 'Switzerland', 276: 'Germany', 784: 'UAE', 840: 'United States', 826: 'United Kingdom', 392: 'Japan', 442: 'Luxembourg', 372: 'Ireland' };
const JOB_LABEL: Record<string, string> = { settle: 'Settlement', revoke_claim: 'Claim revocation', policy_sync: 'Policy sync', break_demo: 'Simulated break' };
const fmt = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  return { msg, show: (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); } };
}

const jobChip = (s: string) => s === 'confirmed' ? <Chip tone="ok">Confirmed</Chip> : s === 'failed' ? <Chip tone="no">Failed</Chip> : s === 'running' ? <Chip tone="info">Running</Chip> : s === 'cancelled' ? <Chip>Cancelled</Chip> : <Chip tone="warn">Queued</Chip>;

/** Loads a paginated list ({ data, next_cursor }) and appends further pages on demand. */
function usePaged(path: string | null) {
  const [rows, setRows] = useState<any[]>([]);
  const [extra, setExtra] = useState<any>({});
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<any>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true; setLoading(true);
    api(path).then((d) => { if (!live) return; const { data, next_cursor, ...rest } = d; setRows(data ?? []); setNext(next_cursor ?? null); setExtra(rest); setError(null); }).catch((e) => { if (live) setError(e); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, n]);
  const loadMore = async () => {
    if (!next || !path) return;
    setMore(true);
    try { const d = await api(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}`); setRows((r) => [...r, ...(d.data ?? [])]); setNext(d.next_cursor ?? null); }
    catch (e) { setError(e); } finally { setMore(false); }
  };
  return { rows, extra, next, loading, more, error, loadMore, reload: () => setN((x) => x + 1), setRows };
}

function Ext({ href, children }: { href?: string | null; children: ComponentChildren }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noopener">{children} <span aria-hidden="true">↗</span><span class="sr">(opens the block explorer)</span></a>;
}

const refLink = (j: any) => j.kind === 'settle' ? `#/settlements/${j.ref}` : j.kind === 'revoke_claim' || j.kind === 'break_demo' ? `#/clients/${j.ref}` : j.kind === 'policy_sync' ? `#/funds/${j.ref}` : null;

/** The chain job queue: every transaction Laissez sent or will send, with per-job retry and cancel. */
export function ChainJobs({ limit = 25, filterable = true }: { limit?: number; filterable?: boolean }) {
  const [status, setStatus] = useState('');
  const r = usePaged(`/v1/chain/jobs?limit=${limit}${status ? `&status=${status}` : ''}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const toast = useToast();
  const act = async (j: any, what: 'retry' | 'cancel') => {
    setBusy(j.id + what); setErr(null);
    try {
      const next = await api(`/v1/chain/jobs/${j.id}/${what}`, { body: {} });
      r.setRows((rows) => rows.map((x) => (x.id === next.id ? next : x)));
      toast.show(what === 'retry' ? (next.status === 'confirmed' ? 'Retried and confirmed on chain.' : next.status === 'failed' ? `Retried, failed again: ${next.error ?? 'no reason'}` : `Retried. The job is ${next.status}.`) : 'Job cancelled. Nothing was sent on chain.');
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  if (r.loading && !r.rows.length) return <Loading />;
  if (r.error && !r.rows.length) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const counts = r.extra?.counts ?? {};
  return (
    <>
      {filterable ? (
        <div class="row-inline tight" style={{ padding: '0.6rem 1.35rem', gap: '0.8rem', flexWrap: 'wrap' }}>
          <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Job status"><option value="">All jobs</option><option value="queued">Queued</option><option value="running">Running</option><option value="failed">Failed</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option></select>
          <span class="small muted">{counts.queued ?? 0} queued, {counts.running ?? 0} running, {counts.failed ?? 0} failed</span>
          <Btn kind="ghost" onClick={r.reload}>Refresh</Btn>
        </div>
      ) : null}
      <ErrorBox error={err} />
      {!r.rows.length ? <Empty title={status ? `No ${status} jobs` : 'No chain jobs yet'}>Settle an allowed decision and its transactions appear here.</Empty> : (
        <div class="tw"><table class="t">
          <thead><tr><th>When</th><th>Job</th><th>Reference</th><th>Status</th><th>Transactions</th><th /></tr></thead>
          <tbody>{r.rows.map((j: any) => (
            <tr class={j.status === 'cancelled' ? 'off' : ''}>
              <td class="muted nowrap">{when(j.created_at)}<div class="small"><code>{j.id}</code></div></td>
              <td>{JOB_LABEL[j.kind] ?? j.kind}{j.attempts > 1 ? <div class="small muted">{j.attempts} attempts</div> : null}{j.retries ? <div class="small muted">Retried {j.retries} time{j.retries === 1 ? '' : 's'}{j.retried_by ? ` by ${j.retried_by}` : ''}</div> : null}</td>
              <td>{refLink(j) ? <a href={refLink(j)!}><code>{j.ref}</code></a> : <code>{j.ref}</code>}</td>
              <td>{jobChip(j.status)}{j.error && j.status !== 'confirmed' ? <div class="small muted">{j.error}</div> : null}{j.status === 'confirmed' && j.error ? <div class="small muted">{j.error}</div> : null}</td>
              <td class="small mono">{j.transactions.length ? j.transactions.map((t: any) => <div><Ext href={t.url}>{shortHash(t.hash, 14)}</Ext></div>) : <span class="muted">None</span>}{j.block ? <div class="muted">Block {fmt(j.block)}</div> : null}</td>
              <td class="r nowrap">
                {j.retryable ? <PermBtn perm="compliance:write" kind="ghost" busy={busy === j.id + 'retry'} onClick={() => act(j, 'retry')}>Retry</PermBtn> : null}
                {j.cancellable ? <ConfirmBtn kind="ghost" confirm="Cancel job" onConfirm={() => act(j, 'cancel')}>Cancel</ConfirmBtn> : null}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {r.next ? <div class="row-inline" style={{ justifyContent: 'center', padding: '0.6rem 0 1rem' }}><Btn kind="ghost" busy={r.more} onClick={r.loadMore}>Load more jobs</Btn><span class="small muted">{r.rows.length} loaded</span></div> : null}
      <Toast msg={toast.msg} />
    </>
  );
}

export function ChainJobsPage() {
  return (
    <>
      <Head title="Chain jobs" sub="Every transaction Laissez queued for the chain: settlements, claim revocations, policy syncs. Failed jobs can be retried; queued jobs that have not sent anything can be cancelled. Settlement jobs whose settlement already reverted are retried from the settlement page, which re-checks the decision." />
      <PermNote perm="compliance:write" />
      <Card pad={false}><ChainJobs limit={50} /></Card>
    </>
  );
}

/** Reconciliation at a glance for the On-chain page: open breaks, last run, and the link to resolve them. */
function ReconSummary() {
  const r = useApi('/v1/reconciliation');
  if (r.loading && !r.data) return <Card title="Reconciliation"><Loading /></Card>;
  if (r.error) return <Card title="Reconciliation"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const runs: any[] = r.data?.runs ?? []; const breaks: any[] = r.data?.breaks ?? [];
  const open = breaks.filter((b) => b.status === 'open');
  const latest = runs[0];
  const resolved7 = breaks.filter((b) => b.status === 'resolved' && b.resolved_at && Date.now() - new Date(b.resolved_at).getTime() < 7 * 86_400_000).length;
  return (
    <Card title="Reconciliation" actions={<a class="b b-ghost" href="#/reconciliation">Open</a>}>
      <div class="row-inline tight" style={{ gap: '1.2rem', flexWrap: 'wrap' }}>
        <div><div class="small muted">Open breaks</div><b style={{ fontSize: '1.4rem' }}>{open.length}</b> {open.length ? <Chip tone="no">Needs attention</Chip> : <Chip tone="ok">Register and chain agree</Chip>}</div>
        <div><div class="small muted">Last run</div><b>{latest ? when(latest.started_at) : 'Never'}</b>{latest ? <div class="small muted">{latest.trigger === 'manual' ? 'Manual' : 'Nightly'}, {fmt(latest.positions)} positions, {latest.breaks} break{latest.breaks === 1 ? '' : 's'}{latest.chain_block ? `, block ${fmt(latest.chain_block)}` : ''}</div> : <div class="small muted">Runs nightly when the operator key is set, or by hand.</div>}</div>
        <div><div class="small muted">Resolved in 7 days</div><b>{resolved7}</b></div>
      </div>
      {open.length ? <ul class="small" style={{ margin: '0.8rem 0 0', paddingLeft: '1.1rem' }}>{open.slice(0, 5).map((b) => <li>{b.investor ?? b.investor_id}, <code>{b.ticker}</code>: chain {fmt(b.chain_units)} against register {fmt(b.register_units)} ({signed(b.difference)})</li>)}{open.length > 5 ? <li class="muted">and {open.length - 5} more</li> : null}</ul> : null}
      <p class="small muted" style={{ marginTop: '0.8rem' }}>Every resolution needs a note, which is kept with the break and written to the audit log.</p>
    </Card>
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
      {d.enabled && d.operator.funded === false ? <div class="note">The operator wallet has no ETH on {d.network_label}, so new transactions cannot be paid for. Fund <code>{d.operator.address}</code> from a faucet.</div>
        : d.enabled && d.operator.low ? <div class="err" role="alert"><strong>Operator balance is low: {d.operator.balance_eth.toFixed(4)} ETH, under the {d.operator.low_threshold_eth} ETH alert level.</strong> Each settlement costs gas; top up <code>{d.operator.address}</code> on {d.network_label} before the queue stalls.</div> : null}
      <div class="kpis">
        <div class="kpi"><span>Network</span><b>{d.network_label}</b><em>Chain ID {d.chain_id}</em></div>
        <div class="kpi"><span>Operator balance</span><b>{d.operator.balance_eth === null ? 'Unknown' : `${d.operator.balance_eth.toFixed(4)} ETH`}{d.operator.low ? <Chip tone="warn">Low</Chip> : null}</b><em><Ext href={d.operator.url}>{shortHash(d.operator.address, 12)}</Ext></em></div>
        <div class="kpi"><span>Fund tokens</span><b>{d.funds.length}</b><em>{d.funds.map((f: any) => f.ticker).join(', ')}, 6 decimals</em></div>
        <div class="kpi"><span>Eligibility claim</span><b>Topic {d.claim_topic}</b><em>Signed by <code>{shortHash(d.claim_signer, 12)}</code></em></div>
      </div>
      <Card title="How the trusted claim issuer works">
        <p>Each investor gets an ONCHAINID identity, and Laissez signs its eligibility credential onto that identity as claim {d.claim_topic}.</p>
        <p>Every fund's identity registry trusts only the Laissez claim issuer, so units can never reach a wallet without a valid claim, even if someone bypasses the Laissez API.</p>
        <p>Revoking a credential revokes the claim on-chain, and the next transfer to that investor reverts while redemptions still go through. The claim also carries the credential's expiry date: once it passes, the ClaimExpiryModule on every fund compliance blocks units reaching that wallet until a renewed credential is put on chain.</p>
      </Card>
      {d.enabled ? <ReconSummary /> : null}
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
      <Card title="Chain job queue" actions={<a class="b b-ghost" href="#/chain/jobs">All jobs</a>} pad={false}><ChainJobs limit={12} filterable={false} /></Card>
      <p class="small muted">Test network only. tUSD and tEUR are test assets with no value. Deployed {when(d.deployed_at)}, blocks {fmt(d.blocks.start)} to {fmt(d.blocks.end)}.</p>
    </>
  );
}

export function Reconciliation() {
  const { isSandbox } = useMe();
  const r = useApi('/v1/reconciliation');
  const investors = useApi(isSandbox ? '/v1/investors?limit=200' : null);
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
      if (!(notes[id] ?? '').trim() || notes[id].trim().length < 3) { setErr(new Error('Write a short note on what you found before resolving the break.')); setBusy(null); return; }
      await api(`/v1/reconciliation/breaks/${id}/resolve`, { method: 'POST', body: { resolution, note: notes[id].trim() } });
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
      <Head title="Reconciliation" sub="Compares every onboarded investor's token balance on-chain with the Laissez register. Each difference opens a break and a work item. Runs nightly when the operator key is set. Resolving a break needs a note." actions={<PermBtn perm="compliance:write" kind="primary" onClick={run} busy={busy === 'run'} disabled={!r.data.enabled}>Run reconciliation</PermBtn>} />
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
                      <input class="sm" required placeholder="What you found (required)" aria-label={`Note for break ${b.id}`} value={notes[b.id] ?? ''} onInput={(e) => setNotes({ ...notes, [b.id]: (e.target as HTMLInputElement).value })} />
                      <PermBtn perm="compliance:write" disabled={(notes[b.id] ?? '').trim().length < 3} onClick={() => resolve(b.id, 'adjust_register')} busy={busy === b.id + 'adjust_register'}>Adjust register</PermBtn>
                      <PermBtn perm="compliance:write" kind="ghost" disabled={(notes[b.id] ?? '').trim().length < 3} onClick={() => resolve(b.id, 'investigated')} busy={busy === b.id + 'investigated'}>Mark investigated</PermBtn>
                    </div>
                  ) : (
                    <><Chip tone={b.resolution === 'adjust_register' ? 'info' : 'ok'}>{b.resolution === 'adjust_register' ? 'Register adjusted' : b.resolution === 'cleared' ? 'Cleared' : 'Investigated'}</Chip><div class="small">{b.note ? <q>{b.note}</q> : <span class="muted">No note</span>}</div><div class="small muted">{b.resolved_by}{b.resolved_at ? `, ${when(b.resolved_at)}` : ''}</div></>
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
