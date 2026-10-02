// Laissez SDK for TypeScript and JavaScript. One file, no dependencies.
// Runs on Node 18+, Deno, Bun, Cloudflare Workers and browsers: it needs only fetch and Web Crypto.
//
//   import { Laissez } from '@laissez/sdk';
//   const laissez = new Laissez({ apiKey: process.env.LAISSEZ_API_KEY });
//   const decision = await laissez.decisions.create({ action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 250000, settle_with: 'USDC' });
//
// Writes carry an Idempotency-Key automatically, so a retried request never applies twice.
// 429 and 5xx responses and network errors are retried with exponential backoff.

export const SDK_VERSION = '2026.10.2';
export const DEFAULT_BASE_URL = 'https://laissez-api.laissez.workers.dev';
export const DEFAULT_API_VERSION = '2026-10-02';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface LaissezOptions {
  /** lz_test_ API key. Use this from servers and jobs. */
  apiKey?: string;
  /** lz_sess_ session token from passkey or single sign-on. Use this from the browser on behalf of a signed-in person. */
  sessionToken?: string;
  /** API origin. Defaults to the live API. */
  baseUrl?: string;
  /** Value of the Laissez-Version header. Defaults to the current version. */
  version?: string;
  /** Retries after the first attempt for 429, 5xx and network errors. Default 3. 0 disables retries. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Generate an Idempotency-Key for every write that has none. Default true. */
  autoIdempotency?: boolean;
  /** A fetch implementation. Defaults to the global fetch. Tests pass a mock here. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Explicit Idempotency-Key for a write. Reuse the same key when you retry the same order. */
  idempotencyKey?: string;
  /** Query string parameters. Undefined and null values are dropped. */
  query?: Query;
  /** Extra headers for this request. */
  headers?: Record<string, string>;
  /** Overrides the client's maxRetries for this request. */
  maxRetries?: number;
  /** Aborts the request. */
  signal?: AbortSignal;
}

export interface ErrorBody { error: { code: string; message: string; detail?: unknown } }

/** Thrown for every non-2xx response, and for network failures after the last retry. */
export class LaissezError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  readonly requestId: string | null;
  readonly method: string;
  readonly path: string;
  constructor(init: { code: string; message: string; status: number; detail?: unknown; requestId?: string | null; method: string; path: string }) {
    super(init.message);
    this.name = 'LaissezError';
    this.code = init.code;
    this.status = init.status;
    this.detail = init.detail;
    this.requestId = init.requestId ?? null;
    this.method = init.method;
    this.path = init.path;
  }
  /** True for 429 rate_limited. */
  get isRateLimited() { return this.status === 429; }
  /** True when the API key lacks a scope, or the action needs a signed-in person. */
  get isPermission() { return this.status === 403; }
}

/** Metadata about the last HTTP exchange, attached to every returned object under the `laissez` symbol when the body is an object. */
export interface ResponseMeta { status: number; version: string | null; idempotentReplayed: boolean; requestId: string | null }
export const META: unique symbol = Symbol.for('laissez.response');

// ---------- Resource types (the shapes the API returns, abbreviated to what callers use most) ----------
export type Outcome = 'ALLOW' | 'DENY' | 'FREEZE';
export type Action = 'subscribe' | 'transfer' | 'redeem';
export type WhatIf = 'expired' | 'sanctioned' | 'capFull' | 'dropUAE' | 'badAsset' | 'becameUS';

