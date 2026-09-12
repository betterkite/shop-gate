"""P28 经营分析的可解释规则单测。"""

import asyncio
from datetime import date

import pytest

from shopgate_commerce_data.analytics import (
    analytics_dataset_meta,
    analytics_drilldown,
    classify_lifecycle_stage,
    classify_rfm,
    inventory_health_label,
    price_band_comparison,
)


def test_dataset_meta_preserves_isolated_dataset_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return [{
                "dataset_id": "retail-upload",
                "version": 1,
                "source_kind": "mixed",
                "source_name": "userbehavior_csv",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 3),
                "generation_seed": 42,
                "row_counts": {"behavior_events": 3},
                "synthetic_fields": ["price"],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [{
            "first_event_ts": date(2025, 1, 1),
            "last_event_ts": date(2025, 1, 3),
            "event_count": 3,
            "user_count": 2,
            "item_count": 2,
            "category_count": 1,
            "source_count": 1,
        }]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(analytics_dataset_meta("retail-upload"))

    assert result["dataset_id"] == "retail-upload"
    assert result["first_event_ts"] == "2025-01-01"
    assert result["last_event_ts"] == "2025-01-03"
    assert result["behavior_source"] == "userbehavior_csv"
    assert result["event_count"] == 3


def test_rfm_labels_are_user_facing_and_stable() -> None:
    assert classify_rfm(30, 8, 1000, 800) == "流失风险"
    assert classify_rfm(5, 6, 1000, 800) == "高价值"
    assert classify_rfm(7, 1, 30, 800) == "新近购买"
    assert classify_rfm(10, 2, 200, 800) == "稳定复购"


def test_inventory_health_labels_explain_stock_state() -> None:
    assert inventory_health_label(0, 2, 0) == "缺货风险"
    assert inventory_health_label(100, 0, 10000) == "有库存但无销量"
    assert inventory_health_label(1000, 10, 100) == "库存积压"
    assert inventory_health_label(20, 5, 4) == "库存正常"


def test_lifecycle_stage_rules_are_user_facing_and_stable() -> None:
    window_start = date(2025, 11, 4)
    window_end = date(2025, 12, 3)
    assert classify_lifecycle_stage(window_start, window_end, None, None)[0] == "未启动"
    assert classify_lifecycle_stage(
        window_start, window_end, date(2025, 11, 25), date(2025, 12, 3)
    )[0] == "成长期"
    assert classify_lifecycle_stage(
        window_start, window_end, date(2025, 11, 4), date(2025, 11, 26)
    )[0] == "稳定期"
    assert classify_lifecycle_stage(
        window_start, window_end, date(2025, 11, 4), date(2025, 11, 10)
    )[0] == "衰退风险"


def test_price_band_comparison_reports_estimated_elasticity_for_multiple_prices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return [{
                "dataset_id": "retail-p28",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "p28_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 31),
                "generation_seed": 28,
                "row_counts": {},
                "synthetic_fields": ["price"],
                "limitations": [],
                "generation_rule": "test",
            }]
        if calls == 2:
            return [{
                "price_band": "50-200",
                "item_count": 1,
                "orders": 8,
                "units": 8,
                "net_sales": 800,
                "average_discount_rate": 0.1,
            }]
        return [{
            "item_id": 1001,
            "category_id": 10,
            "price_points": 2,
            "min_price": 90,
            "max_price": 110,
            "units": 8,
            "orders": 8,
            "elasticity": -1.25,
        }]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(price_band_comparison("retail-p28"))

    assert result["status"] == "estimated"
    assert result["estimation_method"] == "log_demand_on_log_price"
    assert result["elasticity_estimate"] == -1.25
    assert result["eligible_item_count"] == 1
    assert result["item_elasticities"][0]["price_points"] == 2


def test_price_band_comparison_keeps_explicit_data_gap_when_no_item_has_two_prices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return [{
                "dataset_id": "retail-p28",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "p28_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 31),
                "generation_seed": 28,
                "row_counts": {},
                "synthetic_fields": ["price"],
                "limitations": [],
                "generation_rule": "test",
            }]
        if calls == 2:
            return []
        return []

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(price_band_comparison("retail-p28"))

    assert result["status"] == "insufficient_data_for_elasticity"
    assert result["elasticity_estimate"] is None
    assert result["eligible_item_count"] == 0
    assert result["required_for_estimation"]


def test_item_drilldown_includes_behavior_funnel_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return [{
                "dataset_id": "retail-p30",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "p30_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 31),
                "generation_seed": 30,
                "row_counts": {},
                "synthetic_fields": ["price"],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [{
            "item_id": 1001,
            "orders": 3,
            "users": 2,
            "units": 4,
            "net_sales": 396,
            "closing_stock": 20,
            "sold_qty": 4,
            "first_order_date": date(2025, 1, 2),
            "last_order_date": date(2025, 1, 25),
            "snapshot_date": date(2025, 1, 31),
            "pv": 100,
            "fav": 12,
            "cart": 8,
            "buy": 4,
        }]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(analytics_drilldown("retail-p30", "item", "1001"))

    item = result["results"][0]
    assert item["pv"] == 100
    assert item["fav"] == 12
    assert item["cart"] == 8
    assert item["buy"] == 4
    assert item["buy_conversion"] == 0.04
    assert "查看该商品的浏览到购买转化" in result["next_questions"]
    assert result["action_suggestions"]
    assert result["context_url"] == (
        "/analytics-workbench?view=drilldown&dataset_id=retail-p30"
        "&dimension=item&value=1001"
    )


def test_category_drilldown_includes_behavior_funnel_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return [{
                "dataset_id": "retail-p30",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "p30_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 31),
                "generation_seed": 30,
                "row_counts": {},
                "synthetic_fields": ["price"],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [{
            "category_id": 10,
            "orders": 12,
            "users": 9,
            "units": 15,
            "net_sales": 1500,
            "pv": 500,
            "fav": 60,
            "cart": 40,
            "buy": 15,
        }]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(analytics_drilldown("retail-p30", "category", "10"))

    row = result["results"][0]
    assert row["category_id"] == 10
    assert row["pv"] == 500
    assert row["buy"] == 15
    assert row["buy_conversion"] == 0.03
    assert result["context_url"].endswith("dimension=category&value=10")
    assert result["action_suggestions"]
