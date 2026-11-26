"""Shared, version-bound query contract; the only aggregate source for BI/exports/Agent.

This initial implementation aggregates ledger facts on the server. SQL-plan/100k-order
performance is a mandatory R7 gate, not claimed by these correctness tests.
"""

from __future__ import annotations

import copy
import json
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, localcontext
from hashlib import sha256
from typing import Any

import psycopg
from psycopg.pq import TransactionStatus

from shopgate_commerce_data.ledger.accounting import ZERO, Refund, calculate_refunds, money, ratio
from shopgate_commerce_data.ledger.metrics import (
    DIMENSIONS,
    FEE_LABELS,
    METRICS,
    REFUND_DIMENSIONS,
    REFUND_MEASURES,
    REFUND_TYPES,
)
from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope, checked_dataset
from shopgate_commerce_data.ledger.precision import decimal_text
from shopgate_commerce_data.ledger.read_index import IndexedEvents
from shopgate_commerce_data.ledger.recalculation import (
    ALGORITHM_VERSION,
    business_date,
    load_lines,
    rows,
    snapshot_from_row,
)
from shopgate_commerce_data.ledger.scope import IDENTIFIER, LedgerScope

# Look up one expense's latest eligible snapshot using its full primary key.
# A freshly imported preview has no ANALYZE statistics yet. Joining a DISTINCT
# subquery previously allowed repeated scans of all snapshots and timed out at
# the unchanged 60-second preview limit. This bounded lookup also keeps newer
# revisions out without relying on planner estimates or changing RLS/settings.
EXPENSES_WITH_SNAPSHOT_SQL = """
SELECT e.*,s.amount_cny,s.revision,s.accounting_status
FROM bi.expenses e
JOIN LATERAL (
    SELECT amount_cny,revision,accounting_status
    FROM bi.expense_snapshots s
    WHERE s.workspace_id=e.workspace_id AND s.dataset_id=e.dataset_id
      AND s.expense_id=e.expense_id AND s.revision<=%s
    ORDER BY s.revision DESC LIMIT 1
) s ON true
WHERE e.workspace_id=%s AND e.dataset_id=%s
"""

# A scalar indexed lookup avoids joining the whole latest-version relation to
# every allocation when the trial transaction has no fresh table statistics.
EXPENSE_ALLOCATIONS_SQL = """
SELECT a.* FROM bi.expense_allocations a
WHERE a.workspace_id=%s AND a.dataset_id=%s
  AND a.revision=(
      SELECT s.revision FROM bi.expense_snapshots s
      WHERE s.workspace_id=a.workspace_id AND s.dataset_id=a.dataset_id
        AND s.expense_id=a.expense_id AND s.revision<=%s
      ORDER BY s.revision DESC LIMIT 1
  )
"""


