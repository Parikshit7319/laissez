# laissez

Python client for the Laissez API: compliance decisions, atomic settlement, credentials, policy changes, screening, the audit log and signed webhooks for tokenized funds.

Standard library only. Python 3.9 or later.

## Install

```sh
pip install "git+https://github.com/parikshit7319/laissez.git#subdirectory=sdk/python"
```

Once published: `pip install laissez`. Releases publish to PyPI from this repository: pushing a tag `sdk-v<version>` runs `.github/workflows/publish-sdks.yml`, which tests both SDKs and publishes this package and `@laissez/sdk` together. Versions follow the API version they default to (`2026.10.2` targets API `2026-10-02`).

## Quickstart

```python
from laissez import Laissez, LaissezError, create_sandbox

# Open a sandbox with fictional data (no credentials needed).
sandbox = create_sandbox("Aster & Vale sandbox")

client = Laissez(api_key=sandbox["api_key"])

# Ask before you trade.
decision = client.decisions.create(
    action="subscribe",
    investor_id="lumen",
    fund="TWLF",
    amount=250000,
    settle_with="USDC",
    idempotency_key="order-2026-10-02-0001",
)

if decision["outcome"] == "ALLOW":
    settlement = client.settlements.create(decision["id"])
    if settlement["status"] == "pending":  # on-chain settlement returns 202
        settlement = client.settlements.wait_until_settled(settlement["id"])
    print(settlement["status"])  # settled
else:
    print(decision["headline"], decision["remedies"])
```

## Authentication

Pass one of:

- `api_key`: an `lz_test_` key from `POST /v1/sandboxes` or `POST /v1/api-keys`. Keys carry scopes (`read`, `orders`, `clients`, `funds`, `compliance`, `developer`, `admin`) and an optional IP allowlist. 300 requests per minute.
- `session_token`: an `lz_sess_` token from passkey or single sign-on, for calls on behalf of a signed-in person. Required for human-only actions such as approving a policy change. 600 requests per minute.

```python
Laissez(api_key=os.environ["LAISSEZ_API_KEY"])
Laissez(session_token=token, base_url="https://laissez-api.laissez.workers.dev", version="2026-10-02")
```

## Idempotency

Every write (`POST`, `PATCH`, `PUT`, `DELETE`) carries an `Idempotency-Key`. Pass `idempotency_key=` so a retried order is applied once; otherwise the client generates a UUID per call. The API stores the response for 24 hours and replays it with `Idempotent-Replayed: true`, visible as `client.last_response.idempotent_replayed`.

`auto_idempotency=False` sends keys only when you pass them. Writes without a key are never retried.

## Retries

Reads, and writes that carry an idempotency key, are retried on `429`, `5xx` (except `501`) and network errors: up to `max_retries` (default 3) with exponential backoff from about 0.5 s, capped at 8 s, honouring `Retry-After`. Other `4xx` responses are not retried. Each attempt times out after `timeout` seconds (default 30).

## Errors

Every non-2xx response raises `LaissezError`:

```python
try:
    client.credentials.issue(investor_id="meitan", classifications=[{"class_code": "HK_PI", "evidence": {"portfolio_hkd": 1}}])
except LaissezError as e:
    e.code     # 'threshold_not_met'
    e.status   # 422
    e.message  # 'Nothing was issued. ...'
    e.detail   # per-class results
```

Common codes: `invalid_request` (400), `unauthorized` (401), `insufficient_scope` and `human_required` (403), `not_found` (404), `idempotency_in_progress` (409), `idempotency_mismatch` (422), `rate_limited` (429). Network failures after the last retry raise `network_error` with status 0.

## Resources

| Attribute | Methods |
| --- | --- |
| `decisions` | `create`, `retrieve`, `list`, `replay`, `evaluate_as_of`, `bulk_eligibility`, `backtest` |
| `settlements` | `create`, `retrieve`, `list`, `wait_until_settled` |
| `investors` | `list`, `create`, `retrieve`, `portal_invite`, `revoke_portal_access` |
| `credentials` | `list`, `issue`, `revoke` |
| `funds` | `list`, `retrieve`, `create`, `register`, `lifecycle`, `update_terms`, `strike_nav`, `run_accruals`, `list_distributions`, `pay_distribution`, `list_documents`, `publish_document`, `retrieve_document`, `acknowledge_document`, `acknowledgments`, `list_redemption_notices`, `file_redemption_notice`, `cancel_redemption_notice` |
| `policy_changes` | `list`, `preview`, `propose`, `approve`, `reject` |
| `screening` | `screen`, `sources`, `list_hits`, `decide_hit` |
| `work_items` | `list`, `resolve` |
| `monitoring` | `retrieve`, `run` |
| `credential_shares` | `list`, `request`, `revoke` |
| `travel_rule` | `list`, `retrieve`, `start`, `retry`, `confirm` |
| `reports` | `placement`, `distribution`, `placement_csv`, `decisions_csv`, `register_by_jurisdiction_csv` |
| `audit` | `list`, `iter`, `verify`, `export_csv`, `anchors` |
| `api_keys` | `list`, `create`, `rotate`, `revoke` |
| `webhooks` | `list`, `create`, `delete`, `test`, `list_deliveries`, `retrieve_delivery`, `replay_delivery`, `verify` |
| `reference` | `jurisdictions`, `investor_classes`, `booking_centers`, `rule_packs`, `signing_key`, `verify_receipt` |

Anything not covered: `client.get(path, query={...})`, `client.post(path, body, idempotency_key=...)`, `patch`, `put`, `delete`.

## Webhooks

Laissez signs each delivery with `Laissez-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` using the `whsec_` secret returned once by `webhooks.create`. Verify with the raw body, before parsing it:

```python
from laissez import verify_webhook, LaissezError

# Flask
@app.post("/hooks/laissez")
def hook():
    try:
        event = verify_webhook(request.get_data(), request.headers.get("Laissez-Signature"), os.environ["LAISSEZ_WEBHOOK_SECRET"])
    except LaissezError as e:
        return e.message, 400
    if event["type"] == "settlement.completed":
        ...  # release the client's units
    return "ok", 200
```

The comparison uses `hmac.compare_digest` and deliveries older than 300 seconds are rejected (change with `tolerance_seconds`). Any 2xx acknowledges the event; Laissez tries three times, about 1 and 3 seconds apart, then records the delivery so you can replay it from the console or `client.webhooks.replay_delivery(id)`.

## Tests

```sh
cd sdk/python && python3 -m unittest discover -s tests
```

The tests run against a fake transport and cover headers, idempotency, retries, errors, polling, pagination and webhook verification.
