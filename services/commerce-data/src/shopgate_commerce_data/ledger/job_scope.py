"""Purpose-separated queue scopes and current-authority service grants.

Session IDs are private database references, not bearer credentials. No cookie or
long-lived service token is persisted in a job; grants are checked, then discarded.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from shopgate_commerce_data.ledger.scope import (
    IDENTIFIER,
    TOKEN_FIELDS,
    LedgerScope,
    ScopeError,
    _verified_claims,
)

JOB_KINDS = frozenset({"preview_import", "prepare_demo", "confirm_import", "export_standard"})
JOB_FIELDS = TOKEN_FIELDS | {"session_id"}
AUTH_FIELDS = JOB_FIELDS | {"job_id", "kind", "request_hash", "phase"}


@dataclass(frozen=True)
class JobScope:
    workspace_id: str
    dataset_id: str
    actor_id: str
    version: int
    capabilities: frozenset[str]
    session_id: str

    def require(self, capability):
        if capability not in self.capabilities:
            raise ScopeError("当前身份没有此经营任务权限。")

    def ledger(self):
        self.require("jobs.read")
        capabilities = {"ledger.read"}
        if "jobs.manage" in self.capabilities:
            capabilities.add("ledger.manage")
        return LedgerScope(
            self.workspace_id, self.dataset_id, self.actor_id, self.version, frozenset(capabilities)
        )


def verify_job_scope(token, secret, *, now=None):
    claims = _verified_claims(
        token,
        secret,
        now=now,
        audience="shopgate-bi-jobs-v1",
        fields=JOB_FIELDS,
        capabilities=frozenset({"jobs.read", "jobs.manage"}),
    )
    if (
        not isinstance(claims["session_id"], str)
        or not IDENTIFIER.fullmatch(claims["session_id"])
        or type(claims["version"]) is not int
        or not 0 < claims["version"] < 2**53
    ):
        raise ScopeError("经营任务会话或版本无效。")
    return JobScope(
        claims["workspace_id"],
        claims["dataset_id"],
        claims["actor_id"],
        claims["version"],
        frozenset(claims["capabilities"]),
        claims["session_id"],
    )


def sign_claims(claims, secret):
    if not isinstance(secret, str) or len(secret.encode()) < 32:
        raise ScopeError("经营任务服务签名未配置。")
    encoded = (
        base64.urlsafe_b64encode(
            json.dumps(
                claims,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(
                secret.encode(),
                encoded.encode(),
                hashlib.sha256,
            ).digest()
        )
        .decode()
        .rstrip("=")
    )
    return f"{encoded}.{signature}"


def authorization_claims(job, phase, *, now=None):
    if phase not in {"start", "commit"} or job["kind"] not in JOB_KINDS:
        raise ScopeError("经营任务授权阶段无效。")
    current = int(time.time()) if now is None else now
    return {
        "aud": "shopgate-bi-job-auth-v1",
        "capabilities": ["job.authorize"],
        "workspace_id": job["workspace_id"],
        "dataset_id": job["dataset_id"],
        "actor_id": job["actor_id"],
        "session_id": job["session_id"],
        "version": job["base_version"],
        "job_id": job["job_id"],
        "kind": job["kind"],
        "request_hash": job["request_hash"],
        "phase": phase,
        "iat": current,
        "exp": current + 25,
    }


def verify_grant(token, secret, job, phase, *, now=None):
    claims = _verified_claims(
        token,
        secret,
        now=now,
        audience="shopgate-bi-job-grant-v1",
        fields=AUTH_FIELDS,
        capabilities=frozenset({"job.authorized"}),
    )
    expected = authorization_claims(job, phase, now=now)
    for key in AUTH_FIELDS - {"aud", "capabilities", "iat", "exp"}:
        if type(claims[key]) is not type(expected[key]) or claims[key] != expected[key]:
            raise ScopeError("经营任务授权与当前任务不一致。")
    if claims["exp"] - claims["iat"] > 20:
        raise ScopeError("经营任务授权期限无效。")


class CurrentAuthorization:
    """Fixed trusted Node service origin; test transport cannot reach a user DB."""

    def __init__(self, origin, secret, *, transport=None):
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ScopeError("经营任务授权服务地址无效。")
        if not isinstance(secret, str) or len(secret.encode()) < 32:
            raise ScopeError("经营任务授权服务签名未配置。")
        self.url = origin.rstrip("/") + "/api/internal/bi/job-authorization"
        self.secret, self.transport = secret, transport

    def __call__(self, job, phase):
        request = sign_claims(authorization_claims(job, phase), self.secret)
        try:
            with (
                httpx.Client(
                    timeout=5, follow_redirects=False, transport=self.transport, trust_env=False
                ) as client,
                client.stream(
                    "POST",
                    self.url,
                    headers={"authorization": f"Bearer {request}"},
                ) as response,
            ):
                if response.status_code != 200:
                    raise ScopeError("任务当前授权不可用，请重新登录并检查权限。")
                body = bytearray()
                for chunk in response.iter_bytes():
                    if len(body) + len(chunk) > 8192:
                        raise ScopeError("经营任务授权响应无效。")
                    body.extend(chunk)
                content = json.loads(body)
                if not isinstance(content, dict) or content.get("success") is not True:
                    raise ScopeError("经营任务授权响应无效。")
                token = content["data"]["token"]
                verify_grant(token, self.secret, job, phase)
                return token
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            raise ScopeError("任务当前授权失效或服务暂不可用，请重新确认。") from error
