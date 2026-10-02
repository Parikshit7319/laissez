/** @jsxImportSource preact */
// Audit anchors for this organization: each day's Merkle leaf (head hash and proof), the on-chain transaction,
// and a Verify button that recomputes the chain head from the raw audit events and checks the proof.
import { useState } from 'preact/hooks';
import { api, when } from '../api';
import { useApi, Btn, Chip, Card, Empty, Loading, ErrorBox, Head, Hash, TxLink } from '../ui';

const anchorChip = (s: string) => s === 'confirmed' ? <Chip tone="ok">On-chain</Chip> : s === 'pending' ? <Chip tone="warn">Pending</Chip> : s === 'conflict' ? <Chip tone="no">Conflict</Chip> : s === 'failed' ? <Chip tone="no">Failed</Chip> : <Chip>{s}</Chip>;
const dayOf = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function AnchorRow({ a }: { a: any }) {
  const [v, setV] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const verify = async () => {
    setBusy(true); setErr(null);
    try { setV(await api(`/v1/audit-anchors/${a.anchor_id}/verify`)); setOpen(true); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <>
      <tr>
        <td class="nowrap">{dayOf(a.anchor_date)}</td>
        <td>{anchorChip(a.status)}</td>
        <td class="r">{Number(a.seq).toLocaleString('en-US')}</td>
        <td><Hash value={a.head_hash} n={14} /></td>
        <td><Hash value={a.merkle_root} n={14} /><div class="small muted">{a.leaves} organization{a.leaves === 1 ? '' : 's'} in the tree</div></td>
        <td>{a.tx_hash ? <><TxLink hash={a.tx_hash} />{a.block ? <div class="small muted">block {Number(a.block).toLocaleString('en-US')}</div> : null}</> : <span class="small muted">Not written yet</span>}</td>
        <td>{a.proof_valid ? <Chip tone="ok">Proof ok</Chip> : <Chip tone="no">Proof invalid</Chip>}</td>
        <td class="nowrap">
          <Btn kind={v ? 'ghost' : 'default'} busy={busy} onClick={verify}>{v ? 'Verify again' : 'Verify'}</Btn>
          {v ? <Btn kind="ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Btn> : null}
        </td>
      </tr>
      {err ? <tr><td colSpan={8}><ErrorBox error={err} /></td></tr> : null}
      {v && open ? (
        <tr><td colSpan={8} style={{ background: '#faf8f4' }}>
          <div class="verify-grid">
            <div class={`verify-stamp ${v.valid ? 'ok' : 'bad'}`}>
              <b>{v.valid ? 'Verified' : 'Failed'}</b>
              <span>{v.message}</span>
            </div>
            <dl class="kv wide">
              <div><dt>Events recomputed</dt><dd>1 to {v.seq.toLocaleString('en-US')}{v.events_in_log !== v.seq ? <span class="muted small"> ({v.events_in_log.toLocaleString('en-US')} present in the log)</span> : null}</dd></div>
              <div><dt>Recomputed head</dt><dd><Hash value={v.recomputed_head} n={20} /> {v.head_matches ? <Chip tone="ok">Matches the anchored head</Chip> : <Chip tone="no">Does not match</Chip>}</dd></div>
              <div><dt>Anchored head</dt><dd><Hash value={v.head_hash} n={20} /></dd></div>
              <div><dt>Leaf</dt><dd><Hash value={v.leaf} n={20} /> {v.leaf_matches ? <Chip tone="ok">Derives from the head</Chip> : <Chip tone="no">Wrong leaf</Chip>}</dd></div>
              <div><dt>Proof</dt><dd>{v.proof.length} sibling hash{v.proof.length === 1 ? '' : 'es'} {v.proof_valid ? <Chip tone="ok">Leads to the root</Chip> : <Chip tone="no">Does not lead to the root</Chip>}
                {v.proof.length ? <ul class="plain small" style={{ marginTop: '0.3rem' }}>{v.proof.map((p: string) => <li><Hash value={p} n={24} /></li>)}</ul> : null}</dd></div>
              <div><dt>Root</dt><dd><Hash value={v.merkle_root} n={20} />{v.tx_hash ? <div><TxLink hash={v.tx_hash} />{v.block ? <span class="small muted"> block {Number(v.block).toLocaleString('en-US')}</span> : null}</div> : <div class="small muted">{v.status === 'pending' ? 'Waiting to be written on-chain.' : 'Not on-chain.'}</div>}</dd></div>
              <div><dt>Checked</dt><dd class="small muted">{when(v.checked_at)}</dd></div>
            </dl>
          </div>
        </td></tr>
      ) : null}
    </>
  );
}

export function Anchors() {
  const r = useApi('/v1/audit-anchors');
  const rows: any[] = r.data?.data ?? [];
  return (
    <>
      <Head title="Audit anchors" sub="Once a day Laissez takes the head hash of every organization's audit log, builds a Merkle tree over them and writes the root on-chain. Your leaf and its proof are here. Verify recomputes your chain head from the raw events up to the anchored sequence number and checks the proof against the root, so a change anywhere before the anchor shows up."
        actions={<a class="b b-ghost" href="#/audit">Audit log</a>} />
      {r.data ? (
        <div class="note">
          Contract {r.data.contract ? <a href={r.data.contract_url} target="_blank" rel="noopener"><code>{r.data.contract}</code></a> : <span>not deployed</span>}{r.data.network ? ` on ${r.data.network}` : ''}. {r.data.how_to_verify}
        </div>
      ) : null}
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? (
        <Card><Empty title="No anchors yet">The anchoring job runs nightly after the sweep. Your first leaf appears here after it.</Empty></Card>
      ) : (
        <Card pad={false}>
          <div class="tw"><table class="t">
            <thead><tr><th>Day</th><th>Status</th><th class="r">Head seq</th><th>Head hash</th><th>Merkle root</th><th>Transaction</th><th>Proof</th><th></th></tr></thead>
            <tbody>{rows.map((a) => <AnchorRow key={a.anchor_id} a={a} />)}</tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}
