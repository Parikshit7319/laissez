// Golden regression cases for every rule pack, plus integrity checks on the rule-pack data.
// Run with: npm run test:rules
import assert from 'node:assert/strict';
import { evaluate, defaultCtx, type Ctx } from '../src/proto/engine';
import { funds as FUNDS, type Investor, type Classification } from '../src/proto/data';
import { TESTS, findTest } from '../src/proto/thresholds';
import { sources } from '../src/data/sources';
import {
  NEW_JURISDICTIONS, NEW_CLASSES, NEW_LAW, NEW_BOOKING_CENTERS, RULE_PACKS, REGRESSION_CASES, GLOBAL_JURISDICTION,
  extendCtx, packsAsOf, type CaseParty, type RegressionCase,
} from '../src/proto/rulepacks';
import { PLACEMENT_LIMITS } from '../api/src/placement-limits';
import { lawDefaults } from '../api/src/seed';
import '../api/src/rulepacks';

const ISSUED = '2026-06-01';
const EXPIRES = '2027-06-01';
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const base = extendCtx(defaultCtx);

/** Turns a case party into an engine investor. Evidence runs through the threshold tests first. */
function materialize(p: CaseParty): { investor: Investor; issued: string[] } {
  const issued: string[] = [];
  const classifications: Classification[] = [...clone(p.classifications ?? [])];
  for (const [code, ev] of Object.entries(p.evidence ?? {})) {
    const test = findTest(code, p.kind);
    if (!test) throw new Error(`No ${p.kind} threshold test for ${code}`);
    const r = test.check(ev);
    if (!r.pass) continue;
    issued.push(code);
    classifications.push({ code, basis: r.reason, verified: ISSUED, expires: EXPIRES, ...(ev.opt_in ? { optIn: ISSUED } : {}) });
  }
  const investor: Investor = {
    id: p.id, name: p.name, short: p.name, kind: p.kind, residence: p.residence, city: base.jurName[p.residence] ?? p.residence, booking: p.booking,
    usPerson: !!p.usPerson, wallet: '0x0000…test', credentialId: `LP-TEST-${p.id}`, issued: ISSUED, expires: EXPIRES,
    classifications, holdings: clone(p.holdings ?? {}),
  };
  return { investor, issued };
}

function ctxFor(c: RegressionCase): { ctx: Ctx; issued: string[] } {
  const inv = materialize(c.investor);
  const cp = c.counterparty ? materialize(c.counterparty) : null;
  const fund = clone(FUNDS[c.fund]);
  fund.distribution = { ...fund.distribution, ...clone(c.distribution ?? {}) };
  Object.assign(fund, clone(c.fund_patch ?? {}));
  const hitName = c.screenHit === 'investor' ? inv.investor.name : c.screenHit === 'counterparty' ? cp?.investor.name : undefined;
  const ctx: Ctx = {
    ...base,
    investors: { [inv.investor.id]: inv.investor, ...(cp ? { [cp.investor.id]: cp.investor } : {}) },
    funds: { [fund.id]: fund },
    ...(hitName ? { screen: (name: string) => (name === hitName ? { entry: name, program: 'Test watchlist entry' } : null) } : {}),
  };
  return { ctx, issued: inv.issued };
}

const sorted = (xs: string[]) => [...xs].sort();
const results = new Map<string, { pass: number; total: number }>();
const failures: string[] = [];

