// Tests for the Laissez TypeScript SDK with a mocked fetch. Run: npx tsx sdk/typescript/test.ts
import assert from 'node:assert/strict';
import { Laissez, LaissezError, verifyWebhook, responseMeta } from './laissez';

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error };

/** A fetch that records calls and plays back scripted replies in order (the last reply repeats). */
function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: (init?.body as string) ?? null });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r.throws) throw r.throws;
    const text = typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': typeof r.body === 'string' ? 'text/csv' : 'application/json', 'laissez-version': '2026-10-02', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const hmacHex = async (secret: string, text: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
};

test('constructor requires a credential and rejects both', async () => {
  assert.throws(() => new Laissez({}), /apiKey/);
  assert.throws(() => new Laissez({ apiKey: 'a', sessionToken: 'b' }), /not both/);
  const c = new Laissez({ apiKey: 'lz_test_x', baseUrl: 'https://api.example/' });
  assert.equal(c.baseUrl, 'https://api.example');
  assert.equal(c.version, '2026-10-02');
});

test('sends bearer token, version header and query string', async () => {
  const { fetchImpl, calls } = mockFetch([{ body: { data: [] } }]);
  const c = new Laissez({ apiKey: 'lz_test_abc', fetch: fetchImpl, version: '2026-10-01' });
  await c.decisions.list({ limit: 5, fund: 'TWLF', investor_id: undefined });
  assert.equal(calls[0].url, 'https://laissez-api.laissez.workers.dev/v1/decisions?limit=5&fund=TWLF');
  assert.equal(calls[0].headers.authorization, 'Bearer lz_test_abc');
  assert.equal(calls[0].headers['laissez-version'], '2026-10-01');
  assert.equal(calls[0].headers['idempotency-key'], undefined);
});

test('writes get an automatic Idempotency-Key, or the one you pass', async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 201, body: { id: 'dec_1', outcome: 'ALLOW', headline: 'ok', checks: [] } }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl });
  const d = await c.decisions.create({ action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 250000, settle_with: 'USDC' });
  assert.equal(d.outcome, 'ALLOW');
  assert.match(calls[0].headers['idempotency-key'], /^[0-9a-f-]{32,36}$/);
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body!), { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 250000, settle_with: 'USDC' });
  await c.settlements.create('dec_1', { idempotencyKey: 'order-42' });
  assert.equal(calls[1].headers['idempotency-key'], 'order-42');
  assert.deepEqual(JSON.parse(calls[1].body!), { decision_id: 'dec_1' });
  const meta = responseMeta(d);
  assert.equal(meta?.status, 201);
  assert.equal(meta?.version, '2026-10-02');
});

test('autoIdempotency: false sends no key and never retries a write', async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 503, body: { error: { code: 'unavailable', message: 'down' } } }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl, autoIdempotency: false, maxRetries: 3 });
  await assert.rejects(c.settlements.create('dec_1'), (e: LaissezError) => e.code === 'unavailable' && e.status === 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['idempotency-key'], undefined);
});

test('maps error bodies to LaissezError with code, status and detail', async () => {
  const { fetchImpl } = mockFetch([{ status: 422, body: { error: { code: 'threshold_not_met', message: 'Nothing was issued.', detail: [{ class_code: 'HK_PI', pass: false }] } } }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl });
  try {
    await c.credentials.issue({ investor_id: 'meitan', classifications: [{ class_code: 'HK_PI', evidence: { portfolio_hkd: 1 } }] });
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof LaissezError);
    const e = err as LaissezError;
    assert.equal(e.code, 'threshold_not_met');
    assert.equal(e.status, 422);
    assert.equal(e.message, 'Nothing was issued.');
    assert.deepEqual(e.detail, [{ class_code: 'HK_PI', pass: false }]);
    assert.equal(e.method, 'POST');
    assert.equal(e.path, '/v1/credentials');
    assert.equal(e.isPermission, false);
  }
});

test('retries 429 and 5xx with backoff, honours Retry-After, then succeeds', async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } }, headers: { 'retry-after': '0' } },
    { status: 502, body: { error: { code: 'bad_gateway', message: 'upstream' } } },
    { body: { data: [{ id: 'lumen' }] } },
  ]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl, maxRetries: 3 });
  const page = await c.investors.list();
  assert.equal(page.data[0].id, 'lumen');
  assert.equal(calls.length, 3);
});

