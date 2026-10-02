"""Laissez SDK for Python. Standard library only.

    from laissez import Laissez
    client = Laissez(api_key="lz_test_...")
    decision = client.decisions.create(action="subscribe", investor_id="lumen", fund="TWLF", amount=250000, settle_with="USDC")

Writes carry an Idempotency-Key automatically. 429 and 5xx responses and network errors are retried with
exponential backoff. Every non-2xx response raises LaissezError with code, status and detail.
"""

from .client import (
    DEFAULT_API_VERSION,
    DEFAULT_BASE_URL,
    SDK_VERSION,
    Laissez,
    LaissezError,
    Response,
    Transport,
    UrllibTransport,
    create_sandbox,
    verify_webhook,
)

__all__ = [
    "Laissez",
    "LaissezError",
    "Response",
    "Transport",
    "UrllibTransport",
    "create_sandbox",
    "verify_webhook",
    "SDK_VERSION",
    "DEFAULT_BASE_URL",
    "DEFAULT_API_VERSION",
]
__version__ = SDK_VERSION
