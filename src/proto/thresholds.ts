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
