// Extra seed rows: fund lifecycle terms, NAV history, accruals and past distributions,
// fictional fund documents with acknowledgments, and one pending redemption notice.
// Every date is computed from T, the seed's "today" (the demo's Oct 1, 2026 shifted to the real date),
// so a new sandbox always shows the same picture as the demo.
import { investors, SIM_DATE } from '../../src/proto/data';
import { addDays } from './util';
import { simulateNav, nextDealingDate, firstDayOfMonth, lastDayOfMonth, type SimFund } from './fundops-core';

type Q = { text: string; params: unknown[] };
// Local copy of seed.ts multi(): importing it would be circular (seed.ts imports this file).
function multi(table: string, cols: string[], rows: unknown[][], suffix = ''): Q {
  const params: unknown[] = [];
  const values = rows.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`).join(', ');
  return { text: `insert into ${table} (${cols.join(', ')}) values ${values}${suffix}`, params };
}

// ---------- Fund terms ----------
type Terms = SimFund & { shareClassType: 'distributing' | 'accumulating'; dealingFrequency: 'daily' | 'monthly' | 'quarterly'; cutoffTime: string; cutoffTz: string; noticeDays: number; gatePct: number | null; yieldBps: number };
export const SEED_TERMS: Record<'TWLF' | 'NMEL' | 'AGPC', Terms> = {
  TWLF: { ticker: 'TWLF', nav: 1.0, shareClassType: 'distributing', dealingFrequency: 'daily', cutoffTime: '16:00', cutoffTz: 'America/New_York', noticeDays: 0, gatePct: null, yieldBps: 390 },
  NMEL: { ticker: 'NMEL', nav: 1.0, shareClassType: 'accumulating', dealingFrequency: 'daily', cutoffTime: '13:00', cutoffTz: 'Europe/Dublin', noticeDays: 0, gatePct: null, yieldBps: 195 },
  AGPC: { ticker: 'AGPC', nav: 1.0412, shareClassType: 'distributing', dealingFrequency: 'quarterly', cutoffTime: '17:00', cutoffTz: 'America/New_York', noticeDays: 90, gatePct: 5, yieldBps: 920 },
};

// ---------- Synchronous SHA-256 (seedExtras is synchronous; output matches util.sha256) ----------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const len = msg.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ---------- Fictional fund documents ----------
type DocDef = { id: string; ticker: string; docType: string; title: string; jurisdiction: string | null; audience: 'all' | 'retail' | 'professional'; required: boolean; published: string; publishedBy: string; content: string };
const FICTION = 'Fictional document for the Laissez sandbox. It describes no real fund and is not an offer to sell or a solicitation to buy any security.';

const DOCS: DocDef[] = [
  {
    id: 'doc_twlf_om_v1', ticker: 'TWLF', docType: 'offering_memorandum', title: 'Offering memorandum', jurisdiction: null, audience: 'professional', required: true,
    published: '2025-10-01', publishedBy: 'Tidewell Asset Management (fictional)',
    content: `# Tidewell Treasury Liquidity Fund, Tokenized Class T
## Offering memorandum, version 1

> ${FICTION}

Investment manager: Tidewell Asset Management (fictional). Domicile: British Virgin Islands, professional fund.

### Summary of terms
| Term | Detail |
|---|---|
| Fund type | Open-ended money market fund |
| Share class | Tokenized Class T, distributing, stable NAV targeted at US$1.0000 |
| Objective | Preserve capital and daily liquidity while earning a return in line with 3-month U.S. Treasury bills |
| Portfolio | U.S. Treasury bills and overnight repo collateralized by Treasuries. Weighted average maturity of 60 days or less |
| Minimum subscription | US$100,000 |
| Dealing | Every business day. Cut-off 16:00 New York time |
| Settlement | USDC or AVB-USD on Ethereum or Base, on the dealing date |
| Income | Accrues daily, paid monthly and reinvested in units |
| Fees | Management fee 0.15% a year. No subscription or redemption charge |

### Eligibility
Units are offered only to professional investors outside the United States, in reliance on Regulation S. Each holder must hold a current eligibility credential showing the investor classification required in its country of residence and at its booking center. U.S. persons may not subscribe or receive units by transfer.

### Transfer restrictions
Units are recorded on a permissioned token register. A transfer settles only if the receiving wallet belongs to an eligible investor who has acknowledged the current offering documents. A transfer that fails any check does not settle.

### Principal risks
- **Stable NAV is a target, not a guarantee.** A sharp rise in Treasury yields or the failure of a repo counterparty can reduce the value of units.
- **Settlement asset risk.** A stablecoin or tokenized deposit can lose its peg or be frozen by its issuer.
- **Technology risk.** Errors in token contracts, key management or chain operations can delay or prevent settlement.
- **Regulatory risk.** Changes in law can restrict who may hold, buy or receive units.

### Redemptions
Holders may redeem on any dealing day. Holders whose eligibility lapses may keep and redeem their units but may not add to them. The directors may suspend dealing only in the circumstances set out in the articles.`,
  },
  {
    id: 'doc_twlf_sg_v1', ticker: 'TWLF', docType: 'supplement', title: 'Singapore information memorandum supplement', jurisdiction: 'SG', audience: 'all', required: true,
    published: '2025-10-01', publishedBy: 'Tidewell Asset Management (fictional)',
    content: `# Singapore supplement
## Tidewell Treasury Liquidity Fund, Tokenized Class T, version 1

> ${FICTION}

This supplement forms part of the offering memorandum and must be read with it.

### Restricted scheme
The fund is not authorised or recognised by the Monetary Authority of Singapore (MAS), and units may not be offered to the retail public in Singapore. The fund is notified to MAS as a restricted scheme under section 305 of the Securities and Futures Act 2001 (SFA).

### Who may invest
Units may be offered in Singapore only to:
- institutional investors, under section 304 of the SFA; and
- accredited investors, under section 305 of the SFA, who have opted in to be treated as accredited investors under section 4A.

An investor who has not opted in, or who has withdrawn its opt-in, may not subscribe. A holder whose status lapses may continue to redeem.

### Resale restrictions
Units acquired under section 305 are subject to the transfer restrictions in section 305A of the SFA. The token register accepts a transfer only to an institutional or accredited investor with a current credential.

### Status of this document
This document is an information memorandum and is not a prospectus as defined in the SFA. It has not been registered as a prospectus with MAS. Accordingly, statutory liability under the SFA in relation to the content of prospectuses does not apply.

### Acknowledgment
By acknowledging this supplement, the investor confirms that it is an institutional investor or an accredited investor that has opted in, and that it will tell its distributor promptly if that status changes.`,
  },
  {
    id: 'doc_twlf_sub_v1', ticker: 'TWLF', docType: 'subscription_agreement', title: 'Subscription agreement', jurisdiction: null, audience: 'all', required: true,
    published: '2025-10-01', publishedBy: 'Tidewell Asset Management (fictional)',
    content: `# Subscription agreement
## Tidewell Treasury Liquidity Fund, Tokenized Class T, version 1

> ${FICTION}

Between the fund and the subscriber named in each order.

### 1. Subscription
The subscriber applies for units at the NAV per unit on the dealing date. Orders received before 16:00 New York time on a business day deal that day. Later orders deal on the next business day. The fund may reject any subscription in whole or in part.

### 2. Payment and settlement
The subscriber pays in USDC or AVB-USD. Cash and units settle in a single atomic transaction. If either leg fails, neither moves.

### 3. Representations
The subscriber represents that:
1. it is not a U.S. person and is not acting for the account of a U.S. person;
2. it holds the investor classification the fund requires in its country of residence and at its booking center;
3. it has received, read and acknowledged the current offering memorandum and any supplement for its country;
4. its subscription money is not derived from criminal activity and is not owned or controlled by a sanctioned person.

### 4. Ongoing obligations
The subscriber will notify its distributor within 30 days of any change to its residence, U.S. person status or investor classification. If its status lapses it may keep and redeem its units but may not add to them.

### 5. Personal data
The distributor holds the subscriber's identity data. Only a signed decision hash and the subscriber's wallet address are written on chain.

### 6. Governing law
This agreement is governed by the laws of the British Virgin Islands.`,
  },
  {
    id: 'doc_twlf_fact_v1', ticker: 'TWLF', docType: 'factsheet', title: 'Monthly factsheet', jurisdiction: null, audience: 'all', required: false,
    published: '2026-09-01', publishedBy: 'Tidewell Asset Management (fictional)',
    content: `# Monthly factsheet
## Tidewell Treasury Liquidity Fund, Tokenized Class T, version 1

> ${FICTION} For information only. No acknowledgment is required.

### Key facts
| Measure | Value |
|---|---|
| Share class | Class T, distributing, stable NAV |
| Base currency | USD |
| 7-day yield | 3.90% annualized, before fees |
| Weighted average maturity | 41 days |
| Weighted average life | 44 days |
| Holders of record | 214 |
| Management fee | 0.15% a year |

### Portfolio
- U.S. Treasury bills: 82%
- Overnight repo collateralized by Treasuries: 15%
- Cash at the custodian: 3%

### Liquidity
At month end, 21% of assets matured or could be sold within one business day, and 48% within five business days.

Past performance does not predict future returns.`,
  },
  {
    id: 'doc_nmel_prospectus_v1', ticker: 'NMEL', docType: 'prospectus', title: 'Prospectus', jurisdiction: null, audience: 'all', required: true,
    published: '2024-10-01', publishedBy: 'Northmere Investors (fictional)',
    content: `# Northmere Euro Liquidity UCITS
## Prospectus extract for Tokenized Class TK, version 1

> ${FICTION}

Management company: Northmere Investors (fictional). The fund is a sub-fund of an Irish UCITS umbrella company.

### Summary of terms
| Term | Detail |
|---|---|
| Fund type | Low-volatility NAV money market fund under Regulation (EU) 2017/1131 |
| Share class | Tokenized Class TK, accumulating. Income is retained and reflected in the NAV |
| Objective | Preserve capital and provide a return in line with euro short-term rates |
| Portfolio | Euro money market instruments, deposits and reverse repo. Weighted average maturity of 60 days or less, weighted average life of 120 days or less |
| Minimum subscription | EUR 10,000 |
| Dealing | Every business day. Cut-off 13:00 Dublin time |
| Settlement | EURC or AVB-EUR on Ethereum |
| Ongoing charges | 0.10% a year |

### Eligibility
The class is registered for sale to retail and professional clients in Germany. It is offered only to professional or accredited investors in Switzerland, Singapore and Hong Kong. It is not offered to U.S. persons. A retail client in the EEA must receive the key information document before subscribing.

### Valuation
The class is valued every business day. Because income accumulates, the NAV per unit rises over time in line with the fund's net yield. It can fall if yields turn negative or an issuer defaults.

### Liquidity management
Where weekly liquid assets fall below 30% of the fund, the board may apply liquidity fees, redemption gates or a suspension, as Article 34 of the Money Market Funds Regulation provides.

### Principal risks
- **Interest rate risk.** Rising rates reduce the value of fixed-rate instruments held.
- **Credit risk.** An issuer or deposit bank can fail to repay.
- **Negative yield risk.** If euro rates turn negative, the NAV per unit can fall.
- **Settlement asset and technology risk.** E-money tokens, tokenized deposits and token contracts can fail or be frozen.

### Transfer restrictions
Units are held on a permissioned register. Transfers settle only to investors who are eligible in their country and have acknowledged the current documents.`,
  },
  {
    id: 'doc_nmel_kid_de_v1', ticker: 'NMEL', docType: 'kid', title: 'PRIIPs key information document (Germany)', jurisdiction: 'DE', audience: 'retail', required: true,
    published: '2024-10-01', publishedBy: 'Northmere Investors (fictional)',
    content: `# Key information document
## Northmere Euro Liquidity UCITS, Tokenized Class TK, version 1

> ${FICTION} It follows the structure of a PRIIPs key information document.

### Purpose
This document gives you key information about this investment product. It is not marketing material. The information is required by law to help you understand the nature, risks, costs, potential gains and losses of this product and to help you compare it with other products.

### Product
Northmere Euro Liquidity UCITS, Tokenized Class TK. Manufacturer: Northmere Investors (fictional).

### What is this product?
A UCITS money market fund that invests in short-term euro instruments. The class accumulates income, so the price per unit rises over time. It is intended for investors who want to preserve capital over a short horizon and can bear small losses.

### What are the risks and what could I get in return?
Summary risk indicator: **1 on a scale of 1 to 7**, the lowest risk class. Recommended holding period: 1 month.

| Scenario, EUR 10,000 invested for 1 month | Value at the end |
|---|---|
| Stress | EUR 9,985 |
| Unfavourable | EUR 10,008 |
| Moderate | EUR 10,016 |
| Favourable | EUR 10,019 |

### What happens if the manufacturer is unable to pay out?
The fund's assets are held by a depositary, separately from the manufacturer. No compensation or guarantee scheme covers this product.

### What are the costs?
No entry or exit costs. Ongoing costs of 0.10% a year and transaction costs of 0.01% a year.

### How long should I hold it and can I take money out early?
You can redeem on any business day before 13:00 Dublin time, without penalty.

### How can I complain?
Contact your distributor first, then the manufacturer in writing.`,
  },
  {
    id: 'doc_nmel_sub_v1', ticker: 'NMEL', docType: 'subscription_agreement', title: 'Subscription agreement', jurisdiction: null, audience: 'all', required: true,
    published: '2024-10-01', publishedBy: 'Northmere Investors (fictional)',
    content: `# Subscription agreement
## Northmere Euro Liquidity UCITS, Tokenized Class TK, version 1

> ${FICTION}

Between the fund and the subscriber named in each order.

### 1. Subscription
The subscriber applies for units at the NAV per unit on the dealing date. Orders received before 13:00 Dublin time on a business day deal that day. Later orders deal on the next business day.

### 2. Payment and settlement
The subscriber pays in EURC or AVB-EUR. Cash and units settle atomically, so either both legs complete or neither does.

### 3. Representations
The subscriber represents that:
1. it is not a U.S. person;
2. it is permitted to buy the class in its country of residence, as a retail client where the class is registered for retail sale, or otherwise as a professional or accredited investor;
3. if it is a retail client in the EEA, it received the key information document before subscribing;
4. it has received and acknowledged the current prospectus;
5. its subscription money is not derived from criminal activity and is not owned or controlled by a sanctioned person.

### 4. Accumulating class
The subscriber understands that the class pays no distributions. Income is retained in the fund and reflected in the NAV.

### 5. Ongoing obligations
The subscriber will tell its distributor within 30 days of any change to its residence or investor classification.

### 6. Governing law
This agreement is governed by the laws of Ireland.`,
  },
  {
    id: 'doc_agpc_ppm_v1', ticker: 'AGPC', docType: 'private_placement_memorandum', title: 'Private placement memorandum', jurisdiction: null, audience: 'all', required: true,
    published: '2025-03-03', publishedBy: 'Ashgrove Credit Partners (fictional)',
    content: `# Ashgrove Private Credit Fund LP
## Confidential private placement memorandum, Tokenized Interests, version 1

> ${FICTION}

General partner: Ashgrove Credit GP LLC (fictional). Investment manager: Ashgrove Credit Partners (fictional).

### Summary of terms
| Term | Detail |
|---|---|
| Structure | Delaware limited partnership relying on Section 3(c)(1) of the Investment Company Act of 1940 |
| Strategy | Senior secured, floating-rate loans to U.S. middle-market companies, mostly first lien |
| Target distribution | 9.2% a year from net investment income, accrued daily |
| Minimum commitment | US$250,000 |
| Valuation | Monthly NAV, struck on the last business day of each month |
| Dealing | Quarterly, on the last business day of each quarter. Cut-off 17:00 New York time |
| Redemption notice | 90 days' notice before the dealing date |
| Redemption gate | 5% of net assets per quarter. Requests above the gate are reduced pro rata and carried forward |
| Lock-up | 12 months from each subscription |
| Fees | Management fee 1.25% a year. Incentive fee 12.5% of income above a 6% hurdle |
| Holder limit | No more than 100 beneficial owners |

### Eligibility
In the United States, interests are offered under Rule 506(c) of Regulation D to verified accredited investors only. Outside the United States, interests are offered under Regulation S to professional investors as the law of each country permits.

### Principal risks
- **Illiquidity.** Loans are not traded on an exchange. Notice periods and the gate mean you may not exit when you want.
- **Credit risk.** Borrowers can default, and recoveries can take years.
- **Valuation risk.** Monthly NAVs rely on models and broker quotes and may differ from the price a loan would fetch in a sale.
- **Concentration risk.** The portfolio holds a limited number of loans.
- **Holder cap.** A new investor cannot be admitted once the fund has 100 beneficial owners.

### Transfer restrictions
Interests are restricted securities. Transfers need the general partner's consent, given through the token register only when the transferee passes eligibility checks and the transfer keeps the fund within the holder limit.`,
  },
  {
    id: 'doc_agpc_us_v1', ticker: 'AGPC', docType: 'supplement', title: 'U.S. investor supplement', jurisdiction: 'US', audience: 'all', required: true,
    published: '2025-03-03', publishedBy: 'Ashgrove Credit Partners (fictional)',
    content: `# U.S. investor supplement
## Ashgrove Private Credit Fund LP, Tokenized Interests, version 1

> ${FICTION}

This supplement forms part of the private placement memorandum and must be read with it.

### Offering exemption
Interests are offered in the United States under Rule 506(c) of Regulation D. Because general solicitation may be used, the fund must take reasonable steps to verify that every purchaser is an accredited investor under Rule 501(a).

### Verification
Verification relies on one of the following: tax returns showing income above US$200,000, or US$300,000 jointly, in each of the last two years; a statement of assets and liabilities showing net worth above US$1 million excluding the primary residence; or a written confirmation from a registered broker-dealer, investment adviser, attorney or CPA dated within the last three months. Laissez credentials record the basis and expire after 12 months. A lapsed verification blocks new subscriptions but never blocks a redemption.

### Restricted securities
Interests have not been registered under the Securities Act of 1933 or any state securities law. They cannot be resold unless registered or exempt from registration.

### Benefit plan investors
The general partner intends to keep investment by benefit plan investors below 25% of each class of interests, so that fund assets are not treated as plan assets under ERISA.

### Tax
The fund is treated as a partnership for U.S. federal income tax purposes. Each holder receives a Schedule K-1 every year and may be taxed on income allocated to it whether or not that income is distributed.

### Acknowledgment
By acknowledging this supplement, the investor confirms that it is an accredited investor and that its verification evidence is accurate.`,
  },
  {
    id: 'doc_agpc_sub_v1', ticker: 'AGPC', docType: 'subscription_agreement', title: 'Subscription agreement', jurisdiction: null, audience: 'all', required: true,
    published: '2025-03-03', publishedBy: 'Ashgrove Credit Partners (fictional)',
    content: `# Subscription agreement
## Ashgrove Private Credit Fund LP, Tokenized Interests, version 1

> ${FICTION}

Between the partnership, its general partner and the subscriber named in each order.

### 1. Subscription
The subscriber applies for interests at the NAV per interest on the next quarterly dealing date. Orders received after 17:00 New York time on a dealing date deal on the following quarter's dealing date. The general partner may reject any subscription.

### 2. Payment and settlement
The subscriber pays in USDC. Cash and interests settle atomically.

### 3. Representations
The subscriber represents that:
1. it is a verified accredited investor if it is a U.S. person, or a professional investor under the law of its country if it is not;
2. it has received and acknowledged the private placement memorandum and any supplement for its country;
3. it can bear the loss of its entire investment and does not need liquidity from it;
4. its subscription money is not derived from criminal activity and is not owned or controlled by a sanctioned person.

### 4. Liquidity terms
The subscriber accepts a 12-month lock-up, 90 days' notice before any redemption, and a gate of 5% of net assets per quarter. Requests above the gate are reduced pro rata and carried to the next quarter.

### 5. Holder limit
The subscriber will not split its interest among beneficial owners in a way that could take the fund above 100 beneficial owners.

### 6. Governing law
This agreement is governed by the laws of the State of Delaware.`,
  },
];

