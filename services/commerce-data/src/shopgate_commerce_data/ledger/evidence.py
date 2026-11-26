"""Paginated evidence for exact ledger quality counters, under the same snapshot."""

from collections import defaultdict
from dataclasses import dataclass, field, replace
from decimal import Decimal

from shopgate_commerce_data.ledger.precision import decimal_text
from shopgate_commerce_data.ledger.query import (
    QUALITY_KEYS,
    Query,
    aggregate,
    ledger_read_snapshot,
    quality_keys,
)
from shopgate_commerce_data.ledger.scope import IDENTIFIER


@dataclass(frozen=True)
class EvidenceRequest:
    quality_key: str = "unknown_cost_lines"
    query: Query = field(default_factory=Query)
    search: str = ""
    sort: str = "key"
    descending: bool = False
    page: int = 1
    page_size: int = 20
    record_key: str | None = None
    event_page: int = 1

    def validate(self):
        self.query.validate()
        if not isinstance(self.quality_key, str) or self.quality_key not in QUALITY_KEYS:
            raise ValueError("请选择已登记的核算提醒。")
        if not isinstance(self.sort, str) or self.sort not in {"key", "date", "name"}:
            raise ValueError("证据排序无效。")
        if type(self.descending) is not bool:
            raise ValueError("排序方向无效。")
        if not isinstance(self.search, str) or len(self.search) > 200:
            raise ValueError("证据搜索内容过长。")
        if type(self.page_size) is not int or self.page_size != 20 or any(
            type(value) is not int or not 1 <= value <= 999999
            for value in (self.page, self.event_page)
        ):
            raise ValueError("证据使用每页20条，请检查页码。")
        if self.record_key is not None and (
            not isinstance(self.record_key, str) or not IDENTIFIER.fullmatch(self.record_key)
        ):
            raise ValueError("来源记录编号无效。")


def _reason(event, key):
    source = event["source"]
    if key in {"unknown_revenue_lines", "unknown_refund_lines"}:
        return "缺少原订单付款币种的换算汇率，尚不能核算人民币金额。"
    if key == "unknown_quantity_lines":
        return "平台商品尚未对应标准规格及单位换算关系，无法确定标准数量。"
    if key in {"unknown_expenses", "unknown_attribution_expenses"}:
        reason = {
            "missing_fx": "缺少费用发生时适用的汇率，原币费用尚不能换算成人民币。",
            "missing_weight": "用于分摊的成交金额尚未核算完整，暂时无法确定费用归属。",
            "unallocated": "没有符合分摊规则的订单明细，这笔费用暂未归属到具体商品。",
        }.get(source["accounting_status"], "费用归属尚未明确。")
        if key == "unknown_attribution_expenses":
            reason += "原始费用不等于本商品应承担的费用，所选范围金额保留待核算。"
        return reason
    reasons = []
    if "missing_mapping" in source["missing"]:
        reasons.append("平台商品尚未对应标准规格及单位换算关系")
    if "missing_cost" in source["missing"]:
        reasons.append("缺少付款时适用的商品成本")
    if "missing_fx" in source["missing"] and source["cost_fx_missing"]:
        reasons.append("缺少成本币种换算汇率")
    return "；".join(reasons) + "。"


def source_event(event):
    source, kind = event["source"], event["kind"]
    expense = kind == "expense"
    source_id = event.get("refund_id") or event.get("expense_id") or event["line_id"]
    return {
        "key": f"{kind}:{source_id}:{event.get('line_id', '')}",
        "kind": kind, "source_id": source_id, "date": event["date"].isoformat(),
        "order_id": event.get("order_id"), "line_id": event.get("line_id"),
        "refund_id": event.get("refund_id"), "expense_id": event.get("expense_id"),
        "store_name": event.get("store_name"), "listing_name": event.get("listing_name"),
        "paid_at": None if expense else source["paid_at"],
        "occurred_at": source.get("occurred_at"), "currency": source["currency"],
        "original_amount": source.get("original_amount", source.get("paid_amount")),
        "amount_cny": decimal_text(event.get(
            "expense" if expense else "refund" if kind == "refund" else "revenue"
        ), "money"),
        "cost_cny": None if expense else decimal_text(
            event["recovery" if kind == "refund" else "cost"], "money"
        ),
        "source_amount_cny": source.get("source_amount_cny"),
    }


