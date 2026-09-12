"""P28 经营分析的可解释规则单测。"""

import asyncio
from datetime import date

import pytest

from shopgate_commerce_data.analytics import (
    analytics_dataset_meta,
    analytics_drilldown,
    analytics_overview,
    analytics_trend,
    classify_lifecycle_stage,
    classify_rfm,
    inventory_analytics,
    inventory_health_label,
    price_band_comparison,
    replenishment_forecast,
    retention_metrics,
    rfm_segments,
)


def test_analytics_overview_applies_entity_scope_to_order_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    queries: list[str] = []
    params_seen: list[tuple[object, ...]] = []

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        queries.append(query)
        params_seen.append(params)
        if calls == 1:
            return [{
                "dataset_id": "retail-overview",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "overview_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 3),
                "generation_seed": 1,
                "row_counts": {},
                "synthetic_fields": [],
                "limitations": [],
                "generation_rule": "test",
            }]
        if calls == 2:
            return [{
                "orders": 2,
                "buyers": 2,
                "sold_items": 1,
                "units": 3,
                "gross_sales": 300,
                "refunds": 0,
                "net_sales": 300,
            }]
        return [{"severity": "ok", "issue_count": 0, "checked_rows": 2}]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(analytics_overview("retail-overview", "category", "10"))

    assert calls == 3
    assert result["scope"] == {"dimension": "category", "value": "10", "applied": True}
    assert "i.category_id = %s" in queries[1]
    assert params_seen[1] == ("retail-overview", 10)


def test_analytics_overview_rejects_non_numeric_item_scope() -> None:
    with pytest.raises(ValueError, match="必须是数字"):
        asyncio.run(analytics_overview("retail-overview", "item", "not-an-item"))


def test_analytics_trend_returns_padded_daily_rows_for_item_scope(
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
                "dataset_id": "retail-trend",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "trend_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 3),
                "generation_seed": 1,
                "row_counts": {},
                "synthetic_fields": [],
                "limitations": [],
                "generation_rule": "test",
            }]
        if calls == 2:
            return [{
                "stat_date": date(2025, 1, 1),
                "pv": 10,
                "fav": 2,
                "cart": 3,
                "buy": 1,
            }]
        return [{
            "stat_date": date(2025, 1, 3),
            "orders": 1,
            "net_sales": 99.5,
        }]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(analytics_trend("retail-trend", "item", "1001"))

    assert calls == 3
    assert result["filter"] == {"dimension": "item", "value": "1001"}
    assert result["context_url"] == (
        "/analytics-workbench?view=drilldown&dataset_id=retail-trend"
        "&dimension=item&value=1001"
    )
    assert [row["stat_date"] for row in result["rows"]] == [
        "2025-01-01", "2025-01-02", "2025-01-03"
    ]
    assert result["rows"][1]["pv"] == 0
    assert result["rows"][2]["orders"] == 1


def test_analytics_trend_rejects_partial_filter() -> None:
    with pytest.raises(ValueError, match="同时提供"):
        asyncio.run(analytics_trend("retail-trend", "item", None))


def test_analytics_trend_does_not_claim_unattributed_behavior_for_channel(
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
                "dataset_id": "retail-trend",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 1),
            }]
        return [{"stat_date": date(2025, 1, 1), "orders": 2, "net_sales": 20}]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(analytics_trend("retail-trend", "channel", "organic"))

    assert calls == 2
    assert result["rows"] == [{
        "stat_date": "2025-01-01",
        "pv": 0,
        "fav": 0,
        "cart": 0,
        "buy": 0,
        "orders": 2,
        "net_sales": 20.0,
    }]


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


