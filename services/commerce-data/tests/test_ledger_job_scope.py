import json
import time

import httpx
import pytest

from shopgate_commerce_data.ledger.job_scope import (
    CurrentAuthorization,
    authorization_claims,
    sign_claims,
    verify_grant,
    verify_job_scope,
)
from shopgate_commerce_data.ledger.scope import (
    ScopeError,
    verify_directory_token,
    verify_scope_token,
)
from shopgate_commerce_data.routers.bi import (
    MAX_UPLOAD_JSON_BYTES,
    BiInputError,
    JobFileInput,
    decode_files,
)

SECRET = "private-job-scope-test-not-a-real-credential"
JOB = {
    "workspace_id": "account:a",
    "dataset_id": "demo",
    "actor_id": "a",
    "session_id": "session-a",
    "base_version": 1,
    "job_id": "job-a",
    "kind": "confirm_import",
    "request_hash": "a" * 64,
}


def job_claims(**changes):
    return {
        "aud": "shopgate-bi-jobs-v1",
        "workspace_id": "account:a",
        "dataset_id": "demo",
        "actor_id": "a",
        "session_id": "session-a",
        "version": 1,
        "capabilities": ["jobs.read", "jobs.manage"],
        "iat": 100,
        "exp": 200,
        **changes,
    }


def grant(job=JOB, phase="commit", **changes):
    now = int(time.time())
    return sign_claims(
        {
            **authorization_claims(job, phase, now=now),
            "aud": "shopgate-bi-job-grant-v1",
            "capabilities": ["job.authorized"],
            "exp": now + 20,
            **changes,
        },
        SECRET,
    )


def test_job_scope_keeps_actual_session_private_and_is_never_a_fact_or_directory_token():
    token = sign_claims(job_claims(), SECRET)
    scope = verify_job_scope(token, SECRET, now=150)
    assert scope.session_id == "session-a" and scope.ledger().version == 1
    scope.require("jobs.manage")
    for verify in (verify_scope_token, verify_directory_token):
        with pytest.raises(ScopeError):
            verify(token, SECRET, now=150)
    with pytest.raises(ScopeError):
        verify_job_scope(sign_claims(job_claims(aud="shopgate-bi-v1"), SECRET), SECRET, now=150)


@pytest.mark.parametrize(
    "change",
    [
        {"session_id": "../bad"},
        {"session_id": None},
        {"version": True},
        {"version": 2**53},
        {"capabilities": ["ledger.manage"]},
        {"capabilities": ["jobs.read", "jobs.read"]},
        {"exp": 150},
        {"actor_id": "bad/path"},
        {"cookie": "private"},
    ],
)
def test_invalid_job_identity_version_or_extra_credentials_rejected(change):
    with pytest.raises(ScopeError):
        verify_job_scope(sign_claims(job_claims(**change), SECRET), SECRET, now=150)


def test_grant_binds_every_field_and_phase_and_has_no_general_fact_authority():
    token = grant()
    verify_grant(token, SECRET, JOB, "commit")
    for key, value in {
        "workspace_id": "foreign",
        "dataset_id": "foreign",
        "actor_id": "other",
        "session_id": "other",
        "base_version": 2,
        "job_id": "other",
        "kind": "export_standard",
        "request_hash": "b" * 64,
    }.items():
        with pytest.raises(ScopeError):
            verify_grant(token, SECRET, {**JOB, key: value}, "commit")
    with pytest.raises(ScopeError):
        verify_grant(token, SECRET, JOB, "start")
    with pytest.raises(ScopeError):
        verify_scope_token(token, SECRET)
    with pytest.raises(ScopeError):
        verify_grant(grant(exp=int(time.time()) + 21), SECRET, JOB, "commit")


@pytest.mark.parametrize(
    "origin",
    [
        "file:///private",
        "https://user:password@host",
        "http://host/private",
        "http://host?token=secret",
        "http://host#private",
        "",
    ],
)
def test_authorization_service_origin_is_fixed_and_not_a_browser_url(origin):
    with pytest.raises(ScopeError):
        CurrentAuthorization(origin, SECRET)


def test_current_authorization_checks_signed_response_and_never_follows_redirects():
    def respond(request):
        assert request.url.path == "/api/internal/bi/job-authorization"
        assert "cookie" not in request.headers
        return httpx.Response(200, json={"success": True, "data": {"token": grant(phase="start")}})

    current = CurrentAuthorization(
        "http://127.0.0.1:3000", SECRET, transport=httpx.MockTransport(respond)
    )
    verify_grant(current(JOB, "start"), SECRET, JOB, "start")
    for response in [
        httpx.Response(302, headers={"location": "https://foreign"}),
        httpx.Response(403, text="private SQL"),
        httpx.Response(200, json={"success": True, "data": {"token": "forged"}}),
        httpx.Response(200, content=b"x" * 8193),
    ]:
        checker = CurrentAuthorization(
            "http://127.0.0.1:3000",
            SECRET,
            transport=httpx.MockTransport(lambda _, response=response: response),
        )
        with pytest.raises(ScopeError, match="授权"):
            checker(JOB, "start")


def test_base64_upload_accounts_for_encoded_overhead_and_decodes_strictly():
    assert MAX_UPLOAD_JSON_BYTES == 80 * 1024 * 1024 + 64 * 1024
    assert (
        decode_files(
            [JobFileInput(resource="products", filename="商品.csv", content_base64="YWJj")]
        )[0].content
        == b"abc"
    )
    for invalid in ["!", " YWJj", "é", "=bad"]:
        with pytest.raises(BiInputError):
            decode_files(
                [JobFileInput(resource="products", filename="bad.csv", content_base64=invalid)]
            )


def test_authorization_request_can_be_verified_without_source_cells_or_credentials():
    claim = authorization_claims(JOB, "start", now=100)
    assert "token" not in claim and "cookie" not in claim and "payload" not in claim
    assert len(json.dumps(claim)) < 2048 and claim["exp"] == 125
