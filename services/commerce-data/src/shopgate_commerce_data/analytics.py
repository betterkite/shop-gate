"""P28 电商经营分析能力（基于 dataset_* 扩展数据集）。

所有函数先读取数据集契约，再返回结果和限制说明。扩展数据可以支撑演示分析，
但不能把合成订单、成本、渠道归因或库存快照描述成真实业务事实。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote

from shopgate_commerce_data.retail import fetch_all

ANALYTICS_LIMITATIONS = [
    "用户画像、渠道/活动归因、成本、退款、履约和库存快照均为合成字段",
    "订单由合成 buy 事件派生，不能用于真实收入确认或财务结算",
    "渠道和活动指标是确定性模拟，不代表广告平台回传或实验结果",
    "库存可售天数是演示计算，不能单独替代真实补货决策",
]

ANALYTICS_SCOPE_DIMENSIONS = {"item", "category", "channel", "campaign"}
ITEM_SCOPE_DIMENSIONS = {"item", "category"}


def _number(value: Any) -> float:
    return float(value or 0)


def _iso(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def _normalize_scope(
    dimension: str | None,
    value: str | None,
    *,
    supported: set[str] = ANALYTICS_SCOPE_DIMENSIONS,
) -> tuple[str | None, str | None, int | str | None]:
    """Validate a workbench filter before interpolating its trusted column name."""

    if (dimension is None) != (value is None):
        raise ValueError("筛选必须同时提供 dimension 和 value")
    if dimension is None or value is None:
        return None, None, None
    if dimension not in supported:
        labels = {"item": "商品", "category": "类目", "channel": "渠道", "campaign": "活动"}
        raise ValueError(
            f"当前分析不支持按{labels.get(dimension, dimension)}筛选"
        )
    if not value.strip():
        raise ValueError("筛选值不能为空")
    if dimension in ITEM_SCOPE_DIMENSIONS:
        try:
            normalized_value: int | str = int(value)
        except ValueError as error:
            raise ValueError("商品或类目筛选值必须是数字") from error
    else:
        normalized_value = value
    return dimension, value, normalized_value


def _order_scope(
    dimension: str | None,
    value: str | None,
    *,
    order_alias: str = "o",
    item_alias: str = "i",
    supported: set[str] = ANALYTICS_SCOPE_DIMENSIONS,
) -> tuple[str, tuple[int | str, ...], dict[str, Any]]:
    normalized_dimension, original_value, normalized_value = _normalize_scope(
        dimension, value, supported=supported
    )
    if normalized_dimension is None or normalized_value is None:
        return "", (), {"dimension": None, "value": None, "applied": True}
    column_alias = item_alias if normalized_dimension in ITEM_SCOPE_DIMENSIONS else order_alias
    column = "item_id" if normalized_dimension == "item" else (
        "category_id" if normalized_dimension == "category" else f"{normalized_dimension}_id"
    )
    return (
        f" AND {column_alias}.{column} = %s",
        (normalized_value,),
        {
            "dimension": normalized_dimension,
            "value": original_value,
            "applied": True,
        },
    )


async def _contract(dataset_id: str) -> dict[str, Any]:
    rows = await fetch_all(
        """
        SELECT dataset_id, version, source_kind, source_name, schema_version,
               window_start, window_end, generation_seed, row_counts,
               synthetic_fields, limitations, generation_rule
        FROM commerce.dataset_contracts
        WHERE dataset_id = %s
        """,
        (dataset_id,),
    )
    if not rows:
        raise ValueError(f"数据集不存在：{dataset_id}")
    row = rows[0]
    return {key: _iso(value) for key, value in row.items()}


async def analytics_dataset_meta(dataset_id: str) -> dict[str, Any]:
    """Return the window and scale for one isolated analytics dataset."""

    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        SELECT MIN(event_ts) AS first_event_ts,
               MAX(event_ts) AS last_event_ts,
               COUNT(*) AS event_count,
               COUNT(DISTINCT user_id) AS user_count,
               COUNT(DISTINCT item_id) AS item_count,
               COUNT(DISTINCT category_id) AS category_count,
               COUNT(DISTINCT source) AS source_count
        FROM commerce.dataset_behavior_events
        WHERE dataset_id = %s
        """,
        (dataset_id,),
    )
    row = rows[0] if rows else {}
    return {
        "dataset_id": dataset_id,
        "first_event_ts": _iso(row.get("first_event_ts")) or contract.get("window_start"),
        "last_event_ts": _iso(row.get("last_event_ts")) or contract.get("window_end"),
        "event_count": row.get("event_count", 0),
        "user_count": row.get("user_count", 0),
        "item_count": row.get("item_count", 0),
        "category_count": row.get("category_count", 0),
        "source_count": row.get("source_count", 0),
        "behavior_source": contract.get("source_name"),
        "source_kind": contract.get("source_kind"),
        "synthetic_fields": contract.get("synthetic_fields", []),
        "window_start": contract.get("window_start"),
        "window_end": contract.get("window_end"),
    }


def _response(dataset_id: str, contract: dict[str, Any], **payload: Any) -> dict[str, Any]:
    return {
        "dataset_id": dataset_id,
        "contract": contract,
        "synthetic": True,
        "limitations": ANALYTICS_LIMITATIONS,
        **payload,
    }


def classify_rfm(recency_days: int, frequency: int, monetary: float, monetary_p75: float) -> str:
    """用用户能理解的标签解释 RFM，而不是暴露金融术语。"""

    if recency_days > 21:
        return "流失风险"
    if frequency >= 5 and monetary >= monetary_p75:
        return "高价值"
    if frequency <= 1 and recency_days <= 14:
        return "新近购买"
    return "稳定复购"


