// Tests for customer-authored rules (src/proto/custom-rules.ts) and their hook in the engine. Run with: npm run test:custom
import assert from 'node:assert/strict';
import { evaluate, defaultCtx, inputsHash, snapshotFor, ctxFromSnapshot, replaySnapshot, type Ctx, type Order } from '../src/proto/engine';
import {
  evaluateCustomRules, evaluateCondition, factsFor, renderTemplate, describeCondition, describeRule, ruleApplies, ruleInForce,
  ruleDefinitionSchema, parseDefinition, validateDefinition, diffDefinitions, definitionFingerprint, RULE_TEMPLATES, FIELDS, OPERATORS, operatorsFor,
  type CustomRule, type Condition, type RuleDefinition, type Facts,
} from '../src/proto/custom-rules';

let n = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); n++; };
const eq = <T,>(a: T, b: T, msg: string) => { assert.deepEqual(a, b, msg); n++; };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const TODAY = defaultCtx.today; // 2026-10-01
const lumenSub: Order = { action: 'subscribe', investorId: 'lumen', fundId: 'TWLF', amount: 2_000_000, asset: 'USDC' };
const factsOf = (order: Order, ctx: Ctx = defaultCtx): Facts => factsFor(order, ctx.investors[order.investorId], ctx.funds[order.fundId], order.counterpartyId ? ctx.investors[order.counterpartyId] : undefined, ctx.today);
const F = factsOf(lumenSub);

const base: RuleDefinition = ruleDefinitionSchema.parse({
  name: 'Test rule', jurisdiction: '*', applies_to: { actions: ['subscribe', 'transfer', 'redeem'], funds: '*', investor_kinds: '*', residence: '*' },
  condition: { op: 'and', items: [{ op: 'gt', field: 'order.amount', value: 1 }] },
  outcome: { result: 'fail', layer: 'Fund policy', label: 'Test label', detail: 'Test detail for {investor.short}' },
});
const rule = (patch: Partial<CustomRule> & { condition?: Condition } = {}, id = 'crl_test'): CustomRule => ({
  ...clone(base), id, version: 1, status: 'active', effective_from: '2026-01-01', effective_to: null, authored_by: 'Test author', reviewed_by: 'Test reviewer', approved_at: '2026-01-01T00:00:00Z', ...patch,
});
const cond = (c: Condition) => evaluateCondition(c, F);

// ---------- Facts ----------
eq(F.order.amount, 2_000_000, 'order amount');
eq(F.investor.residence, 'SG', 'investor residence');
eq(F.investor.classes, ['HK_PI', 'SG_AI'], 'valid classes, sorted');
eq(F.investor.credentialDaysToExpiry, 164, 'days to expiry from 2026-10-01 to 2027-03-14');
eq(F.holding.exists, true, 'lumen holds TWLF');
eq(F.counterparty, null, 'no counterparty on a subscription');
const meitan = factsOf({ ...lumenSub, investorId: 'meitan' });
eq(meitan.holding, { units: 0, ageDays: null, exists: false }, 'no holding facts');

