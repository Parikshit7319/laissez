# Design partnership terms

Plain language. This is the outline we agree before anyone's lawyer sees it. The signed version will be short and will say the same things.

**Between:** Laissez (Parikshit Ambhore, founder) and [partner firm].

## 1. Purpose

Take one tokenized fund through one cross-border corridor on Laissez, with test money only, so both sides learn whether it works for the partner's real process before anyone commits budget.

## 2. Scope

- One corridor: one investor residence, one booking centre, one fund domicile. Agreed in writing in week 1 and not changed during the pilot.
- One fund (the partner's, or an issuer's that has agreed to the trusted claim issuer pilot), plus one second fund in the sandbox for the credential reuse test.
- Testnet or simulated settlement only. No real cash, no real fund units, no production registry.
- Subscriptions, one secondary transfer, one redemption, one refused order and one policy change.

## 3. Duration

12 weeks from the kick-off call. Either side can end it earlier with one week's notice and no explanation required.

## 4. What Laissez provides

- A dedicated workspace with the partner's corridor, fund policy and rule packs configured.
- Rule packs for the corridor's jurisdictions, versioned and cited, with the sources listed.
- The investor portal under the partner's name and colours for the test investors.
- API access, SDKs and the OpenAPI document, plus help integrating with one of the partner's test systems if they want it.
- A written readout at week 6 and week 12.
- Fixes to anything the partner's compliance team identifies as blocking, within the pilot where feasible, or a written reason why not.
- Parikshit's time: as much as the pilot needs, with a response to any question within one business day.

## 5. What the partner provides

- Two hours a week from one compliance person and one operations or product person, scheduled as a standing slot.
- Access to the current process documents for onboarding a client into a tokenized fund: forms, checklists, the eligibility matrix, the whitelist procedure, any issuer-specific packs. Redacted where needed.
- A list of the rules the partner applies in the corridor today, so the rule packs can be checked against them.
- Three feedback sessions (weeks 4, 8 and 12), one hour each, with the people who would use the product.
- A named sponsor who can say yes or no at week 12.

## 6. Data handling

- No client personal data enters the pilot. All investors, wallets and accounts are synthetic, created for the pilot and labelled as fictional.
- The partner's process documents are confidential (see 8) and are used only to configure and test the pilot. They are not stored in the product.
- The pilot workspace is deleted at the end of the pilot unless the partner asks to keep it for a production conversation.
- Laissez's standard data practices (no personal data on-chain, hash-chained audit log, keys held by Laissez, no custody) apply.

## 7. Intellectual property

- Laissez keeps the product, including anything built or improved during the pilot.
- The partner keeps its data, its process documents and its rule interpretations. Nothing the partner shares gives Laissez a licence to publish it or use it with other partners in identifiable form.
- Feedback the partner gives can be used to improve the product. The partner is not paid for it and does not own the result.
- Neither side is obliged to grant the other a licence after the pilot.

## 8. Confidentiality

- Each side keeps the other's non-public information confidential for three years after the pilot ends.
- Laissez may say publicly that it is working with "a private bank in Singapore" or similar, but not name the partner without written permission.
- The partner may describe the pilot internally without restriction and externally with Laissez's permission.
- Standard exceptions: information already public, independently developed, or required by a regulator or court.

## 9. Fees and exclusivity

- No fee in either direction.
- No exclusivity. The partner can work with anyone else. Laissez can run other pilots at the same time.
- No obligation to buy, and no right of first refusal on either side.

## 10. Success metrics

Measured in the pilot workspace and reviewed at week 12:

1. **Credential to first settlement under 24 hours.** From the moment a test investor's credential is issued to the moment their first cross-border order settles on testnet, including every check.
2. **Zero non-compliant settlements.** No order settles without a passing re-check at the moment of settlement. This number is read from the product's guardrail metric, not from a report I write.
3. **One credential reused across two funds.** At least one test investor subscribes to two funds on one credential without a second onboarding.
4. **Partner compliance can verify a receipt unaided.** One compliance person verifies a decision receipt and the audit chain without Parikshit on the call.

Also recorded but not pass or fail: time the partner's team spent, number of rule disagreements found and how each was resolved, number of blocking issues raised and fixed.

## 11. Decision at week 12

Three outcomes, any of which is acceptable:

- **Go:** move to a paid pilot on production, with one real fund and real money, subject to counsel sign-off on the rule packs and the partner's own approvals.
- **Extend:** another 8 weeks on testnet with a specific list of what has to change.
- **Stop:** workspace deleted, documents returned, thanks exchanged.

**Paid pilot pricing hypothesis** (to be tested in the week 12 conversation, not binding):

- An annual platform fee for the distributor, covering the workspace, rule packs for the corridors they operate, the investor portal and support. Working range to test: USD 60,000 to 150,000 per year depending on the number of corridors.
- Plus basis points on settled value through Laissez. Working range to test: 1 to 3 basis points, with a floor and a cap per year.
- Issuers pay nothing to accept Laissez as a trusted claim issuer. If that changes it will be because an issuer asked for something specific.

If the partner says the pricing shape is wrong, that is a result, not a failure.

## 12. Liability

Testnet and synthetic data only, so neither side relies on the pilot's outputs for any real decision. Each side is responsible for its own costs. No warranties either way during the pilot.

## 13. Signatures

Sponsor at the partner, and Parikshit Ambhore for Laissez. One page each side has read.

parikshit.ambhore@rice.edu | https://parikshit7319.github.io/laissez/
