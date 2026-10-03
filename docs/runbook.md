# Laissez runbook

How to run, deploy and recover Laissez. The site is an Astro build on GitHub Pages; the API is a Cloudflare Worker (Hono 4) on Neon Postgres; heavy scheduled work runs as Node jobs in GitHub Actions. Nothing here is automated beyond what the workflows in `.github/workflows/` do.

Contents: Local setup, Secrets, Deploy (site, Worker, migrations), Jobs, Monitoring and logs, Rotating keys, Restoring from Neon branches, Restore drills, Staff tasks (verification, contracts, invoices, revenue), Switching on email, Stripe and the bot check, Security scanning, Releasing the SDKs, Incident checklist.

## Local setup

Prerequisites: Node 22, npm, Docker (for Postgres), Python 3.9 or later for the Python SDK tests.

### Site

```bash
npm install
npm run dev        # http://localhost:4321/laissez/
```

The dev site calls the live API at `https://laissez-api.laissez.workers.dev` (`src/components/live/api.ts`, `src/app/api.ts`). That is enough for most front-end work. `http://localhost:4321` is in the Worker's `ALLOWED_ORIGINS`, so the app and the live islands work without any API changes.

### Database

```bash
docker compose up -d
DATABASE_URL=postgres://postgres:laissez@127.0.0.1:5432/laissez LAISSEZ_RT_PASSWORD=laissez_rt node api/db/setup.mjs
```

`api/db/setup.mjs` runs `schema.sql`, `seed-globals.sql`, then every `api/db/migrate-*.sql` in file order, creates or updates the tenant role `laissez_rt`, and records what it ran in `schema_migrations`. It is safe to run again: on a database that already has the base tables it skips the schema and seed and reruns the migrations, which are all idempotent. `--dry-run` prints the plan. It needs the `pg` package, which `api/chain` installs; if it is missing, `cd api && npm install --no-save pg`.

Without Docker, any Postgres 15 or later with `pg_trgm` available works the same way, including a Neon branch (see Restoring from Neon branches). `api/chain/e2e-test.mjs` shows how to spin up a throwaway cluster from the PostgreSQL binaries alone.

### API

The Worker reaches Postgres through `@neondatabase/serverless`, which speaks HTTP and WebSocket rather than the Postgres wire protocol. Two ways to run it locally:

1. Against a Neon branch (simplest). Create a branch of the production project in the Neon console, copy its two connection strings into `api/.dev.vars` (below) and run `npx wrangler dev` from `api/`. Nothing you do touches production data.
2. Against Docker Postgres. Start the WebSocket proxy with `docker compose --profile worker up -d`, then in `api/.dev.vars` point `DATABASE_URL` and `DATABASE_URL_TENANT` at `127.0.0.1:5432` and configure the driver for the proxy (`neonConfig.wsProxy = () => '127.0.0.1:5433/v1'`, `neonConfig.useSecureWebSocket = false`, `neonConfig.pipelineConnect = false`) behind a `LOCAL_PG=1` guard in `api/src/db.ts`. That guard is not in the code today; option 1 needs no code change.

`api/.dev.vars` (never committed):

```
DATABASE_URL=postgres://...            # owner role, bypasses row-level security
DATABASE_URL_TENANT=postgres://...     # role laissez_rt, row-level security applies
SIGNING_KEY_JWK={"kty":"OKP","crv":"Ed25519","x":"...","d":"..."}
SSO_ENC_KEY=<32 random bytes, base64url>
DEMO_IDP_JWK={"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}
INTERNAL_TOKEN=<random string>
CHAIN_RPC_URL=https://sepolia.base.org
# LAISSEZ_MODE=sandbox            # production turns off every fictional path; see Deployment mode below
# CHAIN_OPERATOR_KEY=, CHAIN_CLAIM_KEY=, CHAIN_CUSTODY_SEED=, ANTHROPIC_API_KEY= are optional locally
```

Generate the keys once:

