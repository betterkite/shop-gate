"""P28 电商经营分析能力（基于 dataset_* 扩展数据集）。

所有函数先读取数据集契约，再返回结果和限制说明。扩展数据可以支撑演示分析，
但不能把合成订单、成本、渠道归因或库存快照描述成真实业务事实。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from shopgate_commerce_data.retail import fetch_all

ANALYTICS_LIMITATIONS = [
    "用户画像、渠道/活动归因、成本、退款、履约和库存快照均为合成字段",
    "订单由合成 buy 事件派生，不能用于真实收入确认或财务结算",
    "渠道和活动指标是确定性模拟，不代表广告平台回传或实验结果",
    "库存可售天数是演示计算，不能单独替代真实补货决策",
]


def _number(value: Any) -> float:
    return float(value or 0)


def _iso(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


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


async def analytics_overview(dataset_id: str) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        SELECT COUNT(DISTINCT order_id) AS orders,
               COUNT(DISTINCT user_id) AS buyers,
               COUNT(DISTINCT item_id) AS sold_items,
               COALESCE(SUM(quantity), 0) AS units,
               COALESCE(SUM(quantity * selling_price), 0) AS gross_sales,
               COALESCE(SUM(refund_amount), 0) AS refunds,
               COALESCE(SUM(quantity * selling_price - refund_amount), 0) AS net_sales
        FROM commerce.dataset_orders
        WHERE dataset_id = %s
        """,
        (dataset_id,),
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
        metrics=metrics,
        quality=quality[0] if quality else {"severity": "unknown", "issue_count": None},
    )


async def rfm_segments(dataset_id: str, limit: int = 20) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    window_end = date.fromisoformat(str(contract["window_end"]))
    rows = await fetch_all(
        """
        SELECT o.user_id,
               MAX(o.ordered_at)::date AS last_order_date,
               COUNT(DISTINCT o.order_id) AS frequency,
               SUM(o.quantity) AS units,
               SUM(o.quantity * o.selling_price - o.refund_amount) AS monetary,
               p.age_band, p.city_tier, p.member_level
        FROM commerce.dataset_orders o
        LEFT JOIN commerce.dataset_user_profiles p
          ON p.dataset_id = o.dataset_id AND p.user_id = o.user_id
        WHERE o.dataset_id = %s
        GROUP BY o.user_id, p.age_band, p.city_tier, p.member_level
        ORDER BY monetary DESC, frequency DESC, o.user_id
        """,
        (dataset_id,),
    )
    monetary_values = sorted(_number(row["monetary"]) for row in rows)
    p75 = monetary_values[int((len(monetary_values) - 1) * 0.75)] if monetary_values else 0
    customers: list[dict[str, Any]] = []
    segment_counts: dict[str, int] = {}
    for row in rows:
        recency = (window_end - row["last_order_date"]).days
        monetary = _number(row["monetary"])
        segment = classify_rfm(recency, int(row["frequency"]), monetary, p75)
        segment_counts[segment] = segment_counts.get(segment, 0) + 1
        if len(customers) < limit:
            customers.append(
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
    return _response(
        dataset_id,
        contract,
        metric_definition={
            "recency_days": "距最近一次购买的天数",
            "frequency": "窗口内订单数",
            "monetary": "订单净金额（合成成交价减合成退款）",
        },
        monetary_p75=round(p75, 2),
        customer_count=len(rows),
        segment_counts=segment_counts,
        customers=customers,
    )


async def channel_campaign_metrics(dataset_id: str) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        SELECT s.channel_id, ch.name AS channel_name, ch.channel_type,
               s.campaign_id, ca.name AS campaign_name, ca.campaign_type,
               COUNT(DISTINCT s.session_id) AS sessions,
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
        WHERE s.dataset_id = %s
        GROUP BY s.channel_id, ch.name, ch.channel_type, s.campaign_id,
                 ca.name, ca.campaign_type
        ORDER BY net_sales DESC, sessions DESC
        """,
        (dataset_id,),
    )
    metrics = []
    for row in rows:
        sessions = int(row["sessions"] or 0)
        orders = int(row["orders"] or 0)
        metrics.append(
            {
                **row,
                "sessions": sessions,
                "users": int(row["users"] or 0),
                "orders": orders,
                "net_sales": round(_number(row["net_sales"]), 2),
                "order_conversion": round(orders / sessions, 6) if sessions else 0.0,
            }
        )
    return _response(
        dataset_id,
        contract,
        metric_definition={
            "order_conversion": "订单数 ÷ 会话数，不是广告平台归因转化率",
            "net_sales": "合成成交价减合成退款",
        },
        metrics=metrics,
    )


async def profit_metrics(dataset_id: str) -> dict[str, Any]:
    contract = await _contract(dataset_id)
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
        GROUP BY o.channel_id, ch.name
        ORDER BY gross_profit DESC
        """,
        (dataset_id,),
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


async def inventory_analytics(dataset_id: str, limit: int = 20) -> dict[str, Any]:
    contract = await _contract(dataset_id)
    rows = await fetch_all(
        """
        WITH latest AS (
          SELECT DISTINCT ON (item_id) item_id, snapshot_date, closing_stock, reserved_qty
          FROM commerce.dataset_inventory_snapshots
          WHERE dataset_id = %s
          ORDER BY item_id, snapshot_date DESC
        ), velocity AS (
          SELECT item_id, AVG(sold_qty) AS average_daily_sold,
                 SUM(sold_qty) AS sold_units
          FROM commerce.dataset_inventory_snapshots
          WHERE dataset_id = %s
          GROUP BY item_id
        )
        SELECT l.item_id, l.snapshot_date, l.closing_stock, l.reserved_qty,
               v.average_daily_sold, v.sold_units
        FROM latest l
        JOIN velocity v ON v.item_id = l.item_id
        ORDER BY l.closing_stock DESC
        """,
        (dataset_id, dataset_id),
    )
    items: list[dict[str, Any]] = []
    risk_counts: dict[str, int] = {}
    for row in rows:
        closing_stock = int(row["closing_stock"] or 0)
        average_daily_sold = _number(row["average_daily_sold"])
        days_cover = closing_stock / max(average_daily_sold, 0.01)
        label = inventory_health_label(closing_stock, average_daily_sold, days_cover)
        risk_counts[label] = risk_counts.get(label, 0) + 1
        if len(items) < limit:
            items.append(
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
    return _response(
        dataset_id,
        contract,
        metric_definition={
            "days_cover": "结存库存 ÷ 平均日销量；无销量商品用 0.01 防止除零",
            "health_label": "库存正常、库存积压、缺货风险或有库存但无销量",
        },
        item_count=len(rows),
        risk_counts=risk_counts,
        items=items,
    )
