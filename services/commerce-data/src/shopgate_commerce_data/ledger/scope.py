"""Gateway-signed short-lived capabilities. Browser headers never grant a scope."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass

IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
CAPABILITIES = frozenset({"ledger.read", "ledger.manage"})
TOKEN_FIELDS = frozenset(
    {
        "aud",
        "workspace_id",
        "dataset_id",
        "actor_id",
        "version",
        "capabilities",
        "iat",
        "exp",
    }
)


class ScopeError(ValueError):
    pass


@dataclass(frozen=True)
class LedgerScope:
    workspace_id: str
    dataset_id: str
    actor_id: str
    version: int
    capabilities: frozenset[str]

    def require(self, capability: str) -> None:
        if capability not in self.capabilities:
            raise ScopeError("当前身份没有此经营数据操作权限。")


def verify_scope_token(token: str, secret: str, *, now: int | None = None) -> LedgerScope:
    if len(secret.encode()) < 32:
        raise ScopeError("经营服务签名配置无效。")
    if len(token) > 4096 or token.count(".") != 1:
        raise ScopeError("经营服务授权无效。")
    encoded, signature = token.split(".")
    expected = (
        base64.urlsafe_b64encode(
            hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    if not hmac.compare_digest(signature, expected):
        raise ScopeError("经营服务授权无效。")
    try:
        claims = json.loads(
            base64.b64decode(
                encoded + "=" * (-len(encoded) % 4),
                altchars=b"-_",
                validate=True,
            )
        )
    except (ValueError, UnicodeError) as error:
        raise ScopeError("经营服务授权无效。") from error
    current = int(time.time()) if now is None else now
    if not isinstance(claims, dict) or set(claims) != TOKEN_FIELDS:
        raise ScopeError("经营服务授权字段无效。")
    if claims["aud"] != "shopgate-bi-v1":
        raise ScopeError("经营服务授权目标无效。")
    if any(type(claims[field]) is not int for field in ("version", "iat", "exp")):
        raise ScopeError("经营服务授权版本或时间无效。")
    if not (
        0 < claims["version"] < 2**63
        and claims["iat"] <= current < claims["exp"]
        and 0 < claims["exp"] - claims["iat"] <= 300
    ):
        raise ScopeError("经营服务授权过期或版本无效。")
    if any(
        not isinstance(claims[field], str) or not IDENTIFIER.fullmatch(claims[field])
        for field in ("workspace_id", "dataset_id", "actor_id")
    ):
        raise ScopeError("经营服务授权范围无效。")
    caps = claims["capabilities"]
    if (
        not isinstance(caps, list)
        or not caps
        or any(not isinstance(cap, str) for cap in caps)
        or not set(caps).issubset(CAPABILITIES)
        or len(set(caps)) != len(caps)
    ):
        raise ScopeError("经营服务授权能力无效。")
    return LedgerScope(
        claims["workspace_id"],
        claims["dataset_id"],
        claims["actor_id"],
        claims["version"],
        frozenset(caps),
    )
