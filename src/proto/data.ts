// Prototype data. Institutions, people and funds are fictional.
// Thresholds and legal references are real and cited on /sources.

export const SIM_DATE = '2026-10-01';
export const SIM_TIME = '2026-10-01T14:22:07+08:00';

export type Jur = 'SG' | 'HK' | 'CH' | 'DE' | 'AE-DIFC' | 'US' | 'IR';
export const jurName: Record<Jur, string> = {
  SG: 'Singapore',
  HK: 'Hong Kong',
  CH: 'Switzerland',
  DE: 'Germany (EU)',
  'AE-DIFC': 'UAE (DIFC)',
  US: 'United States',
  IR: 'Iran',
};
export const jurShort: Record<Jur, string> = { SG: 'SG', HK: 'HK', CH: 'CH', DE: 'DE', 'AE-DIFC': 'AE', US: 'US', IR: 'IR' };

export type ClassCode = 'SG_AI' | 'HK_PI' | 'EU_PRO' | 'EU_RETAIL' | 'CH_PRO' | 'DIFC_PRO' | 'US_AI';

export const classInfo: Record<ClassCode, { label: string; stamp: string; jur: Jur; rule: string; source: string; threshold: string }> = {
  SG_AI: {
    label: 'Accredited investor', stamp: 'Accredited investor', jur: 'SG', rule: 'SFA s4A(1)(a)', source: 'sfa',
    threshold: 'Corporation: net assets over S$10M. Individual: net personal assets over S$2M, net financial assets over S$1M, or income of at least S$300K. Investor must opt in.',
  },
  HK_PI: {
    label: 'Professional investor', stamp: 'Professional investor', jur: 'HK', rule: 'Cap. 571D', source: 'hk-pi',
    threshold: 'Individual: portfolio of at least HK$8M. Corporation: portfolio of at least HK$8M or total assets of at least HK$40M.',
  },
  EU_PRO: {
    label: 'Professional client (per se)', stamp: 'Professional client', jur: 'DE', rule: 'MiFID II Annex II', source: 'mifid-annex2',
    threshold: 'Large undertaking meeting 2 of 3: balance sheet EUR 20M, net turnover EUR 40M, own funds EUR 2M.',
  },
  EU_RETAIL: {
    label: 'Retail client', stamp: 'Retail client', jur: 'DE', rule: 'MiFID II Art. 4(1)(11)', source: 'mifid-annex2',
    threshold: 'Any client that is not a professional client.',
  },
  CH_PRO: {
    label: 'Professional client (per se)', stamp: 'Professional client', jur: 'CH', rule: 'FinSA Art. 4(3)', source: 'finsa',
    threshold: 'Includes pension schemes with professional treasury and large companies meeting 2 of 3: CHF 20M balance sheet, CHF 40M turnover, CHF 2M equity.',
  },
  DIFC_PRO: {
    label: 'Professional client', stamp: 'Professional client', jur: 'AE-DIFC', rule: 'DFSA COB 2.3', source: 'dfsa-cob',
    threshold: 'Individual: net assets of at least US$1M plus experience. Assessed undertaking: own funds of at least US$1M.',
  },
  US_AI: {
    label: 'Accredited investor', stamp: 'Accredited investor', jur: 'US', rule: 'Reg D Rule 501(a)', source: 'reg-d-501',
    threshold: 'Individual: net worth over $1M excluding primary residence, or income over $200K ($300K joint). Entity: over $5M in assets.',
  },
};

export type BookingId = 'HK' | 'SG' | 'ZRH' | 'DIFC' | 'NY';
export type BookingCenter = {
  id: BookingId; name: string; jur: Jur; licence: string;
  requires: ClassCode | null; ruleText: string; ruleRef: string; source: string;
};
export const bookingCenters: Record<BookingId, BookingCenter> = {
  HK: { id: 'HK', name: 'Hong Kong', jur: 'HK', licence: 'SFC Types 1 and 4 (fictional licensee)', requires: 'HK_PI', ruleText: 'Dealing from Hong Kong in a fund the SFC has not authorized: client must be a professional investor.', ruleRef: 'SFO, Cap. 571D', source: 'hk-pi' },
  SG: { id: 'SG', name: 'Singapore', jur: 'SG', licence: 'MAS capital markets services licence (fictional licensee)', requires: 'SG_AI', ruleText: 'Restricted scheme dealt from Singapore: accredited or institutional investors only.', ruleRef: 'SFA s305', source: 'sfa' },
  ZRH: { id: 'ZRH', name: 'Zurich', jur: 'CH', licence: 'FINMA-licensed bank (fictional)', requires: 'CH_PRO', ruleText: 'Fund not approved for Swiss retail distribution: professional clients only.', ruleRef: 'FinSA Art. 4', source: 'finsa' },
  DIFC: { id: 'DIFC', name: 'Dubai (DIFC)', jur: 'AE-DIFC', licence: 'DFSA Category 4 (fictional licensee)', requires: 'DIFC_PRO', ruleText: 'Firm licensed to deal with professional clients only.', ruleRef: 'DFSA COB 2.3', source: 'dfsa-cob' },
  NY: { id: 'NY', name: 'New York', jur: 'US', licence: 'FINRA broker-dealer affiliate (fictional)', requires: 'US_AI', ruleText: 'Private placement under Rule 506(c): verified accredited investors only.', ruleRef: 'Reg D Rule 501(a)', source: 'reg-d-501' },
};

