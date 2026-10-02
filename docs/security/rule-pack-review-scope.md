# Rule-pack legal review scope

Purpose: obtain a written opinion from qualified counsel that each shipped rule pack and every threshold matches the primary source it cites. Until that opinion exists, Laissez states in the product that its rules are not legal advice and cites sources beside every check.

## What is reviewed

For each of the 17 jurisdiction packs (SG, HK, CH, DE, LU, IE, GB, AE-DIFC, AE-ADGM, JP, IN, US, AU, CA, BR, KR, GLOBAL):

- Investor classification tests in `src/proto/thresholds.ts`: thresholds, currencies, look-back dates, evidence required.
- Distribution and eligibility rules in `src/proto/rulepacks.ts`: who may subscribe, transfer or redeem, per investor class and booking center.
- Fund-structure rules in `src/proto/engine.ts` that depend on law: Regulation S categories and periods, 3(c)(7) holder cap and Section 12(g), India LRS limits, closed-end capital calls, holiday calendars used for settlement dates.
- Sources in `src/data/sources.ts`: that each cited provision exists, is current, and says what we say it says.
- The 109 golden regression cases: that each expected outcome is the correct legal outcome.

## How we package it

One workbook per jurisdiction with rule, citation, our reading, expected outcome, and a blank column for counsel's comment. Generated from the repository so it cannot drift: `npm run test:rules` already prints every case. Add `reviewed_on` and `reviewed_by` to each pack row (column added in migration 018) when counsel signs off.

## Who

One firm with offshore coverage for APAC, Switzerland and the EU, or one lead firm with local counsel in each region. Ask for a fixed price per jurisdiction. Priority order: US, SG, HK, GB, CH, then the rest by first customer demand.

## Output we need

1. A signed opinion per jurisdiction with scope and assumptions.
2. A change list. Every change becomes a rule-pack version with its own regression case and source, approved through the policy workflow so the audit log shows who changed what and why.
3. A standing review cadence: quarterly, plus an ad hoc review when the regulatory feed flags a change.

## What counsel does not review

Software correctness, security (see pentest-scope.md), tax treatment beyond the withholding flags shown, or the commercial terms of any fund.

## Status

Not started. Owner: founder. Blocked on budget; no customer should rely on the rules as legal advice until the opinion for their jurisdictions is on file.