export interface Check { id: string; layer: string; subject?: string; label: string; detail: string; result: 'pass' | 'fail' | 'na' | 'info'; ruleRef?: string; source?: string; binding?: boolean }
export interface BindingRule { text: string; layer: string; ruleRef: string }
export interface Receipt { decision_id: string; sandbox: string; outcome: Outcome; action: Action; fund: string; amount: string; asset: string; binding_rules: string[]; rule_packs: string[]; inputs_sha256: string; issued_at: string; dealing_date?: string | null }
export interface Decision {
  id: string | null; outcome: Outcome; headline: string; redemption_only?: boolean; units?: number; checks: Check[]; binding_rules?: BindingRule[]; remedies?: string[];
  rule_packs?: string[]; inputs_sha256?: string; hypothetical?: boolean; what_ifs?: WhatIf[]; dealing_date?: string | null; travel_rule?: unknown; settle_by?: string | null;
  persisted?: boolean; receipt?: Receipt | null; signature?: string | null; created_at?: string;
}
export interface DecisionCreate { action: Action; investor_id: string; fund: string; amount: number; settle_with: string; counterparty_id?: string; what_ifs?: WhatIf[]; persist?: boolean }
export interface DecisionSummary { id: string; action: Action; investor_id: string; investor: string; counterparty_id: string | null; ticker: string; amount: number; asset: string; outcome: Outcome; headline: string; what_ifs: string[]; dealing_date: string | null; actor_name?: string | null; created_at: string; settlement_status?: string | null }
export interface DecisionRecord extends Omit<Decision, 'id'> { id: string; action: Action; investor_id: string; investor_name: string; ticker: string; amount: number; asset: string; snapshot?: unknown; actor?: string | null; actor_name?: string | null; settlement_id?: string | null; settlement_status?: string | null; replayable?: boolean }
export interface Replay { decision_id: string; decided_at: string; reproduced: boolean; stored_outcome: Outcome; replayed_outcome: Outcome; stored_hash: string; replayed_hash: string; rule_packs: string[]; stored_rule_packs: string[]; headline: string; checks: Check[]; note: string }
export interface SettlementStep { step: string; at: string; block?: number }
export interface Settlement { id: string; decision_id: string; status: 'pending' | 'settled' | 'reverted'; units?: number; fund?: string; simulated?: boolean; steps?: unknown; chain?: unknown; poll?: string; note?: string; settled_at?: string | null; created_at?: string }
export interface Classification { code: string; basis?: string; verified?: string; expires?: string; optIn?: string }
export interface Investor { id: string; name: string; short?: string; kind?: string; residence: string; city?: string; booking?: string; usPerson?: boolean; wallet?: string; credentialId?: string; issued?: string; expires?: string; classifications: Classification[]; holdings?: Record<string, { units: number; since: string }>; lzid?: string; issuer?: string; credential_status?: string; residence_name?: string }
export interface InvestorCreate { name: string; kind: string; residence: string; city: string; booking_center: string; us_person?: boolean; wallet?: string; email?: string }
export interface Credential { id: string; lzid?: string | null; issuer_name?: string | null; investor_id: string; name?: string; issued_on: string; expires_on: string; status: 'active' | 'revoked'; revoked_at?: string | null; classifications?: Classification[] }
export interface CredentialIssue { investor_id: string; valid_months?: number; classifications: { class_code: string; evidence?: Record<string, number | boolean>; evidence_ref?: string }[] }
export interface Fund { ticker: string; id?: string; name: string; short?: string; domicile?: string; structure?: string; currency?: 'USD' | 'EUR'; nav?: number; regS?: boolean; distribution?: Record<string, { accepts: string[]; basis?: string; lawRequires?: string | null; lawText?: string; lawRef?: string }>; minSubscription?: number; holderCap?: number | null; holders?: number; lockupMonths?: number | null; assets?: string[]; chains?: string[]; issuer?: string; policyVersion?: number; [k: string]: unknown }
export interface PolicyInput { distribution: { jurisdiction: string; accepts: string[] }[]; min_subscription?: number; holder_cap?: number | null; lockup_months?: number | null }
export interface PolicyImpact { removed: string[]; added: string[]; holders_affected: { investor_id: string; name: string; from: string; to: string; units: number; value: number }[]; value_affected: number; currency: string; [k: string]: unknown }
export interface PolicyChange { id: string; ticker: string; status: 'draft' | 'published' | 'rejected'; proposed_by: string; approved_by?: string | null; changes?: PolicyInput; impact?: PolicyImpact; created_at?: string; [k: string]: unknown }
export interface ScreeningResult { name: string; normalized: string; result: 'clear' | 'near_miss' | 'potential_match'; threshold: number; candidates: { source: string; matched_name: string; score: number; would_hold: boolean; [k: string]: unknown }[] }
export interface ScreeningHit { id: string; investor_id: string | null; screened_name: string; source: string; matched_name: string; score: number; status: 'open' | 'false_positive' | 'confirmed'; [k: string]: unknown }
export interface WorkItem { id: string; kind: string; title: string; detail: string; severity: 'high' | 'medium' | 'low'; investor_id: string | null; ticker: string | null; status: 'open' | 'done' | 'dismissed'; due_on?: string | null; created_at: string; [k: string]: unknown }
export interface CredentialShare { id: string; direction: 'incoming' | 'outgoing'; status: 'pending' | 'active' | 'declined' | 'revoked'; lzid: string; investor_name: string; purpose: string; [k: string]: unknown }
export interface TravelRuleMessage { id: string; decision_id: string | null; direction: 'outbound' | 'inbound'; status: string; originator_vasp?: string; beneficiary_vasp?: string; [k: string]: unknown }
export interface AuditEvent { id: number; seq: number; type: string; subject: string | null; data: unknown; actor: string; actor_name: string; created_at: string; hash: string; prev_hash: string | null }
export interface AuditVerification { valid: boolean; events: number; head_seq: number | null; head_hash: string | null; bad_hashes: number; broken_links: number; first_break_seq: number | null; checked_at: string; latest_anchor: unknown; message: string }
export interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; ip_allowlist: string[] | null; expires_at: string | null; created_at: string; last_used_at: string | null; rotated_from?: string | null; current?: boolean }
export interface Webhook { id: string; url: string; events: string[]; created_at: string }
export interface WebhookDelivery { id: number | string; webhook_id: string; event: string; status: number; attempts: number; response_ms: number; replay_of: number | null; created_at: string; payload?: string }
export interface WebhookEvent<T = unknown> { id: string; type: string; created: string; data: T }
export interface Sandbox { workspace: { id: string; name: string; kind: string; slug: string; expires_at: string | null; [k: string]: unknown }; api_key: string; session_token: string; note?: string }
export interface Page<T> { data: T[]; [k: string]: unknown }

