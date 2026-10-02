"""Tests for the Laissez Python SDK with a fake transport. Run: python3 -m unittest discover -s tests"""

import hashlib
import hmac
import json
import os
import sys
import unittest
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from laissez import Laissez, LaissezError, Response, create_sandbox, verify_webhook  # noqa: E402


class FakeTransport:
    """Records calls and plays back scripted replies in order (the last reply repeats)."""

    def __init__(self, replies: List[Dict[str, Any]]):
        self.replies = replies
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, method: str, url: str, headers, body: Optional[bytes], timeout: float) -> Response:
        self.calls.append({"method": method, "url": url, "headers": {k.lower(): v for k, v in headers.items()}, "body": json.loads(body) if body else None, "timeout": timeout})
        r = self.replies[min(len(self.calls) - 1, len(self.replies) - 1)]
        if "raises" in r:
            raise r["raises"]
        payload = r.get("body")
        if isinstance(payload, str):
            data, ctype = payload.encode(), "text/csv"
        elif payload is None:
            data, ctype = b"", "application/json"
        else:
            data, ctype = json.dumps(payload).encode(), "application/json"
        hdrs = {"content-type": ctype, "laissez-version": "2026-10-02"}
        hdrs.update(r.get("headers", {}))
        return Response(r.get("status", 200), hdrs, data)


def client(replies, **kw):
    t = FakeTransport(replies)
    kw.setdefault("api_key", "lz_test_abc")
    c = Laissez(transport=t, sleep=lambda s: None, **kw)
    return c, t


def paths(t: FakeTransport):
    return [f"{c['method']} {c['url'].replace('https://laissez-api.laissez.workers.dev', '')}" for c in t.calls]


