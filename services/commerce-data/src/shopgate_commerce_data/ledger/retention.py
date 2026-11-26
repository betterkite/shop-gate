"""Explicit maintenance command; never runs during ordinary API/worker startup.

Dedicated maintenance login can only call the two fixed definer functions. No
user/model SQL or filesystem paths enter this service. Credentials are not logged.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from uuid import UUID

import psycopg

from shopgate_commerce_data.ledger.scope import IDENTIFIER, ScopeError


def _allowed(connection):
    if not connection.autocommit:
        raise ScopeError("维护连接必须使用独立自动提交模式。")
    role = connection.execute(
        "SELECT rolsuper,rolbypassrls,"
        "pg_has_role(current_user,'shopgate_bi_maintenance','MEMBER'),"
        "pg_has_role(current_user,'shopgate_bi_retention_executor','MEMBER') "
        "FROM pg_roles WHERE rolname=current_user"
    ).fetchone()
    if role is None or role[0] or role[1] or not role[2] or role[3]:
        raise ScopeError("请使用独立非管理员维护账号；不能继承执行角色。")


def plan_retention(connection, workspace_id, dataset_id, *, limit=100):
    _allowed(connection)
    if (
        not isinstance(workspace_id, str)
        or not IDENTIFIER.fullmatch(workspace_id)
        or not isinstance(dataset_id, str)
        or not IDENTIFIER.fullmatch(dataset_id)
        or type(limit) is not int
        or not 1 <= limit <= 100
    ):
        raise ValueError("维护范围或单次对象数无效（1–100）。")
    return connection.execute(
        "SELECT bi.plan_private_retention(%s,%s,%s)", (workspace_id, dataset_id, limit)
    ).fetchone()[0]


def apply_retention(connection, plan_id, digest, *, confirmed_by_operator):
    _allowed(connection)
    if confirmed_by_operator is not True:
        raise ScopeError("请先审阅清理计划，再明确确认同一摘要。")
    try:
        if not isinstance(plan_id, str) or str(UUID(plan_id)) != plan_id:
            raise ValueError()
    except (ValueError, AttributeError) as error:
        raise ValueError("清理计划编号无效。") from error
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("清理计划摘要无效。")
    return connection.execute(
        "SELECT bi.apply_private_retention(%s,%s)", (plan_id, digest)
    ).fetchone()[0]


def main():
    parser = argparse.ArgumentParser(
        description="经营临时文件维护：先计划、再确认，不删除正式账本。"
    )
    commands = parser.add_subparsers(dest="action", required=True)
    plan = commands.add_parser("plan", help="列出过期临时载荷及清理摘要，不删除")
    plan.add_argument("--workspace-id", required=True)
    plan.add_argument("--dataset-id", required=True)
    plan.add_argument("--limit", type=int, default=100)
    apply = commands.add_parser("apply", help="执行已审阅的同一计划，保留历史/审计/正式事实")
    apply.add_argument("--plan-id", required=True)
    apply.add_argument("--confirm-digest", required=True)
    arguments = parser.parse_args()
    # Explicit dedicated setting only; no dotenv discovery or DATABASE_URL fallback.
    database = os.environ.get("SHOPGATE_BI_MAINTENANCE_DATABASE_URL", "")
    if not database:
        raise SystemExit("请配置独立的经营维护连接。")
    try:
        with psycopg.connect(
            database,
            autocommit=True,
            connect_timeout=5,
            options="-c statement_timeout=60000 -c lock_timeout=5000",
        ) as connection:
            result = (
                plan_retention(
                    connection, arguments.workspace_id, arguments.dataset_id, limit=arguments.limit
                )
                if arguments.action == "plan"
                else apply_retention(
                    connection,
                    arguments.plan_id,
                    arguments.confirm_digest,
                    confirmed_by_operator=True,
                )
            )
    except psycopg.Error, ScopeError, ValueError:
        raise SystemExit(
            "维护未完成；请检查专用权限、计划期限或重新生成计划。未回显私有数据。"
        ) from None
    print(json.dumps(result, ensure_ascii=False, default=str, separators=(",", ":")))


if __name__ == "__main__":
    main()