export type FundId = 'TWLF' | 'NMEL' | 'AGPC';
export type Fund = {
  id: FundId; name: string; short: string; ticker: string; domicile: string; structure: string;
  currency: 'USD' | 'EUR'; nav: number; regS: boolean; usAccepts: ClassCode[] | null;
  distribution: Partial<Record<Jur, { accepts: ClassCode[]; basis: string; lawRequires: ClassCode | null; lawText: string; lawRef: string; lawSource: string }>>;
  minSubscription: number; holderCap: number | null; holders: number; lockupMonths: number | null;
  assets: string[]; chains: string[]; issuer: string;
};

export const funds: Record<FundId, Fund> = {
  TWLF: {
    id: 'TWLF', name: 'Tidewell Treasury Liquidity Fund, Tokenized Class T', short: 'Tidewell Treasury Liquidity', ticker: 'TWLF',
    domicile: 'British Virgin Islands', structure: 'Open-ended money market fund holding U.S. Treasury bills', currency: 'USD', nav: 1.0,
    regS: true, usAccepts: null, issuer: 'Tidewell Asset Management (fictional)',
    distribution: {
      SG: { accepts: ['SG_AI'], basis: 'Restricted scheme offer', lawRequires: 'SG_AI', lawText: 'Offer of a scheme not recognized by MAS: accredited investors who have opted in, or institutional investors.', lawRef: 'SFA s305, s4A', lawSource: 'sfa' },
      HK: { accepts: ['HK_PI'], basis: 'Not authorized by the SFC', lawRequires: 'HK_PI', lawText: 'Offer of a fund not authorized by the SFC: professional investors only.', lawRef: 'Cap. 571D', lawSource: 'hk-pi' },
      CH: { accepts: ['CH_PRO'], basis: 'Not approved for Swiss retail', lawRequires: 'CH_PRO', lawText: 'Foreign fund not approved by FINMA: no retail offering.', lawRef: 'FinSA Art. 4', lawSource: 'finsa' },
      DE: { accepts: ['EU_PRO'], basis: 'Non-EU AIF under national private placement', lawRequires: 'EU_PRO', lawText: 'Non-EU AIF marketed under a national private placement regime: professional investors only.', lawRef: 'AIFMD Art. 42', lawSource: 'aifmd' },
      'AE-DIFC': { accepts: ['DIFC_PRO'], basis: 'Exempt offer to professional clients', lawRequires: 'DIFC_PRO', lawText: 'Exempt fund offer in the DIFC: professional clients only.', lawRef: 'DFSA COB 2.3', lawSource: 'dfsa-cob' },
    },
    minSubscription: 100_000, holderCap: null, holders: 214, lockupMonths: null,
    assets: ['USDC', 'AVB-USD'], chains: ['Ethereum', 'Base'],
  },
  NMEL: {
    id: 'NMEL', name: 'Northmere Euro Liquidity UCITS, Tokenized Class TK', short: 'Northmere Euro Liquidity', ticker: 'NMEL',
    domicile: 'Ireland', structure: 'UCITS money market fund, low-volatility NAV', currency: 'EUR', nav: 1.0,
    regS: true, usAccepts: null, issuer: 'Northmere Investors (fictional)',
    distribution: {
      DE: { accepts: ['EU_PRO', 'EU_RETAIL'], basis: 'UCITS registered for sale in Germany', lawRequires: null, lawText: 'UCITS passported into Germany may be sold to retail and professional clients.', lawRef: 'UCITS Directive', lawSource: 'mifid-annex2' },
      CH: { accepts: ['CH_PRO'], basis: 'Not registered with FINMA for retail', lawRequires: 'CH_PRO', lawText: 'Foreign fund not approved by FINMA: no retail offering.', lawRef: 'FinSA Art. 4', lawSource: 'finsa' },
      SG: { accepts: ['SG_AI'], basis: 'Restricted scheme offer', lawRequires: 'SG_AI', lawText: 'Offer of a scheme not recognized by MAS: accredited investors who have opted in, or institutional investors.', lawRef: 'SFA s305, s4A', lawSource: 'sfa' },
      HK: { accepts: ['HK_PI'], basis: 'Not authorized by the SFC', lawRequires: 'HK_PI', lawText: 'Offer of a fund not authorized by the SFC: professional investors only.', lawRef: 'Cap. 571D', lawSource: 'hk-pi' },
    },
    minSubscription: 10_000, holderCap: null, holders: 388, lockupMonths: null,
    assets: ['EURC', 'AVB-EUR'], chains: ['Ethereum'],
  },
  AGPC: {
    id: 'AGPC', name: 'Ashgrove Private Credit Fund LP, Tokenized Interests', short: 'Ashgrove Private Credit', ticker: 'AGPC',
    domicile: 'Delaware, United States', structure: 'Private fund relying on Section 3(c)(1); Rule 506(c) in the U.S., Regulation S abroad', currency: 'USD', nav: 1.0412,
    regS: false, usAccepts: ['US_AI'], issuer: 'Ashgrove Credit Partners (fictional)',
    distribution: {
      SG: { accepts: ['SG_AI'], basis: 'Regulation S offer; restricted scheme in Singapore', lawRequires: 'SG_AI', lawText: 'Offer of a scheme not recognized by MAS: accredited investors who have opted in, or institutional investors.', lawRef: 'SFA s305, s4A', lawSource: 'sfa' },
      HK: { accepts: ['HK_PI'], basis: 'Regulation S offer; not authorized by the SFC', lawRequires: 'HK_PI', lawText: 'Offer of a fund not authorized by the SFC: professional investors only.', lawRef: 'Cap. 571D', lawSource: 'hk-pi' },
      CH: { accepts: ['CH_PRO'], basis: 'Regulation S offer; not approved for Swiss retail', lawRequires: 'CH_PRO', lawText: 'Foreign fund not approved by FINMA: no retail offering.', lawRef: 'FinSA Art. 4', lawSource: 'finsa' },
      DE: { accepts: ['EU_PRO'], basis: 'Non-EU AIF under national private placement', lawRequires: 'EU_PRO', lawText: 'Non-EU AIF marketed under a national private placement regime: professional investors only.', lawRef: 'AIFMD Art. 42', lawSource: 'aifmd' },
      'AE-DIFC': { accepts: ['DIFC_PRO'], basis: 'Exempt offer to professional clients', lawRequires: 'DIFC_PRO', lawText: 'Exempt fund offer in the DIFC: professional clients only.', lawRef: 'DFSA COB 2.3', lawSource: 'dfsa-cob' },
      US: { accepts: ['US_AI'], basis: 'Rule 506(c) private placement', lawRequires: 'US_AI', lawText: 'Rule 506(c) offering: purchasers must be verified accredited investors.', lawRef: 'Reg D Rule 501(a)', lawSource: 'reg-d-501' },
    },
    minSubscription: 250_000, holderCap: 100, holders: 97, lockupMonths: 12,
    assets: ['USDC'], chains: ['Ethereum'],
  },
};