def inventory_health_label(closing_stock: int, average_daily_sold: float, days_cover: float) -> str:
    if closing_stock <= 0:
        return "缺货风险"
    if average_daily_sold <= 0:
        return "有库存但无销量"
    if days_cover > 45:
        return "库存积压"
    return "库存正常"


LIFECYCLE_STAGES = ("未启动", "成长期", "稳定期", "衰退风险")


def classify_lifecycle_stage(
    window_start: date,
    window_end: date,
    first_order: date | None,
    last_order: date | None,
) -> tuple[str, int | None, int | None]:
    """根据购买活跃度返回用户可理解的商品经营阶段。"""

    if first_order is None or last_order is None:
        return "未启动", None, None
    active_days = (last_order - first_order).days + 1
    days_since_last = (window_end - last_order).days
    if days_since_last > 14:
        return "衰退风险", active_days, days_since_last
    if (first_order - window_start).days >= max((window_end - window_start).days - 14, 0):
        return "成长期", active_days, days_since_last
    if active_days >= 14:
        return "稳定期", active_days, days_since_last
    return "成长期", active_days, days_since_last


async def analytics_overview(
    dataset_id: str,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    scope_clause, scope_params, scope = _order_scope(dimension, value)
    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        SELECT COUNT(DISTINCT o.order_id) AS orders,
               COUNT(DISTINCT o.user_id) AS buyers,
               COUNT(DISTINCT o.item_id) AS sold_items,
               COALESCE(SUM(o.quantity), 0) AS units,
               COALESCE(SUM(o.quantity * o.selling_price), 0) AS gross_sales,
               COALESCE(SUM(o.refund_amount), 0) AS refunds,
               COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount), 0) AS net_sales
        FROM commerce.dataset_orders o
        JOIN commerce.dataset_item_economics i
          ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
        WHERE o.dataset_id = %s
        """
        + scope_clause
        + """
        """,
        (dataset_id, *scope_params),
    )

    quality = await fetch_all(
        """
        SELECT severity, issue_count, checked_rows, created_at
        FROM commerce.data_quality_scans
        WHERE universe_id = %s AND scope = 'analytics_dataset'
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (dataset_id,),
    )
    row = rows[0] if rows else {}
    integer_metrics = {"orders", "buyers", "sold_items", "units"}
    metrics = {
        key: int(value or 0) if key in integer_metrics else round(_number(value), 2)
        for key, value in row.items()
    }
    return _response(
        dataset_id,
        contract,
        scope=scope,
        metrics=metrics,
        quality=quality[0] if quality else {"severity": "unknown", "issue_count": None},
    )