// ---------- Internals ----------
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
});

function randomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toQuery(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Compares two strings in time that depends on their length, not their content. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a); const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] ?? 0) ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0;
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies a webhook delivery and returns the parsed event.
 * `rawBody` must be the exact bytes Laissez sent (not re-serialized JSON). `header` is the Laissez-Signature header,
 * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>">`. Deliveries older than `toleranceSeconds` are rejected.
 * Throws LaissezError with code invalid_signature or signature_expired.
 */
export async function verifyWebhook<T = unknown>(rawBody: string | Uint8Array, header: string | null | undefined, secret: string, toleranceSeconds = 300, now: () => number = () => Date.now()): Promise<WebhookEvent<T>> {
  const bad = (code: string, message: string) => new LaissezError({ code, message, status: 400, method: 'POST', path: 'webhook' });
  if (!header) throw bad('invalid_signature', 'The Laissez-Signature header is missing.');
  if (!secret) throw bad('invalid_signature', 'A webhook secret is required to verify the signature.');
  const parts: Record<string, string[]> = {};
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i < 1) continue;
    const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim();
    (parts[k] ??= []).push(v);
  }
  const t = Number(parts.t?.[0]);
  const sigs = parts.v1 ?? [];
  if (!Number.isFinite(t) || !sigs.length) throw bad('invalid_signature', 'The Laissez-Signature header is malformed. Expected t=<unix>,v1=<hex>.');
  const body = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  const expected = await hmacHex(secret, `${t}.${body}`);
  let ok = false;
  for (const s of sigs) if (timingSafeEqual(expected, s.toLowerCase())) ok = true;
  if (!ok) throw bad('invalid_signature', 'The signature does not match this body and secret.');
  if (toleranceSeconds > 0 && Math.abs(now() / 1000 - t) > toleranceSeconds) throw bad('signature_expired', `The delivery is older than ${toleranceSeconds} seconds.`);
  try { return JSON.parse(body) as WebhookEvent<T>; }
  catch { throw bad('invalid_payload', 'The signature is valid but the body is not JSON.'); }
}

