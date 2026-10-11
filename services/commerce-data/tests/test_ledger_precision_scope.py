from __future__ import annotations

import base64
import hashlib
import hmac
import json
from decimal import Decimal

import pytest

from shopgate_commerce_data.ledger.precision import decimal_text, exact_decimal
from shopgate_commerce_data.ledger.scope import ScopeError, verify_scope_token

TEST_SECRET = "ledger-only-test-key-not-a-real-credential"


def signed_claims(**overrides):
    claims = {
        "aud": "shopgate-bi-v1",
        "workspace_id": "space-a",
        "dataset_id": "demo",
        "actor_id": "user-a",
        "version": 1,
        "capabilities": ["ledger.read", "ledger.manage"],
        "iat": 100,
        "exp": 200,
    }
    claims.update(overrides)
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(TEST_SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    return f"{encoded}.{signature}"


@pytest.mark.parametrize(
    ("value", "kind"),
    [
        (0.1, "money"),
        (True, "money"),
        ("NaN", "money"),
        ("Infinity", "money"),
        ("-Infinity", "money"),
        ("1e2", "money"),
        ("01.20", "money"),
        (" 1", "money"),
        ("0.001", "money"),
        ("2.00001", "quantity"),
        ("-0.1", "unit_cost"),
        ("0", "fx_rate"),
        ("0.000000001", "fx_rate"),
        ("10000000000000000", "money"),
        (Decimal("NaN"), "quantity"),
        (Decimal("Infinity"), "quantity"),
        (Decimal("1e99999999"), "money"),
    ],
)
def test_precision_rejects_loss_nonfinite_and_overflow(value, kind):
    with pytest.raises(ValueError):
        exact_decimal(value, kind)


def test_precise_decimal_strings_and_unknown_not_zero():
    assert decimal_text(exact_decimal("123456789.12", "money"), "money") == "123456789.12"
    assert decimal_text(Decimal("0"), "unit_cost") == "0.0000"
    assert decimal_text(None, "unit_cost") is None
    assert decimal_text(Decimal("7.12345678"), "fx_rate") == "7.12345678"


def test_verified_gateway_scope_has_capabilities():
    scope = verify_scope_token(signed_claims(), TEST_SECRET, now=150)
    assert scope.workspace_id == "space-a"
    scope.require("ledger.manage")
    with pytest.raises(ScopeError):
        scope.require("arbitrary.sql")


@pytest.mark.parametrize(
    "claims",
    [
        {"exp": 150},
        {"iat": 151},
        {"exp": 500},
        {"version": True},
        {"version": 0},
        {"version": 2**63},
        {"aud": "another-service"},
        {"actor_id": "../private"},
        {"dataset_id": ""},
        {"capabilities": ["admin"]},
        {"capabilities": ["ledger.read", "ledger.read"]},
        {"capabilities": "ledger.manage"},
        {"unexpected_browser_identity": "owner"},
    ],
)
def test_expired_forged_and_unknown_scope_claims_are_rejected(claims):
    with pytest.raises(ScopeError):
        verify_scope_token(signed_claims(**claims), TEST_SECRET, now=150)


def test_bad_signature_and_weak_configuration_fail_closed():
    with pytest.raises(ScopeError):
        verify_scope_token(signed_claims() + "forged", TEST_SECRET, now=150)
    with pytest.raises(ScopeError):
        verify_scope_token(signed_claims(), "short", now=150)


def test_read_scope_cannot_manage():
    scope = verify_scope_token(signed_claims(capabilities=["ledger.read"]), TEST_SECRET, now=150)
    with pytest.raises(ScopeError):
        scope.require("ledger.manage")