async def analytics_trend(
    dataset_id: str,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    """Return a daily trend that follows the optional workbench drilldown scope."""

    allowed_dimensions = {"item", "category", "channel", "campaign"}
    if (dimension is None) != (value is None):
        raise ValueError("趋势筛选必须同时提供 dimension 和 value")
    if dimension is not None and dimension not in allowed_dimensions:
        raise ValueError("趋势筛选只支持商品、类目、渠道或活动")
    contract = await _contract(dataset_id)

    behavior_clause = ""
    behavior_params: list[Any] = [dataset_id]
    order_clause = ""
    order_params: list[Any] = [dataset_id]
    if dimension in {"item", "category"} and value is not None:
        try:
            numeric_value = int(value)
        except ValueError as error:
            raise ValueError("商品或类目趋势筛选值必须是数字") from error
        behavior_column = "item_id" if dimension == "item" else "category_id"
        behavior_clause = f" AND {behavior_column} = %s"
        behavior_params.append(numeric_value)
        order_clause = f" AND {behavior_column} = %s"
        order_params.append(numeric_value)
    elif dimension in {"channel", "campaign"} and value is not None:
        order_column = "channel_id" if dimension == "channel" else "campaign_id"
        order_clause = f" AND {order_column} = %s"
        order_params.append(value)

    behavior_rows: list[dict[str, Any]] = []
    if dimension not in {"channel", "campaign"}:
        behavior_rows = await fetch_all(
            f"""
            SELECT event_ts::date AS stat_date,
                   COUNT(*) FILTER (WHERE behavior_type = 'pv') AS pv,
                   COUNT(*) FILTER (WHERE behavior_type = 'fav') AS fav,
                   COUNT(*) FILTER (WHERE behavior_type = 'cart') AS cart,
                   COUNT(*) FILTER (WHERE behavior_type = 'buy') AS buy
            FROM commerce.dataset_behavior_events
            WHERE dataset_id = %s{behavior_clause}
            GROUP BY event_ts::date
            ORDER BY stat_date
            """,
            tuple(behavior_params),
        )
    order_rows = await fetch_all(
        f"""
        SELECT ordered_at::date AS stat_date,
               COUNT(DISTINCT order_id) AS orders,
               COALESCE(SUM(quantity * selling_price - refund_amount), 0) AS net_sales
        FROM commerce.dataset_orders
        WHERE dataset_id = %s{order_clause}
        GROUP BY ordered_at::date
        ORDER BY stat_date
        """,
        tuple(order_params),
    )

    behavior_by_date = {str(row["stat_date"]): row for row in behavior_rows}
    orders_by_date = {str(row["stat_date"]): row for row in order_rows}
    window_start = date.fromisoformat(str(contract["window_start"]))
    window_end = date.fromisoformat(str(contract["window_end"]))
    rows: list[dict[str, Any]] = []
    cursor = window_start
    while cursor <= window_end:
        date_key = cursor.isoformat()
        behavior = behavior_by_date.get(date_key, {})
        orders = orders_by_date.get(date_key, {})
        rows.append({
            "stat_date": date_key,
            "pv": int(behavior.get("pv") or 0),
            "fav": int(behavior.get("fav") or 0),
            "cart": int(behavior.get("cart") or 0),
            "buy": int(behavior.get("buy") or 0),
            "orders": int(orders.get("orders") or 0),
            "net_sales": round(_number(orders.get("net_sales")), 2),
        })
        cursor += timedelta(days=1)

    payload: dict[str, Any] = {
        "filter": {"dimension": dimension, "value": value},
        "metric_definition": {
            "pv": "页面浏览事件数；渠道/活动筛选未采集行为事件归因时为 0",
            "buy": "购买行为事件数",
            "orders": "订单数",
            "net_sales": "合成成交价减合成退款",
        },
        "rows": rows,
    }
    if dimension is not None and value is not None:
        payload["context_url"] = (
            "/analytics-workbench?view=drilldown&dataset_id="
            f"{quote(dataset_id)}&dimension={quote(dimension)}&value={quote(value)}"
        )
    return _response(dataset_id, contract, **payload)


async def item_behavior_metrics(dataset_id: str, limit: int = 20) -> dict[str, Any]:
    """返回数据集内商品级行为漏斗，保留 PV 到购买的真实事件关系。"""

    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        SELECT item_id, category_id,
               COUNT(*) FILTER (WHERE behavior_type = 'pv') AS pv,
               COUNT(*) FILTER (WHERE behavior_type = 'fav') AS fav,
               COUNT(*) FILTER (WHERE behavior_type = 'cart') AS cart,
               COUNT(*) FILTER (WHERE behavior_type = 'buy') AS buy,
               COUNT(DISTINCT user_id) AS users
        FROM commerce.dataset_behavior_events
        WHERE dataset_id = %s
        GROUP BY item_id, category_id
        ORDER BY buy DESC, pv DESC, item_id
        LIMIT %s
        """,
        (dataset_id, limit),
    )
    items = []
    for row in rows:
        pv = int(row["pv"] or 0)
        buy = int(row["buy"] or 0)
        items.append(
            {
                **row,
                "pv": pv,
                "fav": int(row["fav"] or 0),
                "cart": int(row["cart"] or 0),
                "buy": buy,
                "users": int(row["users"] or 0),
                "buy_conversion": round(buy / pv, 6) if pv else 0.0,
            }
        )
    return _response(
        dataset_id,
        contract,
        metric_definition={
            "pv": "商品页面浏览事件数",
            "buy": "商品购买事件数",
            "buy_conversion": "购买事件 ÷ 页面浏览事件；没有浏览事件时为 0",
        },
        items=items,
    )


async def rfm_segments(
    dataset_id: str,
    limit: int = 20,
    page: int = 1,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    window_end = date.fromisoformat(str(contract["window_end"]))
    scope_clause, scope_params, scope = _order_scope(dimension, value)
    rows = await fetch_all(
        """
        SELECT o.user_id,
               MAX(o.ordered_at)::date AS last_order_date,
               COUNT(DISTINCT o.order_id) AS frequency,
               SUM(o.quantity) AS units,
               SUM(o.quantity * o.selling_price - o.refund_amount) AS monetary,
               p.age_band, p.city_tier, p.member_level
        FROM commerce.dataset_orders o
        JOIN commerce.dataset_item_economics i
          ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
        LEFT JOIN commerce.dataset_user_profiles p
          ON p.dataset_id = o.dataset_id AND p.user_id = o.user_id
        WHERE o.dataset_id = %s
        """
        + scope_clause
        + """
        GROUP BY o.user_id, p.age_band, p.city_tier, p.member_level
        ORDER BY monetary DESC, frequency DESC, o.user_id
        """,
        (dataset_id, *scope_params),
    )
    monetary_values = sorted(_number(row["monetary"]) for row in rows)
    p75 = monetary_values[int((len(monetary_values) - 1) * 0.75)] if monetary_values else 0
    all_customers: list[dict[str, Any]] = []
    segment_counts: dict[str, int] = {}
    for row in rows:
        recency = (window_end - row["last_order_date"]).days
        monetary = _number(row["monetary"])
        segment = classify_rfm(recency, int(row["frequency"]), monetary, p75)
        segment_counts[segment] = segment_counts.get(segment, 0) + 1
        all_customers.append(
            {
                "user_id": row["user_id"],
                "last_order_date": row["last_order_date"].isoformat(),
                "recency_days": recency,
                "frequency": int(row["frequency"]),
                "units": int(row["units"] or 0),
                "monetary": round(monetary, 2),
                "segment": segment,
                "age_band": row["age_band"],
                "city_tier": row["city_tier"],
                "member_level": row["member_level"],
            }
        )
    page_count = max((len(all_customers) + limit - 1) // limit, 1)
    page = min(max(page, 1), page_count)
    start = (page - 1) * limit
    customers = all_customers[start : start + limit]
    return _response(
        dataset_id,
        contract,
        scope=scope,
        metric_definition={
            "recency_days": "距最近一次购买的天数",
            "frequency": "窗口内订单数",
            "monetary": "订单净金额（合成成交价减合成退款）",
        },
        monetary_p75=round(p75, 2),
        customer_count=len(rows),
        page=page,
        page_size=limit,
        page_count=page_count,
        segment_counts=segment_counts,
        customers=customers,
    )


def _cohort_week(value: date) -> date:
    return value - timedelta(days=value.weekday())


async def retention_metrics(
    dataset_id: str,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    """按用户首次购买周计算后续购买留存，不把浏览事件误当成留存。"""

    scope_clause, scope_params, scope = _order_scope(dimension, value)
    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        SELECT o.user_id, o.ordered_at::date AS activity_date
        FROM commerce.dataset_orders o
        JOIN commerce.dataset_item_economics i
          ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
        WHERE o.dataset_id = %s
        """
        + scope_clause
        + """
        ORDER BY o.user_id, activity_date
        """,
        (dataset_id, *scope_params),
    )
    activity_by_user: dict[Any, set[date]] = {}
    for row in rows:
        activity_date = row.get("activity_date")
        if isinstance(activity_date, datetime):
            activity_date = activity_date.date()
        if not isinstance(activity_date, date):
            continue
        activity_by_user.setdefault(row["user_id"], set()).add(activity_date)

    window_start = date.fromisoformat(str(contract["window_start"]))
    window_end = date.fromisoformat(str(contract["window_end"]))
    max_period = min(((window_end - window_start).days // 7) + 1, 12)
    cohorts: dict[date, set[Any]] = {}
    period_users: dict[date, dict[int, set[Any]]] = {}
    for user_id, activity_dates in activity_by_user.items():
        first_order = min(activity_dates)
        cohort = _cohort_week(first_order)
        cohorts.setdefault(cohort, set()).add(user_id)
        for activity_date in activity_dates:
            activity_week = _cohort_week(activity_date)
            period = (activity_week - cohort).days // 7
            if 0 <= period < max_period:
                period_users.setdefault(cohort, {}).setdefault(period, set()).add(user_id)

    cohort_rows: list[dict[str, Any]] = []
    eligible_cohorts = 0
    eligible_users = 0
    retained_users = 0
    for cohort in sorted(cohorts):
        cohort_size = len(cohorts[cohort])
        has_full_week = cohort + timedelta(days=7) <= window_end
        period_rows = []
        for period in range(max_period):
            users = len(period_users.get(cohort, {}).get(period, set()))
            period_rows.append({
                "period": period,
                "label": "首周" if period == 0 else f"第 {period + 1} 周",
                "users": users,
                "rate": round(users / cohort_size, 6) if cohort_size else 0.0,
            })
        if has_full_week:
            eligible_cohorts += 1
            eligible_users += cohort_size
            retained_users += len(period_users.get(cohort, {}).get(1, set()))
        cohort_rows.append({
            "cohort_week": cohort.isoformat(),
            "cohort_users": cohort_size,
            "periods": period_rows,
        })

    return _response(
        dataset_id,
        contract,
        scope=scope,
        metric_definition={
            "cohort": "按用户首次购买所在周分组",
            "retention": "后续周仍发生购买的用户数 ÷ 首购周用户数",
            "eligible_7d": "首购周距窗口结束至少 7 天的用户，才纳入 7 日留存率",
        },
        summary={
            "buyer_count": len(activity_by_user),
            "cohort_count": len(cohort_rows),
            "eligible_7d_cohorts": eligible_cohorts,
            "eligible_7d_users": eligible_users,
            "retained_7d_users": retained_users,
            "retention_7d_rate": round(retained_users / eligible_users, 6)
            if eligible_users else None,
        },
        cohorts=cohort_rows,
        max_period=max_period,
    )


async def channel_campaign_metrics(
    dataset_id: str,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    scope_clause, scope_params, scope = _order_scope(dimension, value)
    item_scoped = dimension in ITEM_SCOPE_DIMENSIONS
    session_select = (
        "NULL::bigint AS sessions,"
        if item_scoped
        else "COUNT(DISTINCT s.session_id) AS sessions,"
    )
    rows = await fetch_all(
        """
        SELECT s.channel_id, ch.name AS channel_name, ch.channel_type,
               s.campaign_id, ca.name AS campaign_name, ca.campaign_type,
               """
        + session_select
        + """
               COUNT(DISTINCT s.user_id) AS users,
               COUNT(DISTINCT o.order_id) AS orders,
               COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount), 0) AS net_sales
        FROM commerce.dataset_sessions s
        LEFT JOIN commerce.dataset_channels ch
          ON ch.dataset_id = s.dataset_id AND ch.channel_id = s.channel_id
        LEFT JOIN commerce.dataset_campaigns ca
          ON ca.dataset_id = s.dataset_id AND ca.campaign_id = s.campaign_id
        LEFT JOIN commerce.dataset_orders o
          ON o.dataset_id = s.dataset_id AND o.session_id = s.session_id
        LEFT JOIN commerce.dataset_item_economics i
          ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
        WHERE s.dataset_id = %s
        """
        + scope_clause
        + """
        GROUP BY s.channel_id, ch.name, ch.channel_type, s.campaign_id,
                 ca.name, ca.campaign_type
        ORDER BY net_sales DESC, sessions DESC
        """,
        (dataset_id, *scope_params),
    )
    metrics = []
    for row in rows:
        sessions = int(row["sessions"]) if row["sessions"] is not None else None
        orders = int(row["orders"] or 0)
        metrics.append(
            {
                **row,
                "sessions": sessions,
                "users": int(row["users"] or 0),
                "orders": orders,
                "net_sales": round(_number(row["net_sales"]), 2),
                "order_conversion": round(orders / sessions, 6) if sessions else None,
            }
        )
    return _response(
        dataset_id,
        contract,
        scope=scope,
        metric_definition={
            "order_conversion": (
                "商品或类目筛选时无商品级渠道曝光映射，不提供会话转化率"
                if item_scoped
                else "订单数 ÷ 会话数，不是广告平台归因转化率"
            ),
            "net_sales": "合成成交价减合成退款",
            "scoped_sessions": (
                "商品或类目筛选时不提供会话数；当前仅按筛选范围内的订单关联渠道汇总"
                if item_scoped
                else "按当前筛选范围统计会话"
            ),
        },
        metrics=metrics,
    )


async def profit_metrics(
    dataset_id: str,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    scope_clause, scope_params, scope = _order_scope(dimension, value)
    rows = await fetch_all(
        """
        SELECT o.channel_id, ch.name AS channel_name,
               COUNT(DISTINCT o.order_id) AS orders,
               COALESCE(SUM(o.quantity * o.selling_price), 0) AS gross_sales,
               COALESCE(SUM(o.refund_amount), 0) AS refunds,
               COALESCE(SUM(o.quantity * i.cost_price), 0) AS cost,
               COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount
                            - o.quantity * i.cost_price), 0) AS gross_profit
        FROM commerce.dataset_orders o
        JOIN commerce.dataset_item_economics i
          ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
        LEFT JOIN commerce.dataset_channels ch
          ON ch.dataset_id = o.dataset_id AND ch.channel_id = o.channel_id
        WHERE o.dataset_id = %s
        """
        + scope_clause
        + """
        GROUP BY o.channel_id, ch.name
        ORDER BY gross_profit DESC
        """,
        (dataset_id, *scope_params),
    )
    metrics = []
    total = {"orders": 0, "gross_sales": 0.0, "refunds": 0.0, "cost": 0.0, "gross_profit": 0.0}
    for row in rows:
        values = {
            "orders": int(row["orders"] or 0),
            "gross_sales": _number(row["gross_sales"]),
            "refunds": _number(row["refunds"]),
            "cost": _number(row["cost"]),
            "gross_profit": _number(row["gross_profit"]),
        }
        total = {key: total[key] + value for key, value in values.items()}
        metrics.append(
            {
                **row,
                **{
                    key: round(value, 2) if key != "orders" else value
                    for key, value in values.items()
                },
                "gross_margin": round(values["gross_profit"] / values["gross_sales"], 6)
                if values["gross_sales"]
                else 0.0,
            }
        )
    total["gross_margin"] = (
        total["gross_profit"] / total["gross_sales"] if total["gross_sales"] else 0.0
    )
    return _response(
        dataset_id,
        contract,
        scope=scope,
        metric_definition={
            "gross_profit": "净销售额 - 合成商品成本",
            "gross_margin": "毛利 ÷ 毛销售额",
        },
        total={
            key: round(value, 6) if key == "gross_margin" else round(value, 2)
            for key, value in total.items()
        },
        by_channel=metrics,
    )


async def inventory_analytics(
    dataset_id: str,
    limit: int = 20,
    page: int = 1,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    scope_clause, scope_params, scope = _order_scope(
        dimension,
        value,
        supported=ITEM_SCOPE_DIMENSIONS,
        item_alias="i",
    )
    rows = await fetch_all(
        """
        WITH latest AS (
          SELECT DISTINCT ON (s.item_id) s.item_id, i.category_id, s.snapshot_date,
                 s.closing_stock, s.reserved_qty
          FROM commerce.dataset_inventory_snapshots s
          JOIN commerce.dataset_item_economics i
            ON i.dataset_id = s.dataset_id AND i.item_id = s.item_id
          WHERE s.dataset_id = %s
          """
        + scope_clause
        + """
          ORDER BY s.item_id, s.snapshot_date DESC
        ), velocity AS (
          SELECT s.item_id, AVG(s.sold_qty) AS average_daily_sold,
                 SUM(s.sold_qty) AS sold_units
          FROM commerce.dataset_inventory_snapshots s
          JOIN commerce.dataset_item_economics i
            ON i.dataset_id = s.dataset_id AND i.item_id = s.item_id
          WHERE s.dataset_id = %s
          """
        + scope_clause
        + """
          GROUP BY s.item_id
        )
        SELECT l.item_id, l.snapshot_date, l.closing_stock, l.reserved_qty,
               v.average_daily_sold, v.sold_units
        FROM latest l
        JOIN velocity v ON v.item_id = l.item_id
        ORDER BY l.closing_stock DESC, l.item_id
        """,
        (dataset_id, *scope_params, dataset_id, *scope_params),
    )
    all_items: list[dict[str, Any]] = []
    risk_counts: dict[str, int] = {}
    for row in rows:
        closing_stock = int(row["closing_stock"] or 0)
        average_daily_sold = _number(row["average_daily_sold"])
        days_cover = closing_stock / max(average_daily_sold, 0.01)
        label = inventory_health_label(closing_stock, average_daily_sold, days_cover)
        risk_counts[label] = risk_counts.get(label, 0) + 1
        all_items.append(
            {
                "item_id": row["item_id"],
                "snapshot_date": row["snapshot_date"].isoformat(),
                "closing_stock": closing_stock,
                "reserved_qty": int(row["reserved_qty"] or 0),
                "sold_units": int(row["sold_units"] or 0),
                "average_daily_sold": round(average_daily_sold, 4),
                "days_cover": round(days_cover, 2),
                "health_label": label,
            }
        )
    page_count = max((len(all_items) + limit - 1) // limit, 1)
    page = min(max(page, 1), page_count)
    start = (page - 1) * limit
    items = all_items[start : start + limit]
    return _response(
        dataset_id,
        contract,
        scope=scope,
        metric_definition={
            "days_cover": "结存库存 ÷ 平均日销量；无销量商品用 0.01 防止除零",
            "health_label": "库存正常、库存积压、缺货风险或有库存但无销量",
        },
        item_count=len(rows),
        page=page,
        page_size=limit,
        page_count=page_count,
        risk_counts=risk_counts,
        items=items,
    )


async def lifecycle_metrics(
    dataset_id: str,
    limit: int = 20,
    page: int = 1,
    stage: str | None = None,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    """按订单首次/最近活跃时间给出商品经营阶段，不冒充真实上下架生命周期。"""

    contract = await _contract(dataset_id)
    window_start = date.fromisoformat(str(contract["window_start"]))
    window_end = date.fromisoformat(str(contract["window_end"]))
    scope_clause, scope_params, scope = _order_scope(
        dimension,
        value,
        supported=ITEM_SCOPE_DIMENSIONS,
        item_alias="i",
    )
    if stage is not None and stage not in LIFECYCLE_STAGES:
        raise ValueError(f"商品阶段必须是：{'、'.join(LIFECYCLE_STAGES)}")
    rows = await fetch_all(
        """
        SELECT i.item_id, i.category_id,
               MIN(o.ordered_at)::date AS first_order_date,
               MAX(o.ordered_at)::date AS last_order_date,
               COUNT(DISTINCT o.order_id) AS orders,
               SUM(o.quantity) AS units,
               SUM(o.quantity * o.selling_price - o.refund_amount) AS net_sales
        FROM commerce.dataset_item_economics i
        LEFT JOIN commerce.dataset_orders o
          ON o.dataset_id = i.dataset_id AND o.item_id = i.item_id
        WHERE i.dataset_id = %s
        """
        + scope_clause
        + """
        GROUP BY i.item_id, i.category_id
        ORDER BY net_sales DESC NULLS LAST, i.item_id
        """,
        (dataset_id, *scope_params),
    )
    stage_counts: dict[str, int] = {label: 0 for label in LIFECYCLE_STAGES}
    classified_items: list[dict[str, Any]] = []
    for row in rows:
        row_stage, active_days, days_since_last = classify_lifecycle_stage(
            window_start,
            window_end,
            row["first_order_date"],
            row["last_order_date"],
        )
        stage_counts[row_stage] += 1
        classified_items.append(
            {
                "item_id": row["item_id"],
                "category_id": row["category_id"],
                "stage": row_stage,
                "first_order_date": _iso(row["first_order_date"]),
                "last_order_date": _iso(row["last_order_date"]),
                "active_days": active_days,
                "days_since_last_order": days_since_last,
                "orders": int(row["orders"] or 0),
                "units": int(row["units"] or 0),
                "net_sales": round(_number(row["net_sales"]), 2),
            }
        )
    filtered_items = [
        item for item in classified_items if stage is None or item["stage"] == stage
    ]
    page_count = max((len(filtered_items) + limit - 1) // limit, 1)
    page = min(page, page_count)
    start = (page - 1) * limit
    items = filtered_items[start : start + limit]
    return _response(
        dataset_id,
        contract,
        scope=scope,
        metric_definition={
            "stage": "根据窗口内首次购买、最近购买和活跃天数推断的经营阶段",
            "boundary": "没有真实上架、下架和生命周期事件，因此不是商品真实生命周期",
        },
        stage_counts=stage_counts,
        item_count=len(rows),
        filtered_item_count=len(filtered_items),
        selected_stage=stage,
        page=page,
        page_size=limit,
        page_count=page_count,
        items=items,
    )


async def price_band_comparison(
    dataset_id: str,
    limit: int = 20,
    page: int = 1,
    dimension: str | None = None,
    value: str | None = None,
) -> dict[str, Any]:
    """提供价格带对比，并在有多价格观察时计算可解释的需求弹性。"""

    contract = await _contract(dataset_id)
    scope_clause, scope_params, scope = _order_scope(
        dimension,
        value,
        supported=ITEM_SCOPE_DIMENSIONS,
        item_alias="i",
    )
    rows = await fetch_all(
        """
        WITH item_sales AS (
          SELECT i.item_id, i.list_price, i.discount_rate,
                 COUNT(DISTINCT o.order_id) AS orders,
                 COALESCE(SUM(o.quantity), 0) AS units,
                 COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount), 0) AS net_sales
          FROM commerce.dataset_item_economics i
          LEFT JOIN commerce.dataset_orders o
            ON o.dataset_id = i.dataset_id AND o.item_id = i.item_id
          WHERE i.dataset_id = %s
          """
        + scope_clause
        + """
          GROUP BY i.item_id, i.list_price, i.discount_rate
        )
        SELECT CASE
                 WHEN list_price < 50 THEN '0-50'
                 WHEN list_price < 200 THEN '50-200'
                 WHEN list_price < 500 THEN '200-500'
                 WHEN list_price < 1000 THEN '500-1000'
                 ELSE '1000+'
               END AS price_band,
               COUNT(*) AS item_count,
               SUM(orders) AS orders,
               SUM(units) AS units,
               SUM(net_sales) AS net_sales,
               AVG(discount_rate) AS average_discount_rate
        FROM item_sales
        GROUP BY 1
        ORDER BY MIN(list_price)
        """,
        (dataset_id, *scope_params),
    )
    bands = [
        {
            **row,
            "item_count": int(row["item_count"] or 0),
            "orders": int(row["orders"] or 0),
            "units": int(row["units"] or 0),
            "net_sales": round(_number(row["net_sales"]), 2),
            "average_discount_rate": round(_number(row["average_discount_rate"]), 4),
        }
        for row in rows
    ]
    elasticity_rows = await fetch_all(
        """
        WITH price_points AS (
          SELECT o.item_id, o.selling_price,
                 SUM(quantity)::double precision AS units,
                 COUNT(DISTINCT order_id) AS orders
          FROM commerce.dataset_orders o
          JOIN commerce.dataset_item_economics i
            ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
          WHERE o.dataset_id = %s
            AND o.selling_price > 0
            AND o.quantity > 0
            AND o.payment_status = 'paid'
          """
        + scope_clause
        + """
          GROUP BY o.item_id, o.selling_price
        ), eligible AS (
          SELECT item_id,
                 COUNT(*) AS price_points,
                 MIN(selling_price) AS min_price,
                 MAX(selling_price) AS max_price,
                 SUM(units) AS units,
                 SUM(orders) AS orders,
                 REGR_SLOPE(
                   LN(NULLIF(units, 0)),
                   LN(NULLIF(selling_price, 0))
                 ) AS elasticity
          FROM price_points
          GROUP BY item_id
          HAVING COUNT(*) >= 2
        )
        SELECT e.item_id, i.category_id, e.price_points, e.min_price,
               e.max_price, e.units, e.orders, e.elasticity
        FROM eligible e
        JOIN commerce.dataset_item_economics i
          ON i.dataset_id = %s AND i.item_id = e.item_id
        WHERE e.elasticity IS NOT NULL
        ORDER BY e.elasticity ASC, e.item_id
        """,
        (dataset_id, *scope_params, dataset_id),
    )
    all_item_elasticities = [
        {
            "item_id": row["item_id"],
            "category_id": row["category_id"],
            "price_points": int(row["price_points"] or 0),
            "min_price": round(_number(row["min_price"]), 2),
            "max_price": round(_number(row["max_price"]), 2),
            "units": int(row["units"] or 0),
            "orders": int(row["orders"] or 0),
            "elasticity": round(_number(row["elasticity"]), 4),
        }
        for row in elasticity_rows
    ]
    average_elasticity = (
        sum(row["elasticity"] for row in all_item_elasticities) / len(all_item_elasticities)
        if all_item_elasticities else None
    )
    if all_item_elasticities:
        status = "estimated"
        explanation = (
            "基于同一商品至少两个实际成交价格点与对应购买量，用对数回归估算需求弹性；"
            "这是演示数据分析，不是因果实验结论。"
        )
        required_for_estimation: list[str] = []
    else:
        status = "insufficient_data_for_elasticity"
        explanation = (
            "当前数据缺少同一商品至少两个有效成交价格点，无法计算价格弹性；"
            "仅展示价格带对比。"
        )
        required_for_estimation = [
            "同一商品多个价格时点",
            "对应销量或转化变化",
            "活动/流量等干扰因素",
        ]
    page_count = max((len(all_item_elasticities) + limit - 1) // limit, 1)
    page = min(max(page, 1), page_count)
    start = (page - 1) * limit
    item_elasticities = all_item_elasticities[start : start + limit]
    return _response(
        dataset_id,
        contract,
        scope=scope,
        status=status,
        elasticity_estimate=(
            round(average_elasticity, 4) if average_elasticity is not None else None
        ),
        estimation_method="log_demand_on_log_price" if all_item_elasticities else None,
        item_elasticities=item_elasticities,
        eligible_item_count=len(all_item_elasticities),
        page=page,
        page_size=limit,
        page_count=page_count,
        explanation=explanation,
        required_for_estimation=required_for_estimation,
        price_band_comparison=bands,
    )


async def analytics_drilldown(
    dataset_id: str,
    dimension: str,
    value: str,
    limit: int = 20,
) -> dict[str, Any]:
    """为多轮 Agent/页面下钻提供稳定的维度上下文和下一步提示。"""

    contract = await _contract(dataset_id)
    if dimension not in {"channel", "campaign", "category", "item", "user"}:
        raise ValueError("下钻维度必须是 channel、campaign、category、item 或 user")
    if not value.strip():
        raise ValueError("下钻值不能为空")

    if dimension == "category":
        try:
            category_id = int(value)
        except ValueError as error:
            raise ValueError("类目下钻值必须是数字 category_id") from error
        rows = await fetch_all(
            """
            WITH sales AS (
              SELECT COUNT(DISTINCT o.order_id) AS orders,
                     COUNT(DISTINCT o.user_id) AS users,
                     COALESCE(SUM(o.quantity), 0) AS units,
                     COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount), 0) AS net_sales
              FROM commerce.dataset_orders o
              JOIN commerce.dataset_item_economics i
                ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
              WHERE o.dataset_id = %s AND i.category_id = %s
            ), behavior AS (
              SELECT
                COUNT(*) FILTER (WHERE behavior_type = 'pv') AS pv,
                COUNT(*) FILTER (WHERE behavior_type = 'fav') AS fav,
                COUNT(*) FILTER (WHERE behavior_type = 'cart') AS cart,
                COUNT(*) FILTER (WHERE behavior_type = 'buy') AS buy
              FROM commerce.dataset_behavior_events
              WHERE dataset_id = %s AND category_id = %s
            )
            SELECT %s AS category_id, s.*, b.pv, b.fav, b.cart, b.buy
            FROM sales s CROSS JOIN behavior b
            """,
            (dataset_id, category_id, dataset_id, category_id, category_id),
        )
        results = [
            {
                **row,
                "orders": int(row["orders"] or 0),
                "users": int(row["users"] or 0),
                "units": int(row["units"] or 0),
                "net_sales": round(_number(row["net_sales"]), 2),
                "pv": int(row["pv"] or 0),
                "fav": int(row["fav"] or 0),
                "cart": int(row["cart"] or 0),
                "buy": int(row["buy"] or 0),
                "buy_conversion": round(
                    int(row["buy"] or 0) / int(row["pv"] or 0), 6
                    if int(row["pv"] or 0) > 0 else 0.0
                ),
            }
            for row in rows
        ]
        next_questions = [
            "查看该类目下浏览量最高的商品",
            "比较该类目的购买转化率",
            "查看该类目的库存风险",
        ]
        action_suggestions = [
            "先查看该类目中浏览量高但购买较少的商品",
            "再结合库存和价格带判断是商品页、价格还是库存问题",
        ]
    elif dimension in {"channel", "campaign"}:
        column = "channel_id" if dimension == "channel" else "campaign_id"
        rows = await fetch_all(
            f"""
            SELECT o.{column} AS dimension_value,
                   COUNT(DISTINCT o.order_id) AS orders,
                   COUNT(DISTINCT o.user_id) AS users,
                   COALESCE(SUM(o.quantity), 0) AS units,
                   COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount), 0) AS net_sales
            FROM commerce.dataset_orders o
            WHERE o.dataset_id = %s AND o.{column} = %s
            GROUP BY o.{column}
            """,
            (dataset_id, value),
        )
        results = [
            {
                **row,
                "orders": int(row["orders"] or 0),
                "users": int(row["users"] or 0),
                "units": int(row["units"] or 0),
                "net_sales": round(_number(row["net_sales"]), 2),
            }
            for row in rows
        ]
        next_questions = [
            "继续按商品查看销量和库存",
            "查看该维度的毛利贡献",
            "对比其他渠道或活动",
        ]
        action_suggestions = [
            "先查看该渠道或活动带来的商品和购买表现",
            "结合订单转化率与估算销售额判断是否需要继续观察",
        ]
    elif dimension == "item":
        try:
            item_id = int(value)
        except ValueError as error:
            raise ValueError("商品下钻值必须是数字 item_id") from error
        rows = await fetch_all(
            """
            WITH sales AS (
              SELECT COUNT(DISTINCT order_id) AS orders,
                     COUNT(DISTINCT user_id) AS users,
                     COALESCE(SUM(quantity), 0) AS units,
                     COALESCE(SUM(quantity * selling_price - refund_amount), 0) AS net_sales,
                     MIN(ordered_at)::date AS first_order_date,
                     MAX(ordered_at)::date AS last_order_date
              FROM commerce.dataset_orders
              WHERE dataset_id = %s AND item_id = %s
            ), inventory AS (
              SELECT closing_stock, sold_qty, snapshot_date
              FROM commerce.dataset_inventory_snapshots
              WHERE dataset_id = %s AND item_id = %s
              ORDER BY snapshot_date DESC
              LIMIT 1
            ), behavior AS (
              SELECT
                COUNT(*) FILTER (WHERE behavior_type = 'pv') AS pv,
                COUNT(*) FILTER (WHERE behavior_type = 'fav') AS fav,
                COUNT(*) FILTER (WHERE behavior_type = 'cart') AS cart,
                COUNT(*) FILTER (WHERE behavior_type = 'buy') AS buy
              FROM commerce.dataset_behavior_events
              WHERE dataset_id = %s AND item_id = %s
            )
            SELECT %s AS item_id, s.*, i.closing_stock, i.sold_qty, i.snapshot_date,
                   b.pv, b.fav, b.cart, b.buy
            FROM sales s LEFT JOIN inventory i ON true CROSS JOIN behavior b
            """,
            (dataset_id, item_id, dataset_id, item_id, dataset_id, item_id, item_id),
        )
        results = [
            {
                **row,
                "orders": int(row["orders"] or 0),
                "users": int(row["users"] or 0),
                "units": int(row["units"] or 0),
                "net_sales": round(_number(row["net_sales"]), 2),
                "closing_stock": int(row["closing_stock"] or 0),
                "sold_qty": int(row["sold_qty"] or 0),
                "first_order_date": _iso(row["first_order_date"]),
                "last_order_date": _iso(row["last_order_date"]),
                "snapshot_date": _iso(row["snapshot_date"]),
                "pv": int(row["pv"] or 0),
                "fav": int(row["fav"] or 0),
                "cart": int(row["cart"] or 0),
                "buy": int(row["buy"] or 0),
                "buy_conversion": round(
                    int(row["buy"] or 0) / int(row["pv"] or 0), 6
                    if int(row["pv"] or 0) > 0 else 0.0
                ),
            }
            for row in rows
        ]
        next_questions = [
            "查看该商品所属渠道和活动",
            "比较该商品所在价格带",
            "查看同类目商品表现",
            "查看该商品的浏览到购买转化",
        ]
        action_suggestions = [
            "优先检查商品页、价格和活动信息是否影响购买",
            "结合结存库存、窗口销量和购买转化判断库存问题",
        ]
    else:
        try:
            user_id = int(value)
        except ValueError as error:
            raise ValueError("用户下钻值必须是数字 user_id") from error
        rows = await fetch_all(
            """
            SELECT o.user_id, p.age_band, p.city_tier, p.member_level,
                   COUNT(DISTINCT o.order_id) AS orders,
                   COALESCE(SUM(o.quantity), 0) AS units,
                   COALESCE(SUM(o.quantity * o.selling_price - o.refund_amount), 0) AS net_sales,
                   MIN(o.ordered_at)::date AS first_order_date,
                   MAX(o.ordered_at)::date AS last_order_date
            FROM commerce.dataset_orders o
            LEFT JOIN commerce.dataset_user_profiles p
              ON p.dataset_id = o.dataset_id AND p.user_id = o.user_id
            WHERE o.dataset_id = %s AND o.user_id = %s
            GROUP BY o.user_id, p.age_band, p.city_tier, p.member_level
            """,
            (dataset_id, user_id),
        )
        results = [
            {
                **row,
                "orders": int(row["orders"] or 0),
                "units": int(row["units"] or 0),
                "net_sales": round(_number(row["net_sales"]), 2),
                "first_order_date": _iso(row["first_order_date"]),
                "last_order_date": _iso(row["last_order_date"]),
            }
            for row in rows
        ]
        next_questions = [
            "查看该用户最近购买的商品",
            "查看该用户来自哪个渠道",
            "查看该用户的 RFM 分群",
        ]
        action_suggestions = [
            "结合最近购买时间和购买次数判断是否需要触达",
            "查看最近购买的商品，决定后续推荐或服务内容",
        ]
    return _response(
        dataset_id,
        contract,
        context={"dimension": dimension, "value": value},
        context_url=(
            "/analytics-workbench?view=drilldown&dataset_id="
            f"{quote(dataset_id)}&dimension={quote(dimension)}&value={quote(value)}"
        ),
        results=results[:limit],
        next_questions=next_questions,
        action_suggestions=action_suggestions,
    )