// ---------- Client ----------
export class Laissez {
  readonly baseUrl: string;
  readonly version: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly autoIdempotency: boolean;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LaissezOptions = {}) {
    const token = opts.apiKey ?? opts.sessionToken;
    if (!token) throw new Error('Laissez: pass apiKey (lz_test_...) or sessionToken (lz_sess_...).');
    if (opts.apiKey && opts.sessionToken) throw new Error('Laissez: pass apiKey or sessionToken, not both.');
    this.token = token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.version = opts.version ?? DEFAULT_API_VERSION;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.autoIdempotency = opts.autoIdempotency ?? true;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('Laissez: no fetch available. Pass one in options.');
    this.fetchImpl = f;
  }

  /** Open a sandbox without a client. Returns a test API key and a session token, shown once. */
  static async createSandbox(name?: string, opts: Pick<LaissezOptions, 'baseUrl' | 'version' | 'fetch'> = {}): Promise<Sandbox> {
    const f = opts.fetch ?? globalThis.fetch;
    const res = await f(`${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/sandboxes`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'laissez-version': opts.version ?? DEFAULT_API_VERSION }, body: JSON.stringify(name ? { name } : {}),
    });
    const body = await parseBody(res);
    if (!res.ok) throw errorFrom(res, body, 'POST', '/v1/sandboxes');
    return body as Sandbox;
  }

  /** Low-level request. Resource namespaces call this. */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    method = method.toUpperCase();
    const url = `${this.baseUrl}${path}${toQuery(opts.query)}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, 'laissez-version': this.version, accept: 'application/json', ...(opts.headers ?? {}) };
    let payload: string | undefined;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const write = WRITE.has(method);
    let idem = opts.idempotencyKey;
    if (write && !idem && this.autoIdempotency) idem = randomKey();
    if (write && idem) headers['idempotency-key'] = idem;
    // A write without an idempotency key is never retried: the first attempt may have been applied.
    const retries = write && !idem ? 0 : (opts.maxRetries ?? this.maxRetries);

    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.send(url, { method, headers, body: payload }, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (attempt >= retries) throw new LaissezError({ code: 'network_error', message: `Could not reach ${this.baseUrl}: ${(e as Error)?.message ?? e}`, status: 0, method, path });
        await sleep(backoff(attempt, null), opts.signal); attempt++; continue;
      }
      const parsed = await parseBody(res);
      if (res.ok) return attach(parsed, res) as T;
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599 && res.status !== 501);
      if (retryable && attempt < retries) {
        await sleep(backoff(attempt, res.headers.get('retry-after')), opts.signal); attempt++; continue;
      }
      throw errorFrom(res, parsed, method, path);
    }
  }

  private async send(url: string, init: { method: string; headers: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`Timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try { return await this.fetchImpl(url, { ...init, signal: ctl.signal }); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  get<T = unknown>(path: string, opts?: RequestOptions) { return this.request<T>('GET', path, undefined, opts); }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) { return this.request<T>('POST', path, body ?? {}, opts); }
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) { return this.request<T>('PATCH', path, body ?? {}, opts); }
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) { return this.request<T>('PUT', path, body ?? {}, opts); }
  delete<T = unknown>(path: string, opts?: RequestOptions) { return this.request<T>('DELETE', path, undefined, opts); }

  /** GET /v1/me: the signed-in person or the API key, and the organization. */
  me() { return this.get<Record<string, unknown>>('/v1/me'); }
  /** GET /v1/workspace: the organization with counts. */
  workspace() { return this.get<Record<string, unknown>>('/v1/workspace'); }
  /** GET /v1/metrics: decisions, allow rate, settled value and credential reuse. */
  metrics() { return this.get<Record<string, unknown>>('/v1/metrics'); }

  readonly decisions = {
    /** POST /v1/decisions. Persisted decisions return a signed receipt. Pass persist: false for a dry run. */
    create: (input: DecisionCreate, opts?: RequestOptions) => this.post<Decision>('/v1/decisions', input, opts),
    retrieve: (id: string, opts?: RequestOptions) => this.get<DecisionRecord>(`/v1/decisions/${enc(id)}`, opts),
    list: (query: { limit?: number; fund?: string; investor_id?: string } = {}, opts?: RequestOptions) => this.get<Page<DecisionSummary>>('/v1/decisions', { ...opts, query }),
    /** GET /v1/decisions/{id}/replay: re-runs the engine on the stored snapshot. */
    replay: (id: string, opts?: RequestOptions) => this.get<Replay>(`/v1/decisions/${enc(id)}/replay`, opts),
    /** POST /v1/evaluate/as-of: evaluate with policy and rule packs as they stood on a past date. Never persisted. */
    evaluateAsOf: (input: Omit<DecisionCreate, 'persist' | 'what_ifs'> & { as_of: string }, opts?: RequestOptions) => this.post<Decision>('/v1/evaluate/as-of', input, opts),
    /** POST /v1/eligibility/bulk: up to 200 prospective clients against every fund. */
    bulkEligibility: (input: { rows: { name: string; kind?: string; residence: string; booking_center: string; classes?: string[]; us_person?: boolean }[]; funds?: string[] }, opts?: RequestOptions) => this.post<Record<string, unknown>>('/v1/eligibility/bulk', input, opts),
    /** POST /v1/funds/{ticker}/policy/backtest. */
    backtest: (ticker: string, input: PolicyInput & { days?: number }, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/policy/backtest`, input, opts),
  };

  readonly settlements = {
    /** POST /v1/settlements. Returns status settled (201) or pending (202, on chain). */
    create: (decisionId: string, opts?: RequestOptions) => this.post<Settlement>('/v1/settlements', { decision_id: decisionId }, opts),
    retrieve: (id: string, opts?: RequestOptions) => this.get<Settlement>(`/v1/settlements/${enc(id)}`, opts),
    list: (opts?: RequestOptions) => this.get<Page<Settlement>>('/v1/settlements', opts),
    /** Polls GET /v1/settlements/{id} until the status is settled or reverted. Resolves with the final settlement; rejects with settlement_reverted or settlement_timeout. */
    waitUntilSettled: async (id: string, { intervalMs = 2000, timeoutMs = 120_000, signal }: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Settlement> => {
      const start = Date.now();
      for (;;) {
        const s = await this.settlements.retrieve(id, { signal });
        if (s.status === 'settled') return s;
        if (s.status === 'reverted') throw new LaissezError({ code: 'settlement_reverted', message: `Settlement ${id} reverted. Nothing moved.`, status: 409, method: 'GET', path: `/v1/settlements/${id}`, detail: s });
        if (Date.now() - start > timeoutMs) throw new LaissezError({ code: 'settlement_timeout', message: `Settlement ${id} is still pending after ${timeoutMs} ms.`, status: 0, method: 'GET', path: `/v1/settlements/${id}`, detail: s });
        await sleep(intervalMs, signal);
      }
    },
  };

  readonly investors = {
    list: (opts?: RequestOptions) => this.get<Page<Investor>>('/v1/investors', opts),
    create: (input: InvestorCreate, opts?: RequestOptions) => this.post<Investor>('/v1/investors', input, opts),
    retrieve: (id: string, opts?: RequestOptions) => this.get<Investor & { recent_decisions: DecisionSummary[]; credentials: Credential[]; holdings_detail: unknown[] }>(`/v1/investors/${enc(id)}`, opts),
    /** POST /v1/investors/{id}/portal-invite: a private lz_inv_ link for the client. */
    portalInvite: (id: string, opts?: RequestOptions) => this.post<{ link: string; expires_at: string }>(`/v1/investors/${enc(id)}/portal-invite`, {}, opts),
    revokePortalAccess: (id: string, opts?: RequestOptions) => this.delete<{ revoked_links: number }>(`/v1/investors/${enc(id)}/portal-access`, opts),
  };

  readonly credentials = {
    list: (query: { expiring_within?: number } = {}, opts?: RequestOptions) => this.get<Page<Credential>>('/v1/credentials', { ...opts, query }),
    /** POST /v1/credentials. Every classification is checked against its threshold; nothing is issued if one fails (422 threshold_not_met). */
    issue: (input: CredentialIssue, opts?: RequestOptions) => this.post<{ credential_id: string; lzid: string; expires_on: string; checks: unknown[]; investor: Investor }>('/v1/credentials', input, opts),
    revoke: (id: string, reason?: string, opts?: RequestOptions) => this.post<{ revoked: string; investor_id: string; revoked_at: string }>(`/v1/credentials/${enc(id)}/revoke`, reason ? { reason } : {}, opts),
  };

  readonly funds = {
    list: (opts?: RequestOptions) => this.get<Page<Fund>>('/v1/funds', opts),
    retrieve: (ticker: string, opts?: RequestOptions) => this.get<Fund>(`/v1/funds/${enc(ticker)}`, opts),
    create: (input: Record<string, unknown>, opts?: RequestOptions) => this.post<Fund>('/v1/funds', input, opts),
    register: (ticker: string, opts?: RequestOptions) => this.get<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/register`, opts),
    lifecycle: (ticker: string, opts?: RequestOptions) => this.get<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/lifecycle`, opts),
    updateTerms: (ticker: string, input: Record<string, unknown>, opts?: RequestOptions) => this.patch<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/terms`, input, opts),
    strikeNav: (ticker: string, input: { nav: number; date?: string; daily_yield_bps?: number | null; confirm?: boolean }, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/nav`, input, opts),
    runAccruals: (ticker: string, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/accruals/run`, {}, opts),
    distributions: {
      list: (ticker: string, opts?: RequestOptions) => this.get<Page<unknown>>(`/v1/funds/${enc(ticker)}/distributions`, opts),
      pay: (ticker: string, input: Record<string, unknown> = {}, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/distributions`, input, opts),
    },
    documents: {
      list: (ticker: string, opts?: RequestOptions) => this.get<{ ticker: string; data: unknown[] }>(`/v1/funds/${enc(ticker)}/documents`, opts),
      publish: (ticker: string, input: Record<string, unknown>, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/documents`, input, opts),
      retrieve: (id: string, opts?: RequestOptions) => this.get<Record<string, unknown>>(`/v1/documents/${enc(id)}`, opts),
      acknowledge: (id: string, input: Record<string, unknown>, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/documents/${enc(id)}/acknowledge`, input, opts),
      acknowledgments: (ticker: string, opts?: RequestOptions) => this.get<Record<string, unknown>>(`/v1/funds/${enc(ticker)}/acknowledgments`, opts),
    },
    redemptionNotices: {
      list: (opts?: RequestOptions) => this.get<Page<unknown>>('/v1/redemption-notices', opts),
      file: (input: { investor_id: string; ticker: string; units: number }, opts?: RequestOptions) => this.post<Record<string, unknown>>('/v1/redemption-notices', input, opts),
      cancel: (id: string, opts?: RequestOptions) => this.delete<Record<string, unknown>>(`/v1/redemption-notices/${enc(id)}`, opts),
    },
  };

  readonly policyChanges = {
    list: (opts?: RequestOptions) => this.get<Page<PolicyChange>>('/v1/policy-changes', opts),
    /** POST /v1/funds/{ticker}/policy/preview: impact on holders, nothing saved. */
    preview: (ticker: string, input: PolicyInput, opts?: RequestOptions) => this.post<PolicyImpact>(`/v1/funds/${enc(ticker)}/policy/preview`, input, opts),
    /** POST /v1/funds/{ticker}/policy/changes: saves a draft. A different signed-in person must approve it. */
    propose: (ticker: string, input: PolicyInput, opts?: RequestOptions) => this.post<PolicyChange>(`/v1/funds/${enc(ticker)}/policy/changes`, input, opts),
    /** Sessions only. API keys get 403 human_required. */
    approve: (id: string, opts?: RequestOptions) => this.post<PolicyChange>(`/v1/policy-changes/${enc(id)}/approve`, {}, opts),
    reject: (id: string, reason?: string, opts?: RequestOptions) => this.post<PolicyChange>(`/v1/policy-changes/${enc(id)}/reject`, reason ? { reason } : {}, opts),
  };

  readonly screening = {
    /** POST /v1/screening: screen a name against every loaded list. */
    screen: (name: string, opts?: RequestOptions) => this.post<ScreeningResult>('/v1/screening', { name }, opts),
    sources: (opts?: RequestOptions) => this.get<Page<unknown>>('/v1/sanctions/sources', opts),
    hits: {
      list: (query: { status?: 'open' | 'false_positive' | 'confirmed' | 'all' } = {}, opts?: RequestOptions) => this.get<Page<ScreeningHit>>('/v1/screening-hits', { ...opts, query }),
      decide: (id: string, status: 'false_positive' | 'confirmed', note?: string, opts?: RequestOptions) => this.post<ScreeningHit>(`/v1/screening-hits/${enc(id)}/decide`, { status, ...(note ? { note } : {}) }, opts),
    },
  };

  readonly workItems = {
    list: (query: { status?: 'open' | 'done' | 'dismissed' | 'all' } = {}, opts?: RequestOptions) => this.get<Page<WorkItem>>('/v1/work-items', { ...opts, query }),
    resolve: (id: string, status: 'done' | 'dismissed', note?: string, opts?: RequestOptions) => this.post<Record<string, unknown>>(`/v1/work-items/${enc(id)}/resolve`, { status, ...(note ? { note } : {}) }, opts),
  };

  readonly monitoring = {
    retrieve: (opts?: RequestOptions) => this.get<Record<string, unknown>>('/v1/monitoring', opts),
    run: (opts?: RequestOptions) => this.post<{ run_id: number; holders_checked: number; changes: number; items_opened: number; items_closed: number }>('/v1/monitoring/run', {}, opts),
  };

  readonly credentialShares = {
    list: (opts?: RequestOptions) => this.get<{ incoming: CredentialShare[]; outgoing: CredentialShare[] }>('/v1/credential-shares', opts),
    /** POST /v1/credential-shares: ask to rely on another distributor's credential by passport number. */
    request: (input: { lzid: string; purpose: string; booking_center: string }, opts?: RequestOptions) => this.post<{ share: CredentialShare; consent_url: string | null }>('/v1/credential-shares', input, opts),
    revoke: (id: string, reason: string, allRecipients = false, opts?: RequestOptions) => this.post<{ revoked: string[] }>(`/v1/credential-shares/${enc(id)}/revoke`, { reason, all_recipients: allRecipients }, opts),
  };

  readonly travelRule = {
    list: (query: { status?: string } = {}, opts?: RequestOptions) => this.get<Page<TravelRuleMessage>>('/v1/travel-rule/messages', { ...opts, query }),
    retrieve: (id: string, opts?: RequestOptions) => this.get<TravelRuleMessage>(`/v1/travel-rule/messages/${enc(id)}`, opts),
    start: (decisionId: string, opts?: RequestOptions) => this.post<TravelRuleMessage>('/v1/travel-rule/messages', { decision_id: decisionId }, opts),
    retry: (id: string, opts?: RequestOptions) => this.post<TravelRuleMessage>(`/v1/travel-rule/messages/${enc(id)}/retry`, {}, opts),
    confirm: (id: string, txid: string, opts?: RequestOptions) => this.post<TravelRuleMessage>(`/v1/travel-rule/messages/${enc(id)}/confirm`, { txid }, opts),
  };

  readonly reports = {
    placement: (opts?: RequestOptions) => this.get<Record<string, unknown>>('/v1/reports/placement', opts),
    distribution: (opts?: RequestOptions) => this.get<Record<string, unknown>>('/v1/reports/distribution', opts),
    placementCsv: (opts?: RequestOptions) => this.csv('/v1/reports/placement.csv', opts),
    decisionsCsv: (opts?: RequestOptions) => this.csv('/v1/reports/decisions.csv', opts),
    registerByJurisdictionCsv: (opts?: RequestOptions) => this.csv('/v1/reports/register-by-jurisdiction.csv', opts),
  };

  readonly audit = {
    /** GET /v1/audit-events, newest first. Page with before_seq = next_before_seq. */
    list: (query: { type?: string; actor?: string; before_seq?: number; limit?: number } = {}, opts?: RequestOptions) => this.get<Page<AuditEvent> & { next_before_seq: number | null }>('/v1/audit-events', { ...opts, query }),
    /** GET /v1/audit-events/verify: recomputes every hash and checks the chain. */
    verify: (opts?: RequestOptions) => this.get<AuditVerification>('/v1/audit-events/verify', opts),
    exportCsv: (opts?: RequestOptions) => this.csv('/v1/audit-events.csv', opts),
    anchors: (opts?: RequestOptions) => this.get<Record<string, unknown>>('/v1/audit-anchors', opts),
  };

  readonly apiKeys = {
    list: (opts?: RequestOptions) => this.get<Page<ApiKey> & { scopes: { id: string; label: string }[]; max_keys: number }>('/v1/api-keys', opts),
    /** POST /v1/api-keys. The key is returned once. */
    create: (input: { name?: string; scopes?: string[]; ip_allowlist?: string[]; expires_in_days?: number } = {}, opts?: RequestOptions) => this.post<ApiKey & { api_key: string }>('/v1/api-keys', input, opts),
    /** POST /v1/api-keys/{id}/rotate. The old key keeps working for 24 hours. */
    rotate: (id: string, opts?: RequestOptions) => this.post<ApiKey & { api_key: string; old_key_expires_at: string }>(`/v1/api-keys/${enc(id)}/rotate`, {}, opts),
    revoke: (id: string, opts?: RequestOptions) => this.delete<{ revoked: string }>(`/v1/api-keys/${enc(id)}`, opts),
  };

  readonly webhooks = {
    list: (opts?: RequestOptions) => this.get<Page<Webhook>>('/v1/webhooks', opts),
    /** POST /v1/webhooks. HTTPS only. The whsec_ secret is returned once. */
    create: (input: { url: string; events: string[] }, opts?: RequestOptions) => this.post<Webhook & { secret: string }>('/v1/webhooks', input, opts),
    delete: (id: string, opts?: RequestOptions) => this.delete<{ deleted: string }>(`/v1/webhooks/${enc(id)}`, opts),
    test: (id: string, opts?: RequestOptions) => this.post<{ sent: boolean }>(`/v1/webhooks/${enc(id)}/test`, {}, opts),
    deliveries: {
      list: (opts?: RequestOptions) => this.get<Page<WebhookDelivery>>('/v1/webhook-deliveries', opts),
      retrieve: (id: string | number, opts?: RequestOptions) => this.get<WebhookDelivery>(`/v1/webhook-deliveries/${enc(String(id))}`, opts),
      replay: (id: string | number, opts?: RequestOptions) => this.post<WebhookDelivery & { delivered: boolean }>(`/v1/webhook-deliveries/${enc(String(id))}/replay`, {}, opts),
    },
    /** Verify a delivery to your endpoint. Same as the exported verifyWebhook. */
    verify: verifyWebhook,
  };

  /** Public reference data. No permission needed beyond a valid token. */
  readonly reference = {
    jurisdictions: (opts?: RequestOptions) => this.get<Page<unknown>>('/v1/jurisdictions', opts),
    investorClasses: (opts?: RequestOptions) => this.get<Page<unknown>>('/v1/investor-classes', opts),
    bookingCenters: (opts?: RequestOptions) => this.get<Page<unknown>>('/v1/booking-centers', opts),
    rulePacks: (opts?: RequestOptions) => this.get<Page<unknown>>('/v1/rule-packs', opts),
    signingKey: (opts?: RequestOptions) => this.get<Record<string, unknown>>('/v1/signing-key', opts),
    verifyReceipt: (receipt: Receipt, signature: string, opts?: RequestOptions) => this.post<{ valid: boolean; message: string }>('/v1/receipts/verify', { receipt, signature }, opts),
  };

  private async csv(path: string, opts: RequestOptions = {}): Promise<string> {
    return this.request<string>('GET', path, undefined, { ...opts, headers: { accept: 'text/csv', ...(opts.headers ?? {}) } });
  }
}

const enc = (s: string) => encodeURIComponent(s);

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base / 2 + Math.random() * base / 2;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) { try { return JSON.parse(text); } catch { return text; } }
  try { return JSON.parse(text); } catch { return text; }
}

function attach(body: unknown, res: Response): unknown {
  if (body && typeof body === 'object') {
    const meta: ResponseMeta = { status: res.status, version: res.headers.get('laissez-version'), idempotentReplayed: res.headers.get('idempotent-replayed') === 'true', requestId: res.headers.get('cf-ray') };
    Object.defineProperty(body, META, { value: meta, enumerable: false });
  }
  return body;
}

/** Reads the HTTP status and headers recorded on an object the client returned. */
export function responseMeta(value: unknown): ResponseMeta | null {
  return (value && typeof value === 'object' && (value as any)[META]) || null;
}

function errorFrom(res: Response, body: unknown, method: string, path: string): LaissezError {
  const e = (body as ErrorBody | null)?.error;
  return new LaissezError({
    code: e?.code ?? (res.status === 429 ? 'rate_limited' : `http_${res.status}`),
    message: e?.message ?? `${method} ${path} failed with status ${res.status}.`,
    status: res.status, detail: e?.detail, requestId: res.headers.get('cf-ray'), method, path,
  });
}

export default Laissez;
