"""Natural-month target changes: preview, human confirmation and unchanged facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from shopgate_commerce_data.ledger.operations import (
    MutationResult,
    OperationConflict,
    bind_scope,
    confirm_operation,
    create_preview,
)
from shopgate_commerce_data.ledger.precision import decimal_text, exact_decimal
from shopgate_commerce_data.ledger.query import ledger_read_snapshot
from shopgate_commerce_data.ledger.recalculation import carry_unchanged_accounting, rows
from shopgate_commerce_data.ledger.scope import IDENTIFIER, ScopeError


@dataclass(frozen=True)
class TargetChange:
    store_id: str
    month: str
    sales_target: str
    profit_target: str | None = None

    def normalized(self):
        if not isinstance(self.store_id, str) or not IDENTIFIER.fullmatch(self.store_id):
            raise ValueError("店铺编号无效，请重新选择店铺。")
        if not isinstance(self.month, str):
            raise ValueError("请选择目标月份。")
        try:
            month = date.fromisoformat(self.month)
        except ValueError as error:
            raise ValueError("目标月份请使用该自然月第一天。") from error
        if month.day != 1 or month.isoformat() != self.month:
            raise ValueError("目标月份请使用该自然月第一天。")
        if not isinstance(self.sales_target, str) or (
            self.profit_target is not None and not isinstance(self.profit_target, str)
        ):
            raise ValueError("目标金额请用普通数字文本填写，最多2位小数。")
        try:
            sales = exact_decimal(self.sales_target, "money")
            profit = (
                exact_decimal(self.profit_target, "money")
                if self.profit_target is not None
                else None
            )
        except ValueError as error:
            raise ValueError("目标金额格式或范围无效，请填写最多2位小数的普通数字。") from error
        if sales < 0:
            raise ValueError("净销售额目标不能为负数；经营贡献目标可按计划填写负数。")
        return {
            "store_id": self.store_id,
            "month": self.month,
            "sales_target": decimal_text(sales, "money"),
            "profit_target": decimal_text(profit, "money"),
        }


def _amounts(row):
    if row is None or row["sales_target"] is None:
        return None
    return {key: decimal_text(row[key], "money") for key in ("sales_target", "profit_target")}


def preview_target(connection, scope, change: TargetChange):
    scope.require("ledger.manage")
    normalized = change.normalized()
    month = date.fromisoformat(normalized["month"])
    with ledger_read_snapshot(connection, scope) as read:
        matches = [row for row in read.target_records(month) if row["store_id"] == change.store_id]
        if not matches:
            raise ScopeError("店铺不存在或不属于当前数据集。")
        store = matches[0]
        previous = _amounts(store)
    proposed = {key: normalized[key] for key in ("sales_target", "profit_target")}
    changed = previous != proposed
    impact = {
        "store_id": change.store_id,
        "store_name": store["store_name"],
        "channel_id": store["channel_id"],
        "month": change.month,
        "previous": previous,
        "proposed": proposed,
        "changed": changed,
        "version_before": scope.version,
        "expected_version_after": scope.version + int(changed),
        "facts_unchanged": True,
        "notice": "仅调整该店铺完整自然月的经营目标；订单、退款、费用和历史成本快照不变。",
    }
    preview_id = create_preview(
        connection, scope, "target", {"change": normalized, "previous": previous}, impact
    )
    with connection.transaction():
        bind_scope(connection, scope)
        expiry = rows(
            connection,
            "SELECT expires_at FROM bi.operation_previews WHERE preview_id=%s AND actor_id=%s",
            (preview_id, scope.actor_id),
        )[0]["expires_at"]
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "version": scope.version,
        "preview_id": preview_id,
        "expires_at": expiry.isoformat(),
        "impact": impact,
    }


def confirm_target(connection, scope, preview_id, idempotency_key, *, confirmed_by_user):
    def apply(connection, kind, payload):
        if kind != "target" or set(payload) != {"change", "previous"}:
            raise OperationConflict("此预览不是可确认的月度目标修改。")
        proposed = TargetChange(**payload["change"]).normalized()
        existing = rows(
            connection,
            "SELECT sales_target,profit_target FROM bi.targets "
            "WHERE store_id=%s AND month=%s FOR UPDATE",
            (proposed["store_id"], proposed["month"]),
        )
        previous = _amounts(existing[0] if existing else None)
        if previous != payload["previous"]:
            raise OperationConflict("原目标已变化，请重新预览；不会覆盖已有目标。")
        changed = previous != {key: proposed[key] for key in ("sales_target", "profit_target")}
        if changed:
            connection.execute(
                "INSERT INTO bi.targets(workspace_id,dataset_id,store_id,month,"
                "sales_target,profit_target) VALUES (%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT(workspace_id,dataset_id,store_id,month) DO UPDATE SET "
                "sales_target=excluded.sales_target,profit_target=excluded.profit_target",
                (
                    scope.workspace_id,
                    scope.dataset_id,
                    proposed["store_id"],
                    proposed["month"],
                    Decimal(proposed["sales_target"]),
                    Decimal(proposed["profit_target"])
                    if proposed["profit_target"] is not None
                    else None,
                ),
            )
            carry_unchanged_accounting(connection, scope)
        return MutationResult(
            changed, {"target": proposed, "previous": previous, "facts_unchanged": True}
        )

    result = confirm_operation(
        connection,
        scope,
        preview_id,
        idempotency_key,
        confirmed_by_user=confirmed_by_user,
        apply=apply,
    )
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "accounting_revision": result["version"],
        **result,
    }