```bash
node -e "crypto.subtle.generateKey('Ed25519', true, ['sign','verify']).then(async k => console.log(JSON.stringify(await crypto.subtle.exportKey('jwk', k.privateKey))))"
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']).then(async k => console.log(JSON.stringify(await crypto.subtle.exportKey('jwk', k.privateKey))))"
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

Then `cd api && npm install && npx wrangler dev` serves the API on `http://127.0.0.1:8787`. Point the site at it by changing `API_BASE` in `src/app/api.ts` and `src/components/live/api.ts` locally (do not commit that), and add `http://localhost:4321` to `ALLOWED_ORIGINS` in `wrangler.toml` if you changed it.

### Tests

```bash
npm test && npm run test:rules && npm run test:openapi && npm run test:mode
cd api && npx tsc --noEmit
npx --prefix api/jobs tsx sdk/typescript/test.ts
(cd sdk/python && python3 -m unittest discover -s tests)
node api/test/smoke.mjs http://127.0.0.1:8787      # against your local Worker; default is the live API
npm --prefix tests/e2e ci && BASE_URL=http://localhost:4321/laissez/ npx --prefix tests/e2e playwright test
```

The smoke test creates sandboxes, orders, settlements, policy changes and a passkey account in whatever database the target API uses. Sandboxes expire after 7 days and are deleted by the daily cleanup.

## Secrets

### GitHub Actions (Settings > Secrets and variables > Actions)

| Name | Kind | Workflow | Purpose |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | ci.yml | API token with the "Workers Scripts: Edit" permission on the account. Lets CI upload a Worker version and smoke-test its preview URL. Optional: without it the preview job posts a notice and succeeds. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | ci.yml | The Cloudflare account id (Workers overview, right-hand column). |
| `DATABASE_URL` | secret | jobs.yml | Neon owner connection string. The jobs bypass row-level security on purpose. |
| `CHAIN_OPERATOR_KEY`, `CHAIN_CLAIM_KEY`, `CHAIN_CUSTODY_SEED` | secret | jobs.yml | Same values as the Worker secrets. The chain step runs only when `CHAIN_OPERATOR_KEY` is set. |
| `NPM_TOKEN` | secret | publish-sdks.yml | npm automation token for `@laissez/sdk`. |
| `PYPI_TOKEN` | secret | publish-sdks.yml | Optional. Leave unset and configure a trusted publisher on pypi.org for this repository, workflow `publish-sdks.yml`, environment `pypi`. |
| `FEEDS_CONTACT` | variable | jobs.yml | Email address in the regulator feed reader's user agent (sec.gov asks for one). |
| `E2E_BASE_URL` | variable | ci.yml | Site the Playwright flows run against on every CI run. Unset: flows run only on manual dispatch with `run_e2e`. |

### Worker (`wrangler secret put NAME`, run from `api/`)

| Name | Purpose | Format |
| --- | --- | --- |
| `DATABASE_URL` | Owner connection: auth lookups, sandbox creation, cross-tenant shares, status, cleanup, request log samples. | Neon connection string with `sslmode=require` |
| `DATABASE_URL_TENANT` | Tenant connection as `laissez_rt`. Every tenant query runs under row-level security. | Neon connection string for role `laissez_rt` |
| `SIGNING_KEY_JWK` | Ed25519 private key that signs decision receipts. The public half is served for verification. | JSON JWK (`kty` OKP, `crv` Ed25519, `x`, `d`) |
| `SSO_ENC_KEY` | AES-GCM key for SSO client secrets at rest. | 32 bytes, base64url |
| `DEMO_IDP_JWK` | P-256 private key for the demo identity provider at `/idp`. | JSON JWK (`kty` EC, `crv` P-256) |
| `INTERNAL_TOKEN` | Shared token for internal job endpoints. | any long random string |
| `CHAIN_OPERATOR_KEY` | Private key of the settlement operator on Base Sepolia. | 0x-prefixed hex |
| `CHAIN_CLAIM_KEY` | Private key that signs on-chain identity claims. | 0x-prefixed hex |
| `CHAIN_CUSTODY_SEED` | Seed from which custodial investor wallets derive. | 0x-prefixed hex, 32 bytes |
| `ANTHROPIC_API_KEY` | Optional. Enables the rule-drafting agent. | string |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional until production. Sends email (invites, confirmation and recovery links, security alerts, invoices). Without them mail is held in the outbox and shown in the app, and production email confirmation cannot complete. | Resend API key; `Laissez <notice@your-domain>` on a domain verified in Resend |
| `STAFF_EMAIL` | Optional. Where verification submissions, quote requests and billing notices go. Falls back to `LEADS_EMAIL`, then the founder's address. | email address |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | Optional. Turns on the Cloudflare Turnstile bot check on sign-up. Both must be set; the site key is public and may live in `[vars]`. | Turnstile widget keys |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional. Turns on Stripe Invoicing: invoices are mirrored to Stripe, customers pay on a Stripe-hosted page, the webhook marks them paid. Use a restricted key with Customers, Invoices and Invoice Items write. | `rk_live_...` or `sk_live_...`; `whsec_...` |
| `SELLER_NAME`, `SELLER_ADDRESS`, `SELLER_TAX_ID` | Optional. The "from" block on invoice PDFs and order forms. Set them to the legal entity once it exists. | plain text |

