/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { api, API_BASE, getKey, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, Json, Copy } from '../ui';

const EVENTS = ['decision.created', 'settlement.completed', 'settlement.reverted', 'credential.issued', 'holder.status_changed', 'policy.published', 'ping', '*'];
const PRESETS: { label: string; method: string; path: string; body?: unknown }[] = [
  { label: 'Pre-trade decision', method: 'POST', path: '/v1/decisions', body: { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 2000000, settle_with: 'USDC', persist: false } },
  { label: 'Transfer decision', method: 'POST', path: '/v1/decisions', body: { action: 'transfer', investor_id: 'lumen', counterparty_id: 'qamar', fund: 'TWLF', amount: 500000, settle_with: 'USDC', persist: false } },
  { label: 'List clients', method: 'GET', path: '/v1/investors' },
  { label: 'Fund policy', method: 'GET', path: '/v1/funds/TWLF' },
  { label: 'Policy preview', method: 'POST', path: '/v1/funds/TWLF/policy/preview', body: { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'HK', accepts: ['HK_PI'] }] } },
  { label: 'Rule packs', method: 'GET', path: '/v1/rule-packs' },
  { label: 'Metrics', method: 'GET', path: '/v1/metrics' },
];

export function Explorer() {
  const [p, setP] = useState(0);
  const [method, setMethod] = useState(PRESETS[0].method);
  const [path, setPath] = useState(PRESETS[0].path);
  const [bodyText, setBody] = useState(JSON.stringify(PRESETS[0].body, null, 2));
  const [res, setRes] = useState<any>(null);
  const [ms, setMs] = useState<number | null>(null);
  const pick = (i: number) => { const x = PRESETS[i]; setP(i); setMethod(x.method); setPath(x.path); setBody(x.body ? JSON.stringify(x.body, null, 2) : ''); setRes(null); };
  const send = async () => {
    const t = performance.now();
    try {
      const r = await fetch(API_BASE + path, { method, headers: { authorization: `Bearer ${getKey()}`, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? bodyText || '{}' : undefined });
      setRes({ status: r.status, body: await r.json().catch(() => null) });
    } catch { setRes({ status: 0, body: { error: 'Network error' } }); }
    setMs(Math.round(performance.now() - t));
  };
  const curl = `curl -X ${method} ${API_BASE}${path} \\\n  -H "Authorization: Bearer $LAISSEZ_KEY"${method !== 'GET' ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${(bodyText || '{}').replace(/\s+/g, ' ')}'` : ''}`;
  return (
    <>
      <Head title="API explorer" sub="Send real requests to the Laissez API with this sandbox's key." />
      <div class="tabs">{PRESETS.map((x, i) => <button class={p === i ? 'on' : ''} onClick={() => pick(i)}>{x.label}</button>)}</div>
      <div class="grid2">
        <Card title="Request">
          <div class="row-inline"><select value={method} onChange={(e) => setMethod((e.target as HTMLSelectElement).value)} aria-label="Method"><option>GET</option><option>POST</option><option>DELETE</option></select><input class="grow mono" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} aria-label="Path" /><Btn kind="primary" onClick={send}>Send</Btn></div>
          {method !== 'GET' ? <textarea class="mono" rows={12} value={bodyText} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} aria-label="Request body" /> : null}
          <div class="card-h"><h2>curl</h2><Copy text={curl} /></div>
          <pre class="json"><code>{curl}</code></pre>
        </Card>
        <Card title="Response" actions={res ? <span class="row-inline tight"><Chip tone={res.status < 300 ? 'ok' : 'no'}>{res.status}</Chip>{ms !== null ? <span class="muted small">{ms} ms</span> : null}</span> : null}>
          {res ? <Json value={res.body} /> : <Empty title="No request sent yet">Pick a preset and press Send.</Empty>}
        </Card>
      </div>
    </>
  );
}

export function Webhooks() {
  const hooks = useApi('/v1/webhooks');
  const del = useApi('/v1/webhook-deliveries');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['decision.created', 'settlement.completed']);
  const [created, setCreated] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const add = async (e: Event) => { e.preventDefault(); setErr(null); try { setCreated(await api('/v1/webhooks', { body: { url, events } })); setUrl(''); hooks.reload(); } catch (x) { setErr(x); } };
  const remove = async (id: string) => { await api(`/v1/webhooks/${id}`, { method: 'DELETE' }).catch(setErr); hooks.reload(); };
  const test = async (id: string) => { await api(`/v1/webhooks/${id}/test`, { body: {} }).catch(setErr); setTimeout(del.reload, 2500); };
  return (
    <>
      <Head title="Webhooks" sub="Signed event notifications. Each request carries a Laissez-Signature header: an HMAC-SHA256 of the timestamp and body." />
      <Card title="Add an endpoint">
        <form class="form-grid" onSubmit={add}>
          <div class="span2"><Field label="HTTPS URL" hint="Try a request-bin service to watch events arrive."><input type="url" required value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="https://example.com/laissez/webhooks" /></Field></div>
          <div class="span2"><span class="f-l">Events</span><div class="pick">{EVENTS.map((ev) => <label class={`pick-i ${events.includes(ev) ? 'on' : ''}`}><input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(events.includes(ev) ? events.filter((x) => x !== ev) : [...events, ev])} /><span><code>{ev}</code></span></label>)}</div></div>
          <div class="form-actions"><Btn type="submit" kind="primary" disabled={!events.length}>Add endpoint</Btn></div>
        </form>
        {created ? <div class="note">Signing secret for {created.url}: <code>{created.secret}</code> <Copy text={created.secret} /> It is shown once.</div> : null}
        <ErrorBox error={err} />
      </Card>
      <Card title="Endpoints" pad={false}>
        {hooks.data?.data?.length ? <div class="tw"><table class="t"><thead><tr><th>URL</th><th>Events</th><th /></tr></thead><tbody>{hooks.data.data.map((h: any) => <tr><td class="mono small">{h.url}</td><td class="small">{h.events.join(', ')}</td><td><div class="row-inline tight"><Btn kind="ghost" onClick={() => test(h.id)}>Send test</Btn><Btn kind="danger" onClick={() => remove(h.id)}>Delete</Btn></div></td></tr>)}</tbody></table></div> : <Empty title="No endpoints yet" />}
      </Card>
      <Card title="Recent deliveries" actions={<Btn kind="ghost" onClick={del.reload}>Refresh</Btn>} pad={false}>
        {del.data?.data?.length ? <div class="tw"><table class="t"><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th><th>Time</th></tr></thead><tbody>{del.data.data.map((d: any) => <tr><td class="muted">{when(d.created_at)}</td><td><code>{d.event}</code></td><td>{d.status >= 200 && d.status < 300 ? <Chip tone="ok">{d.status}</Chip> : <Chip tone="no">{d.status || 'No response'}</Chip>}</td><td>{d.attempts}</td><td>{d.response_ms} ms</td></tr>)}</tbody></table></div> : <Empty title="No deliveries yet" />}
      </Card>
    </>
  );
}

export function Keys() {
  const r = useApi('/v1/api-keys');
  const w = useApi('/v1/workspace');
  const [fresh, setFresh] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const create = async () => { try { setFresh(await api('/v1/api-keys', { body: {} })); r.reload(); } catch (e) { setErr(e); } };
  const revoke = async (id: string) => { try { await api(`/v1/api-keys/${id}`, { method: 'DELETE' }); r.reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <Head title="Sandbox and keys" sub="Test keys start with lz_test_. Laissez stores only a hash; a key is shown once." actions={<Btn kind="primary" onClick={create}>Create key</Btn>} />
      {w.data ? <Card title={w.data.name}><dl class="kv"><div><dt>Sandbox id</dt><dd><code>{w.data.id}</code></dd></div><div><dt>Expires</dt><dd>{when(w.data.expires_at)}</dd></div><div><dt>Contents</dt><dd>{w.data.counts.investors} clients, {w.data.counts.funds} funds, {w.data.counts.decisions} decisions, {w.data.counts.settlements} settlements</dd></div></dl></Card> : null}
      {fresh ? <div class="note">New key: <code>{fresh.api_key}</code> <Copy text={fresh.api_key} /> Store it now.</div> : null}
      <ErrorBox error={err} />
      <Card title="Keys" pad={false}>
        {r.loading && !r.data ? <Loading /> : <div class="tw"><table class="t"><thead><tr><th>Prefix</th><th>Created</th><th>Last used</th><th /></tr></thead><tbody>{(r.data?.data ?? []).map((k: any) => <tr><td><code>{k.prefix}…</code></td><td class="muted">{when(k.created_at)}</td><td class="muted">{k.last_used_at ? when(k.last_used_at) : 'Never'}</td><td><Btn kind="ghost" onClick={() => revoke(k.id)}>Revoke</Btn></td></tr>)}</tbody></table></div>}
      </Card>
    </>
  );
}