test('gives up after maxRetries and reports the last error', async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 429, body: { error: { code: 'rate_limited', message: 'More than 300 requests in a minute.' } }, headers: { 'retry-after': '0' } }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl, maxRetries: 2 });
  await assert.rejects(c.funds.list(), (e: LaissezError) => e.isRateLimited && e.code === 'rate_limited');
  assert.equal(calls.length, 3);
});

test('does not retry 4xx other than 429', async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 404, body: { error: { code: 'not_found', message: 'No decision dec_x.' } } }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl, maxRetries: 3 });
  await assert.rejects(c.decisions.retrieve('dec_x'), (e: LaissezError) => e.status === 404);
  assert.equal(calls.length, 1);
});

test('retries network errors on reads and idempotent writes', async () => {
  const { fetchImpl, calls } = mockFetch([{ throws: new TypeError('fetch failed') }, { status: 201, body: { id: 'stl_1', decision_id: 'dec_1', status: 'settled' } }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl, maxRetries: 2 });
  const s = await c.settlements.create('dec_1');
  assert.equal(s.status, 'settled');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
});

test('network failure after the last retry becomes network_error', async () => {
  const { fetchImpl } = mockFetch([{ throws: new TypeError('fetch failed') }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl, maxRetries: 1 });
  await assert.rejects(c.me(), (e: LaissezError) => e.code === 'network_error' && e.status === 0);
});

test('waitUntilSettled polls until settled', async () => {
  const { fetchImpl, calls } = mockFetch([
    { body: { id: 'stl_1', decision_id: 'dec_1', status: 'pending' } },
    { body: { id: 'stl_1', decision_id: 'dec_1', status: 'pending' } },
    { body: { id: 'stl_1', decision_id: 'dec_1', status: 'settled' } },
  ]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl });
  const s = await c.settlements.waitUntilSettled('stl_1', { intervalMs: 1 });
  assert.equal(s.status, 'settled');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://laissez-api.laissez.workers.dev/v1/settlements/stl_1');
});

test('waitUntilSettled rejects on revert and on timeout', async () => {
  const reverted = mockFetch([{ body: { id: 'stl_2', decision_id: 'dec_2', status: 'reverted' } }]);
  await assert.rejects(new Laissez({ apiKey: 'k', fetch: reverted.fetchImpl }).settlements.waitUntilSettled('stl_2'), (e: LaissezError) => e.code === 'settlement_reverted');
  const pending = mockFetch([{ body: { id: 'stl_3', decision_id: 'dec_3', status: 'pending' } }]);
  await assert.rejects(new Laissez({ apiKey: 'k', fetch: pending.fetchImpl }).settlements.waitUntilSettled('stl_3', { intervalMs: 1, timeoutMs: 5 }), (e: LaissezError) => e.code === 'settlement_timeout');
});

test('resource paths and methods', async () => {
  const { fetchImpl, calls } = mockFetch([{ body: {} }]);
  const c = new Laissez({ sessionToken: 'lz_sess_1', fetch: fetchImpl });
  await c.decisions.replay('dec_1');
  await c.investors.retrieve('lumen');
  await c.credentials.revoke('LP-SG-0419-2207', 'Client left');
  await c.credentials.list({ expiring_within: 30 });
  await c.funds.register('TWLF');
  await c.policyChanges.propose('TWLF', { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }] });
  await c.policyChanges.approve('pc_1');
  await c.screening.screen('Qamar Holdings Ltd');
  await c.screening.hits.decide('hit_1', 'false_positive', 'Different DOB');
  await c.workItems.list({ status: 'all' });
  await c.monitoring.run();
  await c.credentialShares.request({ lzid: 'LZ-7K2M-9QX4-PA3D', purpose: 'Subscription', booking_center: 'SG' });
  await c.travelRule.confirm('trm_1', '0xabc');
  await c.audit.list({ before_seq: 40, limit: 10 });
  await c.audit.verify();
  await c.apiKeys.rotate('key_1');
  await c.apiKeys.revoke('key_1');
  await c.webhooks.create({ url: 'https://ops.example/hooks', events: ['*'] });
  await c.webhooks.deliveries.replay(12);
  await c.reference.rulePacks();
  const got = calls.map((x) => `${x.method} ${x.url.replace('https://laissez-api.laissez.workers.dev', '')}`);
  assert.deepEqual(got, [
    'GET /v1/decisions/dec_1/replay',
    'GET /v1/investors/lumen',
    'POST /v1/credentials/LP-SG-0419-2207/revoke',
    'GET /v1/credentials?expiring_within=30',
    'GET /v1/funds/TWLF/register',
    'POST /v1/funds/TWLF/policy/changes',
    'POST /v1/policy-changes/pc_1/approve',
    'POST /v1/screening',
    'POST /v1/screening-hits/hit_1/decide',
    'GET /v1/work-items?status=all',
    'POST /v1/monitoring/run',
    'POST /v1/credential-shares',
    'POST /v1/travel-rule/messages/trm_1/confirm',
    'GET /v1/audit-events?before_seq=40&limit=10',
    'GET /v1/audit-events/verify',
    'POST /v1/api-keys/key_1/rotate',
    'DELETE /v1/api-keys/key_1',
    'POST /v1/webhooks',
    'POST /v1/webhook-deliveries/12/replay',
    'GET /v1/rule-packs',
  ]);
  assert.deepEqual(JSON.parse(calls[2].body!), { reason: 'Client left' });
  assert.deepEqual(JSON.parse(calls[8].body!), { status: 'false_positive', note: 'Different DOB' });
  assert.equal(calls[16].headers['idempotency-key']?.length > 0, true, 'DELETE carries an idempotency key');
});