for (const c of REGRESSION_CASES) {
  const tally = results.get(c.pack) ?? { pass: 0, total: 0 };
  tally.total++;
  results.set(c.pack, tally);
  try {
    const { ctx, issued } = ctxFor(c);
    const d = evaluate({ ...c.order, investorId: c.investor.id, fundId: c.fund, counterpartyId: c.counterparty?.id }, c.whatIfs ?? [], ctx);
    const failing = d.checks.filter((x) => x.result === 'fail').map((x) => x.id);
    assert.equal(d.outcome, c.expect, `outcome ${d.outcome}, expected ${c.expect}. ${d.headline}`);
    assert.deepEqual(sorted(failing), sorted(c.failing), `failing checks [${failing.join(', ')}], expected [${c.failing.join(', ')}]`);
    if (c.issued) assert.deepEqual(sorted(issued), sorted(c.issued), `issued [${issued.join(', ')}], expected [${c.issued.join(', ')}]`);
    if (c.binding) {
      const binding = d.checks.filter((x) => x.binding).map((x) => x.id);
      assert.deepEqual(sorted(binding), sorted(c.binding), `binding [${binding.join(', ')}], expected [${c.binding.join(', ')}]`);
    }
    for (const id of c.present ?? []) assert.ok(d.checks.some((x) => x.id === id), `check ${id} missing`);
    for (const id of c.absent ?? []) assert.ok(!d.checks.some((x) => x.id === id), `check ${id} should be absent`);
    // Determinism: the same inputs give the same checks.
    assert.deepEqual(evaluate({ ...c.order, investorId: c.investor.id, fundId: c.fund, counterpartyId: c.counterparty?.id }, c.whatIfs ?? [], ctx).checks, d.checks, 'not deterministic');
    tally.pass++;
  } catch (e) {
    failures.push(`${c.id} (${c.name}): ${(e as Error).message}`);
  }
}

// ---------- Integrity of the rule-pack data ----------
let integrity = 0;
const check = (cond: unknown, msg: string) => { integrity++; if (!cond) failures.push(`integrity: ${msg}`); };
const sourceIds = new Set(sources.map((s) => s.id));
const knownJur = new Set([...Object.keys(defaultCtx.jurName), ...NEW_JURISDICTIONS.map((j) => j.code), GLOBAL_JURISDICTION.code]);

// Every jurisdiction pack has at least 4 golden cases; global packs at least 2.
for (const id of new Set(RULE_PACKS.map((p) => p.id))) {
  const n = REGRESSION_CASES.filter((c) => c.pack === id).length;
  check(n >= (id.startsWith('global/') ? 2 : 4), `${id} has ${n} regression cases`);
}
check(REGRESSION_CASES.every((c) => RULE_PACKS.some((p) => p.id === c.pack)), 'every case names a known pack');
check(new Set(REGRESSION_CASES.map((c) => c.id)).size === REGRESSION_CASES.length, 'case ids are unique');

// Pack versions and effective dates.
check(packsAsOf(RULE_PACKS, '2026-06-15')['SG/eligibility'] === '2026.03.0', 'SG 2026.03.0 in force on 2026-06-15');
check(packsAsOf(RULE_PACKS, '2026-08-31')['SG/eligibility'] === '2026.03.0', 'SG 2026.03.0 in force on 2026-08-31');
check(packsAsOf(RULE_PACKS, '2026-09-01')['SG/eligibility'] === '2026.09.0', 'SG 2026.09.0 in force from 2026-09-01');
check(packsAsOf(RULE_PACKS, '2026-09-30')['GB/eligibility'] === undefined, 'no GB pack in force before 2026-10-01 (the CP25/36 draft never applies)');
const oct1 = packsAsOf(RULE_PACKS, '2026-10-01');
for (const j of ['GB', 'JP', 'AE-ADGM', 'LU', 'IE']) check(oct1[`${j}/eligibility`] === '2026.10.0', `${j} 2026.10.0 in force on 2026-10-01`);
check(oct1['global/sanctions'] === '2026-10-01' && oct1['global/travel-rule'] === '2026.07', 'global packs in force on 2026-10-01');
check(oct1['HK/eligibility'] === '2026.04.2' && oct1['US/eligibility'] === '2026.07.0', 'launch packs unchanged');
for (const p of RULE_PACKS) {
  check(knownJur.has(p.jurisdiction), `${p.id}@${p.version} jurisdiction ${p.jurisdiction} exists`);
  check(p.status === 'draft' ? p.effective_from === null : !!p.effective_from, `${p.id}@${p.version} effective_from matches status`);
  check(!p.effective_to || (p.effective_from && p.effective_from < p.effective_to), `${p.id}@${p.version} date range is ordered`);
  check(p.id.startsWith('global/') ? p.jurisdiction === 'GLOBAL' : p.id === `${p.jurisdiction}/eligibility`, `${p.id} filed under ${p.jurisdiction}`);
}

