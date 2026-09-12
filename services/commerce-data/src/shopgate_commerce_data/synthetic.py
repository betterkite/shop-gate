"""确定性合成数据生成器（PRD §5.2 / §R1 兜底）。

设计约束：

- 只依赖显式 ``seed`` 与实体 ID，生成顺序无关、可复现；
- 生成的一切价格/库存/品牌/店铺/标题均为合成口径，展示侧必须带合成标注；
- 类目名是真实 category_id 的合成映射（``synthetic_name=true``）。
"""

from __future__ import annotations

import math
import random
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

BRAND_POOL_SIZE = 200
SHOP_POOL_SIZE = 500
CATEGORY_WORDS = ("家居", "数码", "服饰", "美妆", "食品", "运动", "母婴", "图书", "家电", "百货")
SPEC_WORDS = ("经典款", "便携款", "礼盒装", "家庭装", "升级款", "基础款", "限量款", "定制款")
PRICE_BASE_BANDS = (19.9, 49.9, 99.0, 199.0, 399.0, 699.0, 1299.0)

BEHAVIOR_TYPES = ("pv", "fav", "cart", "buy")
DEFAULT_ITEM_POOL_SIZE = 1_000
DEFAULT_ANALYTICS_DATASET_ID = "retail-demo-expanded-v1"
DEFAULT_ANALYTICS_DAYS = 30


def _rng(*parts: object) -> random.Random:
    """每个实体独立播种：结果与生成顺序无关。"""
    return random.Random("|".join(str(part) for part in parts))


def category_name_for(category_id: int) -> str:
    word = CATEGORY_WORDS[category_id % len(CATEGORY_WORDS)]
    return f"{word}类目{category_id % 100:02d}"


def _category_price_base(category_id: int) -> float:
    return PRICE_BASE_BANDS[category_id % len(PRICE_BASE_BANDS)]


def brand_for(item_id: int, seed: int) -> tuple[int, str]:
    index = _rng(seed, "brand", item_id).randrange(BRAND_POOL_SIZE)
    return index, f"品牌{index:03d}"


def shop_for(item_id: int, seed: int) -> tuple[int, str, str]:
    index = _rng(seed, "shop", item_id).randrange(SHOP_POOL_SIZE)
    tier = _rng(seed, "tier", item_id).choice(("standard", "premium", "flagship"))
    return index, f"店铺{index:03d}", tier


def price_for(category_id: int, item_id: int, seed: int) -> float:
    base = _category_price_base(category_id)
    multiplier = math.exp(_rng(seed, "price", item_id).gauss(0.0, 0.6))
    value = max(1.0, min(50000.0, base * multiplier))
    return round(value, 2)


def stock_for(item_id: int, seed: int) -> int:
    draw = _rng(seed, "stock", item_id).random()
    if draw < 0.15:
        return _rng(seed, "stock-low", item_id).randint(0, 50)
    if draw < 0.6:
        return _rng(seed, "stock-mid", item_id).randint(50, 800)
    return _rng(seed, "stock-high", item_id).randint(800, 5000)


def title_for(item_id: int, category_name: str, brand_name: str, seed: int) -> str:
    spec = SPEC_WORDS[_rng(seed, "spec", item_id).randrange(len(SPEC_WORDS))]
    return f"{brand_name} {category_name.split("类目")[0]}{spec}"


def listed_at_for(window_start: datetime, item_id: int, seed: int) -> datetime:
    days_back = _rng(seed, "listed", item_id).randint(0, 365)
    return window_start - timedelta(days=days_back)


def daily_demand_multiplier(day: datetime) -> float:
    """给合成行为增加可解释的周内季节性，避免 BI 趋势被随机噪声抹平。"""

    weekday_factor = (0.88, 0.96, 1.03, 1.07, 1.12, 1.22, 1.28)[day.weekday()]
    promo_wave = 1.0 + 0.04 * math.sin((day.timetuple().tm_yday % 14) / 14 * math.pi * 2)
    return round(weekday_factor * promo_wave, 4)


def sample_item_offset(rng: random.Random, item_pool_size: int) -> int:
    """按头部/腰部/长尾抽样商品，模拟电商流量集中度。"""

    pool_size = max(1, item_pool_size)
    if pool_size == 1:
        return 0
    head_end = max(1, round(pool_size * 0.10))
    middle_end = max(head_end + 1, round(pool_size * 0.40))
    draw = rng.random()
    if draw < 0.65:
        return rng.randrange(head_end)
    if draw < 0.90:
        return rng.randrange(head_end, min(middle_end, pool_size))
    return rng.randrange(min(middle_end, pool_size - 1), pool_size)


