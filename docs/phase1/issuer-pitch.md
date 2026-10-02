# Laissez for issuers and transfer agents

One page. Sent after a call or on request, never cold.

## The one-line version

Register Laissez as a trusted claim issuer on one fund's identity registry on testnet, and verified investors at any participating distributor can hold that fund without you building onboarding for each distributor.

## What I am asking

One thing: add Laissez's claim issuer key to the trusted issuers list of one fund's ERC-3643 identity registry (or the equivalent allowlist in your registry) on a testnet deployment, scoped to the claim topics that fund requires (typically investor classification per jurisdiction and KYC status). Nothing on mainnet. Nothing on your production register.

If your fund is not on ERC-3643, the equivalent is a signed allowlist entry that your transfer agent accepts from Laissez for the pilot fund.

## What you get

- **Distribution reach without new integrations.** Every distributor on Laissez can place orders in your fund for investors who pass your fund policy and every applicable jurisdiction's rule. You do not onboard each distributor separately or review each distributor's eligibility pack.
- **No change to your token or your register.** Your token standard, your chain, your transfer agent and your register stay as they are. Laissez writes a claim; your registry decides whether to accept it under rules you set.
- **Your fund policy, enforced before every order.** You set where the fund is offered, to which investor classes, minimums, holder caps, lock-ups and accepted settlement assets. Laissez checks all of it, plus the investor's home law, the distributor's booking licence, document acknowledgements, dealing cut-offs and sanctions screens. The stricter rule binds. The decision says which rule decided.
- **A signed receipt for every decision.** Outcome, binding rules, rule-pack versions and a hash of the inputs, signed with Ed25519, in a hash-chained log you can verify in one call. Only the hash goes on-chain. That receipt goes in your compliance file.
- **Policy change preview.** Before you remove a jurisdiction or change a class, you see which holders move to redemption-only and how much value is affected. Two approvers on every change.

## What it costs you

Nothing in the pilot. No fee, no exclusivity, no minimum volume, no commitment past week 8. After the pilot, if you want production, we talk about pricing then and you can walk away.

Your time: roughly two hours a week from one product or TA person and one compliance person for 8 weeks.

## Risks and how they are handled

| Your concern | How Laissez handles it |
|---|---|
| A third party could whitelist someone we would not | Laissez only issues a claim after the investor passes your fund policy and every applicable rule. Your registry can also restrict Laissez to specific claim topics and revoke the trusted issuer entry at any time. In the pilot, everything is testnet. |
| We lose control of the register | Laissez never writes to your register. It writes a claim to the identity registry; transfers still execute through your token's compliance module and your transfer agent under your rules. |
| Custody and asset risk | Laissez never custodies assets or cash. Settlement is delivery versus payment in one transaction on your chain; if either leg fails, both revert. |
| Who is liable for a wrong classification | Reliance stays with the distributor that performed KYC. The credential names that distributor, the evidence reference and the citation. Laissez records and enforces; it does not replace the distributor's regulatory responsibility. |
| Personal data on-chain | None. Identity stays with the distributor. The chain sees an outcome, a hash and rule versions. |
| Investors trapped by a rule change | Never. A holder whose status lapses or whose jurisdiction is removed moves to redemption-only. Exits are never blocked, including during an outage. Inbound fails closed. |
| Rules that are wrong or out of date | Each rule pack is versioned, dated, cited and covered by regression cases. Changes are drafted from regulator publications and approved by counsel before they can bind an order. Counsel sign-off on the launch packs is a condition of production access. |

## The pilot

- **Scope:** one fund, one distributor, one corridor (for example Singapore investor, Hong Kong booking centre, or the reverse), testnet only, fictional or test money.
- **Duration:** 8 weeks.
- **Week 1 to 2:** your fund policy encoded and reviewed with you; Laissez registered as trusted claim issuer on the testnet registry; distributor's test investors credentialed.
- **Week 3 to 5:** subscriptions, a transfer and a redemption run end to end; at least one deliberately ineligible order refused with the fix named; one policy change previewed and published.
- **Week 6 to 7:** your compliance team reviews the receipts and the audit chain; we fix what they object to.
- **Week 8:** readout and decision.
- **Success metrics:** credential to first settled testnet order under 24 hours; zero orders settled without a passing re-check; one investor credential reused across two funds (yours and the distributor's second fund, or two of yours); your compliance team can verify a receipt without help from me.
- **Decision at week 8:** go to a production conversation, extend the pilot, or stop. Any of the three is fine.

## Who is asking

Parikshit Ambhore, founder. Lead engineer on Franklin Templeton's institutional transfer agency platform at FIS. Payments and supply chain engineering at Cybermatic Systems. Founded a healthcare SaaS. Early team at Sarvm.ai. MBA, Rice University, Class of 2027.

parikshit.ambhore@rice.edu | linkedin.com/in/parikshitambhore | https://parikshit7319.github.io/laissez/ (sandbox at /app/, no sign-up)
