// Audit export: push the organization's audit log to its own SIEM or a write-once archive.
import { useState } from 'preact/hooks';
import { api, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, ConfirmBtn } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const KIND_LABEL: Record<string, string> = { splunk_hec: 'Splunk HTTP Event Collector', https: 'Signed HTTPS endpoint', s3_worm: 'S3 bucket with Object Lock' };

export function AuditExport() {
  const { isSandbox, can } = useMe();
  const r = useApi('/v1/audit-export/destinations');
  const d = useApi('/v1/audit-export/deliveries');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const rows = r.data?.data ?? [];
  const act = async (fn: () => Promise<any>, done: (x: any) => string) => { setErr(null); setNote(null); try { setNote(done(await fn())); r.reload(); d.reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <Head title="Audit export" sub={isSandbox ? 'Organizations push their audit log to Splunk, a signed HTTPS endpoint or a write-once S3 bucket. A sandbox can download the log as CSV from Audit.' : 'Every audit event, in order, delivered to your own systems within ten minutes. Hash chain and sequence numbers travel with each event, so your copy can be verified against ours.'} actions={!isSandbox && can('members:admin') ? <Btn kind="primary" onClick={() => setAdding(true)}>Add destination</Btn> : undefined} />
      {!isSandbox && !can('members:admin') ? <PermNote perm="members:admin" /> : null}
      {note ? <p class="ok-text" role="status">{note}</p> : null}
      <ErrorBox error={err} />
      {adding ? <AddDestination onDone={(x) => { setAdding(false); if (x) { setNote(`${x.name} added. Send a test event to see the shape arrive.`); r.reload(); } }} /> : null}
      <Card pad={false}>
        {r.loading && !r.data ? <div class="pad"><Loading /></div> : r.error ? <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div> : rows.length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Destination</th><th>Where</th><th>Delivered up to</th><th>Last run</th><th></th></tr></thead>
            <tbody>{rows.map((x: any) => (
              <tr>
                <td><strong>{x.name}</strong><div class="small muted">{KIND_LABEL[x.kind] ?? x.kind}</div></td>
                <td class="small"><code class="break">{x.config.url ?? `${x.config.bucket}/${x.config.prefix}`}</code>{x.kind === 's3_worm' ? <div class="muted">Locked {x.config.retention_days} days, {x.config.region}</div> : null}{x.config.index ? <div class="muted">index {x.config.index}</div> : null}</td>
                <td>seq {x.last_seq} of {r.data?.latest_seq}{x.last_seq < (r.data?.latest_seq ?? 0) ? <div class="small muted">{(r.data?.latest_seq ?? 0) - x.last_seq} waiting</div> : null}</td>
                <td>{x.last_error ? <Chip tone="no" title={x.last_error}>Failed</Chip> : x.last_ok_at ? <Chip tone="ok">OK</Chip> : <Chip>Not yet</Chip>}<div class="small muted">{x.last_run_at ? when(x.last_run_at) : ''}{x.last_error ? <div class="break">{x.last_error}</div> : null}</div></td>
                <td class="nowrap">
                  <Btn kind="ghost" onClick={() => act(() => api(`/v1/audit-export/destinations/${x.id}/test`, { body: {} }), (j) => j.ok ? 'Test event accepted.' : `Test failed: ${j.detail}`)}>Test</Btn>
                  <Btn kind="ghost" onClick={() => act(() => api(`/v1/audit-export/destinations/${x.id}/run`, { body: {} }), (j) => j.error ? `Stopped after ${j.sent} events: ${j.error}` : `${j.sent} event${j.sent === 1 ? '' : 's'} sent.`)}>Push now</Btn>
                  <Btn kind="ghost" onClick={() => act(() => api(`/v1/audit-export/destinations/${x.id}`, { method: 'PATCH', body: { enabled: !x.enabled } }), (j) => j.enabled ? 'Enabled.' : 'Paused.')}>{x.enabled ? 'Pause' : 'Resume'}</Btn>
                  {can('members:admin') ? <ConfirmBtn kind="ghost" confirm="Remove this destination? Delivered events stay where they are." onConfirm={() => act(() => api(`/v1/audit-export/destinations/${x.id}`, { method: 'DELETE' }), () => 'Destination removed.')}>Remove</ConfirmBtn> : null}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div class="pad"><Empty title="No destinations yet">{isSandbox ? 'Keep this sandbox as an organization to add one.' : 'Add Splunk, a signed HTTPS endpoint or an S3 bucket with Object Lock. Each one receives every audit event from the moment it is added.'}</Empty></div>}
      </Card>
      <Card title="Recent deliveries" pad={false}>
        {d.loading && !d.data ? <div class="pad"><Loading /></div> : (d.data?.data ?? []).length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>When</th><th>Destination</th><th>Events</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>{(d.data?.data ?? []).map((x: any) => (
              <tr><td class="muted nowrap">{when(x.sent_at)}</td><td>{x.destination}</td><td>{x.events}{x.to_seq ? <span class="muted"> (seq {x.from_seq} to {x.to_seq})</span> : <span class="muted"> (test)</span>}</td><td><Chip tone={x.status === 'sent' ? 'ok' : 'no'}>{x.status === 'sent' ? 'Sent' : 'Failed'}</Chip></td><td class="small muted break">{x.object_key ? <code>{x.object_key}</code> : x.detail}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <div class="pad"><Empty title="Nothing delivered yet">Deliveries appear here as batches go out.</Empty></div>}
      </Card>
      <Card title="How to verify your copy">
        <p class="muted">Each event carries <code>seq</code>, <code>hash</code> and <code>prev_hash</code>. Sorted by <code>seq</code>, every <code>prev_hash</code> must equal the <code>hash</code> before it, and <code>GET /v1/audit-events/verify</code> recomputes the same chain on our side. An S3 object cannot be changed or deleted before its retention date, by either party. The daily Merkle anchor on the Base Sepolia testnet adds a third, public reference once the chain deployment is live.</p>
      </Card>
    </>
  );
}

function AddDestination({ onDone }: { onDone: (x?: any) => void }) {
  const [kind, setKind] = useState<'splunk_hec' | 'https' | 's3_worm'>('splunk_hec');
  const [f, setF] = useState<Record<string, string>>({ name: '', url: '', token: '', index: '', sourcetype: 'laissez:audit', secret: '', endpoint: '', region: '', bucket: '', prefix: 'laissez-audit', access_key_id: '', secret_access_key: '', retention_days: '2555' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = kind === 'splunk_hec' ? { kind, name: f.name, url: f.url, token: f.token, index: f.index || undefined, sourcetype: f.sourcetype || 'laissez:audit' }
        : kind === 'https' ? { kind, name: f.name, url: f.url, secret: f.secret }
        : { kind, name: f.name, endpoint: f.endpoint, region: f.region, bucket: f.bucket, prefix: f.prefix, access_key_id: f.access_key_id, secret_access_key: f.secret_access_key, retention_days: Number(f.retention_days) };
      onDone(await api('/v1/audit-export/destinations', { body }));
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Add a destination">
      <form class="form-grid" onSubmit={submit}>
        <Field label="Kind"><select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as any)}><option value="splunk_hec">Splunk HTTP Event Collector</option><option value="https">Signed HTTPS endpoint</option><option value="s3_worm">S3 bucket with Object Lock</option></select></Field>
        <Field label="Name"><input required value={f.name} onInput={set('name')} placeholder="Production Splunk" /></Field>
        {kind === 'splunk_hec' ? <>
          <Field label="HEC URL" hint="Usually https://your-host:8088/services/collector/event"><input required type="url" value={f.url} onInput={set('url')} /></Field>
          <Field label="HEC token"><input required type="password" value={f.token} onInput={set('token')} autocomplete="off" /></Field>
          <Field label="Index (optional)"><input value={f.index} onInput={set('index')} /></Field>
          <Field label="Sourcetype"><input value={f.sourcetype} onInput={set('sourcetype')} /></Field>
        </> : kind === 'https' ? <>
          <Field label="Endpoint URL"><input required type="url" value={f.url} onInput={set('url')} placeholder="https://logs.example.com/laissez" /></Field>
          <Field label="Signing secret" hint="At least 16 characters. Each batch carries Laissez-Signature: t=<unix>,v1=<HMAC-SHA256 of t.body>."><input required type="password" minLength={16} value={f.secret} onInput={set('secret')} autocomplete="off" /></Field>
        </> : <>
          <Field label="Endpoint" hint="https://s3.eu-west-1.amazonaws.com, or your S3-compatible store. Path-style addressing."><input required type="url" value={f.endpoint} onInput={set('endpoint')} /></Field>
          <Field label="Region"><input required value={f.region} onInput={set('region')} placeholder="eu-west-1" /></Field>
          <Field label="Bucket" hint="Object Lock must be enabled on the bucket when it is created."><input required value={f.bucket} onInput={set('bucket')} /></Field>
          <Field label="Key prefix"><input value={f.prefix} onInput={set('prefix')} /></Field>
          <Field label="Access key id"><input required value={f.access_key_id} onInput={set('access_key_id')} autocomplete="off" /></Field>
          <Field label="Secret access key"><input required type="password" value={f.secret_access_key} onInput={set('secret_access_key')} autocomplete="off" /></Field>
          <Field label="Retention, days" hint="Objects are written in COMPLIANCE mode and cannot be deleted before this many days. 2555 is seven years."><input required type="number" min={1} max={3650} value={f.retention_days} onInput={set('retention_days')} /></Field>
        </>}
        <div class="form-actions"><PermBtn perm="members:admin" type="submit" kind="primary" busy={busy}>Add destination</PermBtn><Btn kind="ghost" onClick={() => onDone()}>Cancel</Btn></div>
      </form>
      <ErrorBox error={err} />
      <p class="small muted">Secrets are sealed at rest and never shown again. Adding a destination asks for your passkey.</p>
    </Card>
  );
}