def synthetic_master_rows(
    item_category: dict[int, int],
    seed: int,
    window_start: datetime,
) -> dict[str, list[dict[str, Any]]]:
    """为行为流命中的 item→category 映射生成合成主数据行。

    ``item_category`` 是真实映射：CSV 路径取自事件流 DISTINCT（item_id, category_id），
    合成路径由 :func:`synthetic_category_for` 派生，两边天然一致。
    """

    item_ids = sorted(item_category)
    brands: dict[int, dict[str, Any]] = {}
    shops: dict[int, dict[str, Any]] = {}
    items: list[dict[str, Any]] = []
    for item_id in item_ids:
        brand_id, brand_name = brand_for(item_id, seed)
        shop_id, shop_name, tier = shop_for(item_id, seed)
        brands.setdefault(
            brand_id,
            {"brand_id": brand_id, "name": brand_name, "synthetic": True},
        )
        shops.setdefault(
            shop_id,
            {"shop_id": shop_id, "name": shop_name, "tier": tier, "synthetic": True},
        )
        category_id = item_category[item_id]
        category_name = category_name_for(category_id)
        items.append(
            {
                "item_id": item_id,
                "category_id": category_id,
                "title": title_for(item_id, category_name, brand_name, seed),
                "brand_id": brand_id,
                "shop_id": shop_id,
                "price": price_for(category_id, item_id, seed),
                "stock": stock_for(item_id, seed),
                "listed_at": listed_at_for(window_start, item_id, seed),
                "synthetic_master": True,
            }
        )
    categories = [
        {
            "category_id": category_id,
            "name": category_name_for(category_id),
            "synthetic_name": True,
            "parent_id": None,
        }
        for category_id in sorted(set(item_category.values()))
    ]
    return {
        "categories": categories,
        "brands": sorted(brands.values(), key=lambda row: row["brand_id"]),
        "shops": sorted(shops.values(), key=lambda row: row["shop_id"]),
        "items": items,
    }


def synthetic_item_offset_category(item_offset: int, category_pool_size: int) -> int:
    """合成路径的单一事实源：category 由 item 派生，事件流与主数据共用。"""

    return item_offset % category_pool_size


def synthetic_behavior_events(
    users: int,
    days: int,
    seed: int,
    *,
    item_pool_size: int = DEFAULT_ITEM_POOL_SIZE,
    category_pool_size: int = 100,
    end_day: datetime | None = None,
) -> Iterator[dict[str, Any]]:
    """生成合成行为事件流（无 UserBehavior CSV 时的兜底口径，source='synthetic'）。

    每个用户独立播种；逐用户逐天生成 pv/fav/cart/buy，事件时间落在当天北京时间
    白天区间内（UTC 表示）。
    """

    last_day = end_day or datetime(2017, 12, 3, tzinfo=UTC)
    first_day = last_day - timedelta(days=days - 1)
    item_base = 1_000_000
    category_base = 10_000
    for user_id in range(1, users + 1):
        user_rng = _rng(seed, "user", user_id)
        for day_offset in range(days):
            day = first_day + timedelta(days=day_offset)
            demand = daily_demand_multiplier(day)
            if user_rng.random() > min(0.9, 0.6 * demand):
                continue
            pv_count = max(1, min(5, round(user_rng.randint(1, 5) * demand)))
            item_offsets = [sample_item_offset(user_rng, item_pool_size) for _ in range(pv_count)]
            events: list[tuple[str, int]] = [("pv", offset) for offset in item_offsets]
            if user_rng.random() < min(0.8, 0.25 * demand):
                events.append(("fav", user_rng.choice(item_offsets)))
            if user_rng.random() < min(0.85, 0.30 * demand):
                events.append(("cart", user_rng.choice(item_offsets)))
            if user_rng.random() < min(0.7, 0.15 * demand):
                events.append(("buy", user_rng.choice(item_offsets)))
            for behavior_type, item_offset in events:
                item_id = item_base + item_offset
                category_id = category_base + synthetic_item_offset_category(
                    item_offset, category_pool_size
                )
                second = user_rng.randint(0, 24 * 3600 - 1)
                event_ts = day + timedelta(seconds=second)
                yield {
                    "user_id": user_id,
                    "item_id": item_id,
                    "category_id": category_id,
                    "behavior_type": behavior_type,
                    "event_ts": event_ts,
                    "source": "synthetic",
                }


