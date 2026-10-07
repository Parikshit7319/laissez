# Laissez

Compliance and settlement layer for tokenized funds. A distributor verifies an investor once; Laissez resolves every rule that applies to each order across jurisdictions, settles cash and fund units together, and keeps a signed record of which rule decided. Built by Parikshit Ambhore as a company, not a case study. Live at https://parikshit7319.github.io/laissez/ (app at /app/, API at https://laissez-api.laissez.workers.dev).

## Non-negotiables

- No em dashes anywhere: code comments, copy, docs, commit messages.
- Plain, direct copy in sentence case. Buttons say what happens. Errors say what happened and how to fix it.
- Institutions and people in the product are fictional and labeled so. Thresholds and legal citations are real and cited in `src/data/sources.ts`.
- Every write to the API is audited (hash-chained `audit_events`), permission-checked with `need(c, perm)`, and tenant-scoped through `c.get('sql')`.
- Nothing fictional may run in production paths without a guard (sandbox teammates, demo IdP, test cash minting are gated on `workspace.kind === 'sandbox'` or testnet config).

## Layout

- `src/pages/` marketing site (Astro 7, base path `/laissez`), including the legal and trust pages: `privacy`, `terms`, `trust`, `subprocessors`, `dpa`. `src/layouts/Layout.astro` header and footer. `src/styles/global.css` tokens: paper, ink, green accent, brass detail.
- `src/app/` the product (Preact, hash router). `registry.tsx` is the single route list; add a page by adding one entry. `api.ts` HTTP client. `auth.tsx` gate, sign-up form and permissions mirror. `screens.tsx` email confirmation and recovery screens. `turnstile.tsx` bot check. `views/*.tsx` screens (`account.tsx` your security, `policy.tsx` organization policy and verification, `billing.tsx` plan, usage, invoices, `auditexport.tsx` SIEM and archive destinations, `reviews.tsx` PEP and adverse media, `kyc.tsx` identity verification card).
- `src/proto/` the rules engine. `engine.ts` (deterministic, synchronous `evaluate()`), `data.ts` fictional entities, `thresholds.ts` classification tests, `rulepacks.ts` jurisdictions, packs and regression cases. The same engine runs in the browser (demo) and in the Worker.
- `src/portal/` white-label investor portal. `src/pages/portal.astro`, `src/pages/consent.astro`. `Account.tsx` passkey accounts and the authenticator app.
- `src/data/trust.ts` roles, permission matrix, SOC 2 controls and sub-processors, shared by the Trust page, the Sub-processors page and `scripts/gen-procurement-pack.ts` (the PDF built before every build).
- `api/src/` Cloudflare Worker (Hono 4, zod 4). `index.ts` mounts routers; `auth.ts` sessions, passkeys, SSO, members; `http.ts` roles, scopes, `need()`, `audit()`; `db.ts` tenant wrapper with row-level security and a pluggable driver; `routes/*.ts` endpoints by domain (`security.ts` account security and verification, `billing.ts` plans and invoices); `account-security.ts` email confirmation, recovery, Turnstile, alerts; `totp.ts` authenticator codes; `security-policy.ts` per-organization sign-in policy; `billing.ts` metering, invoices, dunning, Stripe; `pdf.ts` invoice PDFs; `siem.ts` audit log export (Splunk HEC, signed HTTPS, S3 Object Lock, SigV4); `kyc.ts` identity verification (Sumsub) with sealed evidence; `pep.ts` PEP reviews; `routes/portal-auth.ts` investor portal accounts; `routes/rulefeed.ts` the signed rule-pack feed; `internal.ts` staff routes behind `INTERNAL_TOKEN`; `openapi.ts` the spec (tested against the routers).
- `api/db/` `schema.sql`, `seed-globals.sql`, `migrate-NNN-*.sql` (statements separated by a line containing only `-- ;`), `setup.mjs` (fresh database), `migrate.mjs` (one file against Neon), `local.mjs` (embedded Postgres for local work), `restore-check.mjs` (read-only checks after a restore or drill).
- `api/jobs/` scheduled Node jobs (sanctions ingest, monitoring sweep, regulator feeds, fund ops, chain). Run by `.github/workflows/jobs.yml`.
- `api/chain/` and `contracts/` ERC-3643 deployment, Laissez contracts, local Hardhat tests (`local-test.mjs`, 22 steps including an independent issuer registry), `verify-anchor.mjs` (checks an audit anchor with only an RPC node). Test networks only: `TESTNET_CHAIN_IDS` in `api/src/chain.ts`. `docs/chain.md` says what is proven and what is refused.
- `sdk/typescript`, `sdk/python` clients. `tests/e2e` Playwright flows. `docs/` runbook, design notes.

