# Laissez threat model

Scope: the Laissez API (Cloudflare Worker), the Postgres database, the app and investor portal, signing keys, and the chain operator wallet. Date: 2026-10-02. Owner: Parikshit Ambhore. Review every quarter and after any change to auth, tenancy or signing.

## Assets

| Asset | Why it matters |
| --- | --- |
| Tenant data (clients, credentials, holdings, decisions) | Personal and commercial data of regulated firms. Cross-tenant exposure ends the company. |
| Audit log and receipts | Evidence a regulator can rely on. Must be tamper-evident and verifiable offline. |
| Receipt signing key (Ed25519) | Forging it forges proof of which rule decided. |
| Chain operator and claim keys | Move test and, later, real assets and issue identity claims. |
| Rule packs and custom rules | Changing a rule changes who may buy a fund. |
| Sessions, passkeys, API keys, SSO secrets | Account takeover and silent integrations. |

## Trust boundaries

1. Internet to Worker: every request is untrusted until a session or API key resolves to a workspace and actor.
2. Worker to Postgres: the tenant role `laissez_rt` has no BYPASSRLS; every query runs in a transaction that sets `app.ws`. The owner role `laissez_app` is used only for cross-tenant work (auth, jobs, public endpoints).
3. Worker to third parties: Resend, identity providers (OIDC, SCIM), webhook receivers, chain RPC, regulator feeds.
4. Scheduled jobs (GitHub Actions) to Postgres: owner role, secrets held in repository secrets.
5. Browser to portal: investors are not workspace members; access is by invitation token and per-investor scope.

## Threats and controls

| # | Threat | Control today | Gap |
| --- | --- | --- | --- |
| 1 | Cross-tenant read or write | Row-level security on every tenant table, tenant role without BYPASSRLS, `c.get('sql')` only in routes, policy tests in smoke | No external test yet (see pentest-scope.md) |
| 2 | Stolen session or API key | Passkeys, device-bound sessions with listing and revoke, hashed API keys with scopes, IP allowlists, rate limits and monthly quotas | Key rotation is manual |
| 3 | Privilege escalation through a key | `HUMAN_ONLY` permissions (policy:approve, members:admin, rules:approve) cannot be exercised by keys | None known |
| 4 | Approving your own change | Second-person checks on policy changes, large orders, credentials and custom rules (`same_person`) | Sandbox teammates are fictional and gated by workspace kind |
| 5 | Forged or altered audit history | Hash-chained `audit_events` through a database trigger, periodic anchors, Ed25519 receipts with public key endpoint | Anchoring to chain is untested on a public network (item 29) |
| 6 | Malicious custom rule | Rules are data in a fixed vocabulary, never code; validated, tested against regression suite and 90 days of decisions, second-person approval, effective dates, full version history | Legal review of rule-pack content is still internal (see rule-pack-review-scope.md) |
| 7 | Injection through import files | Zod validation per row, parameterized SQL only, row limits per chunk, preview before apply, no formula execution | CSV formula injection when a user re-exports into a spreadsheet is not escaped |
| 8 | SSRF through webhooks, SSO discovery or feeds | Allowlisted schemes, blocked private ranges for user-supplied URLs | Needs a dedicated test |
| 9 | Replay of mutating calls | Idempotency keys with stored response, API versioning, nonces on WebAuthn | None known |
| 10 | Secret leakage | Secrets only in `.dev.vars` and repository secrets, both gitignored; SSO secrets sealed with AES-GCM; production mode disables fictional paths | No secret scanning in CI yet |
| 11 | Chain key theft | Operator key holds testnet funds only; custody keys derived from a seed in a secret | Production needs a KMS or HSM and multi-sig |
| 12 | Denial of service | Rate limits per key and IP, bounded backtests and imports, Worker CPU limits | No WAF rules beyond Cloudflare defaults |
| 13 | Sanctions list poisoning or staleness | Lists fetched from primary publishers, counts and hashes recorded per ingest, stale-list alert | Single fetch path per list |
| 14 | Wrong legal outcome | Citations on every rule, golden regression cases, rule-pack change agent with human approval | Counsel sign-off pending |

## Out of scope

Physical security of laptops, Cloudflare and Neon platform internals, investor devices, and the correctness of regulators' own publications.

## Next review triggers

New auth method, new tenant-scoped table without an RLS policy, any new use of the owner role in a request path, first production customer, first mainnet deployment.
