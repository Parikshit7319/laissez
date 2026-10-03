// Local integration test for account security and billing. It needs what a deployed Worker does not expose:
// the database (to read emails from the outbox and move dates) and INTERNAL_TOKEN (staff routes).
//
//   npm run dev:all                        # database and API on :8787
//   node api/test/security-billing.mjs     # reads api/.dev.local.vars; starts a second API in production mode on :8788
//
// Covers: recovery by email (waiting period, cancel, single use, recovery session limits, authenticator code),
// invite sign-up confirmed by the invite address, staff verification of an organization, contract acceptance,
// metering of real settlements into usage, platform and usage invoices, PDF, dunning from past due to suspended,
// the 402 gate and its lift on payment, the signed Stripe webhook, revenue metrics, account deletion, and production
// mode (sign-up closed without mail, email confirmation gate, organization verification gate).
import { webcrypto as wc, createHash, createHmac, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', 'package.json'));
const pg = require('pg');
const vars = {};
for (const f of ['.dev.vars', '.dev.local.vars']) {
  const p = path.join(HERE, '..', f);
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
}
const DB = process.env.SMOKE_DB_URL ?? vars.DATABASE_URL;
const STAFF_TOKEN = process.env.INTERNAL_TOKEN ?? vars.INTERNAL_TOKEN;
const WH_SECRET = vars.STRIPE_WEBHOOK_SECRET;
if (!DB || !/127\.0\.0\.1|localhost/.test(DB)) { console.error('Refusing to run: DATABASE_URL must be a local database.'); process.exit(2); }
if (!STAFF_TOKEN || !WH_SECRET) { console.error('INTERNAL_TOKEN and STRIPE_WEBHOOK_SECRET must be set in api/.dev.local.vars.'); process.exit(2); }
const db = new pg.Client({ connectionString: DB }); await db.connect();
const q = async (text, params = []) => (await db.query(text, params)).rows;

let BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:4321'; const RP_ID = 'localhost';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const b64u = (b) => Buffer.from(b).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, { token, body, headers = {}, raw = false, base = BASE } = {}) {
  const res = await fetch(base + p, { method, redirect: 'manual', headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  if (raw) return res;
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}
const get = (p, o) => call('GET', p, o); const post = (p, body, o = {}) => call('POST', p, { ...o, body }); const put = (p, body, o = {}) => call('PUT', p, { ...o, body });
const staff = (method, p, body) => call(method, `/v1/internal${p}`, { token: STAFF_TOKEN, body });

function soft() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }); const id = b64u(wc.getRandomValues(new Uint8Array(16))); let counter = 0;
  return {
    register(options) { const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false })); return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: '', publicKey: b64u(spki), publicKeyAlgorithm: -7, transports: ['internal'] } }; },
    assert(options) { counter++; const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false })); const rp = createHash('sha256').update(RP_ID).digest(); const ad = Buffer.concat([rp, Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]); const sig = nodeSign('sha256', Buffer.concat([ad, createHash('sha256').update(cd).digest()]), privateKey); return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null } }; },
  };
}
function totp(secret, atMs = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const bytes = [];
  for (const ch of secret) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest(); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}

async function signUp(email, name, org, extra = {}, base = BASE) {
  const a = soft();
  const ro = await call('POST', '/v1/auth/register/options', { body: { email, name, org_name: org, demo_data: true, accept_terms: true, ...extra }, base });
  if (ro.status !== 200) return { a, ro };
  const rv = await call('POST', '/v1/auth/register/verify', { body: { challenge_id: ro.json.challenge_id, credential: a.register(ro.json.options) }, base });
  return { a, ro, rv, token: rv.json?.session_token, ws: rv.json?.workspace_id };
}
async function signIn(a, base = BASE) {
  const lo = await call('POST', '/v1/auth/login/options', { body: {}, base });
  return call('POST', '/v1/auth/login/verify', { body: { challenge_id: lo.json.challenge_id, credential: a.assert(lo.json.options) }, base });
}
const outboxLink = async (email, kind) => (await q(`select link from email_outbox where to_email = $1 and kind = $2 order by created_at desc limit 1`, [email, kind]))[0]?.link ?? null;
const tokenOf = (link, marker) => link?.split(marker)[1]?.split('/')[0];

const stamp = Date.now();
const emailA = `rec-a+${stamp}@laissez.test`; const emailB = `rec-b+${stamp}@laissez.test`; const emailC = `invitee+${stamp}@laissez.test`;
await q(`delete from rate_limits`);

