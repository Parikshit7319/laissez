// Golden tests for the policy resolver. Run with: npm test
import assert from 'node:assert/strict';
import { evaluate, holderStatus, defaultCtx } from '../src/proto/engine';
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
console.log(`${n} engine and threshold tests passed`);
