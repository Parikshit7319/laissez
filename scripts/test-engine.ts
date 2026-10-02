// Golden tests for the policy resolver. Run with: npm test
import assert from 'node:assert/strict';
import { evaluate, holderStatus, defaultCtx, inputsHash, snapshotFor, ctxFromSnapshot, replaySnapshot, dealingDateFor, indianFinancialYear, type Ctx, type DocReq, type Order } from '../src/proto/engine';
import { TESTS, findTest } from '../src/proto/thresholds';
import { CALENDARS, isBusinessDay } from '../api/src/calendars';
import { distributionDueOn, distributionPeriodStart } from '../api/src/fundops-core';

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
// Holiday calendars: the fund's calendar moves the dealing date past public holidays
{
  const ny = ['2026-11-26', '2026-12-25'];
  const at = (now: string, terms: Record<string, unknown> = {}) => evaluate(subLumen, [], ctxWith({ now, calendars: { 'America/New_York': ny } }, (c) => Object.assign(c.funds.TWLF, { cutoffTime: '16:00', cutoffTz: 'America/New_York', dealingFrequency: 'daily', ...terms })));
  assert.equal(at('2026-11-26T15:00:00Z').dealingDate, '2026-11-27', 'Thanksgiving is not a dealing day in New York'); n++;
  assert.ok(at('2026-11-26T15:00:00Z').checks.find((c) => c.id === 'dealing')!.detail.includes('public holiday'), 'the check says a holiday moved the date'); n++;
  const zrh = evaluate(subLumen, [], ctxWith({ now: '2026-12-01T15:00:00Z', calendars: { 'Europe/Zurich': ['2026-12-24', '2026-12-25', '2026-12-31'] } }, (c) => Object.assign(c.funds.TWLF, { cutoffTime: '16:00', cutoffTz: 'Europe/Zurich', dealingFrequency: 'monthly' })));
  assert.equal(zrh.dealingDate, '2026-12-30', 'a Zurich monthly fund deals on Dec 30 when Dec 31 is closed'); n++;
  assert.equal(dealingDateFor('daily', '2026-12-25', true, ['2026-12-25']), '2026-12-28'); n++;
  assert.equal(dealingDateFor('daily', '2026-12-25', true, (d) => d === '2026-12-25'), '2026-12-28', 'a predicate works too'); n++;
  assert.equal(isBusinessDay('2026-07-03', 'America/New_York'), false, 'Independence Day observed'); n++;
  assert.equal(isBusinessDay('2026-07-06', 'America/New_York'), true); n++;
  assert.equal(isBusinessDay('2027-02-08', 'Asia/Singapore'), false, 'Lunar New Year in lieu'); n++;
  assert.equal(isBusinessDay('2026-05-25', 'Europe/Zurich'), false, 'Whit Monday'); n++;
  assert.equal(isBusinessDay('2026-05-25', 'Europe/Berlin'), true, 'TARGET2 is open on Whit Monday'); n++;
  assert.equal(isBusinessDay('2026-10-06', 'Mars/Olympus'), true, 'unknown calendars skip weekends only'); n++;
  assert.equal(CALENDARS.length, 12); n++;
  for (const cal of CALENDARS) for (const [y, days] of Object.entries(cal.holidays)) for (const d of days) assert.ok(d.startsWith(y) && !Number.isNaN(Date.parse(d)), `${cal.key} ${d}`);
  n++;
  // Snapshots carry the calendar, so a replay gets the same dealing date
  const full = ctxWith({ now: '2026-11-26T15:00:00Z', calendars: { 'America/New_York': ny } }, (c) => Object.assign(c.funds.TWLF, { cutoffTime: '16:00', cutoffTz: 'America/New_York', dealingFrequency: 'daily' }));
  const snap = snapshotFor(subLumen, full);
  assert.deepEqual(snap.calendars, { 'America/New_York': ny }); assert.equal(replaySnapshot(snap).dealingDate, '2026-11-27'); n++;
}
// Distribution due dates: month end for daily and monthly funds, quarter end for quarterly funds
{
  assert.equal(distributionDueOn({ dealingFrequency: 'daily' }, '2026-02-10'), '2026-02-28'); n++;
  assert.equal(distributionDueOn({ dealingFrequency: 'monthly' }, '2028-02-10'), '2028-02-29'); n++;
  assert.equal(distributionDueOn({ dealingFrequency: 'quarterly' }, '2026-10-02'), '2026-12-31'); n++;
  assert.equal(distributionDueOn({ dealingFrequency: 'quarterly' }, '2026-04-01'), '2026-06-30'); n++;
  assert.equal(distributionPeriodStart({ dealingFrequency: 'quarterly' }, '2026-11-15'), '2026-10-01'); n++;
  assert.equal(distributionPeriodStart({ dealingFrequency: 'daily' }, '2026-11-15'), '2026-11-01'); n++;
}
// Opt-in from class metadata: a class flagged requiresOptIn needs consent, worded with its label
{
  const withMeta = (mut?: (c: Ctx) => void) => ctxWith({}, (c) => {
    c.classInfo.HK_PI = { ...c.classInfo.HK_PI, requiresOptIn: true, optInLabel: 'written election' };
    mut?.(c);
  });
  const d = evaluate({ action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' }, [], withMeta());
  const booking = d.checks.find((c) => c.id === 'booking')!;
  assert.equal(d.outcome, 'DENY'); assert.equal(booking.result, 'fail');
  assert.ok(booking.label.includes('Professional investor with written election'), booking.label);
  assert.ok(booking.detail.includes('no written election is recorded'), booking.detail);
  assert.ok(booking.remedy!.startsWith("Record the client's written election"), booking.remedy); n++;
  const ok = evaluate({ action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' }, [], withMeta((c) => { c.investors.lumen.classifications[1].optIn = '2026-03-14'; }));
  assert.equal(ok.outcome, 'ALLOW', ok.headline);
  assert.ok(ok.resolved.some((r) => r.text === 'Professional investor with written election in Hong Kong'), JSON.stringify(ok.resolved)); n++;
  // SG_AI keeps its launch opt-in rule even without metadata
  const legacy = evaluate(subLumen, [], ctxWith({}, (c) => { delete c.investors.lumen.classifications[0].optIn; }));
  assert.equal(legacy.outcome, 'DENY'); assert.ok(legacy.checks.find((c) => c.id === 'law')!.detail.includes('no opt-in is recorded')); n++;
}
// Law accepting any of several classes: pass on either, consent honored per class, the narrower rule binds
{
  const anyLaw = (mut?: (c: Ctx) => void) => ctxWith({}, (c) => {
    const d: any = c.funds.TWLF.distribution.SG;
    d.accepts = ['SG_AI', 'HK_PI']; d.lawRequiresAny = ['SG_AI', 'HK_PI'];
    mut?.(c);
  });
  const d = evaluate(subLumen, [], anyLaw());
  assert.equal(d.outcome, 'ALLOW');
  const law = d.checks.find((c) => c.id === 'law')!;
  assert.equal(law.label, 'Singapore: Accredited investor with opt-in or Professional investor', law.label); n++;
  // Without the SG opt-in, HK_PI still satisfies the law; the Hong Kong booking rule binds
  const viaHk = evaluate(subLumen, [], anyLaw((c) => { delete c.investors.lumen.classifications[0].optIn; }));
  assert.equal(viaHk.outcome, 'ALLOW', viaHk.headline);
  assert.ok(viaHk.checks.find((c) => c.id === 'law')!.result === 'pass');
  assert.deepEqual(viaHk.resolved.map((r) => r.text), ['Accredited investor with opt-in or Professional investor in Singapore', 'Professional investor in Hong Kong']); n++;
  // Neither class: the remedy names both
  const none = evaluate(subLumen, [], anyLaw((c) => { c.investors.lumen.classifications = []; }));
  assert.equal(none.outcome, 'DENY');
  assert.equal(none.checks.find((c) => c.id === 'law')!.remedy, 'Investor must qualify as Accredited investor with opt-in or Professional investor in Singapore.'); n++;
  // lawRequires alone still works (compatibility)
  assert.equal(evaluate(subLumen).checks.find((c) => c.id === 'law')!.label, 'Singapore: Accredited investor with opt-in'); n++;
}
// India: the LRS ceiling on a resident individual's order
{
  const india = (remitted: number, amount: number, fund: 'TWLF' | 'NMEL' = 'TWLF', mut?: (c: Ctx) => void) => {
    const ctx = ctxWith({ lrsRemitted: { meitan: remitted } }, (c) => {
      c.jurName.IN = 'India';
      c.classInfo.IN_AI = { label: 'Accredited investor (SEBI)', stamp: 'AI', jur: 'IN', rule: 'SEBI AI framework', source: 'sebi-ai', threshold: '' };
      c.bookingCenters.GIFT = { id: 'GIFT', name: 'GIFT City (IFSC)', jur: 'IN', licence: 'IFSCA (fictional)', requires: 'IN_AI', ruleText: 'Accredited investors only.', ruleRef: 'IFSCA', source: 'ifsca-ai' };
      Object.assign(c.investors.meitan, { residence: 'IN', city: 'Mumbai', booking: 'GIFT', classifications: [{ code: 'IN_AI', basis: 'Income INR 3 crore', verified: '2026-06-01', expires: '2027-06-01' }] });
      (c.funds[fund].distribution as any).IN = { accepts: ['IN_AI'], basis: 'OPI within the LRS', lawRequires: 'IN_AI', lawText: 'Resident individuals within the LRS.', lawRef: 'OI Rules 2022 Sch. III', lawSource: 'rbi-lrs' };
      mut?.(c);
    });
    return evaluate({ action: 'subscribe', investorId: 'meitan', fundId: fund, amount, asset: fund === 'NMEL' ? 'EURC' : 'USDC' }, [], ctx);
  };
  const ok = india(100_000, 150_000);
  assert.equal(ok.outcome, 'ALLOW', ok.headline);
  const lrs = ok.checks.find((c) => c.id === 'lrs')!;
  assert.equal(lrs.layer, 'Residence law'); assert.ok(lrs.detail.includes('USD 250,000'), lrs.detail); n++;
  const over = india(100_000, 150_001);
  assert.equal(over.outcome, 'DENY'); assert.deepEqual(failIds(over), ['lrs']);
  assert.equal(over.checks.find((c) => c.id === 'lrs')!.remedy, "Reduce the order to $150,000 or less, or place the balance after April 1 when the next financial year's allowance opens."); n++;
  const eur = india(100_000, 140_000, 'NMEL');
  assert.equal(eur.outcome, 'DENY', 'EUR 140,000 at 1.10 is USD 154,000, over the remaining USD 150,000');
  assert.ok(eur.checks.find((c) => c.id === 'lrs')!.detail.includes('fixed demo rate of 1.1'), eur.checks.find((c) => c.id === 'lrs')!.detail); n++;
  const used = india(250_000, 10_000);
  assert.ok(used.checks.find((c) => c.id === 'lrs')!.remedy!.startsWith('The investor has used the full LRS allowance for FY 2026-27')); n++;
  // Without a context override, the figure on the IN_LRS classification is used
  const fromClass = india(0, 200_000, 'TWLF', (c) => { delete c.lrsRemitted; c.investors.meitan.classifications.push({ code: 'IN_LRS', basis: 'Resident individual with PAN; USD 100,000 of the USD 250,000 LRS allowance used this financial year (remitted_this_fy_usd=100000).', verified: '2026-06-01', expires: '2027-06-01' }); });
  assert.deepEqual(failIds(fromClass), ['lrs']); n++;
  assert.equal(indianFinancialYear('2026-03-31'), '2025-26'); assert.equal(indianFinancialYear('2026-04-01'), '2026-27'); n++;
}
// Regulation S Category 3: distribution compliance period on resales to U.S. persons
{
  const regs = (patch: Record<string, unknown>, cpId = 'reyes') => evaluate({ action: 'transfer', investorId: 'sorell', fundId: 'AGPC', amount: 300_000, asset: 'USDC', counterpartyId: cpId }, [], ctxWith({}, (c) => {
    Object.assign(c.funds.AGPC, patch);
    c.investors.reyes.classifications[0].expires = '2027-09-15'; c.investors.reyes.expires = '2027-09-15';
  }));
  const blocked = regs({ regSCategory: 3, offeringDate: '2026-01-15' });
  assert.deepEqual(failIds(blocked), ['regSPeriod']);
  const ch = blocked.checks.find((c) => c.id === 'regSPeriod')!;
  assert.equal(ch.layer, 'Transfer controls'); assert.equal(ch.ruleRef, 'Reg S Rule 903(b)(3)'); assert.ok(ch.detail.includes('Until 2027-01-15')); n++;
  assert.equal(regs({ regSCategory: 3, offeringDate: '2025-09-30' }).checks.find((c) => c.id === 'regSPeriod')!.result, 'pass', 'one year has passed'); n++;
  assert.deepEqual(failIds(regs({ regSCategory: 3, offeringDate: '2026-09-01', regSSecurityType: 'debt' })), ['regSPeriod'], 'debt: 40 days'); n++;
  assert.equal(regs({ regSCategory: 3, offeringDate: '2026-08-01', regSSecurityType: 'debt' }).checks.find((c) => c.id === 'regSPeriod')!.result, 'pass'); n++;
  assert.ok(!regs({ regSCategory: 2, offeringDate: '2026-09-01' }).checks.some((c) => c.id === 'regSPeriod'), 'category 2 has no period check'); n++;
  assert.ok(!regs({ regSCategory: 3, offeringDate: '2026-09-01' }, 'qamar').checks.some((c) => c.id === 'regSPeriod'), 'non-U.S. receiver'); n++;
}
// Section 3(c)(7): no 100-owner cap, 12(g) holders of record threshold
{
  const c7 = (holders: number, existing = false) => evaluate({ action: 'subscribe', investorId: 'reyes', fundId: 'AGPC', amount: 300_000, asset: 'USDC' }, [], ctxWith({}, (c) => {
    Object.assign(c.funds.AGPC, { holderCap: null, holders, usAccepts: ['US_AI', 'US_QP'] });
    c.investors.reyes.classifications[0].expires = '2027-09-15'; c.investors.reyes.expires = '2027-09-15';
    if (!existing) c.investors.reyes.holdings = {};
  }));
  assert.equal(c7(1998).outcome, 'ALLOW'); assert.ok(!c7(1998).checks.some((x) => x.id === 'cap')); assert.ok(c7(1998).checks.find((x) => x.id === 'cap12g')!.detail.includes('1999 with Daniel Reyes')); n++;
  assert.deepEqual(failIds(c7(1999)), ['cap12g']); n++;
  assert.equal(c7(1999, true).outcome, 'ALLOW', 'an existing holder adds without changing the count'); n++;
}
// Closed-end funds: a subscription needs a capital call; the call travels with the snapshot
{
  const closed = (call?: Record<string, unknown> | null) => ctxWith(call === undefined ? {} : { capitalCall: call as any }, (c) => { (c.funds.TWLF as any).fundType = 'closed_end'; });
  const free = evaluate(subLumen, [], closed());
  assert.equal(free.outcome, 'DENY'); assert.deepEqual(failIds(free), ['closed_end']);
  assert.ok(free.checks.find((c) => c.id === 'closed_end')!.detail.includes('free subscription is not accepted')); n++;
  const call = { id: 'call_test1', ticker: 'TWLF', callNumber: 2, dueOn: '2026-10-20', status: 'issued', amount: 2_000_000 };
  const paid = evaluate(subLumen, [], closed(call));
  assert.equal(paid.outcome, 'ALLOW', paid.headline); assert.ok(paid.checks.find((c) => c.id === 'closed_end')!.detail.includes('capital call 2')); n++;
  assert.deepEqual(failIds(evaluate({ ...subLumen, amount: 1_500_000 }, [], closed(call))), ['closed_end'], 'the paid-in amount must match the notice'); n++;
  assert.deepEqual(failIds(evaluate(subLumen, [], closed({ ...call, status: 'settled' }))), ['closed_end'], 'a settled call takes no more money'); n++;
  assert.deepEqual(failIds(evaluate(subLumen, [], closed({ ...call, ticker: 'AGPC' }))), ['closed_end'], 'a call for another fund does not count'); n++;
  assert.equal(evaluate(redLumen, [], closed()).checks.some((c) => c.id === 'closed_end'), false, 'redemptions and open-ended funds never see the check'); n++;
  const snap = snapshotFor(subLumen, closed(call));
  assert.deepEqual(snap.capitalCall, call); assert.equal(replaySnapshot(snap).outcome, 'ALLOW'); n++;
}

// ---------- Property-based tests: random investors, funds and orders over every jurisdiction ----------
{
  const { extendCtx, NEW_LAW } = await import('../src/proto/rulepacks');
  const base = extendCtx(defaultCtx);
  let seed = 20261003;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const chance = (p: number) => rnd() < p;
  const JURS = Object.keys(base.jurName).filter((j) => !['GLOBAL', 'US'].includes(j));
  const BOOKINGS = Object.keys(base.bookingCenters);
  const classesOf = (jur: string) => Object.entries(base.classInfo).filter(([, m]) => m.jur === jur).map(([k]) => k);
  const lawFor = (jur: string): any => NEW_LAW[jur] ?? (defaultCtx.funds.TWLF.distribution as any)[jur] ?? (defaultCtx.funds.AGPC.distribution as any)[jur] ?? null;
  const ASSETS = ['USDC', 'EURC', 'AVB-USD', 'USDT'];
  const investor = (id: string): any => {
    const jur = pick(JURS);
    const codes = classesOf(jur);
    const held = codes.filter(() => chance(0.6)).concat(chance(0.3) ? [pick(Object.keys(base.classInfo))] : []);
    const expired = chance(0.15);
    return {
      id, name: `Random ${id}`, short: `Random ${id}`, kind: chance(0.5) ? 'Individual' : 'Corporate', residence: jur, city: base.jurName[jur], booking: pick(BOOKINGS),
      usPerson: jur === 'US' || chance(0.05), wallet: '0x0000…rand', credentialId: chance(0.9) ? `LP-${id}` : '', issued: '2026-01-01', expires: expired ? '2026-09-01' : '2027-06-01',
      classifications: held.map((code) => ({ code, basis: 'random', verified: '2026-01-01', expires: chance(0.1) ? '2026-09-01' : '2027-06-01', ...(chance(0.8) ? { optIn: '2026-01-01' } : {}) })),
      holdings: {},
    };
  };
  const fund = (id: string): any => {
    const src = clone(pick([defaultCtx.funds.TWLF, defaultCtx.funds.NMEL, defaultCtx.funds.AGPC]));
    const dist: Record<string, unknown> = {};
    for (const j of JURS) if (chance(0.5)) { const l = lawFor(j); if (l) { const acc = l.accepts.filter(() => chance(0.8)); dist[j] = { ...l, accepts: acc.length ? acc : l.accepts }; } }
    return {
      ...src, id, ticker: id, distribution: dist, holders: Math.floor(rnd() * 120), holderCap: chance(0.3) ? 100 : null, lockupMonths: chance(0.3) ? 12 : null,
      minSubscription: pick([0, 1000, 100_000]), gatePct: chance(0.3) ? 10 : null, noticeDays: chance(0.3) ? 5 : 0, cutoffTime: '16:00', cutoffTz: 'America/New_York', dealingFrequency: pick(['daily', 'monthly', 'quarterly']),
      ...(chance(0.15) ? { fundType: 'closed_end' } : {}),
    };
  };
  const ELIG_ONLY_REDEEM = new Set(['holding', 'lock', 'notice', 'gate']);
  const SCREEN_IDS = new Set(['screen', 'cpScreen', 'sanc']);
  const N = 600;
  const t0 = Date.now();
  const outcomes: Record<string, number> = { ALLOW: 0, DENY: 0, FREEZE: 0 };
  for (let i = 0; i < N; i++) {
    const f = fund(`RF${i % 7}`);
    const a = investor(`a${i}`); const b = investor(`b${i}`);
    if (chance(0.6)) a.holdings[f.id] = { units: Math.round(rnd() * 2_000_000), since: pick(['2024-01-10', '2026-01-10', '2026-09-20']) };
    if (chance(0.3)) b.holdings[f.id] = { units: 1000, since: '2025-01-01' };
    const hitName = chance(0.08) ? pick([a.name, b.name]) : null;
    const action = pick(['subscribe', 'subscribe', 'transfer', 'redeem', 'redeem'] as const);
    const amount = pick([500, 50_000, 250_000, 1_000_000]);
    const asset = action === 'redeem' ? f.assets[0] : pick(ASSETS);
    const order: Order = { action, investorId: a.id, fundId: f.id, amount, asset, ...(action === 'transfer' ? { counterpartyId: b.id } : {}) };
    const ctx: Ctx = {
      ...base, investors: { [a.id]: a, [b.id]: b }, funds: { [f.id]: f }, today: '2026-10-03',
      now: chance(0.7) ? '2026-10-03T14:00:00Z' : undefined,
      screen: (name) => (name === hitName ? { entry: name.toUpperCase(), program: 'TEST', source: 'TEST', score: 0.9 } : null),
      aum: chance(0.5) ? { [f.id]: 4_000_000 } : undefined, redeemedInPeriod: chance(0.5) ? { [f.id]: 300_000 } : undefined,
      notices: chance(0.5) ? { [`${a.id}:${f.id}`]: [{ units: 100_000, dealingDate: '2026-10-03' }] } : undefined,
      rulePacks: { 'SG/eligibility': '2026.09.0', 'global/sanctions': '2026-10-01' },
      capitalCall: chance(0.5) ? { id: 'call_rand', ticker: f.id, callNumber: 1, dueOn: '2026-10-20', status: 'issued', amount } : null,
    };
    const whatIfs = chance(0.1) ? [pick(['expired', 'sanctioned', 'capFull', 'badAsset', 'becameUS'] as const)] : [];
    const d = evaluate(order, whatIfs, ctx);
    outcomes[d.outcome]++;
    const fails = d.checks.filter((c) => c.result === 'fail');
    const label = `case ${i} (${action} ${a.residence}/${a.booking} on ${f.id}): ${d.headline}`;
    // 1. A redemption is never denied for eligibility reasons alone.
    if (action === 'redeem' && d.outcome === 'DENY') assert.ok(fails.every((c) => ELIG_ONLY_REDEEM.has(c.id) || (c.id === 'asset' && whatIfs.includes('badAsset'))), `${label} denied on ${fails.map((c) => c.id).join(', ')}`);
    // 2. A freeze always carries a screening or sanctions failure.
    if (d.outcome === 'FREEZE') assert.ok(fails.some((c) => SCREEN_IDS.has(c.id)), `${label} froze without a screening check`);
    // 3. Allow means every check passed or was informational.
    if (d.outcome === 'ALLOW') assert.ok(d.checks.every((c) => c.result === 'pass' || c.result === 'info' || c.result === 'na'), `${label} allowed with a failing check`);
    // 4. Determinism: the same inputs give the same checks and hash.
    const d2 = evaluate(order, whatIfs, ctx);
    assert.deepEqual(d2.checks, d.checks, `${label} is not deterministic`);
    assert.equal(await inputsHash(d2), await inputsHash(d), `${label} hash differs between runs`);
    // 5. The snapshot reproduces the decision.
    const snap = JSON.parse(JSON.stringify(snapshotFor(order, ctx, whatIfs)));
    const r = replaySnapshot(snap);
    assert.equal(r.outcome, d.outcome, `${label} replayed as ${r.outcome}`);
    assert.deepEqual(r.checks, d.checks, `${label} replayed checks differ`);
    assert.equal(await inputsHash(r), await inputsHash(d), `${label} replayed hash differs`);
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `${N} generated cases took ${ms} ms, over the 5 s budget`);
  assert.ok(outcomes.ALLOW > 0 && outcomes.DENY > 0 && outcomes.FREEZE > 0, `generator covered every outcome: ${JSON.stringify(outcomes)}`);
  console.log(`${N} generated cases in ${ms} ms: ${outcomes.ALLOW} allowed, ${outcomes.DENY} denied, ${outcomes.FREEZE} frozen`);
  n++;
}
console.log(`${n} engine and threshold tests passed`);
