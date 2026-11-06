"""Paginated evidence for exact ledger quality counters, under the same snapshot."""

from collections import defaultdict
from dataclasses import dataclass, field, replace

from shopgate_commerce_data.ledger.precision import decimal_text
from shopgate_commerce_data.ledger.query import (
    QUALITY_KEYS,
    Query,
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


def _event(event, key):
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
        "reason": _reason(event, key),
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
        detailed = sorted((_event(event, request.quality_key) for event in members),
                          key=lambda event: (event["date"], event["key"]))
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
