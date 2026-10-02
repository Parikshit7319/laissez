// Rule packs added after launch: jurisdictions, investor classes, booking centers and the law
// rules an issuer gets when it adds a jurisdiction to a fund. Also the version history of every
// pack and the golden regression cases that scripts/test-rulepacks.ts runs through the engine.
// Every threshold and citation is listed on /sources (src/data/sources.ts). Research as of Oct 2026.
// Data only, plus two helpers (extendCtx, packsAsOf). Shared by the app, the API and the tests.

import type { BookingCenter, Classification } from './data';
import type { Ctx, ClassMeta, Order, Outcome, WhatIf } from './engine';
import type { Evidence } from './thresholds';

// ---------- Jurisdictions ----------
export type NewJurisdiction = { code: string; name: string; iso3: string; iso_numeric: string };
/** GB already has a row from the launch seed (for the CP25/36 draft pack); the rest are new. */
export const NEW_JURISDICTIONS: NewJurisdiction[] = [
  { code: 'GB', name: 'United Kingdom', iso3: 'GBR', iso_numeric: '826' },
  { code: 'JP', name: 'Japan', iso3: 'JPN', iso_numeric: '392' },
  { code: 'AE-ADGM', name: 'UAE (ADGM)', iso3: 'ARE', iso_numeric: '784' },
  { code: 'LU', name: 'Luxembourg', iso3: 'LUX', iso_numeric: '442' },
  { code: 'IE', name: 'Ireland', iso3: 'IRL', iso_numeric: '372' },
];
/** ISO 3166-1 numeric codes for the launch jurisdictions, backfilled by migration 005. */
export const LAUNCH_ISO_NUMERIC: Record<string, string> = {
  SG: '702', HK: '344', CH: '756', DE: '276', 'AE-DIFC': '784', US: '840', IR: '364', CU: '192', KP: '408',
};
/**
 * Holder for cross-jurisdiction packs (sanctions, Travel Rule). rule_packs.jurisdiction references
 * jurisdictions(code), so it needs a row. It is not a residence. XGL is in the ISO 3166-1 user-assigned range.
 */
export const GLOBAL_JURISDICTION = { code: 'GLOBAL', name: 'Global (cross-jurisdiction rule packs)', iso3: 'XGL', iso_numeric: null as string | null };

// ---------- Investor classes ----------
export type NewClass = {
  code: string; jurisdiction: string; label: string; stamp: string;
  rule_ref: string; source_id: string; threshold: string; requires_opt_in: boolean;
};
/** Luxembourg and Ireland reuse EU_PRO (MiFID II Annex II), which already exists. */
export const NEW_CLASSES: NewClass[] = [
  {
    code: 'GB_PRO', jurisdiction: 'GB', label: 'Professional client (per se)', stamp: 'Professional client', rule_ref: 'COBS 3.5.2R', source_id: 'fca-cobs35',
    threshold: 'Authorised or regulated entity, or a large undertaking meeting 2 of 3: balance sheet EUR 20M, net turnover EUR 40M, own funds EUR 2M.',
    requires_opt_in: false,
  },
  {
    code: 'GB_EPRO', jurisdiction: 'GB', label: 'Elective professional client', stamp: 'Elective professional', rule_ref: 'COBS 3.5.3R', source_id: 'fca-cobs35',
    threshold: 'Qualitative assessment plus 2 of 3: 10 significant trades per quarter over four quarters, a portfolio over EUR 500K, one year in a professional finance role. The client opts up in writing after a written warning.',
    requires_opt_in: true,
  },
  {
    code: 'JP_QII', jurisdiction: 'JP', label: 'Qualified institutional investor', stamp: 'QII', rule_ref: 'Definitions Ordinance Art. 10(1)', source_id: 'jp-qii',
    threshold: 'Listed financial institutions, or a corporation or individual with securities of JPY 1 billion or more that has notified the FSA. Individuals also need a securities account open for a year. Notified status lasts two years.',
    requires_opt_in: false,
  },
  {
    code: 'ADGM_PRO', jurisdiction: 'AE-ADGM', label: 'Professional client', stamp: 'Professional client', rule_ref: 'FSRA COBS 2.4', source_id: 'adgm-cobs',
    threshold: 'Individual: net assets of at least US$1M excluding primary residence, plus experience. Undertaking: own funds of at least US$1M plus experience, or 2 of 3: US$20M balance sheet, US$40M turnover, US$2M own funds.',
    requires_opt_in: false,
  },
];

// ---------- Law rules for a fund's distribution list ----------
export type LawRule = { accepts: string[]; basis: string; lawRequires: string | null; lawText: string; lawRef: string; lawSource: string };
/**
 * Registered into EXTRA_LAW by api/src/rulepacks.ts so issuers can add these jurisdictions.
 * The engine binds a single class per jurisdiction (lawRequires). For GB that is per se status:
 * elective professional clients are professional investors in law, but this pack does not accept
 * them until the engine can bind on either of two classes.
 */
