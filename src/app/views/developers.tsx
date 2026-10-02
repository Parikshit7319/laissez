/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { api, API_BASE, API_VERSION, getKey, getSession, keyWorkspace, uuid, track, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Empty, Field, Card, Json, Copy, Reveal, ConfirmBtn } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

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
  const { me } = useMe();
  const key = getKey();
  const keyFits = !!key && (!keyWorkspace() || keyWorkspace() === me?.workspace.id);
  const [p, setP] = useState(0);
  const [method, setMethod] = useState(PRESETS[0].method);
  const [path, setPath] = useState(PRESETS[0].path);
  const [bodyText, setBody] = useState(JSON.stringify(PRESETS[0].body, null, 2));
  const [version, setVersion] = useState(API_VERSION);
  const [idem, setIdem] = useState(uuid());
  const [as, setAs] = useState<'key' | 'session'>(keyFits ? 'key' : 'session');
  const [res, setRes] = useState<any>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const mutating = method !== 'GET';
  const pick = (i: number) => { const x = PRESETS[i]; setP(i); setMethod(x.method); setPath(x.path); setBody(x.body ? JSON.stringify(x.body, null, 2) : ''); setRes(null); setIdem(uuid()); };
  const token = as === 'key' && keyFits ? key : getSession();
  const send = async () => {
    setBusy(true);
    const t = performance.now();
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${token ?? ''}` };
      if (version.trim()) headers['Laissez-Version'] = version.trim();
      if (mutating) { headers['content-type'] = 'application/json'; if (idem.trim()) headers['Idempotency-Key'] = idem.trim(); }
      const r = await fetch(API_BASE + path, { method, headers, body: mutating ? bodyText || '{}' : undefined });
      const text = await r.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      const pickH = (h: string) => r.headers.get(h);
      setRes({ status: r.status, body, headers: { 'Idempotent-Replayed': pickH('Idempotent-Replayed'), 'Laissez-Version': pickH('Laissez-Version'), 'Request-Id': pickH('Request-Id') ?? pickH('X-Request-Id'), 'RateLimit-Remaining': pickH('RateLimit-Remaining') ?? pickH('X-RateLimit-Remaining') } });
      track('api_request_sent', { method, path: path.replace(/\/(dec|stl|pc|inv|wh)_[A-Za-z0-9]+/g, '/:id'), status: r.status, auth: as });
    } catch { setRes({ status: 0, body: { error: { message: 'Could not reach the Laissez API. Check your connection and try again.' } }, headers: {} }); }
    setMs(Math.round(performance.now() - t));
    setBusy(false);
  };
  const tokenVar = as === 'key' ? '$LAISSEZ_KEY' : '$LAISSEZ_SESSION';
  const curl = [`curl -X ${method} ${API_BASE}${path}`, `  -H "Authorization: Bearer ${tokenVar}"`, version.trim() ? `  -H "Laissez-Version: ${version.trim()}"` : null,
    mutating && idem.trim() ? `  -H "Idempotency-Key: ${idem.trim()}"` : null, mutating ? '  -H "Content-Type: application/json"' : null, mutating ? `  -d '${(bodyText || '{}').replace(/\s+/g, ' ')}'` : null].filter(Boolean).join(' \\\n');
  const replayed = res?.headers?.['Idempotent-Replayed'];
  return (
    <>
      <Head title="API explorer" sub={keyFits ? "Send real requests to the Laissez API with this sandbox's key or your session." : 'Send real requests to the Laissez API with your session.'} />
      <div class="tabs">{PRESETS.map((x, i) => <button class={p === i ? 'on' : ''} aria-pressed={p === i} onClick={() => pick(i)}>{x.label}</button>)}</div>
      <div class="grid2">
        <Card title="Request">
          <div class="row-inline xp-line">
            <select value={method} onChange={(e) => { setMethod((e.target as HTMLSelectElement).value); setIdem(uuid()); }} aria-label="Method">{['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => <option>{m}</option>)}</select>
            <input class="grow mono" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} aria-label="Path" />
            <Btn kind="primary" busy={busy} onClick={send}>Send request</Btn>
          </div>
          <div class="form-grid xp-h">
            <Field label="Authenticate with">
              <select value={as} onChange={(e) => setAs((e.target as HTMLSelectElement).value as 'key' | 'session')}>
                {keyFits ? <option value="key">Sandbox key ({key!.slice(0, 12)}…)</option> : null}
                <option value="session">Your session</option>
              </select>
            </Field>
            <Field label="Laissez-Version" hint="Pins response shapes. Leave empty for the latest."><input class="mono" value={version} onInput={(e) => setVersion((e.target as HTMLInputElement).value)} /></Field>
            {mutating ? (
              <div class="span2"><Field label="Idempotency-Key" hint="Send twice with the same key and Laissez returns the first response instead of acting again.">
                <div class="reveal-row"><input class="mono" value={idem} onInput={(e) => setIdem((e.target as HTMLInputElement).value)} /><Btn kind="ghost" onClick={() => setIdem(uuid())}>New key</Btn></div>
              </Field></div>
            ) : null}
          </div>
          {mutating ? <textarea class="mono" rows={10} value={bodyText} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} aria-label="Request body" /> : null}
          <div class="card-h xp-curl"><h2>curl</h2><Copy text={curl} /></div>
          <pre class="json"><code>{curl}</code></pre>
        </Card>
        <Card title="Response" actions={res ? <span class="row-inline tight"><Chip tone={res.status && res.status < 300 ? 'ok' : 'no'}>{res.status || 'No response'}</Chip>{ms !== null ? <span class="muted small">{ms} ms</span> : null}</span> : null}>
          {res ? (
            <>
              <dl class="kv wide xp-hdrs">
                {mutating ? <div><dt>Idempotent-Replayed</dt><dd>{replayed === 'true' ? <Chip tone="info">true: Laissez returned the stored first response</Chip> : replayed === 'false' ? <Chip>false: first time this key was used</Chip> : <span class="muted">Not returned</span>}</dd></div> : null}
                {Object.entries(res.headers).filter(([k, v]) => k !== 'Idempotent-Replayed' && v).map(([k, v]) => <div><dt>{k}</dt><dd><code>{String(v)}</code></dd></div>)}
              </dl>
              <Json value={res.body} />
            </>
          ) : <Empty title="No request sent yet">Pick a preset and press Send request. For a POST, send it twice without changing the Idempotency-Key to see a replay.</Empty>}
        </Card>
      </div>
    </>
  );
}

export function Webhooks() {
  const { can } = useMe();
  const hooks = useApi('/v1/webhooks');
  const del = useApi('/v1/webhook-deliveries');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['decision.created', 'settlement.completed']);
  const [created, setCreated] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const add = async (e: Event) => { e.preventDefault(); setErr(null); try { setCreated(await api('/v1/webhooks', { body: { url, events } })); setUrl(''); hooks.reload(); } catch (x) { setErr(x); } };
  const remove = async (id: string) => { setErr(null); await api(`/v1/webhooks/${id}`, { method: 'DELETE' }).catch(setErr); hooks.reload(); };
  const test = async (id: string) => { setErr(null); await api(`/v1/webhooks/${id}/test`, { body: {} }).catch(setErr); setTimeout(del.reload, 2500); };
  return (
    <>
      <Head title="Webhooks" sub="Signed event notifications. Each request carries a Laissez-Signature header: an HMAC-SHA256 of the timestamp and body." />
      <Card title="Add an endpoint">
        <form class="form-grid" onSubmit={add}>
          <div class="span2"><Field label="HTTPS URL" hint="Try a request-bin service to watch events arrive."><input type="url" required value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="https://example.com/laissez/webhooks" /></Field></div>
          <div class="span2"><span class="f-l">Events</span><div class="pick">{EVENTS.map((ev) => <label class={`pick-i ${events.includes(ev) ? 'on' : ''}`}><input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(events.includes(ev) ? events.filter((x) => x !== ev) : [...events, ev])} /><span><code>{ev}</code></span></label>)}</div></div>
          <div class="form-actions"><PermBtn perm="developer" type="submit" kind="primary" disabled={!events.length}>Add endpoint</PermBtn></div>
        </form>
        <PermNote perm="developer" />
        {created ? <Reveal label={`Signing secret for ${created.url}`} value={created.secret} note="Store it now. It is shown once. Use it to check the Laissez-Signature header on each delivery." /> : null}
        <ErrorBox error={err} />
      </Card>
      <Card title="Endpoints" pad={false}>
        {hooks.data?.data?.length ? <div class="tw"><table class="t"><thead><tr><th>URL</th><th>Events</th><th /></tr></thead><tbody>{hooks.data.data.map((h: any) => <tr><td class="mono small">{h.url}</td><td class="small">{h.events.join(', ')}</td><td><div class="row-inline tight acts"><PermBtn perm="developer" kind="ghost" onClick={() => test(h.id)}>Send test event</PermBtn>{can('developer') ? <ConfirmBtn confirm="Delete endpoint" onConfirm={() => remove(h.id)}>Delete</ConfirmBtn> : null}</div></td></tr>)}</tbody></table></div> : <Empty title="No endpoints yet" />}
      </Card>
      <Card title="Recent deliveries" actions={<Btn kind="ghost" onClick={del.reload}>Refresh</Btn>} pad={false}>
        {del.data?.data?.length ? <div class="tw"><table class="t"><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th><th>Time</th></tr></thead><tbody>{del.data.data.map((d: any) => <tr><td class="muted">{when(d.created_at)}</td><td><code>{d.event}</code></td><td>{d.status >= 200 && d.status < 300 ? <Chip tone="ok">{d.status}</Chip> : <Chip tone="no">{d.status || 'No response'}</Chip>}</td><td>{d.attempts}</td><td>{d.response_ms} ms</td></tr>)}</tbody></table></div> : <Empty title="No deliveries yet" />}
      </Card>
    </>
  );
}
