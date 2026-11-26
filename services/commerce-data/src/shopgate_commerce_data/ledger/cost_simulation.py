"""Read-only cost scenarios use the same paid quantities and refund recovery as the ledger."""

from dataclasses import replace
from decimal import Decimal

from .precision import decimal_text, exact_decimal
from .query import Query, aggregate, ledger_read_snapshot
from .scope import IDENTIFIER

SIMULATION_METRICS = (
    "order_count",
    "standard_quantity",
    "net_sales",
    "product_cost",
    "refund_cost_recovery",
    "expense_amount",
    "contribution_profit",
    "accounted_contribution",
    "contribution_margin",
    "coverage_ratio",
)


def simulate_cost(connection, scope, query: Query, sku_id: str, unit_cost: str):
    if not isinstance(sku_id, str) or not IDENTIFIER.fullmatch(sku_id):
        raise ValueError("请选择需要试算的标准规格。")
    if not isinstance(unit_cost, str):
        raise ValueError("试算单位成本须为人民币金额，最多四位小数。")
    price = exact_decimal(unit_cost, "unit_cost")
    if query.sku_ids and sku_id not in query.sku_ids:
        raise ValueError("规格与当前页面范围不匹配。")
    query = replace(query, sku_ids=(sku_id,), dimension="sku", metrics=SIMULATION_METRICS)
    with ledger_read_snapshot(connection, scope) as read:
        sku = read._rows(
            connection, "SELECT sku_id,name,unit FROM bi.skus WHERE sku_id=%s", (sku_id,)
        )
        if not sku:
            raise ValueError("当前数据集中没有所选规格。")
        _, original, span, cutoff = read.selected_events(query)
        _, projected, _, _ = read.selected_events(query, hypothetical_cost=(sku_id, price))
        before = aggregate(original, query)["metrics"]
        after = aggregate(projected, query)["metrics"]
        old, new = before["contribution_profit"], after["contribution_profit"]
        delta = Decimal(new) - Decimal(old) if old is not None and new is not None else None
        return {
            "workspace_id": scope.workspace_id,
            "dataset_id": scope.dataset_id,
            "version": scope.version,
            "accounting_revision": scope.version,
            "algorithm_version": read._run["algorithm_version"],
            "sku_id": sku_id,
            "name": sku[0]["name"],
            "unit": sku[0]["unit"],
            "unit_cost_cny": decimal_text(price, "unit_cost"),
            "range": span,
            "data_cutoff": cutoff,
            "affected_orders": len(
                {e["order_id"] for e in original if e["kind"] in ("sale", "refund")}
            ),
            "before": before,
            "after": after,
            "profit_difference_cny": decimal_text(delta, "money"),
        }
