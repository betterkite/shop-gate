"""Workspace metadata directory and explicitly confirmed creation, never resets.

Directory authorization has its own audience; it cannot query any trading facts.
Only the internal create operation binds the validated new target for INSERTs.
"""

from __future__ import annotations

from dataclasses import dataclass

import psycopg
from psycopg.pq import TransactionStatus
from psycopg.types.json import Jsonb

from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope, payload_hash
from shopgate_commerce_data.ledger.recalculation import ALGORITHM_VERSION, rows
from shopgate_commerce_data.ledger.scope import (
    IDENTIFIER,
    DirectoryScope,
    LedgerScope,
    ScopeError,
)


def require_idle(connection):
    if connection.info.transaction_status != TransactionStatus.IDLE:
        raise ValueError("数据集操作需要独立事务。")


def bind_directory(connection: psycopg.Connection, scope: DirectoryScope):
    scope.require("datasets.read")
    if connection.info.transaction_status != TransactionStatus.INTRANS:
        raise ScopeError("数据集目录作用域必须在事务内绑定。")
    role = connection.execute(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
    ).fetchone()
    if role[0] or role[1]:
        raise ScopeError("经营运行时不能使用超级用户或绕过行级隔离的数据库角色。")
    # Empty dataset gives zero fact visibility, not wildcard access. SET LOCAL clears on exit.
    connection.execute(
        "SELECT set_config('shopgate.workspace_id',%s,true),"
        "set_config('shopgate.dataset_id','',true),set_config('shopgate.actor_id',%s,true)",
        (scope.workspace_id, scope.actor_id),
    )


@dataclass(frozen=True)
class DatasetPlan:
    dataset_id: str
    name: str
    source_kind: str

    def validate(self):
        if not isinstance(self.dataset_id, str) or not IDENTIFIER.fullmatch(self.dataset_id):
            raise ValueError("数据集标识无效。")
        if (
            not isinstance(self.name, str)
            or self.name != self.name.strip()
            or not 1 <= len(self.name) <= 200
            or any(ord(char) < 32 for char in self.name)
        ):
            raise ValueError("数据集名称须为1–200个可见字符，不能含首尾空白或控制符。")
        if not isinstance(self.source_kind, str) or self.source_kind not in {"demo", "import"}:
            raise ValueError("请选择演示数据或正式导入数据。")


def list_datasets(connection, scope: DirectoryScope, *, page=1, page_size=20, source_kind=None):
    require_idle(connection)
    scope.require("datasets.read")
    if (
        type(page) is not int
        or not 1 <= page <= 1_000_000
        or type(page_size) is not int
        or not 1 <= page_size <= 100
    ):
        raise ValueError("数据集页码或每页数量无效。")
    if source_kind is not None and (
        not isinstance(source_kind, str) or source_kind not in {"demo", "import"}
    ):
        raise ValueError("数据集来源筛选无效。")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        bind_directory(connection, scope)
        params = (scope.workspace_id, source_kind, source_kind)
        predicate = "workspace_id=%s AND state='active' AND (%s::text IS NULL OR source_kind=%s)"
        total = connection.execute(
            "SELECT count(*) FROM bi.dataset_directory WHERE " + predicate, params
        ).fetchone()[0]
        found = rows(
            connection,
            "SELECT dataset_id,name,source_kind,version,reporting_currency,state,updated_at "
            "FROM bi.dataset_directory WHERE "
            + predicate
            + " ORDER BY dataset_id LIMIT %s OFFSET %s",
            (*params, page_size, (page - 1) * page_size),
        )
        for record in found:
            record["updated_at"] = record["updated_at"].isoformat()
        return {
            "workspace_id": scope.workspace_id,
            "rows": found,
            "total": total,
            "page": page,
            "page_size": page_size,
        }


def dataset_metadata(connection, scope: DirectoryScope, dataset_id):
    require_idle(connection)
    if not isinstance(dataset_id, str) or not IDENTIFIER.fullmatch(dataset_id):
        raise ValueError("数据集标识无效。")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        bind_directory(connection, scope)
        found = rows(
            connection,
            "SELECT dataset_id,name,source_kind,version,reporting_currency,"
            "state,updated_at FROM bi.dataset_directory WHERE workspace_id=%s "
            "AND dataset_id=%s AND state='active'",
            (scope.workspace_id, dataset_id),
        )
        if not found:
            raise ScopeError("数据集不存在、已归档或当前身份无权访问。")
        result = found[0]
        result["workspace_id"] = scope.workspace_id
        result["updated_at"] = result["updated_at"].isoformat()
        return result


