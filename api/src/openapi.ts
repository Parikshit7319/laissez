// OpenAPI 3.1 description of the Laissez API. Plain data assembled once at startup by a few small helpers,
// so it adds little to the Worker bundle. Served at GET /v1/openapi.json and rendered at build time on
// /developers/reference. Keep it in step with the routers: `npm run test:openapi` cross-checks every route.

type S = { [k: string]: unknown };

// ---------- Schema helpers ----------
const t = (type: string | string[], x: S = {}): S => ({ type, ...x });
const str = (x: S = {}) => t('string', x);
const int = (x: S = {}) => t('integer', x);
const num = (x: S = {}) => t('number', x);
const bool = (x: S = {}) => t('boolean', x);
const ref = (n: string): S => ({ $ref: `#/components/schemas/${n}` });
const arr = (items: S, x: S = {}) => t('array', { items, ...x });
const d = (s: S, description: string): S => ({ ...s, description });
const en = (...v: string[]) => str({ enum: v });
/** Nullable form of a schema (OpenAPI 3.1 uses type arrays). */
const nul = (s: S): S => {
  if (s.$ref || !s.type) return { anyOf: [s, { type: 'null' }] };
  return { ...s, type: [s.type as string, 'null'], ...(Array.isArray(s.enum) ? { enum: [...(s.enum as unknown[]), null] } : {}) };
};
/** Object schema. A key ending in * is required. */
const o = (props: Record<string, S>, x: S = {}): S => {
  const properties: Record<string, S> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    const r = k.endsWith('*');
    const n = r ? k.slice(0, -1) : k;
    properties[n] = v;
    if (r) required.push(n);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), ...x };
};
const map = (v: S, description: string) => t('object', { additionalProperties: v, description });
const anyJson = (description: string): S => ({ description });
const list = (item: S, extra: Record<string, S> = {}) => o({ 'data*': arr(item), ...extra });
const date = str({ format: 'date' });
const dt = str({ format: 'date-time' });
const uuid = str({ format: 'uuid' });
const ymd = str({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', format: 'date' });
const money = num({ exclusiveMinimum: 0, maximum: 1e12 });
const note = d(str(), 'A plain-language note about the result.');

const LAYER = en('Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Documents', 'Fund terms', 'Transfer controls', 'Counterparty', 'Global screens');
const OUTCOME = en('ALLOW', 'DENY', 'FREEZE');
const ACTION = en('subscribe', 'transfer', 'redeem');
const ROLE = en('admin', 'ops', 'compliance', 'issuer', 'developer', 'auditor');
const SCOPE = en('read', 'orders', 'clients', 'funds', 'compliance', 'developer', 'admin');
const WHAT_IF = en('expired', 'sanctioned', 'capFull', 'dropUAE', 'badAsset', 'becameUS');
const DIST = arr(o({ 'jurisdiction*': d(str(), 'Jurisdiction code, for example SG or AE-DIFC.'), 'accepts*': d(arr(str(), { minItems: 1 }), 'Investor class codes accepted there, for example SG_AI.') }), { minItems: 1 });
const CHAIN = nul(o({ job_id: nul(str()), status: str(), network: str(), tx_hash: str(), block: int(), url: str() }, { description: 'On-chain job and transaction. Null for simulated settlement.' }));

// ---------- Permissions (mirror api/src/http.ts) ----------
const SCOPE_PERMS: Record<string, string[]> = {
  read: ['read', 'audit:export'], orders: ['orders:write'], clients: ['clients:write'], funds: ['funds:write'],
  compliance: ['compliance:write', 'work:write'], developer: ['developer'], admin: ['keys:admin'],
};
const ROLE_PERMS: Record<string, string[]> = {
  admin: ['*'], ops: ['read', 'clients:write', 'orders:write', 'work:write'],
  compliance: ['read', 'clients:write', 'compliance:write', 'policy:approve', 'work:write', 'audit:export'],
  issuer: ['read', 'funds:write', 'policy:approve'], developer: ['read', 'developer', 'keys:admin'], auditor: ['read', 'audit:export'],
};
const HUMAN_ONLY = ['policy:approve', 'members:admin'];
const ALL_ROLES = Object.keys(ROLE_PERMS);

// ---------- Examples (fictional sandbox data) ----------
const DEC_ID = 'dec_8KQ2M4ZP7WXA';
const STL_ID = 'stl_4WN8PQ2KD7ZT';
const PACKS = ['fund/TWLF@v1', 'SG/eligibility@2026.09.0', 'HK/eligibility@2026.04.2', 'global/sanctions@2026-10-01', 'global/travel-rule@2026.07'];
const HASH = '9b2f6c1e4d0a7b3c58e1f2a6d9c40b7e1a3f5d8c2b6e9f0a4c7d1e3b5a8f2c6d';
const CHECKS_EX = [
  { id: 'cred', layer: 'Credential', subject: 'Lumen Family Office', label: 'Laissez credential on file', result: 'pass', detail: 'LP-SG-0419-2207 is valid until 2027-03-14.' },
  { id: 'screen', layer: 'Credential', subject: 'Lumen Family Office', label: 'Sanctions name screening', result: 'pass', detail: 'No match against OFAC SDN, UN and EU consolidated lists.', ruleRef: 'OFAC', source: 'ofac' },
  { id: 'dist', layer: 'Fund policy', subject: 'Lumen Family Office', label: 'Offered in Singapore', result: 'pass', detail: 'Approved by the issuer for Singapore. Basis: Restricted scheme offer.' },
  { id: 'law', layer: 'Residence law', subject: 'Lumen Family Office', label: 'Singapore: Accredited investor with opt-in', result: 'pass', detail: 'Accredited investor status verified 2026-03-14, opted in.', ruleRef: 'SFA s305, s4A', source: 'sfa', binding: true },
  { id: 'booking', layer: 'Booking-center licence', subject: 'Lumen Family Office', label: 'Booked in Hong Kong: Professional investor', result: 'pass', detail: 'Professional investor status verified 2026-03-14.', ruleRef: 'Cap. 571D', source: 'hk-pi' },
  { id: 'min', layer: 'Fund policy', subject: 'Lumen Family Office', label: 'Minimum subscription $100,000', result: 'pass', detail: 'Order of $250,000 meets the minimum.' },
  { id: 'asset', layer: 'Fund policy', label: 'Settlement in USDC', result: 'pass', detail: 'TWLF accepts USDC and AVB-USD.' },
];
const RECEIPT_EX = { decision_id: DEC_ID, sandbox: '5f0c2a91', outcome: 'ALLOW', action: 'subscribe', fund: 'TWLF', amount: '250000', asset: 'USDC', binding_rules: ['Accredited investor with opt-in (SFA s305, s4A)'], rule_packs: PACKS, inputs_sha256: HASH, issued_at: '2026-10-02T06:22:07.000Z', dealing_date: '2026-10-02' };
const DECISION_EX = {
  id: DEC_ID, outcome: 'ALLOW', headline: 'Lumen Family Office can subscribe to Tidewell Treasury Liquidity.', redemption_only: false, units: 250000, checks: CHECKS_EX,
  binding_rules: [{ text: 'Accredited investor with opt-in', layer: 'Residence law', ruleRef: 'SFA s305, s4A' }], remedies: [], rule_packs: PACKS, inputs_sha256: HASH,
  hypothetical: false, what_ifs: [], dealing_date: '2026-10-02', travel_rule: null, settle_by: '2026-10-02T06:37:07.000Z', persisted: true, receipt: RECEIPT_EX,
  signature: 'kW3p9yZ0bQe4Tg1vN8mX2rA6cF5hJ7uL0sD3oP9iE1wK4nB8tV2qR6yM5xC7zH0gU3fS9aL1dJ4eQ8kN6bW2Ag', created_at: '2026-10-02T06:22:07.000Z',
};
const INVESTOR_EX = {
  id: 'lumen', name: 'Lumen Family Office Pte. Ltd.', short: 'Lumen Family Office', kind: 'Single-family office', residence: 'SG', city: 'Singapore', booking: 'HK', usPerson: false,
  wallet: '0x7a3f…c91e', credentialId: 'LP-SG-0419-2207', issued: '2026-03-14', expires: '2027-03-14', lzid: 'LZ-7K2M-9QX4-PA3D', issuer: 'Aster & Vale Private Bank',
  classifications: [{ code: 'SG_AI', basis: 'Corporation with net assets of S$48.2M', verified: '2026-03-14', expires: '2027-03-14', optIn: '2026-03-14' }, { code: 'HK_PI', basis: 'Corporation with a portfolio of HK$310M', verified: '2026-03-14', expires: '2027-03-14' }],
  holdings: { TWLF: { units: 3250000, since: '2025-11-02' }, AGPC: { units: 400000, since: '2026-06-01' } }, credential_status: 'active', residence_name: 'Singapore',
};
const FUND_EX = {
  id: 'TWLF', ticker: 'TWLF', name: 'Tidewell Treasury Liquidity Fund, Tokenized Class T', short: 'Tidewell Treasury Liquidity', domicile: 'British Virgin Islands',
  structure: 'Open-ended money market fund holding U.S. Treasury bills', currency: 'USD', nav: 1, regS: true, usAccepts: null,
  distribution: { SG: { accepts: ['SG_AI'], basis: 'Restricted scheme offer', lawRequires: 'SG_AI', lawText: 'Offer of a scheme not recognized by MAS: accredited investors who have opted in, or institutional investors.', lawRef: 'SFA s305, s4A', lawSource: 'sfa' } },
  minSubscription: 100000, holderCap: null, holders: 214, lockupMonths: null, assets: ['USDC', 'AVB-USD'], chains: ['Ethereum', 'Base'], issuer: 'Tidewell Asset Management (fictional)',
  policyVersion: 1, shareClassType: 'distributing', cutoffTime: '16:00', cutoffTz: 'America/New_York', dealingFrequency: 'daily', noticeDays: 0, gatePct: null, yieldBps: 512,
};

// ---------- Operation builder ----------
type Op = {
  tag: string; id: string; sum: string; desc?: string;
  /** public, trp, investor, session, any (any signed-in person or key), or a permission such as orders:write. */
  perm: string;
  human?: boolean;
  q?: S[];
  idd?: string; idx?: string;
  body?: S; ex?: unknown; form?: boolean;
  ok?: number; okd?: string; res?: S; rex?: unknown;
  more?: Record<string, S>;
  err?: number[];
  csv?: boolean;
};
const qp = (name: string, schema: S, description: string, required = false): S => ({ name, in: 'query', required, description, schema });
const json = (schema?: S, example?: unknown): S => ({ 'application/json': { ...(schema ? { schema } : {}), ...(example !== undefined ? { example } : {}) } });
const R = (n: string): S => ({ $ref: `#/components/responses/${n}` });
const P = (n: string): S => ({ $ref: `#/components/parameters/${n}` });
const ERR_NAME: Record<number, string> = { 400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable', 429: 'RateLimited', 501: 'NotConfigured', 502: 'BadGateway', 503: 'Unavailable' };
const PATH_PARAM: Record<string, [string, string]> = {
  ticker: ['Fund ticker.', 'TWLF'], token: ['The token from the link.', 'inv_3kQ9…'], ws: ['Organization id encoded in the Travel Address.', '5f0c2a91-7d3e-4b8a-9c11-2e6f4a8b0d17'],
  investor: ['Beneficiary investor id.', 'qamar'], msgId: ['Travel Rule message id.', 'trm_6TQ1Z8M3KD2W'], share_id: ['Credential share id.', 'shr_Z81Q4KW7M2PD'],
};

function operation(method: string, path: string, op: Op): S {
  const write = method !== 'get';
  const bearer = !['public', 'trp', 'investor'].includes(op.perm);
  const human = !!op.human || op.perm === 'session' || HUMAN_ONLY.includes(op.perm);
  const security = !bearer ? (op.perm === 'investor' ? [{ portalToken: [] }] : []) : human ? [{ sessionToken: [] }] : [{ sessionToken: [] }, { apiKey: [] }];
  const scopes = !bearer || human ? [] : op.perm === 'any' ? Object.keys(SCOPE_PERMS) : Object.keys(SCOPE_PERMS).filter((s) => SCOPE_PERMS[s].includes(op.perm));
  const roles = !bearer ? [] : ['any', 'session'].includes(op.perm) ? ALL_ROLES : ALL_ROLES.filter((r) => ROLE_PERMS[r].includes('*') || ROLE_PERMS[r].includes(op.perm));
  const params: S[] = [...path.matchAll(/\{([^}]+)\}/g)].map(([, n]) => {
    const [desc, ex] = n === 'id' ? [op.idd ?? 'Resource id.', op.idx] : PATH_PARAM[n] ?? ['Path parameter.', undefined];
    return { name: n, in: 'path', required: true, description: desc, schema: str(), ...(ex ? { example: ex } : {}) };
  });
  params.push(...(op.q ?? []), P('LaissezVersion'));
  if (bearer && write) params.push(P('IdempotencyKey'));
  if (op.perm === 'trp') params.push(P('TrpVersion'), P('TrpRequestId'));
  const ok = op.ok ?? 200;
  const headers: S = { 'Laissez-Version': { $ref: '#/components/headers/LaissezVersion' }, ...(bearer && write ? { 'Idempotent-Replayed': { $ref: '#/components/headers/IdempotentReplayed' } } : {}) };
  const responses: S = {
    [String(ok)]: ok === 204 ? { description: op.okd ?? 'No content.', headers } : ok === 302 ? { description: op.okd ?? 'Redirect.', headers: { ...headers, Location: { schema: str(), description: 'Where the browser goes next.' } } }
      : { description: op.okd ?? (ok === 201 ? 'Created.' : 'OK.'), headers, content: op.csv ? { 'text/csv': { schema: str({ description: 'RFC 4180 CSV with a header row.' }) } } : json(op.res ?? anyJson('JSON object.'), op.rex) },
    ...(op.more ?? {}),
  };
  const codes = new Set<number>([400, ...(op.perm !== 'public' && op.perm !== 'trp' ? [401] : []), ...(bearer ? [403] : []), ...(params.some((p) => p.in === 'path') ? [404] : []), ...(op.err ?? []), ...(op.perm !== 'public' ? [429] : [])]);
  for (const c of [...codes].sort()) if (!responses[String(c)]) responses[String(c)] = R(ERR_NAME[c]);
  return {
    tags: [op.tag], operationId: op.id, summary: op.sum, ...(op.desc ? { description: op.desc } : {}), security, parameters: params,
    ...(op.body ? { requestBody: { required: true, content: op.form ? { 'application/x-www-form-urlencoded': { schema: op.body } } : json(op.body, op.ex) } } : {}),
    responses,
    'x-laissez-permission': op.perm, 'x-laissez-api-key-scopes': scopes, 'x-laissez-roles': roles, ...(human ? { 'x-laissez-human-only': true } : {}),
  };
}

const LIMIT = (max: number, def: number) => qp('limit', int({ minimum: 1, maximum: max, default: def }), `Maximum rows to return, 1 to ${max}.`);
const STATUS = (vals: string[], def: string | null, what: string) => qp('status', str({ enum: vals, ...(def ? { default: def } : {}) }), `Filter by ${what} status.`);
const created = (x: Record<string, S>) => o(x);

// ---------- Operations ----------
const OPS: [string, Op][] = [
  // Platform
  ['get /', { tag: 'Platform', id: 'getApiOverview', sum: 'API overview', perm: 'public', desc: 'Name, current version, supported versions and links to the docs, the sandbox and status.', res: o({ name: str(), version: str(), versions: arr(str()), docs: str(), sandbox: str(), status: str() }) }],
  ['get /v1/health', { tag: 'Platform', id: 'getHealth', sum: 'Health check', perm: 'public', desc: 'Returns ok when the API can reach its database.', res: o({ ok: bool(), version: str() }), rex: { ok: true, version: '2026-10-02' } }],
  ['get /v1/openapi.json', { tag: 'Platform', id: 'getOpenApi', sum: 'This OpenAPI document', perm: 'public', res: anyJson('OpenAPI 3.1 document.') }],
  ['get /v1/versions', { tag: 'Platform', id: 'listVersions', sum: 'List API versions', perm: 'public', desc: 'Every version with its release date and changes. Pin one with the Laissez-Version header.', res: o({ latest: str(), header: str(), data: arr(o({ version: str(), released: date, changes: arr(str()) })) }) }],
  ['get /v1/status', { tag: 'Platform', id: 'getStatus', sum: 'Service status', perm: 'public', desc: 'Component health from checks that run every 10 minutes, with 24 hour, 7 day and 90 day uptime. Cached for 30 seconds. Rendered at /laissez/status/.', res: o({ status: en('operational', 'degraded', 'partial_data'), checked_at: dt, components: arr(o({ id: str(), name: str(), status: en('operational', 'degraded', 'unknown'), ok: nul(bool()), last_checked_at: nul(dt), latency_ms: nul(int()), detail: str(), uptime: o({ '24h': nul(num()), '7d': nul(num()), '90d': nul(num()) }), checks_24h: int() })), sanctions: anyJson('Sanctions list freshness.'), monitoring: anyJson('Last monitoring run.'), note }) }],
  ['get /v1/metrics/public', { tag: 'Platform', id: 'getPublicMetrics', sum: 'Public product metrics', perm: 'public', desc: 'Funnel, north-star and guardrail metrics aggregated across all organizations. No per-organization data. Cached for 60 seconds.', res: o({ generated_at: dt, window_days: int(), funnel: arr(o({ event: str(), subjects: int(), conversion_from_start: nul(num()) })), north_star: anyJson('Cross-border compliant settled value by currency.'), guardrail: anyJson('Settlements without a passing re-check. Target 0.'), time_to_first_settlement: anyJson('Median seconds from sandbox to first settlement.'), credential_reuse: anyJson('Multi-fund and network credential reuse.'), note }) }],
  ['post /v1/events', { tag: 'Platform', id: 'recordEvent', sum: 'Record a product event', perm: 'public', desc: 'Anonymous product analytics from the site and app. Properties that look like personal data are dropped. 120 events per minute per network.', body: o({ 'event*': en('sandbox_opened', 'account_created', 'signed_in', 'order_previewed', 'order_placed', 'settlement_completed', 'policy_proposed', 'policy_published', 'credential_issued', 'credential_shared', 'portal_opened', 'api_request_sent', 'demo_started'), anon_id: str({ maxLength: 64, pattern: '^[A-Za-z0-9_-]{8,64}$' }), props: map(t(['string', 'number', 'boolean']), 'Up to 12 properties.') }), ok: 202, okd: 'Accepted.', res: o({ accepted: bool() }), err: [422] }],

  // Auth
  ['post /v1/sandboxes', { tag: 'Auth', id: 'createSandbox', sum: 'Open a sandbox', perm: 'public', desc: 'Creates a 7-day sandbox organization seeded with fictional investors, funds and teammates. Returns a test API key with every scope and a session token. Both are shown once. 10 sandboxes per hour per network.', body: o({ name: str({ maxLength: 80 }) }), ex: { name: 'Aster & Vale sandbox' }, ok: 201, res: ref('Sandbox'), rex: { workspace: { id: '5f0c2a91-7d3e-4b8a-9c11-2e6f4a8b0d17', name: 'Aster & Vale sandbox', kind: 'sandbox', slug: 'sbx-5f0c2a91', created_at: '2026-10-02T06:20:00.000Z', expires_at: '2026-10-09T06:20:00.000Z' }, api_key: 'lz_test_Xq7…', session_token: 'lz_sess_9Fh…', note: 'Store the API key now. It is shown once. Everything in this sandbox is fictional and is deleted when it expires.' }, err: [503] }],
  ['post /v1/auth/register/options', { tag: 'Auth', id: 'registerOptions', sum: 'Start passkey registration', perm: 'public', desc: 'Returns WebAuthn creation options. Name a new organization, or pass an invite token to join one. 8 attempts per hour per network.', body: o({ 'email*': str({ format: 'email', maxLength: 160 }), 'name*': str({ minLength: 2, maxLength: 80 }), org_name: str({ minLength: 2, maxLength: 80 }), invite_token: str(), demo_data: bool({ default: true }) }), res: o({ challenge_id: uuid, joining: nul(o({ organization: str(), role: ROLE })), options: anyJson('PublicKeyCredentialCreationOptions for navigator.credentials.create().') }), err: [409, 422] }],
  ['post /v1/auth/register/verify', { tag: 'Auth', id: 'registerVerify', sum: 'Finish passkey registration', perm: 'public', desc: 'Verifies the attestation, creates the account and its organization (or joins the invited one) and signs in.', body: o({ 'challenge_id*': uuid, 'credential*': anyJson('The RegistrationResponse JSON from the browser.') }), ok: 201, res: ref('SessionToken'), err: [409, 410] }],
  ['post /v1/auth/login/options', { tag: 'Auth', id: 'loginOptions', sum: 'Start passkey sign-in', perm: 'public', res: o({ challenge_id: uuid, options: anyJson('PublicKeyCredentialRequestOptions for navigator.credentials.get().') }) }],
  ['post /v1/auth/login/verify', { tag: 'Auth', id: 'loginVerify', sum: 'Finish passkey sign-in', perm: 'public', desc: 'Verifies the assertion and returns a session token valid for 7 days, or 12 hours of inactivity outside sandboxes. 30 attempts per 10 minutes per network.', body: o({ 'challenge_id*': uuid, 'credential*': anyJson('The AuthenticationResponse JSON from the browser.'), workspace_id: d(uuid, 'Organization to sign in to. Defaults to the most recent.') }), res: ref('SessionToken'), err: [403] }],
  ['get /v1/auth/invites/{token}', { tag: 'Auth', id: 'getInvite', sum: 'Look up an invite', perm: 'public', res: o({ email: str(), role: ROLE, role_label: str(), expires_at: dt, organization: str(), invited_by: nul(str()) }) }],
  ['get /v1/auth/sso/start', { tag: 'Auth', id: 'startSso', sum: 'Start single sign-on', perm: 'public', desc: 'Redirects to the organization\'s OpenID Connect provider with PKCE. Find the organization by slug or by email domain.', q: [qp('org', str(), 'Organization slug.'), qp('email', str({ format: 'email' }), 'Work email, used to find the organization by domain.'), qp('origin', str(), 'Allowed app origin to return to.')], ok: 302, okd: 'Redirect to the identity provider.' }],
  ['get /v1/auth/sso/callback', { tag: 'Auth', id: 'ssoCallback', sum: 'Single sign-on callback', perm: 'public', desc: 'The identity provider returns here. Laissez verifies the ID token, provisions the member just in time and redirects to the app with a one-time code.', q: [qp('code', str(), 'Authorization code.'), qp('state', str(), 'State from the start request.'), qp('error', str(), 'Error from the provider.')], ok: 302, okd: 'Redirect to the app with a one-time code, or to an error page.' }],
  ['post /v1/auth/sso/exchange', { tag: 'Auth', id: 'exchangeSsoCode', sum: 'Exchange a sign-on code', perm: 'public', desc: 'Swaps the one-time code from the callback for a 12-hour session token. Codes expire after 2 minutes.', body: o({ 'code*': str({ minLength: 10 }) }), res: ref('SessionToken') }],
  ['post /v1/auth/logout', { tag: 'Auth', id: 'logout', sum: 'Sign out', perm: 'any', desc: 'Revokes the current session. With an API key this does nothing.', res: o({ signed_out: bool() }) }],
  ['post /v1/auth/invites/{token}/accept', { tag: 'Auth', id: 'acceptInvite', sum: 'Accept an invite', perm: 'session', desc: 'Joins the inviting organization and returns a new session for it.', res: ref('SessionToken') }],
  ['get /v1/sessions', { tag: 'Auth', id: 'listSessions', sum: 'List your sessions', perm: 'session', res: list(o({ id: uuid, method: str(), created_at: dt, last_seen_at: dt, expires_at: dt, user_agent: str(), organization: str(), current: bool() })) }],
  ['delete /v1/sessions/{id}', { tag: 'Auth', id: 'revokeSession', sum: 'Revoke a session', perm: 'session', idd: 'Session id.', res: o({ revoked: str() }) }],
  ['get /v1/passkeys', { tag: 'Auth', id: 'listPasskeys', sum: 'List your passkeys', perm: 'session', res: list(o({ id: str(), name: str(), alg: int(), transports: arr(str()), created_at: dt, last_used_at: nul(dt) })) }],
  ['post /v1/passkeys/options', { tag: 'Auth', id: 'passkeyOptions', sum: 'Start adding a passkey', perm: 'session', desc: 'Not available in sandboxes.', res: o({ challenge_id: uuid, options: anyJson('PublicKeyCredentialCreationOptions.') }) }],
  ['post /v1/passkeys/verify', { tag: 'Auth', id: 'addPasskey', sum: 'Finish adding a passkey', perm: 'session', body: o({ 'challenge_id*': uuid, 'credential*': anyJson('RegistrationResponse JSON.'), name: str({ maxLength: 60 }) }), ok: 201, res: o({ added: str() }) }],
  ['delete /v1/passkeys/{id}', { tag: 'Auth', id: 'removePasskey', sum: 'Remove a passkey', perm: 'session', idd: 'Passkey credential id.', desc: 'Your last passkey cannot be removed.', res: o({ removed: str() }), err: [422] }],
  ['post /v1/session/act-as', { tag: 'Auth', id: 'actAsTeammate', sum: 'Act as a sandbox teammate', perm: 'session', desc: 'Sandboxes only. Switch to a fictional teammate so you can try two-person approval alone. Send null to switch back.', body: o({ 'user_id*': nul(uuid) }), res: o({ acting_as: nul(uuid) }) }],
  ['post /v1/session/switch', { tag: 'Auth', id: 'switchOrganization', sum: 'Switch organization', perm: 'session', desc: 'Revokes the current session and returns one for another organization you belong to.', body: o({ 'workspace_id*': uuid }), res: ref('SessionToken') }],
  ['get /idp/.well-known/openid-configuration', { tag: 'Auth', id: 'demoIdpDiscovery', sum: 'Demo identity provider: discovery', perm: 'public', desc: 'OpenID Connect discovery for the fictional Aster & Vale workforce provider that sandboxes use for single sign-on.', res: anyJson('OpenID provider metadata.') }],
  ['get /idp/jwks', { tag: 'Auth', id: 'demoIdpJwks', sum: 'Demo identity provider: keys', perm: 'public', res: o({ keys: arr(anyJson('P-256 public JWK.')) }) }],
  ['get /idp/authorize', { tag: 'Auth', id: 'demoIdpAuthorize', sum: 'Demo identity provider: sign-in page', perm: 'public', desc: 'HTML page listing fictional people to sign in as.', q: [qp('client_id', str(), 'Demo client id.', true), qp('redirect_uri', str(), 'Laissez callback URL.', true), qp('response_type', en('code'), 'Always code.', true), qp('code_challenge', str(), 'PKCE challenge.', true), qp('code_challenge_method', en('S256'), 'Always S256.', true), qp('state', str(), 'Opaque state.'), qp('nonce', str(), 'ID token nonce.')], more: { 200: { description: 'HTML sign-in page.', content: { 'text/html': { schema: str() } } } }, okd: 'HTML sign-in page.' }],
  ['post /idp/authorize', { tag: 'Auth', id: 'demoIdpChoose', sum: 'Demo identity provider: choose a person', perm: 'public', form: true, body: o({ 'email*': str(), 'client_id*': str(), 'redirect_uri*': str(), state: str(), nonce: str(), code_challenge: str() }), ok: 302, okd: 'Redirect to the callback with a code.' }],
  ['post /idp/token', { tag: 'Auth', id: 'demoIdpToken', sum: 'Demo identity provider: token', perm: 'public', form: true, body: o({ 'client_id*': str(), 'client_secret*': str(), 'code*': str(), 'code_verifier*': str(), 'redirect_uri*': str(), grant_type: en('authorization_code') }), res: o({ id_token: str(), token_type: str(), expires_in: int() }) }],

  // Organization
  ['get /v1/me', { tag: 'Organization', id: 'getMe', sum: 'Who am I', perm: 'any', desc: 'For a person: the user, role, organization, other organizations and sandbox teammates. For an API key: the key actor and organization.', res: o({ user: o({ id: uuid, email: str(), name: str(), title: nul(str()), fictional: bool() }), actor: anyJson('Present for API keys.'), acting_as: nul(o({ id: uuid, name: str(), role: ROLE })), role: ROLE, role_label: str(), workspace: ref('Workspace'), organizations: arr(o({ workspace_id: uuid, name: str(), kind: str(), role: ROLE })), teammates: arr(o({ id: uuid, name: str(), title: str(), role: ROLE })) }) }],
  ['get /v1/workspace', { tag: 'Organization', id: 'getWorkspace', sum: 'Get the organization', perm: 'read', res: { allOf: [ref('Workspace'), o({ counts: o({ investors: int(), funds: int(), decisions: int(), settlements: int() }) })] } }],
  ['get /v1/metrics', { tag: 'Organization', id: 'getMetrics', sum: 'Organization metrics', perm: 'read', desc: 'Decision totals and allow rate, 14-day daily outcomes, top refusal reasons, settled value, credential reuse and credentials expiring in 30 days.', res: o({ totals: o({ decisions: int(), allowed: int(), denied: int(), frozen: int(), allow_rate: nul(num()) }), daily: arr(o({ day: date, outcome: OUTCOME, n: int() })), top_refusal_reasons: arr(o({ label: str(), n: int() })), settled_value: arr(o({ currency: str(), value: num(), n: int() })), credential_reuse: o({ investors_with_two_or_more_funds: int(), investors_with_allowed_orders: int(), rate: nul(num()) }), credential_reuse_network: int(), credentials_expiring_30d: int() }) }],
  ['get /v1/members', { tag: 'Organization', id: 'listMembers', sum: 'List members', perm: 'read', res: list(o({ id: uuid, name: str(), email: str(), title: nul(str()), fictional: bool(), last_login_at: nul(dt), role: ROLE, role_label: str(), created_at: dt }), { roles: arr(o({ id: ROLE, label: str() })) }) }],
  ['patch /v1/members/{id}', { tag: 'Organization', id: 'updateMember', sum: 'Change a member\'s role', perm: 'members:admin', idd: 'User id.', desc: 'An organization always keeps at least one administrator.', body: o({ 'role*': ROLE }), ex: { role: 'compliance' }, res: o({ user_id: uuid, role: ROLE }), err: [422] }],
  ['delete /v1/members/{id}', { tag: 'Organization', id: 'removeMember', sum: 'Remove a member', perm: 'members:admin', idd: 'User id.', desc: 'Removes the membership and revokes the member\'s sessions in this organization.', res: o({ removed: uuid }), err: [422] }],
  ['get /v1/invites', { tag: 'Organization', id: 'listInvites', sum: 'List invites', perm: 'members:admin', res: list(o({ id: uuid, email: str(), role: ROLE, created_at: dt, expires_at: dt, accepted_at: nul(dt) })) }],
  ['post /v1/invites', { tag: 'Organization', id: 'createInvite', sum: 'Invite a member', perm: 'members:admin', desc: 'Returns a single-use link that expires in 7 days.', body: o({ 'email*': str({ format: 'email', maxLength: 160 }), 'role*': ROLE }), ex: { email: 'aisha.rahman@astervale.example', role: 'compliance' }, ok: 201, res: o({ id: uuid, email: str(), role: ROLE, expires_at: dt, link: str(), note }) }],
  ['delete /v1/invites/{id}', { tag: 'Organization', id: 'revokeInvite', sum: 'Revoke an invite', perm: 'members:admin', idd: 'Invite id.', res: o({ revoked: uuid }) }],
  ['patch /v1/organization', { tag: 'Organization', id: 'updateOrganization', sum: 'Update organization settings', perm: 'members:admin', body: o({ name: str({ minLength: 2, maxLength: 80 }), brand_name: str({ minLength: 2, maxLength: 80 }), brand_color: str({ pattern: '^#[0-9a-fA-F]{6}$' }) }), res: o({ id: uuid, name: str(), brand_name: str(), brand_color: str() }) }],
  ['get /v1/sso', { tag: 'Organization', id: 'getSso', sum: 'Get single sign-on settings', perm: 'read', res: o({ org_slug: str(), redirect_uri: str(), start_url: str(), config: nul(o({ enabled: bool(), label: str(), issuer: str(), client_id: str(), email_domain: str(), default_role: ROLE, demo: bool(), has_secret: bool() })) }) }],
  ['put /v1/sso', { tag: 'Organization', id: 'configureSso', sum: 'Configure single sign-on', perm: 'members:admin', desc: 'Connects an OpenID Connect provider. The client secret is sealed with AES-GCM at rest. Not available in sandboxes, which use the demo provider.', body: o({ 'enabled*': bool(), 'issuer*': str({ format: 'uri' }), 'client_id*': str({ minLength: 3, maxLength: 200 }), client_secret: str({ minLength: 8, maxLength: 500 }), 'email_domain*': str({ pattern: '^[a-z0-9.-]+\\.[a-z]{2,}$' }), default_role: { ...ROLE, default: 'auditor' }, label: str({ maxLength: 80 }) }), res: o({ saved: bool() }), err: [409, 422] }],

  // Clients
  ['get /v1/investors', { tag: 'Clients', id: 'listInvestors', sum: 'List clients', perm: 'read', desc: 'Every client with its credential, classifications, holdings and credential status.', res: list(ref('Investor')), rex: { data: [INVESTOR_EX] } }],
  ['post /v1/investors', { tag: 'Clients', id: 'createInvestor', sum: 'Add a client', perm: 'clients:write', desc: 'Residence must be a supported jurisdiction and booking_center an existing booking center. A US residence makes the client a U.S. person.', body: o({ 'name*': str({ minLength: 2, maxLength: 120 }), 'kind*': d(str({ minLength: 2, maxLength: 60 }), 'Investor type, for example Individual or Single-family office.'), 'residence*': d(str({ minLength: 2, maxLength: 10 }), 'Jurisdiction code from GET /v1/jurisdictions.'), 'city*': str({ minLength: 1, maxLength: 80 }), 'booking_center*': d(str({ minLength: 2, maxLength: 10 }), 'Booking center id from GET /v1/booking-centers.'), us_person: bool({ default: false }), wallet: str({ maxLength: 80 }), email: str({ format: 'email', maxLength: 160 }) }), ex: { name: 'Harbour Lane Capital Pte. Ltd.', kind: 'Single-family office', residence: 'SG', city: 'Singapore', booking_center: 'SG' }, ok: 201, res: ref('Investor'), err: [422] }],
  ['get /v1/investors/{id}', { tag: 'Clients', id: 'getInvestor', sum: 'Get a client', perm: 'read', idd: 'Investor id.', idx: 'lumen', desc: 'The client with holdings and holder status per fund, the 20 most recent decisions and credentials.', res: { allOf: [ref('Investor'), o({ holdings_detail: arr(o({ ticker: str(), fund: str(), units: num(), value: nul(num()), currency: str(), since: date, lockup_ends: nul(date), status: str(), reason: str() })), recent_decisions: arr(ref('DecisionSummary')), credentials: arr(ref('Credential')) })] } }],

  // Credentials
  ['post /v1/credentials', { tag: 'Credentials', id: 'issueCredential', sum: 'Issue a credential', perm: 'clients:write', desc: 'Checks each classification against its legal threshold, then issues a credential with a network passport number (LZ-XXXX-XXXX-XXXX). Replaces the client\'s active credential. Nothing is issued if any classification fails (422 threshold_not_met, with per-class results in detail).', body: o({ 'investor_id*': str(), valid_months: int({ minimum: 1, maximum: 24, default: 12 }), 'classifications*': arr(o({ 'class_code*': d(str(), 'From GET /v1/investor-classes.'), evidence: map(t(['number', 'boolean']), 'Figures the threshold test reads, for example net_assets_sgd and opt_in.'), evidence_ref: str({ maxLength: 200 }) }), { maxItems: 10 }) }), ex: { investor_id: 'meitan', valid_months: 12, classifications: [{ class_code: 'HK_PI', evidence: { portfolio_hkd: 9500000 }, evidence_ref: 'Custody statement 2026-09-30' }] }, ok: 201, res: ref('CredentialIssued'), err: [422] }],
  ['get /v1/credentials', { tag: 'Credentials', id: 'listCredentials', sum: 'List credentials', perm: 'read', q: [qp('expiring_within', int({ minimum: 0, maximum: 365 }), 'Only active credentials that expire within this many days.')], res: list(ref('Credential')) }],
  ['post /v1/credentials/{id}/revoke', { tag: 'Credentials', id: 'revokeCredential', sum: 'Revoke a credential', perm: 'clients:write', idd: 'Credential id.', idx: 'LP-SG-0419-2207', desc: 'Holders keep their units and move to redemption-only. Emits credential.revoked and holder.status_changed.', body: o({ reason: str({ maxLength: 300 }) }), res: o({ revoked: str(), investor_id: str(), revoked_at: dt }) }],

  // Network
  ['post /v1/credential-shares', { tag: 'Network', id: 'requestCredentialShare', sum: 'Request a credential share', perm: 'clients:write', desc: 'Asks to rely on another distributor\'s credential by its passport number. The client consents on a Laissez page; consent links expire in 14 days. In sandboxes the consent_url is returned so you can act as the client.', body: o({ 'lzid*': str({ pattern: '^LZ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$' }), 'purpose*': str({ minLength: 3, maxLength: 300 }), 'booking_center*': str({ minLength: 2, maxLength: 10 }) }), ex: { lzid: 'LZ-7K2M-9QX4-PA3D', purpose: 'Subscription to TWLF from our Singapore desk', booking_center: 'SG' }, ok: 201, res: o({ share: ref('CredentialShare'), consent_url: nul(str()), delivery: str(), consent_expires_in_days: int() }), err: [409, 422] }],
  ['get /v1/credential-shares', { tag: 'Network', id: 'listCredentialShares', sum: 'List credential shares', perm: 'read', res: o({ incoming: arr(ref('CredentialShare')), outgoing: arr(ref('CredentialShare')) }) }],
  ['post /v1/credential-shares/{id}/revoke', { tag: 'Network', id: 'revokeCredentialShare', sum: 'Revoke a credential share', perm: 'clients:write', idd: 'Share id.', desc: 'Either side can revoke. The issuer can revoke every recipient at once with all_recipients. Relying clients move to redemption-only.', body: o({ 'reason*': str({ minLength: 3, maxLength: 300 }), all_recipients: bool({ default: false }) }), res: o({ revoked: arr(str()), note }), err: [409] }],
  ['get /v1/network/demo-ids', { tag: 'Network', id: 'listDemoPassports', sum: 'List demo passport numbers', perm: 'read', desc: 'Sandboxes only: fictional clients of Halden & Co. on the network that you can request.', res: o({ issuer: str(), data: arr(o({ lzid: str(), name: str(), kind: str(), residence: str(), city: str(), classifications: arr(str()), expires_on: date, suggested_booking_center: str(), share_status: nul(str()) })), note }) }],
  ['get /v1/consent/{token}', { tag: 'Network', id: 'getConsent', sum: 'Read a consent request', perm: 'public', desc: 'Public consent page data. The lz_cns_ token in the link is the secret. 40 requests per minute per network.', res: o({ share: anyJson('Share status and dates.'), requester: anyJson('Receiving organization and booking center.'), issuer: o({ name: str() }), investor: anyJson('Name, type and residence.'), credential: anyJson('Passport number and dates.'), classifications: arr(anyJson('Classification with label and rule.')), terms: anyJson('Reliance terms.'), shared: arr(str()), not_shared: arr(str()), sandbox: bool() }), err: [429] }],
  ['post /v1/consent/{token}', { tag: 'Network', id: 'answerConsent', sum: 'Approve or decline a share', perm: 'public', desc: 'The client signs with their name. Approving creates the client record at the receiving organization.', body: o({ 'decision*': en('approve', 'decline'), 'name*': str({ minLength: 2, maxLength: 120 }) }), res: o({ status: en('active', 'declined'), message: str(), share_id: str() }), err: [409, 410, 429] }],
  ['post /v1/consent/{token}/withdraw', { tag: 'Network', id: 'withdrawConsent', sum: 'Withdraw consent', perm: 'public', body: o({ name: str({ maxLength: 120 }) }), res: o({ status: en('revoked'), message: str() }), err: [409, 429] }],

  // Funds
  ['get /v1/funds', { tag: 'Funds', id: 'listFunds', sum: 'List funds', perm: 'read', res: list(ref('Fund')), rex: { data: [FUND_EX] } }],
  ['post /v1/funds', { tag: 'Funds', id: 'createFund', sum: 'Create a fund', perm: 'funds:write', desc: 'Every jurisdiction in distribution needs a launch rule pack. A Regulation S fund cannot list US. Policy version 1 is published on creation.', body: o({ 'ticker*': str({ pattern: '^[A-Z]{3,6}$' }), 'name*': str({ minLength: 3, maxLength: 140 }), 'domicile*': str({ minLength: 2, maxLength: 80 }), 'structure*': str({ minLength: 3, maxLength: 160 }), 'currency*': en('USD', 'EUR'), 'nav*': num({ exclusiveMinimum: 0 }), 'reg_s*': bool(), 'min_subscription*': num({ minimum: 0 }), holder_cap: nul(int({ exclusiveMinimum: 0 })), lockup_months: nul(int({ exclusiveMinimum: 0 })), 'assets*': arr(str({ minLength: 2, maxLength: 20 }), { minItems: 1, maxItems: 8 }), 'chains*': arr(str({ minLength: 2, maxLength: 40 }), { minItems: 1, maxItems: 8 }), 'issuer*': str({ minLength: 2, maxLength: 120 }), 'distribution*': DIST, cutoff_time: str({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', default: '16:00' }), cutoff_tz: d(str({ minLength: 1, maxLength: 60, default: 'America/New_York' }), 'IANA time zone.'), dealing_frequency: en('daily', 'monthly', 'quarterly'), notice_days: int({ minimum: 0, maximum: 365 }), gate_pct: nul(num({ exclusiveMinimum: 0, maximum: 100 })), share_class_type: en('distributing', 'accumulating') }), ex: { ticker: 'HRBF', name: 'Harbour Short Duration Fund, Tokenized Class A', domicile: 'Ireland', structure: 'UCITS short duration bond fund', currency: 'USD', nav: 10, reg_s: true, min_subscription: 250000, assets: ['USDC'], chains: ['Base'], issuer: 'Harbour Funds (fictional)', distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'CH', accepts: ['CH_PRO'] }] }, ok: 201, res: ref('Fund'), err: [409, 422] }],
  ['get /v1/funds/{ticker}', { tag: 'Funds', id: 'getFund', sum: 'Get a fund', perm: 'read', res: ref('Fund'), rex: FUND_EX }],
  ['get /v1/funds/{ticker}/register', { tag: 'Funds', id: 'getFundRegister', sum: 'Get the register', perm: 'read', desc: 'Holders in this organization with units, value and holder status (eligible, redemption-only or frozen).', res: o({ fund: str(), holder_cap: nul(int()), total_holders_of_record: int(), sandbox_holders: int(), data: arr(o({ investor_id: str(), name: str(), residence: str(), units: num(), value: num(), since: date, status: en('eligible', 'redemption-only', 'frozen'), reason: str() })) }) }],

  // Policy
  ['post /v1/funds/{ticker}/policy/preview', { tag: 'Policy', id: 'previewPolicy', sum: 'Preview a policy change', perm: 'read', desc: 'Shows which holders would change status, and the value affected, without saving anything.', body: ref('PolicyInput'), ex: { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'HK', accepts: ['HK_PI'] }] }, res: ref('PolicyImpact'), err: [422] }],
  ['post /v1/funds/{ticker}/policy/changes', { tag: 'Policy', id: 'proposePolicyChange', sum: 'Propose a policy change', perm: 'funds:write', desc: 'Saves a draft with its impact. A different signed-in person must approve it. API keys can propose but never approve.', body: ref('PolicyInput'), ex: { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'HK', accepts: ['HK_PI'] }], min_subscription: 100000 }, ok: 201, res: o({ id: str(), status: en('draft'), ticker: str(), proposed_by: str(), impact: ref('PolicyImpact') }), err: [422] }],
  ['post /v1/funds/{ticker}/policy/backtest', { tag: 'Policy', id: 'backtestPolicy', sum: 'Backtest a policy change', perm: 'read', desc: 'Re-runs up to 120 recent decisions from their snapshots with only the fund policy swapped and lists the ones that would flip.', body: { allOf: [ref('PolicyInput'), o({ days: int({ minimum: 1, maximum: 365, default: 90 }) })] }, res: o({ fund: str(), window_days: int(), decisions_checked: int(), truncated: bool(), flips: arr(o({ decision_id: str(), created_at: dt, investor: str(), action: ACTION, amount: num(), from: OUTCOME, to: OUTCOME, reason: str() })), note }), err: [422] }],
  ['get /v1/policy-changes', { tag: 'Policy', id: 'listPolicyChanges', sum: 'List policy changes', perm: 'read', res: list(ref('PolicyChange')) }],
  ['post /v1/policy-changes/{id}/approve', { tag: 'Policy', id: 'approvePolicyChange', sum: 'Approve a policy change', perm: 'policy:approve', idd: 'Policy change id.', desc: 'Signed-in people only, and never the proposer. Publishes a new policy version and emits policy.published. Holders who lose eligibility move to redemption-only.', res: o({ id: str(), status: en('published'), ticker: str(), policy_version: int(), proposed_by: str(), approved_by: str() }), err: [409] }],
  ['post /v1/policy-changes/{id}/reject', { tag: 'Policy', id: 'rejectPolicyChange', sum: 'Reject a policy change', perm: 'policy:approve', idd: 'Policy change id.', body: o({ reason: str({ maxLength: 500 }) }), res: o({ id: str(), status: en('rejected'), rejected_by: str() }), err: [409] }],

  // Fund operations
  ['get /v1/funds/{ticker}/lifecycle', { tag: 'Fund operations', id: 'getFundLifecycle', sum: 'Get fund lifecycle', perm: 'read', desc: 'Terms, NAV series, dealing clock and next dealing date, liquidity and gate usage, accruals, distributions and pending redemption notices.', res: o({ ticker: str(), name: str(), currency: str(), as_of: date, terms: ref('FundTerms'), nav: anyJson('Current NAV, latest strike and series.'), dealing: anyJson('Fund clock, cut-off and next dealing date.'), liquidity: anyJson('AUM, redemptions this period and gate.'), accrued: anyJson('Accrued, unpaid income.'), distributions: arr(anyJson('Distribution.')), notices: o({ pending: int(), pending_units: num(), data: arr(ref('RedemptionNotice')) }) }) }],
  ['patch /v1/funds/{ticker}/terms', { tag: 'Fund operations', id: 'updateFundTerms', sum: 'Update dealing terms', perm: 'funds:write', desc: 'New terms apply to orders evaluated from now on. Emits fund.terms_updated.', body: ref('FundTermsInput'), ex: { dealing_frequency: 'monthly', notice_days: 30, gate_pct: 10 }, res: o({ ticker: str(), terms: ref('FundTerms'), next_dealing_date: date, note }), err: [422] }],
  ['post /v1/funds/{ticker}/terms', { tag: 'Fund operations', id: 'updateFundTermsPost', sum: 'Update dealing terms (POST)', perm: 'funds:write', desc: 'Same as PATCH, for clients that cannot send PATCH.', body: ref('FundTermsInput'), res: o({ ticker: str(), terms: ref('FundTerms'), next_dealing_date: date, note }), err: [422] }],
  ['post /v1/funds/{ticker}/nav', { tag: 'Fund operations', id: 'strikeNav', sum: 'Strike a NAV', perm: 'funds:write', desc: 'Records the NAV for a date (today by default, at most 400 days back). A move of more than 2% from the previous strike needs confirm: true. Emits nav.struck.', body: o({ 'nav*': num({ exclusiveMinimum: 0, maximum: 1000000 }), date: ymd, daily_yield_bps: nul(num({ minimum: -1000, maximum: 5000 })), confirm: bool() }), ex: { nav: 1.0002, date: '2026-10-01', daily_yield_bps: 5.1 }, ok: 201, res: o({ ticker: str(), date: date, nav: num(), previous: nul(o({ date: date, nav: num() })), change_bps: nul(num()), daily_yield_bps: nul(num()), latest: bool(), replaced: bool() }), err: [409, 422] }],
  ['post /v1/funds/{ticker}/accruals/run', { tag: 'Fund operations', id: 'runAccruals', sum: 'Run daily accruals', perm: 'funds:write', desc: 'Accrues one day of income per holder. Running again for the same date changes nothing and returns 200.', body: o({ date: ymd }), ok: 201, res: o({ ticker: str(), date: date, inserted: int(), amount: num(), currency: str(), skipped: str(), note }), more: { 200: { description: 'Already accrued for that date.' } }, err: [422] }],
  ['post /v1/funds/{ticker}/distributions', { tag: 'Fund operations', id: 'payDistribution', sum: 'Pay a distribution', perm: 'funds:write', desc: 'Pays unpaid accruals for a period: reinvested as units for current holders, cash for holders who fully redeemed. Emits distribution.paid.', body: o({ 'period_start*': ymd, 'period_end*': ymd }), ex: { period_start: '2026-09-01', period_end: '2026-09-30' }, ok: 201, res: ref('Distribution'), err: [409, 422] }],
  ['get /v1/funds/{ticker}/distributions', { tag: 'Fund operations', id: 'listDistributions', sum: 'List distributions', perm: 'read', res: o({ ticker: str(), currency: str(), share_class_type: str(), data: arr(ref('Distribution')) }) }],
  ['post /v1/redemption-notices', { tag: 'Fund operations', id: 'fileRedemptionNotice', sum: 'File a redemption notice', perm: 'orders:write', desc: 'For funds with a notice period. Returns the dealing date and warnings about lock-ups and gates. Emits redemption_notice.filed.', body: o({ 'investor_id*': str({ minLength: 1 }), 'ticker*': str({ minLength: 1 }), 'units*': num({ exclusiveMinimum: 0 }) }), ex: { investor_id: 'sorell', ticker: 'AGPC', units: 250000 }, ok: 201, res: ref('RedemptionNotice'), err: [409, 422] }],
  ['get /v1/redemption-notices', { tag: 'Fund operations', id: 'listRedemptionNotices', sum: 'List redemption notices', perm: 'read', q: [qp('ticker', str(), 'Fund ticker.'), STATUS(['pending', 'executed', 'cancelled'], null, 'notice'), qp('investor_id', str(), 'Investor id.')], res: list(ref('RedemptionNotice')) }],
  ['delete /v1/redemption-notices/{id}', { tag: 'Fund operations', id: 'cancelRedemptionNotice', sum: 'Cancel a redemption notice', perm: 'orders:write', idd: 'Notice id.', res: o({ id: str(), status: en('cancelled') }), err: [409] }],

  // Documents
  ['get /v1/funds/{ticker}/documents', { tag: 'Documents', id: 'listFundDocuments', sum: 'List fund documents', perm: 'read', res: o({ ticker: str(), current: int(), superseded: int(), data: arr(ref('Document')) }) }],
  ['post /v1/funds/{ticker}/documents', { tag: 'Documents', id: 'publishFundDocument', sum: 'Publish a fund document', perm: 'funds:write', desc: 'Publishes a new version and supersedes the previous one of the same type and jurisdiction. Required documents must be acknowledged before the next subscription or incoming transfer; redemptions are never blocked. Emits document.published.', body: o({ 'doc_type*': str({ pattern: '^[a-z][a-z0-9_]{1,39}$' }), 'title*': str({ minLength: 3, maxLength: 140 }), jurisdiction: nul(str({ maxLength: 12 })), audience: { ...en('all', 'retail', 'professional'), default: 'all' }, 'content*': str({ minLength: 50, maxLength: 200000 }), required: d(bool(), 'Defaults to true for every type except factsheet.') }), ex: { doc_type: 'offering_memorandum', title: 'TWLF offering memorandum, October 2026', audience: 'professional', content: 'Tidewell Treasury Liquidity Fund. This memorandum describes the fund, its risks and its dealing terms...' }, ok: 201, res: { allOf: [ref('Document'), o({ supersedes: nul(str()), holders_to_acknowledge: arr(o({ investor_id: str(), name: str() })), note })] }, err: [409, 422] }],
  ['get /v1/documents/{id}', { tag: 'Documents', id: 'getDocument', sum: 'Get a document', perm: 'read', idd: 'Document id.', res: { allOf: [ref('Document'), o({ content: str(), acknowledgments: arr(o({ investor_id: str(), name: str(), sha256: str(), method: str(), signed_name: str(), acknowledged_at: dt, matches: bool() })), versions: arr(o({ id: str(), version: int(), published_at: dt, superseded_at: nul(dt), sha256: str(), status: str() })) })] } }],
  ['post /v1/documents/{id}/acknowledge', { tag: 'Documents', id: 'acknowledgeDocument', sum: 'Record an acknowledgment', perm: 'clients:write', idd: 'Document id.', desc: 'Operations attests that the client acknowledged this exact version. The evidence digest binds who, for whom, which bytes and when.', body: o({ 'investor_id*': str({ minLength: 1 }), 'signed_name*': str({ minLength: 2, maxLength: 140 }), method: { ...en('ops_attested'), default: 'ops_attested' } }), ex: { investor_id: 'lumen', signed_name: 'Wei Lin Tan' }, ok: 201, res: o({ document_id: str(), investor_id: str(), investor: str(), title: str(), version: int(), sha256: str(), method: str(), signed_name: str(), evidence: str(), acknowledged_at: dt }), err: [409] }],
  ['get /v1/funds/{ticker}/acknowledgments', { tag: 'Documents', id: 'getAcknowledgmentMatrix', sum: 'Acknowledgment matrix', perm: 'read', desc: 'Which clients have acknowledged which current documents, and who is ready to subscribe.', res: o({ ticker: str(), as_of: date, documents: arr(ref('Document')), investors: arr(o({ id: str(), name: str(), residence: str(), holder: bool(), units: num(), ready: bool(), offered: bool() })), cells: anyJson('Per investor, per document status.'), summary: o({ required_acknowledgments: int(), acknowledged: int(), missing: int(), outdated: int(), ready_investors: int(), investors: int() }) }) }],

  // Decisions
  ['post /v1/decisions', { tag: 'Decisions', id: 'createDecision', sum: 'Create a decision', perm: 'orders:write', desc: 'Evaluates a subscription, transfer or redemption against the credential, fund policy, residence law, booking-center licence, documents, fund terms and global screens. Persisted decisions return 201 with a signed receipt and, when allowed, settle_by (15 minutes). Send persist: false for a dry run (200). what_ifs make the decision hypothetical, so it cannot settle.', body: o({ 'action*': ACTION, 'investor_id*': str({ minLength: 1 }), 'fund*': d(str({ minLength: 1 }), 'Fund ticker.'), 'amount*': d(money, 'Amount in fund currency.'), 'settle_with*': d(str({ minLength: 1, maxLength: 20 }), 'Settlement asset, for example USDC.'), counterparty_id: d(str(), 'Required for transfers: the receiving investor.'), what_ifs: arr(WHAT_IF, { maxItems: 6, default: [] }), persist: bool({ default: true }) }), ex: { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 250000, settle_with: 'USDC' }, ok: 201, res: ref('Decision'), rex: DECISION_EX, more: { 200: { description: 'Dry run (persist: false). Nothing was recorded.', content: json(ref('Decision')) } }, err: [422] }],
  ['get /v1/decisions', { tag: 'Decisions', id: 'listDecisions', sum: 'List decisions', perm: 'read', desc: 'Newest first.', q: [LIMIT(200, 100), qp('fund', str(), 'Fund ticker.'), qp('investor_id', str(), 'Investor or counterparty id.')], res: list(ref('DecisionSummary')) }],
  ['get /v1/decisions/{id}', { tag: 'Decisions', id: 'getDecision', sum: 'Get a decision', perm: 'read', idd: 'Decision id.', idx: DEC_ID, desc: 'The full decision with checks, snapshot, the acting person or key, settlement status and the signed receipt.', res: ref('DecisionRecord') }],
  ['get /v1/decisions/{id}/replay', { tag: 'Decisions', id: 'replayDecision', sum: 'Replay a decision', perm: 'read', idd: 'Decision id.', idx: DEC_ID, desc: 'Re-runs the engine on the snapshot stored with the decision and reports whether the outcome and input hash reproduce.', res: o({ decision_id: str(), decided_at: dt, reproduced: bool(), stored_outcome: OUTCOME, replayed_outcome: OUTCOME, stored_hash: str(), replayed_hash: str(), rule_packs: arr(str()), stored_rule_packs: arr(str()), headline: str(), dealing_date: nul(date), checks: arr(ref('Check')), note }), rex: { decision_id: DEC_ID, decided_at: '2026-10-02T06:22:07.000Z', reproduced: true, stored_outcome: 'ALLOW', replayed_outcome: 'ALLOW', stored_hash: HASH, replayed_hash: HASH, rule_packs: PACKS, stored_rule_packs: PACKS, headline: DECISION_EX.headline, dealing_date: '2026-10-02', checks: CHECKS_EX.slice(0, 2), note: 'Replayed from the inputs stored with the decision.' }, err: [409] }],
  ['post /v1/evaluate/as-of', { tag: 'Decisions', id: 'evaluateAsOf', sum: 'Evaluate as of a past date', perm: 'read', desc: 'Evaluates an order with the fund policy, credentials and rule packs as they stood on as_of. Holdings, documents, screening and liquidity are read as they are today. Never persisted.', body: o({ 'action*': ACTION, 'investor_id*': str(), 'fund*': str(), 'amount*': money, 'settle_with*': str({ maxLength: 20 }), counterparty_id: str(), 'as_of*': ymd }), ex: { action: 'subscribe', investor_id: 'reyes', fund: 'AGPC', amount: 100000, settle_with: 'USDC', as_of: '2026-06-30' }, res: { allOf: [ref('Decision'), o({ as_of: date, policy_version_used: int(), policy_version_detail: anyJson('Version, effective time and publisher.'), credential_used: anyJson('Credential in force on as_of.') })] }, err: [422] }],
  ['post /v1/eligibility/bulk', { tag: 'Decisions', id: 'bulkEligibility', sum: 'Check eligibility in bulk', perm: 'read', desc: 'Checks up to 200 prospective clients against every fund (or the listed ones), assuming each declared class is verified today. Documents are not checked.', body: o({ 'rows*': arr(o({ 'name*': str({ minLength: 1, maxLength: 120 }), kind: str({ default: 'Corporate' }), 'residence*': str(), 'booking_center*': str(), us_person: bool({ default: false }), classes: arr(str(), { default: [] }) }), { minItems: 1, maxItems: 200 }), funds: arr(str()) }), ex: { rows: [{ name: 'Harbour Lane Capital', residence: 'SG', booking_center: 'SG', classes: ['SG_AI'] }], funds: ['TWLF', 'NMEL'] }, res: o({ funds: arr(str()), data: arr(o({ row: int(), name: str(), residence: str(), screening: nul(anyJson('Potential sanctions match.')), results: arr(o({ fund: str(), outcome: OUTCOME, reason: str(), binding: arr(str()) })) })), note }) }],
  ['get /v1/signing-key', { tag: 'Decisions', id: 'getSigningKey', sum: 'Get the receipt signing key', perm: 'public', desc: 'The Ed25519 public key that signs decision receipts.', res: o({ alg: en('Ed25519'), key: anyJson('Public JWK.') }), err: [501] }],
  ['post /v1/receipts/verify', { tag: 'Decisions', id: 'verifyReceipt', sum: 'Verify a decision receipt', perm: 'public', desc: 'Checks a receipt and its signature. Anyone can call this, so a regulator can verify a decision without an account.', body: o({ 'receipt*': ref('Receipt'), 'signature*': str({ minLength: 10 }) }), ex: { receipt: RECEIPT_EX, signature: DECISION_EX.signature }, res: o({ valid: bool(), message: str() }) }],

  // Settlements
  ['post /v1/settlements', { tag: 'Settlements', id: 'createSettlement', sum: 'Settle a decision', perm: 'orders:write', desc: 'Re-checks the order against current state, then settles both legs atomically. With on-chain settlement (version 2026-10-02) it returns 202 with status pending: poll GET /v1/settlements/{id} or wait for settlement.completed. Version 2026-10-01 always simulates and returns 201. Transfers wait for an approved Travel Rule message (409 travel_rule_pending).', body: o({ 'decision_id*': str({ minLength: 1 }) }), ex: { decision_id: DEC_ID }, ok: 201, okd: 'Settled (simulated).', res: ref('SettlementCreated'), rex: { id: STL_ID, decision_id: DEC_ID, status: 'settled', units: 250000, fund: 'TWLF', simulated: true, chain: null, steps: [{ step: 'decision_signed', at: '2026-10-02T06:23:00.200Z' }, { step: 'cash_locked', at: '2026-10-02T06:23:12.000Z', block: 1 }, { step: 'atomic_swap', at: '2026-10-02T06:23:12.000Z', block: 1 }, { step: 'final', at: '2026-10-02T06:36:00.000Z' }] }, more: { 202: { description: 'Queued on chain. Poll until settled or reverted.', content: json(ref('SettlementCreated'), { id: STL_ID, decision_id: DEC_ID, status: 'pending', units: 250000, fund: 'TWLF', simulated: false, chain: { job_id: 'cj_P4T8M2QZ6K', status: 'queued' }, poll: `/v1/settlements/${STL_ID}` }) } }, err: [409, 502] }],
  ['get /v1/settlements', { tag: 'Settlements', id: 'listSettlements', sum: 'List settlements', perm: 'read', desc: 'The 100 most recent.', res: list(ref('Settlement')) }],
  ['get /v1/settlements/{id}', { tag: 'Settlements', id: 'getSettlement', sum: 'Get a settlement', perm: 'read', idd: 'Settlement id.', idx: STL_ID, res: ref('Settlement') }],

  // Screening
  ['get /v1/sanctions/sources', { tag: 'Screening', id: 'listSanctionsSources', sum: 'List sanctions lists', perm: 'read', desc: 'Each list with its entry count, last load and freshness. Daily lists are stale after 36 hours.', res: list(o({ source: str(), name: str(), url: str(), status: str(), error: nul(str()), entries: int(), last_fetched_at: nul(dt), last_published: nul(str()), age_hours: nul(num()), static: bool(), fresh: bool() }), { total_entries: int(), matching: anyJson('Method, thresholds and refresh time.') }) }],
  ['post /v1/screening', { tag: 'Screening', id: 'screenName', sum: 'Screen a name', perm: 'read', desc: 'Trigram similarity against every loaded list. Candidates at or above the threshold would hold an order unless already marked a false positive.', body: o({ 'name*': str({ minLength: 2, maxLength: 200 }) }), ex: { name: 'Qamar Holdings Ltd' }, res: o({ name: str(), normalized: str(), result: en('clear', 'near_miss', 'potential_match'), threshold: num(), near_miss_floor: num(), candidates: arr(o({ source: str(), source_uid: str(), matched_name: str(), primary_name: str(), is_alias: bool(), programs: nul(str()), entry_type: nul(str()), country: nul(str()), listed_on: nul(str()), score: num(), would_hold: bool(), prior_decision: nul(str()), prior_hit_id: nul(str()) })), match: nul(anyJson('First holding candidate, for older clients.')) }), err: [422] }],
  ['get /v1/screening-list', { tag: 'Screening', id: 'listDemoScreeningEntries', sum: 'List demo screening entries', perm: 'read', desc: 'The fictional LAISSEZ-TEST entries used in demos. Not real designations.', res: list(o({ name: str(), program: str(), note: str() })) }],
  ['get /v1/screening-hits', { tag: 'Screening', id: 'listScreeningHits', sum: 'List screening hits', perm: 'read', q: [STATUS(['open', 'false_positive', 'confirmed', 'all'], 'open', 'hit')], res: list(ref('ScreeningHit'), { counts: map(int(), 'Hits per status.'), threshold: num() }) }],
  ['post /v1/screening-hits/{id}/decide', { tag: 'Screening', id: 'decideScreeningHit', sum: 'Decide a screening hit', perm: 'compliance:write', idd: 'Hit id.', desc: 'Marks an open hit as a false positive or a confirmed match and queues a monitoring run.', body: o({ 'status*': en('false_positive', 'confirmed'), note: str({ maxLength: 1000 }) }), ex: { status: 'false_positive', note: 'Different date of birth and nationality.' }, res: { allOf: [ref('ScreeningHit'), o({ monitoring: en('queued') })] }, err: [409] }],

  // Monitoring
  ['get /v1/work-items', { tag: 'Monitoring', id: 'listWorkItems', sum: 'List work items', perm: 'read', desc: 'The compliance work queue, highest severity first.', q: [STATUS(['open', 'done', 'dismissed', 'all'], 'open', 'item')], res: list(ref('WorkItem'), { open_counts: map(int(), 'Open items per severity.') }) }],
  ['post /v1/work-items/{id}/resolve', { tag: 'Monitoring', id: 'resolveWorkItem', sum: 'Resolve a work item', perm: 'work:write', idd: 'Work item id.', body: o({ 'status*': en('done', 'dismissed'), note: str({ maxLength: 1000 }) }), ex: { status: 'done', note: 'Renewed credential LP-US-3391-7720.' }, res: o({ id: str(), kind: str(), title: str(), status: str(), resolved_at: dt, resolved_by: str() }), err: [409] }],
  ['post /v1/monitoring/run', { tag: 'Monitoring', id: 'runMonitoring', sum: 'Run monitoring now', perm: 'compliance:write', desc: 'Re-checks every holder, records status changes, opens and closes work items and emits holder.status_changed.', res: o({ run_id: int(), holders_checked: int(), changes: int(), items_opened: int(), items_closed: int() }) }],
  ['get /v1/monitoring', { tag: 'Monitoring', id: 'getMonitoring', sum: 'Get monitoring state', perm: 'read', res: o({ runs: arr(o({ id: int(), trigger: str(), started_at: dt, finished_at: nul(dt), holders_checked: int(), changes: int(), items_opened: int(), duration_ms: nul(int()) })), holders: arr(o({ investor_id: str(), ticker: str(), status: en('eligible', 'redemption-only', 'frozen'), reason: str(), updated_at: dt, investor_name: str(), fund_name: str() })), counts: map(int(), 'Holders per status.'), last_run: nul(anyJson('Most recent run.')) }) }],

  // Rule packs
  ['get /v1/rule-packs', { tag: 'Rule packs', id: 'listRulePacks', sum: 'List rule packs', perm: 'public', desc: 'Every rule pack version with its status and effective window.', res: list(o({ id: str(), version: str(), jurisdiction: str(), status: str(), summary: str(), effective_from: nul(date), effective_to: nul(date), approved_by: nul(str()), created_at: dt })), rex: { data: [{ id: 'SG/eligibility', version: '2026.09.0', jurisdiction: 'SG', status: 'active', summary: 'Accredited investor (SFA s4A) with opt-in; restricted scheme offers (SFA s305).', effective_from: '2026-09-01', effective_to: null, approved_by: 'pending counsel review', created_at: '2026-09-01T00:00:00.000Z' }] } }],
  ['get /v1/jurisdictions', { tag: 'Rule packs', id: 'listJurisdictions', sum: 'List jurisdictions', perm: 'public', res: list(anyJson('Jurisdiction code and name.')) }],
  ['get /v1/investor-classes', { tag: 'Rule packs', id: 'listInvestorClasses', sum: 'List investor classes', perm: 'public', desc: 'Class codes such as SG_AI and HK_PI with their thresholds and citations.', res: list(anyJson('Investor class.')) }],
  ['get /v1/booking-centers', { tag: 'Rule packs', id: 'listBookingCenters', sum: 'List booking centers', perm: 'public', res: list(anyJson('Booking center with licence and the class it requires.')) }],
  ['get /v1/reg-publications', { tag: 'Rule packs', id: 'listRegPublications', sum: 'List regulator publications', perm: 'read', desc: 'The regulatory feed, newest first, with the latest rule draft for each publication.', q: [qp('relevant', bool(), 'Only publications marked relevant (true) or not (false).'), qp('regulator', str(), 'Regulator code, for example MAS.')], res: list(o({ id: str(), regulator: str(), jurisdiction: str(), title: str(), url: str(), published_at: nul(dt), summary: nul(str()), relevant: bool(), topics: arr(str()), fetched_at: dt, has_excerpt: bool(), draft_id: nul(str()), draft_status: nul(str()) }), { newest_fetched_at: nul(dt), total: int(), relevant: int(), agent_enabled: bool(), agent_note: nul(str()) }) }],
  ['post /v1/reg-publications/{id}/draft', { tag: 'Rule packs', id: 'draftFromPublication', sum: 'Draft a rule change from a publication', perm: 'compliance:write', idd: 'Publication id.', desc: 'The drafting agent reads the publication and proposes a structured rule-pack change with citations. 10 drafts per hour per organization.', ok: 201, res: { allOf: [ref('RuleDraft'), o({ publication_id: str() })] }, err: [409, 422, 501, 502] }],
  ['post /v1/rule-drafts', { tag: 'Rule packs', id: 'createRuleDraft', sum: 'Draft a rule change from text', perm: 'compliance:write', body: o({ 'source_text*': str({ minLength: 40, maxLength: 20000 }), source_url: str({ format: 'uri' }), jurisdiction: str({ maxLength: 10 }) }), ok: 201, res: ref('RuleDraft'), err: [501, 502] }],
  ['get /v1/rule-drafts', { tag: 'Rule packs', id: 'listRuleDrafts', sum: 'List rule drafts', perm: 'read', res: list(anyJson('Rule draft with source, reviewer and publication.'), { agent_enabled: bool() }) }],
  ['post /v1/rule-drafts/{id}/approve', { tag: 'Rule packs', id: 'approveRuleDraft', sum: 'Approve a rule draft', perm: 'compliance:write', human: true, idd: 'Draft id.', desc: 'Signed-in people only. API keys can create and reject drafts, not approve them.', body: o({ note: str({ maxLength: 1000 }) }), res: o({ id: str(), status: en('approved'), reviewer: str() }), err: [409] }],
  ['post /v1/rule-drafts/{id}/reject', { tag: 'Rule packs', id: 'rejectRuleDraft', sum: 'Reject a rule draft', perm: 'compliance:write', idd: 'Draft id.', body: o({ note: str({ maxLength: 1000 }) }), res: o({ id: str(), status: en('rejected'), reviewer: str() }), err: [409] }],
  ['get /v1/rule-freshness', { tag: 'Rule packs', id: 'getRuleFreshness', sum: 'Rule freshness guardrail', perm: 'read', desc: 'Relevant publications that have not reached an approved rule change within 5 business days.', q: [qp('days', int({ minimum: 7, maximum: 365, default: 90 }), 'Look-back window in days.')], res: o({ guardrail: o({ max_business_days: int(), met: bool(), window_days: int() }), counts: anyJson('Relevant, approved, overdue and pending counts.'), data: arr(anyJson('Overdue publication.')), pending: arr(anyJson('Publication within the window.')) }) }],

  // Audit
  ['get /v1/audit-events', { tag: 'Audit', id: 'listAuditEvents', sum: 'List audit events', perm: 'read', desc: 'The hash-chained audit log, newest first. Page with before_seq set to next_before_seq.', q: [qp('type', str(), 'Event type prefix, for example decision or policy.published.'), qp('actor', str(), 'Exact actor reference or part of the actor name.'), qp('before_seq', int({ minimum: 1 }), 'Only events with seq below this.'), LIMIT(300, 300)], res: list(ref('AuditEvent'), { next_before_seq: nul(int()) }), rex: { data: [{ id: 48213, seq: 42, type: 'decision.created', subject: DEC_ID, data: { outcome: 'ALLOW', action: 'subscribe', fund: 'TWLF', investor: 'lumen', amount: 250000, inputs_sha256: HASH, hypothetical: false }, actor: 'key:lz_test_Xq7a', actor_name: 'API key Sandbox key (lz_test_Xq7a…)', created_at: '2026-10-02T06:22:07.000Z', hash: 'c4e1…', prev_hash: '7a90…' }], next_before_seq: null } }],
  ['get /v1/audit-events.csv', { tag: 'Audit', id: 'exportAuditEvents', sum: 'Export the audit log', perm: 'audit:export', desc: 'The latest 5,000 events as CSV with hashes. The export itself is audited.', csv: true }],
  ['get /v1/audit-events/verify', { tag: 'Audit', id: 'verifyAuditLog', sum: 'Verify the audit chain', perm: 'read', desc: 'Recomputes every hash in Postgres, checks each event links to the one before it, and compares the latest on-chain anchor with the log.', res: o({ valid: bool(), events: int(), head_seq: nul(int()), head_hash: nul(str()), bad_hashes: int(), broken_links: int(), first_break_seq: nul(int()), checked_at: dt, latest_anchor: nul(anyJson('Latest Merkle anchor and whether it matches.')), message: str() }), rex: { valid: true, events: 42, head_seq: 42, head_hash: 'c4e1…', bad_hashes: 0, broken_links: 0, first_break_seq: null, checked_at: '2026-10-02T06:30:00.000Z', latest_anchor: null, message: 'All 42 events recompute to their stored hashes and link in order.' } }],

  // Travel Rule
  ['get /v1/travel-rule/messages', { tag: 'Travel Rule', id: 'listTravelRuleMessages', sum: 'List Travel Rule messages', perm: 'read', q: [qp('status', str(), 'Message status.')], res: list(ref('TravelRuleMessage'), { threshold: anyJson('USD or EUR 1,000, FATF Recommendation 16.'), protocol: anyJson('OpenVASP TRP version.') }) }],
  ['post /v1/travel-rule/messages', { tag: 'Travel Rule', id: 'startTravelRuleMessage', sum: 'Start a Travel Rule exchange', perm: 'orders:write', desc: 'Sends an IVMS101 inquiry for an allowed transfer of 1,000 or more that has no message yet. Allowed transfers start one automatically.', body: o({ 'decision_id*': str({ minLength: 3, maxLength: 60 }) }), ok: 201, res: ref('TravelRuleMessage'), err: [409, 422] }],
  ['get /v1/travel-rule/messages/{id}', { tag: 'Travel Rule', id: 'getTravelRuleMessage', sum: 'Get a Travel Rule message', perm: 'read', idd: 'Message id.', res: { allOf: [ref('TravelRuleMessage'), o({ travel_address_decoded: nul(str()), payload: anyJson('TRP inquiry.'), response: anyJson('TRP resolution.'), ivms101: anyJson('IVMS101 payload.'), timeline: arr(o({ at: dt, event: str(), detail: str() })), related: arr(anyJson('Messages with the same request identifier.')), headers: map(str(), 'TRP headers sent.'), retryable: bool() })] } }],
  ['post /v1/travel-rule/messages/{id}/retry', { tag: 'Travel Rule', id: 'retryTravelRuleMessage', sum: 'Retry a Travel Rule message', perm: 'orders:write', idd: 'Message id.', desc: 'Resends a failed, rejected or unanswered outbound inquiry with a new request identifier and fresh client data.', res: ref('TravelRuleMessage'), err: [409, 422] }],
  ['post /v1/travel-rule/messages/{id}/confirm', { tag: 'Travel Rule', id: 'confirmTravelRuleMessage', sum: 'Send the transaction id', perm: 'orders:write', idd: 'Message id.', body: o({ 'txid*': str({ minLength: 4, maxLength: 120 }) }), res: ref('TravelRuleMessage'), err: [409] }],
  ['post /trp/v3/{ws}/{investor}', { tag: 'Travel Rule', id: 'trpInquiry', sum: 'TRP inquiry (beneficiary side)', perm: 'trp', desc: 'OpenVASP Travel Rule Protocol 3.x endpoint behind each Travel Address. Laissez matches the beneficiary name and posts the resolution to the callback, or returns it inline when the callback is not reachable.', body: o({ 'asset*': anyJson('Asset identifier.'), 'amount*': t(['number', 'string']), 'callback*': str(), 'IVMS101*': anyJson('IVMS101 originator and beneficiary.'), extensions: anyJson('Named extensions.') }), ok: 204, okd: 'Resolution delivered to the callback.', more: { 200: { description: 'Resolution returned inline.', content: json(o({ version: str(), approved: o({ address: str(), callback: str() }), rejected: str() })) } } }],
  ['post /trp/v3/callback/{ws}/{msgId}', { tag: 'Travel Rule', id: 'trpCallback', sum: 'TRP resolution callback', perm: 'trp', desc: 'The beneficiary VASP approves with an address, or rejects.', body: o({ approved: o({ 'address*': str(), callback: str() }), rejected: str() }), ok: 204, okd: 'Resolution recorded.' }],
  ['post /trp/v3/confirm/{ws}/{msgId}', { tag: 'Travel Rule', id: 'trpConfirm', sum: 'TRP transfer confirmation', perm: 'trp', desc: 'The originator reports the transaction id, or cancels.', body: o({ txid: str(), canceled: str() }), ok: 204, okd: 'Confirmation recorded.', err: [409] }],

  // Reports
  ['get /v1/reports/placement', { tag: 'Reports', id: 'getPlacementReport', sum: 'Placement limits report', perm: 'read', desc: 'Holder counts against private-placement limits per fund and jurisdiction, flagged at 80% utilization. Counts cover this organization only.', res: o({ as_of: date, flag_threshold: num(), flagged: int(), data: arr(anyJson('Fund and jurisdiction row with limit, counted, headroom and citation.')), note }) }],
  ['get /v1/reports/distribution', { tag: 'Reports', id: 'getDistributionReport', sum: 'Distribution report', perm: 'read', desc: 'Settled value by jurisdiction, booking center, fund and month, and decisions with top refusal reasons by jurisdiction.', res: o({ as_of: date, settled_value: anyJson('by_jurisdiction, by_booking_center, by_fund and by_month.'), decisions_by_jurisdiction: arr(anyJson('Allow rate and top refusal reasons.')), note }) }],
  ['get /v1/reports/register-by-jurisdiction.csv', { tag: 'Reports', id: 'exportRegisterByJurisdiction', sum: 'Export the register by jurisdiction', perm: 'audit:export', csv: true }],
  ['get /v1/reports/placement.csv', { tag: 'Reports', id: 'exportPlacementReport', sum: 'Export the placement report', perm: 'audit:export', csv: true }],
  ['get /v1/reports/decisions.csv', { tag: 'Reports', id: 'exportDecisions', sum: 'Export decisions', perm: 'audit:export', csv: true }],

  // On-chain
  ['get /v1/chain', { tag: 'On-chain', id: 'getChainOverview', sum: 'Chain overview', perm: 'read', desc: 'Network, contract addresses and operator status for on-chain settlement on Base Sepolia.', res: anyJson('Deployment overview.') }],
  ['get /v1/chain/investors/{id}', { tag: 'On-chain', id: 'getInvestorChainView', sum: 'Investor on-chain view', perm: 'read', idd: 'Investor id.', idx: 'lumen', res: anyJson('Wallet, identity claim and token balances.') }],
  ['get /v1/chain/jobs', { tag: 'On-chain', id: 'listChainJobs', sum: 'List chain jobs', perm: 'read', res: list(o({ id: str(), kind: str(), ref: nul(str()), status: en('queued', 'running', 'confirmed', 'failed'), attempts: int(), tx_hashes: arr(str()), block: nul(int()), error: nul(str()), created_at: dt, updated_at: dt, payload: anyJson('Job payload.'), transactions: arr(o({ hash: str(), url: nul(str()) })) })) }],
  ['post /v1/reconciliation/run', { tag: 'On-chain', id: 'runReconciliation', sum: 'Run reconciliation', perm: 'compliance:write', desc: 'Compares token balances on chain with the register and records breaks.', ok: 201, res: anyJson('Run summary with positions and breaks.') }],
  ['get /v1/reconciliation', { tag: 'On-chain', id: 'getReconciliation', sum: 'Get reconciliation state', perm: 'read', res: o({ enabled: bool(), sandbox: bool(), network: nul(str()), runs: arr(anyJson('Run.')), breaks: arr(o({ id: str(), run_id: int(), investor_id: str(), investor: nul(str()), ticker: str(), register_units: num(), chain_units: num(), difference: num(), status: str(), resolution: nul(str()), note: nul(str()), resolved_by: nul(str()), resolved_at: nul(dt), created_at: dt })) }) }],
  ['post /v1/reconciliation/breaks/{id}/resolve', { tag: 'On-chain', id: 'resolveReconciliationBreak', sum: 'Resolve a reconciliation break', perm: 'compliance:write', idd: 'Break id.', body: o({ 'resolution*': en('adjust_register', 'investigated'), note: str({ maxLength: 500 }) }), res: anyJson('The resolved break.') }],
  ['post /v1/reconciliation/simulate-break', { tag: 'On-chain', id: 'simulateReconciliationBreak', sum: 'Simulate a break', perm: 'compliance:write', desc: 'Sandboxes only. Mints 1,000 test units on chain without touching the register.', body: o({ 'investor_id*': str({ minLength: 1, maxLength: 80 }), 'ticker*': str({ minLength: 2, maxLength: 12 }) }), ok: 201, res: o({ job_id: nul(str()), status: str(), error: nul(str()), tx_url: nul(str()), message: str() }) }],
  ['get /v1/audit-anchors', { tag: 'On-chain', id: 'listAuditAnchors', sum: 'List audit anchors', perm: 'read', desc: 'Daily Merkle roots of the audit log head anchored on chain, with an inclusion proof for this organization.', res: o({ contract: nul(str()), contract_url: nul(str()), network: nul(str()), how_to_verify: str(), data: arr(o({ anchor_id: int(), anchor_date: date, merkle_root: str(), leaves: int(), tx_hash: nul(str()), block: nul(int()), status: str(), seq: int(), head_hash: str(), leaf: str(), proof: arr(str()), explorer_url: nul(str()), proof_valid: bool() })) }) }],

  // Portal (investor side)
  ['get /v1/portal/me', { tag: 'Portal', id: 'portalMe', sum: 'Portal: the investor', perm: 'investor', desc: 'The investor, their classifications, holdings, credential shares and distributor branding.', res: o({ distributor: o({ name: str(), brand_color: str(), sandbox: bool() }), investor: ref('Investor'), holdings: arr(o({ ticker: str(), fund: str(), units: num(), value: nul(num()), currency: nul(str()), since: date })), shares: arr(anyJson('Share of this credential with another distributor.')), open_evidence: int(), today: date }) }],
  ['get /v1/portal/funds', { tag: 'Portal', id: 'portalFunds', sum: 'Portal: eligibility per fund', perm: 'investor', desc: 'Each fund with a plain-language eligibility summary, reasons with next steps, and documents to acknowledge.', res: list(anyJson('Fund with eligible, summary, reasons, documents and documents_outstanding.'), { as_of: date }) }],
  ['get /v1/portal/documents/{id}', { tag: 'Portal', id: 'portalGetDocument', sum: 'Portal: read a document', perm: 'investor', idd: 'Document id.', res: { allOf: [ref('Document'), o({ content: str(), current: bool(), acknowledgment: nul(anyJson('This investor\'s acknowledgment of this version.')) })] } }],
  ['post /v1/portal/documents/{id}/acknowledge', { tag: 'Portal', id: 'portalAcknowledgeDocument', sum: 'Portal: acknowledge a document', perm: 'investor', idd: 'Document id.', body: o({ 'signed_name*': str({ minLength: 2, maxLength: 120 }) }), ok: 201, res: o({ document_id: str(), sha256: str(), signed_name: str(), signature: str(), acknowledged_at: dt }), err: [409] }],
  ['post /v1/portal/evidence', { tag: 'Portal', id: 'portalSubmitEvidence', sum: 'Portal: submit evidence', perm: 'investor', desc: 'Figures for a classification, prechecked against the threshold. At most 10 open submissions.', body: o({ 'class_code*': str({ minLength: 2, maxLength: 20 }), 'evidence*': map(t(['number', 'boolean', 'string']), 'Up to 12 figures.'), reference: str({ maxLength: 300 }) }), ex: { class_code: 'HK_PI', evidence: { portfolio_hkd: 9500000 }, reference: 'Custody statement, September 2026' }, ok: 201, res: o({ id: str(), status: en('submitted'), class_code: str(), label: str(), precheck: nul(o({ pass: bool(), reason: str() })), note }), err: [422] }],
  ['get /v1/portal/evidence', { tag: 'Portal', id: 'portalListEvidence', sum: 'Portal: list evidence', perm: 'investor', res: list(anyJson('Evidence submission with status.')) }],
  ['post /v1/portal/requests', { tag: 'Portal', id: 'portalCreateRequest', sum: 'Portal: request a subscription', perm: 'investor', desc: 'A signed subscription request. The distributor approves it into a pre-trade decision.', body: o({ 'ticker*': str({ minLength: 2, maxLength: 10 }), 'amount*': money, 'asset*': str({ minLength: 2, maxLength: 20 }), 'signed_name*': str({ minLength: 2, maxLength: 120 }), 'agree*': { const: true } }), ex: { ticker: 'TWLF', amount: 250000, asset: 'USDC', signed_name: 'Mei Tan', agree: true }, ok: 201, res: o({ id: str(), status: en('submitted'), ticker: str(), amount: num(), asset: str(), signature: o({ signed_name: str(), signed_at: dt, payload_sha256: str(), laissez_signature: nul(str()), document_hashes: arr(str()) }), note }), err: [422] }],
  ['get /v1/portal/requests', { tag: 'Portal', id: 'portalListRequests', sum: 'Portal: list requests', perm: 'investor', res: list(anyJson('Subscription request with status and outcome.')) }],
  ['post /v1/portal/consent/withdraw/{share_id}', { tag: 'Portal', id: 'portalWithdrawConsent', sum: 'Portal: withdraw a credential share', perm: 'investor', res: o({ revoked: str(), message: str() }) }],
  // Portal (distributor side)
  ['post /v1/investors/{id}/portal-invite', { tag: 'Portal', id: 'createPortalInvite', sum: 'Invite a client to the portal', perm: 'clients:write', idd: 'Investor id.', idx: 'meitan', desc: 'Returns a private portal link with an lz_inv_ token, valid for 30 days.', ok: 201, res: o({ link: str(), expires_at: dt, investor: o({ id: str(), name: str() }), note }) }],
  ['delete /v1/investors/{id}/portal-access', { tag: 'Portal', id: 'revokePortalAccess', sum: 'Revoke portal access', perm: 'clients:write', idd: 'Investor id.', res: o({ revoked_links: int() }) }],
  ['get /v1/portal-requests', { tag: 'Portal', id: 'listPortalRequests', sum: 'List portal requests', perm: 'read', q: [STATUS(['submitted', 'approved', 'rejected'], null, 'request')], res: list(anyJson('Request with investor, fund and decision outcome.')) }],
  ['post /v1/portal-requests/{id}/approve', { tag: 'Portal', id: 'approvePortalRequest', sum: 'Approve a portal request', perm: 'orders:write', idd: 'Request id.', desc: 'Runs the pre-trade decision for the request.', res: o({ request: o({ id: str(), status: en('approved'), decision_id: str(), note: str() }), decision: ref('Decision') }), err: [409] }],
  ['post /v1/portal-requests/{id}/reject', { tag: 'Portal', id: 'rejectPortalRequest', sum: 'Reject a portal request', perm: 'orders:write', idd: 'Request id.', body: o({ 'note*': str({ minLength: 3, maxLength: 500 }) }), res: o({ id: str(), status: en('rejected'), note: str() }) }],
  ['get /v1/evidence', { tag: 'Portal', id: 'listEvidence', sum: 'List evidence submissions', perm: 'read', q: [STATUS(['submitted', 'accepted', 'rejected'], null, 'submission')], res: list(anyJson('Submission with threshold, fields and precheck.')) }],
  ['post /v1/evidence/{id}/review', { tag: 'Portal', id: 'reviewEvidence', sum: 'Review an evidence submission', perm: 'clients:write', idd: 'Submission id.', body: o({ 'status*': en('accepted', 'rejected'), note: str({ maxLength: 500 }) }), res: o({ id: str(), status: str(), next: nul(o({ label: str(), path: str(), class_code: str() })) }) }],

  // Webhooks
  ['get /v1/webhooks', { tag: 'Webhooks', id: 'listWebhooks', sum: 'List webhook endpoints', perm: 'read', res: list(ref('Webhook')) }],
  ['post /v1/webhooks', { tag: 'Webhooks', id: 'createWebhook', sum: 'Create a webhook endpoint', perm: 'developer', desc: 'HTTPS only. Subscribe to event types or * for all. Returns the whsec_ signing secret once. Up to 5 endpoints in a sandbox, 20 in an organization.', body: o({ 'url*': str({ format: 'uri', pattern: '^https://', maxLength: 500 }), 'events*': arr(str({ pattern: '^(\\*|[a-z_]+(\\.[a-z_]+)*)$' }), { minItems: 1, maxItems: 20 }) }), ex: { url: 'https://ops.astervale.example/hooks/laissez', events: ['decision.created', 'settlement.completed', 'settlement.reverted', 'holder.status_changed'] }, ok: 201, res: { allOf: [ref('Webhook'), o({ secret: str(), note })] }, err: [422] }],
  ['delete /v1/webhooks/{id}', { tag: 'Webhooks', id: 'deleteWebhook', sum: 'Delete a webhook endpoint', perm: 'developer', idd: 'Webhook id.', res: o({ deleted: str() }) }],
  ['post /v1/webhooks/{id}/test', { tag: 'Webhooks', id: 'testWebhook', sum: 'Send a test event', perm: 'developer', idd: 'Webhook id.', desc: 'Sends a signed ping event.', res: o({ sent: bool(), webhook_id: str(), note }) }],
  ['get /v1/webhook-deliveries', { tag: 'Webhooks', id: 'listWebhookDeliveries', sum: 'List deliveries', perm: 'read', desc: 'The 100 most recent deliveries.', res: list(ref('WebhookDelivery')) }],
  ['get /v1/webhook-deliveries/{id}', { tag: 'Webhooks', id: 'getWebhookDelivery', sum: 'Get a delivery', perm: 'read', idd: 'Delivery id.', res: { allOf: [ref('WebhookDelivery'), o({ payload: d(str(), 'The exact body that was signed and sent.') })] } }],
  ['post /v1/webhook-deliveries/{id}/replay', { tag: 'Webhooks', id: 'replayWebhookDelivery', sum: 'Replay a delivery', perm: 'developer', idd: 'Delivery id.', desc: 'Sends the same payload again with a fresh signature and records a new delivery.', ok: 201, res: o({ id: int(), replay_of: int(), webhook_id: str(), event: str(), status: int(), attempts: int(), response_ms: int(), delivered: bool() }), err: [409] }],

  // API keys
  ['get /v1/api-keys', { tag: 'API keys', id: 'listApiKeys', sum: 'List API keys', perm: 'keys:admin', res: list(ref('ApiKey'), { scopes: arr(o({ id: SCOPE, label: str() })), max_keys: int() }) }],
  ['post /v1/api-keys', { tag: 'API keys', id: 'createApiKey', sum: 'Create an API key', perm: 'keys:admin', desc: 'Defaults to every scope. A key can only create keys with scopes it has. Up to 10 active keys per organization. The key is shown once.', body: o({ name: str({ minLength: 1, maxLength: 60, default: 'API key' }), scopes: arr(SCOPE, { minItems: 1, maxItems: 7 }), ip_allowlist: d(arr(str(), { maxItems: 20 }), 'IPv4 or IPv6 addresses or CIDR ranges.'), expires_in_days: int({ minimum: 1, maximum: 365 }) }), ex: { name: 'Order router', scopes: ['read', 'orders'], ip_allowlist: ['203.0.113.0/24'], expires_in_days: 90 }, ok: 201, res: { allOf: [ref('ApiKey'), o({ api_key: str(), note })] }, err: [422] }],
  ['post /v1/api-keys/{id}/rotate', { tag: 'API keys', id: 'rotateApiKey', sum: 'Rotate an API key', perm: 'keys:admin', idd: 'API key id.', desc: 'Issues a replacement with the same scopes and allowlist. The old key keeps working for 24 hours.', ok: 201, res: { allOf: [ref('ApiKey'), o({ api_key: str(), old_key_expires_at: dt, note })] }, err: [409] }],
  ['delete /v1/api-keys/{id}', { tag: 'API keys', id: 'revokeApiKey', sum: 'Revoke an API key', perm: 'keys:admin', idd: 'API key id.', desc: 'Takes effect immediately. A key cannot revoke itself.', res: o({ revoked: str() }), err: [422] }],
];

// ---------- Webhook events ----------
const EVENTS: [string, string, S][] = [
  ['decision.created', 'A decision was recorded.', o({ id: str(), outcome: OUTCOME, headline: str(), action: ACTION, fund: str() })],
  ['settlement.pending', 'A settlement was queued on chain.', o({ id: str(), decision: str(), units: num(), fund: str(), job_id: nul(str()) })],
  ['settlement.completed', 'Both legs settled.', o({ id: str(), decision: str(), units: num(), fund: str(), chain: CHAIN })],
  ['settlement.reverted', 'A leg failed and nothing moved.', o({ id: str(), decision: str(), reason: str(), chain: CHAIN })],
  ['credential.issued', 'A credential was issued or renewed.', o({ credential: str(), lzid: str(), investor: str() })],
  ['credential.revoked', 'A credential was revoked.', o({ credential: str(), investor: str() })],
  ['holder.status_changed', 'A holder became eligible, redemption-only or frozen.', o({ investor_id: str(), investor_name: str(), ticker: str(), fund_name: str(), from: nul(str()), to: str(), reason: str(), run_id: int(), trigger: str(), checked_at: dt })],
  ['policy.published', 'A policy change was approved and published.', o({ policy_change: str(), ticker: str(), policy_version: int(), impact: ref('PolicyImpact') })],
  ['nav.struck', 'A NAV was recorded.', o({ ticker: str(), date: date, nav: num(), currency: str(), change_bps: nul(num()), daily_yield_bps: nul(num()) })],
  ['distribution.paid', 'Accrued income was paid.', ref('Distribution')],
  ['fund.terms_updated', 'Dealing terms changed.', o({ ticker: str(), before: ref('FundTerms'), after: ref('FundTerms') })],
  ['redemption_notice.filed', 'A redemption notice was filed.', ref('RedemptionNotice')],
  ['redemption_notice.cancelled', 'A redemption notice was cancelled.', o({ id: str(), investor_id: str(), ticker: str() })],
  ['document.published', 'A fund document version was published.', o({ id: str(), ticker: str(), doc_type: str(), title: str(), version: int(), jurisdiction: nul(str()), audience: str(), required: bool(), sha256: str(), supersedes: nul(str()) })],
  ['document.acknowledged', 'A client acknowledged a document.', o({ document_id: str(), investor_id: str(), ticker: str(), version: int(), sha256: str(), method: str() })],
  ['ping', 'Test event from POST /v1/webhooks/{id}/test.', o({ message: str() })],
];

const errRes = (description: string, code: string, message: string, detail?: unknown): S => ({
  description, content: json(ref('Error'), { error: { code, message, ...(detail ? { detail } : {}) } }),
});

const paths: Record<string, Record<string, S>> = {};
for (const [key, op] of OPS) {
  const [method, path] = key.split(' ');
  (paths[path] ??= {})[method] = operation(method, path, op);
}

const webhooks: Record<string, S> = {};
for (const [name, description, data] of EVENTS) {
  webhooks[name] = {
    post: {
      tags: ['Webhooks'], operationId: `event_${name.replace(/\./g, '_')}`, summary: `Event: ${name}`, description, security: [],
      parameters: [{ name: 'Laissez-Signature', in: 'header', required: true, description: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> with your whsec_ secret.', schema: str() }],
      requestBody: { required: true, content: json({ allOf: [ref('WebhookEvent'), o({ type: { const: name }, data })] }) },
      responses: { '200': { description: 'Any 2xx acknowledges the event. Laissez tries up to 3 times, about 1 and 3 seconds apart, then records the delivery for replay.' } },
      'x-laissez-permission': 'webhook', 'x-laissez-api-key-scopes': [], 'x-laissez-roles': [],
    },
  };
}

const TAGS: [string, string][] = [
  ['Auth', 'Sandboxes, passkey sign-in, single sign-on, sessions and the demo identity provider.'],
  ['Organization', 'The signed-in person, the organization, members, invites and single sign-on settings.'],
  ['Clients', 'Investors your organization distributes to.'],
  ['Credentials', 'Eligibility credentials: classifications checked against legal thresholds.'],
  ['Network', 'Rely on another distributor\'s credential with the client\'s consent.'],
  ['Funds', 'Funds, their distribution rules and registers.'],
  ['Policy', 'Preview, backtest, propose and approve fund policy changes with two people.'],
  ['Fund operations', 'Dealing terms, NAV, accruals, distributions and redemption notices.'],
  ['Documents', 'Versioned fund documents and client acknowledgments.'],
  ['Decisions', 'Pre-trade decisions with checks, binding rules, remedies, snapshots and signed receipts.'],
  ['Settlements', 'Atomic settlement of allowed decisions, simulated or on chain.'],
  ['Screening', 'Sanctions lists, name screening and hit dispositions.'],
  ['Monitoring', 'Continuous holder monitoring and the compliance work queue.'],
  ['Rule packs', 'Reference data, rule packs, the regulatory feed and the rule-drafting agent.'],
  ['Audit', 'The hash-chained audit log, its export and verification.'],
  ['Travel Rule', 'FATF Recommendation 16 data exchange over the OpenVASP Travel Rule Protocol.'],
  ['Reports', 'Placement limits, distribution and CSV exports.'],
  ['On-chain', 'Chain deployment, jobs, reconciliation and audit anchors.'],
  ['Portal', 'The investor portal (lz_inv_ tokens) and the distributor routes that manage it.'],
  ['Webhooks', 'Signed event delivery, delivery history and replay.'],
  ['API keys', 'Scoped keys with IP allowlists, expiry and rotation.'],
  ['Platform', 'Health, versions, status, public metrics and this document.'],
];

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Laissez API',
    version: '2026-10-02',
    summary: 'Compliance and settlement for tokenized funds crossing borders.',
    description: [
      'Laissez checks every subscription, transfer and redemption of a tokenized fund against the investor\'s credential, the fund\'s distribution policy, residence law, the booking center\'s licence and global screens, then settles allowed orders atomically.',
      'Authenticate with "Authorization: Bearer <token>". A session token (lz_sess_) comes from passkey or single sign-on. An API key (lz_test_) comes from POST /v1/sandboxes or POST /v1/api-keys and carries scopes. Each operation lists its permission in x-laissez-permission, the key scopes that grant it in x-laissez-api-key-scopes and the roles in x-laissez-roles. Operations marked x-laissez-human-only accept sessions only.',
      'Pin a version with Laissez-Version (2026-10-02 current, 2026-10-01 legacy). Send Idempotency-Key on writes: a retry with the same key and body returns the stored response with Idempotent-Replayed: true for 24 hours. Errors use {"error": {"code", "message", "detail"}}.',
      'Rate limits: 300 requests per minute per API key and 600 per minute per session; 429 rate_limited when exceeded. Everything in a sandbox is fictional.',
    ].join('\n\n'),
    contact: { name: 'Laissez', url: 'https://parikshit7319.github.io/laissez/developers/' },
  },
  servers: [{ url: 'https://laissez-api.laissez.workers.dev', description: 'Live API (sandboxes and organizations)' }],
  externalDocs: { description: 'Developer guide', url: 'https://parikshit7319.github.io/laissez/developers/' },
  tags: TAGS.map(([name, description]) => ({ name, description })),
  paths,
  webhooks,
  components: {
    securitySchemes: {
      sessionToken: { type: 'http', scheme: 'bearer', bearerFormat: 'lz_sess_...', description: 'A person\'s session from passkey or single sign-on. Acts with the person\'s role: admin, ops, compliance, issuer, developer or auditor. 600 requests per minute. Required for human-only actions such as approving policy changes, approving rule drafts and managing members.' },
      apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'lz_test_...', description: 'An organization API key. Scopes: read (read everything, export audit), orders (decisions and settlements), clients (clients, credentials, shares), funds (funds, NAV, documents, policy proposals), compliance (screening dispositions, monitoring, work items), developer (webhooks), admin (API keys). Optional IP allowlist and expiry. Rotation keeps the old key valid for 24 hours. 300 requests per minute.' },
      portalToken: { type: 'http', scheme: 'bearer', bearerFormat: 'lz_inv_...', description: 'An investor portal link token, valid for 30 days. Acts only for that investor. 120 requests per minute.' },
    },
    parameters: {
      LaissezVersion: { name: 'Laissez-Version', in: 'header', required: false, description: 'API version. Omit for the latest. Unknown versions return 400 unsupported_version.', schema: { ...en('2026-10-02', '2026-10-01'), default: '2026-10-02' } },
      IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, description: '1 to 255 characters, for example a UUID. Retries with the same key and body replay the stored response for 24 hours. A different body with the same key returns 422 idempotency_mismatch.', schema: str({ minLength: 1, maxLength: 255 }) },
      TrpVersion: { name: 'api-version', in: 'header', required: true, description: 'TRP version, starting with 3.', schema: str({ examples: ['3.1.0'] }) },
      TrpRequestId: { name: 'request-identifier', in: 'header', required: true, description: 'One identifier for the whole transfer, up to 100 characters.', schema: str({ maxLength: 100 }) },
    },
    headers: {
      LaissezVersion: { description: 'The API version used for this response.', schema: str() },
      IdempotentReplayed: { description: 'true when the response was replayed from an earlier request with the same Idempotency-Key.', schema: en('true') },
    },
    responses: {
      BadRequest: errRes('The body or a header is not valid (invalid_request, unsupported_version, invalid_idempotency_key).', 'invalid_request', 'The request body is not valid. Fix the fields listed in detail and retry.', ['amount: Too small: expected number to be >0']),
      Unauthorized: errRes('Missing, invalid or expired credentials (unauthorized, session_expired, portal_link_expired).', 'unauthorized', 'Sign in, or send an API key as "Authorization: Bearer lz_test_...".'),
      Forbidden: errRes('Authenticated but not allowed (insufficient_scope, forbidden, human_required, ip_not_allowed, sandbox_only, same_person).', 'insufficient_scope', 'This API key is not allowed to place orders or settle. Add the right scope or use another key.'),
      NotFound: errRes('No such resource in this organization.', 'not_found', `No decision ${DEC_ID} in this organization.`),
      Conflict: errRes('The resource is not in a state that allows this (for example already_settled, expired, not_draft, state_changed, idempotency_in_progress).', 'already_settled', `This decision already settled as ${STL_ID} (settled).`),
      Gone: errRes('The link or invite was used or expired.', 'consent_expired', 'This consent request expired. Ask the distributor to send a new one.'),
      Unprocessable: errRes('Well formed but breaks a business rule (for example threshold_not_met, unknown_jurisdiction, counterparty_required, idempotency_mismatch, limit).', 'counterparty_required', 'A transfer needs counterparty_id, the investor receiving the units.'),
      RateLimited: errRes('Too many requests. Wait and retry with backoff.', 'rate_limited', 'More than 300 requests in a minute. Wait a moment and retry.'),
      NotConfigured: errRes('This feature is not configured on this deployment.', 'not_configured', 'The rule-drafting agent is not configured.'),
      BadGateway: errRes('An upstream service (chain or drafting agent) failed. Nothing was applied.', 'chain_unavailable', 'The settlement could not be queued on chain. Nothing moved. Request a new decision and try again.'),
      Unavailable: errRes('Temporarily at capacity.', 'capacity', 'All sandboxes are in use right now. Try again tomorrow.'),
    },
    schemas: {
      Error: o({ 'error*': o({ 'code*': d(str(), 'Stable machine-readable code, for example not_found or insufficient_scope.'), 'message*': d(str(), 'A plain sentence that says what went wrong and what to do.'), detail: anyJson('Field errors as strings for invalid_request, or structured detail such as failing checks.') }) }),
      Workspace: o({ id: uuid, name: str(), kind: en('sandbox', 'org', 'network'), slug: str(), brand_name: nul(str()), brand_color: nul(str()), created_at: dt, expires_at: nul(dt), sso_enabled: nul(bool()) }),
      Sandbox: o({ 'workspace*': ref('Workspace'), 'api_key*': d(str(), 'lz_test_ key with every scope. Shown once.'), 'session_token*': d(str(), 'lz_sess_ token for the guest administrator.'), note }),
      SessionToken: o({ 'session_token*': str(), 'workspace_id*': uuid, organizations: arr(o({ workspace_id: uuid, name: str(), role: ROLE })) }),
      Check: o({ 'id*': d(str(), 'Check id, for example cred, screen, dist, fundClass, law, booking, min, asset, holding, cpScreen, travel.'), 'layer*': LAYER, 'label*': str(), 'detail*': str(), 'result*': en('pass', 'fail', 'na', 'info'), ruleRef: d(str(), 'Legal citation, for example SFA s4A.'), source: str(), remedy: d(str(), 'What would make this check pass.'), binding: bool(), subject: d(str(), 'Who the check is about when an order has two parties.') }),
      BindingRule: o({ 'text*': str(), 'layer*': LAYER, 'ruleRef*': str() }),
      Receipt: o({ decision_id: str(), sandbox: str(), outcome: OUTCOME, action: ACTION, fund: str(), amount: d(str(), 'Decimal string.'), asset: str(), binding_rules: arr(str()), rule_packs: arr(str()), inputs_sha256: str(), issued_at: dt, dealing_date: date }, { description: 'Signed with Ed25519. Verify with POST /v1/receipts/verify or the key from GET /v1/signing-key.' }),
      Decision: o({
        'id*': d(nul(str()), 'Null when persist is false.'), 'outcome*': OUTCOME, 'headline*': str(), redemption_only: d(bool(), 'The investor may only redeem from this fund.'), units: num(),
        'checks*': arr(ref('Check')), binding_rules: arr(ref('BindingRule')), remedies: arr(str()), rule_packs: arr(str()), inputs_sha256: d(str(), 'SHA-256 of every input the engine read.'),
        hypothetical: bool(), what_ifs: arr(WHAT_IF), dealing_date: nul(date), travel_rule: nul(anyJson('IVMS101 payload for transfers of 1,000 or more.')), settle_by: d(nul(dt), 'Allowed decisions must settle by this time.'),
        persisted: bool(), receipt: nul(ref('Receipt')), signature: nul(str()), created_at: dt,
      }),
      DecisionSummary: o({ id: str(), action: ACTION, investor_id: str(), investor: str(), counterparty_id: nul(str()), ticker: str(), amount: num(), asset: str(), outcome: OUTCOME, headline: str(), what_ifs: arr(str()), dealing_date: nul(date), actor: nul(str()), created_at: dt, settlement_id: nul(str()), settlement_status: nul(str()) }),
      DecisionRecord: o({
        id: str(), action: ACTION, investor_id: str(), investor_name: str(), counterparty_id: nul(str()), counterparty_name: nul(str()), ticker: str(), amount: num(), asset: str(), outcome: OUTCOME, headline: str(),
        checks: arr(ref('Check')), resolved: arr(ref('BindingRule')), remedies: arr(str()), rule_packs: arr(str()), what_ifs: arr(str()), units: num(), inputs_sha256: str(), snapshot: nul(anyJson('Every input the engine read, for replay.')),
        dealing_date: nul(date), actor: nul(d(str(), 'user:<id> or key:<prefix>.')), actor_name: nul(str()), created_at: dt, settlement_id: nul(str()), settlement_status: nul(str()), replayable: bool(), receipt: nul(ref('Receipt')), signature: nul(str()),
      }),
      SettlementStep: o({ 'step*': en('decision_signed', 'cash_locked', 'registry_confirmed', 'atomic_swap', 'units_locked', 'atomic_payout', 'final'), 'at*': dt, block: int() }),
      SettlementCreated: o({ 'id*': str(), 'decision_id*': str(), 'status*': en('pending', 'settled'), units: num(), fund: str(), simulated: bool(), steps: arr(ref('SettlementStep')), chain: CHAIN, poll: d(str(), 'On 202: poll this path until settled or reverted.') }),
      Settlement: o({ 'id*': str(), 'decision_id*': str(), 'status*': en('pending', 'settled', 'reverted'), steps: o({ simulated: bool(), chain: str(), recheck: o({ outcome: OUTCOME, inputs_sha256: str(), checked_at: dt }), steps: arr(ref('SettlementStep')), reason: str() }), chain: CHAIN, action: ACTION, ticker: str(), amount: num(), asset: str(), units: num(), investor_id: str(), counterparty_id: nul(str()), investor: str(), created_at: dt }),
      Classification: o({ 'code*': d(str(), 'Investor class code, for example SG_AI.'), basis: str(), verified: date, expires: date, optIn: date }),
      Investor: o({
        'id*': str(), 'name*': str(), short: str(), kind: str(), residence: d(str(), 'Jurisdiction code.'), city: str(), booking: d(str(), 'Booking center id.'), usPerson: bool(), wallet: str(),
        credentialId: d(str(), 'Empty when the client has no credential.'), issued: str(), expires: str(), classifications: arr(ref('Classification')), holdings: map(o({ units: num(), since: date }), 'Units per fund ticker.'),
        issuer: str(), lzid: d(str(), 'Network passport number.'), reliedShare: d(str(), 'Share id when the credential is relied on from another distributor.'), shareStatus: str(),
        credential_status: en('active', 'partly_lapsed', 'lapsed', 'none', 'share_pending', 'relied_invalid'), residence_name: str(),
      }),
      Fund: o({
        'ticker*': str(), id: str(), 'name*': str(), short: str(), domicile: str(), structure: str(), currency: en('USD', 'EUR'), nav: num(), regS: d(bool(), 'Regulation S: not offered to U.S. persons.'), usAccepts: nul(arr(str())),
        distribution: map(o({ accepts: arr(str()), basis: str(), lawRequires: nul(str()), lawText: str(), lawRef: str(), lawSource: str() }), 'Offering rules per jurisdiction code.'),
        minSubscription: num(), holderCap: nul(int()), holders: int(), lockupMonths: nul(int()), assets: arr(str()), chains: arr(str()), issuer: str(), policyVersion: int(),
        shareClassType: en('distributing', 'accumulating'), cutoffTime: str(), cutoffTz: str(), dealingFrequency: en('daily', 'monthly', 'quarterly'), noticeDays: int(), gatePct: nul(num()), yieldBps: nul(num()), chainToken: nul(str()),
      }),
      FundTerms: o({ share_class_type: en('distributing', 'accumulating'), dealing_frequency: en('daily', 'monthly', 'quarterly'), cutoff_time: str(), cutoff_tz: str(), notice_days: int(), gate_pct: nul(num()), yield_bps: nul(num()) }),
      FundTermsInput: o({ share_class_type: en('distributing', 'accumulating'), dealing_frequency: en('daily', 'monthly', 'quarterly'), cutoff_time: d(str(), '24-hour time such as 16:00.'), cutoff_tz: d(str({ minLength: 1, maxLength: 64 }), 'IANA time zone.'), notice_days: int({ minimum: 0, maximum: 365 }), gate_pct: nul(num({ exclusiveMinimum: 0, maximum: 100 })), yield_bps: nul(num({ minimum: 0, maximum: 5000 })) }, { additionalProperties: false }),
      Credential: o({ 'id*': d(str(), 'Credential id, for example LP-SG-0419-2207.'), lzid: nul(str()), issuer_name: nul(str()), investor_id: str(), name: str(), issued_on: date, expires_on: date, status: en('active', 'revoked'), revoked_at: nul(dt) }),
      CredentialIssued: o({ credential_id: str(), lzid: str(), issuer_name: str(), issued_on: date, expires_on: date, checks: arr(o({ class_code: str(), pass: bool(), reason: str(), label: str(), jurisdiction: str() })), investor: ref('Investor') }),
      PolicyInput: o({ 'distribution*': DIST, min_subscription: num({ minimum: 0 }), holder_cap: nul(int({ exclusiveMinimum: 0 })), lockup_months: nul(int({ exclusiveMinimum: 0 })) }),
      PolicyImpact: o({ removed: arr(str()), added: arr(str()), holders_affected: arr(o({ investor_id: str(), name: str(), from: str(), to: str(), units: num(), value: num() })), value_affected: num(), currency: str(), sandbox_holders: int(), current_policy_version: int(), note }),
      PolicyChange: o({ 'id*': str(), ticker: str(), 'status*': en('draft', 'published', 'rejected'), proposed_by: str(), proposed_by_user: nul(uuid), approved_by: nul(str()), approved_by_user: nul(uuid), changes: ref('PolicyInput'), impact: ref('PolicyImpact'), decided_at: nul(dt), created_at: dt }),
      AuditEvent: o({ id: int(), 'seq*': d(int(), 'Position in this organization\'s chain, from 1.'), 'type*': str(), subject: nul(str()), data: anyJson('Event detail.'), actor: d(str(), 'user:<id>, key:<prefix>, investor:<id> or system:<id>.'), actor_name: str(), created_at: dt, 'hash*': d(str(), 'SHA-256 over seq, organization, type, subject, data, actor, created_at and prev_hash.'), 'prev_hash*': d(str(), 'Hash of the previous event. Sixty-four zeros for the first.') }),
      WorkItem: o({ 'id*': str(), kind: str(), title: str(), detail: str(), severity: en('high', 'medium', 'low'), investor_id: nul(str()), ticker: nul(str()), link: nul(str()), 'status*': en('open', 'done', 'dismissed'), due_on: nul(date), created_at: dt, resolved_at: nul(dt), resolved_by: nul(str()), investor_name: nul(str()) }),
      ScreeningHit: o({ 'id*': str(), investor_id: nul(str()), screened_name: str(), source: d(str(), 'List, for example OFAC-SDN.'), source_uid: str(), matched_name: str(), primary_name: str(), programs: nul(str()), score: num({ minimum: 0, maximum: 1 }), context: d(str(), 'Where the hit came from, for example order or monitoring.'), 'status*': en('open', 'false_positive', 'confirmed'), created_at: dt, decided_at: nul(dt), decided_by: nul(str()), note: nul(str()), investor_name: nul(str()) }),
      CredentialShare: o({ 'id*': str(), direction: en('incoming', 'outgoing'), 'status*': en('pending', 'active', 'declined', 'revoked'), lzid: str(), investor_name: str(), purpose: str(), booking_center: nul(str()), issuing_org: nul(str()), receiving_org: nul(str()), counterparty_org: nul(str()), to_investor_id: nul(str()), requested_by: nul(str()), consent_name: nul(str()), consent_at: nul(dt), created_at: dt, consent_expires_at: nul(dt), revoked_at: nul(dt), revoked_reason: nul(str()), classifications: arr(str()), credential_expires_on: nul(date), credential_live: nul(bool()), terms: o({ reliance: str(), scope: arr(str()), expires_with_credential: bool(), credential_expires_on: date }) }),
      TravelRuleMessage: o({ 'id*': str(), decision_id: nul(str()), direction: en('outbound', 'inbound'), 'status*': en('sending', 'awaiting_resolution', 'approved', 'rejected', 'confirmed', 'canceled', 'failed'), originator_vasp: str(), beneficiary_vasp: str(), originator: nul(str()), beneficiary: nul(str()), amount: nul(t(['number', 'string'])), ticker: nul(str()), notional: nul(str()), currency: nul(str()), travel_address: nul(str()), request_identifier: str(), beneficiary_address: nul(str()), txid: nul(str()), created_at: dt, updated_at: dt }),
      Document: o({ 'id*': str(), ticker: str(), doc_type: str(), type_label: str(), title: str(), version: int(), jurisdiction: nul(str()), audience: en('all', 'retail', 'professional'), sha256: str(), required: bool(), published_at: dt, published_by: str(), superseded_at: nul(dt), status: en('current', 'superseded'), excerpt: str(), acknowledgments: t(['integer', 'array']) }),
      Distribution: o({ id: str(), ticker: str(), period_start: date, period_end: date, paid_on: date, currency: str(), nav: num(), total_amount: num(), reinvested_units: num(), cash_paid: num(), holders: int(), lines: arr(o({ investor_id: str(), investor: str(), amount: num(), days: int() })) }),
      RedemptionNotice: o({ 'id*': str(), investor_id: str(), investor: str(), ticker: str(), units: num(), notice_date: date, dealing_date: date, 'status*': en('pending', 'executed', 'cancelled'), value: num(), warnings: arr(str()), note }),
      RuleDraft: o({ id: str(), status: en('draft', 'approved', 'rejected'), draft: o({ jurisdiction: str(), source_status: en('final', 'proposal', 'guidance'), summary: str(), effective_date: nul(str()), changes: arr(o({ class_code: str(), field: str(), from: nul(str()), to: str(), citation: str() })), open_questions: arr(str()) }) }),
      ApiKey: o({ 'id*': uuid, name: str(), prefix: d(str(), 'First 12 characters of the key.'), scopes: arr(SCOPE), ip_allowlist: nul(arr(str())), expires_at: nul(dt), created_at: dt, last_used_at: nul(dt), rotated_from: nul(uuid), current: d(bool(), 'True for the key making this request.') }),
      Webhook: o({ 'id*': str(), 'url*': str(), 'events*': arr(str()), created_at: dt }),
      WebhookDelivery: o({ 'id*': t(['integer', 'string']), webhook_id: str(), event: str(), status: d(int(), 'HTTP status from your endpoint. 0 means no response.'), attempts: int({ minimum: 1, maximum: 3 }), response_ms: int(), replay_of: nul(int()), created_at: dt }),
      WebhookEvent: o({ 'id*': d(str(), 'Event id, evt_ prefix.'), 'type*': str(), 'created*': dt, 'data*': anyJson('Event payload.') }),
    },
  },
};

export default OPENAPI;