// ---------- Every comparison operator ----------
ok(cond({ op: 'eq', field: 'order.asset', value: 'usdc' }), 'eq on text is case-insensitive');
ok(!cond({ op: 'eq', field: 'order.asset', value: 'USDT' }), 'eq false');
ok(cond({ op: 'ne', field: 'investor.residence', value: 'HK' }), 'ne on text');
ok(cond({ op: 'gt', field: 'order.amount', value: 1_999_999 }) && !cond({ op: 'gt', field: 'order.amount', value: 2_000_000 }), 'gt is strict');
ok(cond({ op: 'gte', field: 'order.amount', value: 2_000_000 }), 'gte at the boundary');
ok(cond({ op: 'lt', field: 'order.amount', value: 2_000_001 }) && !cond({ op: 'lt', field: 'order.amount', value: 2_000_000 }), 'lt is strict');
ok(cond({ op: 'lte', field: 'order.amount', value: 2_000_000 }), 'lte at the boundary');
ok(cond({ op: 'in', field: 'investor.residence', value: ['HK', 'sg'] }), 'in on a list, case-insensitive');
ok(cond({ op: 'notIn', field: 'investor.residence', value: ['HK', 'US'] }) && !cond({ op: 'notIn', field: 'investor.residence', value: ['SG'] }), 'notIn');
ok(cond({ op: 'in', field: 'order.amount', value: [1, 2_000_000] }), 'in on numbers');
ok(cond({ op: 'has', field: 'investor.classes', value: 'SG_AI' }) && !cond({ op: 'has', field: 'investor.classes', value: 'US_AI' }), 'has on a set');
ok(cond({ op: 'hasAny', field: 'investor.classes', value: ['US_AI', 'HK_PI'] }) && !cond({ op: 'hasAny', field: 'investor.classes', value: ['US_AI'] }), 'hasAny');
ok(cond({ op: 'hasAll', field: 'investor.classes', value: ['SG_AI', 'HK_PI'] }) && !cond({ op: 'hasAll', field: 'investor.classes', value: ['SG_AI', 'US_AI'] }), 'hasAll');
ok(cond({ op: 'eq', field: 'investor.usPerson', value: false }) && cond({ op: 'eq', field: 'investor.usPerson', value: 'false' }), 'boolean eq, also from text');
ok(cond({ op: 'ne', field: 'holding.exists', value: false }), 'boolean ne');
ok(!cond({ op: 'eq', field: 'counterparty.residence', value: 'SG' }) && !cond({ op: 'ne', field: 'counterparty.residence', value: 'SG' }), 'a missing value satisfies nothing, not even ne');
ok(!cond({ op: 'lt', field: 'fund.holderCap', value: 1000 }), 'an empty holder cap satisfies nothing');
ok(!cond({ op: 'gt', field: 'order.asset', value: 5 }), 'a mismatched operator is false, never a throw');

// ---------- Nested groups ----------
ok(cond({ op: 'and', items: [{ op: 'eq', field: 'investor.residence', value: 'SG' }, { op: 'or', items: [{ op: 'eq', field: 'order.asset', value: 'USDT' }, { op: 'gt', field: 'order.amount', value: 1_000_000 }] }] }), 'and over a nested or');
ok(!cond({ op: 'and', items: [{ op: 'eq', field: 'investor.residence', value: 'SG' }, { op: 'not', item: { op: 'gt', field: 'order.amount', value: 1_000_000 } }] }), 'not inside and');
ok(cond({ op: 'or', items: [{ op: 'not', item: { op: 'and', items: [{ op: 'eq', field: 'fund.ticker', value: 'TWLF' }, { op: 'eq', field: 'order.asset', value: 'USDT' }] } }] }), 'or over not over and');

// ---------- Templating ----------
eq(renderTemplate('{investor.short} orders {order.amount} {order.currency} of {fund.ticker} on {today}; classes {investor.classes}; cp {counterparty.short}; us {investor.usPerson}; nope {bogus.field}', F),
  'Lumen Family Office orders 2,000,000 USD of TWLF on 2026-10-01; classes HK_PI, SG_AI; cp {counterparty.short}; us no; nope {bogus.field}', 'template renders numbers, sets, booleans, keeps unknown and absent placeholders');

