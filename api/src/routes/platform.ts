// Platform: API keys, idempotency, security headers, webhooks, the audit log and its verification,
// product analytics, the public status page and public product metrics.
import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { adminSql } from '../db';
import { ApiError, id, rand, sha256, validCidr, rateLimit, type Env } from '../util';
import { type Vars, router, body, bg, need, audit, auditQ, SCOPES } from '../http';
import { deliver } from '../ctx';
import { VERSIONS, LATEST_VERSION } from '../version';

export const routes = router();
export const publicRoutes = router();

const MAX_KEYS = 10;
const MAX_WEBHOOKS = { sandbox: 5, org: 20 } as const;

// ---------- Security headers (every response) ----------
const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";
type Mw = MiddlewareHandler<{ Bindings: Env; Variables: Vars }>;
export const securityHeaders: Mw = async (c, next) => {
  await next();
  const apply = (h: Headers) => {
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Strict-Transport-Security', 'max-age=31536000');
    if (c.req.header('authorization') || c.get('actor')) h.set('Cache-Control', 'no-store');
    if ((h.get('content-type') ?? '').includes('application/json') && !h.has('Content-Security-Policy')) h.set('Content-Security-Policy', JSON_CSP);
  };
  try { apply(c.res.headers); }
  catch {
    // Responses passed through from fetch() have immutable headers: copy them first.
    c.res = new Response(c.res.body, c.res);
    apply(c.res.headers);
  }
};

// ---------- Idempotency (authenticated writes) ----------
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/**
 * Replays the stored response when a write is retried with the same Idempotency-Key and body.
 * Keys are scoped to the organization and kept for 24 hours.
 */