export const NEW_LAW: Record<string, LawRule> = {
  GB: {
    accepts: ['GB_PRO'], basis: 'UK national private placement (AIFM Regulations 2013, regs 57 to 59)', lawRequires: 'GB_PRO',
    lawText: 'Non-UK AIF marketed under the UK national private placement regime after notice to the FCA: professional investors only. This pack binds on per se professional status (COBS 3.5.2R).',
    lawRef: 'AIFM Regs 2013 regs 57-59; COBS 3.5.2R', lawSource: 'uk-aifmr',
  },
  JP: {
    accepts: ['JP_QII'], basis: 'QII-only private placement (FIEA Art. 2(3)(ii)(a))', lawRequires: 'JP_QII',
    lawText: 'Private placement in Japan limited to qualified institutional investors, with transfers restricted to other QIIs. A foreign investment trust is notified to the FSA before units are offered.',
    lawRef: 'FIEA Art. 2(3)(ii)(a); Investment Trust Act Art. 58', lawSource: 'jp-fiea',
  },
  'AE-ADGM': {
    accepts: ['ADGM_PRO'], basis: 'Foreign fund offered to Professional Clients in ADGM', lawRequires: 'ADGM_PRO',
    lawText: 'A foreign fund that cannot be sold to retail investors at home may be offered in ADGM to Professional Clients only. The offering firm notifies the FSRA within 30 days of starting.',
    lawRef: 'FSRA FUNDS 10.1; COBS 2.4', lawSource: 'adgm-funds',
  },
  LU: {
    accepts: ['EU_PRO'], basis: 'Non-EU AIF under national private placement (Law of 12 July 2013, Art. 45)', lawRequires: 'EU_PRO',
    lawText: 'Non-EU AIFM marketing an AIF in Luxembourg without a passport: professional investors only, after filing the CSSF information form. Retail marketing needs separate CSSF authorisation.',
    lawRef: 'Law of 12 July 2013 Art. 45; AIFMD Art. 42', lawSource: 'lu-aifm',
  },
  IE: {
    accepts: ['EU_PRO'], basis: 'Non-EU AIF under national private placement (S.I. No. 257 of 2013, Reg. 43)', lawRequires: 'EU_PRO',
    lawText: 'Non-EU AIFM marketing an AIF in Ireland without a passport: professional investors only, after notifying the Central Bank of Ireland.',
    lawRef: 'S.I. 257/2013 Reg. 43; AIFMD Art. 42', lawSource: 'ie-aifmr',
  },
};

// ---------- Booking centers ----------
export const NEW_BOOKING_CENTERS: BookingCenter[] = [
  { id: 'LDN', name: 'London', jur: 'GB', licence: 'FCA-authorised investment firm (fictional licensee)', requires: 'GB_PRO',
    ruleText: 'Promoting an unregulated collective investment scheme from the UK: professional clients only.', ruleRef: 'FSMA s238; COBS 4.12B', source: 'fca-cobs412b' },
  { id: 'TYO', name: 'Tokyo', jur: 'JP', licence: 'Type II financial instruments business operator (fictional licensee)', requires: 'JP_QII',
    ruleText: 'Handling a QII-only private placement from Japan: qualified institutional investors only.', ruleRef: 'FIEA Art. 2(3)(ii)(a)', source: 'jp-fiea' },
  { id: 'ADGM', name: 'Abu Dhabi (ADGM)', jur: 'AE-ADGM', licence: 'FSRA financial services permission, Professional Clients only (fictional licensee)', requires: 'ADGM_PRO',
    ruleText: 'Firm permitted to deal with Professional Clients only.', ruleRef: 'FSRA COBS 2.4', source: 'adgm-cobs' },
];

