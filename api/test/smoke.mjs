// End-to-end API test against a deployed Laissez API. Usage: node api/test/smoke.mjs [baseUrl]
const A = process.argv[2] ?? 'https://laissez-api.laissez.workers.dev';
let key = '';
let pass = 0, fail = 0;
const call = async (method, path, body, auth = true) => {
  const r = await fetch(A + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const h = await call('GET', '/v1/health'); check('health', h.j.ok === true);
const s = await call('POST', '/v1/sandboxes', {}); check('open sandbox', s.status === 201 && s.j.api_key?.startsWith('lz_test_'), JSON.stringify(s.j)); key = s.j.api_key;
const noauth = await fetch(A + '/v1/investors'); check('auth required', noauth.status === 401);
const inv = await call('GET', '/v1/investors'); check('six seeded clients', inv.j.data?.length === 6);
const d1 = await call('POST', '/v1/decisions', { action: 'subscribe', investor_id: 'lumen', fund: 'TWLF', amount: 2000000, settle_with: 'USDC' });
check('Lumen subscribe allowed', d1.j.outcome === 'ALLOW', d1.j.headline); check('two binding rules', d1.j.binding_rules?.length === 2); check('receipt signed', !!d1.j.signature);
const v = await call('POST', '/v1/receipts/verify', { receipt: d1.j.receipt, signature: d1.j.signature }, false); check('receipt verifies', v.j.valid === true);
const tampered = await call('POST', '/v1/receipts/verify', { receipt: { ...d1.j.receipt, amount: '9' }, signature: d1.j.signature }, false); check('tampered receipt fails', tampered.j.valid === false);
const st = await call('POST', '/v1/settlements', { decision_id: d1.j.id }); check('settles', st.status === 201, JSON.stringify(st.j));
const again = await call('POST', '/v1/settlements', { decision_id: d1.j.id }); check('no double settlement', again.status === 409);
const lumen = await call('GET', '/v1/investors/lumen'); const tw = lumen.j.holdings_detail?.find((x) => x.ticker === 'TWLF'); check('holding increased to 5.25M', tw?.units === 5250000, JSON.stringify(tw));
const d2 = await call('POST', '/v1/decisions', { action: 'subscribe', investor_id: 'meitan', fund: 'TWLF', amount: 200000, settle_with: 'USDC' }); check('Mei Tan denied', d2.j.outcome === 'DENY');
const d3 = await call('POST', '/v1/decisions', { action: 'transfer', investor_id: 'lumen', counterparty_id: 'qamar', fund: 'TWLF', amount: 500000, settle_with: 'USDC' }); check('transfer allowed with travel rule', d3.j.outcome === 'ALLOW' && d3.j.travel_rule?.standard === 'IVMS101');
const d4 = await call('POST', '/v1/decisions', { action: 'redeem', investor_id: 'reyes', fund: 'AGPC', amount: 100000, settle_with: 'USDC' }); check('lapsed holder can redeem', d4.j.outcome === 'ALLOW' && d4.j.redemption_only === true);
const bad = await call('POST', '/v1/credentials', { investor_id: 'meitan', classifications: [{ class_code: 'HK_PI', evidence: { portfolio: 5200000 } }] }); check('credential below threshold refused', bad.status === 422);
const good = await call('POST', '/v1/credentials', { investor_id: 'meitan', classifications: [{ class_code: 'HK_PI', evidence: { portfolio: 9000000 } }] }); check('credential issued at HK$9M', good.status === 201, JSON.stringify(good.j));
const d5 = await call('POST', '/v1/decisions', { action: 'subscribe', investor_id: 'meitan', fund: 'TWLF', amount: 200000, settle_with: 'USDC' }); check('Mei Tan now allowed', d5.j.outcome === 'ALLOW', d5.j.headline);
const prev = await call('POST', '/v1/funds/TWLF/policy/preview', { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'HK', accepts: ['HK_PI'] }, { jurisdiction: 'CH', accepts: ['CH_PRO'] }, { jurisdiction: 'DE', accepts: ['EU_PRO'] }] }); check('removing UAE affects Qamar', prev.j.holders_affected?.some((x) => x.investor_id === 'qamar'));
const pc = await call('POST', '/v1/funds/TWLF/policy/changes', { distribution: [{ jurisdiction: 'SG', accepts: ['SG_AI'] }, { jurisdiction: 'HK', accepts: ['HK_PI'] }, { jurisdiction: 'CH', accepts: ['CH_PRO'] }, { jurisdiction: 'DE', accepts: ['EU_PRO'] }], proposed_by: 'Ana Ruiz' });
const same = await call('POST', `/v1/policy-changes/${pc.j.id}/approve`, { approved_by: 'ana ruiz' }); check('proposer cannot approve', same.status === 403);
const ok = await call('POST', `/v1/policy-changes/${pc.j.id}/approve`, { approved_by: 'Ben Okafor' }); check('second approver publishes', ok.j.status === 'published');
const reg = await call('GET', '/v1/funds/TWLF/register'); check('Qamar now redemption-only', reg.j.data?.find((x) => x.investor_id === 'qamar')?.status === 'redemption-only');
const scr = await call('POST', '/v1/screening', { name: 'Blocked Example Trading LLC' }); check('screening match', scr.j.result === 'potential_match');
const bulk = await call('POST', '/v1/eligibility/bulk', { rows: [{ name: 'A', kind: 'Corporate', residence: 'SG', booking_center: 'HK', classes: ['SG_AI', 'HK_PI'] }, { name: 'B', kind: 'Individual', residence: 'HK', booking_center: 'HK', classes: [] }] }); check('bulk matrix', bulk.j.data?.length === 2 && bulk.j.data[0].results.find((x) => x.fund === 'TWLF')?.outcome === 'ALLOW');
const m = await call('GET', '/v1/metrics'); check('metrics', m.j.totals?.decisions >= 5, JSON.stringify(m.j.totals));
const au = await call('GET', '/v1/audit-events'); check('audit trail', au.j.data?.length >= 8);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
