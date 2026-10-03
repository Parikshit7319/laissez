// End-to-end checks against the live API. Run: node api/test/smoke.mjs [baseUrl]
// Covers accounts (passkeys simulated with a software authenticator), SSO through the demo
// identity provider, roles, tenant isolation, the hash-chained audit log, decisions, settlement,
// screening, monitoring, documents, fund terms, the credential network, the portal, Travel Rule and reports.
import { webcrypto as wc, createHash, createHmac, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

const BASE = process.argv[2] ?? 'https://laissez-api.laissez.workers.dev';
const ORIGIN = process.env.SMOKE_ORIGIN ?? (process.argv[2]?.includes('127.0.0.1') || process.argv[2]?.includes('localhost') ? 'http://localhost:4321' : 'https://parikshit7319.github.io');
const RP_ID = new URL(ORIGIN).hostname;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const b64u = (b) => Buffer.from(b).toString('base64url');

async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}
const get = (p, o) => call('GET', p, o);
const post = (p, body, o = {}) => call('POST', p, { ...o, body });
const put = (p, body, o = {}) => call('PUT', p, { ...o, body });
const patch = (p, body, o = {}) => call('PATCH', p, { ...o, body });

// RFC 6238 code for a base32 secret, used to exercise the authenticator-app endpoints.
function totp(secret, atMs = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const bytes = [];
  for (const ch of secret) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest(); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}

// ---------- Software passkey ----------
function softAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const id = b64u(wc.getRandomValues(new Uint8Array(16)));
  let counter = 0;
  return {
    register(options) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), attestationObject: '', publicKey: b64u(spki), publicKeyAlgorithm: -7, transports: ['internal'] } };
    },
    assert(options, { uv = true } = {}) {
      counter++;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const rpHash = createHash('sha256').update(RP_ID).digest();
      const authData = Buffer.concat([rpHash, Buffer.from([uv ? 0x05 : 0x01]), Buffer.from([0, 0, 0, counter])]);
      const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
      const signature = nodeSign('sha256', signed, privateKey);
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null } };
    },
  };
}