// ---------- Scope: applies_to, jurisdiction, effective dates ----------
ok(ruleApplies(rule(), F), 'wildcard scope applies');
ok(!ruleApplies(rule({ applies_to: { ...base.applies_to, actions: ['redeem'] } }), F), 'action filter');
ok(!ruleApplies(rule({ applies_to: { ...base.applies_to, funds: ['NMEL'] } }), F) && ruleApplies(rule({ applies_to: { ...base.applies_to, funds: ['twlf'] } }), F), 'fund filter, case-insensitive');
ok(ruleApplies(rule({ applies_to: { ...base.applies_to, investor_kinds: ['Corporate'] } }), F), 'Corporate matches any entity kind');
ok(!ruleApplies(rule({ applies_to: { ...base.applies_to, investor_kinds: ['Individual'] } }), F) && ruleApplies(rule({ applies_to: { ...base.applies_to, investor_kinds: ['Individual'] } }), meitan), 'Individual kind filter');
ok(ruleApplies(rule({ applies_to: { ...base.applies_to, investor_kinds: ['Single-family office'] } }), F), 'exact kind match');
ok(!ruleApplies(rule({ applies_to: { ...base.applies_to, residence: ['HK'] } }), F), 'residence filter');
ok(!ruleApplies(rule({ jurisdiction: 'HK' }), F) && ruleApplies(rule({ jurisdiction: 'SG' }), F), 'jurisdiction must be touched by the order');
const xfer: Order = { action: 'transfer', investorId: 'lumen', fundId: 'TWLF', amount: 500_000, asset: 'USDC', counterpartyId: 'qamar' };
ok(ruleApplies(rule({ jurisdiction: 'AE-DIFC' }), factsOf(xfer)), 'a transfer touches the counterparty jurisdiction');
ok(ruleInForce({ effective_from: '2026-10-01', effective_to: null }, TODAY) && !ruleInForce({ effective_from: '2026-10-02', effective_to: null }, TODAY), 'effective_from is inclusive');
ok(ruleInForce({ effective_from: null, effective_to: '2026-10-02' }, TODAY) && !ruleInForce({ effective_from: null, effective_to: '2026-10-01' }, TODAY), 'effective_to is exclusive');
eq(evaluateCustomRules([rule({ effective_from: '2026-11-01' })], F), [], 'a future rule yields nothing');
eq(evaluateCustomRules([rule({ effective_to: '2026-09-30' })], F), [], 'an expired rule yields nothing');

// ---------- Checks and outcomes ----------
const fired = evaluateCustomRules([rule()], F);
eq(fired.length, 1, 'one check per applicable rule');
eq([fired[0].id, fired[0].result, fired[0].layer, fired[0].detail, fired[0].subject], ['custom:crl_test', 'fail', 'Fund policy', 'Test detail for Lumen Family Office', 'Lumen Family Office'], 'fail check shape');
const quiet = evaluateCustomRules([rule({ condition: { op: 'gt', field: 'order.amount', value: 1e9 } })], F);
eq([quiet[0].result, quiet[0].custom.matched], ['pass', false], 'a rule whose condition does not hold records a pass');
const info = evaluateCustomRules([rule({ outcome: { ...base.outcome, result: 'info', remedy: 'ignored' } })], F);
eq([info[0].result, info[0].remedy], ['info', undefined], 'info result carries no remedy');
const two = evaluateCustomRules([rule({ version: 2, outcome: { ...base.outcome, label: 'v2' } }), rule({ version: 1 })], F);
eq([two.length, two[0].label, two[0].custom.version], [1, 'v2', 2], 'highest version wins when two are in force');
const order = evaluateCustomRules([rule({}, 'crl_b'), rule({}, 'crl_a')], F).map((c) => c.id);
eq(order, ['custom:crl_a', 'custom:crl_b'], 'checks come out in rule id order');

// ---------- Through the engine ----------
const ctxWith = (rules: CustomRule[]): Ctx => ({ ...clone(defaultCtx), customRules: rules });
const plain = evaluate(lumenSub);
eq(plain.outcome, 'ALLOW', 'baseline allows');
const denied = evaluate(lumenSub, [], ctxWith([rule()]));
eq(denied.outcome, 'DENY', 'a fail rule denies');
ok(denied.checks.some((c) => c.id === 'custom:crl_test' && c.result === 'fail'), 'the custom check is in the trace');
ok(denied.headline.startsWith('Subscription denied. Test detail for Lumen Family Office'), 'headline quotes the rule detail');
const frozen = evaluate(lumenSub, [], ctxWith([rule({ outcome: { ...base.outcome, result: 'freeze', layer: 'Global screens' } })]));
eq(frozen.outcome, 'FREEZE', 'a freeze rule freezes');
const flagged = evaluate(lumenSub, [], ctxWith([rule({ outcome: { ...base.outcome, result: 'info' } })]));
eq(flagged.outcome, 'ALLOW', 'an info rule does not change the outcome');
ok(flagged.checks.some((c) => c.id === 'custom:crl_test' && c.result === 'info'), 'info check present');
const untouched = evaluate(lumenSub, [], ctxWith([rule({ applies_to: { ...base.applies_to, actions: ['redeem'] } })]));
eq(untouched.checks.map((c) => c.id), plain.checks.map((c) => c.id), 'an out-of-scope rule leaves the trace unchanged');
// Freeze from the engine's own screens still wins before custom rules run.
const sanctioned = evaluate(lumenSub, ['sanctioned'], ctxWith([rule()]));
eq(sanctioned.outcome, 'FREEZE', 'sanctions freeze first');
ok(!sanctioned.checks.some((c) => c.id.startsWith('custom:')), 'custom rules do not run after an early freeze');
// A transfer rule on the counterparty.
const cpRule = rule({ condition: { op: 'eq', field: 'counterparty.residence', value: 'AE-DIFC' }, outcome: { ...base.outcome, layer: 'Counterparty', label: 'No DIFC receivers' } });
const xd = evaluate(xfer, [], ctxWith([cpRule]));
eq(xd.outcome, 'DENY', 'counterparty rule denies the transfer');
eq(xd.checks.find((c) => c.id === 'custom:crl_test')?.subject, 'Qamar Holdings', 'counterparty layer names the receiver');

