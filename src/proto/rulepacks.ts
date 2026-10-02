// Rule packs added after launch: jurisdictions, investor classes, booking centers and the law
// rules an issuer gets when it adds a jurisdiction to a fund. Also the version history of every
// pack and the golden regression cases that scripts/test-rulepacks.ts runs through the engine.
// Every threshold and citation is listed on /sources (src/data/sources.ts). Research as of Oct 2026 (AU, CA, BR, KR added Oct 3, 2026).
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
  { code: 'IN', name: 'India', iso3: 'IND', iso_numeric: '356' },
  // Added Oct 3, 2026 with the AU, CA, BR and KR packs.
  { code: 'AU', name: 'Australia', iso3: 'AUS', iso_numeric: '036' },
  { code: 'CA', name: 'Canada', iso3: 'CAN', iso_numeric: '124' },
  { code: 'BR', name: 'Brazil', iso3: 'BRA', iso_numeric: '076' },
  { code: 'KR', name: 'South Korea', iso3: 'KOR', iso_numeric: '410' },
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
  /** What the investor's consent is called when requires_opt_in is true, or when a notification is part of the status. */
  opt_in_label?: string;
};
/** Consent labels for the launch classes (migration 007 writes them to investor_classes.opt_in_label). */
export const LAUNCH_OPT_IN_LABELS: Record<string, string> = { SG_AI: 'opt-in' };
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
    requires_opt_in: true, opt_in_label: 'written opt-up',
  },
  {
    code: 'JP_QII', jurisdiction: 'JP', label: 'Qualified institutional investor', stamp: 'QII', rule_ref: 'Definitions Ordinance Art. 10(1)', source_id: 'jp-qii',
    threshold: 'Listed financial institutions, or a corporation or individual with securities of JPY 1 billion or more that has notified the FSA. Individuals also need a securities account open for a year. Notified status lasts two years.',
    requires_opt_in: false, opt_in_label: 'FSA notification',
  },
  {
    code: 'ADGM_PRO', jurisdiction: 'AE-ADGM', label: 'Professional client', stamp: 'Professional client', rule_ref: 'FSRA COBS 2.4', source_id: 'adgm-cobs',
    threshold: 'Individual: net assets of at least US$1M excluding primary residence, plus experience. Undertaking: own funds of at least US$1M plus experience, or 2 of 3: US$20M balance sheet, US$40M turnover, US$2M own funds.',
    requires_opt_in: false,
  },
  // ---------- United States (added Oct 2026 alongside US_AI) ----------
  {
    code: 'US_QP', jurisdiction: 'US', label: 'Qualified purchaser', stamp: 'Qualified purchaser', rule_ref: 'ICA §2(a)(51)', source_id: 'ica-2a51',
    threshold: 'Natural persons and family companies with at least $5M in investments; other entities that own and invest on a discretionary basis at least $25M; entities owned entirely by qualified purchasers.',
    requires_opt_in: false,
  },
  {
    code: 'US_QIB', jurisdiction: 'US', label: 'Qualified institutional buyer', stamp: 'QIB', rule_ref: 'Rule 144A(a)(1)', source_id: 'us-144a',
    threshold: 'Institutions owning and investing on a discretionary basis at least $100M in securities of unaffiliated issuers; registered dealers at $10M; banks also need $25M audited net worth.',
    requires_opt_in: false,
  },
  {
    code: 'US_IAI', jurisdiction: 'US', label: 'Institutional accredited investor', stamp: 'Institutional AI', rule_ref: 'Reg D Rule 501(a)(1), (2), (3), (7)', source_id: 'reg-d-501',
    threshold: 'Banks, broker-dealers, insurers, registered investment companies and other 501(a)(1) institutions; private BDCs; organizations and trusts not formed for the investment with total assets over $5M.',
    requires_opt_in: false,
  },
  // ---------- India ----------
  {
    code: 'IN_AI', jurisdiction: 'IN', label: 'Accredited investor (SEBI)', stamp: 'Accredited investor', rule_ref: 'SEBI AIF Master Circular Ch. 12 (circular of Aug 26, 2021)', source_id: 'sebi-ai',
    threshold: 'Individual: annual income of at least INR 2 crore; or net worth of at least INR 7.5 crore with INR 3.75 crore in financial assets; or income of at least INR 1 crore plus net worth of at least INR 5 crore with half financial. Body corporate or trust: net worth of at least INR 50 crore.',
    requires_opt_in: false,
  },
  {
    code: 'IN_LRS', jurisdiction: 'IN', label: 'Resident individual within the LRS', stamp: 'LRS remitter', rule_ref: 'RBI Master Direction No. 7/2015-16', source_id: 'rbi-lrs',
    threshold: 'Resident individual with a PAN remitting under the Liberalised Remittance Scheme: USD 250,000 per financial year (April to March) across all purposes. Not available to companies, firms, HUFs or trusts.',
    requires_opt_in: false,
  },
  {
    code: 'IFSCA_PRO', jurisdiction: 'IN', label: 'Accredited investor (IFSCA)', stamp: 'IFSCA accredited', rule_ref: 'IFSCA circular IFSCA-IF-10PR/1/2023-Capital Markets', source_id: 'ifsca-ai',
    threshold: 'Individual: annual gross income of at least US$200,000, or net assets of at least US$1M with US$500,000 in financial assets. Body corporate or trust: net worth of at least US$5M, or every constituent an accredited investor.',
    requires_opt_in: false,
  },
  // ---------- Australia ----------
  {
    code: 'AU_WHOLESALE', jurisdiction: 'AU', label: 'Wholesale client', stamp: 'Wholesale client', rule_ref: 'Corporations Act s761G(7); regs 7.1.18, 7.1.28', source_id: 'au-reg-7128',
    threshold: 'Product value of at least A$500,000; or a qualified accountant\'s certificate given within 2 years showing net assets of at least A$2.5M or gross income of at least A$250,000 in each of the last 2 financial years; or a business that is not a small business; or control by a wholesale client.',
    requires_opt_in: false,
  },
  {
    code: 'AU_PRO', jurisdiction: 'AU', label: 'Professional investor', stamp: 'Professional investor', rule_ref: 'Corporations Act s9; s761G(7)(d)', source_id: 'au-wholesale-guide',
    threshold: 'AFS licensee, APRA-regulated body, large superannuation trustee or listed entity, or a person who has or controls gross assets of at least A$10M.',
    requires_opt_in: false,
  },
  // ---------- Canada ----------
  {
    code: 'CA_AI', jurisdiction: 'CA', label: 'Accredited investor', stamp: 'Accredited investor', rule_ref: 'NI 45-106 s1.1, s2.3', source_id: 'ca-ni45106',
    threshold: 'Individual: net financial assets over C$1M (with Form 45-106F9), or over C$5M; net income over C$200,000 (C$300,000 with a spouse) in each of the last two years; or net assets of at least C$5M. Non-individual: net assets of at least C$5M, listed institutions, or every owner an accredited investor.',
    requires_opt_in: false,
  },
  {
    code: 'CA_PC', jurisdiction: 'CA', label: 'Permitted client', stamp: 'Permitted client', rule_ref: 'NI 31-103 s1.1', source_id: 'ca-ni31103',
    threshold: 'Individual with financial assets over C$5M; a person other than an individual or investment fund with net assets of at least C$25M; listed institutions.',
    requires_opt_in: false,
  },
  {
    code: 'CA_MIN', jurisdiction: 'CA', label: 'Minimum amount purchaser', stamp: 'Minimum amount', rule_ref: 'NI 45-106 s2.10', source_id: 'ca-ni45106',
    threshold: 'Non-individual paying an acquisition cost of at least C$150,000 in cash at the time of the distribution, not created solely to use the exemption. Not available to individuals.',
    requires_opt_in: false,
  },
  // ---------- Brazil ----------
  {
    code: 'BR_QUAL', jurisdiction: 'BR', label: 'Investidor qualificado', stamp: 'Qualified investor', rule_ref: 'Resolução CVM 30 art. 12', source_id: 'br-rcvm30',
    threshold: 'Financial investments over R$1,000,000.00 with a written attestation of qualified investor status; or an individual approved in a CVM-recognised exam or holding a CVM-approved certification; or a professional investor.',
    requires_opt_in: true, opt_in_label: 'written attestation',
  },
  {
    code: 'BR_PRO', jurisdiction: 'BR', label: 'Investidor profissional', stamp: 'Professional investor', rule_ref: 'Resolução CVM 30 art. 11', source_id: 'br-rcvm30',
    threshold: 'Financial investments over R$10,000,000.00 with a written attestation; or a financial institution, insurer, pension entity, investment fund, authorised manager, or non-resident investor.',
    requires_opt_in: false,
  },
  // ---------- South Korea ----------
  {
    code: 'KR_PRO', jurisdiction: 'KR', label: 'Professional investor', stamp: 'Professional investor', rule_ref: 'FSCMA Art. 9(5); Enforcement Decree Art. 10', source_id: 'kr-pro-2019',
    threshold: 'Individual: financial investment products of at least KRW 50 million held for a year, plus annual income of at least KRW 100 million (KRW 150 million with a spouse), net assets of at least KRW 500 million excluding the primary residence, or a financial profession qualification. Corporations: listed, regulated, or (unverified figure) KRW 10 billion in financial investment products.',
    requires_opt_in: false,
  },
  {
    code: 'KR_QPI', jurisdiction: 'KR', label: 'Qualified professional investor', stamp: 'Qualified professional', rule_ref: 'FSCMA Art. 279; Enforcement Decree Art. 301', source_id: 'kr-decree-303',
    threshold: 'Financial institutions, pension funds, public funds and the other institutions named in Enforcement Decree Art. 301, to whom a foreign collective investment scheme may be privately placed under the simplified registration route.',
    requires_opt_in: false,
  },
];