@dataclass(frozen=True)
class Query:
    dimension: str = "overall"
    metrics: tuple[str, ...] = tuple(METRICS)
    start: str | None = None
    end: str | None = None
    refund_basis: str = "payment"
    channel_ids: tuple[str, ...] = ()
    store_ids: tuple[str, ...] = ()
    product_ids: tuple[str, ...] = ()
    sku_ids: tuple[str, ...] = ()
    listing_ids: tuple[str, ...] = ()
    category: str | None = None
    search: str = ""
    refund_reason_id: str | None = None
    refund_type: str | None = None
    refund_search: str = ""
    group_condition: str | None = None
    condition_grain: str | None = None
    condition_start: str | None = None
    condition_end: str | None = None
    sort: str = "net_sales"
    descending: bool = True
    page: int = 1
    page_size: int = 20

    def validate(self) -> None:
        if self.refund_type is not None and (
            not isinstance(self.refund_type, str) or self.refund_type not in REFUND_TYPES
        ):
            raise ValueError("退款类型无效。")
        if self.refund_reason_id is not None and (
            not isinstance(self.refund_reason_id, str) or len(self.refund_reason_id) != 64
            or any(c not in "0123456789abcdef" for c in self.refund_reason_id)
        ):
            raise ValueError("退款原因编号无效。")
        if not isinstance(self.refund_search, str) or len(self.refund_search) > 200:
            raise ValueError("退款搜索词过长。")
        if self.group_condition is None:
            if any(x is not None for x in (
                self.condition_grain, self.condition_start, self.condition_end,
            )):
                raise ValueError("请同时指定商品筛选规则、统计方式和判断日期。")
        else:
            if (self.group_condition not in ("negative", "low_margin", "high_refund", "incomplete",
                                            "missing_cost", "missing_mapping")
                    or self.condition_grain not in ("product", "sku", "listing")):
                raise ValueError("商品经营筛选条件无效。")
            if self.group_condition == "missing_mapping" and self.condition_grain != "listing":
                raise ValueError("请按平台货号查找付款时没有对应标准规格的商品。")
            if not all(isinstance(x, str) and date.fromisoformat(x).isoformat() == x
                       for x in (self.condition_start, self.condition_end)):
                raise ValueError("请选择判断商品表现的日期范围。")
            if self.condition_start > self.condition_end:
                raise ValueError("商品筛选的开始日期不能晚于结束日期。")
        if self.dimension not in DIMENSIONS or self.refund_basis not in {"payment", "occurred"}:
            raise ValueError("分析维度或退款日期口径无效。")
        if (
            not isinstance(self.metrics, tuple)
            or not self.metrics
            or any(metric not in METRICS for metric in self.metrics)
            or len(set(self.metrics)) != len(self.metrics)
            or self.sort not in METRICS
            and self.sort != "key"
        ):
            raise ValueError("指标或排序不在允许目录中。")
        if (
            type(self.page) is not int
            or self.page < 1
            or type(self.page_size) is not int
            or not 1 <= self.page_size <= 200
            or type(self.descending) is not bool
        ):
            raise ValueError("页码、每页数量或排序方向无效。")
        for values in (
            self.channel_ids,
            self.store_ids,
            self.product_ids,
            self.sku_ids,
            self.listing_ids,
        ):
            if (
                not isinstance(values, tuple)
                or len(values) > 100
                or any(
                    not isinstance(value, str) or not IDENTIFIER.fullmatch(value)
                    for value in values
                )
            ):
                raise ValueError("筛选对象无效或数量过多。")
        if (
            not isinstance(self.search, str)
            or len(self.search) > 200
            or (
                self.category is not None
                and (not isinstance(self.category, str) or len(self.category) > 200)
            )
        ):
            raise ValueError("搜索或类目内容无效。")
        for value in (self.start, self.end):
            if value is not None and (
                not isinstance(value, str) or date.fromisoformat(value).isoformat() != value
            ):
                raise ValueError("日期必须为YYYY-MM-DD。")
        if self.start and self.end and self.start > self.end:
            raise ValueError("开始日期不能晚于结束日期。")

    def cache_key(self, scope: LedgerScope) -> str:
        self.validate()
        encoded = json.dumps(
            {
                "workspace": scope.workspace_id,
                "dataset": scope.dataset_id,
                "version": scope.version,
                "actor": scope.actor_id,
                "capabilities": sorted(scope.capabilities),
                "query": asdict(self),
                "algorithm": ALGORITHM_VERSION,
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        return sha256(encoded.encode()).hexdigest()


def _selected(event: dict, query: Query) -> bool:
    for key, values in (
        ("channel_id", query.channel_ids),
        ("store_id", query.store_ids),
        ("product_id", query.product_ids),
        ("sku_id", query.sku_ids),
        ("listing_id", query.listing_ids),
    ):
        if values and event.get(key) not in values:
            return False
    if query.category is not None and event.get("category") != query.category:
        return False
    return not (
        query.search and query.search.casefold() not in event.get("search_text", "").casefold()
    )


def _group(event: dict, dimension: str) -> tuple[str, str]:
    if dimension == "overall":
        return "overall", "全部所选范围"
    if dimension == "day":
        return event["date"].isoformat(), event["date"].isoformat()
    if dimension == "week":
        day = event["date"] - timedelta(days=event["date"].weekday())
        return day.isoformat(), f"{day.isoformat()}起的一周"
    key = event.get(f"{dimension}_id")
    return (
        (key, event.get(f"{dimension}_name") or key)
        if key
        else ("__unattributed__", "未归属对象的费用/待映射交易")
    )


QUALITY_KEYS = (
    "unknown_revenue_lines", "unknown_refund_lines", "unknown_cost_lines",
    "unknown_expenses", "unknown_attribution_expenses", "unknown_quantity_lines",
)


def quality_keys(event):
    """Shared predicates for summary counters and their source evidence."""
    if event["kind"] == "sale":
        return tuple(key for field, key in (
            ("revenue", "unknown_revenue_lines"), ("cost", "unknown_cost_lines"),
            ("quantity", "unknown_quantity_lines"),
        ) if event[field] is None)
    if event["kind"] == "refund":
        return tuple(key for field, key in (
            ("refund", "unknown_refund_lines"), ("recovery", "unknown_cost_lines"),
        ) if event[field] is None)
    if event["kind"] == "expense" and event["expense"] is None:
        return ("unknown_attribution_expenses" if event.get("attribution_marker")
                else "unknown_expenses",)
    return ()


def _per_unit(amount: Decimal | None, quantity: Decimal | None) -> str | None:
    if amount is None or quantity is None or quantity <= 0:
        return None
    with localcontext() as context:
        context.prec = 80
        return format((amount / quantity).quantize(Decimal("0.0001"), ROUND_HALF_UP), "f")


def aggregate(events: list[dict], query: Query, *, include_fees: bool = False) -> dict:
    sales = refunds = costs = expenses = covered = contribution = ZERO
    gaps = {key: set() for key in QUALITY_KEYS}
    for event in events:
        for key in quality_keys(event):
            gaps[key].add(event["expense_id" if event["kind"] == "expense" else "line_id"])
    missing_revenue = gaps["unknown_revenue_lines"]
    missing_refund = gaps["unknown_refund_lines"]
    missing_cost = gaps["unknown_cost_lines"]
    missing_expense = gaps["unknown_expenses"]
    missing_attribution = gaps["unknown_attribution_expenses"]
    orders = set()
    payment_gaps = defaultdict(set)
    refund_orders = set()
    refund_count = 0
    recovered = ZERO
    missing_recovery = False
    selling_channels, selling_stores = set(), set()
    known_original_cost = known_cost_quantity = ZERO
    known_cost_units = set()
    units = defaultdict(lambda: ZERO)
    missing_quantity = gaps["unknown_quantity_lines"]
    unallocated = ZERO
    fee_totals = defaultdict(lambda: ZERO)
    fee_gaps = set()
    for event in events:
        kind = event["kind"]
        if kind == "sale":
            orders.add(event["order_id"])
            for reason in event.get("source", {}).get("missing", ()):
                payment_gaps[reason].add(event["line_id"])
            if event.get("channel_id") is not None:
                selling_channels.add(event["channel_id"])
            if event.get("store_id") is not None:
                selling_stores.add(event["store_id"])
            if event["cost"] is not None and event["quantity"] is not None:
                known_original_cost += event["cost"]
                known_cost_quantity += event["quantity"]
                known_cost_units.add(event["unit"])
            if event["revenue"] is not None:
                sales += event["revenue"]
            if event["cost"] is not None:
                costs += event["cost"]
            if event["quantity"] is not None:
                units[event["unit"]] += event["quantity"]
            if event["complete"]:
                covered += event["revenue"]
                contribution += event["revenue"] - event["cost"]
        elif kind == "refund":
            refund_orders.add(event["order_id"])
            refund_count += 1
            if event["recovery"] is None:
                missing_recovery = True
            else:
                recovered += event["recovery"]
            if event["refund"] is not None:
                refunds += event["refund"]
            if event["recovery"] is not None:
                costs -= event["recovery"]
            if event["complete"]:
                contribution += event["recovery"] - event["refund"]
        elif kind == "expense":
            fee_type = event.get("source", {}).get("expense_type")
            if fee_type:
                if event["expense"] is None:
                    fee_gaps.add(fee_type)
                else:
                    fee_totals[fee_type] += event["expense"]
            if event["expense"] is not None:
                expenses += event["expense"]
                if event.get("unallocated"):
                    unallocated += event["expense"]
                if event["complete"] or event.get("unallocated"):
                    contribution -= event["expense"]
        else:
            raise ValueError("核算事件类型无效。")
    gross = None if missing_revenue else sales
    refund_total = None if missing_refund else refunds
    net = None if missing_revenue or missing_refund else sales - refunds
    product_cost = None if missing_cost else costs
    total_expense = None if missing_expense or missing_attribution else expenses
    profit = (
        None
        if net is None or product_cost is None or total_expense is None
        else (net - product_cost - total_expense)
    )
    quantity = None if missing_quantity or len(units) > 1 else sum(units.values(), ZERO)
    data = {
        "sales_amount": decimal_text(gross, "money"),
        "refund_amount": decimal_text(refund_total, "money"),
        "refund_event_count": refund_count,
        "refund_order_count": len(refund_orders),
        "refund_cost_recovery": decimal_text(None if missing_recovery else recovered, "money"),
        "net_sales": decimal_text(net, "money"),
        "order_count": len(orders),
        "average_order_value": decimal_text(
            money(sales / len(orders)) if orders and gross is not None else None, "money"
        ),
        "standard_quantity": decimal_text(quantity, "quantity"),
        "selling_channels": len(selling_channels),
        "selling_stores": len(selling_stores),
        "average_unit_price": _per_unit(gross, quantity),
        "weighted_unit_cost": _per_unit(known_original_cost, known_cost_quantity)
        if len(known_cost_units) == 1 and len(units) == 1 else None,
        "costed_quantity": decimal_text(known_cost_quantity, "quantity")
        if len(known_cost_units) <= 1 and len(units) <= 1 else None,
        "product_cost": decimal_text(product_cost, "money"),
        "expense_amount": decimal_text(total_expense, "money"),
        **{f"{kind}_expense": decimal_text(None if kind in fee_gaps else fee_totals.get(kind, ZERO),
                                           "money")
           for kind in FEE_LABELS if f"{kind}_expense" in query.metrics},
        "known_unallocated_expenses": decimal_text(unallocated, "money"),
        "contribution_profit": decimal_text(profit, "money"),
        "accounted_contribution": decimal_text(contribution, "money"),
        "contribution_margin": _ratio_text(ratio(profit, net)),
        "refund_ratio": _ratio_text(ratio(refund_total, gross))
        if query.refund_basis == "payment"
        else None,
        "accounted_revenue": decimal_text(covered, "money"),
        "coverage_ratio": _ratio_text(ratio(covered, gross)),
    }
    return {
        "metrics": {key: data[key] for key in query.metrics},
        **({"expense_breakdown": {
            key: {
                "amount": None if key in fee_gaps else decimal_text(fee_totals[key], "money"),
                "known_amount": decimal_text(fee_totals[key], "money"),
            }
            for key in sorted(fee_gaps | fee_totals.keys())
        }} if include_fees else {}),
        "quality": {
            "unknown_revenue_lines": len(missing_revenue),
            "unknown_refund_lines": len(missing_refund),
            "unknown_cost_lines": len(missing_cost),
            "unknown_expenses": len(missing_expense),
            "unknown_attribution_expenses": len(missing_attribution),
            "unknown_quantity_lines": len(missing_quantity),
            "quantity_by_unit": {
                key: decimal_text(value, "quantity") for key, value in sorted(units.items())
            },
            **({"payment_missing_reasons": {key: len(ids) for key, ids in payment_gaps.items()}}
               if payment_gaps else {}),
            "known_sales_cny": decimal_text(sales, "money"),
            "known_expenses_cny": decimal_text(expenses, "money"),
            **({"known_refunds_cny": decimal_text(refunds, "money"),
                "known_product_cost_cny": decimal_text(costs, "money")} if include_fees else {}),
            "unallocated_expenses_cny": decimal_text(unallocated, "money"),
            "refund_order_count": len(refund_orders),
        },
    }


def _ratio_text(value: Decimal | None) -> str | None:
    return None if value is None else format(value, ".8f")



class LedgerReadSnapshot:
    """One authorized transaction; source/event caches never outlive this read."""

    def __init__(self, connection, scope, run, *, use_index=False, overview=False):
        self._connection, self._scope, self._run = connection, scope, run
        self._index = IndexedEvents(connection, scope, overview=overview) if use_index else None
        self._active = True
        self._source_rows = {}
        self._event_sets = {}
        self._eligible_groups = {}
        self._lines = None
        self.recorded_start = None

    def _check_active(self):
        if (not self._active
                or self._connection.info.transaction_status != TransactionStatus.INTRANS):
            raise ValueError("经营读取快照已结束，请重新读取当前版本。")

    def _rows(self, connection, statement, params=()):
        self._check_active()
        if connection is not self._connection:
            raise ValueError("经营快照不能切换数据库连接。")
        key = (statement, tuple(params))
        if key not in self._source_rows:
            self._source_rows[key] = rows(connection, statement, params)
        return self._source_rows[key]

    def _events(self, query, hypothetical_cost=None):
        connection, scope, rows = self._connection, self._scope, self._rows
        channels = {row["channel_id"]: row["name"] for row in rows(
            connection, "SELECT channel_id,name FROM bi.channels"
        )}
        stores = {
            row["store_id"]: row
            for row in rows(
                connection,
                "SELECT s.*,c.name AS channel_name FROM bi.stores s "
                "JOIN bi.channels c USING(workspace_id,dataset_id,channel_id)",
            )
        }
        if query.channel_ids and any(
            store_id in stores and stores[store_id]["channel_id"] not in query.channel_ids
            for store_id in query.store_ids
        ):
            raise ValueError("所选店铺不属于所选销售平台，请调整筛选范围。")
        item_scope = bool(
            query.dimension in {"product", "sku", "listing", "order", "line"}
            or query.group_condition or query.product_ids or query.sku_ids or query.listing_ids
            or query.category is not None
        )
        if self._index is not None and self._index.header and hypothetical_cost is None:
            self.recorded_start = self._index.header[1]
            return self._index.events(query, item_scope)
        event_key = (query.refund_basis, item_scope, hypothetical_cost)
        if event_key in self._event_sets:
            return self._event_sets[event_key]
        if self._lines is None:
            self._lines = load_lines(connection, scope)
        lines = self._lines
        snapshots = {
            row["line_id"]: row
            for row in rows(
                connection,
                "SELECT DISTINCT ON(line_id) * FROM bi.line_snapshots "
                "WHERE revision <= %s ORDER BY line_id,revision DESC",
                (scope.version,),
            )
        }
        catalog = {
            row["sku_id"]: row
            for row in rows(
                connection,
                "SELECT s.*,p.name AS product_name,p.category FROM bi.skus s "
                "JOIN bi.products p USING(workspace_id,dataset_id,product_id)",
            )
        }
        listings = {row["listing_id"]: row for row in rows(connection, "SELECT * FROM bi.listings")}
        refunds = defaultdict(list)
        for row in rows(connection, "SELECT * FROM bi.refunds WHERE status='completed'"):
            refunds[row["line_id"]].append(
                Refund(
                    row["refund_id"],
                    row["occurred_at"],
                    row["amount"],
                    row["refund_type"],
                    row["returned_quantity"],
                    row["recoverable_quantity"],
                    row["status"],
                    row["cancelled_quantity"],
                    row["reason"],
                )
            )
        events = []
        dimensions = {}
        payment_lines = defaultdict(list)
        for line in lines:
            raw = snapshots.get(line["line_id"])
            if raw is None:
                raise OperationConflict("有订单尚未核算，请完成导入核算后重试。")
            snapshot = snapshot_from_row(raw)
            if (
                hypothetical_cost
                and snapshot.sku_id == hypothetical_cost[0]
                and snapshot.standard_quantity is not None
            ):
                # Use a CNY price per standard unit. Preserve original payment FX and mapping,
                # then let the normal cumulative refund algorithm apportion recovered cost.
                unit_cost = hypothetical_cost[1]
                with localcontext() as context:
                    context.prec = 80
                    cost_cny = money(unit_cost * snapshot.standard_quantity)
                missing = tuple(
                    reason
                    for reason in snapshot.missing
                    if reason != "missing_cost"
                    and (reason != "missing_fx" or snapshot.revenue_fx_rate is None)
                )
                snapshot = replace(
                    snapshot,
                    unit_cost=unit_cost,
                    cost_cny=cost_cny,
                    cost_fx_rate=Decimal(1),
                    missing=missing,
                )
            sku = catalog.get(snapshot.sku_id, {})
            store = stores[line["store_id"]]
            listing = listings[line["listing_id"]]
            dims = {
                "channel_id": store["channel_id"],
                "channel_name": store["channel_name"],
                "store_id": line["store_id"],
                "store_name": store["name"],
                "product_id": sku.get("product_id"),
                "product_name": sku.get("product_name"),
                "sku_id": snapshot.sku_id,
                "sku_name": sku.get("name"),
                "listing_id": line["listing_id"],
                "listing_name": listing["name"],
                "order_id": line["order_id"],
                "platform_order_id": line["platform_order_id"],
                "line_id": line["line_id"],
                "category": sku.get("category"),
                "unit": sku.get("unit", "未知单位"),
                "complete": not snapshot.missing,
                "source": {
                    "paid_at": line["paid_at"].isoformat(),
                    "currency": line["currency"],
                    "paid_amount": decimal_text(line["paid_amount"], "money"),
                    "missing": snapshot.missing,
                    "revenue_fx_missing": snapshot.revenue_fx_rate is None,
                    "cost_id": snapshot.cost_id,
                    "cost_fx_missing": snapshot.cost_id is not None
                    and snapshot.cost_fx_rate is None,
                },
            }
            dims["search_text"] = " ".join(
                str(value) for value in (
                    dims["channel_id"], dims["channel_name"], dims["store_id"], dims["store_name"],
                    dims["product_id"], dims["product_name"], dims["sku_id"], dims["sku_name"],
                    dims["listing_id"], dims["listing_name"], listing.get("platform_sku_id"),
                    listing.get("platform_product_id"), line["platform_order_id"],
                    dims["order_id"], dims["line_id"], dims["category"],
                ) if value is not None
            )
            dimensions[line["line_id"]] = dims
            paid_day = business_date(line["paid_at"])
            if item_scope:
                groups = (("all", ""), ("channel", dims["channel_id"]), ("store", dims["store_id"]))
                for group in groups:
                    payment_lines[(paid_day, *group)].append(dims)
            events.append(
                {
                    **dims,
                    "kind": "sale",
                    "date": paid_day,
                    "revenue": snapshot.revenue_cny,
                    "cost": snapshot.cost_cny,
                    "quantity": snapshot.standard_quantity,
                }
            )
            refund_map = {row.refund_id: row for row in refunds[line["line_id"]]}
            for result in calculate_refunds(
                snapshot, line["paid_amount"], line["quantity"], refunds[line["line_id"]]
            ):
                row = refund_map[result.refund_id]
                day = line["paid_at"] if query.refund_basis == "payment" else row.occurred_at
                reason = row.reason or ""
                type_label = REFUND_TYPES[row.refund_type]
                events.append(
                    {
                        **dims,
                        "kind": "refund",
                        "refund_reason_id": sha256(reason.encode()).hexdigest(),
                        "refund_reason_name": reason or "未填写原因",
                        "refund_type_id": row.refund_type, "refund_type_name": type_label,
                        "refund_event_id": row.refund_id,
                        "refund_event_name": (
                            f"{row.refund_id} · {type_label} · 原单 {line['order_id']} "
                            f"· 明细 {line['line_id']}"
                        ),
                        "refund_id": result.refund_id,
                        "search_text": " ".join((dims["search_text"], row.refund_id,
                                                 type_label, reason)),
                        "source": {
                            **dims["source"], "occurred_at": row.occurred_at.isoformat(),
                            "original_amount": decimal_text(row.amount, "money"),
                            "refund_type": row.refund_type, "reason": reason,
                            "returned_quantity": decimal_text(row.returned_quantity, "quantity"),
                            "recoverable_quantity": decimal_text(
                                row.recoverable_quantity, "quantity"
                            ),
                            "cancelled_quantity": decimal_text(row.cancelled_quantity, "quantity"),
                        },
                        "date": business_date(day),
                        "refund": result.amount_cny,
                        "recovery": result.recovered_cost_cny,
                    }
                )
        expenses = {
            row["expense_id"]: row
            for row in rows(
                connection,
                EXPENSES_WITH_SNAPSHOT_SQL,
                (scope.version, scope.workspace_id, scope.dataset_id),
            )
        }
        allocations = defaultdict(list)
        for row in rows(
            connection,
            EXPENSE_ALLOCATIONS_SQL,
            (scope.workspace_id, scope.dataset_id, scope.version),
        ):
            allocations[row["expense_id"]].append(row)
        for expense in expenses.values():
            day = business_date(expense["occurred_at"])
            source = {
                "occurred_at": expense["occurred_at"].isoformat(),
                "original_amount": decimal_text(expense["amount"], "money"),
                "currency": expense["currency"], "note": expense["note"],
                "source_amount_cny": decimal_text(expense["amount_cny"], "money"),
                "accounting_status": expense["accounting_status"],
                "expense_type": expense["expense_type"],
                "allocation_method": expense["allocation_method"],
            }
            expense_search = " ".join(
                str(value) for value in (expense["expense_id"], expense["note"]) if value
            )
            if expense["accounting_status"] == "allocated":
                for allocation in allocations[expense["expense_id"]]:
                    dims = dimensions[allocation["line_id"]]
                    events.append(
                        {
                            **dims,
                            "kind": "expense",
                            "source": source,
                            "date": day,
                            "expense_id": expense["expense_id"],
                            "expense": allocation["amount_cny"],
                            "search_text": f"{dims['search_text']} {expense_search}",
                        }
                    )
            else:
                store = stores.get(expense["store_id"], {})
                events.append(
                    {
                        "kind": "expense",
                        "source": source,
                        "date": day,
                        "expense_id": expense["expense_id"],
                        "expense": expense["amount_cny"],
                        "channel_id": expense["channel_id"],
                        "channel_name": channels.get(expense["channel_id"]),
                        "store_id": expense["store_id"],
                        "store_name": store.get("name"),
                        "complete": False,
                        "unallocated": True,
                        "search_text": " ".join(str(value) for value in (
                            expense_search, expense["channel_id"],
                            channels.get(expense["channel_id"]),
                            expense["store_id"], store.get("name"),
                        ) if value),
                    }
                )
                # Unknown/unallocated attribution must not look like a SKU has zero fees.
                # Overall/store/channel still carries the actual source expense once.
                if item_scope:
                    if expense["allocation_method"] == "direct":
                        direct = dimensions.get(expense["line_id"])
                        candidates = [direct] if direct else []
                    elif expense["store_id"] is not None:
                        candidates = payment_lines[day, "store", expense["store_id"]]
                    elif expense["channel_id"] is not None:
                        candidates = payment_lines[day, "channel", expense["channel_id"]]
                    else:
                        candidates = payment_lines[day, "all", ""]
                    for dims in candidates:
                        if (expense["channel_id"] is not None
                                and expense["channel_id"] != dims["channel_id"]):
                            continue
                        if (expense["store_id"] is not None
                                and expense["store_id"] != dims["store_id"]):
                            continue
                        events.append(
                            {
                                **dims,
                                "kind": "expense",
                                "source": source,
                                "date": day,
                                "expense_id": expense["expense_id"],
                                "expense": None,
                                "unallocated": False,
                                "attribution_marker": True,
                                "search_text": f"{dims['search_text']} {expense_search}",
                            }
                        )
        latest_business_day = max(
            [event["date"] for event in events]
            + [
                business_date(refund.occurred_at)
                for values in refunds.values()
                for refund in values
            ],
            default=None,
        )
        business_days = [event["date"] for event in events] + [
            business_date(refund.occurred_at)
            for values in refunds.values() for refund in values
        ]
        self.recorded_start = min(business_days, default=None)
        self._event_sets[event_key] = (events, latest_business_day)
        return events, latest_business_day

    def _eligible(self, events, query):
        key = (query.group_condition, query.condition_grain, query.condition_start,
               query.condition_end, query.refund_basis, query.channel_ids, query.store_ids,
               query.product_ids, query.sku_ids, query.listing_ids, query.category, query.search)
        if key in self._eligible_groups:
            return self._eligible_groups[key]
        start = date.fromisoformat(query.condition_start)
        end = date.fromisoformat(query.condition_end)
        groups = defaultdict(list)
        eligible = set()
        snapshot_reason = query.group_condition in {"missing_cost", "missing_mapping"}
        for event in events:
            if (event.get("line_id") and start <= event["date"] <= end
                    and _selected(event, query)):
                group, _ = _group(event, query.condition_grain)
                if snapshot_reason:
                    if (event["kind"] in ("sale", "refund")
                            and query.group_condition in event["source"]["missing"]):
                        eligible.add(group)
                else:
                    groups[group].append(event)
        rule_metrics = ("accounted_contribution", "contribution_margin", "refund_ratio")
        rule_query = replace(query, metrics=rule_metrics)
        for group, members in groups.items():
            row = aggregate(members, rule_query)
            values = row["metrics"]
            if query.group_condition == "incomplete":
                matches = any(row["quality"][reason] for reason in QUALITY_KEYS)
            elif query.group_condition == "negative":
                matches = Decimal(values["accounted_contribution"]) < 0
            elif query.group_condition == "low_margin":
                rate = values["contribution_margin"]
                matches = rate is not None and Decimal(rate) < Decimal("0.10")
            else:
                rate = values["refund_ratio"]
                matches = rate is not None and Decimal(rate) > Decimal("0.10")
            if matches:
                eligible.add(group)
        self._eligible_groups[key] = eligible
        return eligible

    def selected_events(self, query: Query, *, hypothetical_cost=None):
        """One range resolver shared by aggregates and exact source evidence."""
        self._check_active()
        query.validate()
        events, latest_business_day = self._events(query, hypothetical_cost)
        end = date.fromisoformat(query.end) if query.end else latest_business_day
        start = (
            date.fromisoformat(query.start)
            if query.start
            else end - timedelta(days=min(29, end.toordinal() - 1))
            if end
            else None
        )
        # Keep the original population when a scenario changes the profitability of a group.
        eligible = self._eligible(self._events(query)[0], query) if query.group_condition else None
        restrict_objects = bool(query.channel_ids or query.store_ids or query.product_ids
                                or query.sku_ids or query.listing_ids
                                or query.category is not None or query.search)
        filtered = [
            event
            for event in events
            if (start is None or event["date"] >= start)
            and (end is None or event["date"] <= end)
            and (not restrict_objects or _selected(event, query))
            and (event["kind"] != "refund" or (
                (not query.refund_type or event["refund_type_id"] == query.refund_type)
                and (not query.refund_reason_id
                     or event["refund_reason_id"] == query.refund_reason_id)
                and (not query.refund_search or query.refund_search.casefold()
                     in event["search_text"].casefold())
            ))
            and (eligible is None or (event.get("line_id")
                 and _group(event, query.condition_grain)[0] in eligible))
        ]
        has_item_filter = bool(
            query.product_ids or query.sku_ids or query.listing_ids
            or query.category is not None or query.search or query.group_condition
        )
        # Attribution markers explain an unknown allocation on individual products.
        # When the same source expense is in the selected total, count that source only.
        included_sources = {e["expense_id"] for e in filtered if e.get("unallocated")}
        summary_events = [
            e for e in filtered if not e.get("attribution_marker")
            or (has_item_filter and e["expense_id"] not in included_sources)
        ]
        return filtered, summary_events, {
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "refund_basis": query.refund_basis, "timezone": "Asia/Shanghai",
        }, latest_business_day.isoformat() if latest_business_day else None

    def summarize(self, query, *, profit=False):
        _, events, span, cutoff = self.selected_events(query)
        return self._summary(query, events, span, cutoff, profit)

    def grouped_rows(self, query):
        filtered, _, _, _ = self.selected_events(query)
        return self._grouped_rows(query, filtered)

    def query(self, query: Query, *, profit: bool = False) -> dict[str, Any]:
        filtered, events, span, cutoff = self.selected_events(query)
        return {
            **self._summary(query, events, span, cutoff, profit),
            **self._grouped_rows(query, filtered),
        }

    @staticmethod
    def _grouped_rows(query, filtered):
        groups = defaultdict(list)
        names = {}
        for event in filtered:
            if query.dimension in REFUND_DIMENSIONS and event["kind"] != "refund":
                continue
            key, label = _group(event, query.dimension)
            groups[key].append(event)
            names[key] = label
        include_fees = query.dimension in {"channel", "store"}
        results = [
            {"key": key, "name": names[key], **aggregate(value, query, include_fees=include_fees)}
            for key, value in groups.items()
        ]
        if query.dimension in REFUND_DIMENSIONS:
            for row in results:
                # Refund postings alone have no paid revenue, profit or order denominator.
                row["metrics"] = {key: value if key in REFUND_MEASURES else None
                                  for key, value in row["metrics"].items()}
        # Sort on the requested full-range metric even when hidden from output columns.
        if query.sort == "key":
            results.sort(key=lambda row: row["key"], reverse=query.descending)
        else:
            if query.sort in query.metrics:
                values = {row["key"]: row["metrics"][query.sort] for row in results}
            else:
                sort_query = replace(query, metrics=(query.sort,))
                values = {
                    key: aggregate(value, sort_query)["metrics"][query.sort]
                    for key, value in groups.items()
                }
            known = sorted(
                (row for row in results if values[row["key"]] is not None),
                key=lambda row: row["key"],
            )
            known.sort(key=lambda row: Decimal(values[row["key"]]), reverse=query.descending)
            results = known + sorted(
                (row for row in results if values[row["key"]] is None), key=lambda row: row["key"]
            )
        offset = (query.page - 1) * query.page_size
        return {
            "rows": results[offset : offset + query.page_size],
            "total": len(results),
            "page": query.page,
            "page_size": query.page_size,
        }

    def _summary(self, query, summary_events, selected_range, cutoff, profit):
        scope = self._scope
        return {
            "workspace_id": scope.workspace_id,
            "dataset_id": scope.dataset_id,
            "version": scope.version,
            "accounting_revision": self._run["revision"],
            "algorithm_version": ALGORITHM_VERSION,
            "cache_key": query.cache_key(scope),
            "range": selected_range,
            "data_cutoff": cutoff,
            "summary": aggregate(summary_events, query, include_fees=profit),
            "notes": [
                "费用在完整来源业务日/平台/店铺范围分摊后筛选；未分摊费用不伪归属规格。",
                "已核算范围贡献金额不是财务净利润；未知成本/费用另列。",
                "退款发生日口径不提供无适当付款分母的退款比例。",
            ],
        }

    def target_records(self, month):
        """Private server-owned monthly inputs, still inside the same authorized snapshot."""
        return copy.deepcopy(self._rows(
            self._connection,
            "SELECT s.store_id,s.name AS store_name,s.channel_id,t.month,"
            "t.sales_target,t.profit_target FROM bi.stores s LEFT JOIN bi.targets t "
            "ON (s.workspace_id,s.dataset_id,s.store_id)="
            "(t.workspace_id,t.dataset_id,t.store_id) AND t.month=%s ORDER BY s.store_id",
            (month,),
        ))


@contextmanager
def ledger_read_snapshot(connection, scope, *, _preview_transaction=False, _overview=False):
    """Server-owned consistent read; HTTP/model fields cannot select nested mode."""
    scope.require("ledger.read")
    if type(_preview_transaction) is not bool or (
        connection.info.transaction_status
        != (TransactionStatus.INTRANS if _preview_transaction else TransactionStatus.IDLE)
    ):
        raise ValueError("经营查询需要独立事务，以确保一次分析的一致版本。")
    with connection.transaction():
        if not _preview_transaction:
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        bind_scope(connection, scope)
        if checked_dataset(connection, scope) != scope.version:
            raise OperationConflict("数据已更新，请刷新；不能拼接不同版本的分析。")
        runs = rows(
            connection,
            "SELECT revision,algorithm_version FROM bi.accounting_runs "
            "ORDER BY revision DESC LIMIT 1",
        )
        if not runs:
            raise OperationConflict("该数据集尚未完成经营核算，请先导入并核算。")
        if runs[0]["revision"] != scope.version:
            raise OperationConflict("数据版本与核算版本不一致，请完成核算后重试。")
        if runs[0]["algorithm_version"] != ALGORITHM_VERSION:
            raise OperationConflict("核算版本不受支持，需显式重新核算。")
        snapshot = LedgerReadSnapshot(
            connection, scope, runs[0], use_index=not _preview_transaction, overview=_overview
        )
        try:
            yield snapshot
        finally:
            snapshot._active = False
            snapshot._source_rows.clear()
            snapshot._event_sets.clear()
            snapshot._eligible_groups.clear()
            snapshot._lines = None
            snapshot._index = None


def query_ledger(
    connection: psycopg.Connection, scope: LedgerScope, query: Query, *, _preview_transaction=False
) -> dict[str, Any]:
    query.validate()
    with ledger_read_snapshot(connection, scope, _preview_transaction=_preview_transaction) as read:
        return read.query(query)