def quality_evidence(connection, scope, request: EvidenceRequest):
    request.validate()
    # Overview counters always refer to the overall scope, not a displayed page.
    selected = replace(request.query, dimension="overall")
    with ledger_read_snapshot(connection, scope) as read:
        _, events, selected_range, cutoff = read.selected_events(selected)
        groups = defaultdict(list)
        for event in events:
            if request.quality_key in quality_keys(event):
                key = event["expense_id" if event["kind"] == "expense" else "line_id"]
                groups[key].append(event)
        records = []
        for key, members in groups.items():
            first = members[0]
            record = {
                "key": key, "kind": "expense" if first["kind"] == "expense" else "line",
                "name": (first["source"]["note"] or "经营费用")
                if first["kind"] == "expense" else first["listing_name"],
                "store_name": first.get("store_name"), "order_id": first.get("order_id"),
                "date": min(event["date"] for event in members).isoformat(),
                "event_count": len(members),
                "reasons": sorted({_reason(event, request.quality_key) for event in members}),
            }
            if request.search.casefold() in " ".join(
                str(record.get(name) or "") for name in ("key", "name", "store_name", "order_id")
            ).casefold():
                records.append(record)
        records.sort(key=lambda row: row["key"])
        records.sort(key=lambda row: row[request.sort], reverse=request.descending)
        # A selected source remains accessible on another list page, but never
        # escapes the current authorized scope or literal evidence search.
        members = groups.get(request.record_key, []) if any(
            row["key"] == request.record_key for row in records
        ) else []
        detailed = sorted(
            ({**source_event(e), "reason": _reason(e, request.quality_key)} for e in members),
            key=lambda event: (event["date"], event["key"]),
        )
        offset, event_offset = (request.page - 1) * 20, (request.event_page - 1) * 20
        return {
            "workspace_id": scope.workspace_id, "dataset_id": scope.dataset_id,
            "version": scope.version, "accounting_revision": read._run["revision"],
            "quality_key": request.quality_key, "range": selected_range, "data_cutoff": cutoff,
            "scope_total": len(groups), "rows": records[offset:offset + 20],
            "total": len(records), "page": request.page, "page_size": 20,
            "events": {"record_key": request.record_key,
                       "rows": detailed[event_offset:event_offset + 20],
                       "total": len(detailed), "page": request.event_page, "page_size": 20},
        }


@dataclass(frozen=True)
class SourceRequest:
    kind: str
    query: Query = field(default_factory=Query)
    search: str = ""
    order_id: str | None = None
    refund_analysis: bool = False
    reason_page: int = 1
    sort: str = "date"
    page_size: int = 20
    page: int = 1
    descending: bool = True

    def validate(self):
        self.query.validate()
        if not isinstance(self.kind, str) or self.kind not in ("sale", "refund", "expense"):
            raise ValueError("请选择付款、退款或经营费用记录。")
        if not isinstance(self.search, str) or len(self.search) > 200:
            raise ValueError("来源记录的搜索词过长。")
        if self.order_id is not None and (
            not isinstance(self.order_id, str) or not IDENTIFIER.fullmatch(self.order_id)
        ):
            raise ValueError("原订单编号无效。")
        if type(self.page) is not int or not 1 <= self.page <= 1_000_000:
            raise ValueError("页码无效，每页显示 20 条。")
        if (type(self.refund_analysis) is not bool or self.refund_analysis and (
            self.kind != "refund" or self.search or self.order_id
        )):
            raise ValueError("退款分析需使用当前页面的退款筛选范围。")
        if type(self.reason_page) is not int or not 1 <= self.reason_page <= 1_000_000:
            raise ValueError("退款原因页码无效。")
        if self.sort not in ("date", "amount", "cost", "order_id"):
            raise ValueError("来源明细排序字段无效。")
        if type(self.page_size) is not int or not 1 <= self.page_size <= 100:
            raise ValueError("每页记录数应在 1 到 100 之间。")
        if type(self.descending) is not bool:
            raise ValueError("日期排序方向无效。")


