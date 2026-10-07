// Audit log export to the customer's own systems. Three kinds of destination:
//   splunk_hec   Splunk HTTP Event Collector (also Cribl, and anything that speaks HEC)
//   https        any HTTPS endpoint (Sentinel's Logs Ingestion API through a relay, Datadog, a customer function); the body
//                is signed the same way as webhooks (Laissez-Signature: t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">)
//   s3_worm      an S3 or S3-compatible bucket with Object Lock, one newline-delimited JSON object per batch, written with
//                a COMPLIANCE retention so neither the customer nor Laissez can delete it before the retention date
// Delivery is incremental: each destination remembers the last audit sequence number it received, so events go out once
// and in order, and a destination that was down catches up on the next run. The secrets in a destination's configuration
// are sealed with SSO_ENC_KEY; the tenant role cannot select the sealed column.
import type { Sql } from './db';
import { type Env, ApiError, seal, unseal, hmac, sha256, sha256Bytes, id as mkId, canonical } from './util';
import { z } from 'zod';

export const KINDS = ['splunk_hec', 'https', 's3_worm'] as const;
export type Kind = (typeof KINDS)[number];

// Destinations are https, except a loopback address so the local test can stand up a receiver.
const httpsUrl = z.string().url().refine((u) => u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u), 'Use an https:// address');
export const destinationIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('splunk_hec'), name: z.string().trim().min(2).max(80), url: httpsUrl, token: z.string().min(8).max(200), index: z.string().trim().max(80).optional(), sourcetype: z.string().trim().max(80).default('laissez:audit') }),
  z.object({ kind: z.literal('https'), name: z.string().trim().min(2).max(80), url: httpsUrl, secret: z.string().min(16).max(200) }),
  z.object({
    kind: z.literal('s3_worm'), name: z.string().trim().min(2).max(80), endpoint: httpsUrl, region: z.string().trim().min(2).max(40), bucket: z.string().trim().min(3).max(63),
    prefix: z.string().trim().max(120).default('laissez-audit'), access_key_id: z.string().min(8).max(128), secret_access_key: z.string().min(16).max(256),
    retention_days: z.number().int().min(1).max(3650).default(2555),
  }),
]);
export type DestinationIn = z.infer<typeof destinationIn>;

/** Splits a destination into what everyone may see and what is sealed. */
function split(d: DestinationIn): { pub: Record<string, unknown>; secret: Record<string, unknown> } {
  if (d.kind === 'splunk_hec') return { pub: { url: d.url, index: d.index ?? null, sourcetype: d.sourcetype }, secret: { token: d.token } };
  if (d.kind === 'https') return { pub: { url: d.url }, secret: { secret: d.secret } };
  return { pub: { endpoint: d.endpoint, region: d.region, bucket: d.bucket, prefix: d.prefix, retention_days: d.retention_days, access_key_id_hint: `${d.access_key_id.slice(0, 4)}...` }, secret: { access_key_id: d.access_key_id, secret_access_key: d.secret_access_key } };
}

export async function createDestination(env: Env, admin: Sql, ws: string, by: string, d: DestinationIn) {
  const { pub, secret } = split(d);
  const [{ n }] = await admin`select count(*)::int as n from siem_destinations where workspace_id = ${ws}`;
  if (n >= 5) throw new ApiError(422, 'too_many_destinations', 'An organization can have five audit export destinations. Remove one first.');
  const [{ seq }] = await admin`select coalesce(max(seq), 0)::bigint as seq from audit_events where workspace_id = ${ws}`;
  const id = mkId('dest');
  // A new destination starts from now: historic events are exported on request with POST .../backfill.
  await admin`insert into siem_destinations (id, workspace_id, kind, name, config_enc, config_public, last_seq, created_by) values (${id}, ${ws}, ${d.kind}, ${d.name}, ${await seal(env, JSON.stringify(secret))}, ${JSON.stringify(pub)}, ${seq}, ${by})`;
  return id;
}

type Dest = { id: string; workspace_id: string; kind: Kind; name: string; config_enc: string; config_public: Record<string, any>; enabled: boolean; last_seq: number | string };
type Event = { seq: number; type: string; subject: string | null; data: unknown; actor: string | null; actor_name: string | null; created_at: string; hash: string; prev_hash: string };

const BATCH = 500;

