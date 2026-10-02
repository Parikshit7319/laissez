// Threshold tests behind each investor classification. Shared by the API (to validate
// credential issuance) and the app (to show pass or fail while the form is filled in).
// Figures come from the cited rules; see /sources.

export type Evidence = Record<string, number | boolean | undefined>;
export type FieldDef = { key: string; label: string; kind: 'money' | 'bool'; unit?: string };
export type Test = { code: string; subject: 'individual' | 'entity'; fields: FieldDef[]; check: (e: Evidence) => { pass: boolean; reason: string } };

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const fmt = (v: number, unit: string) => `${unit}${v.toLocaleString('en-US')}`;
const twoOfThree = (hits: boolean[]) => hits.filter(Boolean).length >= 2;

export const TESTS: Test[] = [
  {
    code: 'SG_AI', subject: 'entity',
    fields: [{ key: 'net_assets', label: 'Net assets', kind: 'money', unit: 'S$' }, { key: 'opt_in', label: 'Investor has opted in to accredited status', kind: 'bool' }],
    check: (e) => {
      const ok = n(e.net_assets) > 10_000_000;
      if (!ok) return { pass: false, reason: `Net assets of ${fmt(n(e.net_assets), 'S$')} do not exceed S$10,000,000 (SFA s4A(1)(a)(ii)).` };
      if (!e.opt_in) return { pass: false, reason: 'Qualifies on net assets, but the investor has not opted in. Singapore requires opt-in consent.' };
      return { pass: true, reason: `Net assets of ${fmt(n(e.net_assets), 'S$')} exceed S$10M, and opt-in is recorded.` };
    },
  },
  {
    code: 'SG_AI', subject: 'individual',
    fields: [
      { key: 'net_personal_assets', label: 'Net personal assets (primary residence counts up to S$1M)', kind: 'money', unit: 'S$' },
      { key: 'net_financial_assets', label: 'Net financial assets', kind: 'money', unit: 'S$' },
      { key: 'income', label: 'Income in the last 12 months', kind: 'money', unit: 'S$' },
      { key: 'opt_in', label: 'Investor has opted in to accredited status', kind: 'bool' },
    ],
    check: (e) => {
      const routes = [
        n(e.net_personal_assets) > 2_000_000 && 'net personal assets over S$2M',
        n(e.net_financial_assets) > 1_000_000 && 'net financial assets over S$1M',
        n(e.income) >= 300_000 && 'income of at least S$300K',
      ].filter(Boolean);
      if (!routes.length) return { pass: false, reason: 'None of the three routes is met: net personal assets over S$2M, net financial assets over S$1M, or income of at least S$300K.' };
      if (!e.opt_in) return { pass: false, reason: `Qualifies on ${routes[0]}, but the investor has not opted in.` };
      return { pass: true, reason: `Qualifies on ${routes.join(' and ')}; opt-in recorded.` };
    },
  },
  {
    code: 'HK_PI', subject: 'entity',
    fields: [{ key: 'portfolio', label: 'Investment portfolio', kind: 'money', unit: 'HK$' }, { key: 'total_assets', label: 'Total assets', kind: 'money', unit: 'HK$' }],
    check: (e) => {
      if (n(e.portfolio) >= 8_000_000) return { pass: true, reason: `Portfolio of ${fmt(n(e.portfolio), 'HK$')} meets the HK$8M test (Cap. 571D).` };
      if (n(e.total_assets) >= 40_000_000) return { pass: true, reason: `Total assets of ${fmt(n(e.total_assets), 'HK$')} meet the HK$40M test (Cap. 571D).` };
      return { pass: false, reason: 'Needs a portfolio of at least HK$8M or total assets of at least HK$40M.' };
    },
  },
  {
    code: 'HK_PI', subject: 'individual',
    fields: [{ key: 'portfolio', label: 'Investment portfolio', kind: 'money', unit: 'HK$' }],
    check: (e) => n(e.portfolio) >= 8_000_000
      ? { pass: true, reason: `Portfolio of ${fmt(n(e.portfolio), 'HK$')} meets the HK$8M test.` }
      : { pass: false, reason: `Portfolio of ${fmt(n(e.portfolio), 'HK$')} is below the HK$8M professional investor threshold.` },
  },
  {
    code: 'EU_PRO', subject: 'entity',
    fields: [{ key: 'balance_sheet', label: 'Balance sheet total', kind: 'money', unit: '€' }, { key: 'net_turnover', label: 'Net turnover', kind: 'money', unit: '€' }, { key: 'own_funds', label: 'Own funds', kind: 'money', unit: '€' }],
    check: (e) => {
      const hits = [n(e.balance_sheet) >= 20_000_000, n(e.net_turnover) >= 40_000_000, n(e.own_funds) >= 2_000_000];
      return twoOfThree(hits)
        ? { pass: true, reason: `Meets ${hits.filter(Boolean).length} of 3 large-undertaking tests (MiFID II Annex II).` }
        : { pass: false, reason: `Meets ${hits.filter(Boolean).length} of 3 tests; 2 are required: EUR 20M balance sheet, EUR 40M turnover, EUR 2M own funds.` };
    },
  },
  {
    code: 'EU_RETAIL', subject: 'individual', fields: [],
    check: () => ({ pass: true, reason: 'Retail client classification: no threshold.' }),
  },
  {
    code: 'CH_PRO', subject: 'entity',
    fields: [
      { key: 'pension_professional_treasury', label: 'Occupational pension scheme with professional treasury', kind: 'bool' },
      { key: 'balance_sheet', label: 'Balance sheet total', kind: 'money', unit: 'CHF ' },
      { key: 'turnover', label: 'Turnover', kind: 'money', unit: 'CHF ' },
      { key: 'equity', label: 'Equity', kind: 'money', unit: 'CHF ' },
    ],
    check: (e) => {
      if (e.pension_professional_treasury) return { pass: true, reason: 'Pension scheme with professional treasury: per-se professional (FinSA Art. 4(3)).' };
      const hits = [n(e.balance_sheet) >= 20_000_000, n(e.turnover) >= 40_000_000, n(e.equity) >= 2_000_000];
      return twoOfThree(hits)
        ? { pass: true, reason: `Large company meeting ${hits.filter(Boolean).length} of 3 FinSA size tests.` }
        : { pass: false, reason: 'Needs 2 of 3: CHF 20M balance sheet, CHF 40M turnover, CHF 2M equity, or a pension scheme with professional treasury.' };
    },
  },
  {
    code: 'DIFC_PRO', subject: 'entity',
    fields: [{ key: 'own_funds', label: 'Own funds', kind: 'money', unit: 'US$' }],
    check: (e) => n(e.own_funds) >= 1_000_000
      ? { pass: true, reason: `Own funds of ${fmt(n(e.own_funds), 'US$')} meet the assessed undertaking test (DFSA COB 2.3).` }
      : { pass: false, reason: 'An assessed undertaking needs own funds of at least US$1M.' },
  },
  {
    code: 'DIFC_PRO', subject: 'individual',
    fields: [{ key: 'net_assets', label: 'Net assets', kind: 'money', unit: 'US$' }, { key: 'experience', label: 'Has sufficient experience and understanding', kind: 'bool' }],
    check: (e) => n(e.net_assets) >= 1_000_000 && e.experience
      ? { pass: true, reason: 'Net assets of at least US$1M plus experience (DFSA COB 2.3).' }
      : { pass: false, reason: 'Needs net assets of at least US$1M and sufficient experience.' },
  },
  {
    code: 'US_AI', subject: 'individual',
    fields: [{ key: 'net_worth', label: 'Net worth excluding primary residence', kind: 'money', unit: '$' }, { key: 'income', label: 'Income in each of the last 2 years', kind: 'money', unit: '$' }, { key: 'joint', label: 'Income test is joint with a spouse', kind: 'bool' }],
    check: (e) => {
      if (n(e.net_worth) > 1_000_000) return { pass: true, reason: 'Net worth over $1M excluding primary residence (Rule 501(a)(5)).' };
      const bar = e.joint ? 300_000 : 200_000;
      if (n(e.income) > bar) return { pass: true, reason: `Income over ${fmt(bar, '$')} (Rule 501(a)(6)).` };
      return { pass: false, reason: 'Needs net worth over $1M excluding primary residence, or income over $200K ($300K joint).' };
    },
  },
  {
    code: 'US_AI', subject: 'entity',
    fields: [{ key: 'assets', label: 'Total assets or investments', kind: 'money', unit: '$' }],
    check: (e) => n(e.assets) > 5_000_000
      ? { pass: true, reason: 'Entity with over $5M in assets (Rule 501(a)(3), (7), (9)).' }
      : { pass: false, reason: 'An entity needs more than $5M in assets or investments.' },
  },

  // ---------- United States: qualified purchaser, qualified institutional buyer, institutional accredited investor ----------
  // ICA 2(a)(51)(A): natural persons and family companies with at least $5M in investments; others that own and
  // invest on a discretionary basis at least $25M (for their own account or other qualified purchasers).
  {
    code: 'US_QP', subject: 'individual',
    fields: [{ key: 'investments', label: 'Investments owned (Rule 2a51-1), excluding primary residence', kind: 'money', unit: '$' }],
    check: (e) => n(e.investments) >= 5_000_000
      ? { pass: true, reason: `Investments of ${fmt(n(e.investments), '$')} meet the $5,000,000 qualified purchaser test (ICA 2(a)(51)(A)(i)).` }
      : { pass: false, reason: `Investments of ${fmt(n(e.investments), '$')} are below the $5,000,000 qualified purchaser test (ICA 2(a)(51)(A)(i)).` },
  },
  {
    code: 'US_QP', subject: 'entity',
    fields: [
      { key: 'family_company', label: 'Company owned by two or more related natural persons, their estates or foundations (family company)', kind: 'bool' },
      { key: 'investments', label: 'Investments owned, or owned and invested on a discretionary basis', kind: 'money', unit: '$' },
      { key: 'all_owners_qp', label: 'Every beneficial owner of the entity is itself a qualified purchaser', kind: 'bool' },
    ],
    check: (e) => {
      if (e.all_owners_qp) return { pass: true, reason: 'Entity owned entirely by qualified purchasers (ICA 2(a)(51)(A)(iv) and Rule 2a51-3).' };
      if (e.family_company) {
        return n(e.investments) >= 5_000_000
          ? { pass: true, reason: `Family company with investments of ${fmt(n(e.investments), '$')}, at least $5,000,000 (ICA 2(a)(51)(A)(ii)).` }
          : { pass: false, reason: `A family company needs at least $5,000,000 in investments; it has ${fmt(n(e.investments), '$')} (ICA 2(a)(51)(A)(ii)).` };
      }
      return n(e.investments) >= 25_000_000
        ? { pass: true, reason: `Owns and invests on a discretionary basis ${fmt(n(e.investments), '$')}, at least $25,000,000 (ICA 2(a)(51)(A)(iv)).` }
        : { pass: false, reason: `An entity that is not a family company needs at least $25,000,000 owned and invested on a discretionary basis; it has ${fmt(n(e.investments), '$')} (ICA 2(a)(51)(A)(iv)).` };
    },
  },
  // Rule 144A(a)(1): institutions owning and investing on a discretionary basis at least $100M in securities of
  // unaffiliated issuers; registered dealers at $10M; banks also need $25M audited net worth.
  {
    code: 'US_QIB', subject: 'entity',
    fields: [
      { key: 'securities', label: 'Securities of unaffiliated issuers owned and invested on a discretionary basis', kind: 'money', unit: '$' },
      { key: 'registered_dealer', label: 'Dealer registered under Exchange Act s15', kind: 'bool' },
      { key: 'bank', label: 'Bank or savings and loan association', kind: 'bool' },
      { key: 'net_worth', label: 'Audited net worth (banks only)', kind: 'money', unit: '$' },
      { key: 'all_owners_qib', label: 'Every equity owner is itself a qualified institutional buyer', kind: 'bool' },
    ],
    check: (e) => {
      if (e.all_owners_qib) return { pass: true, reason: 'Entity whose equity owners are all qualified institutional buyers (Rule 144A(a)(1)(v)).' };
      if (e.registered_dealer) {
        return n(e.securities) >= 10_000_000
          ? { pass: true, reason: `Registered dealer with ${fmt(n(e.securities), '$')} in securities, at least $10,000,000 (Rule 144A(a)(1)(ii)).` }
          : { pass: false, reason: `A registered dealer needs at least $10,000,000 in securities; it has ${fmt(n(e.securities), '$')} (Rule 144A(a)(1)(ii)).` };
      }
      if (n(e.securities) < 100_000_000) return { pass: false, reason: `Securities of ${fmt(n(e.securities), '$')} are below the $100,000,000 qualified institutional buyer test (Rule 144A(a)(1)(i)).` };
      if (e.bank && n(e.net_worth) < 25_000_000) return { pass: false, reason: `Meets the $100,000,000 securities test, but a bank also needs an audited net worth of at least $25,000,000; it has ${fmt(n(e.net_worth), '$')} (Rule 144A(a)(1)(vi)).` };
      return { pass: true, reason: `Owns and invests on a discretionary basis ${fmt(n(e.securities), '$')} in securities, at least $100,000,000 (Rule 144A(a)(1)(i))${e.bank ? `, with audited net worth of ${fmt(n(e.net_worth), '$')}` : ''}.` };
    },
  },
  // Rule 501(a)(1), (2), (3), (7): institutional accredited investors. Entity categories only; individuals use US_AI.
  {
    code: 'US_IAI', subject: 'entity',
    fields: [
      { key: 'regulated_institution', label: 'Bank, savings and loan, registered broker-dealer or investment adviser, insurance company, registered investment company, BDC, SBIC or plan listed in Rule 501(a)(1)', kind: 'bool' },
      { key: 'private_bdc', label: 'Private business development company (Advisers Act 202(a)(22))', kind: 'bool' },
      { key: 'total_assets', label: 'Total assets of a 501(c)(3) organization, corporation, partnership, LLC or business trust not formed for this investment', kind: 'money', unit: '$' },
      { key: 'trust_assets', label: 'Total assets of a trust not formed for this investment, directed by a sophisticated person', kind: 'money', unit: '$' },
    ],
    check: (e) => {
      if (e.regulated_institution) return { pass: true, reason: 'Institution listed in Rule 501(a)(1).' };
      if (e.private_bdc) return { pass: true, reason: 'Private business development company (Rule 501(a)(2)).' };
      if (n(e.total_assets) > 5_000_000) return { pass: true, reason: `Organization with total assets of ${fmt(n(e.total_assets), '$')}, over $5,000,000 (Rule 501(a)(3)).` };
      if (n(e.trust_assets) > 5_000_000) return { pass: true, reason: `Trust with total assets of ${fmt(n(e.trust_assets), '$')}, over $5,000,000, directed by a sophisticated person (Rule 501(a)(7)).` };
      return { pass: false, reason: 'Needs a Rule 501(a)(1) institution, a private BDC (501(a)(2)), or total assets over $5,000,000 as an organization (501(a)(3)) or trust (501(a)(7)).' };
    },
  },

  // ---------- India (SEBI accredited investor framework, circular of Aug 26, 2021, now Chapter 12 of the AIF Master Circular of May 7, 2024) ----------
  {
    code: 'IN_AI', subject: 'individual',
    fields: [
      { key: 'annual_income', label: 'Annual income in the preceding financial year', kind: 'money', unit: 'INR ' },
      { key: 'net_worth', label: 'Net worth (primary residence excluded)', kind: 'money', unit: 'INR ' },
      { key: 'financial_assets', label: 'Financial assets within net worth', kind: 'money', unit: 'INR ' },
    ],
    check: (e) => {
      const crore = 10_000_000;
      const inc = n(e.annual_income); const nw = n(e.net_worth); const fa = n(e.financial_assets);
      if (inc >= 2 * crore) return { pass: true, reason: `Annual income of ${fmt(inc, 'INR ')}, at least INR 2 crore.` };
      if (nw >= 7.5 * crore && fa >= 3.75 * crore) return { pass: true, reason: `Net worth of ${fmt(nw, 'INR ')} with ${fmt(fa, 'INR ')} in financial assets: at least INR 7.5 crore with half in financial assets.` };
      if (inc >= 1 * crore && nw >= 5 * crore && fa >= 2.5 * crore) return { pass: true, reason: `Annual income of ${fmt(inc, 'INR ')} with net worth of ${fmt(nw, 'INR ')} (${fmt(fa, 'INR ')} financial): the combined INR 1 crore plus INR 5 crore route.` };
      return { pass: false, reason: 'None of the three routes is met: annual income of at least INR 2 crore; net worth of at least INR 7.5 crore with INR 3.75 crore in financial assets; or income of at least INR 1 crore plus net worth of at least INR 5 crore with half in financial assets.' };
    },
  },
  {
    code: 'IN_AI', subject: 'entity',
    fields: [
      { key: 'net_worth', label: 'Net worth of the body corporate or trust', kind: 'money', unit: 'INR ' },
      { key: 'all_partners_ai', label: 'Partnership firm: every partner independently meets the individual criteria', kind: 'bool' },
      { key: 'deemed', label: 'Deemed accredited: government, developmental agency, QIB, Category I FPI, sovereign wealth fund or multilateral agency', kind: 'bool' },
    ],
    check: (e) => {
      if (e.deemed) return { pass: true, reason: 'Deemed accredited investor under the SEBI framework.' };
      if (e.all_partners_ai) return { pass: true, reason: 'Partnership firm whose partners each meet the individual accredited investor criteria.' };
      return n(e.net_worth) >= 500_000_000
        ? { pass: true, reason: `Net worth of ${fmt(n(e.net_worth), 'INR ')}, at least INR 50 crore.` }
        : { pass: false, reason: `Net worth of ${fmt(n(e.net_worth), 'INR ')} is below the INR 50 crore test for a body corporate or trust.` };
    },
  },
  // RBI Liberalised Remittance Scheme: resident individuals only, USD 250,000 per financial year (April to March) across
  // all current and capital account remittances. The remitted figure is recorded so the engine can test each order against the ceiling.
  {
    code: 'IN_LRS', subject: 'individual',
    fields: [
      { key: 'resident_individual', label: 'Resident individual under FEMA (the LRS is not available to companies, firms, HUFs or trusts)', kind: 'bool' },
      { key: 'pan', label: 'PAN furnished to the authorised dealer bank', kind: 'bool' },
      { key: 'remitted_this_fy_usd', label: 'Remitted under the LRS so far this financial year (April to March)', kind: 'money', unit: 'US$' },
    ],
    check: (e) => {
      if (!e.resident_individual) return { pass: false, reason: 'The LRS is available only to resident individuals (RBI Master Direction No. 7/2015-16).' };
      if (!e.pan) return { pass: false, reason: 'A PAN is mandatory for every LRS remittance (RBI Master Direction No. 7/2015-16).' };
      const r = n(e.remitted_this_fy_usd);
      if (r >= 250_000) return { pass: false, reason: `USD ${r.toLocaleString('en-US')} already remitted this financial year: the USD 250,000 allowance is used up until April 1 (remitted_this_fy_usd=${r}).` };
      return { pass: true, reason: `Resident individual with PAN; USD ${r.toLocaleString('en-US')} of the USD 250,000 LRS allowance used this financial year (remitted_this_fy_usd=${r}).` };
    },
  },
  // IFSCA accredited investor (circular F.No. IFSCA-IF-10PR/1/2023-Capital Markets, Jan 25, 2024): individuals on income or net assets; body corporates on net worth.
  {
    code: 'IFSCA_PRO', subject: 'individual',
    fields: [
      { key: 'annual_income', label: 'Annual gross income in the preceding financial year', kind: 'money', unit: 'US$' },
      { key: 'net_assets', label: 'Net assets, primary residence excluded', kind: 'money', unit: 'US$' },
      { key: 'financial_assets', label: 'Financial assets within net assets', kind: 'money', unit: 'US$' },
    ],
    check: (e) => {
      if (n(e.annual_income) >= 200_000) return { pass: true, reason: `Annual gross income of ${fmt(n(e.annual_income), 'US$')}, at least US$200,000 (IFSCA accredited investor).` };
      if (n(e.net_assets) >= 1_000_000 && n(e.financial_assets) >= 500_000) return { pass: true, reason: `Net assets of ${fmt(n(e.net_assets), 'US$')} with ${fmt(n(e.financial_assets), 'US$')} in financial assets: at least US$1,000,000 with US$500,000 financial (IFSCA accredited investor).` };
      return { pass: false, reason: 'Needs annual gross income of at least US$200,000, or net assets of at least US$1,000,000 with at least US$500,000 in financial assets.' };
    },
  },
  {
    code: 'IFSCA_PRO', subject: 'entity',
    fields: [
      { key: 'net_worth', label: 'Net worth of the body corporate, LLP or trust', kind: 'money', unit: 'US$' },
      { key: 'all_owners_ai', label: 'Every shareholder, partner or beneficiary independently qualifies as an accredited investor', kind: 'bool' },
      { key: 'deemed', label: 'Deemed accredited: government entity, multilateral agency, pension fund, licensed financial institution or regulated fund', kind: 'bool' },
    ],
    check: (e) => {
      if (e.deemed) return { pass: true, reason: 'Deemed accredited investor under the IFSCA circular.' };
      if (e.all_owners_ai) return { pass: true, reason: 'Entity whose constituents each qualify as accredited investors (IFSCA circular).' };
      return n(e.net_worth) >= 5_000_000
        ? { pass: true, reason: `Net worth of ${fmt(n(e.net_worth), 'US$')}, at least US$5,000,000 (IFSCA accredited investor).` }
        : { pass: false, reason: `Net worth of ${fmt(n(e.net_worth), 'US$')} is below the US$5,000,000 test for a body corporate.` };
    },
  },

  // ---------- United Kingdom (FCA COBS 3.5, Handbook text as of Apr 6, 2026) ----------
  // The UK AIFM Regulations 2013 define a professional investor as a professional client
  // under UK MiFIR art. 2(1)(8); COBS 3.5 carries the same tests. Figures stay in EUR for MiFID business.
  {
    code: 'GB_PRO', subject: 'entity',
    fields: [
      { key: 'regulated_entity', label: 'Authorised or regulated financial institution, or other per se category in COBS 3.5.2R(1)', kind: 'bool' },
      { key: 'balance_sheet', label: 'Balance sheet total', kind: 'money', unit: '€' },
      { key: 'net_turnover', label: 'Net turnover', kind: 'money', unit: '€' },
      { key: 'own_funds', label: 'Own funds', kind: 'money', unit: '€' },
    ],
    check: (e) => {
      if (e.regulated_entity) return { pass: true, reason: 'Authorised or regulated entity: per se professional client (COBS 3.5.2R(1)).' };
      const hits = [n(e.balance_sheet) >= 20_000_000, n(e.net_turnover) >= 40_000_000, n(e.own_funds) >= 2_000_000];
      return twoOfThree(hits)
        ? { pass: true, reason: `Large undertaking meeting ${hits.filter(Boolean).length} of 3 size tests (COBS 3.5.2R(2)).` }
        : { pass: false, reason: `Meets ${hits.filter(Boolean).length} of 3 size tests; 2 are required: EUR 20M balance sheet, EUR 40M net turnover, EUR 2M own funds (COBS 3.5.2R(2)).` };
    },
  },
  ...(['individual', 'entity'] as const).map((subject): Test => ({
    code: 'GB_EPRO', subject,
    fields: [
      { key: 'qualitative', label: 'Firm has assessed the client’s expertise, experience and knowledge (qualitative test)', kind: 'bool' },
      { key: 'frequent_trading', label: 'Significant transactions averaging 10 per quarter over the last four quarters', kind: 'bool' },
      { key: 'portfolio', label: 'Financial instrument portfolio, including cash deposits', kind: 'money', unit: '€' },
      { key: 'finance_role', label: 'At least one year in a professional position in the financial sector', kind: 'bool' },
      { key: 'opt_in', label: 'Client asked in writing, received the written warning, and confirmed in a separate document', kind: 'bool' },
    ],
    check: (e) => {
      if (!e.qualitative) return { pass: false, reason: 'The qualitative assessment of expertise, experience and knowledge is required first (COBS 3.5.3R(1)).' };
      const routes = [
        e.frequent_trading && '10 significant trades per quarter',
        n(e.portfolio) > 500_000 && `a portfolio of ${fmt(n(e.portfolio), '€')}, over EUR 500,000`,
        e.finance_role && 'a year in a professional finance role',
      ].filter(Boolean);
      if (routes.length < 2) return { pass: false, reason: `Meets ${routes.length} of 3 quantitative criteria; 2 are required: 10 significant trades per quarter over four quarters, a portfolio over EUR 500,000, one year in a professional finance role (COBS 3.5.3R(2)).` };
      if (!e.opt_in) return { pass: false, reason: 'Qualifies on the tests, but the client has not opted up. COBS 3.5.3R(3) needs a written request, a written warning and a separate written confirmation.' };
      return { pass: true, reason: `Elective professional client on ${routes.join(' and ')}; written opt-up recorded (COBS 3.5.3R).` };
    },
  })),

  // ---------- Japan (Definitions Ordinance under FIEA Art. 2, Art. 10) ----------
  {
    code: 'JP_QII', subject: 'individual',
    fields: [
      { key: 'securities_balance', label: 'Securities held', kind: 'money', unit: '¥' },
      { key: 'account_one_year', label: 'Securities account opened at least one year ago', kind: 'bool' },
      { key: 'fsa_notification', label: 'QII notification filed with the FSA Commissioner and in effect', kind: 'bool' },
    ],
    check: (e) => {
      if (n(e.securities_balance) < 1_000_000_000) return { pass: false, reason: `Securities of ${fmt(n(e.securities_balance), '¥')} are below the JPY 1 billion test (Definitions Ordinance Art. 10(1)(xxiv)).` };
      if (!e.account_one_year) return { pass: false, reason: 'The securities account must have been open for at least one year (Art. 10(1)(xxiv)).' };
      if (!e.fsa_notification) return { pass: false, reason: 'Meets the JPY 1 billion test, but an individual is a QII only after notifying the FSA. Status runs two years from the first day of the second month after filing.' };
      return { pass: true, reason: `Securities of ${fmt(n(e.securities_balance), '¥')}, account open over a year, and FSA notification in effect (Art. 10(1)(xxiv)).` };
    },
  },
  {
    code: 'JP_QII', subject: 'entity',
    fields: [
      { key: 'listed_institution', label: 'Financial institution listed in Art. 10(1), such as a bank, insurer or registered securities firm', kind: 'bool' },
      { key: 'securities_balance', label: 'Securities held', kind: 'money', unit: '¥' },
      { key: 'fsa_notification', label: 'QII notification filed with the FSA Commissioner and in effect', kind: 'bool' },
    ],
    check: (e) => {
      if (e.listed_institution) return { pass: true, reason: 'Financial institution listed as a qualified institutional investor (Definitions Ordinance Art. 10(1)).' };
      if (n(e.securities_balance) < 1_000_000_000) return { pass: false, reason: `Securities of ${fmt(n(e.securities_balance), '¥')} are below the JPY 1 billion test (Art. 10(1)(xxiii)).` };
      if (!e.fsa_notification) return { pass: false, reason: 'Meets the JPY 1 billion test, but a corporation is a QII only after notifying the FSA (Art. 10(1)(xxiii)).' };
      return { pass: true, reason: `Corporation with securities of ${fmt(n(e.securities_balance), '¥')} and an FSA notification in effect (Art. 10(1)(xxiii)).` };
    },
  },

  // ---------- Abu Dhabi Global Market (FSRA COBS 2.4) ----------
  {
    code: 'ADGM_PRO', subject: 'individual',
    fields: [
      { key: 'net_assets', label: 'Net assets, excluding primary residence', kind: 'money', unit: 'US$' },
      { key: 'experience', label: 'Has sufficient knowledge and experience of the relevant markets and risks (COBS 2.6.2)', kind: 'bool' },
    ],
    check: (e) => {
      if (n(e.net_assets) < 1_000_000) return { pass: false, reason: `Net assets of ${fmt(n(e.net_assets), 'US$')} are below the US$1,000,000 assessed professional client test (FSRA COBS 2.4.4).` };
      if (!e.experience) return { pass: false, reason: 'Meets the net assets test, but the firm must also find sufficient knowledge and experience (FSRA COBS 2.6.2).' };
      return { pass: true, reason: `Assessed professional client: net assets of ${fmt(n(e.net_assets), 'US$')} plus experience (FSRA COBS 2.4.4).` };
    },
  },
  {
    code: 'ADGM_PRO', subject: 'entity',
    fields: [
      { key: 'regulated_entity', label: 'Authorised person, regulated financial institution or other deemed professional client', kind: 'bool' },
      { key: 'balance_sheet', label: 'Balance sheet total', kind: 'money', unit: 'US$' },
      { key: 'net_turnover', label: 'Net annual turnover', kind: 'money', unit: 'US$' },
      { key: 'own_funds', label: 'Own funds or called-up capital', kind: 'money', unit: 'US$' },
      { key: 'experience', label: 'Has sufficient knowledge and experience of the relevant markets and risks (COBS 2.6.2)', kind: 'bool' },
    ],
    check: (e) => {
      if (e.regulated_entity) return { pass: true, reason: 'Deemed professional client (FSRA COBS 2.4.2).' };
      const hits = [n(e.balance_sheet) >= 20_000_000, n(e.net_turnover) >= 40_000_000, n(e.own_funds) >= 2_000_000];
      if (twoOfThree(hits)) return { pass: true, reason: `Deemed professional client: large undertaking meeting ${hits.filter(Boolean).length} of 3 size tests (FSRA COBS 2.4.2).` };
      if (n(e.own_funds) >= 1_000_000 && e.experience) return { pass: true, reason: `Assessed professional client: own funds of ${fmt(n(e.own_funds), 'US$')} plus experience (FSRA COBS 2.4.4).` };
      return { pass: false, reason: 'Needs 2 of 3 (US$20M balance sheet, US$40M turnover, US$2M own funds), or own funds of at least US$1M plus sufficient experience (FSRA COBS 2.4.2, 2.4.4).' };
    },
  },
];

export const subjectOf = (kind: string): 'individual' | 'entity' => (kind.toLowerCase() === 'individual' ? 'individual' : 'entity');
export const findTest = (code: string, kind: string) => TESTS.find((t) => t.code === code && t.subject === subjectOf(kind));
