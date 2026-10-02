"""Laissez API client. Standard library only: urllib, json, hmac, uuid, time."""

from __future__ import annotations

import hmac
import hashlib
import json
import random
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Protocol, Sequence, Union

SDK_VERSION = "0.1.0"
DEFAULT_BASE_URL = "https://laissez-api.laissez.workers.dev"
DEFAULT_API_VERSION = "2026-10-02"

JsonValue = Union[None, bool, int, float, str, List[Any], Dict[str, Any]]
_WRITE = {"POST", "PUT", "PATCH", "DELETE"}


class LaissezError(Exception):
    """Raised for every non-2xx response, and for network failures after the last retry."""

    def __init__(self, code: str, message: str, status: int, detail: Any = None, method: str = "", path: str = "", request_id: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.detail = detail
        self.method = method
        self.path = path
        self.request_id = request_id

    @property
    def is_rate_limited(self) -> bool:
        return self.status == 429

    @property
    def is_permission(self) -> bool:
        return self.status == 403

    def __repr__(self) -> str:  # pragma: no cover
        return f"LaissezError(code={self.code!r}, status={self.status}, message={self.message!r})"


@dataclass
class Response:
    """What a transport returns: status, lower-cased headers and the raw body."""

    status: int
    headers: Dict[str, str]
    body: bytes

    def header(self, name: str) -> Optional[str]:
        return self.headers.get(name.lower())


class Transport(Protocol):
    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: Optional[bytes], timeout: float) -> Response: ...


class UrllibTransport:
    """Default transport on urllib. Raises OSError subclasses on network failure."""

    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: Optional[bytes], timeout: float) -> Response:
        req = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return Response(res.status, {k.lower(): v for k, v in res.headers.items()}, res.read())
        except urllib.error.HTTPError as e:
            return Response(e.code, {k.lower(): v for k, v in e.headers.items()}, e.read())


@dataclass
class Meta:
    """HTTP metadata about the last call, available as client.last_response."""

    status: int
    version: Optional[str]
    idempotent_replayed: bool
    request_id: Optional[str]


