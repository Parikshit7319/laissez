// Private placement and investor-count limits, per jurisdiction, for the reporting module.
// `number` is the figure the rule names; `limit_text` says whether the bound is inclusive
// ("no more than 50", "fewer than 500"). null means the basis has no head-count cap.
// `verified` is true only when the figure and the citation were confirmed against the linked source
// on Oct 2, 2026. Secondary sources are marked in src/data/sources.ts. Not legal advice.

export type PlacementLimit = {
  jurisdiction: string;
  basis: string;
  limit_text: string;
  number: number | null;
  unit: 'offerees' | 'investors' | 'beneficial_owners' | 'holders_of_record' | null;
  period: string | null;
  citation: string;
  source_url: string;
  verified: boolean;
};

export const PLACEMENT_LIMITS: PlacementLimit[] = [
  // ---------- Singapore ----------
  { jurisdiction: 'SG', basis: 'Restricted scheme offered to accredited investors and relevant persons', limit_text: 'No numeric cap. The scheme must be notified to MAS and entered on its list of restricted schemes before any offer.',
    number: null, unit: null, period: null, citation: 'SFA s305', source_url: 'https://cms.law/en/int/expert-guides/cms-expert-guide-to-private-placement-of-funds/singapore', verified: true },
  { jurisdiction: 'SG', basis: 'Private placement of units in a collective investment scheme', limit_text: 'Offers to no more than 50 persons within any period of 12 months.',
    number: 50, unit: 'offerees', period: '12 months', citation: 'SFA s302C', source_url: 'https://cms.law/en/int/expert-guides/cms-expert-guide-to-private-placement-of-funds/singapore', verified: true },
  { jurisdiction: 'SG', basis: 'Small offers of units in a collective investment scheme', limit_text: 'Total raised within any 12 months may not exceed S$5 million. A value cap, not a head count.',
    number: null, unit: null, period: '12 months', citation: 'SFA s302B', source_url: 'https://cms.law/en/int/expert-guides/cms-expert-guide-to-private-placement-of-funds/singapore', verified: true },
  { jurisdiction: 'SG', basis: 'Private placement of shares or debentures (not CIS units)', limit_text: 'Offers to no more than 50 persons within any period of 12 months. Units in a CIS use s302C instead.',
    number: 50, unit: 'offerees', period: '12 months', citation: 'SFA s272B', source_url: 'https://sso.agc.gov.sg/Act/SFA2001', verified: false },

  // ---------- Hong Kong ----------
  { jurisdiction: 'HK', basis: 'Offer of a fund not authorized by the SFC, made only to professional investors', limit_text: 'No numeric cap.',
    number: null, unit: null, period: null, citation: 'SFO s103(3)(k); Cap. 571D', source_url: 'https://www.charltonslaw.com/legal/compliance/Regulation-of-Crowd-Funding-in-Hong-Kong.pdf', verified: false },
  { jurisdiction: 'HK', basis: 'Offer of shares or debentures to a limited number of persons (prospectus safe harbour)', limit_text: 'Not more than 50 persons, counting offers made under the same exemption in the previous 12 months. Applies to shares and debentures, such as shares of a corporate fund.',
    number: 50, unit: 'offerees', period: '12 months', citation: 'C(WUMP)O Cap. 32, Seventeenth Schedule, Part 1, s2', source_url: 'https://www.charltonslaw.com/legal/compliance/Regulation-of-Crowd-Funding-in-Hong-Kong.pdf', verified: false },

  // ---------- Switzerland ----------
  { jurisdiction: 'CH', basis: 'Foreign fund offered only to professional and institutional clients', limit_text: 'No numeric cap. No FINMA approval, and no Swiss representative or paying agent, when offered only to per se professional and institutional clients.',
    number: null, unit: null, period: null, citation: 'CISA; FinSA Art. 4', source_url: 'https://cms.law/en/int/expert-guides/cms-expert-guide-to-private-placement-of-funds/switzerland', verified: true },
  { jurisdiction: 'CH', basis: 'Prospectus exemption for an offer of securities', limit_text: 'Offers addressed to fewer than 500 investors need no prospectus.',
    number: 500, unit: 'offerees', period: null, citation: 'FinSA Art. 36(1)(b)', source_url: 'https://cms.law/en/int/expert-guides/cms-expert-guide-to-private-placement-of-funds/switzerland', verified: false },

  // ---------- Germany (EU national private placement) ----------
  { jurisdiction: 'DE', basis: 'Non-EU AIF marketed to professional and semi-professional investors', limit_text: 'No numeric cap. Marketing needs a prior notification to BaFin.',
    number: null, unit: null, period: null, citation: 'KAGB § 330; AIFMD Art. 42', source_url: 'https://www.bafin.de/SharedDocs/Downloads/EN/Merkblatt/WA/dl_wa_merkbl_330_kagb_en.pdf?__blob=publicationFile', verified: true },

  // ---------- UAE (DIFC) ----------
  { jurisdiction: 'AE-DIFC', basis: 'DFSA Exempt Fund', limit_text: '100 or fewer unitholders, all Professional Clients, minimum initial subscription US$50,000, private placement only.',
    number: 100, unit: 'investors', period: null, citation: 'DFSA Collective Investment Law 2010 and CIR, Exempt Fund criteria', source_url: 'https://www.dfsa.ae/download_file/view/299/525', verified: true },
  { jurisdiction: 'AE-DIFC', basis: 'DFSA Qualified Investor Fund', limit_text: '50 or fewer unitholders, all Professional Clients, minimum initial subscription US$500,000, private placement only.',
    number: 50, unit: 'investors', period: null, citation: 'DFSA Collective Investment Law 2010 and CIR, QIF criteria', source_url: 'https://www.dfsa.ae/download_file/view/299/525', verified: true },
  { jurisdiction: 'AE-DIFC', basis: 'Foreign fund offered in or from the DIFC by private placement', limit_text: 'One route: 100 or fewer investors, each a Professional Client subscribing at least US$50,000. Other routes rely on the home regulator or a suitability recommendation.',
    number: 100, unit: 'investors', period: null, citation: 'DFSA Collective Investment Law 2010 (foreign fund offers)', source_url: 'https://www.dfsa.ae/download_file/view/299/525', verified: true },

  // ---------- United States ----------
  { jurisdiction: 'US', basis: 'Investment Company Act Section 3(c)(1) private fund', limit_text: 'Not more than 100 beneficial owners (250 for a qualifying venture capital fund), and no public offering.',
    number: 100, unit: 'beneficial_owners', period: null, citation: '15 U.S.C. 80a-3(c)(1)', source_url: 'https://www.law.cornell.edu/uscode/text/15/80a-3', verified: true },
  { jurisdiction: 'US', basis: 'Rule 506(b) offering', limit_text: 'No more than 35 purchasers who are not accredited investors in any 90-calendar-day period. Accredited investors are not counted.',
    number: 35, unit: 'investors', period: '90 days', citation: '17 CFR 230.506(b)(2)(i)', source_url: 'https://www.law.cornell.edu/cfr/text/17/230.506', verified: true },
  { jurisdiction: 'US', basis: 'Rule 506(c) offering', limit_text: 'No cap on purchasers. Every purchaser must be an accredited investor, verified by the issuer.',
    number: null, unit: null, period: null, citation: '17 CFR 230.506(c)', source_url: 'https://www.law.cornell.edu/cfr/text/17/230.506', verified: true },
  { jurisdiction: 'US', basis: 'Investment Company Act Section 3(c)(7) private fund', limit_text: 'No statutory cap; every owner must be a qualified purchaser. The Exchange Act 12(g) holder-of-record threshold still applies.',
    number: null, unit: null, period: null, citation: '15 U.S.C. 80a-3(c)(7)', source_url: 'https://www.law.cornell.edu/uscode/text/15/80a-3', verified: true },
  { jurisdiction: 'US', basis: 'Exchange Act Section 12(g) registration threshold', limit_text: 'Registration is due within 120 days after fiscal year end once total assets exceed $10M and a class of equity is held of record by 2,000 persons, or by 500 persons who are not accredited investors.',
    number: 2000, unit: 'holders_of_record', period: 'Fiscal year end', citation: '15 U.S.C. 78l(g)(1)(A)', source_url: 'https://www.law.cornell.edu/uscode/text/15/78l', verified: true },

  // ---------- United Kingdom ----------
  { jurisdiction: 'GB', basis: 'UK national private placement of a non-UK AIF', limit_text: 'No numeric cap. Professional investors only; the AIFM notifies the FCA in writing before marketing.',
    number: null, unit: null, period: null, citation: 'AIFM Regulations 2013 (SI 2013/1773) regs 57 to 59', source_url: 'https://www.legislation.gov.uk/uksi/2013/1773/regulation/59', verified: true },
  { jurisdiction: 'GB', basis: 'Promotion of a non-mainstream pooled investment to retail clients', limit_text: 'No head-count cap. Retail promotion only to exempt categories, such as certified high net worth investors with £100,000 income or £250,000 net assets who signed the statement within 12 months.',
    number: null, unit: null, period: '12 months', citation: 'COBS 4.12B; COBS 4 Annex 2R', source_url: 'https://www.handbook.fca.org.uk/handbook/COBS/4/12B.html', verified: false },

  // ---------- Japan ----------
  { jurisdiction: 'JP', basis: 'QII-only private placement', limit_text: 'No cap on QII offerees. The securities must be restricted from transfer to anyone other than a QII.',
    number: null, unit: null, period: null, citation: 'FIEA Art. 2(3)(ii)(a)', source_url: 'https://www.fsa.go.jp/common/law/fie01.pdf', verified: true },
  { jurisdiction: 'JP', basis: 'Small-number private placement of paragraph (1) securities, such as shares of a foreign investment corporation', limit_text: 'A solicitation of 50 or more persons is a public offering, so a small-number placement stays under 50. QIIs are not counted where the QII transfer conditions are met.',
    number: 50, unit: 'offerees', period: null, citation: 'FIEA Art. 2(3)(i)', source_url: 'https://www.fsa.go.jp/en/laws_regulations/faq_on_fiea/section02.html', verified: true },
  { jurisdiction: 'JP', basis: 'Private placement of paragraph (2) securities, such as LP interests', limit_text: 'A solicitation that leaves 500 or more holders is a public offering, so a private placement stays under 500 holders.',
    number: 500, unit: 'investors', period: null, citation: 'FIEA Art. 2(3)(iii)', source_url: 'https://www.fsa.go.jp/en/laws_regulations/faq_on_fiea/section02.html', verified: true },
  { jurisdiction: 'JP', basis: 'Specially Permitted Business for QIIs (fund self-offering by a notified operator)', limit_text: 'At least 1 QII and no more than 49 investors who are not QIIs.',
    number: 49, unit: 'investors', period: null, citation: 'FIEA Art. 63', source_url: 'https://lfb.mof.go.jp/kantou/kinyuu/kinshotorihou/tokureigyoumugaiyou.pdf', verified: true },

  // ---------- UAE (ADGM) ----------
  { jurisdiction: 'AE-ADGM', basis: 'Foreign fund marketed by an ADGM authorised firm', limit_text: 'No numeric cap. The firm notifies the FSRA within 30 days of starting; retail offers only if the fund can be sold to retail investors at home.',
    number: null, unit: null, period: null, citation: 'FSRA FUNDS 10.1; FSRA-FMN notification', source_url: 'https://assets.adgm.com/download/assets/fsra-fmn-notification-marketing-and-selling-of-funds.pdf/4e7baab05b9d11ef918f3608cb474223', verified: true },
  { jurisdiction: 'AE-ADGM', basis: 'ADGM Exempt Fund', limit_text: 'No upper limit on investor numbers. Professional Clients by private placement, minimum subscription US$50,000.',
    number: null, unit: null, period: null, citation: 'FSRA FUNDS, Exempt Funds', source_url: 'https://assets.adgm.com/download/assets/adgm-investment-funds.pdf/8a8dd708589b11ef9fab36e29b0f3a63', verified: true },
  { jurisdiction: 'AE-ADGM', basis: 'ADGM Qualified Investor Fund', limit_text: 'No upper limit on investor numbers. Professional Clients by private placement, minimum subscription US$500,000.',
    number: null, unit: null, period: null, citation: 'FSRA FUNDS, Qualified Investor Funds', source_url: 'https://assets.adgm.com/download/assets/adgm-investment-funds.pdf/8a8dd708589b11ef9fab36e29b0f3a63', verified: true },

  // ---------- Luxembourg ----------
  { jurisdiction: 'LU', basis: 'National private placement by a non-EU AIFM', limit_text: 'No numeric cap. Professional investors only; the AIFM files the CSSF information form before marketing.',
    number: null, unit: null, period: null, citation: 'Law of 12 July 2013 Art. 45; AIFMD Art. 42', source_url: 'https://www.cssf.lu/en/marketing-alternative-investment-funds/', verified: true },

  // ---------- Ireland ----------
  { jurisdiction: 'IE', basis: 'National private placement by a non-EU AIFM', limit_text: 'No numeric cap. Professional investors only; the AIFM notifies the Central Bank of Ireland.',
    number: null, unit: null, period: null, citation: 'S.I. No. 257 of 2013 Reg. 43; AIFMD Art. 42', source_url: 'https://www.centralbank.ie/regulation/industry-market-sectors/funds/aifs/guidance/publication-of-national-provisions-governing-marketing-requirements-for-AIFs', verified: true },
];

export const placementLimitsFor = (jurisdiction: string) => PLACEMENT_LIMITS.filter((l) => l.jurisdiction === jurisdiction);
