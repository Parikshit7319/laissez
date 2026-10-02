# @laissez/sdk

TypeScript and JavaScript client for the Laissez API: compliance decisions, atomic settlement, credentials, policy changes, screening, the audit log and signed webhooks for tokenized funds.

One file, no dependencies. Works on Node 18+, Bun, Deno, Cloudflare Workers and in browsers. It needs only `fetch` and Web Crypto.

## Install

The package is not on npm yet. Copy `laissez.ts` into your project (it has no imports and ships as TypeScript source), or vendor the folder:

```sh
curl -O https://raw.githubusercontent.com/parikshit7319/laissez/main/sdk/typescript/laissez.ts
```

```ts
import { Laissez, LaissezError, verifyWebhook } from './laissez';
```

Once published, `npm install @laissez/sdk` and import from `'@laissez/sdk'`.

## Quickstart

```ts
import { Laissez } from './laissez';

// Open a sandbox with fictional data (no credentials needed).
const sandbox = await Laissez.createSandbox('Aster & Vale sandbox');

const laissez = new Laissez({ apiKey: sandbox.api_key });

// Ask before you trade.
const decision = await laissez.decisions.create({
  action: 'subscribe',
  investor_id: 'lumen',
  fund: 'TWLF',
  amount: 250000,
  settle_with: 'USDC',
}, { idempotencyKey: 'order-2026-10-02-0001' });

if (decision.outcome === 'ALLOW' && decision.id) {
  const settlement = await laissez.settlements.create(decision.id);
  const final = settlement.status === 'pending'
    ? await laissez.settlements.waitUntilSettled(settlement.id)
    : settlement;
  console.log(final.status); // settled
} else {
  console.log(decision.headline, decision.remedies);
}
```

## Authentication

Pass one of:

- `apiKey`: an `lz_test_` key from `POST /v1/sandboxes` or `POST /v1/api-keys`. Keys carry scopes (`read`, `orders`, `clients`, `funds`, `compliance`, `developer`, `admin`) and an optional IP allowlist. 300 requests per minute.
- `sessionToken`: an `lz_sess_` token from passkey or single sign-on, for calls made on behalf of a signed-in person. Required for human-only actions such as approving a policy change. 600 requests per minute.

```ts
new Laissez({ apiKey: process.env.LAISSEZ_API_KEY });
new Laissez({ sessionToken, baseUrl: 'https://laissez-api.laissez.workers.dev', version: '2026-10-02' });
```

## Idempotency

Every write (`POST`, `PATCH`, `PUT`, `DELETE`) carries an `Idempotency-Key`. Pass your own with `{ idempotencyKey }` so a retried order is applied once; otherwise the client generates a UUID per call. The API stores the response for 24 hours and replays it with `Idempotent-Replayed: true`. Read it with `responseMeta(result)?.idempotentReplayed`.

Set `autoIdempotency: false` to send keys only when you pass them. Writes without a key are never retried.

## Retries

Reads, and writes that carry an idempotency key, are retried on `429`, `5xx` (except `501`) and network errors: up to `maxRetries` (default 3) with exponential backoff from about 500 ms, capped at 8 s, honouring `Retry-After`. Other `4xx` responses are not retried. Each attempt times out after `timeoutMs` (default 30 s). Pass an `AbortSignal` in request options to cancel.

## Errors

Every non-2xx response throws `LaissezError`:

```ts
try {
  await laissez.credentials.issue({ investor_id: 'meitan', classifications: [{ class_code: 'HK_PI', evidence: { portfolio_hkd: 1 } }] });
} catch (e) {
  if (e instanceof LaissezError) {
    e.code;     // 'threshold_not_met'
    e.status;   // 422
    e.message;  // 'Nothing was issued. ...'
    e.detail;   // per-class results
  }
}
```

Common codes: `invalid_request` (400), `unauthorized` (401), `insufficient_scope` and `human_required` (403), `not_found` (404), `idempotency_in_progress` (409), `idempotency_mismatch` (422), `rate_limited` (429). Network failures after the last retry throw `network_error` with status 0.

## Resources

| Namespace | Methods |
| --- | --- |
| `decisions` | `create`, `retrieve`, `list`, `replay`, `evaluateAsOf`, `bulkEligibility`, `backtest` |
| `settlements` | `create`, `retrieve`, `list`, `waitUntilSettled` |
| `investors` | `list`, `create`, `retrieve`, `portalInvite`, `revokePortalAccess` |
| `credentials` | `list`, `issue`, `revoke` |
| `funds` | `list`, `retrieve`, `create`, `register`, `lifecycle`, `updateTerms`, `strikeNav`, `runAccruals`, `distributions.*`, `documents.*`, `redemptionNotices.*` |
| `policyChanges` | `list`, `preview`, `propose`, `approve`, `reject` |
| `screening` | `screen`, `sources`, `hits.list`, `hits.decide` |
| `workItems` | `list`, `resolve` |
| `monitoring` | `retrieve`, `run` |
| `credentialShares` | `list`, `request`, `revoke` |
| `travelRule` | `list`, `retrieve`, `start`, `retry`, `confirm` |
| `reports` | `placement`, `distribution`, `placementCsv`, `decisionsCsv`, `registerByJurisdictionCsv` |
| `audit` | `list`, `verify`, `exportCsv`, `anchors` |
| `apiKeys` | `list`, `create`, `rotate`, `revoke` |
| `webhooks` | `list`, `create`, `delete`, `test`, `deliveries.list`, `deliveries.retrieve`, `deliveries.replay`, `verify` |
| `reference` | `jurisdictions`, `investorClasses`, `bookingCenters`, `rulePacks`, `signingKey`, `verifyReceipt` |

Anything not covered: `laissez.get(path, { query })`, `laissez.post(path, body, { idempotencyKey })`, `patch`, `put`, `delete`.

## Webhooks

Laissez signs each delivery with `Laissez-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` using the `whsec_` secret returned once by `webhooks.create`. Verify with the raw body, before parsing it:

```ts
import { verifyWebhook, LaissezError } from './laissez';

// Node (Express with express.raw), Hono, Workers: anything that gives you the raw body.
export async function handler(req: Request) {
  const raw = await req.text();
  try {
    const event = await verifyWebhook(raw, req.headers.get('laissez-signature'), process.env.LAISSEZ_WEBHOOK_SECRET!);
    if (event.type === 'settlement.completed') { /* release the client's units */ }
    return new Response('ok');
  } catch (e) {
    if (e instanceof LaissezError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
```

The comparison is constant-time and deliveries older than 300 seconds are rejected (change with the fourth argument). Any 2xx acknowledges the event; Laissez tries three times, about 1 and 3 seconds apart, then records the delivery so you can replay it from the console or `webhooks.deliveries.replay(id)`.

## Tests

```sh
npx tsx sdk/typescript/test.ts
```

The tests run against a mocked `fetch` and cover headers, idempotency, retries, errors, polling and webhook verification.