def batched_events(
    events: Iterator[dict[str, Any]],
    batch_size: int = 10_000,
) -> Iterator[list[dict[str, Any]]]:
    batch: list[dict[str, Any]] = []
    for event in events:
        batch.append(event)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def synthetic_analytics_dataset(
    users: int = 1_000,
    items: int = DEFAULT_ITEM_POOL_SIZE,
    days: int = DEFAULT_ANALYTICS_DAYS,
    seed: int = 20251203,
    *,
    dataset_id: str = DEFAULT_ANALYTICS_DATASET_ID,
    end_day: datetime | None = None,
) -> dict[str, list[dict[str, Any]] | dict[str, Any]]:
    """生成可追溯的电商经营分析演示数据集。

    该数据集与 UserBehavior v1 事实表隔离，通过 ``dataset_id`` 写入扩展表。
    它不是对真实业务的还原：用户画像、会话、渠道、活动、成本、订单状态和库存
    快照全部标记为合成，并在返回的 contract 中记录生成规则与适用限制。
    """

    if users < 1 or items < 1 or days < 1:
        raise ValueError("users、items、days 必须为正数")
    last_day = end_day or datetime(2025, 12, 3, tzinfo=UTC)
    first_day = last_day - timedelta(days=days - 1)
    source = "synthetic_market_scenario_v1"
    channels = [
        {"channel_id": "organic", "name": "自然搜索", "channel_type": "自然流量"},
        {"channel_id": "paid-search", "name": "搜索投放", "channel_type": "付费投放"},
        {"channel_id": "content", "name": "内容种草", "channel_type": "内容种草"},
        {"channel_id": "private", "name": "会员私域", "channel_type": "私域"},
    ]
    campaigns = [
        {
            "campaign_id": "always-on",
            "name": "日常经营",
            "campaign_type": "日常",
            "starts_at": first_day.date(),
            "ends_at": last_day.date(),
        },
        {
            "campaign_id": "mid-month",
            "name": "月中促销",
            "campaign_type": "大促",
            "starts_at": min(first_day.date() + timedelta(days=max(days // 3, 1)), last_day.date()),
            "ends_at": min(
                first_day.date() + timedelta(days=max(days // 3 + 3, 1)), last_day.date()
            ),
        },
        {
            "campaign_id": "member-day",
            "name": "会员日",
            "campaign_type": "会员",
            "starts_at": min(first_day.date() + timedelta(days=max(days // 2, 1)), last_day.date()),
            "ends_at": min(
                first_day.date() + timedelta(days=max(days // 2 + 1, 1)), last_day.date()
            ),
        },
        {
            "campaign_id": "content-wave",
            "name": "内容活动",
            "campaign_type": "内容",
            "starts_at": min(
                first_day.date() + timedelta(days=max(days * 2 // 3, 1)), last_day.date()
            ),
            "ends_at": last_day.date(),
        },
    ]
    profiles: list[dict[str, Any]] = []
    for user_id in range(1, users + 1):
        rng = _rng(seed, dataset_id, "profile", user_id)
        profiles.append(
            {
                "dataset_id": dataset_id,
                "user_id": user_id,
                "age_band": rng.choice(("18-24", "25-34", "35-44", "45+")),
                "gender": rng.choices(("female", "male", "unknown"), weights=(48, 45, 7))[0],
                "city_tier": rng.choices(
                    ("tier_1", "tier_2", "tier_3_plus"), weights=(25, 45, 30)
                )[0],
                "member_level": rng.choices(
                    ("new", "standard", "loyal", "premium"), weights=(20, 45, 25, 10)
                )[0],
                "registered_at": (first_day.date() - timedelta(days=rng.randint(1, 720))),
                "source": source,
                "synthetic": True,
            }
        )

    item_economics: list[dict[str, Any]] = []
    for item_offset in range(items):
        item_id = 1_000_000 + item_offset
        category_id = 10_000 + synthetic_item_offset_category(item_offset, 50)
        list_price = price_for(category_id, item_id, seed)
        cost_ratio = _rng(seed, dataset_id, "cost", item_id).uniform(0.42, 0.78)
        discount_rate = _rng(seed, dataset_id, "discount", item_id).choice(
            (0.0, 0.0, 0.05, 0.1, 0.15, 0.2)
        )
        item_economics.append(
            {
                "dataset_id": dataset_id,
                "item_id": item_id,
                "category_id": category_id,
                "list_price": list_price,
                "cost_price": round(list_price * cost_ratio, 2),
                "discount_rate": discount_rate,
                "source": source,
                "synthetic": True,
            }
        )
    economics_by_item = {row["item_id"]: row for row in item_economics}
    events = list(
        synthetic_behavior_events(
            users=users,
            days=days,
            seed=seed,
            item_pool_size=items,
            category_pool_size=50,
            end_day=last_day,
        )
    )
    sessions: list[dict[str, Any]] = []
    session_by_user_day: dict[tuple[int, str], dict[str, Any]] = {}
    for event in events:
        if event["behavior_type"] != "pv":
            continue
        event_day = event["event_ts"].date().isoformat()
        key = (event["user_id"], event_day)
        if key in session_by_user_day:
            continue
        rng = _rng(seed, dataset_id, "session", event["user_id"], event_day)
        channel = rng.choice(channels)
        campaign = next(
            campaign
            for campaign in campaigns
            if campaign["starts_at"] <= event["event_ts"].date() <= campaign["ends_at"]
        )
        started_at = event["event_ts"]
        session = {
            "dataset_id": dataset_id,
            "session_id": f"{dataset_id}-s-{event['user_id']}-{event_day}",
            "user_id": event["user_id"],
            "started_at": started_at,
            "ended_at": started_at + timedelta(minutes=rng.randint(3, 45)),
            "channel_id": channel["channel_id"],
            "campaign_id": campaign["campaign_id"],
            "source": source,
            "synthetic": True,
        }
        session_by_user_day[key] = session
        sessions.append(session)

    orders: list[dict[str, Any]] = []
    sold_by_day_item: dict[tuple[str, int], int] = {}
    for order_index, event in enumerate(
        (event for event in events if event["behavior_type"] == "buy"), start=1
    ):
        event_day = event["event_ts"].date().isoformat()
        session = session_by_user_day.get((event["user_id"], event_day))
        if session is None:
            continue
        item = economics_by_item[event["item_id"]]
        rng = _rng(seed, dataset_id, "order", order_index)
        quantity = 1 if rng.random() < 0.9 else 2
        promotion_delta = rng.choice((-0.05, 0.0, 0.0, 0.05))
        effective_discount = min(max(item["discount_rate"] + promotion_delta, 0.0), 0.35)
        selling_price = round(item["list_price"] * (1 - effective_discount), 2)
        gross = round(selling_price * quantity, 2)
        refund = gross if rng.random() < 0.04 else 0.0
        orders.append(
            {
                "dataset_id": dataset_id,
                "order_id": f"{dataset_id}-o-{order_index:07d}",
                "user_id": event["user_id"],
                "item_id": event["item_id"],
                "session_id": session["session_id"],
                "channel_id": session["channel_id"],
                "campaign_id": session["campaign_id"],
                "ordered_at": event["event_ts"],
                "quantity": quantity,
                "selling_price": selling_price,
                "discount_amount": round(item["list_price"] * quantity - gross, 2),
                "refund_amount": refund,
                "payment_status": "refunded" if refund else "paid",
                "fulfillment_status": rng.choice(("delivered", "shipped", "processing")),
                "source": source,
                "synthetic": True,
            }
        )
        sold_by_day_item[(event_day, event["item_id"])] = (
            sold_by_day_item.get((event_day, event["item_id"]), 0) + quantity
        )

    inventories: list[dict[str, Any]] = []
    opening_by_item = {
        row["item_id"]: stock_for(row["item_id"], seed) for row in item_economics
    }
    for day_offset in range(days):
        snapshot_date = (first_day + timedelta(days=day_offset)).date()
        for item in item_economics:
            item_id = item["item_id"]
            opening = opening_by_item[item_id]
            sold = sold_by_day_item.get((snapshot_date.isoformat(), item_id), 0)
            rng = _rng(seed, dataset_id, "inventory", snapshot_date, item_id)
            inbound = rng.randint(0, 12) if rng.random() < 0.08 else 0
            reserved = min(max(opening + inbound - sold, 0), rng.randint(0, 5))
            closing = max(opening + inbound - sold, 0)
            inventories.append(
                {
                    "dataset_id": dataset_id,
                    "snapshot_date": snapshot_date,
                    "item_id": item_id,
                    "opening_stock": opening,
                    "inbound_qty": inbound,
                    "sold_qty": sold,
                    "reserved_qty": reserved,
                    "closing_stock": closing,
                    "source": source,
                    "synthetic": True,
                }
            )
            opening_by_item[item_id] = closing

    contract = {
        "dataset_id": dataset_id,
        "version": "1.0.0",
        "source_kind": "synthetic",
        "source_name": source,
        "schema_version": "commerce.analytics.v1",
        "window_start": first_day.date(),
        "window_end": last_day.date(),
        "generation_seed": seed,
        "row_counts": {
            "behavior_events": len(events),
            "user_profiles": len(profiles),
            "channels": len(channels),
            "campaigns": len(campaigns),
            "sessions": len(sessions),
            "item_economics": len(item_economics),
            "orders": len(orders),
            "inventory_snapshots": len(inventories),
        },
        "synthetic_fields": [
            "user_profiles",
            "sessions",
            "channels",
            "campaigns",
            "cost_price",
            "discount_rate",
            "orders",
            "refund_amount",
            "fulfillment_status",
            "inventory_snapshots",
        ],
        "limitations": [
            "仅用于演示数据分析，不代表真实用户、订单、库存或财务事实",
            "订单由合成行为 buy 事件派生，不能用于真实收入确认或财务结算；价格弹性仅用于演示",
            "渠道和活动归因是确定性模拟，不是广告平台回传或实验结果",
            "库存快照没有真实仓库流水，不能单独作为补货结论",
        ],
        "generation_rule": (
            "以显式 seed、dataset_id 和实体 ID 独立播种；行为按周内需求和头腰尾商品分布生成，"
            "订单从 buy 事件派生，成本/折扣/促销价格/库存按实体与日期确定性生成。"
        ),
    }
    return {
        "contract": contract,
        "behavior_events": [
            {**event, "dataset_id": dataset_id, "source": source, "synthetic": True}
            for event in events
        ],
        "profiles": profiles,
        "channels": [
            {**row, "dataset_id": dataset_id, "source": source, "synthetic": True}
            for row in channels
        ],
        "campaigns": [
            {**row, "dataset_id": dataset_id, "source": source, "synthetic": True}
            for row in campaigns
        ],
        "sessions": sessions,
        "item_economics": item_economics,
        "orders": orders,
        "inventories": inventories,
    }


def analytics_dataset_from_behavior_events(
    events: list[dict[str, Any]],
    seed: int = 20251203,
    *,
    dataset_id: str,
    source_name: str = "userbehavior_csv",
) -> dict[str, list[dict[str, Any]] | dict[str, Any]]:
    """把外部行为事件补齐为可分析的混合数据集。

    上传 CSV 只提供行为事实；画像、会话归因、价格、成本、订单扩展字段和库存快照
    仍然由确定性规则补齐，并在契约中标记为合成。这样网页导入可以复用 P28 分析，
    同时不会把推导字段误报为外部真实交易事实。
    """

    if not events:
        raise ValueError("行为事件不能为空")
    user_ids = sorted({int(event["user_id"]) for event in events})
    item_category = {
        int(event["item_id"]): int(event["category_id"])
        for event in events
    }
    if not user_ids or not item_category:
        raise ValueError("行为事件必须包含用户和商品")
    first_day = min(event["event_ts"] for event in events).date()
    last_day = max(event["event_ts"] for event in events).date()
    channels = [
        {"channel_id": "organic", "name": "自然搜索", "channel_type": "自然流量"},
        {"channel_id": "paid-search", "name": "搜索投放", "channel_type": "付费投放"},
        {"channel_id": "content", "name": "内容种草", "channel_type": "内容种草"},
        {"channel_id": "private", "name": "会员私域", "channel_type": "私域"},
    ]
    days = (last_day - first_day).days + 1
    campaigns = [
        {
            "campaign_id": "always-on",
            "name": "日常经营",
            "campaign_type": "日常",
            "starts_at": first_day,
            "ends_at": last_day,
        },
        {
            "campaign_id": "mid-month",
            "name": "月中促销",
            "campaign_type": "大促",
            "starts_at": min(first_day + timedelta(days=max(days // 3, 1)), last_day),
            "ends_at": min(first_day + timedelta(days=max(days // 3 + 3, 1)), last_day),
        },
        {
            "campaign_id": "member-day",
            "name": "会员日",
            "campaign_type": "会员",
            "starts_at": min(first_day + timedelta(days=max(days // 2, 1)), last_day),
            "ends_at": min(first_day + timedelta(days=max(days // 2 + 1, 1)), last_day),
        },
        {
            "campaign_id": "content-wave",
            "name": "内容活动",
            "campaign_type": "内容",
            "starts_at": min(first_day + timedelta(days=max(days * 2 // 3, 1)), last_day),
            "ends_at": last_day,
        },
    ]

    profiles: list[dict[str, Any]] = []
    for user_id in user_ids:
        rng = _rng(seed, dataset_id, "profile", user_id)
        profiles.append(
            {
                "dataset_id": dataset_id,
                "user_id": user_id,
                "age_band": rng.choice(("18-24", "25-34", "35-44", "45+")),
                "gender": rng.choices(("female", "male", "unknown"), weights=(48, 45, 7))[0],
                "city_tier": rng.choices(
                    ("tier_1", "tier_2", "tier_3_plus"), weights=(25, 45, 30)
                )[0],
                "member_level": rng.choices(
                    ("new", "standard", "loyal", "premium"), weights=(20, 45, 25, 10)
                )[0],
                "registered_at": first_day - timedelta(days=rng.randint(1, 720)),
                "source": source_name,
                "synthetic": True,
            }
        )

    item_economics: list[dict[str, Any]] = []
    for item_id in sorted(item_category):
        category_id = item_category[item_id]
        list_price = price_for(category_id, item_id, seed)
        cost_ratio = _rng(seed, dataset_id, "cost", item_id).uniform(0.42, 0.78)
        discount_rate = _rng(seed, dataset_id, "discount", item_id).choice(
            (0.0, 0.0, 0.05, 0.1, 0.15, 0.2)
        )
        item_economics.append(
            {
                "dataset_id": dataset_id,
                "item_id": item_id,
                "category_id": category_id,
                "list_price": list_price,
                "cost_price": round(list_price * cost_ratio, 2),
                "discount_rate": discount_rate,
                "source": source_name,
                "synthetic": True,
            }
        )
    economics_by_item = {row["item_id"]: row for row in item_economics}

    sessions: list[dict[str, Any]] = []
    session_by_user_day: dict[tuple[int, str], dict[str, Any]] = {}
    for event in events:
        event_day = event["event_ts"].date().isoformat()
        key = (int(event["user_id"]), event_day)
        if key in session_by_user_day:
            continue
        rng = _rng(seed, dataset_id, "session", event["user_id"], event_day)
        channel = rng.choice(channels)
        campaign = next(
            campaign
            for campaign in campaigns
            if campaign["starts_at"] <= event["event_ts"].date() <= campaign["ends_at"]
        )
        started_at = event["event_ts"]
        session = {
            "dataset_id": dataset_id,
            "session_id": f"{dataset_id}-s-{event['user_id']}-{event_day}",
            "user_id": int(event["user_id"]),
            "started_at": started_at,
            "ended_at": started_at + timedelta(minutes=rng.randint(3, 45)),
            "channel_id": channel["channel_id"],
            "campaign_id": campaign["campaign_id"],
            "source": source_name,
            "synthetic": True,
        }
        session_by_user_day[key] = session
        sessions.append(session)

    orders: list[dict[str, Any]] = []
    sold_by_day_item: dict[tuple[str, int], int] = {}
    for order_index, event in enumerate(
        (event for event in events if event["behavior_type"] == "buy"), start=1
    ):
        event_day = event["event_ts"].date().isoformat()
        session = session_by_user_day[(int(event["user_id"]), event_day)]
        item = economics_by_item[int(event["item_id"])]
        rng = _rng(seed, dataset_id, "order", order_index)
        quantity = 1 if rng.random() < 0.9 else 2
        promotion_delta = rng.choice((-0.05, 0.0, 0.0, 0.05))
        effective_discount = min(max(item["discount_rate"] + promotion_delta, 0.0), 0.35)
        selling_price = round(item["list_price"] * (1 - effective_discount), 2)
        gross = round(selling_price * quantity, 2)
        refund = gross if rng.random() < 0.04 else 0.0
        orders.append(
            {
                "dataset_id": dataset_id,
                "order_id": f"{dataset_id}-o-{order_index:07d}",
                "user_id": int(event["user_id"]),
                "item_id": int(event["item_id"]),
                "session_id": session["session_id"],
                "channel_id": session["channel_id"],
                "campaign_id": session["campaign_id"],
                "ordered_at": event["event_ts"],
                "quantity": quantity,
                "selling_price": selling_price,
                "discount_amount": round(item["list_price"] * quantity - gross, 2),
                "refund_amount": refund,
                "payment_status": "refunded" if refund else "paid",
                "fulfillment_status": rng.choice(("delivered", "shipped", "processing")),
                "source": source_name,
                "synthetic": True,
            }
        )
        sold_by_day_item[(event_day, int(event["item_id"]))] = (
            sold_by_day_item.get((event_day, int(event["item_id"])), 0) + quantity
        )

    inventories: list[dict[str, Any]] = []
    opening_by_item = {
        row["item_id"]: stock_for(row["item_id"], seed) for row in item_economics
    }
    for day_offset in range(days):
        snapshot_date = first_day + timedelta(days=day_offset)
        for item in item_economics:
            item_id = item["item_id"]
            opening = opening_by_item[item_id]
            sold = sold_by_day_item.get((snapshot_date.isoformat(), item_id), 0)
            rng = _rng(seed, dataset_id, "inventory", snapshot_date, item_id)
            inbound = rng.randint(0, 12) if rng.random() < 0.08 else 0
            reserved = min(max(opening + inbound - sold, 0), rng.randint(0, 5))
            closing = max(opening + inbound - sold, 0)
            inventories.append(
                {
                    "dataset_id": dataset_id,
                    "snapshot_date": snapshot_date,
                    "item_id": item_id,
                    "opening_stock": opening,
                    "inbound_qty": inbound,
                    "sold_qty": sold,
                    "reserved_qty": reserved,
                    "closing_stock": closing,
                    "source": source_name,
                    "synthetic": True,
                }
            )
            opening_by_item[item_id] = closing

    contract = {
        "dataset_id": dataset_id,
        "version": "1.0.0",
        "source_kind": "mixed",
        "source_name": source_name,
        "schema_version": "commerce.analytics.v1",
        "window_start": first_day,
        "window_end": last_day,
        "generation_seed": seed,
        "row_counts": {
            "behavior_events": len(events),
            "user_profiles": len(profiles),
            "channels": len(channels),
            "campaigns": len(campaigns),
            "sessions": len(sessions),
            "item_economics": len(item_economics),
            "orders": len(orders),
            "inventory_snapshots": len(inventories),
        },
        "synthetic_fields": [
            "user_profiles",
            "sessions",
            "channels",
            "campaigns",
            "cost_price",
            "discount_rate",
            "orders",
            "refund_amount",
            "fulfillment_status",
            "inventory_snapshots",
        ],
        "limitations": [
            "行为事件来自上传 CSV，其余扩展字段为合成补齐",
            "合成价格、成本和订单扩展不能用于真实收入确认或财务结算；价格弹性仅用于演示",
            "渠道和活动归因是确定性模拟，不是广告平台回传或实验结果",
            "库存快照没有真实仓库流水，不能单独作为补货结论",
        ],
        "generation_rule": (
            "保留 CSV 行为事件；以显式 seed、dataset_id、实体 ID 和日期确定性补齐画像、"
            "会话归因、带促销波动的价格、成本、订单扩展和库存快照。"
        ),
    }
    return {
        "contract": contract,
        "behavior_events": [
            {**event, "dataset_id": dataset_id, "source": source_name, "synthetic": False}
            for event in events
        ],
        "profiles": profiles,
        "channels": [
            {**row, "dataset_id": dataset_id, "source": source_name, "synthetic": True}
            for row in channels
        ],
        "campaigns": [
            {**row, "dataset_id": dataset_id, "source": source_name, "synthetic": True}
            for row in campaigns
        ],
        "sessions": sessions,
        "item_economics": item_economics,
        "orders": orders,
        "inventories": inventories,
    }