// Classes, law rules and booking centers point at things that exist.
for (const c of NEW_CLASSES) {
  check(sourceIds.has(c.source_id), `${c.code} source ${c.source_id} is on /sources`);
  check(knownJur.has(c.jurisdiction), `${c.code} jurisdiction exists`);
}
const testSubjects: Record<string, string[]> = {
  GB_PRO: ['entity'], GB_EPRO: ['individual', 'entity'], JP_QII: ['individual', 'entity'], ADGM_PRO: ['individual', 'entity'],
  US_QP: ['individual', 'entity'], US_QIB: ['entity'], US_IAI: ['entity'], IN_AI: ['individual', 'entity'], IN_LRS: ['individual'], IFSCA_PRO: ['individual', 'entity'],
  AU_WHOLESALE: ['individual', 'entity'], AU_PRO: ['individual', 'entity'], CA_AI: ['individual', 'entity'], CA_PC: ['individual', 'entity'], CA_MIN: ['entity'],
  BR_QUAL: ['individual', 'entity'], BR_PRO: ['individual', 'entity'], KR_PRO: ['individual', 'entity'], KR_QPI: ['entity'],
};
for (const [code, subjects] of Object.entries(testSubjects)) for (const s of subjects) check(TESTS.some((t) => t.code === code && t.subject === s), `${code} has an ${s} threshold test`);
for (const [j, l] of Object.entries(NEW_LAW)) {
  check(sourceIds.has(l.lawSource), `${j} law source ${l.lawSource} is on /sources`);
  check(l.accepts.every((c) => !!base.classInfo[c]) && (!l.lawRequires || !!base.classInfo[l.lawRequires]), `${j} law classes exist`);
  check(!l.lawRequires || l.accepts.includes(l.lawRequires), `${j} accepts the class its law requires`);
  const d = lawDefaults(j, true);
  check(!!d && d.lawRequires === l.lawRequires && d.basis === 'Regulation S offer', `${j} registered into EXTRA_LAW for issuers`);
}
for (const b of NEW_BOOKING_CENTERS) check(sourceIds.has(b.source) && (!b.requires || !!base.classInfo[b.requires]) && ((b as any).requiresAny ?? []).every((c: string) => !!base.classInfo[c]), `${b.id} booking center references exist`);
check(!!base.classInfo.SG_AI.requiresOptIn && base.classInfo.SG_AI.optInLabel === 'opt-in', 'SG_AI carries its opt-in label');
check(!!base.classInfo.GB_EPRO.requiresOptIn && base.classInfo.GB_EPRO.optInLabel === 'written opt-up', 'GB_EPRO carries its written opt-up label');
check(!base.classInfo.JP_QII.requiresOptIn && base.classInfo.JP_QII.optInLabel === 'FSA notification', 'JP_QII records the FSA notification label without a separate consent step');
check(NEW_LAW.GB.lawRequiresAny?.length === 2 && NEW_LAW.GB.accepts.includes('GB_EPRO'), 'GB law accepts per se or elective professional clients');
check(packsAsOf(RULE_PACKS, '2026-10-02')['US/eligibility'] === '2026.10.0' && packsAsOf(RULE_PACKS, '2026-10-02')['IN/eligibility'] === '2026.10.0', 'US 2026.10.0 and IN 2026.10.0 in force from 2026-10-02');
const oct3 = packsAsOf(RULE_PACKS, '2026-10-03');
for (const j of ['AU', 'CA', 'BR', 'KR']) check(oct3[`${j}/eligibility`] === '2026.10.1' && oct1[`${j}/eligibility`] === undefined, `${j} 2026.10.1 in force from 2026-10-03 and not before`);
check(!findTest('CA_MIN', 'Individual') && !findTest('KR_QPI', 'Individual'), 'CA_MIN and KR_QPI are not available to individuals');
check(!!base.classInfo.BR_QUAL.requiresOptIn && base.classInfo.BR_QUAL.optInLabel === 'written attestation', 'BR_QUAL needs the written attestation');
for (const id of ['SYD', 'TOR', 'SAO', 'SEL']) check(NEW_BOOKING_CENTERS.some((b) => b.id === id && ((b as any).requiresAny ?? []).length >= 2), `${id} booking center accepts more than one class`);
check(packsAsOf(RULE_PACKS, '2025-01-15')['global/sanctions'] === '2024-01-01' && packsAsOf(RULE_PACKS, '2025-08-25')['global/sanctions'] === '2025-08-25' && packsAsOf(RULE_PACKS, '2026-09-30')['global/sanctions'] === '2025-08-25', 'sanctions pack history resolves by date');

