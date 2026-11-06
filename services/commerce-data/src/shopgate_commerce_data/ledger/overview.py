"""Version-consistent overview; every number comes from the shared ledger query."""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from shopgate_commerce_data.ledger.metrics import METRICS
from shopgate_commerce_data.ledger.query import Query, ledger_read_snapshot
from shopgate_commerce_data.ledger.references import reference_names

DAY = timedelta(days=1)
KPI_METRICS = (
    "net_sales",
    "accounted_contribution",
    "order_count",
    "average_order_value",
    "contribution_margin",
    "refund_ratio",
)


@dataclass(frozen=True)
class OverviewRequest:
    query: Query = field(default_factory=Query)
    interval: str = "day"
    channel_page: int = 1
    target_page: int = 1
    target_month: str | None = None
    channel_metric: str = "net_sales"

    def validate(self):
        self.query.validate()
        if self.interval not in {"day", "week"}:
            raise ValueError("趋势仅支持按日或按周查看。")
        if self.channel_metric not in {"net_sales", "accounted_contribution"}:
            raise ValueError("渠道仅支持按净销售额或已核算经营贡献排序。")
        for page in (self.channel_page, self.target_page):
            if type(page) is not int or not 1 <= page <= 1_000_000:
                raise ValueError("页码无效。")
        if self.target_month is not None:
            if not isinstance(self.target_month, str):
                raise ValueError("目标月份无效。")
            month = date.fromisoformat(self.target_month)
            if month.isoformat() != self.target_month or month.day != 1:
                raise ValueError("目标月份请使用该月第一天。")


def compare_value(current, previous, *, history_sufficient=True):
    """No percent for zero/negative bases or unavailable/missing history."""
    state = (
        "history_insufficient"
        if not history_sufficient
        else "missing"
        if current is None or previous is None
        else "zero_base"
        if Decimal(previous) == 0
        else "negative_base"
        if Decimal(previous) < 0
        else "comparable"
    )
    delta = None
    if history_sufficient and current is not None and previous is not None:
        delta = format(Decimal(current) - Decimal(previous), "f")
    growth = None
    if state == "comparable":
        growth = format(
            ((Decimal(current) - Decimal(previous)) / Decimal(previous)).quantize(
                Decimal("0.00000001"), rounding=ROUND_HALF_UP
            ),
            ".8f",
        )
    return {
        "current": current,
        "previous": previous,
        "difference": delta,
        "growth_ratio": growth,
        "state": state,
    }


def _page(rows, page):
    offset = (page - 1) * 20
    return {"rows": rows[offset : offset + 20], "total": len(rows), "page": page, "page_size": 20}


def _completion(actual, target):
    if actual is None or target is None or target <= 0:
        return None
    return format(
        (Decimal(actual) / target).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP),
        ".8f",
    )