def create_dataset(
    connection,
    scope: DirectoryScope,
    plan: DatasetPlan,
    idempotency_key: str,
    *,
    confirmed_by_user: bool,
    demo_allowed: bool,
):
    require_idle(connection)
    scope.require("datasets.manage")
    scope.require("datasets.read")
    if confirmed_by_user is not True:
        raise ScopeError("创建数据集必须先由用户明确确认。")
    plan.validate()
    if type(demo_allowed) is not bool:
        raise ValueError("演示运行模式配置无效。")
    if plan.source_kind == "demo" and not demo_allowed:
        raise ScopeError("当前运行模式不允许创建演示数据；正式数据不会被补入或重置。")
    if not isinstance(idempotency_key, str) or not IDENTIFIER.fullmatch(idempotency_key):
        raise ValueError("创建请求标识无效。")
    digest = payload_hash(
        {
            "dataset_id": plan.dataset_id,
            "name": plan.name,
            "source_kind": plan.source_kind,
            "reporting_currency": "CNY",
        }
    )
    try:
        with connection.transaction():
            bind_directory(connection, scope)
            connection.execute("SELECT set_config('statement_timeout','60000',true)")
            # Same workspace row serializes creation/idempotency without exposing any fact.
            connection.execute(
                "INSERT INTO bi.workspaces(workspace_id,name) VALUES (%s,'经营工作空间') "
                "ON CONFLICT(workspace_id) DO NOTHING",
                (scope.workspace_id,),
            )
            connection.execute(
                "SELECT workspace_id FROM bi.workspaces WHERE workspace_id=%s FOR UPDATE",
                (scope.workspace_id,),
            )
            previous = rows(
                connection,
                "SELECT request_hash,result FROM bi.dataset_creations "
                "WHERE workspace_id=%s AND idempotency_key=%s",
                (scope.workspace_id, idempotency_key),
            )
            if previous:
                if previous[0]["request_hash"] != digest:
                    raise OperationConflict("同一请求标识不能对应不同的数据集创建内容。")
                return previous[0]["result"]
            target = LedgerScope(
                scope.workspace_id,
                plan.dataset_id,
                scope.actor_id,
                1,
                frozenset({"ledger.read", "ledger.manage"}),
            )
            bind_scope(connection, target)
            if connection.execute("SELECT 1 FROM bi.datasets").fetchone():
                raise OperationConflict("此数据集标识已经存在；不会覆盖已有名称、来源或经营事实。")
            connection.execute(
                "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
                "VALUES (%s,%s,%s,%s)",
                (scope.workspace_id, plan.dataset_id, plan.name, plan.source_kind),
            )
            connection.execute(
                "INSERT INTO bi.accounting_runs(workspace_id,dataset_id,revision,algorithm_version,"
                "processed_lines,processed_expenses) VALUES (%s,%s,1,%s,0,0)",
                (scope.workspace_id, plan.dataset_id, ALGORITHM_VERSION),
            )
            result = {
                "workspace_id": scope.workspace_id,
                "dataset_id": plan.dataset_id,
                "name": plan.name,
                "source_kind": plan.source_kind,
                "version": 1,
                "reporting_currency": "CNY",
                "state": "active",
                "notice": "空演示数据集，尚未生成经营记录。"
                if plan.source_kind == "demo"
                else "正式导入数据集，尚未导入经营记录。",
            }
            connection.execute(
                "INSERT INTO bi.dataset_creations(workspace_id,idempotency_key,actor_id,dataset_id,"
                "request_hash,result) VALUES (%s,%s,%s,%s,%s,%s)",
                (
                    scope.workspace_id,
                    idempotency_key,
                    scope.actor_id,
                    plan.dataset_id,
                    digest,
                    Jsonb(result),
                ),
            )
            return result
    except psycopg.errors.UniqueViolation as error:
        raise OperationConflict(
            "创建标识已被使用，请重新确认数据集或请求标识；未覆盖任何记录。"
        ) from error