// ---------- Determinism, hash and snapshot round trip ----------
const d1 = evaluate(lumenSub, [], ctxWith([rule()])); const d2 = evaluate(lumenSub, [], ctxWith([rule()]));
eq(d1.checks, d2.checks, 'deterministic checks with a rule applied');
const h1 = await inputsHash(d1); const h2 = await inputsHash(d2); const h0 = await inputsHash(plain);
ok(h1 === h2 && h1 !== h0, 'inputs hash is stable and differs from the baseline because the custom check is in it');
const snap = snapshotFor(lumenSub, ctxWith([rule()]), []);
eq(snap.customRules?.length, 1, 'snapshot carries the rules');
const replayed = replaySnapshot(snap);
eq([replayed.outcome, await inputsHash(replayed)], ['DENY', h1], 'replay from the snapshot reproduces the outcome and hash');
const snapRt = JSON.parse(JSON.stringify(snap));
eq(ctxFromSnapshot(snapRt).customRules?.[0].id, 'crl_test', 'ctxFromSnapshot restores the rules after a JSON round trip');
const snapNone = snapshotFor(lumenSub, defaultCtx, []);
ok(!('customRules' in snapNone), 'no rules, no field on the snapshot');

// ---------- Schema and validation ----------
const parsed = parseDefinition({ name: 'Cap', applies_to: { actions: ['subscribe'], funds: '*', investor_kinds: '*', residence: '*' }, condition: { op: 'gt', field: 'order.amount', value: 10 }, outcome: { result: 'fail', layer: 'Fund policy', label: 'Cap hit', detail: 'Too big' } });
eq([parsed.definition.severity, parsed.definition.jurisdiction, parsed.problems], ['medium', '*', []], 'defaults fill in and a clean definition has no problems');
assert.throws(() => ruleDefinitionSchema.parse({ ...base, condition: { op: 'gt', field: 'order.amoun', value: 1 } }), 'unknown field is rejected by the schema'); n++;
assert.throws(() => ruleDefinitionSchema.parse({ ...base, outcome: { ...base.outcome, layer: 'Nowhere' } }), 'unknown layer is rejected'); n++;
assert.throws(() => ruleDefinitionSchema.parse({ ...base, applies_to: { ...base.applies_to, actions: [] } }), 'at least one action'); n++;
const bad = validateDefinition({ ...base, condition: { op: 'and', items: [{ op: 'gt', field: 'order.asset', value: 5 }, { op: 'has', field: 'order.amount', value: 1 }, { op: 'in', field: 'investor.residence', value: 'SG' }] }, outcome: { ...base.outcome, detail: 'See {investor.nothing}' } });
ok(bad.length === 5 && bad.some((p) => p.includes('does not apply')) && bad.some((p) => p.includes('needs a list')) && bad.some((p) => p.includes('not a known field')), `semantic problems are named: ${bad.join(' | ')}`);
ok(validateDefinition({ ...base, outcome: { ...base.outcome, result: 'info', remedy: 'x' } }).some((p) => p.includes('no remedy')), 'info with remedy is flagged');
for (const f of FIELDS) ok(operatorsFor(f.type).length > 0, `${f.key} has operators`);
ok(OPERATORS.length === 11, 'eleven comparison operators');

