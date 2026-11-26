"""Master SKU directory with effective costs and independently dated operating results."""

from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time
from decimal import Decimal

from .accounting import Cost, choose_cost, ratio
from .precision import decimal_text
from .query import Query, aggregate, ledger_read_snapshot
from .recalculation import BUSINESS_ZONE
from .scope import IDENTIFIER

COST_METRICS = (
    "sales_amount",
    "refund_amount",
    "net_sales",
    "standard_quantity",
    "product_cost",
    "contribution_profit",
    "accounted_contribution",
    "coverage_ratio",
    "contribution_margin",
)
COST_SORTS = ("key", "name", "unit_cost", "change_rate", "sales_amount", "contribution_profit")
CONDITIONS = ("all", "missing", "negative", "low_margin", "rising")


@dataclass(frozen=True)
class CostDirectoryRequest:
    as_of: str
    query: Query = field(default_factory=Query)
    search: str = ""
    condition: str = "all"
    sort: str = "key"
    descending: bool = False
    page: int = 1
    page_size: int = 20
    history_sku: str | None = None

    def validate(self):
        self.query.validate()
        if (
            not isinstance(self.as_of, str)
            or date.fromisoformat(self.as_of).isoformat() != self.as_of
        ):
            raise ValueError("请选择成本查看日期。")
        if self.sort not in COST_SORTS or self.condition not in CONDITIONS:
            raise ValueError("成本排序或筛选选项无效。")
        if (
            type(self.page) is not int
            or not 1 <= self.page <= 999999
            or type(self.page_size) is not int
            or self.page_size not in (20, 100)
            or type(self.descending) is not bool
        ):
            raise ValueError("成本目录页码或排序方向无效。")
        if not isinstance(self.search, str) or len(self.search) > 200:
            raise ValueError("请输入较短的成本搜索词。")
        if self.history_sku is not None and (
            not isinstance(self.history_sku, str) or not IDENTIFIER.fullmatch(self.history_sku)
        ):
            raise ValueError("标准规格编号无效。")
        if len(self.query.store_ids) > 1 or len(self.query.channel_ids) > 1:
            raise ValueError("比较不同店铺或平台的成本时，请分别选择一个范围。")


def cost_public(rule):
    if not rule:
        return None
    return {
        k: rule[k]
        for k in (
            "cost_id",
            "level",
            "channel_id",
            "store_id",
            "source",
            "currency",
            "created_version",
            "superseded_version",
        )
    } | {
        "unit_cost": decimal_text(rule["unit_cost"], "unit_cost"),
        "valid_from": rule["valid_from"].isoformat(),
        "valid_to": rule["valid_to"].isoformat() if rule["valid_to"] else None,
    }


def cost_matches(condition, row):
    if condition == "all":
        return True
    m = row["metrics"]
    if condition == "missing":
        return row["applied"] is None or row["incomplete_paid_lines"] > 0
    if condition == "rising":
        return row["change_rate"] is not None and Decimal(row["change_rate"]) > Decimal(".1")
    if condition == "negative":
        return m["contribution_profit"] is not None and Decimal(m["contribution_profit"]) < 0
    return m["contribution_margin"] is not None and Decimal(m["contribution_margin"]) < Decimal(
        ".1"
    )


