/** @jsxImportSource preact */
// Integrations: Slack, Microsoft Teams and generic JSON channels that receive in-app notifications as they happen.
import { useState } from 'preact/hooks';
import { api, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Empty, Field, Card, Reveal, ConfirmBtn, Loading } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const KINDS: { id: 'slack' | 'teams' | 'webhook'; label: string; hint: string; placeholder: string }[] = [
  { id: 'slack', label: 'Slack', hint: 'An incoming webhook URL from a Slack app. Messages use Block Kit with an Open in Laissez button.', placeholder: 'https://hooks.slack.com/services/T000/B000/XXXX' },
  { id: 'teams', label: 'Microsoft Teams', hint: 'An incoming webhook or Workflows URL from Teams. Messages are Adaptive Cards.', placeholder: 'https://prod-00.westus.logic.azure.com/workflows/...' },
  { id: 'webhook', label: 'JSON endpoint', hint: 'Any HTTPS URL. Each delivery is signed with Laissez-Signature, the same HMAC scheme as webhooks.', placeholder: 'https://example.com/laissez/notifications' },
];
const EVENT_PRESETS: [string, string][] = [
  ['*', 'Everything'], ['screening.hit', 'Screening matches'], ['monitor.*', 'Monitoring findings and runs'], ['policy.proposed', 'Policy changes awaiting approval'],
  ['travel_rule.*', 'Travel Rule reviews and delivery failures'], ['placement.limit', 'Placement limits'],
];

export function Integrations() {
  const { can } = useMe();
  const r = useApi('/v1/notification-channels');
  const [kind, setKind] = useState<'slack' | 'teams' | 'webhook'>('slack');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [events, setEvents] = useState<string[]>(['*']);
  const [created, setCreated] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, any>>({});
  const k = KINDS.find((x) => x.id === kind)!;
  const toggle = (ev: string) => setEvents((xs) => (ev === '*' ? ['*'] : xs.includes(ev) ? xs.filter((x) => x !== ev) : [...xs.filter((x) => x !== '*'), ev]));
  const add = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy('add');
    try { setCreated(await api('/v1/notification-channels', { body: { kind, url: url.trim(), name: name.trim() || undefined, events: events.length ? events : ['*'] } })); setUrl(''); setName(''); r.reload(); }
    catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const remove = async (id: string) => { setErr(null); try { await api(`/v1/notification-channels/${id}`, { method: 'DELETE' }); r.reload(); } catch (x) { setErr(x); } };
  const test = async (id: string) => {
    setErr(null); setBusy(id);
    try { const t = await api(`/v1/notification-channels/${id}/test`, { body: {} }); setTests((m) => ({ ...m, [id]: t })); r.reload(); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const rows: any[] = r.data?.data ?? [];
  return (
    <>
      <Head title="Integrations" sub="Send notifications where your team already works. Monitoring findings, screening matches, policy changes waiting for a second approver and Travel Rule reviews post to Slack, Microsoft Teams or your own endpoint the moment they are written." />
      <div class="grid2">
        <Card title="Add a channel">
          <form class="form-grid one" onSubmit={add}>
            <div class="tabs" role="tablist" aria-label="Channel type">{KINDS.map((x) => <button type="button" role="tab" aria-selected={kind === x.id} class={kind === x.id ? 'on' : ''} onClick={() => setKind(x.id)}>{x.label}</button>)}</div>
            <Field label={`${k.label} URL`} hint={k.hint}><input type="url" required value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder={k.placeholder} /></Field>
            <Field label="Name" hint="Optional. Shown in the list, for example #compliance-alerts."><input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder={kind === 'slack' ? '#compliance-alerts' : kind === 'teams' ? 'Compliance team' : 'Alerting service'} /></Field>
            <div><span class="f-l">Send</span><div class="pick">{EVENT_PRESETS.map(([ev, label]) => <label class={`pick-i ${events.includes(ev) ? 'on' : ''}`}><input type="checkbox" checked={events.includes(ev)} onChange={() => toggle(ev)} /><span>{label}<div class="small muted mono">{ev}</div></span></label>)}</div></div>
            <div class="form-actions"><PermBtn perm="developer" type="submit" kind="primary" busy={busy === 'add'} disabled={!url.trim()}>Add channel</PermBtn></div>
          </form>
          <PermNote perm="developer" />
          {created?.secret ? <Reveal label={`Signing secret for ${created.name ?? created.url}`} value={created.secret} note={created.note} /> : created ? <p class="ok-text" role="status">{created.note}</p> : null}
          <ErrorBox error={err} />
        </Card>
        <Card title="What gets sent">
          <p class="small">Slack receives a Block Kit message: a header with the title, the body, a context line with the kind and your organization, and an Open in Laissez button. Teams receives the same as an Adaptive Card. A JSON endpoint receives:</p>
          <pre class="json">{`{
  "id": "ntfe_...",
  "type": "notification",
  "created": "2026-10-02T06:22:07.000Z",
  "organization": { "id": "...", "name": "Aster & Vale Private Bank" },
  "data": {
    "kind": "screening.hit",
    "title": "Potential sanctions match: Blocked Example Trading LLC",
    "body": "87 percent similar to an OFAC SDN entry. Holdings are frozen until a reviewer decides.",
    "link": "https://.../app/#/screening-hits/hit_...",
    "user_id": null
  }
}`}</pre>
          <p class="small muted">Header <code>Laissez-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256 of "&lt;t&gt;.&lt;body&gt;"&gt;</code> with the channel's secret. Delivery is one attempt with an 8 second timeout; the result shows in the list. Notifications addressed to one person are sent too, without the person's name.</p>
        </Card>
      </div>
      <Card title="Channels" pad={false}>
        {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : rows.length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Channel</th><th>Sends</th><th>Last delivery</th><th /></tr></thead>
            <tbody>{rows.map((c) => {
              const t = tests[c.id];
              return (
                <tr>
                  <td><strong>{c.name ?? c.kind}</strong> <Chip tone="info">{KINDS.find((x) => x.id === c.kind)?.label ?? c.kind}</Chip><div class="small muted mono">{c.url}</div></td>
                  <td class="small">{c.events.join(', ')}</td>
                  <td class="small">
                    {c.last_sent_at ? <>{c.last_status >= 200 && c.last_status < 300 ? <Chip tone="ok">Delivered</Chip> : <Chip tone="no">{c.last_status ? `HTTP ${c.last_status}` : 'No response'}</Chip>}<div class="muted">{when(c.last_sent_at)}{c.last_error ? `. ${c.last_error}` : ''}</div></> : <span class="muted">Nothing sent yet</span>}
                    {t ? <div class={t.sent ? 'ok-text' : 'muted'} role="status">{t.message}</div> : null}
                  </td>
                  <td><div class="row-inline tight acts"><PermBtn perm="developer" kind="ghost" busy={busy === c.id} onClick={() => test(c.id)}>Send test</PermBtn>{can('developer') ? <ConfirmBtn confirm="Remove channel" onConfirm={() => remove(c.id)}>Remove</ConfirmBtn> : null}</div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <Empty title="No channels yet">Add a Slack or Teams webhook to get findings where the team reads them.</Empty>}
      </Card>
    </>
  );
}