Non-secret configuration lives in `api/wrangler.toml` under `[vars]`: `ALLOWED_ORIGINS`, `MAX_ACTIVE_SANDBOXES`, `APP_URL`, `API_URL`, `CHAIN_RPC_URL`, and `LAISSEZ_MODE` (see Deployment mode).

### Database roles

Two roles. The owner (Neon's default role) bypasses row-level security and is used by the Worker's admin connection, the jobs and `setup.mjs`. `laissez_rt` has `LOGIN`, no `BYPASSRLS`, and only the grants migrate-003 gives it; the Worker sets `app.ws` per transaction so every tenant query sees one organization. Set or change its password with `alter role laissez_rt login password '...'` and update `DATABASE_URL_TENANT`.

## Deploy

### Site (GitHub Pages)

Push to `main`. `.github/workflows/deploy.yml` calls `ci.yml` first, then builds with `withastro/action` and publishes with `actions/deploy-pages`. If CI fails nothing is published; fix forward or revert. The Pages source must be set to "GitHub Actions" once in the repo settings. A manual run is available from the Actions tab (workflow_dispatch).

The build is fully static. Changes to `api/src/openapi.ts` change the reference pages; changes to `api/src/routes/platform.ts` response shapes need matching edits in `src/components/live/api.ts`.

### Worker (Cloudflare)

The Worker is deployed by hand from the owner's machine. Order matters when a release carries a migration:

1. Apply migrations to Neon first. Migrations only add tables, columns and indexes, so the running Worker keeps working while they apply.
   ```bash
   DATABASE_URL=<neon owner url> node api/db/setup.mjs --dry-run   # shows what will run
   DATABASE_URL=<neon owner url> node api/db/setup.mjs
   ```
   Or a single file: `cd api && node db/migrate.mjs db/migrate-011-platform.sql`.
2. Check the code: `cd api && npx tsc --noEmit`.
3. Preview without moving traffic: `npx wrangler versions upload`, then `node ../api/test/smoke.mjs <Version Preview URL>` (CI does this on every PR when the Cloudflare secrets are set).
4. Deploy: `npx wrangler deploy`. Cron triggers in `wrangler.toml` deploy with it.
5. Verify: `node api/test/smoke.mjs` against the live URL, then open the status page. Every response now carries `X-Request-Id` and `X-Response-Time`.

Roll back with `npx wrangler rollback` (Cloudflare keeps previous versions) or `npx wrangler versions deploy` to pick a specific version. Migrations are not rolled back; they are additive.

### Deployment mode (`LAISSEZ_MODE`)

One code base serves two audiences. `LAISSEZ_MODE` in `wrangler.toml` `[vars]` (or `api/.dev.vars` locally) picks which one; anything other than the exact string `production` means `sandbox`, the default. The public API at `laissez-api.laissez.workers.dev` runs in sandbox mode. A customer deployment sets `LAISSEZ_MODE = "production"` and nothing fictional can run:

| Surface | sandbox | production |
| --- | --- | --- |
| `POST /v1/sandboxes` | creates a 7-day fictional sandbox | `404 not_found` |
| Demo identity provider `/idp/*` | served | `404 not_found` |
| Workspaces of kind `sandbox` | created by the sandbox route | never created |
| Fictional seed data on a new organization | opt-in at sign-up (`demo_data`) | never inserted, whatever the form sent |
| Test cash auto-mint on settlement | per deployment flag | reported and treated as off |
| `POST /v1/reconciliation/simulate-break` | sandboxes only | `404 not_found` |
| `POST /v1/session/act-as` (teammate switch) | sandboxes only | `403 sandbox_only` |
| `GET /v1/network/demo-ids` | sandboxes only | `404 not_found` |
| `GET /v1/metrics/public`, `GET /v1/status`, `GET /v1/errors` | served | served |

The guard runs as the first `/v1` middleware (`api/src/mode.ts`, `modeGuard`), before authentication, so a production answer never touches the database; each handler keeps its own check as well. `GET /` reports `mode`. `npm run test:mode` imports the Worker with `LAISSEZ_MODE=production` and a database driver that throws, and asserts every row above. Run it before deploying a change to `mode.ts`, `auth.ts`, `oidc.ts` or `chain.ts`.

### Feature flags

`feature_flags` (global defaults) and `workspace_flags` (per-organization overrides) arrived with `migrate-014-platform2.sql`. `GET /v1/flags` lists them; `PUT /v1/flags/:key {"on": true|false|null}` overrides or clears (administrators only, audited as `flag.updated`); the Organization, Branding page has the same controls. Reads cache for 60 seconds per organization in the Worker isolate (`api/src/flags.ts`), so a flip reaches in-flight isolates within a minute. Flags today: `chain_settlement` (off means simulated settlement even with a deployment), `approvals_workflow`, `order_batching`, `portal_transfers`, `regulatory_agent`. To add one, insert a row in a migration and add it to `FLAG_DEFS` so the Worker answers before the migration runs.

### Generated documents

- `npm run docs:errors` scans every `new ApiError(status, 'code', 'message')` and writes `api/src/errors.generated.ts` (served at `GET /v1/errors`) and `docs/errors.md`. It fails when a code is not snake_case or is thrown with two statuses. Run it whenever you add or change an error.
- `npm run docs:erd` reads the SQL files and writes `docs/erd.md` (Mermaid ER diagrams per domain).
- `npm run docs:openapi` writes the merged OpenAPI document to `api/src/openapi.generated.json`. The Worker serves the same merge from memory at `GET /v1/openapi.json`: the hand-written `openapi.ts` plus request bodies derived from the zod schemas in `api/src/openapi-gen.ts` (`BODY_SCHEMAS`), the operations newer routers declare in `OPENAPI_OPS`, and the pagination contract. `npm run test:openapi` fails when a hand-written body disagrees with zod on required fields.
- `npm run docs:all` runs the three.

### Migrations

Files are `api/db/migrate-NNN-name.sql`, numbered, applied in file order. Statements are separated by a line containing only `-- ;` so function bodies may contain semicolons. Every statement must be idempotent (`if not exists`, `on conflict do nothing`, `drop ... if exists` before `create`), because `setup.mjs` reruns every migration on every run. `migrate-001-base.sql` holds the tables the production database had before migrations were introduced; it is a no-op on production. CI applies the whole chain to a fresh Postgres 17 on every run, twice, so a non-idempotent statement fails the build.

## Jobs

Work that does not fit the Workers free plan runs in `.github/workflows/jobs.yml` as Node scripts under `api/jobs/`:

| Schedule (UTC) | Job | What it does |
| --- | --- | --- |
| 05:20 daily | `sanctions` | Downloads OFAC SDN, UN, EU and UK lists into `sanctions_entries` via a staging table, then screens every workspace. Parser tests run first; a failure keeps the previous lists. |
| 06:40 daily | `sweep` | Fund NAV and accruals (`fundops.ts`), the monitoring sweep across every workspace (`sweep.ts`), then on-chain processing, reconciliation and audit anchoring (`chain.ts`) when `CHAIN_OPERATOR_KEY` is set. |
| every 6 h at :15 | `feeds` | Regulator publications into `reg_publications`. |

Run one by hand from the Actions tab with the `job` input (`sanctions`, `sweep`, `feeds`, `fundops`, `chain`, `all`), or locally with `cd api && DATABASE_URL=... npx --prefix jobs tsx jobs/<name>.ts`.

Inside the Worker, `wrangler.toml` schedules two crons: every 10 minutes `uptimeChecks` (api, database, chain RPC, sanctions freshness, monitoring freshness, then up to 5 queued chain jobs) and daily at 06:17 `dailyCleanup` (expired sandboxes, old rate-limit, challenge, idempotency and session rows, uptime checks older than 120 days, request log samples older than 30 days).

If the status page shows "Sanctions lists" degraded, the daily job failed or did not run: open the latest `Laissez jobs` run, read the parser or download error, rerun with `job: sanctions`. If "Holder monitoring" is degraded, rerun with `job: sweep`.

## Monitoring and logs

- Status page: `https://parikshit7319.github.io/laissez/status/`, backed by `GET /v1/status` (cached 30 s). Components, 90-day uptime, incidents, the 30-day error budget against 99.9 percent and sampled request latency (p50, p95, p99 over 24 hours, by route).
- Request logs: every request writes one JSON line (`ts, id, method, path, status, ms, ws, actor, version, ray, colo`) through `console.log`. Read them with `cd api && npx wrangler tail --format json` or in the Cloudflare dashboard under Workers > laissez-api > Logs. Filter by the `X-Request-Id` a client reports; a 500 response body also carries `request_id`.
- Samples: 1 in 20 requests lands in `request_log_samples` (route path, status, ms; no tenant data). `select path, percentile_cont(0.95) within group (order by ms) from request_log_samples where ts > now() - interval '1 day' group by 1 order by 2 desc` gives the slow routes.
- Public product metrics: `GET /v1/metrics/public` and the Live metrics page.

## Rotating keys

Rotate on a schedule or at once on suspicion of exposure. Each item lists the blast radius and the steps.

**Neon passwords (`DATABASE_URL`, `DATABASE_URL_TENANT`).** Reset the role password in the Neon console (Roles) or with `alter role laissez_rt login password '...'`. Update the Worker secret with `wrangler secret put`, the `DATABASE_URL` Actions secret, and `api/.dev.vars`. Existing connections drop at the next deploy; nothing stored depends on the password.

**`SIGNING_KEY_JWK` (receipt signatures).** Receipts already issued verify against the public key that signed them, so keep the old public key available if you need historic verification: export it (`x` only) before rotating and note the date. Generate a new Ed25519 JWK (command under Local setup), `wrangler secret put SIGNING_KEY_JWK`, deploy. New receipts sign with the new key at once; the Worker caches the key per isolate, so a deploy is required.

**`SSO_ENC_KEY` (SSO client secrets at rest).** Secrets encrypted with the old key cannot be decrypted after rotation. Before rotating, list organizations with SSO enabled (`select slug from workspaces where (sso->>'enabled')::boolean`), rotate the key, deploy, then have each organization's admin re-enter the client secret in Settings > Single sign-on. Until they do, their SSO sign-in fails with a configuration error.

**`DEMO_IDP_JWK`.** Only the demo identity provider uses it. Generate a new P-256 JWK, put the secret, deploy. In-flight demo sign-ins fail once.

**`INTERNAL_TOKEN`.** Put the new value as the Worker secret and anywhere a job calls an internal endpoint; deploy both sides together.

**Chain keys (`CHAIN_OPERATOR_KEY`, `CHAIN_CLAIM_KEY`, `CHAIN_CUSTODY_SEED`).** The operator and claim keys are roles on the deployed contracts: rotating them means granting the new addresses the role on-chain (see `api/chain/deploy.mjs` for the role calls) before switching the secret, then revoking the old addresses. The custody seed derives investor wallets deterministically; it cannot be rotated without migrating balances and should be treated as permanent. Update the Worker secrets and the Actions secrets together.

**Cloudflare and npm tokens.** Create the new token, update the Actions secret, revoke the old token. CI picks up the new value on the next run.

**API keys and sessions (tenant side).** Organizations rotate their own keys with `POST /v1/api-keys/{id}/rotate` (old key valid 24 hours). To revoke every session of a workspace: `update sessions set revoked_at = now() where workspace_id = '...'`.

## Restoring from Neon branches

Neon keeps point-in-time history for the project's retention window and lets you branch from any moment. Use branches both for recovery and as production-shaped test databases.

**Inspect before you restore.** In the Neon console, Branches > Create branch > from `main` at a timestamp before the incident. Connect with its connection string and verify the data (`select count(*) from decisions where workspace_id = ...`). The branch is isolated; nothing you run on it affects production.

**Restore a whole database.** Neon's Restore action on the `main` branch resets it to the chosen time and keeps the previous state as a backup branch. Do it in this order: (1) pause the Worker's writes by deploying with `MAX_ACTIVE_SANDBOXES = "0"` or by disabling the route in the Cloudflare dashboard, (2) restore, (3) rerun `node api/db/setup.mjs` so any migration applied after the restore point is reapplied (idempotent), (4) deploy the Worker again, (5) run the smoke test. Rows written between the restore point and the restore are gone; the audit chain stays valid because each workspace's chain is restored as a whole.

**Restore a few rows.** Branch from the good timestamp, `pg_dump --data-only --table=<table> <branch url> > rows.sql`, review, apply to production with `psql <owner url> -f rows.sql`. Never insert into `audit_events` by hand: the trigger assigns sequence and hash, and a replayed event would break the chain for that workspace. If audit rows were lost, restore the whole workspace or accept the gap and record it.

**Test a migration on production data.** Branch `main`, run `DATABASE_URL=<branch url> node api/db/setup.mjs`, point a `wrangler dev` session or a Version Preview at the branch, run the smoke test, then delete the branch.

**Local copy of production shape.** `pg_dump --schema-only <branch url> | psql postgres://postgres:laissez@127.0.0.1:5432/laissez` gives Docker Postgres the live schema without any data.

Neon's own backups are the retention window; there is no separate dump schedule. The window on the `laissez` project is 21600 seconds (six hours) as of 2 October 2026, which is too short to catch a problem noticed the next day. Raise it in the Neon console, Settings, Storage (it needs a paid plan) before the first paying customer, then update the trust page. Any dump of production data is personal data: never store one as a workflow artifact or in the repository; if longer retention is needed, write an encrypted `pg_dump` to a private object store with its own access log. Run the drill in Restore drills at least quarterly.

## Restore drills

A backup nobody has restored is a hope. Run a drill once a quarter and after any change to the schema that adds a table, and write the result in the commit that records it (for example `docs: restore drill 2026-Q4, 11 minutes, all checks passed`).

1. In the Neon console, create a branch of `main` from a timestamp one hour ago. Note the time you started.
2. Copy the branch's owner connection string.
3. Run the checker from `api/`: `DATABASE_URL=<branch url> node db/restore-check.mjs`. It confirms every table the migrations create exists, row-level security is on wherever the tenant role can read, the tenant role cannot bypass it, every organization's audit chain still verifies hash by hash, and how far back the restore landed.
4. Point a Worker version preview at the branch (`DATABASE_URL` and `DATABASE_URL_TENANT` for that preview only) and run `node api/test/smoke.mjs <preview url>`.
5. Note the elapsed time from step 1 to a passing smoke run. That number is the measured recovery time. Until two drills agree, the trust page says no recovery time objective has been measured.
6. Delete the branch.

A real restore follows Restoring from Neon branches, then runs step 3 against production before reopening writes.

## Staff tasks

Everything that is not self-service goes through `scripts/staff.mjs`, which calls the guarded `/v1/internal` routes with `INTERNAL_TOKEN`. Export the token once (`export INTERNAL_TOKEN=...`; it is the Worker secret of the same name), or add `--local` to use a local API and `api/.dev.local.vars`.

| Task | Command |
| --- | --- |
| See organizations waiting for verification | `node scripts/staff.mjs verification list` |
| Approve or reject one (the note is shown to the organization) | `node scripts/staff.mjs verification decide <workspace-id> approve "Registry entry checked"` |
| Draft an order form for a customer; it emails their administrators to accept it | `node scripts/staff.mjs contract create <workspace-id> --plan platform --fee 60000 --bps 1.5` |
| End a contract | `node scripts/staff.mjs contract end <contract-id>` |
| Run metering, invoicing, dunning and the Stripe sync now (the daily cron runs it too, and it is safe to repeat) | `node scripts/staff.mjs billing run` |
| List invoices | `node scripts/staff.mjs invoices --status open` |
| Record a payment that arrived outside Stripe (wire, cheque) | `node scripts/staff.mjs invoice paid <invoice-id> "Wire received 2026-11-03"` |
| Void an invoice | `node scripts/staff.mjs invoice void <invoice-id> "Issued to the wrong entity"` |
| MRR, ARR, settled value, churn, receivables, per customer | `node scripts/staff.mjs revenue` |
| Quote requests from sandboxes | `node scripts/staff.mjs quotes list`, then `quotes set <id> contacted\|won\|lost` |

How the money side behaves, so there are no surprises:

- A contract is `pending_acceptance` until an administrator accepts the order form in Settings, Billing. Acceptance records the person, the time, a hash of their network address and a SHA-256 of the exact text. Nothing is invoiced before that. In production, acceptance also needs a verified organization.
- Usage is recomputed daily from settlements into `usage_daily`; a reversed settlement drops out the next run. Usage invoices are monthly in arrears for every full month since the contract started, at most 14 months back. The platform fee is invoiced once per contract year in advance.
- Dunning counts days past the due date. At 1 and 14 days an email goes to the organization's administrators. At 30 days the organization is suspended: every write except billing, data export, sign-out and session management returns `402 billing_suspended`; reads keep working. Paying the last overdue invoice (in Stripe, or with `invoice paid`) clears the suspension on the next run.
- Suspension also stops redemptions, because they are writes. If a fund's investors must still be able to exit while the issuer disputes an invoice, end the suspension by recording the payment or voiding the invoice; there is no separate override.
- Tax is a single rate per contract (`--tax-bps`), added as its own line. It is not a tax engine. Charging VAT or sales tax across jurisdictions needs an adviser and either Stripe Tax or a manual rate per customer.

## Switching on email, Stripe and the bot check

Each feature is off until its secrets exist, and the product says so on screen instead of failing.

**Email (Resend).** Verify a sending domain in Resend (add its DNS records, wait for "Verified"). Then `wrangler secret put RESEND_API_KEY` and `wrangler secret put EMAIL_FROM` from `api/`, and deploy. Check: sign up with a real address and confirm the link arrives; look at `select kind, status, created_at from email_outbox order by created_at desc limit 10`. In production mode, accounts cannot be used before their email is confirmed, so do this before opening production sign-ups.

**Stripe Invoicing.** In the Stripe dashboard, create a restricted key with write access to Customers, Invoices and Invoice Items and nothing else. Add a webhook endpoint at `https://laissez-api.laissez.workers.dev/v1/billing/stripe/webhook` for `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible` and `invoice.payment_failed`. `wrangler secret put STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, deploy, then `node scripts/staff.mjs billing run`: open invoices without a Stripe copy are pushed and get a hosted payment link. Webhook deliveries are de-duplicated in `stripe_events` and the signature is checked with a five minute tolerance. Laissez never receives card or bank details; the hosted page is Stripe's.

**Turnstile.** In the Cloudflare dashboard, Turnstile, add a widget for `parikshit7319.github.io`. `wrangler secret put TURNSTILE_SECRET`, set `TURNSTILE_SITE_KEY` in `[vars]`, deploy. `GET /v1/auth/config` now returns the site key and the sign-up form shows the check; a request without a valid token gets `400 bot_check_failed`. Set neither to turn it off.

**Sign-ups close themselves.** In production mode with no mail provider, `GET /v1/auth/config` reports `signup_open: false` and the form shows a closed notice, because an account that cannot confirm its email could never be used. Setting the Resend secrets opens sign-ups. Sign-in for existing members is never affected.

## Security scanning

`.github/workflows/security.yml` runs on every push to `main`, every pull request and weekly (Monday 05:17 UTC). It does not gate the deploy, so a new advisory never blocks a fix.

- **Secret scan.** gitleaks over the full git history with `.gitleaks.toml`. A failure means a credential-shaped string is in a commit. Rotate the secret first (Rotating keys), then remove it from the tree; allowlist only values that are provably fake, by their exact text.
- **Dependency audit.** `scripts/audit-gate.mjs` runs `npm audit --omit=dev` for the site, the Worker and the jobs and fails on any high or critical advisory. An advisory with no patched version can be excepted in `.audit-allowlist.json` with a reason and a review date; the exception stops working on that date and the build fails again. Dependabot (`.github/dependabot.yml`) opens weekly pull requests for minor and patch updates grouped by ecosystem. It never proposes major versions: review those by hand once a quarter.
- **CodeQL.** `security-extended` queries over the TypeScript and the Python SDK. Results appear under the repository's Security tab.

Spreadsheet-formula escaping for CSV exports lives in one place, `src/proto/csv.ts`, and `npm run test:csv` covers it. Any new export must build its cells through it.

## Account security operations

- **A member is locked out.** Their route back is the recovery link from the sign-in page, which needs a confirmed email address and waits 24 hours in production unless they have an authenticator app. If they cannot receive email, an administrator removes the member and invites them again with a new address.
- **A policy locks everyone out.** The API refuses a policy the saving administrator would be locked out of. If an identity provider outage blocks everyone under `require_sso`, clear the policy in the database: `update workspaces set security_policy = '{}'::jsonb where id = '<workspace-id>'`, and record why in the commit message or the incident note.
- **Reading alerts.** Security emails are rows in `email_outbox` with `kind = 'security_alert'`; the audit log carries the matching event (`passkey.added`, `passkey.removed`, `totp.enabled`, `totp.disabled`, `account.recovery_requested`, `account.recovery_used`, `member.account_deleted`, `security.policy_updated`).
- **A deletion request.** Members delete their own account under Settings, Security. For anything else (an organization, an access request) delete in SQL and keep the dated record the audit trail needs. Details are in the privacy page.

## Releasing the SDKs

```bash
node scripts/release-sdks.mjs                 # version from the latest API version: 2026-10-02 becomes 2026.10.2
node scripts/release-sdks.mjs 2026.10.3        # or an explicit version
git push --follow-tags
```

The script updates `sdk/typescript/package.json`, `SDK_VERSION` in `laissez.ts`, `sdk/python/pyproject.toml` and `SDK_VERSION` in `client.py` (plus `DEFAULT_API_VERSION` in both with `--api`), commits, and tags `sdk-v<version>`. The tag runs `publish-sdks.yml`: version strings are checked (`--check`), both test suites run, then npm publishes `@laissez/sdk` and PyPI receives `laissez`. A manual dispatch with `dry_run` runs everything except the uploads.

## Incident checklist

1. Open the status page and `GET /v1/status`. Which component is degraded and since when?
2. `npx wrangler tail --format json` from `api/` for live errors; filter on `"status":5`.
3. Database: Neon console > Monitoring for connections and CPU; `select * from uptime_checks order by checked_at desc limit 20`.
4. Chain RPC degraded only affects on-chain settlement; simulated settlement and everything else continue. Pending settlements retry from the 10-minute cron.
5. Roll back the Worker (`npx wrangler rollback`) if the incident started with a deploy.
6. Afterwards, the incident appears on the status page automatically from the failed checks; write the cause and fix into the commit that resolves it.

If the incident might involve customer data (an exposed credential, a tenant isolation bug, a suspicious session):

1. Contain: rotate the exposed secret (Rotating keys), revoke affected sessions (`update sessions set revoked_at = now() where workspace_id = '...'`) and API keys.
2. Establish what was reachable: `select * from audit_events where workspace_id = '...' and created_at > '<start>' order by seq`, and run `node api/db/restore-check.mjs` to confirm the audit chains still verify.
3. Notify. The draft data processing addendum commits Laissez to tell affected customers within 72 hours of becoming aware of a personal data breach. Start the clock in the incident note when awareness begins, and email each affected organization's administrators with what happened, what data, what was done and what they should do.
4. Write the cause, the timeline and the fix into the commit that resolves it and update the trust page if a stated control was wrong.