def cost_directory(connection, scope, request: CostDirectoryRequest):
    request.validate()
    q = replace(request.query, dimension="sku", metrics=COST_METRICS)
    at = datetime.combine(date.fromisoformat(request.as_of), time.max, BUSINESS_ZONE)
    with ledger_read_snapshot(connection, scope) as read:

        def fetch(sql, params=()):
            return read._rows(connection, sql, params)

        channel = next(iter(q.channel_ids), None)
        store = next(iter(q.store_ids), None)
        if store:
            match = fetch("SELECT channel_id FROM bi.stores WHERE store_id=%s", (store,))
            if not match or channel and match[0]["channel_id"] != channel:
                raise ValueError("店铺与平台范围不匹配。")
            channel = match[0]["channel_id"]
        elif channel and not fetch("SELECT 1 FROM bi.channels WHERE channel_id=%s", (channel,)):
            raise ValueError("所选平台不存在。")
        events, summary, span, cutoff = read.selected_events(q)
        facts = defaultdict(list)
        for event in events:
            if key := event.get("sku_id"):
                facts[key].append(event)
        catalog = fetch(
            "SELECT s.sku_id,s.name,s.unit,p.product_id,p.name AS product_name,p.category "
            "FROM bi.skus s JOIN bi.products p USING(workspace_id,dataset_id,product_id)"
        )
        rules = defaultdict(list)
        for rule in fetch(
            "SELECT * FROM bi.cost_versions WHERE level='base' OR "
            "(level='channel' AND channel_id=%s) OR (level='store' AND store_id=%s) "
            "ORDER BY valid_from DESC,cost_id",
            (channel, store),
        ):
            rules[rule["sku_id"]].append(rule)
        selected = None
        if q.listing_ids:
            selected = {
                r["sku_id"]
                for r in fetch(
                    "SELECT DISTINCT sku_id FROM bi.mappings "
                    "WHERE listing_id=ANY(%s) AND valid_from<=%s "
                    "AND (valid_to IS NULL OR valid_to>%s) AND superseded_version IS NULL",
                    (list(q.listing_ids), at, at),
                )
            }
        found = []
        history = []
        search = request.search.casefold()
        counts = {"catalog": 0, "with_cost": 0, "missing": 0, "rising": 0, "negative": 0}
        for sku in catalog:
            key = sku["sku_id"]
            if (
                q.sku_ids
                and key not in q.sku_ids
                or selected is not None
                and key not in selected
                or q.product_ids
                and sku["product_id"] not in q.product_ids
                or q.category is not None
                and sku["category"] != q.category
                or (q.group_condition or q.search)
                and key not in facts
                or search
                and search not in " ".join(str(v) for v in sku.values()).casefold()
            ):
                continue
            versions = rules[key]
            costs = [
                Cost(
                    r["cost_id"],
                    key,
                    r["level"],
                    r["unit_cost"],
                    r["currency"],
                    r["valid_from"],
                    r["valid_to"],
                    r["channel_id"],
                    r["store_id"],
                )
                for r in versions
                if r["superseded_version"] is None
            ]
            current = choose_cost(at, key, channel, store, costs)
            active = next(
                (r for r in versions if current and r["cost_id"] == current.cost_id), None
            )
            base = next(
                (
                    r
                    for r in versions
                    if r["superseded_version"] is None
                    and r["level"] == "base"
                    and r["valid_from"] <= at
                    and (r["valid_to"] is None or r["valid_to"] > at)
                ),
                None,
            )
            old = next(
                (
                    r
                    for r in versions
                    if active
                    and r["superseded_version"] is None
                    and r["level"] == active["level"]
                    and r["valid_from"] < active["valid_from"]
                ),
                None,
            )
            change = None
            if active and old and active["currency"] == old["currency"]:
                change = ratio(active["unit_cost"] - old["unit_cost"], old["unit_cost"])
            amounts = aggregate(facts[key], q)
            row = {
                **sku,
                "key": key,
                "applied": cost_public(active),
                "base": cost_public(base),
                "previous": cost_public(old),
                "change_rate": format(change, "f") if change is not None else None,
                "has_records": bool(facts[key]),
                "metrics": amounts["metrics"],
                "incomplete_paid_lines": sum(
                    1 for e in facts[key] if e["kind"] == "sale" and e["cost"] is None
                ),
            }
            counts["catalog"] += 1
            counts["with_cost"] += int(active is not None)
            for condition in ("missing", "rising", "negative"):
                counts[condition] += int(cost_matches(condition, row))
            if not cost_matches(request.condition, row):
                continue
            found.append(row)
            if key == request.history_sku:
                history = [cost_public(r) for r in versions]
        found.sort(key=lambda r: r["key"])

        def sort_value(row):
            if request.sort == "unit_cost":
                a = row["applied"]
                return (a["currency"], Decimal(a["unit_cost"])) if a else None
            if request.sort in ("key", "name"):
                return row[request.sort]
            value = (
                row["change_rate"]
                if request.sort == "change_rate"
                else row["metrics"][request.sort]
            )
            return Decimal(value) if value is not None else None

        if request.history_sku is not None:
            items = history
        else:
            known = [r for r in found if sort_value(r) is not None]
            known.sort(key=sort_value, reverse=request.descending)
            items = known + [r for r in found if sort_value(r) is None]
        offset = (request.page - 1) * request.page_size
        totals = aggregate(summary, q)["metrics"]
        return {
            "workspace_id": scope.workspace_id,
            "dataset_id": scope.dataset_id,
            "version": scope.version,
            "accounting_revision": scope.version,
            "range": span,
            "as_of": request.as_of,
            "data_cutoff": cutoff,
            "history_sku": request.history_sku,
            "counts": counts,
            "sales_coverage": totals["coverage_ratio"],
            "total": len(items),
            "page": request.page,
            "page_size": request.page_size,
            "rows": items[offset : offset + request.page_size],
        }