class ClientTests(unittest.TestCase):
    def test_constructor(self):
        with self.assertRaises(ValueError):
            Laissez()
        with self.assertRaises(ValueError):
            Laissez(api_key="a", session_token="b")
        c = Laissez(api_key="k", base_url="https://api.example/")
        self.assertEqual(c.base_url, "https://api.example")
        self.assertEqual(c.version, "2026-10-02")

    def test_headers_and_query(self):
        c, t = client([{"body": {"data": []}}], version="2026-10-01")
        c.decisions.list(limit=5, fund="TWLF")
        call = t.calls[0]
        self.assertEqual(call["url"], "https://laissez-api.laissez.workers.dev/v1/decisions?limit=5&fund=TWLF")
        self.assertEqual(call["headers"]["authorization"], "Bearer lz_test_abc")
        self.assertEqual(call["headers"]["laissez-version"], "2026-10-01")
        self.assertNotIn("idempotency-key", call["headers"])
        self.assertEqual(c.last_response.status, 200)
        self.assertEqual(c.last_response.version, "2026-10-02")

    def test_write_gets_idempotency_key(self):
        c, t = client([{"status": 201, "body": {"id": "dec_1", "outcome": "ALLOW"}}])
        d = c.decisions.create(action="subscribe", investor_id="lumen", fund="TWLF", amount=250000, settle_with="USDC")
        self.assertEqual(d["outcome"], "ALLOW")
        self.assertRegex(t.calls[0]["headers"]["idempotency-key"], r"^[0-9a-f-]{36}$")
        self.assertEqual(t.calls[0]["headers"]["content-type"], "application/json")
        self.assertEqual(t.calls[0]["body"], {"action": "subscribe", "investor_id": "lumen", "fund": "TWLF", "amount": 250000, "settle_with": "USDC"})
        c.settlements.create("dec_1", idempotency_key="order-42")
        self.assertEqual(t.calls[1]["headers"]["idempotency-key"], "order-42")
        self.assertEqual(t.calls[1]["body"], {"decision_id": "dec_1"})

    def test_replayed_flag(self):
        c, _ = client([{"status": 201, "body": {"id": "stl_1"}, "headers": {"idempotent-replayed": "true"}}])
        c.settlements.create("dec_1")
        self.assertTrue(c.last_response.idempotent_replayed)

    def test_no_auto_idempotency_means_no_retry_on_writes(self):
        c, t = client([{"status": 503, "body": {"error": {"code": "unavailable", "message": "down"}}}], auto_idempotency=False, max_retries=3)
        with self.assertRaises(LaissezError) as cm:
            c.settlements.create("dec_1")
        self.assertEqual(cm.exception.code, "unavailable")
        self.assertEqual(cm.exception.status, 503)
        self.assertEqual(len(t.calls), 1)
        self.assertNotIn("idempotency-key", t.calls[0]["headers"])

    def test_error_mapping(self):
        c, _ = client([{"status": 422, "body": {"error": {"code": "threshold_not_met", "message": "Nothing was issued.", "detail": [{"class_code": "HK_PI", "pass": False}]}}}])
        with self.assertRaises(LaissezError) as cm:
            c.credentials.issue(investor_id="meitan", classifications=[{"class_code": "HK_PI", "evidence": {"portfolio_hkd": 1}}])
        e = cm.exception
        self.assertEqual((e.code, e.status, e.message), ("threshold_not_met", 422, "Nothing was issued."))
        self.assertEqual(e.detail, [{"class_code": "HK_PI", "pass": False}])
        self.assertEqual((e.method, e.path), ("POST", "/v1/credentials"))
        self.assertFalse(e.is_permission)
        self.assertEqual(str(e), "Nothing was issued.")

    def test_retries_429_and_5xx_then_succeeds(self):
        c, t = client([
            {"status": 429, "body": {"error": {"code": "rate_limited", "message": "slow"}}, "headers": {"retry-after": "0"}},
            {"status": 502, "body": {"error": {"code": "bad_gateway", "message": "upstream"}}},
            {"body": {"data": [{"id": "lumen"}]}},
        ], max_retries=3)
        page = c.investors.list()
        self.assertEqual(page["data"][0]["id"], "lumen")
        self.assertEqual(len(t.calls), 3)

    def test_gives_up_after_max_retries(self):
        c, t = client([{"status": 429, "body": {"error": {"code": "rate_limited", "message": "More than 300 requests in a minute."}}, "headers": {"retry-after": "0"}}], max_retries=2)
        with self.assertRaises(LaissezError) as cm:
            c.funds.list()
        self.assertTrue(cm.exception.is_rate_limited)
        self.assertEqual(len(t.calls), 3)

    def test_does_not_retry_other_4xx(self):
        c, t = client([{"status": 404, "body": {"error": {"code": "not_found", "message": "No decision."}}}], max_retries=3)
        with self.assertRaises(LaissezError):
            c.decisions.retrieve("dec_x")
        self.assertEqual(len(t.calls), 1)

    def test_retries_network_errors_with_same_key(self):
        c, t = client([{"raises": OSError("connection reset")}, {"status": 201, "body": {"id": "stl_1", "status": "settled"}}], max_retries=2)
        s = c.settlements.create("dec_1")
        self.assertEqual(s["status"], "settled")
        self.assertEqual(len(t.calls), 2)
        self.assertEqual(t.calls[0]["headers"]["idempotency-key"], t.calls[1]["headers"]["idempotency-key"])

    def test_network_error_after_last_retry(self):
        c, _ = client([{"raises": OSError("dns")}], max_retries=1)
        with self.assertRaises(LaissezError) as cm:
            c.me()
        self.assertEqual((cm.exception.code, cm.exception.status), ("network_error", 0))

    def test_wait_until_settled(self):
        c, t = client([
            {"body": {"id": "stl_1", "status": "pending"}},
            {"body": {"id": "stl_1", "status": "pending"}},
            {"body": {"id": "stl_1", "status": "settled"}},
        ])
        s = c.settlements.wait_until_settled("stl_1", interval=0)
        self.assertEqual(s["status"], "settled")
        self.assertEqual(len(t.calls), 3)
        self.assertEqual(paths(t)[0], "GET /v1/settlements/stl_1")

    def test_wait_until_settled_revert_and_timeout(self):
        c, _ = client([{"body": {"id": "stl_2", "status": "reverted"}}])
        with self.assertRaises(LaissezError) as cm:
            c.settlements.wait_until_settled("stl_2")
        self.assertEqual(cm.exception.code, "settlement_reverted")
        c, _ = client([{"body": {"id": "stl_3", "status": "pending"}}])
        ticks = iter([0, 1, 2, 200])
        with self.assertRaises(LaissezError) as cm:
            c.settlements.wait_until_settled("stl_3", interval=0, timeout=100, clock=lambda: next(ticks))
        self.assertEqual(cm.exception.code, "settlement_timeout")

    def test_resource_paths(self):
        c, t = client([{"body": {}}], api_key=None, session_token="lz_sess_1")
        c.decisions.replay("dec_1")
        c.investors.retrieve("lumen")
        c.credentials.revoke("LP-SG-0419-2207", "Client left")
        c.credentials.list(expiring_within=30)
        c.funds.register("TWLF")
        c.policy_changes.propose("TWLF", {"distribution": [{"jurisdiction": "SG", "accepts": ["SG_AI"]}]})
        c.policy_changes.approve("pc_1")
        c.screening.screen("Qamar Holdings Ltd")
        c.screening.decide_hit("hit_1", "false_positive", "Different DOB")
        c.work_items.list(status="all")
        c.monitoring.run()
        c.credential_shares.request(lzid="LZ-7K2M-9QX4-PA3D", purpose="Subscription", booking_center="SG")
        c.travel_rule.confirm("trm_1", "0xabc")
        c.audit.list(before_seq=40, limit=10)
        c.audit.verify()
        c.api_keys.rotate("key_1")
        c.api_keys.revoke("key_1")
        c.webhooks.create(url="https://ops.example/hooks", events=["*"])
        c.webhooks.replay_delivery(12)
        c.reference.rule_packs()
        self.assertEqual(paths(t), [
            "GET /v1/decisions/dec_1/replay",
            "GET /v1/investors/lumen",
            "POST /v1/credentials/LP-SG-0419-2207/revoke",
            "GET /v1/credentials?expiring_within=30",
            "GET /v1/funds/TWLF/register",
            "POST /v1/funds/TWLF/policy/changes",
            "POST /v1/policy-changes/pc_1/approve",
            "POST /v1/screening",
            "POST /v1/screening-hits/hit_1/decide",
            "GET /v1/work-items?status=all",
            "POST /v1/monitoring/run",
            "POST /v1/credential-shares",
            "POST /v1/travel-rule/messages/trm_1/confirm",
            "GET /v1/audit-events?before_seq=40&limit=10",
            "GET /v1/audit-events/verify",
            "POST /v1/api-keys/key_1/rotate",
            "DELETE /v1/api-keys/key_1",
            "POST /v1/webhooks",
            "POST /v1/webhook-deliveries/12/replay",
            "GET /v1/rule-packs",
        ])
        self.assertEqual(t.calls[2]["body"], {"reason": "Client left"})
        self.assertEqual(t.calls[8]["body"], {"status": "false_positive", "note": "Different DOB"})
        self.assertIn("idempotency-key", t.calls[16]["headers"])
        self.assertEqual(t.calls[0]["headers"]["authorization"], "Bearer lz_sess_1")

    def test_audit_iter_follows_pages(self):
        c, t = client([
            {"body": {"data": [{"seq": 3}, {"seq": 2}], "next_before_seq": 2}},
            {"body": {"data": [{"seq": 1}], "next_before_seq": None}},
        ])
        seqs = [e["seq"] for e in c.audit.iter(type="decision")]
        self.assertEqual(seqs, [3, 2, 1])
        self.assertEqual(paths(t), ["GET /v1/audit-events?type=decision", "GET /v1/audit-events?type=decision&before_seq=2"])

    def test_csv(self):
        c, t = client([{"body": "seq,type\n1,decision.created\n"}])
        csv = c.audit.export_csv()
        self.assertTrue(csv.startswith("seq,type"))
        self.assertEqual(t.calls[0]["headers"]["accept"], "text/csv")

    def test_create_sandbox(self):
        t = FakeTransport([{"status": 201, "body": {"workspace": {"id": "w1"}, "api_key": "lz_test_new", "session_token": "lz_sess_new"}}])
        sb = create_sandbox("Aster & Vale sandbox", transport=t)
        self.assertEqual(sb["api_key"], "lz_test_new")
        self.assertNotIn("authorization", t.calls[0]["headers"])
        self.assertEqual(t.calls[0]["body"], {"name": "Aster & Vale sandbox"})
        t = FakeTransport([{"status": 429, "body": {"error": {"code": "rate_limited", "message": "10 sandboxes an hour."}}}])
        with self.assertRaises(LaissezError):
            create_sandbox(transport=t)