## Commands

- `npm run dev:all` local database (embedded Postgres), local API in Node mode on :8787, site on :4321. No Cloudflare or Neon needed.
- `npm run db:local`, `npm run api:local`, `npm run dev` individually. `npm run db:reset` wipes the local database.
- `npm run test:all` engine tests, rule-pack regression, OpenAPI coverage. `cd api && npx tsc --noEmit` API types. `npm run build` site.
- `node api/test/smoke.mjs [baseUrl]` end-to-end API checks (defaults to the live API; pass `http://127.0.0.1:8787` for local).
- `node scripts/staff.mjs ...` staff CLI: organization verification, order forms, invoices, revenue (see `docs/runbook.md`, Staff tasks). `npm run test:security-billing` end-to-end checks of sign-up, recovery, authenticator codes, policy, contracts and invoices against a local API.
- Deploy: push to `main` deploys the site after CI; `cd api && npx wrangler deploy` deploys the Worker; `node api/db/migrate.mjs db/migrate-NNN.sql` applies a migration to Neon (run migrations before deploying code that needs them).

## Conventions

- Permissions: read, clients:write, orders:write, funds:write, policy:approve (human only), compliance:write, work:write, rules:write, rules:approve (human only), developer, keys:admin, members:admin (human only), audit:export, billing:read, billing:write (human only). Roles map to them in `api/src/http.ts`.
- Errors: `throw new ApiError(status, code, message, detail?)`. Codes are snake_case and stable; the SDKs and docs reference them.
- New table: add a migration with grants and an RLS policy following `migrate-003-rls.sql`; admin-only tables get no grant to `laissez_rt`.
- New route: add it to the router, to `api/src/openapi.ts`, and run `npm run test:openapi`.
- New rule or jurisdiction: `src/proto/rulepacks.ts` plus a migration row, a source in `src/data/sources.ts`, thresholds test, and regression cases. Flag anything not verified against a primary source.
- Money and identity: card data never touches Laissez (Stripe-hosted invoices only). Email confirmation, recovery wait, billing gates and step-up (`needStepUp`, a passkey assertion within ten minutes for sensitive actions) apply only to real organizations; sandboxes are exempt. A billing suspension never blocks redemptions. `settlement_mode = 'decide_only'` closes every settlement route. Identity documents never pass through Laissez; the provider's record is sealed and every read is logged. A PEP match opens a review, never a refusal. Every CSV export builds cells through `src/proto/csv.ts`. The terms version lives in `api/src/account-security.ts` (`TERMS_VERSION`) and moves with `src/pages/terms.astro`.
- Secrets live in `api/.dev.vars` (cloud) and `api/.dev.local.vars` (local); both are gitignored. Never commit keys.

## Status

All 54 backlog items from `claude/backlog-54.md` in the project are built except 29 (testnet deployment, waiting on faucet ETH for operator `0x8d4292D0c1464528b0190734c8f14506b7886355`). The go-to-market engineering is built too: contracts, usage metering, invoices with PDF, Stripe Invoicing, dunning and suspension, organization verification, email confirmation and recovery, authenticator codes, per-organization security policy, bot check, account export and deletion, secret and dependency scanning, restore checks. Also built: decide-only mode, step-up, decision pricing, the rule-pack feed, audit export to SIEMs and write-once buckets, Sumsub identity checks, PEP and adverse media reviews, portal passkey accounts, the procurement pack PDF, the walkthrough video, the staging Worker environment. Not code, and still open: Resend, Stripe, Turnstile and Sumsub keys, staging secrets and the Neon staging branch, a lawyer's review of the terms, privacy page and draft DPA, a penetration test, SOC 2, insurance, company formation. The gap to market is documented in the project doc `gap-to-market.md`.