/** Pushes every event after last_seq to the destination, in batches, and records the result. Returns the number sent. */
export async function deliver(env: Env, admin: Sql, dest: Dest, opts: { fromSeq?: number; test?: boolean } = {}): Promise<{ sent: number; batches: number; error?: string }> {
  const secret = JSON.parse(await unseal(env, dest.config_enc));
  const [w] = await admin`select name, slug from workspaces where id = ${dest.workspace_id}`;
  let from = opts.fromSeq ?? Number(dest.last_seq);
  let sent = 0, batches = 0;
  if (opts.test) {
    const ev: Event = { seq: 0, type: 'audit.export_test', subject: dest.id, data: { message: 'Test event from Laissez. Your destination receives the audit log of this organization from here on.' }, actor: 'system', actor_name: 'Laissez', created_at: new Date().toISOString(), hash: '', prev_hash: '' };
    const r = await send(dest, secret, w, [ev], 'test');
    await admin`insert into siem_deliveries (destination_id, workspace_id, from_seq, to_seq, events, status, detail, object_key) values (${dest.id}, ${dest.workspace_id}, 0, 0, 1, ${r.ok ? 'sent' : 'failed'}, ${r.detail ?? null}, ${r.objectKey ?? null})`;
    await admin`update siem_destinations set last_run_at = now(), last_ok_at = ${r.ok ? new Date() : null} , last_error = ${r.ok ? null : r.detail ?? 'failed'} where id = ${dest.id}`;
    if (!r.ok) return { sent: 0, batches: 1, error: r.detail };
    return { sent: 1, batches: 1 };
  }
  for (;;) {
    const events: Event[] = await admin`select seq, type, subject, data, actor, actor_name, created_at, hash, prev_hash from audit_events where workspace_id = ${dest.workspace_id} and seq > ${from} order by seq asc limit ${BATCH}`;
    if (!events.length) break;
    const r = await send(dest, secret, w, events, `${events[0].seq}-${events[events.length - 1].seq}`);
    await admin`insert into siem_deliveries (destination_id, workspace_id, from_seq, to_seq, events, status, detail, object_key) values (${dest.id}, ${dest.workspace_id}, ${events[0].seq}, ${events[events.length - 1].seq}, ${events.length}, ${r.ok ? 'sent' : 'failed'}, ${r.detail ?? null}, ${r.objectKey ?? null})`;
    batches++;
    if (!r.ok) {
      await admin`update siem_destinations set last_run_at = now(), last_error = ${r.detail ?? 'failed'} where id = ${dest.id}`;
      return { sent, batches, error: r.detail };
    }
    from = Number(events[events.length - 1].seq);
    sent += events.length;
    await admin`update siem_destinations set last_seq = greatest(last_seq, ${from}), last_run_at = now(), last_ok_at = now(), last_error = null where id = ${dest.id}`;
    if (events.length < BATCH) break;
  }
  if (!batches) await admin`update siem_destinations set last_run_at = now(), last_ok_at = now(), last_error = null where id = ${dest.id}`;
  return { sent, batches };
}

/** Runs every enabled destination of every organization (scheduled), or of one organization. */
export async function runExports(env: Env, admin: Sql, ws?: string): Promise<{ destinations: number; sent: number; failed: number }> {
  const dests: Dest[] = ws
    ? await admin`select * from siem_destinations where workspace_id = ${ws} and enabled order by created_at`
    : await admin`select d.* from siem_destinations d join workspaces w on w.id = d.workspace_id where d.enabled and w.kind = 'org' order by d.created_at`;
  let sent = 0, failed = 0;
  for (const d of dests) {
    try { const r = await deliver(env, admin, d); sent += r.sent; if (r.error) failed++; }
    catch (e) { failed++; await admin`update siem_destinations set last_run_at = now(), last_error = ${String((e as Error).message).slice(0, 500)} where id = ${d.id}`; }
  }
  return { destinations: dests.length, sent, failed };
}

const shape = (w: any, e: Event) => ({ organization: w?.name, organization_slug: w?.slug, seq: Number(e.seq), type: e.type, subject: e.subject, actor: e.actor, actor_name: e.actor_name, data: e.data, created_at: e.created_at, hash: e.hash, prev_hash: e.prev_hash, source: 'laissez' });