// ---------- Plain language, diff, fingerprint ----------
eq(describeCondition({ op: 'and', items: [{ op: 'gt', field: 'order.amount', value: 1_000_000 }, { op: 'or', items: [{ op: 'in', field: 'investor.residence', value: ['SG', 'HK'] }, { op: 'has', field: 'investor.classes', value: 'SG_AI' }] }] }),
  'order amount is more than 1,000,000 and (investor residence is one of SG or HK or investor classifications includes SG_AI)', 'plain-English condition');
ok(describeRule(base).startsWith('On subscriptions, transfers and redemptions in any fund, when all of these are true: order amount is more than 1; then deny the order with "Test label".'), 'plain-English rule');
const diff = diffDefinitions(base, { ...base, name: 'Renamed', outcome: { ...base.outcome, result: 'info' } });
eq(diff.map((x) => x.path), ['name', 'outcome.result'], 'diff lists changed paths');
ok(definitionFingerprint(base) === definitionFingerprint(clone(base)) && definitionFingerprint(base) !== definitionFingerprint({ ...base, name: 'x' }), 'fingerprint tracks the definition');

// ---------- Templates ----------
eq(RULE_TEMPLATES.length, 6, 'six starter templates');
for (const t of RULE_TEMPLATES) {
  eq(validateDefinition(t.definition), [], `template ${t.id} is valid`);
  ok(!JSON.stringify(t).includes('—'), `template ${t.id} has no em dashes`);
}
const T = (id: string) => rule({ ...RULE_TEMPLATES.find((t) => t.id === id)!.definition }, id);
eq(evaluate({ ...lumenSub, amount: 30_000_000 }, [], ctxWith([T('large-entity-subscription')])).outcome, 'DENY', 'template: large entity subscription denied');
eq(evaluate({ ...lumenSub, amount: 30_000_000, investorId: 'meitan' }, [], ctxWith([T('large-entity-subscription')])).checks.some((c) => c.id.startsWith('custom:')), false, 'template: entity rule skips individuals');
const soonCtx = ctxWith([T('credential-expiry-buffer')]); soonCtx.investors.lumen.expires = '2026-10-15';
eq(evaluate(lumenSub, [], soonCtx).outcome, 'DENY', 'template: credential within 30 days denied');
eq(evaluate(lumenSub, [], ctxWith([T('credential-expiry-buffer')])).outcome, 'ALLOW', 'template: credential with 164 days left allowed');
eq(evaluate({ ...lumenSub, asset: 'USDT' }, [], ctxWith([T('asset-blocked-in-jurisdiction')])).checks.find((c) => c.id === 'custom:asset-blocked-in-jurisdiction')?.result, 'fail', 'template: USDT blocked for Singapore');
eq(evaluate({ ...lumenSub, investorId: 'qamar', asset: 'USDT' }, [], ctxWith([T('asset-blocked-in-jurisdiction')])).checks.some((c) => c.id.startsWith('custom:')), false, 'template: Singapore rule skips a Dubai client');
const capCtx = ctxWith([T('individual-order-cap')]);
eq(evaluate({ action: 'redeem', investorId: 'reyes', fundId: 'AGPC', amount: 3_000_000, asset: 'USDC' }, [], capCtx).checks.find((c) => c.id === 'custom:individual-order-cap')?.result, 'fail', 'template: individual cap on a redemption');
const first = evaluate({ ...lumenSub, investorId: 'meitan' }, [], ctxWith([T('first-time-investor-flag')]));
eq(first.checks.find((c) => c.id === 'custom:first-time-investor-flag')?.result, 'info', 'template: first-time flag is informational');
eq(evaluate(lumenSub, [], ctxWith([T('first-time-investor-flag')])).checks.find((c) => c.id === 'custom:first-time-investor-flag')?.result, 'pass', 'template: existing holder passes the flag');
const mmCtx = ctxWith([T('residence-freeze')]); mmCtx.investors.lumen.residence = 'MM'; mmCtx.jurName.MM = 'Myanmar';
eq(evaluate(lumenSub, [], mmCtx).outcome, 'FREEZE', 'template: paused residence freezes');

console.log(`${n} custom-rule checks passed`);