let hashed: (DocDef & { sha256: string })[] | null = null;
/** Seeded documents with their content hashes, computed once on first use. */
export function seedDocs() {
  return (hashed ??= DOCS.map((d) => ({ ...d, sha256: sha256Hex(d.content) })));
}

/** Who acknowledged which seeded document, chosen so the demo scenarios keep their outcomes. Mei Tan has acknowledged nothing. */
const ACKS: Record<string, string[]> = {
  lumen: ['doc_twlf_om_v1', 'doc_twlf_sg_v1', 'doc_twlf_sub_v1', 'doc_agpc_ppm_v1', 'doc_agpc_sub_v1'],
  qamar: ['doc_twlf_om_v1', 'doc_twlf_sub_v1'],
  kestrel: ['doc_nmel_prospectus_v1', 'doc_nmel_kid_de_v1', 'doc_nmel_sub_v1'],
  sorell: ['doc_nmel_prospectus_v1', 'doc_nmel_sub_v1', 'doc_agpc_ppm_v1', 'doc_agpc_sub_v1'],
  reyes: ['doc_agpc_ppm_v1', 'doc_agpc_us_v1', 'doc_agpc_sub_v1'],
};

// ---------- NAV and income ledger ----------
const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** NAV strikes from `from` to `to` for a fund, using the same simulation as the daily job. */
function navSeries(f: Terms, from: string, to: string): { date: string; nav: number; dy: number | null }[] {
  const out: { date: string; nav: number; dy: number | null }[] = [];
  let prev: { date: string; nav: number } | null = null;
  for (let x = from; x <= to; x = addDays(x, 1)) {
    // Accumulating classes use the closed form from their anchor so the seed and the job agree on every date.
    const s = simulateNav(f, x, f.shareClassType === 'accumulating' ? null : prev);
    if (!s) continue;
    out.push({ date: x, nav: s.nav, dy: s.dailyYieldBps });
    prev = { date: x, nav: s.nav };
  }
  return out;
}