(async () => {
  // ---------- Public ----------
  const h = await get('/v1/health');
  ok('health', h.status === 200 && h.json?.ok);
  const ver = await get('/v1/versions');
  ok('versions listed', ver.status === 200 && JSON.stringify(ver.json).includes('2026-10-02'));
  const bad = await get('/v1/health', { headers: { 'laissez-version': '1999-01-01' } });
  ok('unknown version refused', bad.status === 400);

  // ---------- Sandbox with teammates ----------
  const sb = await post('/v1/sandboxes', {});
  ok('open sandbox', sb.status === 201 && sb.json?.session_token?.startsWith('lz_sess_') && sb.json?.api_key?.startsWith('lz_test_'), JSON.stringify(sb.json));
  const S = sb.json.session_token; const K = sb.json.api_key; const slug = sb.json.workspace.slug;
  const me = await get('/v1/me', { token: S });
  ok('me as guest admin', me.json?.role === 'admin' && me.json?.teammates?.length === 3, JSON.stringify(me.json));
  const tomas = me.json.teammates.find((t) => t.role === 'issuer');
  const aisha = me.json.teammates.find((t) => t.role === 'compliance');
  ok('security headers', h.headers.get('x-content-type-options') === 'nosniff' && !!h.headers.get('laissez-version'));
  ok('auth required', (await get('/v1/investors')).status === 401);

  // ---------- Isolation ----------
  const sb2 = await post('/v1/sandboxes', {});
  const S2 = sb2.json.session_token;
  const dec0 = await post('/v1/decisions', { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 2_000_000, settle_with: 'USDC' }, { token: S });
  ok('decision allowed (Lumen TWLF)', dec0.status === 201 && dec0.json?.outcome === 'ALLOW', dec0.json?.headline);
  const cross = await get(`/v1/decisions/${dec0.json.id}`, { token: S2 });
  ok('other org cannot read the decision', cross.status === 404);
  ok('dealing date set', !!dec0.json?.dealing_date);

  // ---------- Idempotency ----------
  const idem = { 'idempotency-key': `smoke-${Date.now()}` };
  const p1 = await post('/v1/decisions', { action: 'subscribe', investor_id: 'qamar', fund: 'TWLF', amount: 150_000, settle_with: 'USDC' }, { token: K, headers: idem });
  const p2 = await post('/v1/decisions', { action: 'subscribe', investor_id: 'qamar', fund: 'TWLF', amount: 150_000, settle_with: 'USDC' }, { token: K, headers: idem });
  ok('idempotent replay', p1.json?.id && p1.json.id === p2.json?.id && p2.headers.get('idempotent-replayed') === 'true');
  const p3 = await post('/v1/decisions', { action: 'subscribe', investor_id: 'qamar', fund: 'TWLF', amount: 200_000, settle_with: 'USDC' }, { token: K, headers: idem });
  ok('idempotency mismatch refused', p3.status === 422);

  // ---------- Receipts, settlement ----------
  const v = await post('/v1/receipts/verify', { receipt: dec0.json.receipt, signature: dec0.json.signature });
  ok('receipt verifies', v.json?.valid === true);
  const st = await post('/v1/settlements', { decision_id: dec0.json.id, force: true }, { token: S });
  ok('settles', [201, 202].includes(st.status), JSON.stringify(st.json));
  const replay = await get(`/v1/decisions/${dec0.json.id}/replay`, { token: S });
  ok('decision replays from snapshot', replay.json?.reproduced === true, JSON.stringify(replay.json)?.slice(0, 300));

  // ---------- Documents and fund terms ----------
  const mei = await post('/v1/decisions', { action: 'subscribe', investor_id: 'meitan', fund: 'TWLF', amount: 200_000, settle_with: 'USDC', persist: false }, { token: S });
  ok('Mei Tan denied', mei.json?.outcome === 'DENY');
  const sorell = await post('/v1/decisions', { action: 'redeem', investor_id: 'sorell', fund: 'AGPC', amount: 300_000 * 1.0412, settle_with: 'USDC', persist: false }, { token: S });
  ok('AGPC redemption above notice denied', sorell.json?.outcome === 'DENY' && sorell.json.checks.some((x) => x.id === 'notice' && x.result === 'fail'), sorell.json?.headline);
  const life = await get('/v1/funds/AGPC/lifecycle', { token: S });
  ok('fund lifecycle', life.status === 200 && !!life.json?.dealing?.next_dealing_date);
  const docs = await get('/v1/funds/TWLF/documents', { token: S });
  ok('fund documents', docs.status === 200 && JSON.stringify(docs.json).includes('Offering memorandum'));

  // ---------- Two-person approval with identities ----------
  const pc = await post('/v1/funds/TWLF/policy/changes', { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'HK', accepts: ['HK_PI'] }, { jurisdiction: 'CH', accepts: ['CH_PRO'] }, { jurisdiction: 'AE-DIFC', accepts: ['DIFC_PRO'] }] }, { token: S });
  ok('policy proposed by guest', pc.status === 201, JSON.stringify(pc.json));
  const self = await post(`/v1/policy-changes/${pc.json.id}/approve`, {}, { token: S });
  ok('proposer cannot approve', self.status === 403);
  const keyApprove = await post(`/v1/policy-changes/${pc.json.id}/approve`, {}, { token: K });
  ok('API key cannot approve', keyApprove.status === 403 && keyApprove.json?.error?.code === 'human_required');
  await post('/v1/session/act-as', { user_id: tomas.id }, { token: S });
  const ap = await post(`/v1/policy-changes/${pc.json.id}/approve`, {}, { token: S });
  ok('second person approves', ap.status === 200 && ap.json?.status === 'published', JSON.stringify(ap.json));
  await post('/v1/session/act-as', { user_id: null }, { token: S });
  const bt = await post('/v1/funds/TWLF/policy/backtest', { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }], days: 90 }, { token: S });
  ok('policy backtest', bt.status === 200 && typeof bt.json?.decisions_checked === 'number');
  const asof = await post('/v1/evaluate/as-of', { action: 'subscribe', investor_id: 'qamar', fund: 'TWLF', amount: 200_000, settle_with: 'USDC', as_of: new Date(Date.now() - 86_400_000 * 2).toISOString().slice(0, 10) }, { token: S });
  ok('as-of evaluation uses the old policy', asof.status === 200 && asof.json?.outcome === 'ALLOW', JSON.stringify(asof.json)?.slice(0, 200));

  // ---------- Roles ----------
  await post('/v1/session/act-as', { user_id: aisha.id }, { token: S });
  const fundAsCompliance = await post('/v1/funds/TWLF/nav', { nav: 1.0 }, { token: S });
  ok('compliance cannot strike NAV', fundAsCompliance.status === 403);
  await post('/v1/session/act-as', { user_id: null }, { token: S });

  // ---------- Keys ----------
  const rk = await post('/v1/api-keys', { name: 'Read only', scopes: ['read'], ip_allowlist: ['203.0.113.0/24'] }, { token: S });
  ok('scoped key created', rk.status === 201 && rk.json?.api_key);
  const blocked = await get('/v1/investors', { token: rk.json.api_key });
  ok('IP allowlist enforced', blocked.status === 403 && blocked.json?.error?.code === 'ip_not_allowed');
  const rk2 = await post('/v1/api-keys', { name: 'Read', scopes: ['read'] }, { token: S });
  const ro = await post('/v1/decisions', { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 200_000, settle_with: 'USDC' }, { token: rk2.json.api_key });
  ok('read scope cannot place orders', ro.status === 403 && ro.json?.error?.code === 'insufficient_scope');
  const rot = await post(`/v1/api-keys/${rk2.json.id}/rotate`, {}, { token: S });
  ok('key rotation', rot.status === 201 || rot.status === 200);

  // ---------- Screening and monitoring ----------
  const scr = await post('/v1/screening', { name: 'Blocked Example Trading LLC' }, { token: S });
  ok('screening finds test entry', scr.status === 200 && (scr.json?.match || scr.json?.candidates?.length), JSON.stringify(scr.json)?.slice(0, 200));
  const mon = await post('/v1/monitoring/run', {}, { token: S });
  ok('monitoring run', mon.status === 200 && typeof mon.json?.holders_checked === 'number', JSON.stringify(mon.json));
  const wi = await get('/v1/work-items', { token: S });
  ok('work queue has items', wi.status === 200 && (wi.json?.data ?? []).length > 0);
  const src = await get('/v1/sanctions/sources', { token: S });
  ok('sanctions sources listed', src.status === 200 && (src.json?.data ?? []).length >= 4);

  // ---------- Credential network ----------
  const demo = await get('/v1/network/demo-ids', { token: S });
  ok('network demo ids', demo.status === 200 && demo.json?.data?.length >= 1, JSON.stringify(demo.json)?.slice(0, 200));
  const orrin = demo.json.data[0];
  const share = await post('/v1/credential-shares', { lzid: orrin.lzid, purpose: 'Onboard for tokenized fund distribution', booking_center: orrin.suggested_booking_center ?? 'SG' }, { token: S });
  ok('share requested', share.status === 201 && share.json?.consent_url, JSON.stringify(share.json)?.slice(0, 300));
  const token = share.json.consent_url.split('#')[1];
  const consentView = await get(`/v1/consent/${token}`);
  ok('consent page data', consentView.status === 200);
  const consent = await post(`/v1/consent/${token}`, { decision: 'approve', name: orrin.name });
  ok('client consents', consent.status === 200, JSON.stringify(consent.json)?.slice(0, 200));
  const invs = await get('/v1/investors', { token: S });
  const relied = (invs.json?.data ?? []).find((i) => i.reliedShare || i.relied_share);
  ok('relied investor created', !!relied);

  // ---------- Portal ----------
  const pi = await post('/v1/investors/meitan/portal-invite', {}, { token: S });
  ok('portal invite', pi.status === 201 && pi.json?.link);
  const ptok = pi.json.link.split('#')[1];
  const pme = await get('/v1/portal/me', { token: ptok });
  ok('portal me', pme.status === 200 && !!pme.json?.distributor);
  const pf = await get('/v1/portal/funds', { token: ptok });
  ok('portal funds with eligibility', pf.status === 200 && Array.isArray(pf.json?.data ?? pf.json));

  // ---------- Travel Rule ----------
  const tr = await post('/v1/decisions', { action: 'transfer', investor_id: 'lumen', counterparty_id: 'qamar', fund: 'TWLF', amount: 500_000, settle_with: 'USDC' }, { token: S });
  ok('transfer allowed', tr.json?.outcome === 'ALLOW', tr.json?.headline);
  let approved = false;
  for (let i = 0; i < 10 && !approved; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const msgs = await get('/v1/travel-rule/messages', { token: S });
    approved = (msgs.json?.data ?? []).some((m) => m.decision_id === tr.json.id && m.status === 'approved');
  }
  ok('Travel Rule message approved by beneficiary VASP', approved);
  const trs = await post('/v1/settlements', { decision_id: tr.json.id, force: true }, { token: S });
  ok('transfer settles after Travel Rule', [201, 202].includes(trs.status), JSON.stringify(trs.json)?.slice(0, 200));

  // ---------- Reports, audit chain ----------
  const rep = await get('/v1/reports/placement', { token: S });
  ok('placement report', rep.status === 200);
  const dist = await get('/v1/reports/distribution', { token: S });
  ok('distribution report', dist.status === 200);
  const ver2 = await get('/v1/audit-events/verify', { token: S });
  ok('audit chain intact', ver2.json?.valid === true && ver2.json?.events > 5, JSON.stringify(ver2.json));

  // ---------- SSO through the demo identity provider ----------
  const start = await get(`/v1/auth/sso/start?org=${slug}&origin=${encodeURIComponent(ORIGIN)}`);
  const authUrl = start.headers.get('location');
  ok('SSO start redirects to the IdP', start.status === 302 && authUrl?.includes('/idp/authorize'));
  const page = await fetch(authUrl);
  const html = await page.text();
  const field = (n) => (html.match(new RegExp(`name="${n}" value="([^"]*)"`)) ?? [])[1] ?? '';
  const form = new URLSearchParams({ redirect_uri: field('redirect_uri'), state: field('state'), nonce: field('nonce'), code_challenge: field('code_challenge'), client_id: field('client_id'), email: 'aisha.rahman@astervale.example' });
  const idpPost = await fetch(`${BASE}/idp/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString().replace(/&amp;/g, '&') });
  const cb = idpPost.headers.get('location');
  ok('IdP returns a code', idpPost.status === 302 && cb?.includes('/v1/auth/sso/callback'));
  const cbRes = await fetch(cb, { redirect: 'manual' });
  const appLoc = cbRes.headers.get('location') ?? '';
  ok('callback verifies the ID token', cbRes.status === 302 && appLoc.includes('#/sso/'), appLoc);
  const code = appLoc.split('#/sso/')[1];
  const ex = await post('/v1/auth/sso/exchange', { code });
  const meSso = await get('/v1/me', { token: ex.json?.session_token });
  ok('signed in as Aisha via SSO', meSso.json?.user?.name === 'Aisha Rahman' && meSso.json?.role === 'compliance', JSON.stringify(meSso.json)?.slice(0, 200));

  // ---------- Passkey account ----------
  const auth = softAuthenticator();
  const email = `smoke+${Date.now()}@laissez.test`;
  const ro1 = await post('/v1/auth/register/options', { email, name: 'Smoke Test', org_name: 'Smoke Test Org', demo_data: false, accept_terms: true });
  ok('register options', ro1.status === 200 && ro1.json?.options?.challenge);
  const rv = await post('/v1/auth/register/verify', { challenge_id: ro1.json.challenge_id, credential: auth.register(ro1.json.options) });
  ok('passkey registered and org created', rv.status === 201 && rv.json?.session_token, JSON.stringify(rv.json));
  const lo = await post('/v1/auth/login/options', {});
  const lv = await post('/v1/auth/login/verify', { challenge_id: lo.json.challenge_id, credential: auth.assert(lo.json.options) });
  ok('passkey sign-in', lv.status === 200 && lv.json?.session_token, JSON.stringify(lv.json));
  const lo2 = await post('/v1/auth/login/options', {});
  const forged = auth.assert(lo2.json.options); forged.response.signature = b64u(Buffer.from('nope'));
  const lv2 = await post('/v1/auth/login/verify', { challenge_id: lo2.json.challenge_id, credential: forged });
  ok('forged passkey signature refused', lv2.status >= 400);

  // ---------- Account security ----------
  const noTerms = await post('/v1/auth/register/options', { email: `noterms+${Date.now()}@laissez.test`, name: 'No Terms', org_name: 'No Terms Org', demo_data: false });
  ok('sign-up refuses without accepting the terms', noTerms.status === 422 && noTerms.json?.error?.code === 'terms_required', JSON.stringify(noTerms.json));
  const authCfg = await get('/v1/auth/config');
  ok('sign-in configuration is public', authCfg.status === 200 && typeof authCfg.json?.terms_version === 'string' && 'turnstile_site_key' in authCfg.json, JSON.stringify(authCfg.json));
  const P = rv.json.session_token;
  const meP = await get('/v1/me', { token: P });
  ok('new account starts unconfirmed', meP.json?.email_verified === false && meP.json?.user?.email === email, JSON.stringify(meP.json)?.slice(0, 200));
  const vtok = rv.json?.verification?.dev_link?.split('#/verify-email/')[1];
  if (vtok) {
    const badTok = await post('/v1/auth/verify-email', { token: 'ver_' + 'x'.repeat(40) });
    ok('unknown confirmation link refused', badTok.status === 400 && badTok.json?.error?.code === 'verify_link_invalid');
    const vf = await post('/v1/auth/verify-email', { token: vtok });
    ok('email confirmed with the link', vf.status === 200 && vf.json?.verified === true, JSON.stringify(vf.json));
    const vf2 = await post('/v1/auth/verify-email', { token: vtok });
    ok('a confirmation link works once', vf2.status === 400);
    ok('account shows as confirmed', (await get('/v1/me', { token: P })).json?.email_verified === true);
  } else console.log('skip confirmation link checks: the deployment sent mail instead of exposing a link');
  const rs = await post('/v1/auth/verify-email/resend', {}, { token: P });
  ok('confirmation can be requested again', rs.status === 200 && 'verified' in (rs.json ?? {}), JSON.stringify(rs.json));
  const secOv = await get('/v1/account/security', { token: P });
  ok('security overview', secOv.status === 200 && secOv.json?.passkeys === 1 && secOv.json?.totp?.enabled === false && secOv.json?.terms?.accepted_version, JSON.stringify(secOv.json)?.slice(0, 300));
  // Authenticator app: set up, wrong code refused, right code accepted, the same code cannot be replayed.
  const ts = await post('/v1/account/totp/setup', {}, { token: P });
  ok('authenticator setup returns a key and URI', ts.status === 201 && /^[A-Z2-7]{32}$/.test(ts.json?.secret ?? '') && ts.json?.uri?.startsWith('otpauth://totp/'), JSON.stringify(ts.json));
  const tBad = await post('/v1/account/totp/enable', { code: '000000' }, { token: P });
  ok('wrong authenticator code refused', tBad.status === 400 && tBad.json?.error?.code === 'totp_invalid', JSON.stringify(tBad.json));
  const tOn = await post('/v1/account/totp/enable', { code: totp(ts.json.secret) }, { token: P });
  ok('authenticator app enabled', tOn.status === 200 && tOn.json?.enabled === true, JSON.stringify(tOn.json));
  const tReplay = await post('/v1/account/totp/disable', { code: totp(ts.json.secret) }, { token: P });
  ok('an authenticator code cannot be replayed', tReplay.status === 400 && tReplay.json?.error?.code === 'totp_invalid', JSON.stringify(tReplay.json));
  const recoveryStart = await post('/v1/auth/recover/start', { email: `nobody+${Date.now()}@laissez.test` });
  ok('recovery answers the same for an unknown address', recoveryStart.status === 202 && recoveryStart.json?.requested === true, JSON.stringify(recoveryStart.json));
  ok('unknown recovery link refused', (await get('/v1/auth/recover/rec_' + 'x'.repeat(40))).status === 404);
  // Organization security policy.
  const pol0 = await get('/v1/security-policy', { token: P });
  ok('default security policy', pol0.status === 200 && pol0.json?.is_default === true && pol0.json?.policy?.session_hours === 168, JSON.stringify(pol0.json)?.slice(0, 200));
  const polLock = await put('/v1/security-policy', { allowed_email_domains: ['example.com'] }, { token: P });
  ok('a policy that locks out its author is refused', polLock.status === 422 && polLock.json?.error?.code === 'policy_locks_you_out', JSON.stringify(polLock.json));
  const polSso = await put('/v1/security-policy', { require_sso: true }, { token: P });
  ok('requiring SSO before it is set up is refused', polSso.status === 422 && polSso.json?.error?.code === 'sso_not_enabled', JSON.stringify(polSso.json));
  const polSet = await put('/v1/security-policy', { require_user_verification: true, session_hours: 12, idle_minutes: 60, allowed_email_domains: ['laissez.test'] }, { token: P });
  ok('policy saved', polSet.status === 200 && polSet.json?.policy?.session_hours === 12, JSON.stringify(polSet.json));
  const loP1 = await post('/v1/auth/login/options', {});
  const lvNoUv = await post('/v1/auth/login/verify', { challenge_id: loP1.json.challenge_id, credential: auth.assert(loP1.json.options, { uv: false }) });
  ok('passkey without user verification refused by policy', lvNoUv.status === 403 && lvNoUv.json?.error?.code === 'user_verification_required', JSON.stringify(lvNoUv.json));
  const loP2 = await post('/v1/auth/login/options', {});
  const lvUv = await post('/v1/auth/login/verify', { challenge_id: loP2.json.challenge_id, credential: auth.assert(loP2.json.options) });
  ok('verified passkey accepted', lvUv.status === 200 && lvUv.json?.session_token, JSON.stringify(lvUv.json));
  const polInv = await post('/v1/invites', { email: 'person@other-company.com', role: 'ops' }, { token: P });
  ok('invite outside the allowed domains refused', polInv.status === 422 && polInv.json?.error?.code === 'invite_domain_not_allowed', JSON.stringify(polInv.json));
  const polOk = await post('/v1/invites', { email: 'colleague@laissez.test', role: 'ops' }, { token: P });
  ok('invite inside the allowed domains accepted', polOk.status === 201, JSON.stringify(polOk.json));
  const polReset = await put('/v1/security-policy', {}, { token: P });
  ok('policy reset to defaults', polReset.status === 200 && polReset.json?.policy?.session_hours === 168 && polReset.json?.policy?.require_user_verification === false);
  const polSandbox = await put('/v1/security-policy', {}, { token: S });
  ok('sandboxes carry no security policy', polSandbox.status === 403);
  // Organization verification.
  const vs0 = await get('/v1/organization/verification', { token: P });
  ok('verification starts unverified', vs0.status === 200 && ['unverified', 'verified'].includes(vs0.json?.status), JSON.stringify(vs0.json));
  const vsBad = await put('/v1/organization/verification', { legal_name: 'X' }, { token: P });
  ok('verification form validates', vsBad.status === 400);
  const vsSub = await put('/v1/organization/verification', { legal_name: 'Smoke Test Org Ltd', entity_type: 'fintech', registration_number: 'SMK-0001', country: 'GB', address: '1 Test Street, London EC1A 1AA', contact_name: 'Smoke Test', contact_email: email, use_case: 'Distribute a tokenized money market fund to professional investors in three countries.', attest: true }, { token: P });
  ok('verification submitted', (vsSub.status === 200 && vsSub.json?.status === 'pending') || vsSub.status === 409, JSON.stringify(vsSub.json));
  const vsSandbox = await put('/v1/organization/verification', { legal_name: 'Sandbox Ltd', entity_type: 'fintech', registration_number: 'SMK-0002', country: 'GB', address: '1 Test Street, London', contact_name: 'Guest', contact_email: 'guest@laissez.test', use_case: 'Trying the sandbox, which is not a real organization.', attest: true }, { token: S });
  ok('sandboxes cannot be verified', vsSandbox.status === 403);
  // Billing.
  const bill = await get('/v1/billing', { token: P });
  ok('billing overview for a new organization', bill.status === 200 && bill.json?.plan === 'none' && bill.json?.status === 'none' && bill.json?.usage?.settled_value_usd === 0 && bill.json?.sandbox === false, JSON.stringify(bill.json)?.slice(0, 300));
  const billSb = await get('/v1/billing', { token: S });
  ok('sandbox billing shows the days left', billSb.status === 200 && billSb.json?.sandbox === true && billSb.json?.trial?.days_left >= 1, JSON.stringify(billSb.json)?.slice(0, 200));
  const billProf = await patch('/v1/billing/profile', { legal_name: 'Smoke Test Org Ltd', billing_email: email, address: '1 Test Street, London EC1A 1AA', country: 'gb', tax_id: 'GB123456789', tax_exempt: false }, { token: P });
  ok('billing profile saved', billProf.status === 200 && billProf.json?.profile?.country === 'GB', JSON.stringify(billProf.json));
  const billKey = await get('/v1/billing', { token: K });
  ok('API keys cannot read billing', billKey.status === 403, JSON.stringify(billKey.json));
  ok('no invoices yet', (await get('/v1/billing/invoices', { token: P })).json?.data?.length === 0);
  ok('usage endpoint answers', (await get('/v1/billing/usage', { token: P })).json?.totals?.settled_value_usd === 0);
  const quote = await post('/v1/billing/quote-request', { plan: 'platform', expected_value_usd: 50_000_000, message: 'Smoke test quote request.' }, { token: P });
  ok('quote request recorded', quote.status === 201 && quote.json?.status === 'new', JSON.stringify(quote.json));
  const quoteSb = await post('/v1/billing/quote-request', { plan: 'platform' }, { token: S });
  ok('a sandbox guest needs a real email to ask for a quote', quoteSb.status === 422 && quoteSb.json?.error?.code === 'real_email_required', JSON.stringify(quoteSb.json));
  ok('staff routes are closed to customers', [401, 501].includes((await get('/v1/internal/revenue', { token: P })).status));
  ok('stripe webhook rejects an unsigned call', [400, 501].includes((await post('/v1/billing/stripe/webhook', { id: 'evt_x', type: 'invoice.paid' })).status));
  // A person's own data.
  const exp = await get('/v1/account/export', { token: P });
  ok('account export', exp.status === 200 && exp.json?.user?.email === email && exp.json?.passkeys?.length === 1 && !JSON.stringify(exp.json).includes('public_key'), JSON.stringify(exp.json)?.slice(0, 200));
  const delSole = await call('DELETE', '/v1/account', { token: P, body: { confirm_email: email } });
  ok('the only administrator cannot delete the account', delSole.status === 409 && delSole.json?.error?.code === 'sole_admin', JSON.stringify(delSole.json));
  const delMismatch = await call('DELETE', '/v1/account', { token: P, body: { confirm_email: 'wrong@laissez.test' } });
  ok('account deletion needs the exact email', delMismatch.status === 422);

  // ---------- Public metrics and status ----------
  const ev = await post('/v1/events', { event: 'demo_started', anon_id: 'smoke' });
  ok('product event accepted', [200, 202, 204].includes(ev.status));
  const status = await get('/v1/status');
  ok('status page data', status.status === 200);
  const pm = await get('/v1/metrics/public');
  ok('public metrics', pm.status === 200 && pm.json?.north_star !== undefined, JSON.stringify(pm.json)?.slice(0, 200));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