// ---------- Pack versions ----------
export type RulePack = {
  id: string; version: string; jurisdiction: string; status: 'active' | 'draft' | 'retired';
  summary: string; effective_from: string | null; effective_to: string | null;
};
/** Every pack version. effective_to is exclusive: a version is in force on dates d with from <= d < to. */
export const RULE_PACKS: RulePack[] = [
  { id: 'SG/eligibility', version: '2026.03.0', jurisdiction: 'SG', status: 'retired', effective_from: '2026-03-01', effective_to: '2026-09-01',
    summary: 'Earlier Singapore pack: accredited investor (SFA s4A) with opt-in; restricted scheme offers (SFA s305). Kept so decisions made before Sep 1, 2026 replay against the pack then in force.' },
  { id: 'SG/eligibility', version: '2026.09.0', jurisdiction: 'SG', status: 'active', effective_from: '2026-09-01', effective_to: null,
    summary: 'Accredited investor (SFA s4A) with opt-in; restricted scheme offers (SFA s305).' },
  { id: 'HK/eligibility', version: '2026.04.2', jurisdiction: 'HK', status: 'active', effective_from: '2026-04-20', effective_to: null,
    summary: 'Professional investor thresholds (Cap. 571D); funds not authorized by the SFC.' },
  { id: 'CH/eligibility', version: '2026.07.0', jurisdiction: 'CH', status: 'active', effective_from: '2026-07-01', effective_to: null,
    summary: 'Per-se professional clients (FinSA Art. 4); foreign funds not approved for retail.' },
  { id: 'DE/eligibility', version: '2026.07.0', jurisdiction: 'DE', status: 'active', effective_from: '2026-07-01', effective_to: null,
    summary: 'MiFID II professional clients; UCITS retail passport; AIFMD Art. 42 private placement.' },
  { id: 'AE-DIFC/eligibility', version: '2026.07.0', jurisdiction: 'AE-DIFC', status: 'active', effective_from: '2026-07-01', effective_to: null,
    summary: 'DFSA professional clients (COB 2.3).' },
  { id: 'US/eligibility', version: '2026.07.0', jurisdiction: 'US', status: 'active', effective_from: '2026-07-01', effective_to: null,
    summary: 'Accredited investors (Reg D 501(a)); Regulation S offshore restrictions; Section 3(c)(1) holder limit.' },
  { id: 'GB/eligibility', version: 'draft-cp2536', jurisdiction: 'GB', status: 'draft', effective_from: null, effective_to: null,
    summary: 'Drafted against FCA CP25/36: proposed GBP 10M investable-assets route. Inactive until final rules.' },
  { id: 'GB/eligibility', version: '2026.10.0', jurisdiction: 'GB', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'Per se professional clients (COBS 3.5.2R); UK national private placement after FCA notification (AIFM Regulations 2013 regs 57 to 59). Elective professionals (COBS 3.5.3R) are recorded but not yet accepted.' },
  { id: 'JP/eligibility', version: '2026.10.0', jurisdiction: 'JP', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'Qualified institutional investors (Definitions Ordinance Art. 10): JPY 1 billion securities test with FSA notification; QII-only private placement (FIEA Art. 2(3)(ii)(a)).' },
  { id: 'AE-ADGM/eligibility', version: '2026.10.0', jurisdiction: 'AE-ADGM', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'FSRA Professional Clients (COBS 2.4); foreign funds offered to Professional Clients with FSRA notification within 30 days (FUNDS 10.1).' },
  { id: 'LU/eligibility', version: '2026.10.0', jurisdiction: 'LU', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'MiFID II per se professional clients; non-EU AIF marketing under Art. 45 of the Law of 12 July 2013 after the CSSF information form.' },
  { id: 'IE/eligibility', version: '2026.10.0', jurisdiction: 'IE', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'MiFID II per se professional clients; non-EU AIF marketing under Reg. 43 of S.I. No. 257 of 2013 after Central Bank notification.' },
  { id: 'global/sanctions', version: '2026-10-01', jurisdiction: 'GLOBAL', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, occupied regions of Ukraine. Syria removed Aug 25, 2025.' },
  { id: 'global/travel-rule', version: '2026.07', jurisdiction: 'GLOBAL', status: 'active', effective_from: '2026-07-16', effective_to: null,
    summary: 'FATF Recommendation 16: originator and beneficiary data for transfers of USD/EUR 1,000 or more.' },
];
export const RULE_PACK_APPROVAL = 'pending counsel review';

/** Pack versions in force on a date, keyed by pack id. Same rule as packsAsOf in api/src/ctx.ts. */
export function packsAsOf(packs: RulePack[], date: string): Record<string, string> {
  const out: Record<string, string> = {};
  const best: Record<string, string> = {};
  for (const p of packs) {
    if (p.status === 'draft') continue;
    if (p.effective_from && p.effective_from > date) continue;
    if (p.effective_to && p.effective_to <= date) continue;
    if (!(p.id in best) || (p.effective_from ?? '') > best[p.id]) { best[p.id] = p.effective_from ?? ''; out[p.id] = p.version; }
  }
  return out;
}

/** A context with the new jurisdictions, classes and booking centers added. Does not touch optional fields. */
export function extendCtx<T extends Ctx>(base: T): T {
  const classInfo: Record<string, ClassMeta> = { ...base.classInfo };
  for (const c of NEW_CLASSES) classInfo[c.code] = { label: c.label, stamp: c.stamp, jur: c.jurisdiction, rule: c.rule_ref, source: c.source_id, threshold: c.threshold };
  const bookingCenters: Record<string, BookingCenter> = { ...base.bookingCenters };
  for (const b of NEW_BOOKING_CENTERS) bookingCenters[b.id] = b;
  const jurName: Record<string, string> = { ...base.jurName };
  for (const j of NEW_JURISDICTIONS) jurName[j.code] = j.name;
  return { ...base, classInfo, bookingCenters, jurName };
}

// ---------- Golden regression cases ----------
export type CaseParty = {
  id: string; name: string; kind: 'Individual' | 'Corporate'; residence: string; booking: string; usPerson?: boolean;
  /** Evidence per class code. Each runs through its threshold test; the class is issued only if the test passes. */
  evidence?: Record<string, Evidence>;
  /** Classifications recorded directly, for engine edge cases such as lapsed status or a legacy record without opt-in. */
  classifications?: Classification[];
  holdings?: Record<string, { units: number; since: string }>;
};
export type RegressionCase = {
  id: string; pack: string; name: string;
  investor: CaseParty;
  counterparty?: CaseParty;
  fund: 'TWLF' | 'NMEL' | 'AGPC';
  /** Distribution entries added to the base fund (from data.ts), keyed by jurisdiction. */
  distribution?: Record<string, LawRule>;
  order: Pick<Order, 'action' | 'amount' | 'asset'>;
  whatIfs?: WhatIf[];
  /** Simulated watchlist hit on the investor's or the counterparty's name. */
  screenHit?: 'investor' | 'counterparty';
  expect: Outcome;
  /** Ids of checks that must fail, in any order. Every other check must not fail. */
  failing: string[];
  /** Class codes the evidence must produce. */
  issued?: string[];
  /** Ids of checks that must be marked binding. */
  binding?: string[];
  present?: string[];
  absent?: string[];
};

const sub = (amount: number, asset = 'USDC') => ({ action: 'subscribe' as const, amount, asset });
const corp = (id: string, residence: string, booking: string, evidence: Record<string, Evidence> = {}, extra: Partial<CaseParty> = {}): CaseParty =>
  ({ id, name: `Test Entity ${id}`, kind: 'Corporate', residence, booking, evidence, ...extra });
const person = (id: string, residence: string, booking: string, evidence: Record<string, Evidence> = {}, extra: Partial<CaseParty> = {}): CaseParty =>
  ({ id, name: `Test Person ${id}`, kind: 'Individual', residence, booking, evidence, ...extra });
const raw = (code: string, expires: string, optIn?: string): Classification => ({ code, basis: 'Recorded directly for a regression case', verified: '2026-03-14', expires, ...(optIn ? { optIn } : {}) });

const SG_OK = { SG_AI: { net_assets: 25_000_000, opt_in: true } };
const EU_BIG = { balance_sheet: 410_000_000, net_turnover: 880_000_000, own_funds: 120_000_000 };
const CH_BIG = { balance_sheet: 410_000_000, turnover: 880_000_000, equity: 120_000_000 };
const GB_BIG = { balance_sheet: 25_000_000, net_turnover: 50_000_000, own_funds: 1_000_000 };
const DENY_CLASS = ['fundClass', 'law', 'booking'];
const HOLDS_TWLF = { TWLF: { units: 1_000_000, since: '2025-01-15' } };
const NEW_DIST = { GB: NEW_LAW.GB, JP: NEW_LAW.JP, 'AE-ADGM': NEW_LAW['AE-ADGM'], LU: NEW_LAW.LU, IE: NEW_LAW.IE };

export const REGRESSION_CASES: RegressionCase[] = [
  // ---------- SG/eligibility ----------
  { id: 'SG-01', pack: 'SG/eligibility', name: 'Accredited corporation with opt-in, booked in Singapore', fund: 'TWLF', order: sub(250_000),
    investor: corp('SG-01', 'SG', 'SG', SG_OK), expect: 'ALLOW', failing: [], issued: ['SG_AI'], binding: ['law'] },
  { id: 'SG-02', pack: 'SG/eligibility', name: 'Net assets of exactly S$10M do not exceed the threshold', fund: 'TWLF', order: sub(250_000),
    investor: corp('SG-02', 'SG', 'SG', { SG_AI: { net_assets: 10_000_000, opt_in: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'SG-03', pack: 'SG/eligibility', name: 'Legacy accredited record without opt-in fails law and booking', fund: 'TWLF', order: sub(250_000),
    investor: corp('SG-03', 'SG', 'SG', {}, { classifications: [raw('SG_AI', '2027-03-14')] }), expect: 'DENY', failing: ['law', 'booking'] },
  { id: 'SG-04', pack: 'SG/eligibility', name: 'Accredited individual on income, booked in Hong Kong without professional investor status', fund: 'TWLF', order: sub(250_000),
    investor: person('SG-04', 'SG', 'HK', { SG_AI: { income: 350_000, opt_in: true } }), expect: 'DENY', failing: ['booking'], issued: ['SG_AI'] },
  { id: 'SG-05', pack: 'SG/eligibility', name: 'Accredited individual on income, booked in Singapore', fund: 'TWLF', order: sub(250_000),
    investor: person('SG-05', 'SG', 'SG', { SG_AI: { income: 350_000, opt_in: true } }), expect: 'ALLOW', failing: [], issued: ['SG_AI'] },

  // ---------- HK/eligibility ----------
  { id: 'HK-01', pack: 'HK/eligibility', name: 'Individual with a HK$8M portfolio meets the test', fund: 'TWLF', order: sub(250_000),
    investor: person('HK-01', 'HK', 'HK', { HK_PI: { portfolio: 8_000_000 } }), expect: 'ALLOW', failing: [], issued: ['HK_PI'] },
  { id: 'HK-02', pack: 'HK/eligibility', name: 'Individual one dollar under HK$8M', fund: 'TWLF', order: sub(250_000),
    investor: person('HK-02', 'HK', 'HK', { HK_PI: { portfolio: 7_999_999 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'HK-03', pack: 'HK/eligibility', name: 'Corporation qualifying on HK$40M total assets', fund: 'TWLF', order: sub(250_000),
    investor: corp('HK-03', 'HK', 'HK', { HK_PI: { portfolio: 2_000_000, total_assets: 40_000_000 } }), expect: 'ALLOW', failing: [], issued: ['HK_PI'] },
  { id: 'HK-04', pack: 'HK/eligibility', name: 'Professional investor booked in Singapore without accredited status', fund: 'TWLF', order: sub(250_000),
    investor: corp('HK-04', 'HK', 'SG', { HK_PI: { portfolio: 50_000_000 } }), expect: 'DENY', failing: ['booking'], issued: ['HK_PI'] },
  { id: 'HK-05', pack: 'HK/eligibility', name: 'Professional investor status lapsed the day before', fund: 'TWLF', order: sub(250_000),
    investor: corp('HK-05', 'HK', 'HK', {}, { classifications: [raw('HK_PI', '2026-09-30')] }), expect: 'DENY', failing: DENY_CLASS },

  // ---------- CH/eligibility ----------
  { id: 'CH-01', pack: 'CH/eligibility', name: 'Pension scheme with professional treasury, booked in Zurich', fund: 'TWLF', order: sub(250_000),
    investor: corp('CH-01', 'CH', 'ZRH', { CH_PRO: { pension_professional_treasury: true } }), expect: 'ALLOW', failing: [], issued: ['CH_PRO'] },
  { id: 'CH-02', pack: 'CH/eligibility', name: 'Company meeting 1 of 3 size tests', fund: 'TWLF', order: sub(250_000),
    investor: corp('CH-02', 'CH', 'ZRH', { CH_PRO: { balance_sheet: 25_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'CH-03', pack: 'CH/eligibility', name: 'Company exactly at CHF 20M balance sheet and CHF 2M equity', fund: 'TWLF', order: sub(250_000),
    investor: corp('CH-03', 'CH', 'ZRH', { CH_PRO: { balance_sheet: 20_000_000, equity: 2_000_000 } }), expect: 'ALLOW', failing: [], issued: ['CH_PRO'] },
  { id: 'CH-04', pack: 'CH/eligibility', name: 'Swiss professional client booked in Hong Kong', fund: 'TWLF', order: sub(250_000),
    investor: corp('CH-04', 'CH', 'HK', { CH_PRO: { pension_professional_treasury: true } }), expect: 'DENY', failing: ['booking'], issued: ['CH_PRO'] },

  // ---------- DE/eligibility ----------
  { id: 'DE-01', pack: 'DE/eligibility', name: 'Large undertaking booked in Zurich: German law and Swiss licence both bind', fund: 'TWLF', order: sub(250_000),
    investor: corp('DE-01', 'DE', 'ZRH', { EU_PRO: EU_BIG, CH_PRO: CH_BIG }), expect: 'ALLOW', failing: [], issued: ['EU_PRO', 'CH_PRO'], binding: ['law', 'booking'] },
  { id: 'DE-02', pack: 'DE/eligibility', name: 'Undertaking meeting only the own funds test', fund: 'TWLF', order: sub(250_000),
    investor: corp('DE-02', 'DE', 'ZRH', { EU_PRO: { own_funds: 3_000_000 }, CH_PRO: { equity: 3_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'DE-03', pack: 'DE/eligibility', name: 'UCITS retail client allowed by German law but refused by the Zurich licence', fund: 'NMEL', order: sub(50_000, 'EURC'),
    investor: person('DE-03', 'DE', 'ZRH'), expect: 'DENY', failing: ['booking'] },
  { id: 'DE-04', pack: 'DE/eligibility', name: 'Retail client in a non-EU AIF', fund: 'TWLF', order: sub(250_000),
    investor: person('DE-04', 'DE', 'ZRH'), expect: 'DENY', failing: DENY_CLASS },
  { id: 'DE-05', pack: 'DE/eligibility', name: 'Professional client in a UCITS booked in Zurich', fund: 'NMEL', order: sub(1_000_000, 'EURC'),
    investor: corp('DE-05', 'DE', 'ZRH', { EU_PRO: EU_BIG, CH_PRO: CH_BIG }), expect: 'ALLOW', failing: [], issued: ['EU_PRO', 'CH_PRO'] },

  // ---------- AE-DIFC/eligibility ----------
  { id: 'DIFC-01', pack: 'AE-DIFC/eligibility', name: 'Assessed undertaking with US$6.2M own funds', fund: 'TWLF', order: sub(250_000),
    investor: corp('DIFC-01', 'AE-DIFC', 'DIFC', { DIFC_PRO: { own_funds: 6_200_000 } }), expect: 'ALLOW', failing: [], issued: ['DIFC_PRO'] },
  { id: 'DIFC-02', pack: 'AE-DIFC/eligibility', name: 'Individual one dollar under US$1M net assets', fund: 'TWLF', order: sub(250_000),
    investor: person('DIFC-02', 'AE-DIFC', 'DIFC', { DIFC_PRO: { net_assets: 999_999, experience: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'DIFC-03', pack: 'AE-DIFC/eligibility', name: 'Individual with US$1.5M but no experience finding', fund: 'TWLF', order: sub(250_000),
    investor: person('DIFC-03', 'AE-DIFC', 'DIFC', { DIFC_PRO: { net_assets: 1_500_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'DIFC-04', pack: 'AE-DIFC/eligibility', name: 'Fund not offered in the UAE', fund: 'NMEL', order: sub(1_000_000, 'EURC'),
    investor: corp('DIFC-04', 'AE-DIFC', 'DIFC', { DIFC_PRO: { own_funds: 6_200_000 } }), expect: 'DENY', failing: ['dist'] },
  { id: 'DIFC-05', pack: 'AE-DIFC/eligibility', name: 'Issuer removes the UAE from the distribution list', fund: 'TWLF', order: sub(250_000), whatIfs: ['dropUAE'],
    investor: corp('DIFC-05', 'AE-DIFC', 'DIFC', { DIFC_PRO: { own_funds: 6_200_000 } }), expect: 'DENY', failing: ['dist'] },

  // ---------- US/eligibility ----------
  { id: 'US-01', pack: 'US/eligibility', name: 'Accredited individual on net worth, under the 3(c)(1) cap', fund: 'AGPC', order: sub(300_000),
    investor: person('US-01', 'US', 'NY', { US_AI: { net_worth: 1_200_000 } }, { usPerson: true }), expect: 'ALLOW', failing: [], issued: ['US_AI'] },
  { id: 'US-02', pack: 'US/eligibility', name: 'Joint income of $250K is under the $300K joint test', fund: 'AGPC', order: sub(300_000),
    investor: person('US-02', 'US', 'NY', { US_AI: { income: 250_000, joint: true } }, { usPerson: true }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'US-03', pack: 'US/eligibility', name: 'New holder when the fund is at 100 beneficial owners', fund: 'AGPC', order: sub(300_000), whatIfs: ['capFull'],
    investor: corp('US-03', 'US', 'NY', { US_AI: { assets: 6_000_000 } }, { usPerson: true }), expect: 'DENY', failing: ['cap'], issued: ['US_AI'] },
  { id: 'US-04', pack: 'US/eligibility', name: 'U.S. person refused by a Regulation S fund', fund: 'TWLF', order: sub(300_000),
    investor: corp('US-04', 'US', 'NY', { US_AI: { assets: 6_000_000 } }, { usPerson: true }), expect: 'DENY', failing: ['regS'] },
  { id: 'US-05', pack: 'US/eligibility', name: 'Existing holder adds when the fund is at its cap', fund: 'AGPC', order: sub(300_000), whatIfs: ['capFull'],
    investor: corp('US-05', 'US', 'NY', { US_AI: { assets: 6_000_000 } }, { usPerson: true, holdings: { AGPC: { units: 500_000, since: '2025-01-15' } } }), expect: 'ALLOW', failing: [] },

  // ---------- GB/eligibility ----------
  { id: 'GB-01', pack: 'GB/eligibility', name: 'Large undertaking on balance sheet and turnover, booked in London', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-01', 'GB', 'LDN', { GB_PRO: GB_BIG }), expect: 'ALLOW', failing: [], issued: ['GB_PRO'], binding: ['law'] },
  { id: 'GB-02', pack: 'GB/eligibility', name: 'Undertaking meeting only the own funds test', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-02', 'GB', 'LDN', { GB_PRO: { own_funds: 3_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'GB-03', pack: 'GB/eligibility', name: 'FCA-regulated firm is per se professional', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-03', 'GB', 'LDN', { GB_PRO: { regulated_entity: true } }), expect: 'ALLOW', failing: [], issued: ['GB_PRO'] },
  { id: 'GB-04', pack: 'GB/eligibility', name: 'Elective professional with written opt-up is recorded, but the pack binds on per se status', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('GB-04', 'GB', 'LDN', { GB_EPRO: { qualitative: true, portfolio: 750_000, finance_role: true, opt_in: true } }), expect: 'DENY', failing: DENY_CLASS, issued: ['GB_EPRO'] },
  { id: 'GB-05', pack: 'GB/eligibility', name: 'Elective professional tests met but no written opt-up', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('GB-05', 'GB', 'LDN', { GB_EPRO: { qualitative: true, portfolio: 750_000, finance_role: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'GB-06', pack: 'GB/eligibility', name: 'UK professional client booked in Hong Kong', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-06', 'GB', 'HK', { GB_PRO: { regulated_entity: true } }), expect: 'DENY', failing: ['booking'], issued: ['GB_PRO'] },

  // ---------- JP/eligibility ----------
  { id: 'JP-01', pack: 'JP/eligibility', name: 'Individual with exactly JPY 1 billion, notified to the FSA', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('JP-01', 'JP', 'TYO', { JP_QII: { securities_balance: 1_000_000_000, account_one_year: true, fsa_notification: true } }), expect: 'ALLOW', failing: [], issued: ['JP_QII'] },
  { id: 'JP-02', pack: 'JP/eligibility', name: 'Individual one yen under JPY 1 billion', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('JP-02', 'JP', 'TYO', { JP_QII: { securities_balance: 999_999_999, account_one_year: true, fsa_notification: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'JP-03', pack: 'JP/eligibility', name: 'Individual over JPY 1 billion who has not notified the FSA', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('JP-03', 'JP', 'TYO', { JP_QII: { securities_balance: 1_200_000_000, account_one_year: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'JP-04', pack: 'JP/eligibility', name: 'Individual over JPY 1 billion with an account under a year old', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('JP-04', 'JP', 'TYO', { JP_QII: { securities_balance: 1_500_000_000, fsa_notification: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'JP-05', pack: 'JP/eligibility', name: 'Bank listed as a QII, booked in Tokyo', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('JP-05', 'JP', 'TYO', { JP_QII: { listed_institution: true } }), expect: 'ALLOW', failing: [], issued: ['JP_QII'] },
  { id: 'JP-06', pack: 'JP/eligibility', name: 'QII booked in Singapore without accredited status', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('JP-06', 'JP', 'SG', { JP_QII: { listed_institution: true } }), expect: 'DENY', failing: ['booking'], issued: ['JP_QII'] },

  // ---------- AE-ADGM/eligibility ----------
  { id: 'ADGM-01', pack: 'AE-ADGM/eligibility', name: 'Individual with exactly US$1M net assets and experience', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('ADGM-01', 'AE-ADGM', 'ADGM', { ADGM_PRO: { net_assets: 1_000_000, experience: true } }), expect: 'ALLOW', failing: [], issued: ['ADGM_PRO'] },
  { id: 'ADGM-02', pack: 'AE-ADGM/eligibility', name: 'Individual one dollar under US$1M', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('ADGM-02', 'AE-ADGM', 'ADGM', { ADGM_PRO: { net_assets: 999_999, experience: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'ADGM-03', pack: 'AE-ADGM/eligibility', name: 'Large undertaking is a deemed professional client', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('ADGM-03', 'AE-ADGM', 'ADGM', { ADGM_PRO: { balance_sheet: 20_000_000, net_turnover: 40_000_000 } }), expect: 'ALLOW', failing: [], issued: ['ADGM_PRO'] },
  { id: 'ADGM-04', pack: 'AE-ADGM/eligibility', name: 'Undertaking with US$1.5M own funds but no experience finding', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('ADGM-04', 'AE-ADGM', 'ADGM', { ADGM_PRO: { own_funds: 1_500_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'ADGM-05', pack: 'AE-ADGM/eligibility', name: 'ADGM professional client booked in the DIFC, a separate regime', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('ADGM-05', 'AE-ADGM', 'DIFC', { ADGM_PRO: { own_funds: 1_500_000, experience: true } }), expect: 'DENY', failing: ['booking'], issued: ['ADGM_PRO'] },

  // ---------- LU/eligibility ----------
  { id: 'LU-01', pack: 'LU/eligibility', name: 'Large undertaking booked in Zurich', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('LU-01', 'LU', 'ZRH', { EU_PRO: EU_BIG, CH_PRO: CH_BIG }), expect: 'ALLOW', failing: [], issued: ['EU_PRO', 'CH_PRO'], binding: ['law', 'booking'] },
  { id: 'LU-02', pack: 'LU/eligibility', name: 'Undertaking meeting only the own funds test', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('LU-02', 'LU', 'ZRH', { EU_PRO: { own_funds: 3_000_000 }, CH_PRO: { equity: 3_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'LU-03', pack: 'LU/eligibility', name: 'Fund not offered in Luxembourg', fund: 'NMEL', order: sub(1_000_000, 'EURC'),
    investor: corp('LU-03', 'LU', 'ZRH', { EU_PRO: EU_BIG, CH_PRO: CH_BIG }), expect: 'DENY', failing: ['dist'] },
  { id: 'LU-04', pack: 'LU/eligibility', name: 'EU professional client booked in London without UK status', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('LU-04', 'LU', 'LDN', { EU_PRO: EU_BIG }), expect: 'DENY', failing: ['booking'], issued: ['EU_PRO'] },

  // ---------- IE/eligibility ----------
  { id: 'IE-01', pack: 'IE/eligibility', name: 'Large undertaking booked in London: Irish law and UK licence both bind', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('IE-01', 'IE', 'LDN', { EU_PRO: EU_BIG, GB_PRO: GB_BIG }), expect: 'ALLOW', failing: [], issued: ['EU_PRO', 'GB_PRO'], binding: ['law', 'booking'] },
  { id: 'IE-02', pack: 'IE/eligibility', name: 'Retail individual', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('IE-02', 'IE', 'LDN'), expect: 'DENY', failing: DENY_CLASS },
  { id: 'IE-03', pack: 'IE/eligibility', name: 'EU professional status lapsed; UK status still valid', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('IE-03', 'IE', 'LDN', { GB_PRO: GB_BIG }, { classifications: [raw('EU_PRO', '2026-09-30')] }), expect: 'DENY', failing: ['fundClass', 'law'], issued: ['GB_PRO'] },
  { id: 'IE-04', pack: 'IE/eligibility', name: 'Eligible investor paying in an unaccepted asset', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000), whatIfs: ['badAsset'],
    investor: corp('IE-04', 'IE', 'LDN', { EU_PRO: EU_BIG, GB_PRO: GB_BIG }), expect: 'DENY', failing: ['asset'] },

  // ---------- global/sanctions ----------
  { id: 'GS-01', pack: 'global/sanctions', name: 'Resident of a comprehensively sanctioned country', fund: 'TWLF', order: sub(250_000),
    investor: corp('GS-01', 'IR', 'SG', SG_OK), expect: 'FREEZE', failing: ['sanc'] },
  { id: 'GS-02', pack: 'global/sanctions', name: 'Holder moves to a sanctioned country: even redemption freezes', fund: 'TWLF', distribution: NEW_DIST, order: { action: 'redeem', amount: 100_000, asset: 'USDC' }, whatIfs: ['sanctioned'],
    investor: corp('GS-02', 'GB', 'LDN', { GB_PRO: GB_BIG }, { holdings: HOLDS_TWLF }), expect: 'FREEZE', failing: ['sanc'] },
  { id: 'GS-03', pack: 'global/sanctions', name: 'Name screening match on the investor', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000), screenHit: 'investor',
    investor: corp('GS-03', 'GB', 'LDN', { GB_PRO: GB_BIG }), expect: 'FREEZE', failing: ['screen'] },
  { id: 'GS-04', pack: 'global/sanctions', name: 'Name screening match on the receiving counterparty', fund: 'TWLF', distribution: NEW_DIST, order: { action: 'transfer', amount: 100_000, asset: 'USDC' }, screenHit: 'counterparty',
    investor: corp('GS-04', 'SG', 'SG', SG_OK, { holdings: HOLDS_TWLF }), counterparty: corp('GS-04-cp', 'GB', 'LDN', { GB_PRO: GB_BIG }), expect: 'FREEZE', failing: ['cpScreen'] },

  // ---------- global/travel-rule ----------
  { id: 'TR-01', pack: 'global/travel-rule', name: 'Transfer of 500,000 to a UK professional client carries Travel Rule data', fund: 'TWLF', distribution: NEW_DIST, order: { action: 'transfer', amount: 500_000, asset: 'USDC' },
    investor: corp('TR-01', 'SG', 'SG', SG_OK, { holdings: HOLDS_TWLF }), counterparty: corp('TR-01-cp', 'GB', 'LDN', { GB_PRO: GB_BIG }), expect: 'ALLOW', failing: [], present: ['travel'] },
  { id: 'TR-02', pack: 'global/travel-rule', name: 'Transfer of 999 is under the 1,000 threshold', fund: 'TWLF', distribution: NEW_DIST, order: { action: 'transfer', amount: 999, asset: 'USDC' },
    investor: corp('TR-02', 'SG', 'SG', SG_OK, { holdings: HOLDS_TWLF }), counterparty: corp('TR-02-cp', 'GB', 'LDN', { GB_PRO: GB_BIG }), expect: 'ALLOW', failing: [], absent: ['travel'] },
  { id: 'TR-03', pack: 'global/travel-rule', name: 'Transfer to a Japanese individual who is not a QII', fund: 'TWLF', distribution: NEW_DIST, order: { action: 'transfer', amount: 500_000, asset: 'USDC' },
    investor: corp('TR-03', 'SG', 'SG', SG_OK, { holdings: HOLDS_TWLF }), counterparty: person('TR-03-cp', 'JP', 'TYO', { JP_QII: { securities_balance: 400_000_000, account_one_year: true, fsa_notification: true } }), expect: 'DENY', failing: DENY_CLASS, present: ['travel'] },
];