export function seedExtras(ws: string, d: (x: string) => string): Q[] {
  const q: Q[] = [];
  const T = d(SIM_DATE);
  const inv = Object.values(investors);

  // NAV history. Daily funds: every business day from the start of the month three months back (about 90 days).
  // AGPC values monthly, so it gets twelve month-end strikes for a readable chart.
  const ledgerStart = firstDayOfMonth(addDays(firstDayOfMonth(T), -80));
  const navs: Record<string, { date: string; nav: number; dy: number | null }[]> = {};
  for (const f of Object.values(SEED_TERMS)) {
    const from = f.dealingFrequency === 'daily' ? ledgerStart : firstDayOfMonth(addDays(firstDayOfMonth(T), -340));
    navs[f.ticker] = navSeries(f, from, T);
  }

  // Fund terms, with funds.nav set to the latest struck NAV.
  for (const f of Object.values(SEED_TERMS)) {
    const latest = navs[f.ticker].at(-1)?.nav ?? f.nav;
    q.push({
      text: `update funds set share_class_type = $3, dealing_frequency = $4, cutoff_time = $5, cutoff_tz = $6, notice_days = $7, gate_pct = $8, yield_bps = $9, nav = $10 where workspace_id = $1 and ticker = $2`,
      params: [ws, f.ticker, f.shareClassType, f.dealingFrequency, f.cutoffTime, f.cutoffTz, f.noticeDays, f.gatePct, f.yieldBps, latest],
    });
  }
  const navRows = Object.entries(navs).flatMap(([t, rows]) => rows.map((r) => [ws, t, r.date, r.nav, r.dy, 'Seeded history', `${r.date}T21:00:00Z`]));
  if (navRows.length) q.push(multi('nav_history', ['workspace_id', 'ticker', 'nav_date', 'nav', 'daily_yield_bps', 'struck_by', 'struck_at'], navRows));

  // Accruals for distributing funds from ledgerStart to T. Completed months are paid as distributions
  // (accrual rows carry the distribution id, so totals reconcile); the current month stays unpaid.
  const accrualRows: unknown[][] = [];
  const distRows: unknown[][] = [];
  for (const f of Object.values(SEED_TERMS)) {
    if (f.shareClassType !== 'distributing') continue;
    const series = navs[f.ticker];
    const navAt = (x: string) => { let n = series[0]; for (const s of series) { if (s.date <= x) n = s; else break; } return n; };
    const holders = inv.filter((i) => i.holdings[f.ticker]).map((i) => ({ id: i.id, units: i.holdings[f.ticker]!.units, since: d(i.holdings[f.ticker]!.since) }));
    let month = ledgerStart.slice(0, 7);
    let acc: { investor: string; amount: number }[] = [];
    for (let x = ledgerStart; x <= T; x = addDays(x, 1)) {
      const n = navAt(x);
      const rate = n.date === x && n.dy != null ? n.dy : f.yieldBps;
      const monthEnd = lastDayOfMonth(x);
      const paid = monthEnd < T;
      const dstId = paid ? `dst_${f.ticker.toLowerCase()}_${x.slice(0, 7).replace('-', '')}` : null;
      for (const h of holders) {
        if (h.since > x) continue;
        const amount = r6((h.units * n.nav * rate) / 10_000 / 365);
        accrualRows.push([ws, f.ticker, x, h.id, h.units, rate, amount, dstId]);
        acc.push({ investor: h.id, amount });
      }
      if (x === monthEnd && paid) {
        const total = r6(acc.reduce((s, a) => s + a.amount, 0));
        const payNav = navAt(x).nav;
        const per = new Map<string, number>();
        for (const a of acc) per.set(a.investor, (per.get(a.investor) ?? 0) + a.amount);
        const units = r2([...per.values()].reduce((s, a) => s + r2(a / payNav), 0));
        distRows.push([ws, dstId, f.ticker, `${month}-01`, x, x, total, units, per.size, `${x}T22:00:00Z`]);
        acc = [];
        month = addDays(x, 1).slice(0, 7);
      }
    }
  }
  if (distRows.length) q.push(multi('distributions', ['workspace_id', 'id', 'ticker', 'period_start', 'period_end', 'paid_on', 'total_amount', 'reinvested_units', 'holders', 'created_at'], distRows));
  if (accrualRows.length) q.push(multi('accruals', ['workspace_id', 'ticker', 'accrual_date', 'investor_id', 'units', 'rate_bps', 'amount', 'distribution_id'], accrualRows));

  // Documents and acknowledgments.
  const docs = seedDocs();
  q.push(multi('fund_documents', ['workspace_id', 'id', 'ticker', 'doc_type', 'title', 'version', 'jurisdiction', 'audience', 'content', 'sha256', 'required', 'published_at', 'published_by'],
    docs.map((x) => [ws, x.id, x.ticker, x.docType, x.title, 1, x.jurisdiction, x.audience, x.content, x.sha256, x.required, `${d(x.published)}T08:00:00Z`, x.publishedBy])));
  const ackRows: unknown[][] = [];
  for (const [investorId, ids] of Object.entries(ACKS)) {
    const who = investors[investorId as keyof typeof investors];
    for (const docId of ids) {
      const doc = docs.find((x) => x.id === docId)!;
      const since = who.holdings[doc.ticker]?.since;
      const at = since && since > doc.published ? since : addDays(doc.published, 14);
      ackRows.push([ws, investorId, docId, doc.sha256, 'ops_attested', who.name, `${d(at)}T09:30:00Z`]);
    }
  }
  q.push(multi('doc_acknowledgments', ['workspace_id', 'investor_id', 'document_id', 'sha256', 'method', 'signed_name', 'acknowledged_at'], ackRows));

  // Sorell gave 90 days' notice (40 days ago on the demo date) to redeem 200,000 AGPC units at the next quarter end.
  // The notice date moves earlier when the quarter end is less than 90 days after it, so the notice is always valid.
  const agpc = SEED_TERMS.AGPC;
  const quarterEnd = nextDealingDate(agpc, T);
  const a40 = addDays(T, -40); const a90 = addDays(quarterEnd, -agpc.noticeDays);
  const noticeDate = a40 < a90 ? a40 : a90;
  q.push(multi('redemption_notices', ['workspace_id', 'id', 'investor_id', 'ticker', 'units', 'notice_date', 'dealing_date', 'status', 'created_at'],
    [[ws, 'rn_sorell_agpc_1', 'sorell', 'AGPC', 200_000, noticeDate, quarterEnd, 'pending', `${noticeDate}T14:05:00Z`]]));
  return q;
}
