"""合成生成器与零售纯函数的单测（不依赖数据库）。"""

from __future__ import annotations

import random
from datetime import UTC, datetime

from shopgate_commerce_data.retail import (
    buy_conversion_rate,
    funnel_stages,
    parse_iso_date,
    sell_through_ratio,
)
from shopgate_commerce_data.synthetic import (
    batched_events,
    daily_demand_multiplier,
    sample_item_offset,
    synthetic_behavior_events,
    synthetic_item_offset_category,
    synthetic_master_rows,
)

SEED = 20251203
WINDOW_START = datetime(2017, 11, 25, tzinfo=UTC)


def test_funnel_stages_computes_ordered_conversion() -> None:
    stages = funnel_stages({"pv": 1000, "fav": 100, "cart": 300, "buy": 50})
    assert [stage["stage"] for stage in stages] == ["pv", "fav", "cart", "buy"]
    assert stages[0]["conversion_from_previous"] is None
    assert stages[1]["conversion_from_previous"] == 0.1
    assert stages[2]["conversion_from_previous"] == 3.0
    assert stages[3]["conversion_from_previous"] == round(50 / 300, 6)


def test_funnel_stages_handles_missing_stages() -> None:
    stages = funnel_stages({"pv": 10})
    assert [stage["events"] for stage in stages] == [10, 0, 0, 0]
    assert stages[3]["conversion_from_previous"] == 0.0


def test_funnel_stages_exposes_unique_user_reach() -> None:
    stages = funnel_stages(
        {"pv": 1000, "fav": 100, "cart": 300, "buy": 50},
        {"pv": 400, "fav": 80, "cart": 120, "buy": 45},
    )
    assert [stage["unique_users"] for stage in stages] == [400, 80, 120, 45]
    assert stages[0]["user_reach_from_pv"] == 1.0
    assert stages[1]["user_reach_from_pv"] == 0.2
    assert stages[3]["user_reach_from_pv"] == 0.1125


def test_sell_through_ratio_floor_and_ranking() -> None:
    assert sell_through_ratio(stock=0, sold=0, days=9) == 0.0
    assert sell_through_ratio(stock=100, sold=0, days=9) == 100 / 0.01
    low = sell_through_ratio(stock=100, sold=900, days=9)
    high = sell_through_ratio(stock=1000, sold=90, days=9)
    assert low < high


def test_buy_conversion_rate_uses_pv_denominator() -> None:
    assert buy_conversion_rate(sold=25, views=1000) == 0.025
    assert buy_conversion_rate(sold=25, views=0) == 0.0


def test_parse_iso_date_accepts_and_rejects() -> None:
    from datetime import date

    assert parse_iso_date("2017-11-25") == date(2017, 11, 25)
    assert parse_iso_date(None, fallback=date(2017, 12, 3)) == date(2017, 12, 3)
    try:
        parse_iso_date("2017/11/25")
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("非法日期应抛 ValueError")


def test_synthetic_category_is_derived_from_item_offset() -> None:
    assert synthetic_item_offset_category(0, 100) == 0
    assert synthetic_item_offset_category(125, 100) == 25


def test_synthetic_events_and_master_agree_on_category() -> None:
    events = list(
        synthetic_behavior_events(users=50, days=3, seed=SEED, item_pool_size=200,
                                  category_pool_size=20)
    )
    assert events, "合成事件不应为空"
    item_category = {event["item_id"]: event["category_id"] for event in events}
    for event in events:
        assert item_category[event["item_id"]] == event["category_id"]
        offset = event["item_id"] - 1_000_000
        expected_category = 10_000 + synthetic_item_offset_category(offset, 20)
        assert event["category_id"] == expected_category


def test_synthetic_generation_is_deterministic() -> None:
    first = list(
        synthetic_behavior_events(users=30, days=2, seed=SEED, item_pool_size=100,
                                  category_pool_size=10)
    )
    second = list(
        synthetic_behavior_events(users=30, days=2, seed=SEED, item_pool_size=100,
                                  category_pool_size=10)
    )
    assert first == second


def test_synthetic_generation_has_weekly_demand_shape() -> None:
    monday = datetime(2026, 8, 31, tzinfo=UTC)
    saturday = datetime(2026, 9, 5, tzinfo=UTC)
    assert daily_demand_multiplier(saturday) > daily_demand_multiplier(monday)
    events = list(synthetic_behavior_events(users=500, days=9, seed=SEED, end_day=saturday))
    per_day: dict[str, int] = {}
    for event in events:
        day = str(event["event_ts"])[:10]
        per_day[day] = per_day.get(day, 0) + 1
    assert len(per_day) == 9
    assert max(per_day.values()) > min(per_day.values())


def test_synthetic_generation_has_head_mid_tail_item_mix() -> None:
    rng = random.Random(SEED)
    samples = [sample_item_offset(rng, 1000) for _ in range(10_000)]
    head = sum(offset < 100 for offset in samples)
    middle = sum(100 <= offset < 400 for offset in samples)
    tail = sum(offset >= 400 for offset in samples)
    assert head > middle > tail


def test_master_rows_reproducible_and_flagged_synthetic() -> None:
    events = list(
        synthetic_behavior_events(users=40, days=2, seed=SEED, item_pool_size=120,
                                  category_pool_size=12)
    )
    item_category = {event["item_id"]: event["category_id"] for event in events}
    first = synthetic_master_rows(item_category, seed=SEED, window_start=WINDOW_START)
    second = synthetic_master_rows(item_category, seed=SEED, window_start=WINDOW_START)
    assert first == second
    assert first["items"] == sorted(first["items"], key=lambda row: row["item_id"])
    for item in first["items"]:
        assert item["synthetic_master"] is True
        assert item["price"] >= 1.0
        assert 0 <= item["stock"] <= 5000
    for category in first["categories"]:
        assert category["synthetic_name"] is True
    assert {row["brand_id"] for row in first["brands"]} == {
        item["brand_id"] for item in first["items"]
    }


def test_batched_events_keeps_tail() -> None:
    events = iter([{"n": index} for index in range(25)])
    batches = list(batched_events(events, batch_size=10))
    assert [len(batch) for batch in batches] == [10, 10, 5]