class WebhookTests(unittest.TestCase):
    secret = "whsec_test_secret_0123456789"
    body = json.dumps({"id": "evt_1", "type": "settlement.completed", "created": "2026-10-02T06:23:14.000Z", "data": {"id": "stl_4WN8PQ2KD7ZT", "decision": "dec_8KQ2M4ZP7WXA", "units": 250000, "fund": "TWLF"}})
    t = 1_790_000_000

    def sig(self, body=None, secret=None, t=None):
        return hmac.new((secret or self.secret).encode(), f"{t or self.t}.{body or self.body}".encode(), hashlib.sha256).hexdigest()

    def now(self):
        return self.t + 10

    def test_valid(self):
        ev = verify_webhook(self.body, f"t={self.t},v1={self.sig()}", self.secret, 300, now=self.now)
        self.assertEqual(ev["type"], "settlement.completed")
        self.assertEqual(ev["data"]["id"], "stl_4WN8PQ2KD7ZT")
        verify_webhook(self.body.encode(), f"t={self.t},v1=deadbeef,v1={self.sig()}", self.secret, 300, now=self.now)
        verify_webhook(self.body, f"t={self.t},v1={self.sig()}", self.secret, 0, now=lambda: self.t + 100_000)

    def test_rejects(self):
        def expect(code, body, header, secret=None, tolerance=300, now=None):
            with self.assertRaises(LaissezError) as cm:
                verify_webhook(body, header, self.secret if secret is None else secret, tolerance, now=now or self.now)
            self.assertEqual(cm.exception.code, code)

        expect("invalid_signature", self.body.replace("250000", "250001"), f"t={self.t},v1={self.sig()}")
        expect("invalid_signature", self.body, f"t={self.t},v1={self.sig()}", secret="whsec_other")
        expect("invalid_signature", self.body, f"t={self.t + 1},v1={self.sig()}")
        expect("signature_expired", self.body, f"t={self.t},v1={self.sig()}", now=lambda: self.t + 301)
        expect("invalid_signature", self.body, None)
        expect("invalid_signature", self.body, "garbage")
        expect("invalid_signature", self.body, f"t=abc,v1={self.sig()}")
        expect("invalid_signature", self.body, f"t={self.t},v1={self.sig()}", secret="")
        expect("invalid_payload", "not json", f"t={self.t},v1={self.sig(body='not json')}")

    def test_client_alias(self):
        c, _ = client([{"body": {}}])
        ev = c.webhooks.verify(self.body, f"t={self.t},v1={self.sig()}", self.secret, 0)
        self.assertEqual(ev["id"], "evt_1")


if __name__ == "__main__":
    unittest.main()