def posting(event):
    source = event["source"]
    data = source_event(event)
    return {
        **data,
        "key": "|".join([data["kind"], data["source_id"], data["line_id"] or ""]),
        "platform_order_id": event.get("platform_order_id"),
        "line_paid_amount": source.get("paid_amount"),
        "payment_missing": list(source["missing"]) if event["kind"] in ("sale", "refund") else None,
        "expense_type": source.get("expense_type"), "refund_type": source.get("refund_type"),
        **({k: source.get(k) for k in ("reason", "returned_quantity", "recoverable_quantity",
                                       "cancelled_quantity")} if event["kind"] == "refund" else {}),
        "allocation_method": source.get("allocation_method"),
        "accounting_status": source.get("accounting_status"),
    }


def refund_analysis(events, summary, query, reason_page):
    measures = ("sales_amount", "refund_amount", "refund_ratio", "refund_event_count",
                "refund_order_count", "refund_cost_recovery")
    totals = aggregate(summary, replace(query, metrics=measures))["metrics"]
    grouped = {}
    for dim in ("refund_reason", "refund_type"):
        groups = defaultdict(list)
        for event in events:
            groups[event[dim + "_id"]].append(event)
        values = []
        for key, members in groups.items():
            known = sum((e["refund"] for e in members if e["refund"] is not None), Decimal(0))
            known_text = decimal_text(known, "money")
            amount = known_text if all(e["refund"] is not None for e in members) else None
            values.append({"key": key, "name": members[0][dim + "_name"], "count": len(members),
                           "amount": amount, "known": known_text})
        values.sort(key=lambda r: (r["amount"] is None, -Decimal(r["known"]), r["key"]))
        offset = (reason_page - 1) * 20 if dim == "refund_reason" else 0
        grouped[dim] = {"total": len(values), "rows": values[offset:offset + 20]}
    return {"totals": totals, **grouped}


def source_records(connection, scope, request: SourceRequest):
    """Return postings within the signed accounting scope, including unallocated fees."""
    request.validate()
    with ledger_read_snapshot(connection, scope) as read:
        # For an order drill, allocation markers for that order carry unknown
        # amounts. For a whole store/platform, include the source expense once.
        grain = "order" if request.order_id else "overall"
        query = replace(request.query, dimension=grain)
        selected, summary, span, cutoff = read.selected_events(query)
        rows = selected if request.order_id else summary
        term = request.search.casefold()
        rows = [
            event for event in rows if event["kind"] == request.kind
            and (not request.order_id or event.get("order_id") == request.order_id)
            and (not term or term in event["search_text"].casefold())
        ]
        rows.sort(key=lambda e: (
            e.get("expense_id") or e.get("refund_id") or e["line_id"], e.get("line_id", "")
        ))
        field_name = {
            "date": "date", "order_id": "order_id",
            "amount": {"refund": "refund", "expense": "expense", "sale": "revenue"}[request.kind],
            "cost": "recovery" if request.kind == "refund" else "cost",
        }[request.sort]
        known = [e for e in rows if e.get(field_name) is not None]
        known.sort(key=lambda e: e[field_name], reverse=request.descending)
        rows = known + [e for e in rows if e.get(field_name) is None]
        offset = (request.page - 1) * request.page_size
        return {
            "workspace_id": scope.workspace_id, "dataset_id": scope.dataset_id,
            "version": scope.version, "accounting_revision": read._run["revision"],
            "range": span, "data_cutoff": cutoff, "kind": request.kind,
            **({"refund_analysis": refund_analysis(rows, summary, query, request.reason_page)}
               if request.refund_analysis else {}),
            "page": request.page, "page_size": request.page_size, "total": len(rows),
            "rows": [posting(event) for event in rows[offset:offset + request.page_size]],
        }