async function send(dest: Dest, secret: any, w: any, events: Event[], label: string): Promise<{ ok: boolean; detail?: string; objectKey?: string }> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    if (dest.kind === 'splunk_hec') {
      const body = events.map((e) => JSON.stringify({ time: Math.floor(new Date(e.created_at).getTime() / 1000), sourcetype: dest.config_public.sourcetype || 'laissez:audit', source: 'laissez', ...(dest.config_public.index ? { index: dest.config_public.index } : {}), event: shape(w, e) })).join('\n');
      const r = await fetch(dest.config_public.url, { method: 'POST', headers: { authorization: `Splunk ${secret.token}`, 'content-type': 'application/json' }, body, signal: ctl.signal });
      return r.ok ? { ok: true, detail: `${events.length} events, HTTP ${r.status}` } : { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
    }
    if (dest.kind === 'https') {
      const body = JSON.stringify({ format: 'laissez.audit-export.v1', organization: w?.name, batch: label, events: events.map((e) => shape(w, e)) });
      const t = Math.floor(Date.now() / 1000);
      const sig = await hmac(secret.secret, `${t}.${body}`);
      const r = await fetch(dest.config_public.url, { method: 'POST', headers: { 'content-type': 'application/json', 'laissez-signature': `t=${t},v1=${sig}`, 'laissez-batch': label }, body, signal: ctl.signal });
      return r.ok ? { ok: true, detail: `${events.length} events, HTTP ${r.status}` } : { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
    }
    // s3_worm: one object per batch, locked until the retention date.
    const cfg = dest.config_public;
    const day = (events[0]?.created_at ? new Date(events[0].created_at) : new Date()).toISOString().slice(0, 10);
    const key = `${String(cfg.prefix || 'laissez-audit').replace(/^\/+|\/+$/g, '')}/${w?.slug ?? dest.workspace_id}/${day}/${label}.ndjson`;
    const body = events.map((e) => JSON.stringify(shape(w, e))).join('\n') + '\n';
    const retainUntil = new Date(Date.now() + Number(cfg.retention_days || 2555) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const r = await s3Put({ endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, key, body, accessKeyId: secret.access_key_id, secretAccessKey: secret.secret_access_key, headers: { 'x-amz-object-lock-mode': 'COMPLIANCE', 'x-amz-object-lock-retain-until-date': retainUntil, 'content-type': 'application/x-ndjson' }, signal: ctl.signal });
    return r.ok ? { ok: true, detail: `${events.length} events, locked until ${retainUntil.slice(0, 10)}`, objectKey: key } : { ok: false, detail: `HTTP ${r.status}: ${r.text.slice(0, 300)}`, objectKey: key };
  } catch (e) {
    return { ok: false, detail: String((e as Error).message).slice(0, 300) };
  } finally { clearTimeout(timer); }
}

// ---------- AWS Signature Version 4, enough for PutObject (path-style, works with any S3-compatible store) ----------
const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function hmacRaw(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
const encodeKey = (k: string) => k.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/** AWS Signature Version 4 for one request. Returns the Authorization header value. Pure, so the AWS test vectors can check it. */
export async function sigV4(o: { method: string; host: string; path: string; headers: Record<string, string>; payloadHash: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; amzDate: string }): Promise<string> {
  const headers: Record<string, string> = { ...o.headers, host: o.host };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const value = (h: string) => String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map((h) => `${h}:${value(h)}\n`).join('');
  const canonicalRequest = [o.method.toUpperCase(), o.path, '', canonicalHeaders, names.join(';'), o.payloadHash].join('\n');
  const date = o.amzDate.slice(0, 8);
  const scope = `${date}/${o.region}/${o.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, hex(await sha256Bytes(enc.encode(canonicalRequest)))].join('\n');
  let k: ArrayBuffer = await hmacRaw(enc.encode(`AWS4${o.secretAccessKey}`), date);
  k = await hmacRaw(k, o.region); k = await hmacRaw(k, o.service); k = await hmacRaw(k, 'aws4_request');
  const signature = hex(await hmacRaw(k, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

export async function s3Put(o: { endpoint: string; region: string; bucket: string; key: string; body: string; accessKeyId: string; secretAccessKey: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; text: string }> {
  const url = new URL(o.endpoint);
  const host = url.host;
  const path = `${url.pathname.replace(/\/$/, '')}/${o.bucket}/${encodeKey(o.key)}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payloadHash = hex(await sha256Bytes(enc.encode(o.body)));
  const headers: Record<string, string> = { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...(o.headers ?? {}) };
  const authorization = await sigV4({ method: 'PUT', host, path, headers, payloadHash, region: o.region, service: 's3', accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, amzDate });
  const r = await fetch(`${url.protocol}//${host}${path}`, { method: 'PUT', headers: { ...headers, authorization }, body: o.body, signal: o.signal });
  return { ok: r.ok, status: r.status, text: r.ok ? '' : await r.text().catch(() => '') };
}

/** For tests: the canonical request Laissez would sign, so a reader can compare with the AWS examples. */
export const _sigv4Internals = { encodeKey, hex, canonical, sha256 };
