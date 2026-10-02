# Laissez

Compliant cross-border distribution and settlement for tokenized funds. A concept-stage product by Parikshit Ambhore.

Live site: https://parikshit7319.github.io/laissez/
API: https://laissez-api.laissez.workers.dev (status at https://parikshit7319.github.io/laissez/status/)

## Run locally

```bash
npm install
npm run dev      # http://localhost:4321/laissez/
npm run build    # static output in dist/
```

The site talks to the live API. To run the API and a database on your machine, follow `docs/runbook.md` (Local setup). The short version:

```bash
docker compose up -d                                   # Postgres 17 on 5432
DATABASE_URL=postgres://postgres:laissez@127.0.0.1:5432/laissez LAISSEZ_RT_PASSWORD=laissez_rt node api/db/setup.mjs
cd api && npm install && npx wrangler dev               # needs api/.dev.vars, see the runbook
```

## Tests

```bash
npm test                      # policy engine and thresholds
npm run test:rules            # rule pack regression cases
npm run test:openapi          # every route is in the OpenAPI document
npm run test:api [baseUrl]    # end-to-end smoke test against a running API (default: live)
npx --prefix api/jobs tsx sdk/typescript/test.ts && (cd sdk/python && python3 -m unittest discover -s tests)
cd api && npx tsc --noEmit    # API typecheck
npm --prefix tests/e2e ci && npx --prefix tests/e2e playwright test   # browser flows, BASE_URL=... for another site
```

## Where things live

- `src/pages/` one file per page; `src/pages/developers/reference/` the API reference, one page per tag, generated from `api/src/openapi.ts`
- `src/proto/` the prototype: `engine.ts` (policy resolver), `data.ts` (fictional entities, real thresholds), `Console.tsx` (UI)
- `src/app/` the signed-in product; `src/components/live/` the status and metrics islands
- `src/data/sources.ts` every cited source; footnote numbers follow this list
- `api/` the Cloudflare Worker (Hono 4 on Neon Postgres); `api/db/` schema, migrations and `setup.mjs`; `api/jobs/` scheduled Node jobs; `api/chain/` contracts
- `sdk/typescript/`, `sdk/python/` API clients; `scripts/release-sdks.mjs` cuts a release
- `tests/e2e/` Playwright flows; `docs/runbook.md` operations

## Continuous integration and deploy

`.github/workflows/ci.yml` runs on every pull request and branch: install, engine and rule tests, the OpenAPI check, both SDK test suites, the jobs tests, the API typecheck, every migration against a fresh Postgres 17, and the Astro build. When the Cloudflare secrets are present it also uploads a Worker version (no traffic change) and runs `api/test/smoke.mjs` against the version preview URL; without them it posts a notice and skips. Browser flows run when `E2E_BASE_URL` is set or on manual dispatch.

Pushing to `main` runs `.github/workflows/deploy.yml`, which calls CI first and publishes the site to GitHub Pages only when CI passes. In the repo settings, set Pages > Source to "GitHub Actions" once. The Worker is deployed by hand with `wrangler deploy` from `api/` (runbook, Deploy). Scheduled jobs run from `.github/workflows/jobs.yml`. SDKs publish from `.github/workflows/publish-sdks.yml` on a tag `sdk-v<version>`.

### Secrets and variables

Settings > Secrets and variables > Actions.

| Name | Kind | Used by | Purpose |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | ci.yml | Token with "Workers Scripts: Edit" on the account. Uploads the preview version. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | ci.yml | Account that owns `laissez-api`. |
| `DATABASE_URL` | secret | jobs.yml | Neon owner connection string for the scheduled jobs. |
| `CHAIN_OPERATOR_KEY`, `CHAIN_CLAIM_KEY`, `CHAIN_CUSTODY_SEED` | secret | jobs.yml | On-chain jobs. Optional; the chain steps skip when unset. |
| `NPM_TOKEN` | secret | publish-sdks.yml | npm automation token for `@laissez/sdk`. |
| `PYPI_TOKEN` | secret | publish-sdks.yml | Optional. Without it PyPI trusted publishing is used (environment `pypi`). |
| `FEEDS_CONTACT` | variable | jobs.yml | Email sent in the regulator feed reader's user agent. |
| `E2E_BASE_URL` | variable | ci.yml | Site the Playwright flows run against. Unset skips them. |

Worker secrets (`wrangler secret put`) are listed in `api/wrangler.toml` and the runbook.

Prototype entities and data are fictional and simulated. Market data is as of October 1, 2026, with sources on the site.