export type Classification = { code: ClassCode; basis: string; verified: string; expires: string; optIn?: string };
export type InvestorId = 'lumen' | 'kestrel' | 'qamar' | 'meitan' | 'reyes' | 'sorell';
export type Investor = {
  id: InvestorId; name: string; short: string; kind: string; residence: Jur; city: string; booking: BookingId;
  usPerson: boolean; wallet: string; credentialId: string; issued: string; expires: string;
  classifications: Classification[]; holdings: Partial<Record<FundId, { units: number; since: string }>>;
};

export const investors: Record<InvestorId, Investor> = {
  lumen: {
    id: 'lumen', name: 'Lumen Family Office Pte. Ltd.', short: 'Lumen Family Office', kind: 'Single-family office', residence: 'SG', city: 'Singapore', booking: 'HK',
    usPerson: false, wallet: '0x7a3f…c91e', credentialId: 'LP-SG-0419-2207', issued: '2026-03-14', expires: '2027-03-14',
    classifications: [
      { code: 'SG_AI', basis: 'Corporation with net assets of S$48.2M', verified: '2026-03-14', expires: '2027-03-14', optIn: '2026-03-14' },
      { code: 'HK_PI', basis: 'Corporation with a portfolio of HK$310M', verified: '2026-03-14', expires: '2027-03-14' },
    ],
    holdings: { TWLF: { units: 3_250_000, since: '2025-11-02' }, AGPC: { units: 400_000, since: '2026-06-01' } },
  },
  kestrel: {
    id: 'kestrel', name: 'Kestrel Treasury GmbH', short: 'Kestrel Treasury', kind: 'Corporate treasury', residence: 'DE', city: 'Frankfurt', booking: 'ZRH',
    usPerson: false, wallet: '0x19be…04d2', credentialId: 'LP-DE-1182-0931', issued: '2026-01-20', expires: '2027-01-20',
    classifications: [
      { code: 'EU_PRO', basis: 'Large undertaking: balance sheet EUR 410M, turnover EUR 880M, own funds EUR 120M', verified: '2026-01-20', expires: '2027-01-20' },
      { code: 'CH_PRO', basis: 'Large company meeting all three FinSA size thresholds', verified: '2026-01-20', expires: '2027-01-20' },
    ],
    holdings: { NMEL: { units: 5_000_000, since: '2025-08-20' } },
  },
  qamar: {
    id: 'qamar', name: 'Qamar Holdings Ltd', short: 'Qamar Holdings', kind: 'Holding company', residence: 'AE-DIFC', city: 'Dubai', booking: 'DIFC',
    usPerson: false, wallet: '0xd04c…7a10', credentialId: 'LP-AE-0077-5512', issued: '2026-02-10', expires: '2027-02-10',
    classifications: [
      { code: 'DIFC_PRO', basis: 'Assessed undertaking with own funds of US$6.2M', verified: '2026-02-10', expires: '2027-02-10' },
    ],
    holdings: { TWLF: { units: 750_000, since: '2026-02-10' } },
  },
  meitan: {
    id: 'meitan', name: 'Mei Tan', short: 'Mei Tan', kind: 'Individual', residence: 'HK', city: 'Hong Kong', booking: 'HK',
    usPerson: false, wallet: '0x5e21…b8f3', credentialId: 'LP-HK-2650-1048', issued: '2026-07-02', expires: '2027-07-02',
    classifications: [],
    holdings: {},
  },
  reyes: {
    id: 'reyes', name: 'Daniel Reyes', short: 'Daniel Reyes', kind: 'Individual', residence: 'US', city: 'Houston, Texas', booking: 'NY',
    usPerson: true, wallet: '0x88a0…31cd', credentialId: 'LP-US-3391-7720', issued: '2025-09-15', expires: '2026-09-15',
    classifications: [
      { code: 'US_AI', basis: 'Net worth of US$2.4M excluding primary residence', verified: '2025-09-15', expires: '2026-09-15' },
    ],
    holdings: { AGPC: { units: 250_000, since: '2025-09-15' } },
  },
  sorell: {
    id: 'sorell', name: 'Sorell Pensionskasse', short: 'Sorell Pensionskasse', kind: 'Occupational pension fund', residence: 'CH', city: 'Basel', booking: 'ZRH',
    usPerson: false, wallet: '0x3c77…e6a9', credentialId: 'LP-CH-0904-3316', issued: '2026-04-01', expires: '2027-04-01',
    classifications: [
      { code: 'CH_PRO', basis: 'Occupational pension scheme with professional treasury', verified: '2026-04-01', expires: '2027-04-01' },
    ],
    holdings: { NMEL: { units: 12_000_000, since: '2024-11-04' }, AGPC: { units: 1_000_000, since: '2025-04-01' } },
  },
};

// Notes shown for investors whose status is notable
export const investorNotes: Partial<Record<InvestorId, string>> = {
  meitan: 'Portfolio of HK$5.2M, below the HK$8M professional investor threshold. Retail client in Hong Kong.',
  reyes: 'Accredited investor verification expired on Sep 15, 2026. Re-verification pending.',
};

export const sanctionedJurisdictions: Partial<Record<Jur, string>> = {
  IR: 'Iran is subject to a comprehensive U.S. sanctions program (OFAC).',
};

export const ASSET_INFO: Record<string, { label: string; kind: string }> = {
  USDC: { label: 'USDC', kind: 'Payment stablecoin (Circle)' },
  EURC: { label: 'EURC', kind: 'E-money token (Circle)' },
  'AVB-USD': { label: 'AVB-USD', kind: 'Tokenized deposit, Aster & Vale (fictional)' },
  'AVB-EUR': { label: 'AVB-EUR', kind: 'Tokenized deposit, Aster & Vale (fictional)' },
  USDT: { label: 'USDT', kind: 'Stablecoin (Tether)' },
};

export const DISTRIBUTOR = 'Aster & Vale Private Bank';
