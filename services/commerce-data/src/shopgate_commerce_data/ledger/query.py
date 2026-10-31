"""Shared, version-bound query contract; the only aggregate source for BI/exports/Agent.

This initial implementation aggregates ledger facts on the server. SQL-plan/100k-order
performance is a mandatory R7 gate, not claimed by these correctness tests.
"""

from __future__ import annotations

import copy
import json
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from decimal import Decimal
from hashlib import sha256
from typing import Any

import psycopg
from psycopg.pq import TransactionStatus

from shopgate_commerce_data.ledger.accounting import ZERO, Refund, calculate_refunds, money, ratio
from shopgate_commerce_data.ledger.metrics import DIMENSIONS, METRICS
from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope, checked_dataset
from shopgate_commerce_data.ledger.precision import decimal_text
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
    sort: str = "net_sales"
    descending: bool = True
    page: int = 1
    page_size: int = 20

    def validate(self) -> None:
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


def aggregate(events: list[dict], query: Query) -> dict:
    sales = refunds = costs = expenses = covered = contribution = ZERO
    missing_revenue = set()
    missing_refund = set()
    missing_cost = set()
    missing_expense = set()
    missing_attribution = set()
    orders = set()
    refund_orders = set()
    units = defaultdict(lambda: ZERO)
    missing_quantity = set()
    unallocated = ZERO
    for event in events:
        kind = event["kind"]
        if kind == "sale":
            orders.add(event["order_id"])
            if event["revenue"] is None:
                missing_revenue.add(event["line_id"])
            else:
                sales += event["revenue"]
            if event["cost"] is None:
                missing_cost.add(event["line_id"])
            else:
                costs += event["cost"]
            if event["quantity"] is None:
                missing_quantity.add(event["line_id"])
            else:
                units[event["unit"]] += event["quantity"]
            if event["complete"]:
                covered += event["revenue"]
                contribution += event["revenue"] - event["cost"]
        elif kind == "refund":
            refund_orders.add(event["order_id"])
            if event["refund"] is None:
                missing_refund.add(event["line_id"])
            else:
                refunds += event["refund"]
            if event["recovery"] is None:
                missing_cost.add(event["line_id"])
            else:
                costs -= event["recovery"]
            if event["complete"]:
                contribution += event["recovery"] - event["refund"]
        elif kind == "expense":
            if event["expense"] is None:
                if event.get("attribution_marker"):
                    missing_attribution.add(event["expense_id"])
                else:
                    missing_expense.add(event["expense_id"])
            else:
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
        "net_sales": decimal_text(net, "money"),
        "order_count": len(orders),
        "average_order_value": decimal_text(
            money(sales / len(orders)) if orders and gross is not None else None, "money"
        ),
        "standard_quantity": decimal_text(quantity, "quantity"),
        "product_cost": decimal_text(product_cost, "money"),
        "expense_amount": decimal_text(total_expense, "money"),
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
            "known_sales_cny": decimal_text(sales, "money"),
            "known_expenses_cny": decimal_text(expenses, "money"),
            "unallocated_expenses_cny": decimal_text(unallocated, "money"),
            "refund_order_count": len(refund_orders),
        },
    }


def _ratio_text(value: Decimal | None) -> str | None:
    return None if value is None else format(value, ".8f")



