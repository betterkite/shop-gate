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
                events.append(("fav", sample_item_offset(user_rng, item_pool_size)))
            if user_rng.random() < min(0.85, 0.30 * demand):
                events.append(("cart", sample_item_offset(user_rng, item_pool_size)))
            if user_rng.random() < min(0.7, 0.15 * demand):
                events.append(("buy", sample_item_offset(user_rng, item_pool_size)))
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