def _hmac_hex(secret: str, text: str) -> str:
    return hmac.new(secret.encode("utf-8"), text.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_webhook(raw_body: Union[bytes, str], header: Optional[str], secret: str, tolerance_seconds: int = 300, now: Callable[[], float] = time.time) -> Dict[str, Any]:
    """Verify a webhook delivery and return the parsed event.

    ``raw_body`` must be the exact bytes Laissez sent. ``header`` is the Laissez-Signature header,
    ``t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">``. Deliveries older than ``tolerance_seconds``
    are rejected (0 disables the check). Raises LaissezError with code invalid_signature, signature_expired
    or invalid_payload.
    """

    def bad(code: str, message: str) -> LaissezError:
        return LaissezError(code, message, 400, method="POST", path="webhook")

    if not header:
        raise bad("invalid_signature", "The Laissez-Signature header is missing.")
    if not secret:
        raise bad("invalid_signature", "A webhook secret is required to verify the signature.")
    parts: Dict[str, List[str]] = {}
    for kv in header.split(","):
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        parts.setdefault(k.strip(), []).append(v.strip())
    try:
        t = int(parts["t"][0])
    except (KeyError, IndexError, ValueError):
        raise bad("invalid_signature", "The Laissez-Signature header is malformed. Expected t=<unix>,v1=<hex>.")
    sigs = parts.get("v1") or []
    if not sigs:
        raise bad("invalid_signature", "The Laissez-Signature header is malformed. Expected t=<unix>,v1=<hex>.")
    body = raw_body.decode("utf-8") if isinstance(raw_body, (bytes, bytearray)) else raw_body
    expected = _hmac_hex(secret, f"{t}.{body}")
    if not any(hmac.compare_digest(expected, s.lower()) for s in sigs):
        raise bad("invalid_signature", "The signature does not match this body and secret.")
    if tolerance_seconds > 0 and abs(now() - t) > tolerance_seconds:
        raise bad("signature_expired", f"The delivery is older than {tolerance_seconds} seconds.")
    try:
        return json.loads(body)
    except ValueError:
        raise bad("invalid_payload", "The signature is valid but the body is not JSON.")


def _query(params: Optional[Mapping[str, Any]]) -> str:
    if not params:
        return ""
    clean = {k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in params.items() if v is not None}
    return ("?" + urllib.parse.urlencode(clean)) if clean else ""


def _parse(res: Response) -> Any:
    if not res.body:
        return None
    text = res.body.decode("utf-8", errors="replace")
    ctype = res.header("content-type") or ""
    if "json" in ctype:
        try:
            return json.loads(text)
        except ValueError:
            return text
    try:
        return json.loads(text)
    except ValueError:
        return text


def _error(res: Response, parsed: Any, method: str, path: str) -> LaissezError:
    err = parsed.get("error") if isinstance(parsed, dict) else None
    if not isinstance(err, dict):
        err = {}
    code = err.get("code") or ("rate_limited" if res.status == 429 else f"http_{res.status}")
    message = err.get("message") or f"{method} {path} failed with status {res.status}."
    return LaissezError(code, message, res.status, err.get("detail"), method, path, res.header("cf-ray"))


def _backoff(attempt: int, retry_after: Optional[str]) -> float:
    if retry_after:
        try:
            secs = float(retry_after)
            if secs >= 0:
                return min(secs, 30.0)
        except ValueError:
            pass
    base = min(0.5 * (2 ** attempt), 8.0)
    return base / 2 + random.random() * base / 2


def create_sandbox(name: Optional[str] = None, base_url: str = DEFAULT_BASE_URL, version: str = DEFAULT_API_VERSION, transport: Optional[Transport] = None, timeout: float = 30.0) -> Dict[str, Any]:
    """POST /v1/sandboxes without a client. Returns workspace, api_key and session_token (shown once)."""
    t = transport or UrllibTransport()
    body = json.dumps({"name": name} if name else {}).encode("utf-8")
    res = t("POST", base_url.rstrip("/") + "/v1/sandboxes", {"content-type": "application/json", "accept": "application/json", "laissez-version": version}, body, timeout)
    parsed = _parse(res)
    if not 200 <= res.status < 300:
        raise _error(res, parsed, "POST", "/v1/sandboxes")
    return parsed


class Laissez:
    """The client. Pass ``api_key`` (lz_test_) or ``session_token`` (lz_sess_)."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        session_token: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        version: str = DEFAULT_API_VERSION,
        max_retries: int = 3,
        timeout: float = 30.0,
        auto_idempotency: bool = True,
        transport: Optional[Transport] = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        if not api_key and not session_token:
            raise ValueError("Laissez: pass api_key (lz_test_...) or session_token (lz_sess_...).")
        if api_key and session_token:
            raise ValueError("Laissez: pass api_key or session_token, not both.")
        self._token = api_key or session_token or ""
        self.base_url = base_url.rstrip("/")
        self.version = version
        self.max_retries = max_retries
        self.timeout = timeout
        self.auto_idempotency = auto_idempotency
        self._transport: Transport = transport or UrllibTransport()
        self._sleep = sleep
        self.last_response: Optional[Meta] = None

        self.decisions = Decisions(self)
        self.settlements = Settlements(self)
        self.investors = Investors(self)
        self.credentials = Credentials(self)
        self.funds = Funds(self)
        self.policy_changes = PolicyChanges(self)
        self.screening = Screening(self)
        self.work_items = WorkItems(self)
        self.monitoring = Monitoring(self)
        self.credential_shares = CredentialShares(self)
        self.travel_rule = TravelRule(self)
        self.reports = Reports(self)
        self.audit = Audit(self)
        self.api_keys = ApiKeys(self)
        self.webhooks = Webhooks(self)
        self.reference = Reference(self)

    # ---------- transport ----------
    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        query: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        max_retries: Optional[int] = None,
    ) -> Any:
        """Low-level request. Returns the parsed JSON body (or text for CSV)."""
        method = method.upper()
        url = f"{self.base_url}{path}{_query(query)}"
        hdrs: Dict[str, str] = {"authorization": f"Bearer {self._token}", "laissez-version": self.version, "accept": "application/json"}
        if headers:
            hdrs.update({k.lower(): v for k, v in headers.items()})
        payload: Optional[bytes] = None
        if body is not None:
            hdrs["content-type"] = "application/json"
            payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        write = method in _WRITE
        key = idempotency_key
        if write and not key and self.auto_idempotency:
            key = str(uuid.uuid4())
        if write and key:
            hdrs["idempotency-key"] = key
        # A write without an idempotency key is never retried: the first attempt may have been applied.
        retries = 0 if (write and not key) else (self.max_retries if max_retries is None else max_retries)

        attempt = 0
        while True:
            try:
                res = self._transport(method, url, hdrs, payload, self.timeout)
            except (OSError, urllib.error.URLError) as e:  # network failure, timeout, DNS
                if attempt >= retries:
                    raise LaissezError("network_error", f"Could not reach {self.base_url}: {e}", 0, method=method, path=path) from e
                self._sleep(_backoff(attempt, None))
                attempt += 1
                continue
            parsed = _parse(res)
            self.last_response = Meta(res.status, res.header("laissez-version"), (res.header("idempotent-replayed") or "").lower() == "true", res.header("cf-ray"))
            if 200 <= res.status < 300:
                return parsed
            retryable = res.status == 429 or (500 <= res.status <= 599 and res.status != 501)
            if retryable and attempt < retries:
                self._sleep(_backoff(attempt, res.header("retry-after")))
                attempt += 1
                continue
            raise _error(res, parsed, method, path)

    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.request("POST", path, {} if body is None else body, **kw)

    def patch(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.request("PATCH", path, {} if body is None else body, **kw)

    def put(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.request("PUT", path, {} if body is None else body, **kw)

    def delete(self, path: str, **kw: Any) -> Any:
        return self.request("DELETE", path, **kw)

    def csv(self, path: str, **kw: Any) -> str:
        return self.request("GET", path, headers={"accept": "text/csv"}, **kw)

    # ---------- organization ----------
    def me(self) -> Dict[str, Any]:
        """GET /v1/me: the signed-in person or the API key, and the organization."""
        return self.get("/v1/me")

    def workspace(self) -> Dict[str, Any]:
        return self.get("/v1/workspace")

    def metrics(self) -> Dict[str, Any]:
        return self.get("/v1/metrics")


def _q(s: str) -> str:
    return urllib.parse.quote(str(s), safe="")


def _drop_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


class _Resource:
    def __init__(self, client: Laissez):
        self._c = client


class Decisions(_Resource):
    def create(self, *, action: str, investor_id: str, fund: str, amount: float, settle_with: str, counterparty_id: Optional[str] = None, what_ifs: Optional[Sequence[str]] = None, persist: Optional[bool] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/decisions. Persisted decisions return a signed receipt. persist=False is a dry run."""
        body = _drop_none({"action": action, "investor_id": investor_id, "fund": fund, "amount": amount, "settle_with": settle_with, "counterparty_id": counterparty_id, "what_ifs": list(what_ifs) if what_ifs else None, "persist": persist})
        return self._c.post("/v1/decisions", body, idempotency_key=idempotency_key)

    def retrieve(self, decision_id: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/decisions/{_q(decision_id)}")

    def list(self, *, limit: Optional[int] = None, fund: Optional[str] = None, investor_id: Optional[str] = None) -> Dict[str, Any]:
        return self._c.get("/v1/decisions", query={"limit": limit, "fund": fund, "investor_id": investor_id})

    def replay(self, decision_id: str) -> Dict[str, Any]:
        """GET /v1/decisions/{id}/replay: re-runs the engine on the stored snapshot."""
        return self._c.get(f"/v1/decisions/{_q(decision_id)}/replay")

    def evaluate_as_of(self, *, action: str, investor_id: str, fund: str, amount: float, settle_with: str, as_of: str, counterparty_id: Optional[str] = None) -> Dict[str, Any]:
        body = _drop_none({"action": action, "investor_id": investor_id, "fund": fund, "amount": amount, "settle_with": settle_with, "as_of": as_of, "counterparty_id": counterparty_id})
        return self._c.post("/v1/evaluate/as-of", body)

    def bulk_eligibility(self, rows: Sequence[Mapping[str, Any]], funds: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        return self._c.post("/v1/eligibility/bulk", _drop_none({"rows": [dict(r) for r in rows], "funds": list(funds) if funds else None}))

    def backtest(self, ticker: str, policy: Mapping[str, Any], days: Optional[int] = None) -> Dict[str, Any]:
        body = dict(policy)
        if days is not None:
            body["days"] = days
        return self._c.post(f"/v1/funds/{_q(ticker)}/policy/backtest", body)


class Settlements(_Resource):
    def create(self, decision_id: str, *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/settlements. Returns status settled (201) or pending (202, on chain)."""
        return self._c.post("/v1/settlements", {"decision_id": decision_id}, idempotency_key=idempotency_key)

    def retrieve(self, settlement_id: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/settlements/{_q(settlement_id)}")

    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/settlements")

    def wait_until_settled(self, settlement_id: str, *, interval: float = 2.0, timeout: float = 120.0, clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
        """Poll until the settlement is settled. Raises settlement_reverted or settlement_timeout."""
        start = clock()
        path = f"/v1/settlements/{settlement_id}"
        while True:
            s = self.retrieve(settlement_id)
            if s.get("status") == "settled":
                return s
            if s.get("status") == "reverted":
                raise LaissezError("settlement_reverted", f"Settlement {settlement_id} reverted. Nothing moved.", 409, s, "GET", path)
            if clock() - start > timeout:
                raise LaissezError("settlement_timeout", f"Settlement {settlement_id} is still pending after {timeout} seconds.", 0, s, "GET", path)
            self._c._sleep(interval)


class Investors(_Resource):
    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/investors")

    def create(self, *, name: str, kind: str, residence: str, city: str, booking_center: str, us_person: Optional[bool] = None, wallet: Optional[str] = None, email: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        body = _drop_none({"name": name, "kind": kind, "residence": residence, "city": city, "booking_center": booking_center, "us_person": us_person, "wallet": wallet, "email": email})
        return self._c.post("/v1/investors", body, idempotency_key=idempotency_key)

    def retrieve(self, investor_id: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/investors/{_q(investor_id)}")

    def portal_invite(self, investor_id: str) -> Dict[str, Any]:
        return self._c.post(f"/v1/investors/{_q(investor_id)}/portal-invite")

    def revoke_portal_access(self, investor_id: str) -> Dict[str, Any]:
        return self._c.delete(f"/v1/investors/{_q(investor_id)}/portal-access")


class Credentials(_Resource):
    def list(self, *, expiring_within: Optional[int] = None) -> Dict[str, Any]:
        return self._c.get("/v1/credentials", query={"expiring_within": expiring_within})

    def issue(self, *, investor_id: str, classifications: Sequence[Mapping[str, Any]], valid_months: Optional[int] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/credentials. Every classification is checked against its threshold (422 threshold_not_met if one fails)."""
        body = _drop_none({"investor_id": investor_id, "classifications": [dict(c) for c in classifications], "valid_months": valid_months})
        return self._c.post("/v1/credentials", body, idempotency_key=idempotency_key)

    def revoke(self, credential_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
        return self._c.post(f"/v1/credentials/{_q(credential_id)}/revoke", _drop_none({"reason": reason}))


class Funds(_Resource):
    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/funds")

    def retrieve(self, ticker: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/funds/{_q(ticker)}")

    def create(self, **fund: Any) -> Dict[str, Any]:
        return self._c.post("/v1/funds", fund)

    def register(self, ticker: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/funds/{_q(ticker)}/register")

    def lifecycle(self, ticker: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/funds/{_q(ticker)}/lifecycle")

    def update_terms(self, ticker: str, **terms: Any) -> Dict[str, Any]:
        return self._c.patch(f"/v1/funds/{_q(ticker)}/terms", terms)

    def strike_nav(self, ticker: str, *, nav: float, date: Optional[str] = None, daily_yield_bps: Optional[float] = None, confirm: Optional[bool] = None) -> Dict[str, Any]:
        return self._c.post(f"/v1/funds/{_q(ticker)}/nav", _drop_none({"nav": nav, "date": date, "daily_yield_bps": daily_yield_bps, "confirm": confirm}))

    def run_accruals(self, ticker: str) -> Dict[str, Any]:
        return self._c.post(f"/v1/funds/{_q(ticker)}/accruals/run")

    def list_distributions(self, ticker: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/funds/{_q(ticker)}/distributions")

    def pay_distribution(self, ticker: str, **body: Any) -> Dict[str, Any]:
        return self._c.post(f"/v1/funds/{_q(ticker)}/distributions", body)

    def list_documents(self, ticker: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/funds/{_q(ticker)}/documents")

    def publish_document(self, ticker: str, **doc: Any) -> Dict[str, Any]:
        return self._c.post(f"/v1/funds/{_q(ticker)}/documents", doc)

    def retrieve_document(self, document_id: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/documents/{_q(document_id)}")

    def acknowledge_document(self, document_id: str, **body: Any) -> Dict[str, Any]:
        return self._c.post(f"/v1/documents/{_q(document_id)}/acknowledge", body)

    def acknowledgments(self, ticker: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/funds/{_q(ticker)}/acknowledgments")

    def list_redemption_notices(self) -> Dict[str, Any]:
        return self._c.get("/v1/redemption-notices")

    def file_redemption_notice(self, *, investor_id: str, ticker: str, units: float, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._c.post("/v1/redemption-notices", {"investor_id": investor_id, "ticker": ticker, "units": units}, idempotency_key=idempotency_key)

    def cancel_redemption_notice(self, notice_id: str) -> Dict[str, Any]:
        return self._c.delete(f"/v1/redemption-notices/{_q(notice_id)}")


class PolicyChanges(_Resource):
    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/policy-changes")

    def preview(self, ticker: str, policy: Mapping[str, Any]) -> Dict[str, Any]:
        """POST /v1/funds/{ticker}/policy/preview: impact on holders, nothing saved."""
        return self._c.post(f"/v1/funds/{_q(ticker)}/policy/preview", dict(policy))

    def propose(self, ticker: str, policy: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/funds/{ticker}/policy/changes. A different signed-in person must approve it."""
        return self._c.post(f"/v1/funds/{_q(ticker)}/policy/changes", dict(policy), idempotency_key=idempotency_key)

    def approve(self, change_id: str) -> Dict[str, Any]:
        """Sessions only. API keys get 403 human_required."""
        return self._c.post(f"/v1/policy-changes/{_q(change_id)}/approve")

    def reject(self, change_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
        return self._c.post(f"/v1/policy-changes/{_q(change_id)}/reject", _drop_none({"reason": reason}))


class Screening(_Resource):
    def screen(self, name: str) -> Dict[str, Any]:
        return self._c.post("/v1/screening", {"name": name})

    def sources(self) -> Dict[str, Any]:
        return self._c.get("/v1/sanctions/sources")

    def list_hits(self, status: Optional[str] = None) -> Dict[str, Any]:
        return self._c.get("/v1/screening-hits", query={"status": status})

    def decide_hit(self, hit_id: str, status: str, note: Optional[str] = None) -> Dict[str, Any]:
        return self._c.post(f"/v1/screening-hits/{_q(hit_id)}/decide", _drop_none({"status": status, "note": note}))


class WorkItems(_Resource):
    def list(self, status: Optional[str] = None) -> Dict[str, Any]:
        return self._c.get("/v1/work-items", query={"status": status})

    def resolve(self, item_id: str, status: str, note: Optional[str] = None) -> Dict[str, Any]:
        return self._c.post(f"/v1/work-items/{_q(item_id)}/resolve", _drop_none({"status": status, "note": note}))


class Monitoring(_Resource):
    def retrieve(self) -> Dict[str, Any]:
        return self._c.get("/v1/monitoring")

    def run(self) -> Dict[str, Any]:
        return self._c.post("/v1/monitoring/run")


class CredentialShares(_Resource):
    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/credential-shares")

    def request(self, *, lzid: str, purpose: str, booking_center: str, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._c.post("/v1/credential-shares", {"lzid": lzid, "purpose": purpose, "booking_center": booking_center}, idempotency_key=idempotency_key)

    def revoke(self, share_id: str, reason: str, all_recipients: bool = False) -> Dict[str, Any]:
        return self._c.post(f"/v1/credential-shares/{_q(share_id)}/revoke", {"reason": reason, "all_recipients": all_recipients})


class TravelRule(_Resource):
    def list(self, status: Optional[str] = None) -> Dict[str, Any]:
        return self._c.get("/v1/travel-rule/messages", query={"status": status})

    def retrieve(self, message_id: str) -> Dict[str, Any]:
        return self._c.get(f"/v1/travel-rule/messages/{_q(message_id)}")

    def start(self, decision_id: str) -> Dict[str, Any]:
        return self._c.post("/v1/travel-rule/messages", {"decision_id": decision_id})

    def retry(self, message_id: str) -> Dict[str, Any]:
        return self._c.post(f"/v1/travel-rule/messages/{_q(message_id)}/retry")

    def confirm(self, message_id: str, txid: str) -> Dict[str, Any]:
        return self._c.post(f"/v1/travel-rule/messages/{_q(message_id)}/confirm", {"txid": txid})


class Reports(_Resource):
    def placement(self) -> Dict[str, Any]:
        return self._c.get("/v1/reports/placement")

    def distribution(self) -> Dict[str, Any]:
        return self._c.get("/v1/reports/distribution")

    def placement_csv(self) -> str:
        return self._c.csv("/v1/reports/placement.csv")

    def decisions_csv(self) -> str:
        return self._c.csv("/v1/reports/decisions.csv")

    def register_by_jurisdiction_csv(self) -> str:
        return self._c.csv("/v1/reports/register-by-jurisdiction.csv")


class Audit(_Resource):
    def list(self, *, type: Optional[str] = None, actor: Optional[str] = None, before_seq: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """GET /v1/audit-events, newest first. Page with before_seq=next_before_seq."""
        return self._c.get("/v1/audit-events", query={"type": type, "actor": actor, "before_seq": before_seq, "limit": limit})

    def iter(self, **filters: Any) -> Iterable[Dict[str, Any]]:
        """Walk the whole log, newest first, following next_before_seq."""
        before: Optional[int] = None
        while True:
            page = self.list(before_seq=before, **filters)
            for ev in page.get("data", []):
                yield ev
            before = page.get("next_before_seq")
            if not before:
                return

    def verify(self) -> Dict[str, Any]:
        """GET /v1/audit-events/verify: recomputes every hash and checks the chain."""
        return self._c.get("/v1/audit-events/verify")

    def export_csv(self) -> str:
        return self._c.csv("/v1/audit-events.csv")

    def anchors(self) -> Dict[str, Any]:
        return self._c.get("/v1/audit-anchors")


class ApiKeys(_Resource):
    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/api-keys")

    def create(self, *, name: Optional[str] = None, scopes: Optional[Sequence[str]] = None, ip_allowlist: Optional[Sequence[str]] = None, expires_in_days: Optional[int] = None) -> Dict[str, Any]:
        """POST /v1/api-keys. The key is returned once."""
        return self._c.post("/v1/api-keys", _drop_none({"name": name, "scopes": list(scopes) if scopes else None, "ip_allowlist": list(ip_allowlist) if ip_allowlist is not None else None, "expires_in_days": expires_in_days}))

    def rotate(self, key_id: str) -> Dict[str, Any]:
        """POST /v1/api-keys/{id}/rotate. The old key keeps working for 24 hours."""
        return self._c.post(f"/v1/api-keys/{_q(key_id)}/rotate")

    def revoke(self, key_id: str) -> Dict[str, Any]:
        return self._c.delete(f"/v1/api-keys/{_q(key_id)}")


class Webhooks(_Resource):
    def list(self) -> Dict[str, Any]:
        return self._c.get("/v1/webhooks")

    def create(self, *, url: str, events: Sequence[str]) -> Dict[str, Any]:
        """POST /v1/webhooks. HTTPS only. The whsec_ secret is returned once."""
        return self._c.post("/v1/webhooks", {"url": url, "events": list(events)})

    def delete(self, webhook_id: str) -> Dict[str, Any]:
        return self._c.delete(f"/v1/webhooks/{_q(webhook_id)}")

    def test(self, webhook_id: str) -> Dict[str, Any]:
        return self._c.post(f"/v1/webhooks/{_q(webhook_id)}/test")

    def list_deliveries(self) -> Dict[str, Any]:
        return self._c.get("/v1/webhook-deliveries")

    def retrieve_delivery(self, delivery_id: Union[int, str]) -> Dict[str, Any]:
        return self._c.get(f"/v1/webhook-deliveries/{_q(delivery_id)}")

    def replay_delivery(self, delivery_id: Union[int, str]) -> Dict[str, Any]:
        return self._c.post(f"/v1/webhook-deliveries/{_q(delivery_id)}/replay")

    @staticmethod
    def verify(raw_body: Union[bytes, str], header: Optional[str], secret: str, tolerance_seconds: int = 300) -> Dict[str, Any]:
        """Same as laissez.verify_webhook."""
        return verify_webhook(raw_body, header, secret, tolerance_seconds)


class Reference(_Resource):
    def jurisdictions(self) -> Dict[str, Any]:
        return self._c.get("/v1/jurisdictions")

    def investor_classes(self) -> Dict[str, Any]:
        return self._c.get("/v1/investor-classes")

    def booking_centers(self) -> Dict[str, Any]:
        return self._c.get("/v1/booking-centers")

    def rule_packs(self) -> Dict[str, Any]:
        return self._c.get("/v1/rule-packs")

    def signing_key(self) -> Dict[str, Any]:
        return self._c.get("/v1/signing-key")

    def verify_receipt(self, receipt: Mapping[str, Any], signature: str) -> Dict[str, Any]:
        return self._c.post("/v1/receipts/verify", {"receipt": dict(receipt), "signature": signature})