class LedgerReadSnapshot:
    """One authorized transaction; source/event caches never outlive this read."""

    def __init__(self, connection, scope, run):
        self._connection, self._scope, self._run = connection, scope, run
        self._active = True
        self._source_rows = {}
        self._event_sets = {}
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

    def _events(self, query):
        connection, scope, rows = self._connection, self._scope, self._rows
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
            or query.product_ids or query.sku_ids or query.listing_ids or query.category
        )
        event_key = (query.refund_basis, item_scope)
        if event_key in self._event_sets:
            return self._event_sets[event_key]
        if self._lines is None:
            self._lines = load_lines(connection)
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
                )
            )
        events = []
        dimensions = {}
        for line in lines:
            raw = snapshots.get(line["line_id"])
            if raw is None:
                raise OperationConflict("有订单尚未核算，请完成导入核算后重试。")
            snapshot = snapshot_from_row(raw)
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
                "line_id": line["line_id"],
                "category": sku.get("category"),
                "unit": sku.get("unit", "未知单位"),
                "complete": not snapshot.missing,
                "search_text": " ".join(
                    str(value)
                    for value in (
                        line["order_id"],
                        line["line_id"],
                        listing["name"],
                        sku.get("name", ""),
                        sku.get("product_name", ""),
                    )
                ),
            }
            dimensions[line["line_id"]] = dims
            events.append(
                {
                    **dims,
                    "kind": "sale",
                    "date": business_date(line["paid_at"]),
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
                events.append(
                    {
                        **dims,
                        "kind": "refund",
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
            if expense["accounting_status"] == "allocated":
                for allocation in allocations[expense["expense_id"]]:
                    dims = dimensions[allocation["line_id"]]
                    events.append(
                        {
                            **dims,
                            "kind": "expense",
                            "date": day,
                            "expense_id": expense["expense_id"],
                            "expense": allocation["amount_cny"],
                        }
                    )
            else:
                store = stores.get(expense["store_id"], {})
                events.append(
                    {
                        "kind": "expense",
                        "date": day,
                        "expense_id": expense["expense_id"],
                        "expense": expense["amount_cny"],
                        "channel_id": expense["channel_id"],
                        "channel_name": store.get("channel_name"),
                        "store_id": expense["store_id"],
                        "store_name": store.get("name"),
                        "complete": False,
                        "unallocated": True,
                        "search_text": expense["note"],
                    }
                )
                # Unknown/unallocated attribution must not look like a SKU has zero fees.
                # Overall/store/channel still carries the actual source expense once.
                item_scope = query.dimension in {"product", "sku", "listing", "order", "line"} or (
                    query.product_ids or query.sku_ids or query.listing_ids or query.category
                )
                if item_scope:
                    for line in lines:
                        if (
                            expense["store_id"] is not None
                            and line["store_id"] != expense["store_id"]
                        ):
                            continue
                        if (
                            expense["channel_id"] is not None
                            and line["channel_id"] != expense["channel_id"]
                        ):
                            continue
                        if expense["allocation_method"] == "direct":
                            if line["line_id"] != expense["line_id"]:
                                continue
                        elif business_date(line["paid_at"]) != day:
                            continue
                        events.append(
                            {
                                **dimensions[line["line_id"]],
                                "kind": "expense",
                                "date": day,
                                "expense_id": expense["expense_id"],
                                "expense": None,
                                "unallocated": False,
                                "attribution_marker": True,
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

    def query(self, query: Query) -> dict[str, Any]:
        self._check_active()
        query.validate()
        scope = self._scope
        events, latest_business_day = self._events(query)
        end = date.fromisoformat(query.end) if query.end else latest_business_day
        start = (
            date.fromisoformat(query.start)
            if query.start
            else end - timedelta(days=min(29, end.toordinal() - 1))
            if end
            else None
        )
        filtered = [
            event
            for event in events
            if (start is None or event["date"] >= start)
            and (end is None or event["date"] <= end)
            and _selected(event, query)
        ]
        groups = defaultdict(list)
        names = {}
        for event in filtered:
            key, label = _group(event, query.dimension)
            groups[key].append(event)
            names[key] = label
        results = [
            {"key": key, "name": names[key], **aggregate(value, query)}
            for key, value in groups.items()
        ]
        # Sort on the requested full-range metric even when hidden from output columns.
        if query.sort == "key":
            results.sort(key=lambda row: row["key"], reverse=query.descending)
        else:
            from dataclasses import replace

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
        has_item_filter = bool(
            query.product_ids
            or query.sku_ids
            or query.listing_ids
            or query.category
            or query.search
        )
        summary_events = (
            filtered
            if has_item_filter
            else [event for event in filtered if not event.get("attribution_marker")]
        )
        return {
            "workspace_id": scope.workspace_id,
            "dataset_id": scope.dataset_id,
            "version": scope.version,
            "accounting_revision": self._run["revision"],
            "algorithm_version": ALGORITHM_VERSION,
            "cache_key": query.cache_key(scope),
            "range": {
                "start": start.isoformat() if start else None,
                "end": end.isoformat() if end else None,
                "refund_basis": query.refund_basis,
                "timezone": "Asia/Shanghai",
            },
            "data_cutoff": latest_business_day.isoformat() if latest_business_day else None,
            "summary": aggregate(summary_events, query),
            "rows": results[offset : offset + query.page_size],
            "total": len(results),
            "page": query.page,
            "page_size": query.page_size,
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
def ledger_read_snapshot(connection, scope, *, _preview_transaction=False):
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
        snapshot = LedgerReadSnapshot(connection, scope, runs[0])
        try:
            yield snapshot
        finally:
            snapshot._active = False
            snapshot._source_rows.clear()
            snapshot._event_sets.clear()
            snapshot._lines = None


def query_ledger(
    connection: psycopg.Connection, scope: LedgerScope, query: Query, *, _preview_transaction=False
) -> dict[str, Any]:
    query.validate()
    with ledger_read_snapshot(connection, scope, _preview_transaction=_preview_transaction) as read:
        return read.query(query)