export const idempotency: Mw = async (c, next) => {
  if (!IDEMPOTENT_METHODS.has(c.req.method)) return next();
  const key = c.req.header('idempotency-key');
  if (key === undefined) return next();
  if (!key.trim() || key.length > 255) throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 1 to 255 characters. A UUID works well.');
  const sql = c.get('sql'); const ws = c.get('ws');
  const url = new URL(c.req.url);
  const path = url.pathname + url.search;
  // Read a clone so the handler still gets an untouched body (JSON, form data or bytes).
  const raw = await c.req.raw.clone().text();
  const hash = await sha256(`${c.req.method}${path}${raw}`);
  const inserted = await sql`insert into idempotency_keys (workspace_id, key, method, path, request_hash) values (${ws}, ${key}, ${c.req.method}, ${path}, ${hash})
    on conflict (workspace_id, key) do nothing returning key`;
  if (!inserted.length) {
    const [row] = await sql`select request_hash, status, response from idempotency_keys where workspace_id = ${ws} and key = ${key}`;
    if (!row || row.status == null) throw new ApiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still running. Retry in a few seconds.');
    if (row.request_hash !== hash) throw new ApiError(422, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
    c.header('Idempotent-Replayed', 'true');
    return c.json(row.response, row.status);
  }
  let stored = false;
  try {
    await next();
    const res = c.res;
    if (res.status < 500 && (res.headers.get('content-type') ?? '').includes('application/json')) {
      const json = await res.clone().json().catch(() => undefined);
      if (json !== undefined) {
        await sql`update idempotency_keys set status = ${res.status}, response = ${JSON.stringify(json)} where workspace_id = ${ws} and key = ${key}`;
        stored = true;
      }
    }
  } finally {
    // Server errors and non-JSON responses are not replayable: free the key so the client can retry.
    if (!stored) await sql`delete from idempotency_keys where workspace_id = ${ws} and key = ${key} and status is null`;
  }
};

// ---------- API keys ----------
const keyRow = (r: any, current?: string) => ({
  id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, ip_allowlist: r.ip_allowlist, expires_at: r.expires_at, created_at: r.created_at, last_used_at: r.last_used_at,
  rotated_from: r.rotated_from, ...(current !== undefined ? { current: r.id === current } : {}),
  last_used_from: r.last_used_at ? { country: r.last_used_country ?? null, user_agent: r.last_used_ua ?? null, network: r.last_used_ip_hash ? String(r.last_used_ip_hash).slice(0, 8) : null } : null,
  known_networks: Array.isArray(r.known_ip_hashes) ? r.known_ip_hashes.length : 0,
});
const scopesZ = z.array(z.string()).min(1).max(Object.keys(SCOPES).length).refine((s) => s.every((x) => x in SCOPES), { message: `Each scope must be one of: ${Object.keys(SCOPES).join(', ')}` });

routes.get('/api-keys', async (c) => {
  const a = need(c, 'keys:admin');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [rows, [w], [q]] = await Promise.all([
    sql`select id, name, prefix, scopes, ip_allowlist, expires_at, created_at, last_used_at, rotated_from, last_used_ip_hash, last_used_country, last_used_ua, known_ip_hashes from api_keys
      where workspace_id = ${ws} and (expires_at is null or expires_at > now()) order by created_at`,
    sql`select monthly_quota from workspaces where id = ${ws}`,
    sql`select count, month::text as month from quotas where workspace_id = ${ws} and month = date_trunc('month', now())::date`,
  ]);
  const used = Number(q?.count ?? 0); const quota = Number(w?.monthly_quota ?? 100000);
  const resets = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  return c.json({
    data: rows.map((r) => keyRow(r, a.keyId ?? '')), scopes: Object.entries(SCOPES).map(([k, v]) => ({ id: k, label: v.label })), max_keys: MAX_KEYS,
    usage: { month: q?.month ?? new Date().toISOString().slice(0, 7) + '-01', used, quota, remaining: Math.max(0, quota - used), resets_at: resets, rate_limits: { session_per_minute: 600, key_per_minute: 300 } },
  });
});
routes.post('/api-keys', async (c) => {
  const a = need(c, 'keys:admin');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({
    name: z.string().trim().min(1).max(60).default('API key'),
    scopes: scopesZ.optional(),
    ip_allowlist: z.array(z.string().trim()).max(20).optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
  }));
  const scopes = [...new Set(b.scopes ?? Object.keys(SCOPES))];
  if (a.kind === 'key') {
    const extra = scopes.filter((s) => !(a.scopes ?? []).includes(s));
    if (extra.length) throw new ApiError(403, 'scope_escalation', `This key cannot create a key with scopes it does not have: ${extra.join(', ')}.`);
  }
  const bad = (b.ip_allowlist ?? []).filter((x) => !validCidr(x));
  if (bad.length) throw new ApiError(422, 'invalid_cidr', `Not a valid IP address or CIDR range: ${bad.join(', ')}. Use forms like 203.0.113.7 or 203.0.113.0/24.`);
  const [{ n }] = await sql`select count(*)::int as n from api_keys where workspace_id = ${ws} and (expires_at is null or expires_at > now())`;
  if (n >= MAX_KEYS) throw new ApiError(422, 'limit', `An organization can have up to ${MAX_KEYS} active keys. Revoke one first.`);
  const key = `lz_test_${rand(32)}`;
  const expires = b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 86_400_000).toISOString() : null;
  const allow = b.ip_allowlist?.length ? b.ip_allowlist : null;
  const [[row]] = await sql.transaction([
    sql`insert into api_keys (workspace_id, prefix, key_hash, name, scopes, ip_allowlist, expires_at, created_by)
      values (${ws}, ${key.slice(0, 12)}, ${await sha256(key)}, ${b.name}, ${scopes}, ${allow}, ${expires}, ${a.realUserId ?? a.userId ?? null})
      returning id, name, prefix, scopes, ip_allowlist, expires_at, created_at, last_used_at, rotated_from`,
    auditQ(sql, ws, a, 'api_key.created', key.slice(0, 12), { name: b.name, scopes, ip_allowlist: allow, expires_at: expires }),
  ]);
  return c.json({ ...keyRow(row), api_key: key, note: 'Store this key now. It is shown once.' }, 201);
});
routes.post('/api-keys/:id/rotate', async (c) => {
  const a = need(c, 'keys:admin');
  const sql = c.get('sql'); const ws = c.get('ws'); const keyId = c.req.param('id');
  const [old] = await sql`select id, name, prefix, scopes, ip_allowlist, expires_at, (select count(*)::int from api_keys n where n.workspace_id = k.workspace_id and n.rotated_from = k.id) as successors
    from api_keys k where workspace_id = ${ws} and id::text = ${keyId} and (expires_at is null or expires_at > now())`;
  if (!old) throw new ApiError(404, 'not_found', `No active key ${keyId}.`);
  if (old.successors > 0) throw new ApiError(409, 'already_rotated', 'This key was already rotated. Rotate its replacement instead.');
  if (a.kind === 'key' && (old.scopes as string[]).some((s) => !(a.scopes ?? []).includes(s))) throw new ApiError(403, 'scope_escalation', 'This key cannot rotate a key that has scopes it does not have.');
  const key = `lz_test_${rand(32)}`;
  const [[row], [oldRow]] = await sql.transaction([
    sql`insert into api_keys (workspace_id, prefix, key_hash, name, scopes, ip_allowlist, expires_at, created_by, rotated_from)
      values (${ws}, ${key.slice(0, 12)}, ${await sha256(key)}, ${old.name}, ${old.scopes}, ${old.ip_allowlist}, ${old.expires_at}, ${a.realUserId ?? a.userId ?? null}, ${old.id})
      returning id, name, prefix, scopes, ip_allowlist, expires_at, created_at, last_used_at, rotated_from`,
    sql`update api_keys set expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), now() + interval '24 hours') where workspace_id = ${ws} and id = ${old.id} returning expires_at`,
    auditQ(sql, ws, a, 'api_key.rotated', key.slice(0, 12), { from: old.prefix, old_key_id: old.id }),
  ]);
  return c.json({ ...keyRow(row), api_key: key, old_key_expires_at: oldRow.expires_at, note: 'Store this key now. It is shown once. The old key keeps working for 24 hours so you can deploy the new one.' }, 201);
});
routes.delete('/api-keys/:id', async (c) => {
  const a = need(c, 'keys:admin');
  const sql = c.get('sql'); const ws = c.get('ws'); const keyId = c.req.param('id');
  if (a.keyId && keyId === a.keyId) throw new ApiError(422, 'in_use', 'You cannot revoke the key making this request. Use another key or sign in.');
  const [r] = await sql.transaction([
    sql`delete from api_keys where workspace_id = ${ws} and id::text = ${keyId} returning id, prefix, name`,
  ]);
  if (!r.length) throw new ApiError(404, 'not_found', `No key ${keyId}.`);
  await audit(sql, ws, a, 'api_key.revoked', r[0].prefix, { key_id: r[0].id, name: r[0].name });
  return c.json({ revoked: r[0].id });
});

