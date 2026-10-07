# The chain layer: what it proves, what it refuses, what comes next

Laissez uses a blockchain for exactly two things: shared state between parties that do not trust each other (fund units and eligibility claims an issuer's registry can check without calling Laissez), and evidence that Laissez itself cannot rewrite (a daily root over every organization's audit log). Everything else, including personal data, stays off-chain. `docs/architecture.md` says how the code is wired; this page says what is proven, how anyone can check it, and what is deliberately not built.

## What is on-chain

| Contract | Role | Source |
| --- | --- | --- |
| One ERC-3643 suite per fund (Token, IdentityRegistry, IdentityRegistryStorage, ClaimTopicsRegistry, TrustedIssuersRegistry, ModularCompliance) | The fund's permissioned token and the registry that decides who may hold it. The issuer owns these in production; the test deployment is Laissez-owned. | `@tokenysolutions/t-rex` 4.1.6 |
| ONCHAINID identity, factory, Laissez `ClaimIssuer` | One identity per investor wallet. The Laissez claim (topic 10101) is a hash of the credential and an expiry, signed by the claim key. | `@onchain-id/solidity` 2.2.1 |
| `CountryAllowModule`, `ClaimExpiryModule` | Fund policy on-chain: which countries, and no receipt by an expired claim. | T-REX module and `contracts/ClaimExpiryModule.sol` |
| `LaissezOnboarder` | Identity at a predicted CREATE2 address, claim, registry entry and opening balance in one transaction. Idempotent. | `contracts/LaissezOnboarder.sol` |
| `LaissezDvP` | Atomic delivery versus payment keyed by decision hash. A decision settles once. Redemption is never blocked by eligibility. | `contracts/LaissezDvP.sol` |
| `LaissezCash` (tUSD, tEUR) | Test cash with no value, minted on demand on test networks. | `contracts/LaissezCash.sol` |
| `AuditAnchor` | One Merkle root per UTC day over the audit log head of every organization. | `contracts/AuditAnchor.sol` |

The chain never sees names, documents or classifications. A claim carries `keccak256` of the credential id and an expiry. A settlement carries a decision hash. Deleting an organization leaves hashes nobody can reverse.

## What is proven, and where

`node api/chain/local-test.mjs` starts a local node, deploys everything and runs 22 steps. The ones that matter to a reviewer:

- Subscribe, transfer and redeem move units and cash in one transaction or not at all; the same decision hash cannot settle twice.
- A revoked or expired claim makes the next inbound transfer revert on-chain, with the reason; the investor can still redeem.
- A policy change (a new country) published by Laissez changes what the fund's compliance contract accepts.
- **Independent issuer registry.** A second issuer, with its own key, deploys its own ERC-3643 registry with no help from Laissez, requires topic 10101, registers an investor's identity and adds the Laissez `ClaimIssuer` as a trusted issuer. The registry then reports the investor verified with no call to the Laissez API; it stops when the issuer removes the trust or when Laissez revokes the claim, and resumes when either is restored. This is the credential network's claim: verify once, rely anywhere, and either side can withdraw.
- **Audit anchoring, verified by a third party.** `api/chain/verify-anchor.mjs` takes the response of `GET /v1/audit-anchors`, an organization id, the contract address and an RPC URL, and checks each anchor five ways without trusting Laissez: it recomputes the leaf, folds the proof to the root, reads `rootOf(day)` from the contract, calls `AuditAnchor.verify` on-chain and checks the anchoring transaction and block. The test shows it accepting every real head and rejecting a tampered head, a wrong organization and an unanchored day.

Run it yourself, against the test deployment, once it is live:

```bash
curl -s -H "Authorization: Bearer $LAISSEZ_KEY" https://laissez-api.laissez.workers.dev/v1/audit-anchors > anchors.json
node api/chain/verify-anchor.mjs anchors.json --workspace <your organization id> --contract <AuditAnchor address from the status page>
```

The anchor says an audit head existed by that day. `GET /v1/audit-events/verify` says the log behind the head is intact; the two together say nothing was rewritten after the fact.

## What is refused

Laissez signs only on test networks. `TESTNET_CHAIN_IDS` in `api/src/chain.ts` (Base Sepolia 84532, local Hardhat 31337) gates every transaction the Worker and the chain job sign, and `api/chain/deploy.mjs` refuses any other chain id. Pointing `CHAIN_RPC_URL` at a chain where tokens have value does nothing except produce an error. Adding a chain is a code change, reviewed, after the questions below are answered.

Not built, on purpose: a Laissez token, a chain of our own, governance tokens, NFTs, and anything personal on-chain. None of these solves a problem a distributor or issuer has, and the last one breaks the GDPR position the privacy page states.

## The real cash leg: what has to change before mainnet

Today `LaissezDvP._pay` calls `operatorTransfer` on `LaissezCash`, a function real stablecoins do not have. Settling against USDC or EURC needs three changes, in this order:

1. **Authorization model.** Either investor wallets approve the DvP contract (they are custodial and hold no gas, so this means EIP-2612 `permit` signed by the custody key and submitted by the operator; USDC and EURC support it), or cash sits in a per-organization vault the DvP is operator of. The vault is simpler and keeps one approval per organization; the permit keeps cash in the investor's own wallet. Counsel decides which, because the answer decides who the custodian is.
2. **Contract change.** `_pay` becomes `transferFrom` (plus the permit path or the vault), `autoFundTestCash` is removed from the mainnet build, and the cash token address becomes per-fund configuration rather than a Laissez deployment. A Hardhat test against a mock USDC with `permit` goes in before any testnet run; Circle's testnet USDC on Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) is the second run.
3. **Legal and operational clearance.** Custody of client cash and fund units, money transmission exposure in each booking centre, the treasury wallet's ownership (issuer, transfer agent or Laissez), key ceremony and recovery for the operator and custody keys, and insurance. The gap list in the project doc `gap-to-market.md` tracks these.

Until all three are done, settlement value on-chain is test cash, and the product says so wherever it shows a settlement.

## Switching the test network on

1. Fund the operator `0x8d4292D0c1464528b0190734c8f14506b7886355` with about 0.005 Base Sepolia ETH. The deployment is about 90 transactions (19 shared, 24 per fund).
2. From the project folder, with `api/.dev.vars` holding the three chain keys and the Neon owner URL:
   `cd api/chain && set -a && . ../.dev.vars && set +a && CHAIN_RPC_URL=https://sepolia.base.org node deploy.mjs`
   It writes `api/chain/deployment.json`, resumes if interrupted, and upserts the result into `chain_config` so the Worker and the status page pick it up within a minute.
3. Set the same three keys as GitHub Actions secrets so the nightly `sweep` job processes stalled settlements, reconciles and anchors (`docs/runbook.md`, Secrets).
4. `chain_settlement` is on by default; turn it off per organization (`PUT /v1/flags/chain_settlement`) where settlement should stay simulated. Without a deployment and the operator key, settlement is simulated everywhere and labelled as such.
5. Check: the status page shows the network and contract addresses with explorer links; `GET /v1/chain` reports `enabled: true`; the first nightly run produces an anchor, and `verify-anchor.mjs` passes against it.