(async () => {
  // =====================================================================================================
  console.log('\n-- Recovery by email --');
  const A = await signUp(emailA, 'Recovery Alpha', `Alpha Capital ${stamp}`);
  ok('account A created', A.rv?.status === 201 && A.token, JSON.stringify(A.rv?.json));
  const rs1 = await post('/v1/auth/recover/start', { email: emailA });
  ok('recovery requested', rs1.status === 202);
  await sleep(600);
  const link1 = await outboxLink(emailA, 'recovery'); const tok1 = tokenOf(link1, '#/recover/');
  ok('recovery email carries a link', !!tok1, String(link1));
  const st1 = await get(`/v1/auth/recover/${tok1}`);
  ok('link is waiting out its period', st1.json?.state === 'waiting' && st1.json?.needs_code === false && st1.json?.email?.includes('*'), JSON.stringify(st1.json));
  const early = await post(`/v1/auth/recover/${tok1}/complete`, {});
  ok('link refused during the waiting period', early.status === 403 && early.json?.error?.code === 'recovery_waiting', JSON.stringify(early.json));
  await q(`update email_tokens set available_at = now() - interval '1 second' where token_hash = encode(sha256($1::bytea), 'hex')`, [tok1]);
  const done = await post(`/v1/auth/recover/${tok1}/complete`, {});
  ok('recovery completes after the wait', done.status === 200 && done.json?.recovery_session === true && done.json?.session_token, JSON.stringify(done.json));
  const R = done.json?.session_token;
  ok('every earlier session was ended', (await get('/v1/me', { token: A.token })).status === 401);
  const lim = await get('/v1/investors', { token: R });
  ok('recovery session is limited to adding a passkey', lim.status === 403 && lim.json?.error?.code === 'recovery_session', JSON.stringify(lim.json));
  const meR = await get('/v1/me', { token: R });
  ok('recovery session reports itself and confirms the address', meR.json?.recovery_session === true && meR.json?.email_verified === true);
  const a2 = soft();
  const po = await post('/v1/passkeys/options', {}, { token: R });
  const pv = await post('/v1/passkeys/verify', { challenge_id: po.json?.challenge_id, credential: a2.register(po.json?.options), name: 'After recovery' }, { token: R });
  ok('new passkey added from the recovery session', pv.status === 201, JSON.stringify(pv.json));
  const lv = await signIn(a2);
  ok('signed in with the new passkey', lv.status === 200 && lv.json?.session_token);
  const reuse = await post(`/v1/auth/recover/${tok1}/complete`, {});
  ok('a recovery link works once', reuse.status === 410 && reuse.json?.error?.code === 'recovery_used');
  const audit = await q(`select type from audit_events where workspace_id = $1 and type like 'account.recovery%' order by id`, [A.ws]);
  ok('recovery is audited', audit.some((r) => r.type === 'account.recovery_requested') && audit.some((r) => r.type === 'account.recovery_used'), JSON.stringify(audit));
  const alerts = await q(`select kind from email_outbox where to_email = $1 and kind = 'security_alert'`, [emailA]);
  ok('the person is told by email', alerts.length >= 1);
  // Cancel path.
  await post('/v1/auth/recover/start', { email: emailA }); await sleep(600);
  const tokC = tokenOf(await outboxLink(emailA, 'recovery'), '#/recover/');
  const cancel = await post(`/v1/auth/recover/${tokC}/cancel`, {});
  ok('recovery can be cancelled from the email', cancel.status === 200 && cancel.json?.cancelled === true, JSON.stringify(cancel.json));
  await q(`update email_tokens set available_at = now() - interval '1 second' where token_hash = encode(sha256($1::bytea), 'hex')`, [tokC]);
  const afterCancel = await post(`/v1/auth/recover/${tokC}/complete`, {});
  ok('a cancelled link cannot be used', afterCancel.status === 410 && afterCancel.json?.error?.code === 'recovery_cancelled');
  const a3 = await post('/v1/auth/recover/start', { email: emailA });
  const a4 = await post('/v1/auth/recover/start', { email: emailA });
  ok('recovery is limited per address', a3.status === 202 && a4.status === 429, `${a3.status} ${a4.status}`);

  // With an authenticator app: no waiting period, a code is required, and a used code cannot be replayed.
  const B = await signUp(emailB, 'Recovery Bravo', `Bravo Funds ${stamp}`);
  const setup = await post('/v1/account/totp/setup', {}, { token: B.token });
  const enable = await post('/v1/account/totp/enable', { code: totp(setup.json.secret) }, { token: B.token });
  ok('authenticator enabled on B', enable.status === 200);
  await post('/v1/auth/recover/start', { email: emailB }); await sleep(600);
  const tokB = tokenOf(await outboxLink(emailB, 'recovery'), '#/recover/');
  const stB = await get(`/v1/auth/recover/${tokB}`);
  ok('with an authenticator the link opens at once and asks for a code', stB.json?.state === 'ready' && stB.json?.needs_code === true, JSON.stringify(stB.json));
  const noCode = await post(`/v1/auth/recover/${tokB}/complete`, {});
  ok('code required', noCode.status === 422 && noCode.json?.error?.code === 'totp_required');
  const wrong = await post(`/v1/auth/recover/${tokB}/complete`, { code: '123456' });
  ok('wrong code refused', wrong.status === 400 && wrong.json?.error?.code === 'totp_invalid');
  const replay = await post(`/v1/auth/recover/${tokB}/complete`, { code: totp(setup.json.secret) });
  ok('the code that enabled the app cannot be replayed', replay.status === 400, JSON.stringify(replay.json));
  const fine = await post(`/v1/auth/recover/${tokB}/complete`, { code: totp(setup.json.secret, Date.now() + 30_000) });
  ok('recovery completes with the next code', fine.status === 200 && fine.json?.recovery_session === true, JSON.stringify(fine.json));

  // =====================================================================================================
  console.log('\n-- Invite sign-up and account deletion --');
  const A2 = await signIn(a2);
  const AT = A2.json.session_token;
  const inv = await post('/v1/invites', { email: emailC, role: 'ops' }, { token: AT });
  ok('invite created', inv.status === 201, JSON.stringify(inv.json));
  const invTok = inv.json?.link?.split('#/invite/')[1];
  const C = await signUp(emailC, 'Invitee Charlie', undefined, { invite_token: invTok, org_name: undefined });
  ok('invited person signs up', C.rv?.status === 201 && C.rv?.json?.verification?.verified === true, JSON.stringify(C.rv?.json ?? C.ro?.json));
  const meC = await get('/v1/me', { token: C.token });
  ok('the invite address counts as confirmed', meC.json?.email_verified === true && meC.json?.role === 'ops');
  ok('terms acceptance recorded', (await q(`select terms_version from users where email = $1`, [emailC]))[0]?.terms_version === '2026-10-02');
  const delOk = await call('DELETE', '/v1/account', { token: C.token, body: { confirm_email: emailC } });
  ok('a member who is not the only administrator can delete the account', delOk.status === 200 && delOk.json?.deleted === true, JSON.stringify(delOk.json));
  ok('the deleted account is signed out', (await get('/v1/me', { token: C.token })).status === 401);
  const gone = (await q(`select email, name from users where name = 'Deleted user' and email like $1`, [`deleted+%`]));
  ok('name and email are stripped from the user record', gone.length >= 1 && !(await q(`select 1 from users where email = $1`, [emailC])).length);
  const members = await get('/v1/members', { token: AT });
  ok('the deleted person is no longer a member', !members.json?.data?.some((m) => m.name === 'Invitee Charlie'));

  // =====================================================================================================
  console.log('\n-- Staff: organization verification --');
  const vsub = await put('/v1/organization/verification', { legal_name: `Alpha Capital ${stamp} Ltd`, entity_type: 'asset_manager', registration_number: 'AC-1234', country: 'GB', regulator: 'FCA', license_number: 'FRN 123456', address: '10 Alpha Way, London EC2V 8RT', contact_name: 'Recovery Alpha', contact_email: emailA, use_case: 'Distribute tokenized money market funds to professional clients in the UK and Singapore.', expected_annual_volume_usd: 250_000_000, attest: true }, { token: AT });
  ok('verification submitted', vsub.status === 200 && vsub.json?.status === 'pending', JSON.stringify(vsub.json));
  const queue = await staff('GET', '/verifications?status=pending');
  ok('staff queue lists it', queue.json?.data?.some((o) => o.id === A.ws), JSON.stringify(queue.json)?.slice(0, 200));
  ok('staff routes refuse a wrong token', (await call('GET', '/v1/internal/verifications', { token: 'nope' })).status === 401);
  const noNote = await staff('POST', `/verifications/${A.ws}/decision`, { decision: 'reject' });
  ok('a rejection needs a reason', noNote.status === 422 || noNote.status === 400, JSON.stringify(noNote.json));
  const approve = await staff('POST', `/verifications/${A.ws}/decision`, { decision: 'approve', note: 'Checked FCA register.' });
  ok('approved', approve.status === 200 && approve.json?.verification_status === 'verified', JSON.stringify(approve.json));
  ok('customer sees verified', (await get('/v1/organization/verification', { token: AT })).json?.status === 'verified');
  ok('resubmitting a verified organization is refused', (await put('/v1/organization/verification', { legal_name: 'Alpha again', entity_type: 'fintech', registration_number: 'AC-1', country: 'GB', address: '10 Alpha Way, London', contact_name: 'A', contact_email: emailA, use_case: 'Anything long enough to pass the form checks.', attest: true }, { token: AT })).status === 409);

  // =====================================================================================================
  console.log('\n-- Contract, metering, invoices --');
  const prevMonthStart = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
  const settledDay = `${prevMonthStart.slice(0, 8)}10`;
  const mk = await staff('POST', '/contracts', { workspace_id: A.ws, plan: 'platform', platform_fee_cents: 6_000_000, usage_bps: 1.5, tax_bps: 0, net_days: 30, starts_on: prevMonthStart, auto_renew: true });
  ok('staff creates an order form', mk.status === 201 && mk.json?.terms_text?.includes('1.5 basis points'), JSON.stringify(mk.json)?.slice(0, 200));
  const bill0 = await get('/v1/billing', { token: AT });
  ok('customer sees the pending order form', bill0.json?.pending_contract?.id === mk.json?.id && bill0.json?.contract === null, JSON.stringify(bill0.json)?.slice(0, 300));
  const full = await get(`/v1/billing/contracts/${mk.json.id}`, { token: AT });
  ok('order form text is readable', full.json?.terms_text?.includes('LAISSEZ ORDER FORM') && full.json?.terms_sha256?.length === 64);
  const noAgree = await post(`/v1/billing/contracts/${mk.json.id}/accept`, { name: 'Recovery Alpha', title: 'CEO' }, { token: AT });
  ok('acceptance needs the box ticked', noAgree.status === 400);
  const acc = await post(`/v1/billing/contracts/${mk.json.id}/accept`, { name: 'Recovery Alpha', title: 'Chief Executive', agree: true }, { token: AT });
  ok('order form accepted', acc.status === 200 && acc.json?.accepted === true, JSON.stringify(acc.json));
  ok('a second acceptance is refused', (await post(`/v1/billing/contracts/${mk.json.id}/accept`, { name: 'Recovery Alpha', title: 'Chief Executive', agree: true }, { token: AT })).status === 409);
  const bill1 = await get('/v1/billing', { token: AT });
  ok('billing turns active', bill1.json?.status === 'active' && bill1.json?.contract?.accepted_by === 'Recovery Alpha' && bill1.json?.plan === 'platform', JSON.stringify(bill1.json)?.slice(0, 300));

  // A real settlement, then moved into last month so it is billable.
  const dec = await post('/v1/decisions', { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 2_000_000, settle_with: 'USDC' }, { token: AT });
  const st = await post('/v1/settlements', { decision_id: dec.json?.id, force: true }, { token: AT });
  ok('a settlement exists in the organization', dec.status === 201 && st.status < 300, JSON.stringify(st.json)?.slice(0, 200));
  await q(`update settlements set created_at = $2::timestamptz where workspace_id = $1`, [A.ws, `${settledDay}T12:00:00Z`]);
  const [{ value, currency }] = await q(`select sum(d.amount)::float8 as value, min(f.currency) as currency from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker where s.workspace_id = $1 and s.status = 'settled'`, [A.ws]);
  const usd = value * (currency === 'EUR' ? 1.08 : 1);
  const expectUsage = Math.round((usd * 1.5) / 10_000 * 100);
  const run1 = await staff('POST', '/billing/run', {});
  ok('billing run issues the platform and the usage invoice', run1.status === 200 && run1.json?.invoices?.length === 2 && run1.json?.metered_days >= 1, JSON.stringify(run1.json));
  const invs = await get('/v1/billing/invoices', { token: AT });
  const plat = invs.json?.data?.find((i) => i.kind === 'platform'); const use = invs.json?.data?.find((i) => i.kind === 'usage');
  ok('platform invoice is the annual fee', plat?.total_cents === 6_000_000 && plat?.status === 'open' && plat?.period_start === prevMonthStart, JSON.stringify(plat));
  ok(`usage invoice is 1.5 bps of ${Math.round(usd)} USD settled (${expectUsage} cents)`, use?.total_cents === expectUsage && use?.period_start === prevMonthStart, JSON.stringify(use));
  ok('invoice numbers are sequential and unique', /^LZ-\d{4}-\d+$/.test(plat?.number ?? '') && plat?.number !== use?.number);
  const usageRows = await get('/v1/billing/usage', { token: AT });
  ok('metered usage matches the settlement', Math.abs(usageRows.json?.totals?.settled_value_usd - usd) < 0.01 && usageRows.json?.totals?.settlements === 1, JSON.stringify(usageRows.json?.totals));
  const run2 = await staff('POST', '/billing/run', {});
  ok('a second run creates nothing new', run2.json?.invoices?.length === 0, JSON.stringify(run2.json));
  const pdf = await get(`/v1/billing/invoices/${use.id}/pdf`, { token: AT, raw: true });
  const bytes = Buffer.from(await pdf.arrayBuffer());
  ok('invoice PDF is a PDF with the invoice number', pdf.headers.get('content-type') === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.toString('latin1').includes(use.number) && bytes.toString('latin1').trimEnd().endsWith('%%EOF'), `${pdf.status} ${bytes.length}`);
  ok('invoice emails were written', (await q(`select 1 from email_outbox where to_email = $1 and kind = 'billing'`, [emailA])).length >= 2);

  // =====================================================================================================
  console.log('\n-- Dunning and the 402 gate --');
  await q(`update invoices set due_on = current_date - 2 where id = $1`, [use.id]);
  const d1 = await staff('POST', '/billing/run', {});
  ok('day 1 overdue: past due', d1.json?.past_due === 1 && d1.json?.reminders === 1, JSON.stringify(d1.json));
  ok('status shows past due, writes still work', (await get('/v1/billing', { token: AT })).json?.status === 'past_due' && (await post('/v1/billing/quote-request', { plan: 'platform' }, { token: AT })).status !== 402);
  await q(`update invoices set due_on = current_date - 15 where id = $1`, [use.id]);
  const d2 = await staff('POST', '/billing/run', {});
  ok('day 14 overdue: a second reminder, still past due', d2.json?.reminders === 1 && d2.json?.suspended === 0, JSON.stringify(d2.json));
  await q(`update invoices set due_on = current_date - 31 where id = $1`, [use.id]);
  const d3 = await staff('POST', '/billing/run', {});
  ok('day 30 overdue: suspended', d3.json?.suspended === 1, JSON.stringify(d3.json));
  const blocked = await post('/v1/decisions', { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 1_000, settle_with: 'USDC', persist: false }, { token: AT });
  ok('writes answer 402 billing_suspended', blocked.status === 402 && blocked.json?.error?.code === 'billing_suspended', JSON.stringify(blocked.json));
  ok('reads, billing and export still work while suspended', (await get('/v1/investors', { token: AT })).status === 200 && (await get('/v1/billing/invoices', { token: AT })).status === 200 && (await get('/v1/account/export', { token: AT })).status === 200);
  const d4 = await staff('POST', '/billing/run', {});
  ok('dunning is not repeated for the same stage', d4.json?.reminders === 0 && d4.json?.suspended === 0, JSON.stringify(d4.json));
  const paid = await staff('POST', `/invoices/${use.id}/paid`, { note: 'Wire received 2026-10-02, ref TEST-1' });
  ok('staff marks the invoice paid', paid.status === 200);
  ok('payment lifts the suspension', (await get('/v1/billing', { token: AT })).json?.status === 'active');
  const unblocked = await post('/v1/decisions', { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 1_000, settle_with: 'USDC', persist: false }, { token: AT });
  ok('writes work again', unblocked.status !== 402, JSON.stringify(unblocked.json)?.slice(0, 200));
  ok('a paid invoice cannot be paid twice', (await staff('POST', `/invoices/${use.id}/paid`, { note: 'again please' })).status === 409);

  // =====================================================================================================
  console.log('\n-- Stripe webhook --');
  await q(`update invoices set stripe_invoice_id = $2 where id = $1`, [plat.id, `in_localtest_${stamp}`]);
  const evt = JSON.stringify({ id: `evt_${stamp}`, type: 'invoice.paid', data: { object: { id: `in_localtest_${stamp}`, metadata: { laissez_invoice: plat.id } } } });
  const sign = (body, t = Math.floor(Date.now() / 1000), secret = WH_SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  ok('wrong signature refused', (await call('POST', '/v1/billing/stripe/webhook', { body: evt, headers: { 'stripe-signature': sign(evt, undefined, 'whsec_wrong') } })).status === 400);
  ok('stale timestamp refused', (await call('POST', '/v1/billing/stripe/webhook', { body: evt, headers: { 'stripe-signature': sign(evt, Math.floor(Date.now() / 1000) - 3600) } })).status === 400);
  const wh = await call('POST', '/v1/billing/stripe/webhook', { body: evt, headers: { 'stripe-signature': sign(evt) } });
  ok('signed invoice.paid marks the invoice paid', wh.status === 200 && wh.json?.result === 'marked paid', JSON.stringify(wh.json));
  const wh2 = await call('POST', '/v1/billing/stripe/webhook', { body: evt, headers: { 'stripe-signature': sign(evt) } });
  ok('the same event is processed once', wh2.json?.duplicate === true);
  ok('invoice is paid in the customer view', (await get(`/v1/billing/invoices/${plat.id}`, { token: AT })).json?.status === 'paid');
  const unknown = JSON.stringify({ id: `evt_${stamp}_2`, type: 'invoice.paid', data: { object: { id: 'in_not_ours' } } });
  ok('events for other invoices are ignored', (await call('POST', '/v1/billing/stripe/webhook', { body: unknown, headers: { 'stripe-signature': sign(unknown) } })).json?.result?.startsWith('ignored'));

  // =====================================================================================================
  console.log('\n-- Revenue metrics, quotes, void --');
  const rev = await staff('GET', '/revenue');
  ok('revenue: customers and platform ARR', rev.json?.customers >= 1 && rev.json?.arr_platform_cents >= 6_000_000 && rev.json?.value_settled_usd?.all_time > 0, JSON.stringify(rev.json)?.slice(0, 300));
  ok('revenue: per customer row for Alpha', rev.json?.per_customer?.some((c) => c.id === A.ws && c.paid_12m > 0));
  const quotes = await staff('GET', '/quotes');
  ok('quote requests listed for staff', Array.isArray(quotes.json?.data));
  // A voided invoice never counts and clears a past-due state.
  const voidId = `inv_void_${stamp}`;
  await q(`insert into invoices (id, workspace_id, number, kind, period_start, period_end, status, lines, subtotal_cents, tax_cents, total_cents, issued_on, due_on)
    values ($2, $1, 'LZ-T-' || $2, 'usage', '2000-01-01', '2000-01-31', 'open', '[]', 100, 0, 100, current_date - 40, current_date - 10)`, [A.ws, voidId]);
  const vd = await staff('POST', `/invoices/${voidId}/void`, { reason: 'Issued in error' });
  ok('staff can void an open invoice', vd.status === 200 && (await q(`select status from invoices where id = $1`, [voidId]))[0].status === 'void');

  // =====================================================================================================
  console.log('\n-- Production mode --');
  const startServer = async (port, extra) => {
    const child = spawn('node', [path.join(HERE, '..', 'server.mjs')], { env: { ...process.env, PORT: String(port), LZ_OVERRIDE_LAISSEZ_MODE: 'production', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return { child, log: () => log }; } catch { /* starting */ } }
    child.kill(); throw new Error(`server on ${port} did not start:\n${log}`);
  };
  let s1, s2;
  try {
    s1 = await startServer(8788, {});
    const P1 = 'http://127.0.0.1:8788';
    const closed = await call('POST', '/v1/auth/register/options', { base: P1, body: { email: `prod-closed+${stamp}@laissez.test`, name: 'Prod Closed', org_name: 'Prod Closed Org', accept_terms: true } });
    ok('production without mail closes sign-up', closed.status === 503 && closed.json?.error?.code === 'email_not_configured', JSON.stringify(closed.json));
    ok('config says sign-up is closed', (await get('/v1/auth/config', { base: P1 })).json?.signup_open === false);
    ok('sandboxes do not exist in production', (await call('POST', '/v1/sandboxes', { base: P1, body: {} })).status === 404);
    s1.child.kill();
    s2 = await startServer(8789, { LZ_OVERRIDE_RESEND_API_KEY: 're_localtest', LZ_OVERRIDE_EMAIL_FROM: 'Laissez <no-reply@laissez.test>' });
    const P2 = 'http://127.0.0.1:8789';
    const emailP = `prod+${stamp}@laissez.test`;
    const PA = await signUp(emailP, 'Prod Person', `Prod Org ${stamp}`, {}, P2);
    ok('sign-up works once mail is configured', PA.rv?.status === 201 && PA.rv?.json?.verification?.required === true && PA.rv?.json?.verification?.verified === false, JSON.stringify(PA.rv?.json ?? PA.ro?.json));
    ok('no confirmation link is exposed in production', PA.rv?.json?.verification?.dev_link === null);
    const gate = await get('/v1/investors', { token: PA.token, base: P2 });
    ok('an unconfirmed account is held at the door', gate.status === 403 && gate.json?.error?.code === 'email_not_verified', JSON.stringify(gate.json));
    const meGate = await get('/v1/me', { token: PA.token, base: P2 });
    ok('but it can see itself and is told what is missing', meGate.status === 200 && meGate.json?.verification_required === true);
    const plink = await outboxLink(emailP, 'verify_email'); const ptok = tokenOf(plink, '#/verify-email/');
    ok('the confirmation email is in the outbox', !!ptok, String(plink));
    ok('confirming opens the account', (await call('POST', '/v1/auth/verify-email', { base: P2, body: { token: ptok } })).status === 200 && (await get('/v1/investors', { token: PA.token, base: P2 })).status === 200);
    const demo = await q(`select count(*)::int as n from investors where workspace_id = $1`, [PA.ws]);
    ok('no fictional seed data in a production organization', demo[0].n === 0);
    const keyBlocked = await post('/v1/api-keys', { name: 'First key' }, { token: PA.token, base: P2 });
    ok('an unverified organization cannot create API keys', keyBlocked.status === 403 && keyBlocked.json?.error?.code === 'org_not_verified', JSON.stringify(keyBlocked.json));
    const settleBlocked = await post('/v1/settlements', { decision_id: 'x' }, { token: PA.token, base: P2 });
    ok('nor settle', settleBlocked.status === 403 && settleBlocked.json?.error?.code === 'org_not_verified');
    ok('reads stay open', (await get('/v1/api-keys', { token: PA.token, base: P2 })).status === 200);
    const ct = await call('POST', '/v1/internal/contracts', { base: P2, token: STAFF_TOKEN, body: { workspace_id: PA.ws, plan: 'pilot', platform_fee_cents: 0, usage_bps: 0 } });
    const acceptEarly = await post(`/v1/billing/contracts/${ct.json?.id}/accept`, { name: 'Prod Person', title: 'Founder', agree: true }, { token: PA.token, base: P2 });
    ok('an order form cannot be accepted before verification', acceptEarly.status === 403 && acceptEarly.json?.error?.code === 'org_not_verified', JSON.stringify(acceptEarly.json));
    await call('PUT', '/v1/organization/verification', { token: PA.token, base: P2, body: { legal_name: `Prod Org ${stamp} Inc`, entity_type: 'fintech', registration_number: 'P-1', country: 'US', address: '1 Prod Road, New York NY 10001', contact_name: 'Prod Person', contact_email: emailP, use_case: 'Settle tokenized funds for institutional investors.', attest: true } });
    await call('POST', `/v1/internal/verifications/${PA.ws}/decision`, { base: P2, token: STAFF_TOKEN, body: { decision: 'approve' } });
    const keyOk = await post('/v1/api-keys', { name: 'First key' }, { token: PA.token, base: P2 });
    ok('after verification the API key is created', keyOk.status === 201, JSON.stringify(keyOk.json)?.slice(0, 200));
    const acceptOk = await post(`/v1/billing/contracts/${ct.json?.id}/accept`, { name: 'Prod Person', title: 'Founder', agree: true }, { token: PA.token, base: P2 });
    ok('and the pilot order form can be accepted', acceptOk.status === 200, JSON.stringify(acceptOk.json));
  } catch (e) { fail++; console.log('FAIL production mode block', e.message); }
  finally { s1?.child.kill(); s2?.child.kill(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await db.end().catch(() => {}); process.exit(1); });
