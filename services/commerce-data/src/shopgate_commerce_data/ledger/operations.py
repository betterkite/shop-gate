"""Internal preview/confirm protocol; no SQL or callback comes from user/model input."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from shopgate_commerce_data.ledger.scope import IDENTIFIER, LedgerScope, ScopeError

OPERATION_KINDS = frozenset({"costs", "mapping", "target", "import", "recalculate"})


class OperationConflict(ValueError):
    """Stale, expired or reused request: do not partially apply."""


@dataclass(frozen=True)
class MutationResult:
    changed: bool
    result: dict[str, Any]


def payload_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                         allow_nan=False)
    if len(encoded.encode()) > 2_000_000:
        raise ValueError("操作内容过大。")
    return hashlib.sha256(encoded.encode()).hexdigest()


def bind_scope(connection: psycopg.Connection, scope: LedgerScope) -> None:
    """Must run inside a transaction; SET LOCAL cannot leak to a pooled next request."""
    scope.require("ledger.read")
    role = connection.execute(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    ).fetchone()
    if role[0] or role[1]:
        raise ScopeError("经营运行时不能使用超级用户或绕过行级隔离的数据库角色。")
    connection.execute(
        "SELECT set_config('shopgate.workspace_id', %s, true), "
        "set_config('shopgate.dataset_id', %s, true)", (scope.workspace_id, scope.dataset_id),
    )


def checked_dataset(connection: psycopg.Connection, scope: LedgerScope, *, lock: bool = False):
    query = ("SELECT version FROM bi.datasets WHERE workspace_id = %s AND dataset_id = %s "
             "AND state = 'active'") + (" FOR UPDATE" if lock else "")
    row = connection.execute(query, (scope.workspace_id, scope.dataset_id)).fetchone()
    if row is None:
        raise ScopeError("数据集不存在或当前身份无权访问。")
    return row[0]


def create_preview(connection: psycopg.Connection, scope: LedgerScope, kind: str,
                   payload: dict[str, Any], impact: dict[str, Any], *,
                   lifetime_seconds: int = 300) -> str:
    scope.require("ledger.manage")
    if kind not in OPERATION_KINDS or not 1 <= lifetime_seconds <= 900:
        raise ValueError("操作类型或预览期限无效。")
    digest = payload_hash(payload)
    payload_hash(impact)
    preview_id = str(uuid4())
    with connection.transaction():
        bind_scope(connection, scope)
        if checked_dataset(connection, scope) != scope.version:
            raise OperationConflict("数据已更新，请刷新并重新预览。")
        connection.execute(
            "INSERT INTO bi.operation_previews "
            "(workspace_id, dataset_id, preview_id, actor_id, kind, version, payload, "
            "payload_hash, impact, expires_at) VALUES "
            "(%s, %s, %s, %s, %s, %s, %s, %s, %s, clock_timestamp() + %s)",
            (scope.workspace_id, scope.dataset_id, preview_id, scope.actor_id, kind,
             scope.version, Jsonb(payload), digest, Jsonb(impact),
             timedelta(seconds=lifetime_seconds)),
        )
    return preview_id


def confirm_operation(connection: psycopg.Connection, scope: LedgerScope, preview_id: str,
                      idempotency_key: str, *, confirmed_by_user: bool,
                      apply: Callable[[psycopg.Connection, str, dict[str, Any]], MutationResult]
                      ) -> dict[str, Any]:
    scope.require("ledger.manage")
    if confirmed_by_user is not True:
        raise ScopeError("正式修改必须先由用户明确确认。")
    if not IDENTIFIER.fullmatch(idempotency_key) or not IDENTIFIER.fullmatch(preview_id):
        raise ValueError("操作标识无效。")
    request_digest = payload_hash({"preview_id": preview_id})
    with connection.transaction():
        bind_scope(connection, scope)
        # One dataset lock orders version check, idempotency and effects consistently.
        version = checked_dataset(connection, scope, lock=True)
        with connection.cursor(row_factory=dict_row) as cursor:
            previous = cursor.execute(
                "SELECT actor_id, request_hash, result FROM bi.operations "
                "WHERE workspace_id = %s AND dataset_id = %s AND idempotency_key = %s",
                (scope.workspace_id, scope.dataset_id, idempotency_key),
            ).fetchone()
            if previous:
                if (previous["actor_id"] != scope.actor_id
                        or previous["request_hash"] != request_digest):
                    raise OperationConflict("同一提交标识不能对应其他用户或不同操作。")
                return previous["result"]
            preview = cursor.execute(
                "SELECT *, expires_at <= clock_timestamp() AS expired "
                "FROM bi.operation_previews WHERE workspace_id = %s AND dataset_id = %s "
                "AND preview_id = %s FOR UPDATE",
                (scope.workspace_id, scope.dataset_id, preview_id),
            ).fetchone()
        if preview is None or preview["actor_id"] != scope.actor_id:
            raise ScopeError("预览不存在或当前身份无权确认。")
        if preview["expired"] or preview["consumed_at"]:
            raise OperationConflict("预览已过期或已提交，请重新预览。")
        if version != scope.version or preview["version"] != version:
            raise OperationConflict("数据已更新，请刷新并重新预览。")
        if payload_hash(preview["payload"]) != preview["payload_hash"]:
            raise OperationConflict("预览内容校验不一致。")
        mutation = apply(connection, preview["kind"], preview["payload"])
        if not isinstance(mutation, MutationResult) or type(mutation.changed) is not bool:
            raise TypeError("经营操作必须返回明确的变更与结果。")
        payload_hash(mutation.result)
        committed_version = version + int(mutation.changed)
        result = {"version": committed_version, "changed": mutation.changed,
                  "data": mutation.result}
        if mutation.changed:
            connection.execute(
                "UPDATE bi.datasets SET version = %s, updated_at = clock_timestamp() "
                "WHERE workspace_id = %s AND dataset_id = %s",
                (committed_version, scope.workspace_id, scope.dataset_id),
            )
        connection.execute(
            "UPDATE bi.operation_previews SET consumed_at = clock_timestamp() "
            "WHERE workspace_id = %s AND dataset_id = %s AND preview_id = %s",
            (scope.workspace_id, scope.dataset_id, preview_id),
        )
        connection.execute(
            "INSERT INTO bi.operations (workspace_id, dataset_id, idempotency_key, actor_id, "
            "preview_id, request_hash, result, committed_version) VALUES "
            "(%s, %s, %s, %s, %s, %s, %s, %s)",
            (scope.workspace_id, scope.dataset_id, idempotency_key, scope.actor_id,
             preview_id, request_digest, Jsonb(result), committed_version),
        )
        connection.execute(
            "INSERT INTO bi.audit_events (workspace_id, dataset_id, event_id, actor_id, "
            "operation_kind, preview_id, version, summary) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (scope.workspace_id, scope.dataset_id, str(uuid4()), scope.actor_id,
             preview["kind"], preview_id, committed_version,
             Jsonb({"changed": mutation.changed, "payload_hash": preview["payload_hash"],
                    "user_confirmed": True})),
        )
        return result
