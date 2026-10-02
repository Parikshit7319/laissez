/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { api, money, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Card, Copy, Json, Hash } from '../ui';

const STATUS: Record<string, [tone: 'ok' | 'no' | 'warn' | 'info' | 'muted', label: string]> = {
  sending: ['info', 'Sending'], awaiting_resolution: ['info', 'Waiting for beneficiary'], approved: ['ok', 'Approved'],
  confirmed: ['ok', 'Confirmed'], rejected: ['no', 'Rejected'], failed: ['no', 'Failed'], canceled: ['muted', 'Canceled'],
};
const statusChip = (s: string) => { const [tone, label] = STATUS[s] ?? ['muted', s]; return <Chip tone={tone}>{label}</Chip>; };
const dirChip = (d: string) => d === 'outbound' ? <Chip tone="brass">Sent</Chip> : <Chip>Received</Chip>;
const amountOf = (m: any) => m.notional && m.currency ? `${money(Number(m.notional), m.currency)}${m.ticker ? ` of ${m.ticker}` : ''}` : m.amount !== null && m.amount !== undefined ? `${Number(m.amount).toLocaleString('en-US')} units` : 'Not stated';

export function TravelRule({ id }: { id?: string }) {
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState<string | null>(id ?? null);
  const list = useApi(`/v1/travel-rule/messages${status ? `?status=${status}` : ''}`, [status]);
  const rows: any[] = list.data?.data ?? [];
  return (
    <>
      <Head title="Travel Rule" sub={<>Transfers of USD or EUR 1,000 and above exchange originator and beneficiary data before settlement (FATF Recommendation 16). Laissez speaks the OpenVASP Travel Rule Protocol{list.data ? ` ${list.data.protocol.version}` : ''}, with IVMS101 payloads. Each booking center acts as its own VASP.</>} />
      <div class="tabs" role="tablist">
        {[['', 'All'], ['awaiting_resolution', 'Waiting'], ['approved', 'Approved'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected'], ['failed', 'Failed']].map(([v, l]) => (
          <button type="button" role="tab" aria-selected={status === v} class={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{l}</button>
        ))}
      </div>
      <Card pad={false}>
        {list.loading && !list.data ? <div class="pad"><Loading /></div> : list.error ? <div class="pad"><ErrorBox error={list.error} onRetry={list.reload} /></div> : !rows.length ? (
          <div style={{ padding: '1rem 1.35rem' }}><Empty title="No Travel Rule messages yet">Place a transfer of 1,000 or more between two clients. Laissez sends the inquiry as soon as the decision allows it.</Empty></div>
        ) : (
          <div class="tw"><table class="t">
            <thead><tr><th>Direction</th><th>Status</th><th>Originator</th><th>Beneficiary</th><th>Amount</th><th>Travel Address</th><th>Updated</th></tr></thead>
            <tbody>{rows.map((m) => (
              <tr class="click" aria-selected={sel === m.id} onClick={() => setSel(m.id)} style={sel === m.id ? { background: 'rgba(201, 169, 110, 0.1)' } : undefined}>
                <td>{dirChip(m.direction)}</td>
                <td>{statusChip(m.status)}</td>
                <td>{m.originator ?? 'Unnamed'}<div class="small muted">{m.originator_vasp}</div></td>
                <td>{m.beneficiary ?? 'Unnamed'}<div class="small muted">{m.beneficiary_vasp}</div></td>
                <td class="nowrap">{amountOf(m)}</td>
                <td><Hash value={m.travel_address} n={14} /></td>
                <td class="nowrap small">{when(m.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {sel ? <MessageDetail id={sel} onSelect={setSel} onChange={list.reload} /> : rows.length ? <p class="small muted">Select a message to see its IVMS101 payload, Travel Address and timeline.</p> : null}
    </>
  );
}

function MessageDetail({ id, onSelect, onChange }: { id: string; onSelect: (id: string) => void; onChange: () => void }) {
  const r = useApi(`/v1/travel-rule/messages/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [txid, setTxid] = useState('');
  const [tab, setTab] = useState<'ivms' | 'inquiry' | 'response'>('ivms');
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const m = r.data;
  const retry = async () => {
    setBusy(true); setErr(null);
    try { await api(`/v1/travel-rule/messages/${m.id}/retry`, { body: {} }); r.reload(); onChange(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const confirm = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api(`/v1/travel-rule/messages/${m.id}/confirm`, { body: { txid } }); setTxid(''); r.reload(); onChange(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const timeline: any[] = m.timeline ?? [];
  return (
    <div class="grid2" style={{ alignItems: 'start' }}>
      <Card title={<>Message <code>{m.id}</code></>} actions={<div class="row-inline tight">{dirChip(m.direction)}{statusChip(m.status)}</div>}>
        <dl class="kv small">
          <div><dt>Originator</dt><dd>{m.originator ?? 'Unnamed'}<div class="muted">{m.originator_vasp}</div></dd></div>
          <div><dt>Beneficiary</dt><dd>{m.beneficiary ?? 'Unnamed'}<div class="muted">{m.beneficiary_vasp}</div></dd></div>
          <div><dt>Amount</dt><dd>{amountOf(m)}{m.amount !== null && m.notional ? <span class="muted"> ({Number(m.amount).toLocaleString('en-US')} units)</span> : null}</dd></div>
          {m.decision_id ? <div><dt>Decision</dt><dd><a href={`#/decisions/${m.decision_id}`}><code>{m.decision_id}</code></a></dd></div> : null}
          <div><dt>Request id</dt><dd><code class="break">{m.request_identifier}</code></dd></div>
          {m.beneficiary_address ? <div><dt>Pay to</dt><dd><code class="break">{m.beneficiary_address}</code></dd></div> : null}
          {m.txid ? <div><dt>Transaction</dt><dd><code class="break">{m.txid}</code></dd></div> : null}
        </dl>
        <div class="reveal" style={{ marginTop: '1rem' }}>
          <span class="f-l">Beneficiary Travel Address</span>
          <div class="reveal-row"><code class="break">{m.travel_address}</code><Copy text={m.travel_address} /></div>
          {m.travel_address_decoded ? <p class="small muted">Decodes to <code class="break">{m.travel_address_decoded}</code>. Base58Check of the endpoint without its scheme, prefixed "ta".</p> : null}
        </div>
        <div class="small" style={{ marginTop: '0.8rem' }}>
          <span class="f-l">TRP headers</span>
          <ul class="plain" style={{ marginTop: '0.3rem', gap: '0.2rem' }}>{Object.entries(m.headers ?? {}).map(([k, v]) => <li><code>{k}: {String(v)}</code></li>)}</ul>
        </div>
        {m.related?.length ? (
          <div class="small" style={{ marginTop: '0.8rem' }}>
            <span class="f-l">Other side of this exchange</span>
            <ul class="plain" style={{ marginTop: '0.3rem' }}>{m.related.map((x: any) => <li><button type="button" class="link" style={{ color: '#6d5222' }} onClick={() => onSelect(x.id)}>{x.id}</button> {x.direction === 'outbound' ? 'sent' : 'received'}, {STATUS[x.status]?.[1]?.toLowerCase() ?? x.status}</li>)}</ul>
          </div>
        ) : null}
        <div class="row-inline" style={{ marginTop: '1rem' }}>
          {m.retryable ? <Btn onClick={retry} busy={busy}>Retry with a new request id</Btn> : null}
        </div>
        {m.direction === 'outbound' && m.status === 'approved' ? (
          <form class="row-inline" onSubmit={confirm}>
            <input class="grow mono" required minLength={4} maxLength={120} value={txid} onInput={(e) => setTxid((e.target as HTMLInputElement).value)} placeholder="0x… transaction id" aria-label="Transaction id to confirm" />
            <Btn type="submit" busy={busy}>Send transfer confirmation</Btn>
          </form>
        ) : null}
        <ErrorBox error={err} />
      </Card>
      <div>
        <Card title="Timeline">
          {timeline.length ? (
            <div class="tl"><ul>{timeline.map((t) => {
              const bad = /fail|reject|did not match|cancel/i.test(t.event);
              return (
                <li class={bad ? 'r-fail' : 'r-pass'}>
                  <i aria-hidden="true">{bad ? '×' : '✓'}</i>
                  <div><span class="tl-l">{t.event}<em>{when(t.at)}</em></span>{t.detail ? <p>{t.detail}</p> : null}</div>
                </li>
              );
            })}</ul></div>
          ) : <Empty title="No events recorded" />}
        </Card>
        <Card title="Payload" actions={<div class="seg-c" style={{ margin: 0 }}>{([['ivms', 'IVMS101'], ['inquiry', 'Inquiry'], ['response', 'Resolution']] as const).map(([k, l]) => <button type="button" class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>}>
          <Json value={tab === 'ivms' ? m.ivms101 : tab === 'inquiry' ? m.payload : m.response ?? { note: 'No resolution yet.' }} />
        </Card>
      </div>
    </div>
  );
}