// Threshold boundaries for the new classes.
const t = (code: string, kind: string, e: Record<string, number | boolean>) => findTest(code, kind)!.check(e).pass;
check(t('GB_PRO', 'Corporate', { balance_sheet: 20_000_000, net_turnover: 40_000_000 }), 'GB_PRO passes at exactly EUR 20M and EUR 40M');
check(!t('GB_PRO', 'Corporate', { balance_sheet: 19_999_999, net_turnover: 40_000_000, own_funds: 1_999_999 }), 'GB_PRO fails at 1 of 3');
check(!t('GB_EPRO', 'Individual', { qualitative: true, portfolio: 500_000, finance_role: true, opt_in: true }), 'GB_EPRO portfolio must exceed EUR 500,000 (1 of 3 here)');
check(t('GB_EPRO', 'Individual', { qualitative: true, portfolio: 500_001, finance_role: true, opt_in: true }), 'GB_EPRO passes just over EUR 500,000 with a finance role and opt-up');
check(!t('GB_EPRO', 'Corporate', { portfolio: 900_000, frequent_trading: true, finance_role: true, opt_in: true }), 'GB_EPRO needs the qualitative assessment');
check(t('JP_QII', 'Corporate', { securities_balance: 1_000_000_000, fsa_notification: true }), 'JP_QII corporation at JPY 1 billion with notification');
check(!t('JP_QII', 'Corporate', { securities_balance: 5_000_000_000 }), 'JP_QII corporation needs FSA notification');
check(!t('ADGM_PRO', 'Corporate', { balance_sheet: 20_000_000, own_funds: 999_999 }), 'ADGM_PRO entity fails at 1 of 3 without experience');
check(t('ADGM_PRO', 'Corporate', { own_funds: 1_000_000, experience: true }), 'ADGM_PRO assessed undertaking at exactly US$1M with experience');
check(t('US_QP', 'Individual', { investments: 5_000_000 }) && !t('US_QP', 'Individual', { investments: 4_999_999 }), 'US_QP individual at $5M, not one dollar under');
check(t('US_QP', 'Corporate', { family_company: true, investments: 5_000_000 }) && !t('US_QP', 'Corporate', { investments: 24_999_999 }) && t('US_QP', 'Corporate', { investments: 25_000_000 }), 'US_QP family company at $5M, other entities at $25M');
check(t('US_QIB', 'Corporate', { securities: 100_000_000 }) && !t('US_QIB', 'Corporate', { securities: 99_999_999 }), 'US_QIB at $100M');
check(t('US_QIB', 'Corporate', { registered_dealer: true, securities: 10_000_000 }) && !t('US_QIB', 'Corporate', { bank: true, securities: 100_000_000, net_worth: 24_999_999 }), 'US_QIB dealer at $10M; bank needs $25M net worth');
check(t('US_IAI', 'Corporate', { total_assets: 5_000_001 }) && !t('US_IAI', 'Corporate', { total_assets: 5_000_000 }), 'US_IAI organization needs total assets over $5M');
check(t('IN_AI', 'Individual', { annual_income: 20_000_000 }) && !t('IN_AI', 'Individual', { annual_income: 9_999_999, net_worth: 74_999_999, financial_assets: 37_500_000 }), 'IN_AI individual at INR 2 crore income, not under; net worth needs INR 7.5 crore');
check(t('IN_AI', 'Individual', { net_worth: 75_000_000, financial_assets: 37_500_000 }) && !t('IN_AI', 'Individual', { net_worth: 75_000_000, financial_assets: 37_499_999 }), 'IN_AI net worth route needs INR 3.75 crore financial');
check(t('IN_AI', 'Individual', { annual_income: 10_000_000, net_worth: 50_000_000, financial_assets: 25_000_000 }) && !t('IN_AI', 'Individual', { annual_income: 10_000_000, net_worth: 50_000_000, financial_assets: 24_999_999 }), 'IN_AI combined route: INR 1 crore income plus INR 5 crore net worth, half financial');
check(t('IN_AI', 'Corporate', { net_worth: 500_000_000 }) && !t('IN_AI', 'Corporate', { net_worth: 499_999_999 }), 'IN_AI body corporate at INR 50 crore');
check(t('IN_LRS', 'Individual', { resident_individual: true, pan: true, remitted_this_fy_usd: 249_999 }) && !t('IN_LRS', 'Individual', { resident_individual: true, pan: true, remitted_this_fy_usd: 250_000 }) && !t('IN_LRS', 'Individual', { resident_individual: true, remitted_this_fy_usd: 0 }), 'IN_LRS needs a resident individual with PAN and allowance left');
check(t('IFSCA_PRO', 'Individual', { annual_income: 200_000 }) && !t('IFSCA_PRO', 'Individual', { annual_income: 199_999, net_assets: 1_000_000, financial_assets: 499_999 }) && t('IFSCA_PRO', 'Individual', { net_assets: 1_000_000, financial_assets: 500_000 }), 'IFSCA_PRO individual at US$200K income or US$1M net assets with US$500K financial');
check(t('IFSCA_PRO', 'Corporate', { net_worth: 5_000_000 }) && !t('IFSCA_PRO', 'Corporate', { net_worth: 4_999_999 }), 'IFSCA_PRO body corporate at US$5M');
// Australia
check(t('AU_WHOLESALE', 'Individual', { product_value: 500_000 }) && !t('AU_WHOLESALE', 'Individual', { product_value: 499_999 }), 'AU_WHOLESALE product value at A$500,000');
check(t('AU_WHOLESALE', 'Corporate', { accountant_certificate: true, net_assets: 2_500_000 }) && !t('AU_WHOLESALE', 'Corporate', { net_assets: 2_500_000 }), 'AU_WHOLESALE net assets need the certificate');
check(t('AU_WHOLESALE', 'Individual', { accountant_certificate: true, gross_income: 250_000 }) && !t('AU_WHOLESALE', 'Individual', { accountant_certificate: true, gross_income: 249_999, net_assets: 2_499_999 }), 'AU_WHOLESALE gross income at A$250,000');
check(t('AU_WHOLESALE', 'Corporate', { large_business: true }) && !t('AU_WHOLESALE', 'Individual', { large_business: true } as any), 'AU_WHOLESALE large business route is for entities');
check(t('AU_PRO', 'Individual', { gross_assets: 10_000_000 }) && !t('AU_PRO', 'Individual', { gross_assets: 9_999_999 }) && t('AU_PRO', 'Corporate', { regulated_entity: true }), 'AU_PRO at A$10M gross assets or by status');
// Canada
check(t('CA_AI', 'Individual', { financial_assets: 1_000_001, risk_acknowledgement: true }) && !t('CA_AI', 'Individual', { financial_assets: 1_000_000, risk_acknowledgement: true }) && !t('CA_AI', 'Individual', { financial_assets: 1_000_001 }), 'CA_AI (j) over C$1M with Form 45-106F9');
check(t('CA_AI', 'Individual', { financial_assets: 5_000_001 }) && !t('CA_AI', 'Individual', { financial_assets: 5_000_000 }), 'CA_AI (j.1) over C$5M needs no form');
check(t('CA_AI', 'Individual', { net_income: 200_001, risk_acknowledgement: true }) && !t('CA_AI', 'Individual', { net_income: 200_000, risk_acknowledgement: true }) && t('CA_AI', 'Individual', { net_income: 300_001, joint: true, risk_acknowledgement: true }) && !t('CA_AI', 'Individual', { net_income: 300_000, joint: true, risk_acknowledgement: true }), 'CA_AI (k) income over C$200,000, C$300,000 joint');
check(t('CA_AI', 'Individual', { net_assets: 5_000_000, risk_acknowledgement: true }) && !t('CA_AI', 'Individual', { net_assets: 4_999_999, risk_acknowledgement: true }), 'CA_AI (l) net assets at C$5M');
check(t('CA_AI', 'Corporate', { net_assets: 5_000_000 }) && !t('CA_AI', 'Corporate', { net_assets: 4_999_999 }), 'CA_AI (m) non-individual net assets at C$5M');
check(t('CA_PC', 'Individual', { financial_assets: 5_000_001 }) && !t('CA_PC', 'Individual', { financial_assets: 5_000_000 }) && t('CA_PC', 'Corporate', { net_assets: 25_000_000 }) && !t('CA_PC', 'Corporate', { net_assets: 24_999_999 }), 'CA_PC over C$5M financial assets, C$25M net assets');
check(t('CA_MIN', 'Corporate', { acquisition_cost: 150_000, not_created_for_exemption: true }) && !t('CA_MIN', 'Corporate', { acquisition_cost: 149_999, not_created_for_exemption: true }) && !t('CA_MIN', 'Corporate', { acquisition_cost: 150_000 }), 'CA_MIN at C$150,000, not for a vehicle created for the exemption');
// Brazil
check(t('BR_QUAL', 'Individual', { financial_investments: 1_000_001, opt_in: true }) && !t('BR_QUAL', 'Individual', { financial_investments: 1_000_000, opt_in: true }) && !t('BR_QUAL', 'Individual', { financial_investments: 1_000_001 }), 'BR_QUAL over R$1M with written attestation');
check(t('BR_QUAL', 'Individual', { certified_professional: true }) && !t('BR_QUAL', 'Corporate', { certified_professional: true } as any), 'BR_QUAL certification route is for individuals');
check(t('BR_PRO', 'Corporate', { financial_investments: 10_000_001, attestation: true }) && !t('BR_PRO', 'Corporate', { financial_investments: 10_000_000, attestation: true }) && !t('BR_PRO', 'Individual', { financial_investments: 10_000_001 }) && t('BR_PRO', 'Individual', { non_resident: true }), 'BR_PRO over R$10M with attestation, or non-resident');
// South Korea
check(t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, annual_income: 100_000_000 }) && !t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, annual_income: 99_999_999 }), 'KR_PRO KRW 50M balance plus KRW 100M income');
check(t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, annual_income: 150_000_000, joint: true }) && !t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, annual_income: 149_999_999, joint: true }), 'KR_PRO joint income at KRW 150M');
check(t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, net_assets: 500_000_000 }) && !t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, net_assets: 499_999_999 }) && t('KR_PRO', 'Individual', { balance: 50_000_000, balance_one_year: true, professional_qualification: true }), 'KR_PRO net assets at KRW 500M or a qualification');
check(t('KR_PRO', 'Corporate', { listed_corporation: true }) && t('KR_PRO', 'Corporate', { balance: 10_000_000_000 }) && !t('KR_PRO', 'Corporate', { balance: 9_999_999_999 }), 'KR_PRO corporations: listed or KRW 10 billion');
check(t('KR_QPI', 'Corporate', { qualified_institution: true }) && !t('KR_QPI', 'Corporate', {}), 'KR_QPI by institution status only');