// ---------- Webhooks ----------
routes.get('/webhooks', async (c) => {
  need(c, 'read');
  return c.json({ data: await c.get('sql')`select id, url, events, created_at from webhooks where workspace_id = ${c.get('ws')} order by created_at` });
});
routes.post('/webhooks', async (c) => {
  const a = need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ url: z.string().url().startsWith('https://', 'Webhook URLs must use https.').max(500), events: z.array(z.string().regex(/^(\*|[a-z_]+(\.[a-z_]+)*)$/)).min(1).max(20) }));
  const cap = c.get('wsKind') === 'sandbox' ? MAX_WEBHOOKS.sandbox : MAX_WEBHOOKS.org;
  const [{ n }] = await sql`select count(*)::int as n from webhooks where workspace_id = ${ws}`;
  if (n >= cap) throw new ApiError(422, 'limit', `This organization can have up to ${cap} webhook endpoints. Delete one first.`);
  const whId = id('wh', 10); const secret = `whsec_${rand(28)}`;
  const events = [...new Set(b.events)];
  await sql.transaction([
    sql`insert into webhooks (workspace_id, id, url, secret, events) values (${ws}, ${whId}, ${b.url}, ${secret}, ${events})`,
    auditQ(sql, ws, a, 'webhook.created', whId, { url: b.url, events }),
  ]);
  return c.json({ id: whId, url: b.url, events, secret, note: 'Store the signing secret now. It is shown once.' }, 201);
});
routes.delete('/webhooks/:id', async (c) => {
  const a = need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [r] = await sql.transaction([sql`delete from webhooks where workspace_id = ${ws} and id = ${c.req.param('id')} returning id, url`]);
  if (!r.length) throw new ApiError(404, 'not_found', `No webhook ${c.req.param('id')}.`);
  await audit(sql, ws, a, 'webhook.deleted', r[0].id, { url: r[0].url });
  return c.json({ deleted: r[0].id });
});
routes.post('/webhooks/:id/test', async (c) => {
  need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [h] = await sql`select * from webhooks where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!h) throw new ApiError(404, 'not_found', `No webhook ${c.req.param('id')}.`);
  const payload = JSON.stringify({ id: id('evt'), type: 'ping', created: new Date().toISOString(), data: { message: 'Test event from Laissez' } });
  bg(c, deliver(sql, ws, h, 'ping', payload, null));
  return c.json({ sent: true, webhook_id: h.id, note: 'The delivery appears in GET /v1/webhook-deliveries within a few seconds.' });
});
routes.get('/webhook-deliveries', async (c) => {
  need(c, 'read');
  return c.json({ data: await c.get('sql')`select id, webhook_id, event, status, attempts, response_ms, replay_of, created_at from webhook_deliveries where workspace_id = ${c.get('ws')} order by created_at desc limit 100` });
});
routes.get('/webhook-deliveries/:id', async (c) => {
  need(c, 'read');
  const [r] = await c.get('sql')`select * from webhook_deliveries where workspace_id = ${c.get('ws')} and id::text = ${c.req.param('id')}`;
  if (!r) throw new ApiError(404, 'not_found', `No delivery ${c.req.param('id')}.`);
  return c.json(r);
});
routes.post('/webhook-deliveries/:id/replay', async (c) => {
  const a = need(c, 'developer');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [d] = await sql`select d.id, d.event, d.payload, w.id as hook_id from webhook_deliveries d left join webhooks w on w.workspace_id = d.workspace_id and w.id = d.webhook_id
    where d.workspace_id = ${ws} and d.id::text = ${c.req.param('id')}`;
  if (!d) throw new ApiError(404, 'not_found', `No delivery ${c.req.param('id')}.`);
  if (!d.hook_id) throw new ApiError(409, 'webhook_deleted', 'The webhook for this delivery was deleted, so there is nowhere to send it. Create the webhook again.');
  const [h] = await sql`select * from webhooks where workspace_id = ${ws} and id = ${d.hook_id}`;
  const res = await deliver(sql, ws, h, d.event, typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload), Number(d.id));
  await audit(sql, ws, a, 'webhook.replayed', String(d.id), { webhook: h.id, event: d.event, new_delivery: res.id, status: res.status });
  return c.json({ id: res.id, replay_of: Number(d.id), webhook_id: h.id, event: d.event, status: res.status, attempts: res.attempts, response_ms: res.ms, delivered: res.status >= 200 && res.status < 300 }, 201);
});

// ---------- Audit log ----------
routes.get('/audit-events', async (c) => {
  need(c, 'read');
  const type = c.req.query('type') || null; const actor = c.req.query('actor') || null;
  const before = Number(c.req.query('before_seq') ?? 0) || null;
  const limit = Math.max(1, Math.min(300, Number(c.req.query('limit') ?? 300) || 300));
  const rows = await c.get('sql')`select id, seq, type, subject, data, actor, actor_name, created_at, hash, prev_hash from audit_events
    where workspace_id = ${c.get('ws')} and (${type}::text is null or type like ${(type ?? '') + '%'}) and (${actor}::text is null or actor = ${actor} or actor_name ilike ${'%' + (actor ?? '') + '%'})
      and (${before}::bigint is null or seq < ${before}) order by seq desc limit ${limit}`;
  return c.json({ data: rows, next_before_seq: rows.length === limit ? rows[rows.length - 1].seq : null });
});
routes.get('/audit-events.csv', async (c) => {
  need(c, 'audit:export');
  const sql = c.get('sql'); const ws = c.get('ws');
  const rows = await sql`select seq, created_at, type, subject, actor, actor_name, data, prev_hash, hash from audit_events where workspace_id = ${ws} order by seq desc limit 5000`;
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['seq,created_at,type,subject,actor,actor_name,data,prev_hash,hash',
    ...rows.map((r) => [r.seq, new Date(r.created_at).toISOString(), r.type, r.subject, r.actor, r.actor_name, JSON.stringify(r.data), r.prev_hash, r.hash].map(esc).join(','))].join('\n');
  bg(c, audit(sql, ws, c.get('actor'), 'audit.exported', null, { rows: rows.length }));
  return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="laissez-audit-log.csv"' });
});
routes.get('/audit-events/verify', async (c) => {
  need(c, 'read');
  const ws = c.get('ws');
  // One pass in Postgres: recompute every hash and check each event links to the one before it.
  const [r] = await c.get('sql')`
    with e as (
      select seq, hash, prev_hash,
        audit_hash(seq, workspace_id, type, subject, data, actor, created_at, prev_hash) as calc,
        lag(hash) over (order by seq) as lag_hash, lag(seq) over (order by seq) as lag_seq
      from audit_events where workspace_id = ${ws}
    ), f as (
      select *, calc is distinct from hash as bad_hash,
        (case when lag_seq is null then seq <> 1 or prev_hash is distinct from repeat('0', 64) else seq <> lag_seq + 1 or prev_hash is distinct from lag_hash end) as broken_link
      from e
    ), agg as (
      select count(*)::int as events, max(seq) as head_seq, count(*) filter (where bad_hash)::int as bad_hashes, count(*) filter (where broken_link)::int as broken_links,
        min(seq) filter (where bad_hash or broken_link) as first_break_seq
      from f
    )
    select agg.*, (select hash from f where f.seq = agg.head_seq) as head_hash, now() as checked_at,
      (select row_to_json(x) from (
        select l.anchor_id, a.anchor_date::text, a.merkle_root, a.tx_hash, a.block, a.status, a.leaves, l.seq, l.head_hash, l.leaf, l.proof,
          (select f.hash = l.head_hash from f where f.seq = l.seq) as matches_log
        from audit_anchor_leaves l join audit_anchors a on a.id = l.anchor_id where l.workspace_id = ${ws} order by a.anchor_date desc limit 1) x) as latest_anchor
    from agg`;
  const anchorOk = !r.latest_anchor || r.latest_anchor.matches_log !== false;
  return c.json({
    valid: r.bad_hashes === 0 && r.broken_links === 0 && anchorOk,
    events: r.events, head_seq: r.head_seq == null ? null : Number(r.head_seq), head_hash: r.head_hash ?? null,
    bad_hashes: r.bad_hashes, broken_links: r.broken_links, first_break_seq: r.first_break_seq == null ? null : Number(r.first_break_seq),
    checked_at: r.checked_at, latest_anchor: r.latest_anchor ?? null,
    message: r.bad_hashes || r.broken_links
      ? `The chain is broken starting at event ${r.first_break_seq}. An event was altered, removed or inserted out of order.`
      : !anchorOk ? 'Every hash links, but the anchored head no longer matches the log. Events were rewritten after anchoring.'
      : `All ${r.events} events recompute to their stored hashes and link in order.`,
  });
});

// ---------- Public: API versions ----------
publicRoutes.get('/versions', (c) => c.json({ latest: LATEST_VERSION, header: 'Laissez-Version', data: VERSIONS }));

// ---------- Public: product analytics ----------
const EVENTS = new Set(['sandbox_opened', 'account_created', 'signed_in', 'order_previewed', 'order_placed', 'settlement_completed', 'policy_proposed', 'policy_published',
  'credential_issued', 'credential_shared', 'portal_opened', 'api_request_sent', 'demo_started']);
const PII_KEY = /(e-?mail|name|phone|address|street|city|zip|postal|ip|wallet|passport|ssn|tax|dob|birth|token|secret|key|password)/i;
function cleanProps(p: Record<string, unknown> | undefined) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(p ?? {}).slice(0, 12)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || PII_KEY.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 80 && !/@|\d{6,}|0x[0-9a-f]{8,}/i.test(v)) out[k] = v;
  }
  return out;
}
publicRoutes.post('/events', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, z.object({ event: z.string().max(40), anon_id: z.string().max(64).optional(), props: z.record(z.string(), z.unknown()).optional() }));
  if (!EVENTS.has(b.event)) throw new ApiError(422, 'unknown_event', `Event ${b.event} is not recorded. Allowed: ${[...EVENTS].join(', ')}.`);
  const ipHash = await sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
  if (!(await rateLimit(admin, `events:${ipHash}`, 120, 60))) throw new ApiError(429, 'rate_limited', 'More than 120 events in a minute from this network. Events were dropped; slow down.');
  let ws: string | null = null;
  const h = c.req.header('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (tok.startsWith('lz_sess_')) {
    const [s] = await admin`select workspace_id from sessions where token_hash = ${await sha256(tok)} and revoked_at is null and expires_at > now()`;
    ws = s?.workspace_id ?? null;
  } else if (tok.startsWith('lz_test_')) {
    const [k] = await admin`select workspace_id from api_keys where key_hash = ${await sha256(tok)} and (expires_at is null or expires_at > now())`;
    ws = k?.workspace_id ?? null;
  }
  const anon = b.anon_id && /^[A-Za-z0-9_-]{8,64}$/.test(b.anon_id) ? b.anon_id : null;
  await admin`insert into product_events (workspace_id, anon_id, event, props) values (${ws}, ${anon}, ${b.event}, ${JSON.stringify(cleanProps(b.props))})`;
  return c.json({ accepted: true }, 202);
});

// ---------- Public: status page ----------
const COMPONENTS: { id: string; name: string }[] = [
  { id: 'api', name: 'API' }, { id: 'database', name: 'Database' }, { id: 'chain_rpc', name: 'Chain RPC (Base Sepolia)' },
  { id: 'sanctions_data', name: 'Sanctions lists' }, { id: 'monitoring', name: 'Holder monitoring' },
];
const pct = (x: unknown) => (x == null ? null : Math.round(Number(x) * 100_000) / 1000);
const DAY_MS = 86_400_000;
/** The last n UTC calendar days, oldest first, as YYYY-MM-DD. The last entry is today (UTC). */
function utcDays(n: number, now = Date.now()): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}
const STATUS_DAYS = 90;
const INCIDENT_DAYS = 30;
// Error budget: 99.9 percent over a rolling 30 days, measured on the request path (the api and database checks).
// A check interval counts as down when either failed; each interval stands for 10 minutes, the check cadence.
const SLO_OBJECTIVE = 99.9;
const SLO_DAYS = 30;
const CHECK_INTERVAL_MIN = 10;
const LATENCY_HOURS = 24;
let statusCache: { at: number; data: unknown } | null = null;
publicRoutes.get('/status', async (c) => {
  if (statusCache && Date.now() - statusCache.at < 30_000) { c.header('Cache-Control', 'public, max-age=30'); return c.json(statusCache.data as any); }
  const admin = adminSql(c.env.DATABASE_URL);
  const days = utcDays(STATUS_DAYS);
  // Sampled request log: present once migrate-011 has run. Missing table or empty window both read as "no samples".
  const latencyRows = Promise.all([
    admin`select count(*)::int as samples,
        percentile_cont(0.5) within group (order by ms)::float8 as p50, percentile_cont(0.95) within group (order by ms)::float8 as p95, percentile_cont(0.99) within group (order by ms)::float8 as p99,
        count(*) filter (where status >= 500)::int as server_errors, count(*) filter (where status >= 400 and status < 500)::int as client_errors,
        min(ts) as first_sample_at
      from request_log_samples where ts > now() - make_interval(hours => ${LATENCY_HOURS})`,
    admin`select path, count(*)::int as samples, percentile_cont(0.95) within group (order by ms)::float8 as p95, count(*) filter (where status >= 500)::int as server_errors
      from request_log_samples where ts > now() - make_interval(hours => ${LATENCY_HOURS}) group by path order by samples desc limit 8`,
  ]).catch(() => [[{ samples: 0, p50: null, p95: null, p99: null, server_errors: 0, client_errors: 0, first_sample_at: null }], []] as [any[], any[]]);
  const [checks, sources, [mon], dailyRows, incidentRows, [slo], [[lat], latByRoute]] = await Promise.all([
    admin`select component,
        (array_agg(ok order by checked_at desc))[1] as ok, max(checked_at) as last_checked_at,
        (array_agg(latency_ms order by checked_at desc))[1] as latency_ms, (array_agg(detail order by checked_at desc))[1] as detail,
        avg(case when ok then 1.0 else 0.0 end) filter (where checked_at > now() - interval '24 hours') as up_24h,
        avg(case when ok then 1.0 else 0.0 end) filter (where checked_at > now() - interval '7 days') as up_7d,
        avg(case when ok then 1.0 else 0.0 end) as up_90d,
        count(*) filter (where checked_at > now() - interval '24 hours')::int as checks_24h
      from uptime_checks where checked_at > now() - interval '90 days' group by component`,
    admin`select source, name, last_fetched_at, last_published, entries, status, error,
        round(extract(epoch from now() - last_fetched_at) / 3600.0, 1)::float8 as age_hours from sanctions_sources order by source`,
    admin`select max(finished_at) as last_finished_at, count(*) filter (where started_at > now() - interval '24 hours')::int as runs_24h from monitor_runs`,
    // One row per component per UTC day that has checks. Days without checks are filled in below.
    admin`select component, to_char((checked_at at time zone 'UTC')::date, 'YYYY-MM-DD') as date,
        count(*)::int as checks, count(*) filter (where ok)::int as ok_checks
      from uptime_checks where checked_at >= (${days[0]}::date)::timestamp at time zone 'UTC'
      group by 1, 2`,
    // Incidents: runs of consecutive failed checks per component (gaps and islands). A run ends at the first passing check after it.
    admin`with c as (
        select component, checked_at, ok, detail,
          lead(checked_at) over (partition by component order by checked_at) as next_at,
          row_number() over (partition by component order by checked_at) - row_number() over (partition by component, ok order by checked_at) as grp
        from uptime_checks where checked_at > now() - make_interval(days => ${INCIDENT_DAYS})
      )
      select component, min(checked_at) as started_at, max(checked_at) as last_failed_at, count(*)::int as failed_checks,
        (array_agg(next_at order by checked_at desc))[1] as resolved_at, (array_agg(detail order by checked_at))[1] as detail
      from c where not ok group by component, grp order by started_at desc limit 50`,
    // Error budget: one row per check batch on the request path, down when api or database failed.
    admin`with b as (
        select checked_at, bool_and(ok) as up from uptime_checks
        where component in ('api', 'database') and checked_at > now() - make_interval(days => ${SLO_DAYS}) group by checked_at
      )
      select count(*)::int as intervals, count(*) filter (where not up)::int as failed_intervals, min(checked_at) as first_check_at from b`,
    latencyRows,
  ]);
  const components = COMPONENTS.map((k) => {
    const r = checks.find((x: any) => x.component === k.id);
    if (!r) return { id: k.id, name: k.name, status: 'unknown', ok: null, last_checked_at: null, latency_ms: null, detail: 'No checks recorded yet.', uptime: { '24h': null, '7d': null, '90d': null }, checks_24h: 0 };
    const stale = Date.now() - new Date(r.last_checked_at).getTime() > 30 * 60_000;
    return {
      id: k.id, name: k.name, status: stale ? 'unknown' : r.ok ? 'operational' : 'degraded', ok: r.ok, last_checked_at: r.last_checked_at, latency_ms: r.latency_ms, detail: stale ? 'The last check is more than 30 minutes old.' : r.detail,
      uptime: { '24h': pct(r.up_24h), '7d': pct(r.up_7d), '90d': pct(r.up_90d) }, checks_24h: r.checks_24h,
    };
  });
  const overall = components.some((x) => x.status === 'degraded') ? 'degraded' : components.every((x) => x.status === 'operational') ? 'operational' : 'partial_data';
  const byDay = new Map<string, { checks: number; ok_checks: number }>(dailyRows.map((r: any) => [`${r.component}|${r.date}`, { checks: r.checks, ok_checks: r.ok_checks }]));
  const daily = Object.fromEntries(COMPONENTS.map((k) => [k.id, days.map((date) => {
    const r = byDay.get(`${k.id}|${date}`);
    return { date, checks: r?.checks ?? 0, ok_checks: r?.ok_checks ?? 0, uptime: r?.checks ? pct(r.ok_checks / r.checks) : null };
  })]));
  const nowMs = Date.now();
  const incidents = incidentRows.map((r: any) => {
    const start = new Date(r.started_at).getTime();
    const end = r.resolved_at ? new Date(r.resolved_at).getTime() : null;
    return {
      component: r.component, name: COMPONENTS.find((k) => k.id === r.component)?.name ?? r.component,
      started_at: r.started_at, last_failed_at: r.last_failed_at, ended_at: r.resolved_at ?? null, ongoing: end == null,
      duration_seconds: Math.round(((end ?? nowMs) - start) / 1000), failed_checks: r.failed_checks, detail: r.detail ?? null,
    };
  });
  const intervals = Number(slo?.intervals ?? 0);
  const failedIntervals = Number(slo?.failed_intervals ?? 0);
  const availability = intervals ? pct((intervals - failedIntervals) / intervals) : null;
  const allowedMinutes = Math.round(SLO_DAYS * 1440 * (1 - SLO_OBJECTIVE / 100) * 10) / 10;
  const usedMinutes = failedIntervals * CHECK_INTERVAL_MIN;
  const remainingMinutes = Math.round((allowedMinutes - usedMinutes) * 10) / 10;
  const coveredDays = slo?.first_check_at ? Math.min(SLO_DAYS, Math.ceil((nowMs - new Date(slo.first_check_at).getTime()) / DAY_MS)) : 0;
  const errorBudget = {
    objective: SLO_OBJECTIVE, window_days: SLO_DAYS, covered_days: coveredDays,
    availability, intervals, failed_intervals: failedIntervals, interval_minutes: CHECK_INTERVAL_MIN,
    allowed_downtime_minutes: allowedMinutes, used_downtime_minutes: usedMinutes, remaining_minutes: remainingMinutes,
    remaining_share: allowedMinutes ? Math.max(0, Math.round((remainingMinutes / allowedMinutes) * 1000) / 1000) : null,
    state: !intervals ? 'no_data' : remainingMinutes <= 0 ? 'exhausted' : remainingMinutes < allowedMinutes * 0.25 ? 'warning' : 'ok',
    definition: `Availability is the share of ${CHECK_INTERVAL_MIN}-minute check intervals in the last ${SLO_DAYS} days where both the API and database checks passed. The objective is ${SLO_OBJECTIVE} percent, which allows ${allowedMinutes} minutes of downtime per ${SLO_DAYS} days. Each failed interval spends ${CHECK_INTERVAL_MIN} minutes of that budget.`,
  };
  const latency = {
    window_hours: LATENCY_HOURS, sample_rate: 20, samples: Number(lat?.samples ?? 0),
    p50_ms: lat?.p50 == null ? null : Math.round(lat.p50), p95_ms: lat?.p95 == null ? null : Math.round(lat.p95), p99_ms: lat?.p99 == null ? null : Math.round(lat.p99),
    server_errors: Number(lat?.server_errors ?? 0), client_errors: Number(lat?.client_errors ?? 0),
    server_error_rate: lat?.samples ? Math.round((Number(lat.server_errors) / Number(lat.samples)) * 100_000) / 1000 : null,
    first_sample_at: lat?.first_sample_at ?? null,
    by_route: (latByRoute as any[]).map((r) => ({ path: r.path, samples: r.samples, p95_ms: r.p95 == null ? null : Math.round(r.p95), server_errors: r.server_errors })),
    definition: `Measured inside the Worker from the first byte of the request to the response, on 1 in 20 requests over the last ${LATENCY_HOURS} hours. Network time between the client and Cloudflare is not included. Preflight requests and this endpoint are excluded.`,
  };
  const data = {
    status: overall, checked_at: new Date().toISOString(), components,
    error_budget: errorBudget, latency,
    sanctions: { sources, oldest_list_hours: sources.filter((s: any) => s.source !== 'LAISSEZ-TEST' && s.age_hours != null).reduce((m: number | null, s: any) => (m == null || s.age_hours > m ? s.age_hours : m), null) },
    monitoring: { last_run_finished_at: mon?.last_finished_at ?? null, runs_24h: mon?.runs_24h ?? 0 },
    daily_window_days: STATUS_DAYS, daily,
    incident_window_days: INCIDENT_DAYS, incidents,
    note: 'Checks run every 10 minutes from the API itself. Uptime is the share of passing checks in each window. Daily figures use UTC days. An incident is a run of consecutive failed checks; it starts at the first failed check and ends at the next passing one.',
  };
  statusCache = { at: Date.now(), data };
  c.header('Cache-Control', 'public, max-age=30');
  return c.json(data);
});

// ---------- Public: product metrics (aggregated across all organizations, no per-organization data) ----------
const FUNNEL = ['sandbox_opened', 'order_placed', 'settlement_completed', 'policy_published'];
const SERIES_DAYS = 30;
let metricsCache: { at: number; data: unknown } | null = null;
publicRoutes.get('/metrics/public', async (c) => {
  if (metricsCache && Date.now() - metricsCache.at < 60_000) { c.header('Cache-Control', 'public, max-age=60'); return c.json(metricsCache.data as any); }
  const admin = adminSql(c.env.DATABASE_URL);
  const days = utcDays(SERIES_DAYS);
  const since = days[0];
  const [funnel, northStar, [guard], [ttv], [reuse], eventDaily, valueDaily] = await Promise.all([
    admin`select event, count(distinct coalesce(anon_id, workspace_id::text))::int as subjects, count(*)::int as events from product_events
      where created_at > now() - interval '30 days' and event = any(${FUNNEL}) group by event`,
    // Cross-border: the acquiring (or exiting) investor resides outside the fund's domicile.
    admin`select f.currency,
        coalesce(sum(d.amount) filter (where s.created_at > now() - interval '30 days'), 0)::float8 as last_30d,
        coalesce(sum(d.amount), 0)::float8 as all_time,
        (count(*) filter (where s.created_at > now() - interval '30 days'))::int as settlements_30d, count(*)::int as settlements_all_time
      from settlements s
      join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
      join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker
      join investors i on i.workspace_id = d.workspace_id and i.id = case when d.action = 'transfer' and d.counterparty_id is not null then d.counterparty_id else d.investor_id end
      where s.status = 'settled' and d.outcome = 'ALLOW'
        and i.residence is distinct from (case f.domicile when 'British Virgin Islands' then 'VG' when 'Ireland' then 'IE' when 'Delaware, United States' then 'US' else null end)
      group by f.currency order by f.currency`,
    admin`select count(*) filter (where s.status in ('settled', 'pending') and (d.outcome <> 'ALLOW' or (s.steps ? 'recheck' and s.steps->'recheck'->>'outcome' <> 'ALLOW')))::int as settled_without_allow,
        count(*) filter (where s.steps ? 'recheck')::int as rechecked, count(*)::int as settlements
      from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id`,
    admin`with t0 as (
        select w.id, coalesce((select min(e.created_at) from product_events e where e.workspace_id = w.id and e.event = 'sandbox_opened'), w.created_at) as at
        from workspaces w where w.created_at > now() - interval '30 days'
      ), t1 as (
        select t0.id, t0.at as start_at, coalesce(
          (select min(e.created_at) from product_events e where e.workspace_id = t0.id and e.event = 'settlement_completed'),
          (select min(s.created_at) from settlements s where s.workspace_id = t0.id and s.status = 'settled')) as first_at
        from t0
      )
      select percentile_cont(0.5) within group (order by extract(epoch from first_at - start_at))::float8 as median_seconds,
        count(*) filter (where first_at is not null)::int as workspaces_settled, count(*)::int as workspaces
      from t1 where first_at is null or first_at >= start_at`,
    admin`with allowed as (select d.workspace_id, d.investor_id, count(distinct d.ticker) as funds from decisions d where d.outcome = 'ALLOW' group by 1, 2)
      select count(*)::int as investors, count(*) filter (where a.funds >= 2)::int as multi_fund,
        count(*) filter (where i.relied_share is not null)::int as relied
      from allowed a join investors i on i.workspace_id = a.workspace_id and i.id = a.investor_id`,
    // Daily series, UTC days. Uses the (event, created_at) index.
    admin`select event, to_char((created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as date, count(*)::int as n from product_events
      where event = any(${FUNNEL}) and created_at >= (${since}::date)::timestamp at time zone 'UTC' group by 1, 2`,
    // Same definition as the north star above, bucketed by the UTC day the settlement was recorded.
    admin`select f.currency, to_char((s.created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as date, coalesce(sum(d.amount), 0)::float8 as value, count(*)::int as n
      from settlements s
      join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
      join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker
      join investors i on i.workspace_id = d.workspace_id and i.id = case when d.action = 'transfer' and d.counterparty_id is not null then d.counterparty_id else d.investor_id end
      where s.status = 'settled' and d.outcome = 'ALLOW' and s.created_at >= (${since}::date)::timestamp at time zone 'UTC'
        and i.residence is distinct from (case f.domicile when 'British Virgin Islands' then 'VG' when 'Ireland' then 'IE' when 'Delaware, United States' then 'US' else null end)
      group by 1, 2`,
  ]);
  const step = (e: string) => funnel.find((x: any) => x.event === e)?.subjects ?? 0;
  const top = step(FUNNEL[0]);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const eventSeries = Object.fromEntries(FUNNEL.map((e) => [e, days.map(() => 0)])) as Record<string, number[]>;
  for (const r of eventDaily as any[]) { const i = dayIndex.get(r.date); if (i != null && eventSeries[r.event]) eventSeries[r.event][i] = r.n; }
  const valueSeries: Record<string, number[]> = {};
  const settledCount = days.map(() => 0);
  for (const r of valueDaily as any[]) {
    const i = dayIndex.get(r.date); if (i == null) continue;
    (valueSeries[r.currency] ??= days.map(() => 0))[i] = Math.round(Number(r.value) * 100) / 100;
    settledCount[i] += r.n;
  }
  const data = {
    generated_at: new Date().toISOString(), window_days: 30,
    funnel: FUNNEL.map((e) => ({ event: e, subjects: step(e), conversion_from_start: top ? Math.round((step(e) / top) * 1000) / 1000 : null })),
    north_star: {
      name: 'Cross-border compliant settled value', definition: 'Value of settled orders that passed every check, where the investor resides outside the fund domicile.',
      by_currency: northStar,
    },
    guardrail: {
      name: 'Settlements without a passing re-check', target: 0,
      settled_without_allow: guard.settled_without_allow, rechecked_at_settlement: guard.rechecked, settlements: guard.settlements,
    },
    time_to_first_settlement: { median_seconds: ttv.median_seconds == null ? null : Math.round(ttv.median_seconds), workspaces_settled: ttv.workspaces_settled, workspaces_opened_30d: ttv.workspaces },
    credential_reuse: {
      investors_with_allowed_orders: reuse.investors, multi_fund: reuse.multi_fund, multi_fund_rate: reuse.investors ? Math.round((reuse.multi_fund / reuse.investors) * 1000) / 1000 : null,
      relied_on_network: reuse.relied, network_rate: reuse.investors ? Math.round((reuse.relied / reuse.investors) * 1000) / 1000 : null,
    },
    series: {
      window_days: SERIES_DAYS, days, events: eventSeries,
      cross_border_settled_value: valueSeries, cross_border_settlements: settledCount,
      note: 'UTC days, oldest first; every array lines up with days. Event series count events, not distinct visitors.',
    },
    note: 'Aggregated across every live sandbox and organization. Sandboxes are deleted after 7 days, so all-time figures cover live data only.',
  };
  metricsCache = { at: Date.now(), data };
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(data);
});