def test_retention_metrics_builds_weekly_cohorts_from_repeat_purchases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    queries: list[str] = []

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        queries.append(query)
        if calls == 1:
            return [{
                "dataset_id": "retail-retention",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "retention_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 12),
                "generation_seed": 1,
                "row_counts": {},
                "synthetic_fields": [],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [
            {"user_id": 1, "activity_date": date(2025, 1, 1)},
            {"user_id": 1, "activity_date": date(2025, 1, 8)},
            {"user_id": 2, "activity_date": date(2025, 1, 2)},
            {"user_id": 3, "activity_date": date(2025, 1, 8)},
        ]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(retention_metrics("retail-retention", "category", "10"))

    assert calls == 2
    assert "i.category_id = %s" in queries[1]
    assert result["scope"] == {"dimension": "category", "value": "10", "applied": True}
    assert result["summary"]["buyer_count"] == 3
    assert result["summary"]["cohort_count"] == 2
    assert result["summary"]["eligible_7d_users"] == 2
    assert result["summary"]["retained_7d_users"] == 1
    assert result["summary"]["retention_7d_rate"] == 0.5
    assert result["cohorts"][0]["periods"][0]["rate"] == 1.0


def test_inventory_health_labels_explain_stock_state() -> None:
    assert inventory_health_label(0, 2, 0) == "缺货风险"
    assert inventory_health_label(100, 0, 10000) == "有库存但无销量"
    assert inventory_health_label(1000, 10, 100) == "库存积压"
    assert inventory_health_label(20, 5, 4) == "库存正常"


def test_inventory_analytics_paginates_all_items_without_losing_counts(
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
                "dataset_id": "retail-inventory",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "inventory_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 3),
                "generation_seed": 1,
                "row_counts": {},
                "synthetic_fields": ["stock"],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [
            {
                "item_id": 1000 + index,
                "snapshot_date": date(2025, 1, 3),
                "closing_stock": 100 + index,
                "reserved_qty": 0,
                "average_daily_sold": 2,
                "sold_units": 6,
            }
            for index in range(45)
        ]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(inventory_analytics("retail-inventory", limit=20, page=2))

    assert calls == 2
    assert result["item_count"] == 45
    assert result["page"] == 2
    assert result["page_size"] == 20
    assert result["page_count"] == 3
    assert [item["item_id"] for item in result["items"]] == list(range(1020, 1040))
    assert sum(result["risk_counts"].values()) == 45


def test_replenishment_forecast_uses_explicit_coverage_assumptions(
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
                "dataset_id": "retail-replenishment",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "replenishment_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 31),
                "generation_seed": 1,
                "row_counts": {},
                "synthetic_fields": ["stock"],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [
            {
                "item_id": 1000,
                "snapshot_date": date(2025, 1, 31),
                "closing_stock": 20,
                "reserved_qty": 0,
                "average_daily_sold": 10,
                "sold_units": 310,
            },
            {
                "item_id": 1001,
                "snapshot_date": date(2025, 1, 31),
                "closing_stock": 100,
                "reserved_qty": 0,
                "average_daily_sold": 0,
                "sold_units": 0,
            },
            {
                "item_id": 1002,
                "snapshot_date": date(2025, 1, 31),
                "closing_stock": 100,
                "reserved_qty": 0,
                "average_daily_sold": 1,
                "sold_units": 31,
            },
        ]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(
        replenishment_forecast(
            "retail-replenishment",
            limit=20,
            lead_time_days=7,
            target_days=30,
        )
    )

    assert calls == 2
    assert result["assumptions"]["coverage_days"] == 37
    assert result["summary"]["priority_counts"]["优先评估补货"] == 1
    assert result["summary"]["priority_counts"]["无销量先观察"] == 1
    assert result["summary"]["reference_replenishment_item_count"] == 1
    assert result["items"][0]["item_id"] == 1000
    assert result["items"][0]["available_days_cover"] == 2.0
    assert result["items"][0]["reference_replenishment_units"] == 350
    assert result["items"][0]["replenishment_priority"] == "优先评估补货"
    assert result["items"][1]["replenishment_priority"] == "暂不建议补货"


def test_rfm_segments_paginates_all_customers_without_losing_segments(
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
                "dataset_id": "retail-rfm",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "rfm_fixture",
                "schema_version": "commerce-analytics-v1",
                "window_start": date(2025, 1, 1),
                "window_end": date(2025, 1, 31),
                "generation_seed": 1,
                "row_counts": {},
                "synthetic_fields": ["user_profiles"],
                "limitations": [],
                "generation_rule": "test",
            }]
        return [
            {
                "user_id": 2000 + index,
                "last_order_date": date(2025, 1, 31),
                "frequency": 1,
                "units": 1,
                "monetary": 100 + index,
                "age_band": "25-34",
                "city_tier": "二线",
                "member_level": "普通",
            }
            for index in range(45)
        ]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(rfm_segments("retail-rfm", limit=20, page=2))

    assert calls == 2
    assert result["customer_count"] == 45
    assert result["page"] == 2
    assert result["page_size"] == 20
    assert result["page_count"] == 3
    assert [customer["user_id"] for customer in result["customers"]] == list(range(2020, 2040))
    assert sum(result["segment_counts"].values()) == 45


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


def test_price_band_comparison_paginates_item_observations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    queries: list[str] = []

    async def fake_fetch_all(
        query: str,
        params: tuple[object, ...] = (),
    ) -> list[dict[str, object]]:
        nonlocal calls
        calls += 1
        queries.append(query)
        if calls == 1:
            return [{
                "dataset_id": "retail-p28-elasticity",
                "version": 1,
                "source_kind": "synthetic",
                "source_name": "elasticity_fixture",
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
                "item_count": 45,
                "orders": 45,
                "units": 45,
                "net_sales": 4_500,
                "average_discount_rate": 0.1,
            }]
        return [
            {
                "item_id": 3000 + index,
                "category_id": 10,
                "price_points": 2,
                "min_price": 90,
                "max_price": 110,
                "units": 8,
                "orders": 8,
                "elasticity": -1.25,
            }
            for index in range(45)
        ]

    monkeypatch.setattr("shopgate_commerce_data.analytics.fetch_all", fake_fetch_all)

    result = asyncio.run(price_band_comparison("retail-p28-elasticity", limit=20, page=2))

    assert calls == 3
    assert result["eligible_item_count"] == 45
    assert result["page"] == 2
    assert result["page_size"] == 20
    assert result["page_count"] == 3
    assert [item["item_id"] for item in result["item_elasticities"]] == list(range(3020, 3040))
    assert "LIMIT 100" not in queries[2]


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
