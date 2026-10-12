"""Directory tokens are not wildcard fact tokens; malformed input fails closed."""

import base64
import hashlib
import hmac
import json
from dataclasses import replace

import pytest

from shopgate_commerce_data.ledger.datasets import DatasetPlan
from shopgate_commerce_data.ledger.scope import (
    ScopeError,
    verify_directory_token,
    verify_scope_token,
)

SECRET = "directory-only-test-key-not-a-real-credential"


def signed(**overrides):
    claims = {
        "aud": "shopgate-bi-directory-v1",
        "workspace_id": "account:member-a",
        "actor_id": "member-a",
        "capabilities": ["datasets.read", "datasets.manage"],
        "iat": 100,
        "exp": 200,
    }
    claims.update(overrides)
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    return f"{encoded}.{signature}"


def test_directory_scope_has_no_dataset_or_version_and_cannot_read_facts():
    scope = verify_directory_token(signed(), SECRET, now=150)
    assert scope.workspace_id == "account:member-a" and scope.actor_id == "member-a"
    assert not hasattr(scope, "dataset_id") and not hasattr(scope, "version")
    scope.require("datasets.manage")
    with pytest.raises(ScopeError):
        scope.require("ledger.read")
    with pytest.raises(ScopeError):
        verify_scope_token(signed(), SECRET, now=150)


def test_ledger_token_cannot_be_reused_as_directory_authorization():
    token = signed(
        aud="shopgate-bi-v1",
        dataset_id="demo",
        version=1,
        capabilities=["ledger.read", "ledger.manage"],
    )
    assert verify_scope_token(token, SECRET, now=150).dataset_id == "demo"
    with pytest.raises(ScopeError):
        verify_directory_token(token, SECRET, now=150)


@pytest.mark.parametrize(
    "change",
    [
        {"exp": 150},
        {"iat": 151},
        {"iat": -1},
        {"exp": 500},
        {"iat": True},
        {"aud": "shopgate-bi-v1"},
        {"dataset_id": "*"},
        {"version": 1},
        {"actor_id": "../private"},
        {"workspace_id": ""},
        {"actor_id": None},
        {"capabilities": ["ledger.read"]},
        {"capabilities": ["datasets.read", "datasets.read"]},
        {"capabilities": "datasets.manage"},
        {"capabilities": []},
        {"browser_role": "owner"},
    ],
)
def test_directory_rejects_expired_extra_forged_or_unknown_claims(change):
    with pytest.raises(ScopeError):
        verify_directory_token(signed(**change), SECRET, now=150)


@pytest.mark.parametrize(
    "token", [None, 1, {}, "", "one.two.three", "abc.非ASCII", "abc." + "A" * 43]
)
def test_malformed_token_is_scope_error_not_a_crash(token):
    for verifier in (verify_directory_token, verify_scope_token):
        with pytest.raises(ScopeError):
            verifier(token, SECRET, now=150)


def test_read_only_directory_cannot_create():
    scope = verify_directory_token(signed(capabilities=["datasets.read"]), SECRET, now=150)
    with pytest.raises(ScopeError):
        scope.require("datasets.manage")
    with pytest.raises(ScopeError):
        verify_directory_token(signed(), "short", now=150)


@pytest.mark.parametrize(
    "change",
    [
        {"dataset_id": "../private"},
        {"dataset_id": ""},
        {"name": ""},
        {"name": " leading"},
        {"name": "x\n"},
        {"name": "x" * 201},
        {"name": None},
        {"source_kind": "observed"},
        {"source_kind": []},
    ],
)
def test_dataset_plan_rejects_ambiguous_invalid_sources_and_names(change):
    with pytest.raises(ValueError):
        replace(DatasetPlan("new-data", "正式数据", "import"), **change).validate()
