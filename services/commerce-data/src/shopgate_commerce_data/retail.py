"""零售领域查询层（PRD §3 四个 capability 的数据底座）。

纯函数（漏斗计算、库销比等）与异步 SQL 查询分离：纯函数可无 DB 单测，
SQL 查询统一走 :func:`shopgate_commerce_data.database_core.connect`。
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from psycopg.rows import dict_row

from shopgate_commerce_data.database_core import connect

BEHAVIOR_ORDER = ("pv", "fav", "cart", "buy")


def parse_iso_date(value: str | None, fallback: date | None = None) -> date | None:
    if value is None or value == "":
        return fallback
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"日期格式必须是 YYYY-MM-DD：{value!r}") from error


def funnel_stages(
    counts: dict[str, int],
    unique_users: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    """把 pv/fav/cart/buy 事件计数组装成漏斗阶段（纯函数）。

    每一阶段给出事件数、去重口径之外的相对上一阶段转化率；缺失阶段按 0 处理。
    """

    stages: list[dict[str, Any]] = []
    user_counts = unique_users or {}
    pv_users = max(0, int(user_counts.get("pv", 0)))
    previous = 0
    for index, behavior_type in enumerate(BEHAVIOR_ORDER):
        events = max(0, int(counts.get(behavior_type, 0)))
        stage: dict[str, Any] = {
            "stage": behavior_type,
            "order": index,
            "events": events,
            "unique_users": max(0, int(user_counts.get(behavior_type, 0))),
        }
        if index == 0:
            stage["conversion_from_previous"] = None
        else:
            stage["conversion_from_previous"] = (
                round(events / previous, 6) if previous > 0 else 0.0
            )
        stage["user_reach_from_pv"] = (
            round(stage["unique_users"] / pv_users, 6) if pv_users > 0 else 0.0
        )
        stages.append(stage)
        previous = events
    return stages


def sell_through_ratio(stock: int, sold: int, days: int) -> float:
    """库销比（PRD §6.2）：库存 / 日均销量；越大越滞销。

    ``days`` 是观察窗口天数；销量为 0 时用 0.01 的地板值避免除零，
    使零销量商品的库销比反映为“极高”而非无穷。
    """

    daily_rate = max(sold / max(days, 1), 0.01)
    return round(max(stock, 0) / daily_rate, 2)


def buy_conversion_rate(sold: int, views: int) -> float:
    """购买转化率（Buy / PV）；无页面浏览量时返回 0。"""

    return round(max(sold, 0) / views, 6) if views > 0 else 0.0


async def fetch_all(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    connection = await connect()
    async with connection:
        cursor = connection.cursor(row_factory=dict_row)
        await cursor.execute(sql, params)
        rows = await cursor.fetchall()
    return [dict(row) for row in rows]


async def resolve_entities(term: str, limit: int = 10) -> dict[str, Any]:
    """实体解析（PRD §7）：前缀显式形式 + 类目名/商品标题模糊匹配。

    零售实体 ID 是任意大整数，不能像股票代码那样用位形正则识别；
    显式形式固定为 ``item:<id>`` / ``cat:<id>``，其余走名称匹配。
    """

    trimmed = term.strip()
    if not trimmed:
        return {"term": term, "matches": [], "synthetic_fields": ["category_name"]}
    matches: list[dict[str, Any]] = []
    lowered = trimmed.lower()
    if lowered.startswith("item:"):
        raw = lowered.split(":", 1)[1]
        if raw.isdigit():
            rows = await fetch_all(
                "SELECT item_id, title FROM commerce.items WHERE item_id = %s",
                (int(raw),),
            )
            matches.extend(
                {
                    "kind": "item",
                    "id": row["item_id"],
                    "name": row["title"],
                    "confidence": 1.0,
                }
                for row in rows
            )
    elif lowered.startswith("cat:"):
        raw = lowered.split(":", 1)[1]
        if raw.isdigit():
            rows = await fetch_all(
                "SELECT category_id, name FROM commerce.categories WHERE category_id = %s",
                (int(raw),),
            )
            matches.extend(
                {
                    "kind": "category",
                    "id": row["category_id"],
                    "name": row["name"],
                    "confidence": 1.0,
                }
                for row in rows
            )
    else:
        category_rows = await fetch_all(
            """
            SELECT category_id, name,
                   (name = %s) AS exact
            FROM commerce.categories
            WHERE name ILIKE %s
            ORDER BY exact DESC, category_id
            LIMIT %s
            """,
            (trimmed, f"%{trimmed}%", limit),
        )
        matches.extend(
            {
                "kind": "category",
                "id": row["category_id"],
                "name": row["name"],
                "confidence": 0.95 if row["exact"] else 0.8,
            }
            for row in category_rows
        )
        item_rows = await fetch_all(
            """
            SELECT item_id, title, price, synthetic_master
            FROM commerce.items
            WHERE title ILIKE %s OR item_id::text = %s
            ORDER BY item_id
            LIMIT %s
            """,
            (f"%{trimmed}%", trimmed if trimmed.isdigit() else "", limit),
        )
        matches.extend(
            {
                "kind": "item",
                "id": row["item_id"],
                "name": row["title"],
                "price": float(row["price"]),
                "synthetic_master": row["synthetic_master"],
                "confidence": 0.6,
            }
            for row in item_rows
        )
    matches.sort(key=lambda row: row["confidence"], reverse=True)
    return {
        "term": term,
        "matches": matches[:limit],
        "synthetic_fields": ["category_name", "item_title", "price"],
    }


async def dataset_meta() -> dict[str, Any]:
    rows = await fetch_all(
        """
        SELECT
          MIN(event_ts) AS first_event_ts,
          MAX(event_ts) AS last_event_ts,
          COUNT(*) AS event_count,
          COUNT(DISTINCT user_id) AS user_count,
          COUNT(DISTINCT item_id) AS item_count,
          COUNT(DISTINCT category_id) AS category_count,
          COUNT(DISTINCT source) AS source_count,
          MIN(source) AS behavior_source
        FROM commerce.user_behavior_events
        """,
    )
    item_rows = await fetch_all("SELECT COUNT(*) AS item_count FROM commerce.items")
    meta = dict(rows[0]) if rows else {}
    meta["master_item_count"] = item_rows[0]["item_count"] if item_rows else 0
    return meta


async def behavior_funnel(
    start: date,
    end: date,
    category_id: int | None = None,
) -> dict[str, Any]:
    end_exclusive = end + timedelta(days=1)
    if category_id is None:
        rows = await fetch_all(
            """
            SELECT behavior_type, COUNT(*) AS events, COUNT(DISTINCT user_id) AS users
            FROM commerce.user_behavior_events
            WHERE event_ts >= %s AND event_ts < %s
            GROUP BY behavior_type
            """,
            (start, end_exclusive),
        )
    else:
        rows = await fetch_all(
            """
            SELECT behavior_type, COUNT(*) AS events, COUNT(DISTINCT user_id) AS users
            FROM commerce.user_behavior_events
            WHERE event_ts >= %s AND event_ts < %s AND category_id = %s
            GROUP BY behavior_type
            """,
            (start, end_exclusive, category_id),
        )
    counts = {row["behavior_type"]: row["events"] for row in rows}
    users_by_type = {row["behavior_type"]: row["users"] for row in rows}
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "category_id": category_id,
        "stages": funnel_stages(counts, users_by_type),
        "unique_users": users_by_type,
    }


async def funnel_daily_series(
    start: date,
    end: date,
    category_id: int | None = None,
) -> list[dict[str, Any]]:
    end_exclusive = end + timedelta(days=1)
    if category_id is None:
        rows = await fetch_all(
            """
            SELECT event_ts::date AS stat_date, behavior_type,
                   COUNT(*) AS events, COUNT(DISTINCT user_id) AS users
            FROM commerce.user_behavior_events
            WHERE event_ts >= %s AND event_ts < %s
            GROUP BY 1, 2
            ORDER BY 1
            """,
            (start, end_exclusive),
        )
    else:
        rows = await fetch_all(
            """
            SELECT event_ts::date AS stat_date, behavior_type,
                   COUNT(*) AS events, COUNT(DISTINCT user_id) AS users
            FROM commerce.user_behavior_events
            WHERE event_ts >= %s AND event_ts < %s AND category_id = %s
            GROUP BY 1, 2
            ORDER BY 1
            """,
            (start, end_exclusive, category_id),
        )
    series: dict[str, dict[str, int]] = {}
    for row in rows:
        day = series.setdefault(
            row["stat_date"].isoformat(),
            {
                **{behavior_type: 0 for behavior_type in BEHAVIOR_ORDER},
                **{f"{behavior_type}_users": 0 for behavior_type in BEHAVIOR_ORDER},
            },
        )
        day[row["behavior_type"]] = row["events"]
        day[f'{row["behavior_type"]}_users'] = row["users"]
    return [
        {"stat_date": stat_date, **counts_by_type}
        for stat_date, counts_by_type in sorted(series.items())
    ]


async def top_categories(
    start: date,
    end: date,
    metric: str = "gmv",
    limit: int = 10,
) -> list[dict[str, Any]]:
    if metric not in {"gmv", "pv", "buy", "cart", "fav"}:
        raise ValueError(f"不支持的类目指标：{metric}")
    rows = await fetch_all(
        f"""
        WITH window_metrics AS (
          SELECT
            category_id,
            SUM(pv) AS pv,
            SUM(fav) AS fav,
            SUM(cart) AS cart,
            SUM(buy) AS buy,
            SUM(gmv) AS gmv,
            SUM(buyers) AS buyers
          FROM commerce.daily_category_metrics
          WHERE stat_date >= %s AND stat_date <= %s
          GROUP BY category_id
        ), previous_metrics AS (
          SELECT
            category_id,
            SUM(pv) AS pv,
            SUM(buy) AS buy,
            SUM(gmv) AS gmv
          FROM commerce.daily_category_metrics
          WHERE stat_date = %s
          GROUP BY category_id
        )
        SELECT
          m.category_id,
          c.name AS category_name,
          c.synthetic_name,
          m.pv,
          m.fav,
          m.cart,
          m.buy,
          m.gmv,
          m.buyers,
          COALESCE(p.pv, 0) AS previous_pv,
          COALESCE(p.buy, 0) AS previous_buy,
          COALESCE(p.gmv, 0) AS previous_gmv
        FROM window_metrics m
        LEFT JOIN commerce.categories c ON c.category_id = m.category_id
        LEFT JOIN previous_metrics p ON p.category_id = m.category_id
        ORDER BY m.{metric} DESC
        LIMIT %s
        """,
        (start, end, end - timedelta(days=1), limit),
    )
    for row in rows:
        for key in ("pv", "fav", "cart", "buy", "buyers"):
            row[key] = int(row[key] or 0)
        row["gmv"] = float(row.get("gmv") or 0)
        previous_pv = int(row.pop("previous_pv") or 0)
        previous_buy = int(row.pop("previous_buy") or 0)
        previous_gmv = float(row.pop("previous_gmv") or 0)
        row["buy_conversion"] = (
            round(row["buy"] / row["pv"], 6) if row.get("pv") else 0.0
        )
        row["avg_price"] = (
            round(row["gmv"] / row["buy"], 2) if row.get("buy") else 0.0
        )
        row["gmv_day_over_day"] = (
            round((row["gmv"] - previous_gmv) / previous_gmv, 6)
            if previous_gmv
            else None
        )
        row["pv_day_over_day"] = (
            round((row["pv"] - previous_pv) / previous_pv, 6)
            if previous_pv
            else None
        )
        row["buy_day_over_day"] = (
            round((row["buy"] - previous_buy) / previous_buy, 6)
            if previous_buy
            else None
        )
        previous_conversion = previous_buy / previous_pv if previous_pv else 0.0
        row["buy_conversion_day_over_day"] = (
            round(row["buy_conversion"] - previous_conversion, 6)
            if previous_pv
            else None
        )
    return rows


async def item_daily_series(
    item_id: int,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    return await fetch_all(
        """
        SELECT stat_date, item_id, category_id, pv, fav, cart, buy, gmv
        FROM commerce.daily_item_metrics
        WHERE item_id = %s AND stat_date >= %s AND stat_date <= %s
        ORDER BY stat_date
        """,
        (item_id, start, end),
    )


async def product_pool(
    start: date,
    end: date,
    *,
    page: int = 1,
    page_size: int = 20,
    category_id: int | None = None,
    sort: str = "gmv",
) -> dict[str, Any]:
    """商品池：按页返回商品级窗口指标（真实事件 + 合成主数据）。

    sort 取 gmv / pv / buy / price。返回 total 供分页。
    """
    if sort not in {"gmv", "pv", "buy", "price"}:
        raise ValueError(f"不支持的排列指标：{sort}")
    if page < 1 or page_size < 1 or page_size > 100:
        raise ValueError("page 需 ≥1，page_size 需在 1..100")
    clauses = ["1 = 1"]
    params: list[Any] = []
    if category_id is not None:
        clauses.append("i.category_id = %s")
        params.append(category_id)
    filter_sql = " AND ".join(clauses)

    counted = await fetch_all(
        f"""
        SELECT COUNT(*) AS total
        FROM commerce.items i
        WHERE {filter_sql}
        """,
        tuple(params),
    )
    total = int(counted[0]["total"]) if counted else 0

    order_col = {
        "gmv": "COALESCE(m.gmv, 0) DESC",
        "pv": "COALESCE(m.pv, 0) DESC",
        "buy": "COALESCE(m.buy, 0) DESC",
        "price": "i.price DESC",
    }[sort]
    rows = await fetch_all(
        f"""
        SELECT
          i.item_id, i.title, i.category_id, c.name AS category_name,
          c.synthetic_name AS category_synthetic_name, i.price, i.stock,
          b.name AS brand_name, s.name AS shop_name, s.tier AS shop_tier,
          COALESCE(m.pv, 0) AS pv, COALESCE(m.buy, 0) AS buy, COALESCE(m.gmv, 0) AS gmv
        FROM commerce.items i
        LEFT JOIN commerce.categories c ON c.category_id = i.category_id
        LEFT JOIN commerce.brands b ON b.brand_id = i.brand_id
        LEFT JOIN commerce.shops s ON s.shop_id = i.shop_id
        LEFT JOIN (
          SELECT item_id, SUM(pv) AS pv, SUM(buy) AS buy, SUM(gmv) AS gmv
          FROM commerce.daily_item_metrics
          WHERE stat_date >= %s AND stat_date <= %s
          GROUP BY item_id
        ) m ON m.item_id = i.item_id
        WHERE {filter_sql}
        ORDER BY {order_col}
        LIMIT %s OFFSET %s
        """,
        tuple(params) + (start, end, page_size, (page - 1) * page_size),
    )
    for row in rows:
        row["price"] = float(row["price"] or 0)
        row["stock"] = int(row["stock"] or 0)
        row["pv"] = int(row["pv"] or 0)
        row["buy"] = int(row["buy"] or 0)
        row["gmv"] = float(row["gmv"] or 0)
        row["buy_conversion"] = round(row["buy"] / row["pv"], 6) if row["pv"] else 0.0
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "synthetic_fields": ["price", "stock", "brand_name", "shop_name", "shop_tier", "gmv"],
        "items": rows,
    }


async def channel_metrics(
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    """渠道分析：按店铺 tier 聚合（渠道 = 店铺 tier，合成口径）。

    事件为真实 UserBehavior；店铺/金额为合成主数据指标。
    """
    rows = await fetch_all(
        """
        SELECT
          s.tier AS channel,
          COUNT(DISTINCT s.shop_id) AS shop_count,
          COUNT(DISTINCT i.item_id) AS item_count,
          COALESCE(SUM(m.pv), 0) AS pv,
          COALESCE(SUM(m.buy), 0) AS buy,
          COALESCE(SUM(m.gmv), 0) AS gmv
        FROM commerce.shops s
        LEFT JOIN commerce.items i ON i.shop_id = s.shop_id
        LEFT JOIN (
          SELECT item_id, SUM(pv) AS pv, SUM(buy) AS buy, SUM(gmv) AS gmv
          FROM commerce.daily_item_metrics
          WHERE stat_date >= %s AND stat_date <= %s
          GROUP BY item_id
        ) m ON m.item_id = i.item_id
        GROUP BY s.tier
        ORDER BY COALESCE(SUM(m.gmv), 0) DESC
        """,
        (start, end),
    )
    total_gmv = sum(float(row.get("gmv") or 0) for row in rows)
    for row in rows:
        row["shop_count"] = int(row["shop_count"] or 0)
        row["item_count"] = int(row["item_count"] or 0)
        row["pv"] = int(row["pv"] or 0)
        row["buy"] = int(row["buy"] or 0)
        row["gmv"] = float(row["gmv"] or 0)
        row["gmv_share"] = round(row["gmv"] / total_gmv, 6) if total_gmv else 0.0
        row["buy_conversion"] = round(row["buy"] / row["pv"], 6) if row["pv"] else 0.0
    return rows


async def inventory_risk(
    start: date,
    end: date,
    limit: int = 20,
) -> list[dict[str, Any]]:
    days = (end - start).days + 1
    rows = await fetch_all(
        """
        SELECT
          i.item_id,
          i.title,
          i.category_id,
          i.price,
          i.stock,
          COALESCE(s.sold, 0) AS sold,
          COALESCE(s.views, 0) AS views
        FROM commerce.items i
        LEFT JOIN (
          SELECT item_id, SUM(buy) AS sold, SUM(pv) AS views
          FROM commerce.daily_item_metrics
          WHERE stat_date >= %s AND stat_date <= %s
          GROUP BY item_id
        ) s ON s.item_id = i.item_id
        ORDER BY i.item_id
        """,
        (start, end),
    )
    for row in rows:
        row["price"] = float(row["price"])
        row["sold"] = int(row["sold"] or 0)
        row["views"] = int(row["views"] or 0)
        row["window_days"] = days
        row["sell_through_ratio"] = sell_through_ratio(row["stock"], row["sold"], days)
        row["buy_conversion"] = buy_conversion_rate(row["sold"], row["views"])
    rows.sort(key=lambda row: row["sell_through_ratio"], reverse=True)
    return rows[:limit]


async def daily_summary(stat_date: date) -> dict[str, Any]:
    rows = await fetch_all(
        """
        SELECT
          stat_date,
          SUM(pv) AS pv,
          SUM(fav) AS fav,
          SUM(cart) AS cart,
          SUM(buy) AS buy,
          SUM(buyers) AS buyers,
          SUM(gmv) AS gmv
        FROM commerce.daily_category_metrics
        WHERE stat_date IN (%s, %s)
        GROUP BY stat_date
        ORDER BY stat_date
        """,
        (stat_date - timedelta(days=1), stat_date),
    )
    current = next((row for row in rows if row["stat_date"] == stat_date), None)
    previous = next(
        (row for row in rows if row["stat_date"] == stat_date - timedelta(days=1)),
        None,
    )

    def _float(value: Any) -> float:
        return float(value) if value is not None else 0.0

    unique_user_rows = await fetch_all(
        """
        SELECT event_ts::date AS stat_date, COUNT(DISTINCT user_id) AS uv
        FROM commerce.user_behavior_events
        WHERE event_ts >= %s AND event_ts < %s
        GROUP BY event_ts::date
        """,
        (stat_date - timedelta(days=1), stat_date + timedelta(days=1)),
    )
    unique_users_by_day = {
        row["stat_date"]: int(row["uv"] or 0) for row in unique_user_rows
    }
    if current is not None:
        current["uv"] = unique_users_by_day.get(stat_date, 0)
    if previous is not None:
        previous["uv"] = unique_users_by_day.get(stat_date - timedelta(days=1), 0)

    summary: dict[str, Any] = {"stat_date": stat_date.isoformat()}
    if current is None:
        summary["status"] = "no_data"
        return summary
    summary["status"] = "ok"
    summary["totals"] = {
        key: (_float(current[key]) if key == "gmv" else int(current[key] or 0))
        for key in ("pv", "uv", "fav", "cart", "buy", "buyers", "gmv")
    }
    if previous is not None and int(previous["pv"] or 0):
        summary["day_over_day"] = {
            key: (
                round((_float(current[key]) - _float(previous[key])) / _float(previous[key]), 4)
                if _float(previous[key])
                else None
            )
            for key in ("pv", "uv", "cart", "buy", "gmv")
        }
    else:
        summary["day_over_day"] = None
    if current["buy"]:
        summary["avg_price"] = round(_float(current["gmv"]) / int(current["buy"]), 2)
        summary["buy_conversion"] = round(int(current["buy"]) / int(current["pv"] or 0), 6)
    else:
        summary["avg_price"] = 0.0
        summary["buy_conversion"] = 0.0
    return summary
