// Golden tests for the policy resolver. Run with: npm test
import assert from 'node:assert/strict';
import { evaluate, holderStatus, defaultCtx, inputsHash, snapshotFor, ctxFromSnapshot, replaySnapshot, dealingDateFor, type Ctx, type DocReq, type Order } from '../src/proto/engine';
import { TESTS, findTest } from '../src/proto/thresholds';

type Case = [string, Parameters<typeof evaluate>[0], string[], 'ALLOW' | 'DENY' | 'FREEZE', ((d: ReturnType<typeof evaluate>) => void)?];
const cases: Case[] = [
  ['Lumen subscribes to TWLF', { action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' }, [], 'ALLOW', (d) => assert.equal(d.resolved.length, 2)],
  ['Expired status blocks subscription', { action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' }, ['expired'], 'DENY'],
  ['Lapsed holder can redeem', { action: 'redeem', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC' }, ['expired'], 'ALLOW', (d) => assert.equal(d.redemptionOnly, true)],
  ['Sanctioned residence freezes even redemptions', { action: 'redeem', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC' }, ['sanctioned'], 'FREEZE'],
  ['HK retail investor refused', { action: 'subscribe', investorId: 'meitan', fundId: 'TWLF', amount: 200_000, asset: 'USDC' }, [], 'DENY'],
  ['U.S. person refused by Regulation S fund', { action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' }, ['becameUS'], 'DENY'],
  ['Transfer to DIFC professional allowed', { action: 'transfer', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC', counterpartyId: 'qamar' }, [], 'ALLOW'],
  ['Transfer blocked when issuer drops UAE', { action: 'transfer', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC', counterpartyId: 'qamar' }, ['dropUAE'], 'DENY'],
  ['Lock-up blocks early transfer', { action: 'transfer', investorId: 'lumen', fundId: 'AGPC', amount: 100_000, asset: 'USDC', counterpartyId: 'sorell' }, [], 'DENY'],
  ['Holder cap blocks a new holder', { action: 'subscribe', investorId: 'kestrel', fundId: 'AGPC', amount: 500_000, asset: 'USDC' }, ['capFull'], 'DENY'],
  ['Holder cap lets an existing holder add', { action: 'subscribe', investorId: 'sorell', fundId: 'AGPC', amount: 500_000, asset: 'USDC' }, ['capFull'], 'ALLOW'],
  ['Unaccepted settlement asset refused', { action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' }, ['badAsset'], 'DENY'],
  ['Fund not offered in UAE', { action: 'subscribe', investorId: 'qamar', fundId: 'NMEL', amount: 1_000_000, asset: 'EURC' }, [], 'DENY'],
  ['Booking center rule binds a German client in Zurich', { action: 'subscribe', investorId: 'kestrel', fundId: 'NMEL', amount: 1_000_000, asset: 'EURC' }, [], 'ALLOW', (d) => assert.ok(d.resolved.some((r) => r.text.includes('Switzerland')))],
];
let n = 0;
for (const [name, order, wi, expect, extra] of cases) {
  const d = evaluate(order, wi as any);
  assert.equal(d.outcome, expect, `${name}: expected ${expect}, got ${d.outcome} (${d.headline})`);
  extra?.(d);
  n++;
}
// Determinism: same inputs, same decision
const a = evaluate(cases[0][1]); const b = evaluate(cases[0][1]);
assert.deepEqual(a.checks, b.checks); n++;
// Holder status
assert.equal(holderStatus(defaultCtx.investors.reyes, defaultCtx.funds.AGPC).status, 'redemption-only'); n++;
assert.equal(holderStatus(defaultCtx.investors.qamar, defaultCtx.funds.TWLF).status, 'eligible'); n++;
// Thresholds
assert.equal(findTest('HK_PI', 'Individual')!.check({ portfolio: 7_999_999 }).pass, false); n++;
assert.equal(findTest('HK_PI', 'Individual')!.check({ portfolio: 8_000_000 }).pass, true); n++;
assert.equal(findTest('SG_AI', 'Corporate')!.check({ net_assets: 12_000_000 }).pass, false, 'opt-in required'); n++;
assert.equal(findTest('SG_AI', 'Corporate')!.check({ net_assets: 12_000_000, opt_in: true }).pass, true); n++;
assert.equal(findTest('EU_PRO', 'Corporate')!.check({ balance_sheet: 25e6, net_turnover: 10e6, own_funds: 3e6 }).pass, true); n++;
assert.equal(findTest('US_AI', 'Individual')!.check({ income: 250_000, joint: true }).pass, false); n++;
assert.ok(TESTS.length >= 10); n++;

// ---------- Extended layers ----------
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const ctxWith = (patch: Partial<Ctx> = {}, mut?: (c: Ctx) => void): Ctx => { const c: Ctx = { ...clone({ ...defaultCtx }), ...patch }; mut?.(c); return c; };
const failIds = (d: ReturnType<typeof evaluate>) => d.checks.filter((c) => c.result === 'fail').map((c) => c.id);
const subLumen: Order = { action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' };
const redLumen: Order = { action: 'redeem', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC' };
const doc = (over: Partial<DocReq>): DocReq => ({ id: 'doc_im', ticker: 'TWLF', title: 'Information memorandum', docType: 'offering_memorandum', version: 3, sha256: 'a'.repeat(64), jurisdiction: null, audience: 'all', required: true, ...over });

// Documents: unacknowledged required document denies the subscription
{
  const d = evaluate(subLumen, [], ctxWith({ documents: { TWLF: [doc({})] }, acks: {} }));
  assert.equal(d.outcome, 'DENY', d.headline);
  const c = d.checks.find((x) => x.id === 'doc:doc_im')!;
  assert.equal(c.layer, 'Documents'); assert.equal(c.result, 'fail');
  assert.equal(c.remedy, 'Send Information memorandum v3 to the investor in the portal, or record an attested acknowledgment.'); n++;
}
// Documents: acknowledged at the current hash passes; a stale hash fails
{
  const docs = { TWLF: [doc({}), doc({ id: 'doc_sg', title: 'Singapore supplement', jurisdiction: 'SG', version: 1, sha256: 'b'.repeat(64) }), doc({ id: 'doc_de', jurisdiction: 'DE' })] };
  const ok = evaluate(subLumen, [], ctxWith({ documents: docs, acks: { lumen: { doc_im: 'a'.repeat(64), doc_sg: 'b'.repeat(64) } } }));
  assert.equal(ok.outcome, 'ALLOW', ok.headline);
  assert.ok(!ok.checks.some((x) => x.id === 'doc:doc_de'), 'German document does not apply to a Singapore resident'); n++;
  const stale = evaluate(subLumen, [], ctxWith({ documents: docs, acks: { lumen: { doc_im: 'c'.repeat(64), doc_sg: 'b'.repeat(64) } } }));
  assert.deepEqual(failIds(stale), ['doc:doc_im']); n++;
}
// Documents: retail documents apply only to retail-only investors; the transfer receiver is the one tested
{
  const kid = doc({ id: 'doc_kid', ticker: 'NMEL', title: 'Key information document', audience: 'retail' });
  const pro = evaluate({ action: 'subscribe', investorId: 'kestrel', fundId: 'NMEL', amount: 1_000_000, asset: 'EURC' }, [], ctxWith({ documents: { NMEL: [kid] }, acks: {} }));
  assert.equal(pro.outcome, 'ALLOW', 'professional client does not need the retail KID'); n++;
  const t = evaluate({ action: 'transfer', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC', counterpartyId: 'qamar' }, [], ctxWith({ documents: { TWLF: [doc({})] }, acks: { lumen: { doc_im: 'a'.repeat(64) } } }));
  assert.equal(t.outcome, 'DENY'); assert.equal(t.checks.find((x) => x.id === 'doc:doc_im')?.subject, 'Qamar Holdings'); n++;
}
// Fund terms: notice period fails without a notice and passes with one that covers the units
{
  const terms = (c: Ctx) => Object.assign(c.funds.TWLF, { cutoffTime: '16:00', cutoffTz: 'America/New_York', dealingFrequency: 'daily', noticeDays: 5 });
  const now = '2026-10-01T14:00:00Z'; // 10:00 in New York, before the cut-off
  const no = evaluate(redLumen, [], ctxWith({ now, notices: {} }, terms));
  assert.equal(no.outcome, 'DENY');
  const c = no.checks.find((x) => x.id === 'notice')!;
  assert.equal(c.layer, 'Fund terms'); assert.equal(c.remedy, 'File a redemption notice.');
  assert.ok(c.detail.startsWith("Redemptions need 5 days' notice. A notice filed today makes the earliest dealing date 2026-10-06."), c.detail);
  assert.ok(no.checks.find((x) => x.id === 'redeemPolicy')?.result === 'pass', 'redemption stays open on eligibility grounds'); n++;
  const yes = evaluate(redLumen, [], ctxWith({ now, notices: { 'lumen:TWLF': [{ units: 500_000, dealingDate: '2026-10-01' }] } }, terms));
  assert.equal(yes.outcome, 'ALLOW', yes.headline); assert.equal(yes.dealingDate, '2026-10-01'); n++;
  const late = evaluate(redLumen, [], ctxWith({ now, notices: { 'lumen:TWLF': [{ units: 500_000, dealingDate: '2026-10-08' }] } }, terms));
  assert.equal(late.outcome, 'DENY', 'a notice for a later dealing date does not cover today'); n++;
}
// Fund terms: redemption gate
{
  const gated = (c: Ctx) => Object.assign(c.funds.TWLF, { gatePct: 10 });
  const d = evaluate(redLumen, [], ctxWith({ aum: { TWLF: 4_000_000 }, redeemedInPeriod: { TWLF: 300_000 } }, gated));
  assert.equal(d.outcome, 'DENY');
  const g = d.checks.find((x) => x.id === 'gate')!;
  assert.equal(g.result, 'fail'); assert.ok(g.remedy!.startsWith('Reduce the redemption to $100,000 or less'), g.remedy); n++;
  const ok = evaluate({ ...redLumen, amount: 100_000 }, [], ctxWith({ aum: { TWLF: 4_000_000 }, redeemedInPeriod: { TWLF: 300_000 } }, gated));
  assert.equal(ok.outcome, 'ALLOW', ok.headline); n++;
}
// Screening: investor hit carries source and score; counterparty hit freezes the transfer
{
  const screen = (name: string) => name === 'Qamar Holdings Ltd' ? { entry: 'QAMAR HOLDING', program: 'SDGT', source: 'OFAC-SDN', score: 0.81 } : null;
  const t = evaluate({ action: 'transfer', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC', counterpartyId: 'qamar' }, [], ctxWith({ screen }));
  assert.equal(t.outcome, 'FREEZE');
  assert.ok(t.checks.find((x) => x.id === 'cpScreen')!.detail.includes('(OFAC-SDN: SDGT), similarity 0.81'), t.headline); n++;
  const s = evaluate({ action: 'subscribe', investorId: 'qamar', fundId: 'TWLF', amount: 200_000, asset: 'USDC' }, [], ctxWith({ screen }));
  assert.equal(s.outcome, 'FREEZE');
  assert.equal(s.checks.find((x) => x.id === 'screen')!.detail, 'Potential match with “QAMAR HOLDING” (OFAC-SDN: SDGT), similarity 0.81. Screened at order time.'); n++;
}
// Credential: a relied-on credential that was revoked no longer counts; a live one names the issuer
{
  const relied = (status: 'active' | 'revoked') => ctxWith({}, (c) => Object.assign(c.investors.lumen, {
    reliedShare: 'sh_test1', shareStatus: status, issuer: 'Harbor & Pike Bank (relied on under share sh_test1)',
    ...(status === 'revoked' ? { credentialId: '', classifications: [], expires: '0000-00-00' } : {}),
  }));
  const dead = evaluate(subLumen, [], relied('revoked'));
  const cred = dead.checks.find((x) => x.id === 'cred')!;
  assert.equal(dead.outcome, 'DENY'); assert.equal(cred.result, 'fail');
  assert.ok(cred.detail.includes('from Harbor & Pike Bank is no longer valid'), cred.detail);
  assert.equal(cred.remedy, 'Ask the client to share again, or issue your own credential.'); n++;
  const live = evaluate(subLumen, [], relied('active'));
  assert.equal(live.outcome, 'ALLOW'); assert.ok(live.checks.find((x) => x.id === 'cred')!.detail.includes('issued by Harbor & Pike Bank'), 'live relied credential names the issuer'); n++;
}
// Rule packs: versions come from the context when present
{
  const rp = { 'SG/eligibility': '2027.01.0', 'HK/eligibility': '2026.04.2', 'global/sanctions': '2026-10-02', 'global/travel-rule': '2026.07' };
  const d = evaluate(subLumen, [], ctxWith({ rulePacks: rp }, (c) => { c.funds.TWLF.policyVersion = 3; }));
  assert.deepEqual(d.rulePacks, ['fund/TWLF@v3', 'SG/eligibility@2027.01.0', 'HK/eligibility@2026.04.2', 'global/sanctions@2026-10-02', 'global/travel-rule@2026.07']); n++;
  assert.ok(evaluate(subLumen).rulePacks.includes('fund/TWLF@2026.09.1'), 'falls back to launch versions'); n++;
}
// Snapshots: replaying a decision from its stored snapshot reproduces the checks and the inputs hash
{
  const screen = (name: string) => name.startsWith('Sorell') ? { entry: 'SORELL', program: 'UKR', source: 'EU', score: 0.74 } : null;
  const full = ctxWith({
    now: '2026-10-01T20:30:00Z', rulePacks: { 'SG/eligibility': '2026.09.0', 'HK/eligibility': '2026.04.2', 'AE-DIFC/eligibility': '2026.07.0', 'global/sanctions': '2026-10-01', 'global/travel-rule': '2026.07' },
    documents: { TWLF: [doc({})] }, acks: { lumen: { doc_im: 'a'.repeat(64) }, qamar: {} }, aum: { TWLF: 9_000_000 }, redeemedInPeriod: { TWLF: 0 },
    notices: { 'lumen:TWLF': [{ units: 100_000, dealingDate: '2026-10-02' }] }, screen,
  }, (c) => Object.assign(c.funds.TWLF, { cutoffTime: '16:00', cutoffTz: 'America/New_York', noticeDays: 2, gatePct: 10 }));
  const orders: [Order, any[]][] = [
    [subLumen, []], [redLumen, []], [{ ...redLumen, amount: 100_000 }, []], [subLumen, ['expired', 'badAsset']],
    [{ action: 'transfer', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC', counterpartyId: 'qamar' }, ['dropUAE']],
    [{ action: 'subscribe', investorId: 'sorell', fundId: 'AGPC', amount: 500_000, asset: 'USDC' }, []],
  ];
  for (const [o, wi] of orders) {
    const d1 = evaluate(o, wi, full);
    const snap = JSON.parse(JSON.stringify(snapshotFor(o, full, wi)));
    const d2 = replaySnapshot(snap);
    assert.equal(d2.outcome, d1.outcome); assert.deepEqual(d2.checks, d1.checks); assert.deepEqual(d2.rulePacks, d1.rulePacks); assert.equal(d2.dealingDate, d1.dealingDate);
    assert.equal(await inputsHash(d2), await inputsHash(d1));
    assert.deepEqual(evaluate(o, wi, ctxFromSnapshot(snap)).headline, d1.headline);
  }
  n++;
}
// Dealing dates with a fixed clock
{
  const at = (now: string, terms: Record<string, unknown>) => evaluate(subLumen, [], ctxWith({ now }, (c) => Object.assign(c.funds.TWLF, { cutoffTime: '16:00', cutoffTz: 'America/New_York', dealingFrequency: 'daily', ...terms }))).dealingDate;
  assert.equal(at('2026-10-01T19:30:00Z', {}), '2026-10-01', 'before the 16:00 New York cut-off'); n++;
  assert.equal(at('2026-10-01T20:30:00Z', {}), '2026-10-02', 'after the cut-off rolls to the next business day'); n++;
  assert.equal(at('2026-10-02T21:00:00Z', {}), '2026-10-05', 'Friday after the cut-off rolls to Monday'); n++;
  assert.equal(at('2026-10-03T15:00:00Z', {}), '2026-10-05', 'weekend orders deal Monday'); n++;
  assert.equal(at('2026-10-01T05:00:00Z', { cutoffTz: 'Asia/Singapore', cutoffTime: '12:00' }), '2026-10-02', '13:00 in Singapore is past a 12:00 cut-off'); n++;
  assert.equal(at('2026-10-01T15:00:00Z', { dealingFrequency: 'monthly' }), '2026-10-30', 'October 31, 2026 is a Saturday'); n++;
  assert.equal(at('2026-10-30T21:00:00Z', { dealingFrequency: 'monthly' }), '2026-11-30', 'past the cut-off on the dealing day rolls a month'); n++;
  assert.equal(at('2026-10-01T15:00:00Z', { dealingFrequency: 'quarterly' }), '2026-12-31'); n++;
  assert.equal(at('2026-12-31T22:00:00Z', { dealingFrequency: 'quarterly' }), '2027-03-31'); n++;
  assert.equal(dealingDateFor('monthly', '2027-01-31', true), '2027-02-26', 'January 31, 2027 is a Sunday, so January has already dealt'); n++;
  assert.equal(evaluate(subLumen).dealingDate, undefined, 'the demo has no clock and no dealing check'); n++;
  assert.ok(!evaluate(subLumen).checks.some((c) => c.layer === 'Documents' || c.layer === 'Fund terms'), 'the demo is unchanged'); n++;
}
console.log(`${n} engine and threshold tests passed`);