test('CSV exports return text', async () => {
  const { fetchImpl, calls } = mockFetch([{ body: 'seq,type\n1,decision.created\n' }]);
  const c = new Laissez({ apiKey: 'k', fetch: fetchImpl });
  const csv = await c.audit.exportCsv();
  assert.equal(csv.split('\n')[0], 'seq,type');
  assert.equal(calls[0].headers.accept, 'text/csv');
});

test('createSandbox needs no credential', async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 201, body: { workspace: { id: 'w1' }, api_key: 'lz_test_new', session_token: 'lz_sess_new' } }]);
  const sb = await Laissez.createSandbox('Aster & Vale sandbox', { fetch: fetchImpl });
  assert.equal(sb.api_key, 'lz_test_new');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body!), { name: 'Aster & Vale sandbox' });
});

test('verifyWebhook accepts a valid signature and rejects tampering, bad headers and stale timestamps', async () => {
  const secret = 'whsec_test_secret_0123456789';
  const body = JSON.stringify({ id: 'evt_1', type: 'settlement.completed', created: '2026-10-02T06:23:14.000Z', data: { id: 'stl_4WN8PQ2KD7ZT', decision: 'dec_8KQ2M4ZP7WXA', units: 250000, fund: 'TWLF' } });
  const t = 1_790_000_000;
  const now = () => t * 1000 + 10_000;
  const sig = await hmacHex(secret, `${t}.${body}`);
  const event = await verifyWebhook<{ id: string }>(body, `t=${t},v1=${sig}`, secret, 300, now);
  assert.equal(event.type, 'settlement.completed');
  assert.equal(event.data.id, 'stl_4WN8PQ2KD7ZT');
  // Bytes work too, and extra v1 values are tolerated.
  await verifyWebhook(new TextEncoder().encode(body), `t=${t},v1=deadbeef,v1=${sig}`, secret, 300, now);
  await assert.rejects(verifyWebhook(body.replace('250000', '250001'), `t=${t},v1=${sig}`, secret, 300, now), (e: LaissezError) => e.code === 'invalid_signature');
  await assert.rejects(verifyWebhook(body, `t=${t},v1=${sig}`, 'whsec_other', 300, now), (e: LaissezError) => e.code === 'invalid_signature');
  await assert.rejects(verifyWebhook(body, `t=${t + 1},v1=${sig}`, secret, 300, now), (e: LaissezError) => e.code === 'invalid_signature');
  await assert.rejects(verifyWebhook(body, `t=${t},v1=${sig}`, secret, 300, () => (t + 301) * 1000), (e: LaissezError) => e.code === 'signature_expired');
  await verifyWebhook(body, `t=${t},v1=${sig}`, secret, 0, () => (t + 100_000) * 1000);
  await assert.rejects(verifyWebhook(body, null, secret, 300, now), (e: LaissezError) => e.code === 'invalid_signature');
  await assert.rejects(verifyWebhook(body, 'garbage', secret, 300, now), (e: LaissezError) => e.code === 'invalid_signature');
  await assert.rejects(verifyWebhook(body, `t=${t},v1=${sig}`, '', 300, now), (e: LaissezError) => e.code === 'invalid_signature');
  const c = new Laissez({ apiKey: 'k', fetch: mockFetch([{ body: {} }]).fetchImpl });
  assert.equal(c.webhooks.verify, verifyWebhook);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${(e as Error).stack ?? e}`); }
}
console.log(failed ? `\n${failed} of ${tests.length} tests failed.` : `\nAll ${tests.length} tests passed.`);
if (failed) process.exit(1);