// Placement limits cover every jurisdiction the reporting module uses.
for (const j of ['SG', 'HK', 'CH', 'DE', 'AE-DIFC', 'US', 'GB', 'JP', 'AE-ADGM', 'LU', 'IE', 'IN']) check(PLACEMENT_LIMITS.some((l) => l.jurisdiction === j), `placement limits cover ${j}`);
for (const l of PLACEMENT_LIMITS) {
  check(/^https:\/\//.test(l.source_url), `${l.jurisdiction} ${l.citation} has an https source`);
  check(l.number === null || l.unit !== null, `${l.jurisdiction} ${l.citation} gives a unit for its number`);
}

// House style: no em dashes in anything this module ships.
const shipped = JSON.stringify({ NEW_JURISDICTIONS, NEW_CLASSES, NEW_LAW, NEW_BOOKING_CENTERS, RULE_PACKS, REGRESSION_CASES, PLACEMENT_LIMITS, sources: sources.filter((s) => s.group === 'Eligibility rules') });
check(!shipped.includes('\u2014'), 'no em dashes in rule-pack data, placement limits or eligibility sources');
const reasons = TESTS.filter((x) => Object.keys(testSubjects).includes(x.code)).map((x) => x.check({}).reason).join(' ');
check(!reasons.includes('\u2014'), 'no em dashes in threshold reasons');

// ---------- Report ----------
console.log('Rule-pack regression cases');
for (const [pack, r] of [...results.entries()].sort()) {
  const v = oct1[pack] ?? 'not in force';
  console.log(`  ${r.pass === r.total ? 'ok  ' : 'FAIL'} ${pack.padEnd(22)} @${v.padEnd(12)} ${r.pass}/${r.total} cases`);
}
console.log(`  integrity checks: ${integrity - failures.filter((f) => f.startsWith('integrity:')).length}/${integrity}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`${REGRESSION_CASES.length} regression cases and ${integrity} integrity checks passed`);