def _channels(read, fixed, request, summary):
    selected = replace(fixed, dimension="channel", page_size=200, sort=request.channel_metric)
    first = read.query(selected)
    records = list(first["rows"])
    for page in range(2, (first["total"] + 199) // 200 + 1):
        records.extend(read.query(replace(selected, page=page))["rows"])
    states = {}
    for metric in ("net_sales", "accounted_contribution"):
        denominator = summary["metrics"][metric]
        values = [row["metrics"][metric] for row in records]
        state = (
            "incomplete" if denominator is None or any(value is None for value in values)
            else "nonpositive_total" if Decimal(denominator) <= 0
            else "negative_values" if any(Decimal(value) < 0 for value in values)
            else "comparable"
        )
        states[metric] = state
        for row in records:
            row.setdefault("shares", {})[metric] = (
                _completion(row["metrics"][metric], Decimal(denominator))
                if state == "comparable" else None
            )
    return {**_page(records, request.channel_page), "share_states": states}


def _monthly_targets(read, selected, month, page):
    end = month.replace(day=calendar.monthrange(month.year, month.month)[1])
    # Targets exist only at store/month granularity. Item/search/date filters
    # cannot silently turn a whole-month target into an item/day target.
    monthly = Query(
        start=month.isoformat(),
        end=end.isoformat(),
        channel_ids=selected.channel_ids,
        store_ids=selected.store_ids,
        refund_basis="payment",
        dimension="store",
    )
    records = [
        row
        for row in read.target_records(month)
        if (not monthly.channel_ids or row["channel_id"] in monthly.channel_ids)
        and (not monthly.store_ids or row["store_id"] in monthly.store_ids)
    ]
    monthly_result = read.query(replace(monthly, page_size=200))
    actual_by_store = {row["key"]: row["metrics"] for row in monthly_result["rows"]}
    for current_page in range(2, (monthly_result["total"] + 199) // 200 + 1):
        actual_by_store.update(
            {
                row["key"]: row["metrics"]
                for row in read.query(replace(monthly, page=current_page, page_size=200))["rows"]
            }
        )
    result = []
    total_target = Decimal(0)
    configured = 0
    for row in records:
        actual_metrics = actual_by_store.get(row["store_id"], {})
        actual = actual_metrics.get("net_sales")
        target = row["sales_target"]
        profit_target = row["profit_target"]
        if target is not None:
            total_target += target
            configured += 1
        result.append(
            {
                "store_id": row["store_id"],
                "store_name": row["store_name"],
                "channel_id": row["channel_id"],
                "month": month.isoformat(),
                "sales_target": format(target, ".2f") if target is not None else None,
                "profit_target": format(profit_target, ".2f")
                if profit_target is not None
                else None,
                "net_sales": actual,
                "contribution_profit": actual_metrics.get("contribution_profit"),
                "accounted_contribution": actual_metrics.get("accounted_contribution"),
                "completion_ratio": _completion(actual, target),
                "profit_completion_ratio": _completion(
                    actual_metrics.get("contribution_profit"), profit_target
                ),
                "state": "not_set" if target is None else "recorded",
                "actual_state": "recorded" if row["store_id"] in actual_by_store else "no_records",
            }
        )
    return {
        **_page(result, page),
        "month": month.isoformat(),
        "range": {"start": month.isoformat(), "end": end.isoformat()},
        "configured_count": configured,
        "sales_target_total": format(total_target, ".2f") if configured else None,
        "actual_summary": monthly_result["summary"],
        "scope_note": (
            "按所选平台与店铺的完整自然月净销售额对比；不沿用商品、搜索或部分日期筛选。"
        ),
    }


def _trend(read, query, start, end, interval):
    # Bound the response explicitly, never silently truncate dates or lists.
    if (end - start).days > 3660:
        raise ValueError("趋势一次最多查看3661天，请缩小日期范围后继续。")
    raw = read.query(
        replace(query, dimension=interval, sort="key", descending=False, page=1, page_size=200)
    )
    rows = list(raw["rows"])
    for page in range(2, (raw["total"] + 199) // 200 + 1):
        rows.extend(
            read.query(
                replace(
                    query,
                    dimension=interval,
                    sort="key",
                    descending=False,
                    page=page,
                    page_size=200,
                )
            )["rows"]
        )
    known = {row["key"]: row for row in rows}
    cursor = start if interval == "day" else start - timedelta(days=start.weekday())
    step = DAY if interval == "day" else timedelta(days=7)
    buckets = []
    while cursor <= end:
        available = min(step.days - 1, (end - cursor).days)
        bucket_start, bucket_end = max(cursor, start), cursor + timedelta(days=available)
        key = cursor.isoformat()
        row = known.get(key)
        buckets.append(
            {
                "key": key,
                "start": bucket_start.isoformat(),
                "end": bucket_end.isoformat(),
                "state": "recorded" if row else "no_records",
                "metrics": row["metrics"] if row else None,
                "quality": row["quality"] if row else None,
            }
        )
        if (date.max - cursor).days < step.days:
            break
        cursor += step
    return {
        "interval": interval,
        "rows": buckets,
        "note": "无经营记录的日期保留为空；不能据此证明当天完整销售额为零。",
    }


def _attention(summary, comparison, query):
    """Documented observation rules with controlled evidence parameters, not causal claims."""
    quality, metrics = summary["quality"], summary["metrics"]
    rules = []
    for key, name in (
        ("unknown_revenue_lines", "付款金额"),
        ("unknown_refund_lines", "退款金额"),
        ("unknown_cost_lines", "商品成本"),
        ("unknown_expenses", "经营费用"),
        ("unknown_attribution_expenses", "费用归属"),
    ):
        if quality[key]:
            rules.append(
                {
                    "id": key,
                    "title": f"有{name}尚未核算完整",
                    "description": f"当前范围有{quality[key]}项记录缺少{name}依据，"
                    "请查看来源并补齐；相关金额保留待核算状态。",
                    "rule": "记录缺失数大于0",
                    "evidence": {
                        "quality_key": key,
                        "query": {"dimension": "line", "start": query.start, "end": query.end},
                    },
                    "severity": "attention",
                }
            )
    net = comparison["net_sales"]
    if net["state"] == "comparable" and Decimal(net["growth_ratio"]) < Decimal("-0.10"):
        rules.append(
            {
                "id": "sales_decline",
                "title": "净销售额比前期减少超过10%",
                "description": "所选期间与等长前期的净销售额出现减少；"
                "可以继续比较平台、店铺和商品，核对减少来自哪些记录。",
                "rule": "历史期间可比较且净销售额变化低于-10%",
                "evidence": {"comparison": net},
                "severity": "attention",
            }
        )
    if Decimal(metrics["accounted_contribution"]) < 0:
        rules.append(
            {
                "id": "negative_contribution",
                "title": "已核算经营贡献为负数",
                "description": "已核算收入扣除退款、商品成本和已知费用后为负数；"
                "请查看成本、费用及退款记录，未核算范围仍需另行确认。",
                "rule": "已核算经营贡献金额小于0",
                "evidence": {
                    "metric": "accounted_contribution",
                    "value": metrics["accounted_contribution"],
                },
                "severity": "attention",
            }
        )
    return _page(rules, 1)


def overview(connection, scope, request: OverviewRequest):
    request.validate()
    selected = replace(
        request.query, dimension="overall", metrics=tuple(METRICS), page=1, page_size=20
    )
    with ledger_read_snapshot(connection, scope) as read:
        current = read.query(selected)
        start_text, end_text = current["range"]["start"], current["range"]["end"]
        base = {
            key: current[key]
            for key in (
                "workspace_id",
                "dataset_id",
                "version",
                "accounting_revision",
                "algorithm_version",
                "range",
                "data_cutoff",
                "summary",
            )
        }
        base["scope_names"] = reference_names(read, selected)
        if start_text is None or end_text is None or current["data_cutoff"] is None:
            return {
                **base,
                "state": "empty",
                "previous": None,
                "comparison": {},
                "trend": {"interval": request.interval, "rows": []},
                "channels": _page([], request.channel_page),
                "attention": _page([], 1),
                "targets": _monthly_targets(
                    read, selected, date.fromisoformat(request.target_month), request.target_page
                )
                if request.target_month
                else None,
                "recorded_start": None,
            }
        start, end = date.fromisoformat(start_text), date.fromisoformat(end_text)
        if start > end:
            raise ValueError("开始日期晚于当前数据集的截止日期，请调整日期范围。")
        fixed = replace(selected, start=start_text, end=end_text)
        length = (end - start).days + 1
        previous_start = start - timedelta(days=length) if start.toordinal() > length else None
        previous_end = start - DAY if start > date.min else None
        history_sufficient = bool(
            previous_start
            and read.recorded_start
            and read.recorded_start <= previous_start
            and end <= date.fromisoformat(current["data_cutoff"])
        )
        previous = None
        if previous_start is not None:
            previous = read.query(
                replace(fixed, start=previous_start.isoformat(), end=previous_end.isoformat())
            )
        comparison = {
            metric: compare_value(
                current["summary"]["metrics"][metric],
                previous["summary"]["metrics"][metric] if previous else None,
                history_sufficient=history_sufficient,
            )
            for metric in KPI_METRICS
        }
        channels = _channels(read, fixed, request, current["summary"])
        month = (
            date.fromisoformat(request.target_month) if request.target_month else end.replace(day=1)
        )
        return {
            **base,
            "state": "ready",
            "recorded_start": read.recorded_start.isoformat(),
            "previous": {
                "range": previous["range"],
                "summary": previous["summary"],
                "history_sufficient": history_sufficient,
            }
            if previous
            else None,
            "comparison": comparison,
            "trend": _trend(read, fixed, start, end, request.interval),
            "channels": channels,
            "attention": _attention(current["summary"], comparison, fixed),
            "targets": _monthly_targets(read, selected, month, request.target_page),
            "notes": [
                "全部结果使用同一只读事务、数据版本和核算版本。",
                "前期按相同天数比较；源记录起止不能保证中间每一天已完整接入。",
                "已核算经营贡献未包含尚未接入的固定支出，不是财务净利润。",
            ],
        }
