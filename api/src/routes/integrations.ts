// Notification channels: Slack, Microsoft Teams and generic JSON endpoints that receive in-app notifications
// as they are written. notify() in api/src/notifications.ts calls fanout() after its insert; delivery never
// blocks or fails the action behind the notification. Slack gets Block Kit, Teams an Adaptive Card, generic
// endpoints the notification as JSON with a Laissez-Signature HMAC header, the same scheme as webhooks.
import { z } from 'zod';
import type { Sql } from '../db';
import { ApiError, id, rand, hmac } from '../util';
import { router, body, need, audit, auditQ } from '../http';
import type { Notice } from '../notifications';

export const routes = router();

export const CHANNEL_KINDS = ['slack', 'teams', 'webhook'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
const MAX_CHANNELS = 10;
const EVENT = /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/;

export type Channel = { id: string; workspace_id: string; kind: ChannelKind; url: string; events: string[]; secret: string | null; name: string | null };
export type Fanout = { channel_id: string; kind: ChannelKind; status: number; ms: number; error?: string };

const row = (r: any) => ({ id: r.id, name: r.name, kind: r.kind, url: redact(r.url, r.kind), events: r.events, has_secret: !!r.secret, created_at: r.created_at, last_sent_at: r.last_sent_at, last_status: r.last_status, last_error: r.last_error });
/** Slack and Teams URLs embed a token: show the host and the first path segment only. */
function redact(url: string, kind: string) {
  if (kind === 'webhook') return url;
  try { const u = new URL(url); return `${u.origin}/${u.pathname.split('/').filter(Boolean)[0] ?? ''}/…`; } catch { return url.slice(0, 32) + '…'; }
}

/** Does a channel subscribed to these patterns want this notification kind? "*" and "monitor.*" are patterns. */
export function wants(events: string[], kind: string): boolean {
  return events.some((e) => e === '*' || e === kind || (e.endsWith('.*') && kind.startsWith(e.slice(0, -1))));
}

// ---------- Payloads ----------
const APP = 'https://parikshit7319.github.io/laissez/app/';
const linkOf = (n: Notice) => (n.link ? (n.link.startsWith('http') ? n.link : `${APP}${n.link.startsWith('#') ? n.link : `#${n.link}`}`) : null);
const kindLabel = (k: string) => k.replace(/[._]/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());

export function slackPayload(org: string, n: Notice) {
  const link = linkOf(n);
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: n.title.slice(0, 150), emoji: false } },
    ...(n.body ? [{ type: 'section', text: { type: 'mrkdwn', text: n.body.slice(0, 2900) } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${kindLabel(n.kind)} · ${org} · Laissez` }] },
    ...(link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Laissez', emoji: false }, url: link }] }] : []),
  ];
  return { text: `${n.title}${n.body ? `: ${n.body}` : ''}`, blocks };
}

export function teamsPayload(org: string, n: Notice) {
  const link = linkOf(n);
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: n.title.slice(0, 200), wrap: true },
          ...(n.body ? [{ type: 'TextBlock', text: n.body.slice(0, 2000), wrap: true }] : []),
          { type: 'TextBlock', text: `${kindLabel(n.kind)} · ${org} · Laissez`, isSubtle: true, size: 'Small', wrap: true },
        ],
        ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Laissez', url: link }] } : {}),
      },
    }],
  };
}

export function genericPayload(org: string, ws: string, n: Notice) {
  return { id: id('ntfe'), type: 'notification', created: new Date().toISOString(), organization: { id: ws, name: org }, data: { kind: n.kind, title: n.title, body: n.body ?? null, link: linkOf(n), user_id: n.user_id ?? null } };
}

async function post(ch: Channel, payloadText: string): Promise<{ status: number; ms: number; error?: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Laissez-Notifications/1' };
  if (ch.kind === 'webhook' && ch.secret) { const t = Math.floor(Date.now() / 1000); headers['laissez-signature'] = `t=${t},v1=${await hmac(ch.secret, `${t}.${payloadText}`)}`; }
  const start = Date.now();
  try {
    const res = await fetch(ch.url, { method: 'POST', headers, body: payloadText, signal: AbortSignal.timeout(8000) });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
    return { status: res.status, ms: Date.now() - start, ...(res.ok ? {} : { error: text || `HTTP ${res.status}` }) };
  } catch (e: any) {
    return { status: 0, ms: Date.now() - start, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Sends one notification to every channel of the organization that subscribes to its kind. Errors are recorded, never thrown. */
export async function fanout(sql: Sql, ws: string, notification: Notice): Promise<Fanout[]> {
  let channels: Channel[] = [];
  let org = 'Laissez';
  try {
    channels = await sql`select id, workspace_id, kind, url, events, secret, name from notification_channels where workspace_id = ${ws}`;
    if (!channels.length) return [];
    const [w] = await sql`select coalesce(brand_name, name) as name from workspaces where id = ${ws}`;
    org = w?.name ?? org;
  } catch (e) { console.error('fanout lookup failed', e); return []; }
  const out: Fanout[] = [];
  for (const ch of channels) {
    if (!wants(ch.events ?? [], notification.kind)) continue;
    const payload = ch.kind === 'slack' ? slackPayload(org, notification) : ch.kind === 'teams' ? teamsPayload(org, notification) : genericPayload(org, ws, notification);
    const r = await post(ch, JSON.stringify(payload));
    out.push({ channel_id: ch.id, kind: ch.kind, ...r });
    try { await sql`update notification_channels set last_sent_at = now(), last_status = ${r.status}, last_error = ${r.error ?? null} where workspace_id = ${ws} and id = ${ch.id}`; } catch { /* best effort */ }
  }
  return out;
}

/** Fire-and-forget form for notify(): one call per notice, failures logged. */
export function fanoutAll(sql: Sql, ws: string, notices: Notice[]): Promise<void> {
  return (async () => { for (const n of notices) await fanout(sql, ws, n); })().catch((e) => console.error('fanout failed', e));
}

// ---------- Routes ----------
export const channelIn = z.object({
  kind: z.enum(CHANNEL_KINDS),
  url: z.string().url().startsWith('https://', 'Channel URLs must use https.').max(600),
  name: z.string().trim().min(1).max(60).optional(),
  events: z.array(z.string().regex(EVENT, 'Use a notification kind such as screening.hit, a prefix such as monitor.*, or *.')).min(1).max(20).default(['*']),
});

routes.get('/notification-channels', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`select * from notification_channels where workspace_id = ${c.get('ws')} order by created_at`;
  return c.json({ data: rows.map(row), max_channels: MAX_CHANNELS, kinds: CHANNEL_KINDS, event_examples: ['*', 'monitor.*', 'screening.hit', 'policy.proposed', 'travel_rule.review', 'placement.limit'] });
});

routes.post('/notification-channels', async (c) => {
  const a = need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, channelIn);
  const host = new URL(b.url).hostname;
  if (b.kind === 'slack' && !/(^|\.)slack\.com$/.test(host)) throw new ApiError(422, 'channel_url_mismatch', 'A Slack channel needs an incoming webhook URL on hooks.slack.com. Create one under Slack apps, Incoming Webhooks.');
  if (b.kind === 'teams' && !/(^|\.)(office\.com|office365\.com|azure\.com|microsoft\.com|logic\.azure\.com)$/.test(host) && !/webhook\.office\.com$/.test(host)) throw new ApiError(422, 'channel_url_mismatch', 'A Teams channel needs an incoming webhook or Workflows URL from Microsoft (webhook.office.com or logic.azure.com).');
  const [{ n }] = await sql`select count(*)::int as n from notification_channels where workspace_id = ${ws}`;
  if (n >= MAX_CHANNELS) throw new ApiError(422, 'limit', `An organization can have up to ${MAX_CHANNELS} notification channels. Remove one first.`);
  const chId = id('nch', 10);
  const secret = b.kind === 'webhook' ? `nchsec_${rand(28)}` : null;
  const events = [...new Set(b.events)];
  const name = b.name ?? (b.kind === 'slack' ? 'Slack' : b.kind === 'teams' ? 'Microsoft Teams' : host);
  const [[r]] = await sql.transaction([
    sql`insert into notification_channels (workspace_id, id, kind, url, events, secret, name, created_by) values (${ws}, ${chId}, ${b.kind}, ${b.url}, ${events}, ${secret}, ${name}, ${a.realUserId ?? a.userId ?? null}) returning *`,
    auditQ(sql, ws, a, 'notification_channel.created', chId, { kind: b.kind, host, events, name }),
  ]);
  return c.json({ ...row(r), ...(secret ? { secret, note: 'Store the signing secret now. It is shown once. Each delivery carries Laissez-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">.' } : { note: 'Send a test message to check the channel receives it.' }) }, 201);
});

routes.delete('/notification-channels/:id', async (c) => {
  const a = need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const r = await sql`delete from notification_channels where workspace_id = ${ws} and id = ${c.req.param('id')} returning id, kind, name`;
  if (!r.length) throw new ApiError(404, 'not_found', `No notification channel ${c.req.param('id')}.`);
  await audit(sql, ws, a, 'notification_channel.deleted', r[0].id, { kind: r[0].kind, name: r[0].name });
  return c.json({ deleted: r[0].id });
});

routes.post('/notification-channels/:id/test', async (c) => {
  const a = need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [ch] = await sql`select * from notification_channels where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!ch) throw new ApiError(404, 'not_found', `No notification channel ${c.req.param('id')}.`);
  const [w] = await sql`select coalesce(brand_name, name) as name from workspaces where id = ${ws}`;
  const n: Notice = { kind: 'test', title: 'Test notification from Laissez', body: `Sent by ${a.name} to check this ${ch.kind === 'webhook' ? 'endpoint' : ch.kind === 'teams' ? 'Teams' : 'Slack'} channel.`, link: '#/settings/integrations' };
  const payload = ch.kind === 'slack' ? slackPayload(w?.name ?? 'Laissez', n) : ch.kind === 'teams' ? teamsPayload(w?.name ?? 'Laissez', n) : genericPayload(w?.name ?? 'Laissez', ws, n);
  const r = await post(ch as Channel, JSON.stringify(payload));
  await sql`update notification_channels set last_sent_at = now(), last_status = ${r.status}, last_error = ${r.error ?? null} where workspace_id = ${ws} and id = ${ch.id}`;
  const ok = r.status >= 200 && r.status < 300;
  return c.json({ sent: ok, channel_id: ch.id, status: r.status, response_ms: r.ms, error: r.error ?? null, message: ok ? 'Delivered. Check the channel for the test message.' : `The channel did not accept the message (${r.error ?? `HTTP ${r.status}`}). Check the URL and try again.` });
});

// ---------- OpenAPI operations (merged by api/src/openapi-gen.ts) ----------
const CH = { $ref: '#/components/schemas/NotificationChannel' };
export const OPENAPI_OPS = [
  { method: 'get', path: '/v1/notification-channels', tag: 'Webhooks', id: 'listNotificationChannels', sum: 'List notification channels', perm: 'read', desc: 'Slack, Microsoft Teams and generic JSON channels that receive in-app notifications. Slack and Teams URLs are redacted.', res: { type: 'object', properties: { data: { type: 'array', items: CH }, max_channels: { type: 'integer' }, kinds: { type: 'array', items: { type: 'string' } }, event_examples: { type: 'array', items: { type: 'string' } } }, required: ['data'] } },
  { method: 'post', path: '/v1/notification-channels', tag: 'Webhooks', id: 'createNotificationChannel', sum: 'Add a notification channel', perm: 'developer', desc: 'Slack gets Block Kit messages, Teams an Adaptive Card, a generic endpoint the notification as JSON signed with Laissez-Signature. events takes notification kinds, prefixes such as monitor.*, or *.', body: channelIn, ex: { kind: 'slack', url: 'https://hooks.slack.com/services/T000/B000/XXXX', events: ['screening.hit', 'monitor.*'] }, ok: 201, res: { allOf: [CH, { type: 'object', properties: { secret: { type: 'string' }, note: { type: 'string' } } }] }, err: [422] },
  { method: 'delete', path: '/v1/notification-channels/{id}', tag: 'Webhooks', id: 'deleteNotificationChannel', sum: 'Remove a notification channel', perm: 'developer', idd: 'Channel id.', res: { type: 'object', properties: { deleted: { type: 'string' } } } },
  { method: 'post', path: '/v1/notification-channels/{id}/test', tag: 'Webhooks', id: 'testNotificationChannel', sum: 'Send a test message', perm: 'developer', idd: 'Channel id.', desc: 'Posts a test notification to the channel right away and reports the response.', res: { type: 'object', properties: { sent: { type: 'boolean' }, channel_id: { type: 'string' }, status: { type: 'integer' }, response_ms: { type: 'integer' }, error: { type: ['string', 'null'] }, message: { type: 'string' } } } },
];
export const OPENAPI_SCHEMAS = {
  NotificationChannel: { type: 'object', properties: { id: { type: 'string' }, name: { type: ['string', 'null'] }, kind: { type: 'string', enum: [...CHANNEL_KINDS] }, url: { type: 'string', description: 'Redacted for Slack and Teams.' }, events: { type: 'array', items: { type: 'string' } }, has_secret: { type: 'boolean' }, created_at: { type: 'string', format: 'date-time' }, last_sent_at: { type: ['string', 'null'], format: 'date-time' }, last_status: { type: ['integer', 'null'] }, last_error: { type: ['string', 'null'] } }, required: ['id', 'kind', 'url', 'events'] },
};
