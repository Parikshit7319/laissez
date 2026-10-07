// The chain deployment on the status page: network, every contract address with an explorer link, fund tokens.
// Reads GET /v1/chain/public; says plainly when nothing is deployed yet.
import { type ChainPublic } from './api';
import { useLive } from './store';
import { fmtDateTime } from './format';

export default function ChainDeployment() {
  const live = useLive<ChainPublic>('chain');
  const d = live.data;
  if (live.error && !d) return <p class="muted">The deployment record could not be read right now ({live.error.message}).</p>;
  if (!d) return <p class="muted">Reading the deployment record.</p>;
  if (!d.deployed) {
    return (
      <div class="chain-dep">
        <p class="muted">{d.message} Until it runs, settlements complete on the simulated register and say so in every receipt. The contracts and the deployment script are in the repository; the local chain test runs 22 steps against them.</p>
      </div>
    );
  }
  return (
    <div class="chain-dep">
      <p class="muted">{d.network_label ?? d.network} (chain {d.chain_id}){d.deployed_at ? `, deployed ${fmtDateTime(d.deployed_at)}` : ''}. {d.enabled ? 'On-chain settlement is switched on.' : 'Contracts are deployed; settlement stays simulated until the operator key is set.'} Operator {d.operator?.url ? <a href={d.operator.url} rel="noopener">{d.operator.address}</a> : d.operator?.address}.</p>
      <div class="table-wrap"><table class="grid">
        <thead><tr><th>Contract</th><th>Address</th><th>Role</th></tr></thead>
        <tbody>{(d.contracts ?? []).map((c) => <tr key={c.key}><td>{c.name}</td><td class="mono">{c.url ? <a href={c.url} rel="noopener">{c.address}</a> : c.address}</td><td class="muted">{c.role}</td></tr>)}</tbody>
      </table></div>
      <div class="table-wrap"><table class="grid">
        <thead><tr><th>Fund token</th><th>Address</th><th>Countries allowed</th></tr></thead>
        <tbody>{(d.funds ?? []).map((f) => <tr key={f.ticker}><td>{f.ticker} <span class="muted">{f.name}</span></td><td class="mono">{f.token_url ? <a href={f.token_url} rel="noopener">{f.token}</a> : f.token}</td><td class="muted">{f.countries.join(', ')}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}
