# Running Laissez on your own computer

Everything runs locally with no Cloudflare and no Neon account: an embedded Postgres, the API in Node mode, and the site.

## First time

1. Install Node 22 or newer (you have it) and VS Code. Docker is not needed.
2. In the project folder: `npm install`, then `cd api && npm install && cd ..`.
3. `npm run dev:all`

The first run downloads a Postgres 17 binary (about 30 MB), creates the database under `api/.local/pgdata`, applies the schema and all migrations, writes `api/.dev.local.vars` with local settings and fresh signing keys, starts the API on http://127.0.0.1:8787 and the site on http://localhost:4321/laissez/. Open the site, press Try the sandbox, and everything you do is stored on your machine.

## Day to day

- `npm run dev:all` starts the three processes together; Ctrl+C stops them.
- `npm run db:local`, `npm run api:local`, `npm run dev` start them one at a time (three terminals) when you want to see logs separately.
- `npm run db:reset` wipes the local database and rebuilds it.
- `node api/test/smoke.mjs http://127.0.0.1:8787` runs the 59 end-to-end checks against your local API.
- `npm run test:all` runs the engine, rule-pack and OpenAPI tests.

In VS Code: Terminal > Run Task lists the same commands. Run and Debug has "Debug local API" with breakpoints in `api/src/**`.

## How local differs from the cloud

| | Local | Cloud |
|---|---|---|
| Database | embedded Postgres 17 in `api/.local/pgdata` | Neon (free tier) |
| API runtime | Node, `api/server.mjs` wrapping the same Hono app | Cloudflare Worker, `npx wrangler deploy` |
| Settings | `api/.dev.local.vars` (generated) | `api/.dev.vars` plus `wrangler secret` |
| Scheduled jobs | timers inside the Node server; `cd api && npx --prefix jobs tsx jobs/<job>.ts` by hand | Worker cron and GitHub Actions |
| Email | stored in the Outbox page | Resend when a key is set, else Outbox |
| Chain | off unless `CHAIN_*` keys are in `.dev.local.vars` | Base Sepolia once deployed |

The code is identical. `api/src/db.ts` has a pluggable driver: Neon HTTP in the Worker, node-postgres locally.

## Moving off Cloudflare or Neon later

- Any Postgres works: set `DATABASE_URL` and `DATABASE_URL_TENANT` and run `node api/db/setup.mjs`.
- Any Node host works for the API: run `node api/server.mjs` behind a reverse proxy, set `API_URL`, `APP_URL`, `ALLOWED_ORIGINS` and the secrets as environment variables.
- The site is static files in `dist/` after `npm run build`; any static host serves them. Set `PUBLIC_API_BASE` at build time to point at your API.