// ---------- Law rules for a fund's distribution list ----------
export type LawRule = {
  accepts: string[]; basis: string; lawRequires: string | null; lawText: string; lawRef: string; lawSource: string;
  /** Classes the law accepts when more than one does. Any one suffices; lawRequires stays as the first for older readers. */
  lawRequiresAny?: string[] | null;
};
/**
 * Registered into EXTRA_LAW by api/src/rulepacks.ts so issuers can add these jurisdictions.
 * A jurisdiction's law may accept more than one class (lawRequiresAny); the engine passes when the
 * investor holds any one of them, honoring each class's consent rule.
 */
export const NEW_LAW: Record<string, LawRule> = {
  GB: {
    accepts: ['GB_PRO', 'GB_EPRO'], basis: 'UK national private placement (AIFM Regulations 2013, regs 57 to 59)', lawRequires: 'GB_PRO', lawRequiresAny: ['GB_PRO', 'GB_EPRO'],
    lawText: 'Non-UK AIF marketed under the UK national private placement regime after notice to the FCA: professional investors only. A professional investor is a per se professional client (COBS 3.5.2R) or an elective professional client who opted up in writing (COBS 3.5.3R).',
    lawRef: 'AIFM Regs 2013 regs 57-59; COBS 3.5.2R, 3.5.3R', lawSource: 'uk-aifmr',
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
  IN: {
    accepts: ['IN_AI', 'IN_LRS', 'IFSCA_PRO'], basis: 'Overseas portfolio investment by Indian residents (FEM (Overseas Investment) Rules 2022)', lawRequires: 'IN_AI', lawRequiresAny: ['IN_AI', 'IN_LRS', 'IFSCA_PRO'],
    lawText: 'A foreign fund is not offered to the Indian public. A resident individual may acquire units of a regulated overseas fund only as overseas portfolio investment within the Liberalised Remittance Scheme (OI Rules 2022 Sch. III; RBI MD 7/2015-16). An Indian entity may hold overseas portfolio investment up to 50% of its net worth per its last audited balance sheet (OI Rules 2022 Sch. II). Any offer to more than 200 persons in a financial year is a public offer (Companies Act 2013 s42).',
    lawRef: 'FEM (OI) Rules 2022 Sch. II, III; RBI MD 7/2015-16; Companies Act s42', lawSource: 'fema-oi-2022',
  },
  AU: {
    accepts: ['AU_PRO', 'AU_WHOLESALE'], basis: 'Foreign scheme offered to wholesale clients (Corporations Act s601ED(2), s761G)', lawRequires: 'AU_WHOLESALE', lawRequiresAny: ['AU_WHOLESALE', 'AU_PRO'],
    lawText: 'A foreign managed investment scheme not registered under Chapter 5C may only be offered in Australia where no Product Disclosure Statement is required, that is to wholesale clients: product value of at least A$500,000, a certified net assets or gross income test, a large business, or a professional investor (s761G(7)). The foreign provider deals with wholesale clients under ASIC relief for foreign financial services providers, extended to 31 March 2027 (ASIC Instrument 2025/798).',
    lawRef: 'Corporations Act s601ED(2), s761G(7), s9; ASIC Instrument 2025/798', lawSource: 'au-s601ed',
  },
  CA: {
    accepts: ['CA_AI', 'CA_PC', 'CA_MIN'], basis: 'Prospectus-exempt distribution (NI 45-106 s2.3 accredited investor, s2.10 minimum amount)', lawRequires: 'CA_AI', lawRequiresAny: ['CA_AI', 'CA_PC', 'CA_MIN'],
    lawText: 'A foreign fund distributed in Canada without a prospectus relies on the accredited investor exemption (NI 45-106 s2.3; individuals under paragraphs (j), (k) and (l) sign Form 45-106F9) or, for non-individuals, the C$150,000 minimum amount exemption (s2.10). A report of exempt distribution follows within 10 days. The seller is a registered dealer or relies on the international dealer exemption, which reaches permitted clients only (NI 31-103 s8.18).',
    lawRef: 'NI 45-106 s1.1, s2.3, s2.10, s6.1; NI 31-103 s1.1, s8.18', lawSource: 'ca-ni45106',
  },
  BR: {
    accepts: ['BR_PRO', 'BR_QUAL'], basis: 'Offshore fund reached through a CVM 175 feeder for qualified or professional investors', lawRequires: 'BR_QUAL', lawRequiresAny: ['BR_QUAL', 'BR_PRO'],
    lawText: 'Units of a foreign fund are not offered to the Brazilian public without CVM registration. Resident investors reach an offshore fund through a Brazilian fund under Resolução CVM 175, whose classes for qualified or professional investors may hold their whole portfolio abroad; the investor is tested as investidor qualificado (financial investments over R$1,000,000.00 with a written attestation) or investidor profissional (over R$10,000,000.00) under Resolução CVM 30. Laissez records the Brazilian investor as the beneficial subscriber behind the feeder.',
    lawRef: 'Resolução CVM 30 arts 11, 12; Resolução CVM 175', lawSource: 'br-rcvm30',
  },
  KR: {
    accepts: ['KR_QPI', 'KR_PRO'], basis: 'Foreign collective investment scheme privately placed with professional investors (FSCMA Art. 279)', lawRequires: 'KR_PRO', lawRequiresAny: ['KR_PRO', 'KR_QPI'],
    lawText: 'A foreign collective investment scheme must be registered with the Financial Services Commission before its securities are sold to residents of Korea (FSCMA Art. 279(1); Enforcement Decree Art. 303). Sale to general investors needs full registration; a private placement to professional investors uses the simplified route and, for qualified professional investors named in Enforcement Decree Art. 301, the lightest one. Sales go through a locally licensed distributor.',
    lawRef: 'FSCMA Art. 9(5), Art. 279; Enforcement Decree Arts 10, 301, 303', lawSource: 'kr-decree-303',
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
  { id: 'GIFT', name: 'GIFT City (IFSC)', jur: 'IN', licence: 'IFSCA-registered fund management entity (fictional licensee)', requires: 'IFSCA_PRO',
    ruleText: 'Foreign fund units distributed from GIFT City: accredited investors only (IFSCA or SEBI accredited).', ruleRef: 'IFSCA (Fund Management) Regulations 2025; IFSCA AI circular', source: 'ifsca-ai',
    requiresAny: ['IFSCA_PRO', 'IN_AI'] } as BookingCenter & { requiresAny: string[] },
  { id: 'SYD', name: 'Sydney', jur: 'AU', licence: 'AFS licensee authorised for wholesale clients only (fictional licensee)', requires: 'AU_WHOLESALE',
    ruleText: 'Dealing from Australia in a scheme with no Product Disclosure Statement: wholesale clients or professional investors only.', ruleRef: 'Corporations Act s761G, s1012; s601ED(2)', source: 'au-s601ed',
    requiresAny: ['AU_WHOLESALE', 'AU_PRO'] } as BookingCenter & { requiresAny: string[] },
  { id: 'TOR', name: 'Toronto', jur: 'CA', licence: 'Exempt market dealer registered in Ontario (fictional licensee)', requires: 'CA_AI',
    ruleText: 'Exempt market dealer distributing a foreign fund in Canada: accredited investors, permitted clients, or non-individuals under the C$150,000 minimum amount exemption.', ruleRef: 'NI 31-103 s7.1(2)(d); NI 45-106 s2.3, s2.10', source: 'ca-ni31103',
    requiresAny: ['CA_AI', 'CA_PC', 'CA_MIN'] } as BookingCenter & { requiresAny: string[] },
  { id: 'SAO', name: 'São Paulo', jur: 'BR', licence: 'Distributor of securities authorised by the Central Bank and CVM (fictional licensee)', requires: 'BR_QUAL',
    ruleText: 'Placing a feeder for an offshore fund from Brazil: investidores qualificados with a written attestation, or investidores profissionais.', ruleRef: 'Resolução CVM 30 arts 11, 12; Resolução CVM 175', source: 'br-rcvm30',
    requiresAny: ['BR_QUAL', 'BR_PRO'] } as BookingCenter & { requiresAny: string[] },
  { id: 'SEL', name: 'Seoul', jur: 'KR', licence: 'Investment broker licensed under the FSCMA (fictional licensee)', requires: 'KR_PRO',
    ruleText: 'Selling a privately placed foreign collective investment scheme from Korea: professional investors or qualified professional investors only.', ruleRef: 'FSCMA Art. 279; Enforcement Decree Arts 301, 303', source: 'kr-offshore-guide',
    requiresAny: ['KR_PRO', 'KR_QPI'] } as BookingCenter & { requiresAny: string[] },
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
  { id: 'US/eligibility', version: '2026.07.0', jurisdiction: 'US', status: 'retired', effective_from: '2026-07-01', effective_to: '2026-10-02',
    summary: 'Accredited investors (Reg D 501(a)); Regulation S offshore restrictions; Section 3(c)(1) holder limit.' },
  { id: 'US/eligibility', version: '2026.10.0', jurisdiction: 'US', status: 'active', effective_from: '2026-10-02', effective_to: null,
    summary: 'Adds qualified purchasers (ICA 2(a)(51)), qualified institutional buyers (Rule 144A) and institutional accredited investors (Rule 501(a)(1), (2), (3), (7)); Section 3(c)(7) funds carry the Exchange Act 12(g) 2,000 holders of record threshold instead of the 100-owner cap; Regulation S Category 3 distribution compliance period on resales to U.S. persons (Rule 903(b)(3)).' },
  { id: 'GB/eligibility', version: 'draft-cp2536', jurisdiction: 'GB', status: 'draft', effective_from: null, effective_to: null,
    summary: 'Drafted against FCA CP25/36: proposed GBP 10M investable-assets route. Inactive until final rules.' },
  { id: 'GB/eligibility', version: '2026.10.0', jurisdiction: 'GB', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'Per se professional clients (COBS 3.5.2R) or elective professional clients with a written opt-up (COBS 3.5.3R); UK national private placement after FCA notification (AIFM Regulations 2013 regs 57 to 59).' },
  { id: 'JP/eligibility', version: '2026.10.0', jurisdiction: 'JP', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'Qualified institutional investors (Definitions Ordinance Art. 10): JPY 1 billion securities test with FSA notification; QII-only private placement (FIEA Art. 2(3)(ii)(a)).' },
  { id: 'AE-ADGM/eligibility', version: '2026.10.0', jurisdiction: 'AE-ADGM', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'FSRA Professional Clients (COBS 2.4); foreign funds offered to Professional Clients with FSRA notification within 30 days (FUNDS 10.1).' },
  { id: 'LU/eligibility', version: '2026.10.0', jurisdiction: 'LU', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'MiFID II per se professional clients; non-EU AIF marketing under Art. 45 of the Law of 12 July 2013 after the CSSF information form.' },
  { id: 'IE/eligibility', version: '2026.10.0', jurisdiction: 'IE', status: 'active', effective_from: '2026-10-01', effective_to: null,
    summary: 'MiFID II per se professional clients; non-EU AIF marketing under Reg. 43 of S.I. No. 257 of 2013 after Central Bank notification.' },
  { id: 'IN/eligibility', version: '2026.10.0', jurisdiction: 'IN', status: 'active', effective_from: '2026-10-02', effective_to: null,
    summary: 'SEBI accredited investors (AIF Master Circular Ch. 12); resident individuals within the RBI Liberalised Remittance Scheme (USD 250,000 per financial year); IFSCA accredited investors for GIFT City; overseas portfolio investment under the FEM (Overseas Investment) Rules 2022; Companies Act s42 200-person private placement limit.' },
  { id: 'AU/eligibility', version: '2026.10.1', jurisdiction: 'AU', status: 'active', effective_from: '2026-10-03', effective_to: null,
    summary: 'Wholesale clients (Corporations Act s761G(7): A$500,000 product value, certified A$2.5M net assets or A$250,000 gross income, large business) and professional investors (s9: A$10M gross assets); foreign schemes offered without a PDS to wholesale clients only (s601ED(2)); ASIC foreign financial services provider relief to 31 March 2027.' },
  { id: 'CA/eligibility', version: '2026.10.1', jurisdiction: 'CA', status: 'active', effective_from: '2026-10-03', effective_to: null,
    summary: 'Accredited investors (NI 45-106 s1.1: C$1M financial assets with Form 45-106F9, C$5M financial assets, C$200,000 or C$300,000 income, C$5M net assets; non-individuals C$5M net assets), permitted clients (NI 31-103: C$5M financial assets, C$25M net assets), minimum amount C$150,000 for non-individuals (s2.10); international dealer exemption for permitted clients (s8.18).' },
  { id: 'BR/eligibility', version: '2026.10.1', jurisdiction: 'BR', status: 'active', effective_from: '2026-10-03', effective_to: null,
    summary: 'Investidor qualificado (Resolução CVM 30 art. 12: financial investments over R$1 million with written attestation, or CVM certification) and investidor profissional (art. 11: over R$10 million, institutions, non-residents); offshore funds reached through Resolução CVM 175 feeder classes that may invest fully abroad.' },
  { id: 'KR/eligibility', version: '2026.10.1', jurisdiction: 'KR', status: 'active', effective_from: '2026-10-03', effective_to: null,
    summary: 'Professional investors (FSCMA Art. 9(5); Enforcement Decree Art. 10: KRW 50 million in financial investment products for a year plus KRW 100 million income, KRW 150 million with a spouse, KRW 500 million net assets or a professional qualification) and qualified professional investors (Enforcement Decree Art. 301); foreign collective investment schemes registered with the FSC before sale (Art. 279), privately placed to professional investors through a licensed distributor.' },
  { id: 'global/sanctions', version: '2024-01-01', jurisdiction: 'GLOBAL', status: 'retired', effective_from: '2024-01-01', effective_to: '2025-08-25',
    summary: 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, Syria, occupied regions of Ukraine.' },
  { id: 'global/sanctions', version: '2025-08-25', jurisdiction: 'GLOBAL', status: 'retired', effective_from: '2025-08-25', effective_to: '2026-10-01',
    summary: 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, occupied regions of Ukraine. Syria program removed Aug 25, 2025 (Executive Order 14312).' },
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
  for (const [code, label] of Object.entries(LAUNCH_OPT_IN_LABELS)) if (classInfo[code]) classInfo[code] = { ...classInfo[code], requiresOptIn: true, optInLabel: label };
  for (const c of NEW_CLASSES) classInfo[c.code] = { label: c.label, stamp: c.stamp, jur: c.jurisdiction, rule: c.rule_ref, source: c.source_id, threshold: c.threshold, requiresOptIn: c.requires_opt_in, optInLabel: c.opt_in_label };
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
  /** Fund fields overridden for the case (for example usAccepts, holderCap, regSCategory, offeringDate). */
  fund_patch?: Record<string, unknown>;
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
const NEW_DIST = { GB: NEW_LAW.GB, JP: NEW_LAW.JP, 'AE-ADGM': NEW_LAW['AE-ADGM'], LU: NEW_LAW.LU, IE: NEW_LAW.IE, IN: NEW_LAW.IN };
/** AGPC's U.S. entry widened to the new classes, for cases on a Section 3(c)(7) fund or a Rule 144A placement. */
const usDist = (accepts: string[], basis: string): LawRule => ({
  accepts, basis, lawRequires: accepts[0], lawRequiresAny: accepts,
  lawText: `${basis}: purchasers must hold the status the exemption names, verified by the issuer.`, lawRef: 'Reg D Rule 501(a); ICA §2(a)(51); Rule 144A', lawSource: 'reg-d-501',
});
const US_3C7 = { US: usDist(['US_AI', 'US_QP'], 'Section 3(c)(7) private fund offered under Rule 506(c)') };
const US_QP_ONLY = { US: usDist(['US_QP'], 'Section 3(c)(7) private fund: qualified purchasers only') };
const US_QIB_ONLY = { US: usDist(['US_QIB'], 'Rule 144A resale to qualified institutional buyers') };
const US_IAI_ONLY = { US: usDist(['US_IAI'], 'Rule 506(b) placement to institutional accredited investors') };
const US_AI_OK = { US_AI: { net_worth: 6_000_000 } };
const US_AI_ENTITY = { US_AI: { assets: 6_000_000 } };
const IN_AI_OK = { IN_AI: { annual_income: 25_000_000 } };
const lrs = (remitted: number) => ({ IN_LRS: { resident_individual: true, pan: true, remitted_this_fy_usd: remitted } });
const HOLDS_AGPC = { AGPC: { units: 1_000_000, since: '2025-01-15' } };
/** The Oct 3, 2026 jurisdictions added to TWLF for their cases. */
const DIST4 = { AU: NEW_LAW.AU, CA: NEW_LAW.CA, BR: NEW_LAW.BR, KR: NEW_LAW.KR };
const AU_CERT = { accountant_certificate: true, net_assets: 3_000_000 };
const KR_OK = { balance: 60_000_000, balance_one_year: true, annual_income: 120_000_000 };

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
  { id: 'US-06', pack: 'US/eligibility', name: 'Qualified purchaser with exactly $5M in investments joins a 3(c)(7) fund with 1,200 holders of record', fund: 'AGPC', distribution: US_3C7, fund_patch: { usAccepts: ['US_AI', 'US_QP'], holderCap: null, holders: 1200 }, order: sub(300_000),
    investor: person('US-06', 'US', 'NY', { US_QP: { investments: 5_000_000 }, ...US_AI_OK }, { usPerson: true }), expect: 'ALLOW', failing: [], issued: ['US_QP', 'US_AI'], present: ['cap12g'], absent: ['cap'] },
  { id: 'US-07', pack: 'US/eligibility', name: 'One dollar under $5M is not a qualified purchaser', fund: 'AGPC', distribution: US_QP_ONLY, fund_patch: { usAccepts: ['US_QP'], holderCap: null, holders: 1200 }, order: sub(300_000),
    investor: person('US-07', 'US', 'NY', { US_QP: { investments: 4_999_999 }, ...US_AI_OK }, { usPerson: true }), expect: 'DENY', failing: ['fundClass', 'law'], issued: ['US_AI'] },
  { id: 'US-08', pack: 'US/eligibility', name: 'A 3(c)(7) fund at 1,999 holders of record cannot add a 2,000th without Section 12(g) registration', fund: 'AGPC', distribution: US_3C7, fund_patch: { usAccepts: ['US_AI', 'US_QP'], holderCap: null, holders: 1999 }, order: sub(300_000),
    investor: corp('US-08', 'US', 'NY', { US_QP: { investments: 30_000_000 }, ...US_AI_ENTITY }, { usPerson: true }), expect: 'DENY', failing: ['cap12g'], issued: ['US_QP', 'US_AI'] },
  { id: 'US-09', pack: 'US/eligibility', name: 'Family company with $5M in investments is a qualified purchaser; an ordinary entity needs $25M', fund: 'AGPC', distribution: US_QP_ONLY, fund_patch: { usAccepts: ['US_QP'], holderCap: null, holders: 40 }, order: sub(300_000),
    investor: corp('US-09', 'US', 'NY', { US_QP: { family_company: true, investments: 5_000_000 }, ...US_AI_ENTITY }, { usPerson: true }), expect: 'ALLOW', failing: [], issued: ['US_QP', 'US_AI'] },
  { id: 'US-10', pack: 'US/eligibility', name: 'Qualified institutional buyer with $100M in securities', fund: 'AGPC', distribution: US_QIB_ONLY, fund_patch: { usAccepts: ['US_QIB'] }, order: sub(300_000),
    investor: corp('US-10', 'US', 'NY', { US_QIB: { securities: 100_000_000 }, ...US_AI_ENTITY }, { usPerson: true }), expect: 'ALLOW', failing: [], issued: ['US_QIB', 'US_AI'] },
  { id: 'US-11', pack: 'US/eligibility', name: 'Bank with $100M in securities but $20M net worth is not a QIB', fund: 'AGPC', distribution: US_QIB_ONLY, fund_patch: { usAccepts: ['US_QIB'] }, order: sub(300_000),
    investor: corp('US-11', 'US', 'NY', { US_QIB: { securities: 100_000_000, bank: true, net_worth: 20_000_000 }, ...US_AI_ENTITY }, { usPerson: true }), expect: 'DENY', failing: ['fundClass', 'law'], issued: ['US_AI'] },
  { id: 'US-12', pack: 'US/eligibility', name: 'Institutional accredited investor on $6M total assets', fund: 'AGPC', distribution: US_IAI_ONLY, fund_patch: { usAccepts: ['US_IAI'] }, order: sub(300_000),
    investor: corp('US-12', 'US', 'NY', { US_IAI: { total_assets: 6_000_000 }, ...US_AI_ENTITY }, { usPerson: true }), expect: 'ALLOW', failing: [], issued: ['US_IAI', 'US_AI'] },
  { id: 'US-13', pack: 'US/eligibility', name: 'Regulation S Category 3: offshore units cannot pass to a U.S. person inside the one-year period', fund: 'AGPC', fund_patch: { regSCategory: 3, offeringDate: '2026-01-15' }, order: { action: 'transfer', amount: 300_000, asset: 'USDC' },
    investor: corp('US-13', 'SG', 'SG', SG_OK, { holdings: HOLDS_AGPC }), counterparty: person('US-13-cp', 'US', 'NY', US_AI_OK, { usPerson: true }), expect: 'DENY', failing: ['regSPeriod'] },
  { id: 'US-14', pack: 'US/eligibility', name: 'Regulation S Category 3: the same transfer after the one-year period ends', fund: 'AGPC', fund_patch: { regSCategory: 3, offeringDate: '2025-06-01' }, order: { action: 'transfer', amount: 300_000, asset: 'USDC' },
    investor: corp('US-14', 'SG', 'SG', SG_OK, { holdings: HOLDS_AGPC }), counterparty: person('US-14-cp', 'US', 'NY', US_AI_OK, { usPerson: true }), expect: 'ALLOW', failing: [], present: ['regSPeriod'] },
  { id: 'US-15', pack: 'US/eligibility', name: 'Regulation S Category 3 debt: 40-day period still running', fund: 'AGPC', fund_patch: { regSCategory: 3, offeringDate: '2026-09-01', regSSecurityType: 'debt' }, order: { action: 'transfer', amount: 300_000, asset: 'USDC' },
    investor: corp('US-15', 'SG', 'SG', SG_OK, { holdings: HOLDS_AGPC }), counterparty: person('US-15-cp', 'US', 'NY', US_AI_OK, { usPerson: true }), expect: 'DENY', failing: ['regSPeriod'] },
  { id: 'US-16', pack: 'US/eligibility', name: 'Regulation S period does not touch a transfer between two non-U.S. persons', fund: 'AGPC', fund_patch: { regSCategory: 3, offeringDate: '2026-01-15' }, order: { action: 'transfer', amount: 300_000, asset: 'USDC' },
    investor: corp('US-16', 'SG', 'SG', SG_OK, { holdings: HOLDS_AGPC }), counterparty: corp('US-16-cp', 'HK', 'HK', { HK_PI: { portfolio: 50_000_000 } }), expect: 'ALLOW', failing: [], absent: ['regSPeriod'] },

  // ---------- IN/eligibility ----------
  { id: 'IN-01', pack: 'IN/eligibility', name: 'SEBI accredited individual within the LRS allowance, booked in GIFT City', fund: 'TWLF', distribution: NEW_DIST, order: sub(100_000),
    investor: person('IN-01', 'IN', 'GIFT', { ...IN_AI_OK, ...lrs(100_000) }), expect: 'ALLOW', failing: [], issued: ['IN_AI', 'IN_LRS'], present: ['lrs'], binding: ['booking'] },
  { id: 'IN-02', pack: 'IN/eligibility', name: 'Order that would take the financial year over USD 250,000', fund: 'TWLF', distribution: NEW_DIST, order: sub(100_000),
    investor: person('IN-02', 'IN', 'GIFT', { ...IN_AI_OK, ...lrs(200_000) }), expect: 'DENY', failing: ['lrs'], issued: ['IN_AI', 'IN_LRS'] },
  { id: 'IN-03', pack: 'IN/eligibility', name: 'Euro order converted at the demo rate breaches the LRS ceiling', fund: 'NMEL', distribution: { IN: NEW_LAW.IN }, order: sub(150_000, 'EURC'),
    investor: person('IN-03', 'IN', 'GIFT', { ...IN_AI_OK, ...lrs(100_000) }), expect: 'DENY', failing: ['lrs'], issued: ['IN_AI', 'IN_LRS'] },
  { id: 'IN-04', pack: 'IN/eligibility', name: 'Resident individual below the SEBI thresholds may invest within the LRS but the GIFT City licence needs accredited status', fund: 'TWLF', distribution: NEW_DIST, order: sub(100_000),
    investor: person('IN-04', 'IN', 'GIFT', { IN_AI: { annual_income: 15_000_000, net_worth: 40_000_000, financial_assets: 30_000_000 }, ...lrs(0) }), expect: 'DENY', failing: ['booking'], issued: ['IN_LRS'] },
  { id: 'IN-05', pack: 'IN/eligibility', name: 'Body corporate with INR 60 crore net worth: overseas portfolio investment, no LRS test', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('IN-05', 'IN', 'GIFT', { IN_AI: { net_worth: 600_000_000 } }), expect: 'ALLOW', failing: [], issued: ['IN_AI'], absent: ['lrs'] },
  { id: 'IN-06', pack: 'IN/eligibility', name: 'Body corporate with INR 40 crore net worth is not accredited', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('IN-06', 'IN', 'GIFT', { IN_AI: { net_worth: 400_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'IN-07', pack: 'IN/eligibility', name: 'IFSCA accredited individual on income, first remittance of the year', fund: 'TWLF', distribution: NEW_DIST, order: sub(100_000),
    investor: person('IN-07', 'IN', 'GIFT', { IFSCA_PRO: { annual_income: 250_000 }, ...lrs(0) }), expect: 'ALLOW', failing: [], issued: ['IFSCA_PRO', 'IN_LRS'] },
  { id: 'IN-08', pack: 'IN/eligibility', name: 'The LRS ceiling applies to every resident individual, with or without an LRS record', fund: 'TWLF', distribution: NEW_DIST, order: sub(300_000),
    investor: person('IN-08', 'IN', 'GIFT', IN_AI_OK), expect: 'DENY', failing: ['lrs'], issued: ['IN_AI'] },
  { id: 'IN-09', pack: 'IN/eligibility', name: 'Accredited individual booked in Hong Kong without professional investor status', fund: 'TWLF', distribution: NEW_DIST, order: sub(100_000),
    investor: person('IN-09', 'IN', 'HK', { ...IN_AI_OK, ...lrs(0) }), expect: 'DENY', failing: ['booking'], issued: ['IN_AI', 'IN_LRS'] },

  // ---------- GB/eligibility ----------
  { id: 'GB-01', pack: 'GB/eligibility', name: 'Large undertaking on balance sheet and turnover, booked in London: the licence (per se only) binds over the law (per se or elective)', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-01', 'GB', 'LDN', { GB_PRO: GB_BIG }), expect: 'ALLOW', failing: [], issued: ['GB_PRO'], binding: ['booking'] },
  { id: 'GB-02', pack: 'GB/eligibility', name: 'Undertaking meeting only the own funds test', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-02', 'GB', 'LDN', { GB_PRO: { own_funds: 3_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'GB-03', pack: 'GB/eligibility', name: 'FCA-regulated firm is per se professional', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-03', 'GB', 'LDN', { GB_PRO: { regulated_entity: true } }), expect: 'ALLOW', failing: [], issued: ['GB_PRO'] },
  { id: 'GB-04', pack: 'GB/eligibility', name: 'Elective professional with written opt-up satisfies UK law, but the London licence needs per se status', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: person('GB-04', 'GB', 'LDN', { GB_EPRO: { qualitative: true, portfolio: 750_000, finance_role: true, opt_in: true } }), expect: 'DENY', failing: ['booking'], issued: ['GB_EPRO'] },
  { id: 'GB-07', pack: 'GB/eligibility', name: 'Elective professional undertaking with written opt-up, booked in Singapore as an accredited investor', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-07', 'GB', 'SG', { GB_EPRO: { qualitative: true, frequent_trading: true, portfolio: 900_000, opt_in: true }, ...SG_OK }), expect: 'ALLOW', failing: [], issued: ['GB_EPRO', 'SG_AI'], binding: ['law', 'booking'] },
  { id: 'GB-08', pack: 'GB/eligibility', name: 'Elective professional record without the written opt-up fails UK law on consent', fund: 'TWLF', distribution: NEW_DIST, order: sub(250_000),
    investor: corp('GB-08', 'GB', 'SG', SG_OK, { classifications: [raw('GB_EPRO', '2027-03-14')] }), expect: 'DENY', failing: ['law'], issued: ['SG_AI'] },
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

  // ---------- AU/eligibility ----------
  { id: 'AU-01', pack: 'AU/eligibility', name: 'Company with a certified A$3M net assets figure, booked in Sydney', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('AU-01', 'AU', 'SYD', { AU_WHOLESALE: AU_CERT }), expect: 'ALLOW', failing: [], issued: ['AU_WHOLESALE'] },
  { id: 'AU-02', pack: 'AU/eligibility', name: 'Individual one dollar under both certificate figures', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('AU-02', 'AU', 'SYD', { AU_WHOLESALE: { accountant_certificate: true, net_assets: 2_499_999, gross_income: 249_999 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'AU-03', pack: 'AU/eligibility', name: 'Professional investor with exactly A$10M gross assets', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('AU-03', 'AU', 'SYD', { AU_PRO: { gross_assets: 10_000_000 } }), expect: 'ALLOW', failing: [], issued: ['AU_PRO'] },
  { id: 'AU-04', pack: 'AU/eligibility', name: 'Individual investing A$500,000 qualifies on product value without a certificate', fund: 'TWLF', distribution: DIST4, order: sub(500_000),
    investor: person('AU-04', 'AU', 'SYD', { AU_WHOLESALE: { product_value: 500_000 } }), expect: 'ALLOW', failing: [], issued: ['AU_WHOLESALE'] },
  { id: 'AU-05', pack: 'AU/eligibility', name: 'Gross income of A$250,000 without the accountant\'s certificate', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('AU-05', 'AU', 'SYD', { AU_WHOLESALE: { gross_income: 250_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'AU-06', pack: 'AU/eligibility', name: 'Wholesale client booked in Hong Kong without professional investor status', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('AU-06', 'AU', 'HK', { AU_WHOLESALE: AU_CERT }), expect: 'DENY', failing: ['booking'], issued: ['AU_WHOLESALE'] },

  // ---------- CA/eligibility ----------
  { id: 'CA-01', pack: 'CA/eligibility', name: 'Individual with C$1.2M net financial assets and a signed Form 45-106F9', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('CA-01', 'CA', 'TOR', { CA_AI: { financial_assets: 1_200_000, risk_acknowledgement: true } }), expect: 'ALLOW', failing: [], issued: ['CA_AI'] },
  { id: 'CA-02', pack: 'CA/eligibility', name: 'Same figures without the risk acknowledgement form', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('CA-02', 'CA', 'TOR', { CA_AI: { financial_assets: 1_200_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'CA-03', pack: 'CA/eligibility', name: 'Joint income of C$250,000 is under the C$300,000 spousal test', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('CA-03', 'CA', 'TOR', { CA_AI: { net_income: 250_000, joint: true, risk_acknowledgement: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'CA-04', pack: 'CA/eligibility', name: 'Individual with over C$5M in financial assets needs no form and is also a permitted client', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('CA-04', 'CA', 'TOR', { CA_AI: { financial_assets: 5_000_001 }, CA_PC: { financial_assets: 5_000_001 } }), expect: 'ALLOW', failing: [], issued: ['CA_AI', 'CA_PC'] },
  { id: 'CA-05', pack: 'CA/eligibility', name: 'Corporation paying C$150,000 under the minimum amount exemption', fund: 'TWLF', distribution: DIST4, order: sub(150_000),
    investor: corp('CA-05', 'CA', 'TOR', { CA_MIN: { acquisition_cost: 150_000, not_created_for_exemption: true }, CA_AI: { net_assets: 4_000_000 } }), expect: 'ALLOW', failing: [], issued: ['CA_MIN'] },
  { id: 'CA-06', pack: 'CA/eligibility', name: 'Corporation with C$25M net assets is an accredited investor and a permitted client', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('CA-06', 'CA', 'TOR', { CA_AI: { net_assets: 25_000_000 }, CA_PC: { net_assets: 25_000_000 } }), expect: 'ALLOW', failing: [], issued: ['CA_AI', 'CA_PC'] },
  { id: 'CA-07', pack: 'CA/eligibility', name: 'Accredited investor booked in London without UK status', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('CA-07', 'CA', 'LDN', { CA_AI: { net_assets: 6_000_000 } }), expect: 'DENY', failing: ['booking'], issued: ['CA_AI'] },

  // ---------- BR/eligibility ----------
  { id: 'BR-01', pack: 'BR/eligibility', name: 'Individual with R$1.5M in financial investments and the written attestation', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('BR-01', 'BR', 'SAO', { BR_QUAL: { financial_investments: 1_500_000, opt_in: true } }), expect: 'ALLOW', failing: [], issued: ['BR_QUAL'], binding: ['law'] },
  { id: 'BR-02', pack: 'BR/eligibility', name: 'Exactly R$1,000,000.00 does not exceed the qualified investor test', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('BR-02', 'BR', 'SAO', { BR_QUAL: { financial_investments: 1_000_000, opt_in: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'BR-03', pack: 'BR/eligibility', name: 'Qualified investor figures without the written attestation', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('BR-03', 'BR', 'SAO', { BR_QUAL: { financial_investments: 1_500_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'BR-04', pack: 'BR/eligibility', name: 'Company with R$12M in financial investments and the professional investor attestation', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('BR-04', 'BR', 'SAO', { BR_PRO: { financial_investments: 12_000_000, attestation: true } }), expect: 'ALLOW', failing: [], issued: ['BR_PRO'] },
  { id: 'BR-05', pack: 'BR/eligibility', name: 'Legacy qualified investor record without the attestation fails the consent test', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('BR-05', 'BR', 'SAO', {}, { classifications: [raw('BR_QUAL', '2027-03-14')] }), expect: 'DENY', failing: ['law', 'booking'] },
  { id: 'BR-06', pack: 'BR/eligibility', name: 'Professional investor booked in Singapore without accredited status', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('BR-06', 'BR', 'SG', { BR_PRO: { financial_investments: 12_000_000, attestation: true } }), expect: 'DENY', failing: ['booking'], issued: ['BR_PRO'] },

  // ---------- KR/eligibility ----------
  { id: 'KR-01', pack: 'KR/eligibility', name: 'Individual with KRW 60M held a year and KRW 120M income, booked in Seoul', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('KR-01', 'KR', 'SEL', { KR_PRO: KR_OK }), expect: 'ALLOW', failing: [], issued: ['KR_PRO'] },
  { id: 'KR-02', pack: 'KR/eligibility', name: 'Balance not yet held for a year', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('KR-02', 'KR', 'SEL', { KR_PRO: { ...KR_OK, balance_one_year: false } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'KR-03', pack: 'KR/eligibility', name: 'One won under the KRW 50M balance', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('KR-03', 'KR', 'SEL', { KR_PRO: { ...KR_OK, balance: 49_999_999, annual_income: 200_000_000 } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'KR-04', pack: 'KR/eligibility', name: 'Joint income of KRW 140M is under the KRW 150M spousal test', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('KR-04', 'KR', 'SEL', { KR_PRO: { ...KR_OK, annual_income: 140_000_000, joint: true } }), expect: 'DENY', failing: DENY_CLASS, issued: [] },
  { id: 'KR-05', pack: 'KR/eligibility', name: 'Pension fund is a professional and a qualified professional investor', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: corp('KR-05', 'KR', 'SEL', { KR_PRO: { regulated_institution: true }, KR_QPI: { qualified_institution: true } }), expect: 'ALLOW', failing: [], issued: ['KR_PRO', 'KR_QPI'] },
  { id: 'KR-06', pack: 'KR/eligibility', name: 'Individual qualifying on KRW 500M net assets', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('KR-06', 'KR', 'SEL', { KR_PRO: { balance: 50_000_000, balance_one_year: true, net_assets: 500_000_000 } }), expect: 'ALLOW', failing: [], issued: ['KR_PRO'] },
  { id: 'KR-07', pack: 'KR/eligibility', name: 'Professional investor booked in Tokyo without QII status', fund: 'TWLF', distribution: DIST4, order: sub(250_000),
    investor: person('KR-07', 'KR', 'TYO', { KR_PRO: KR_OK }), expect: 'DENY', failing: ['booking'], issued: ['KR_PRO'] },

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
