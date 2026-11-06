from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal as D

import pytest

from shopgate_commerce_data.ledger.accounting import (
    Cost,
    Mapping,
    Refund,
    allocate_cents,
    calculate_refunds,
    growth,
    make_snapshot,
    ratio,
)
from shopgate_commerce_data.ledger.metrics import METRICS, metric_catalog
from shopgate_commerce_data.ledger.query import Query, aggregate
from shopgate_commerce_data.ledger.scope import LedgerScope

AT = datetime(2026, 10, 1, tzinfo=UTC)
PAST = datetime(2026, 1, 1, tzinfo=UTC)


def snapshot(**overrides):
    data = {
        "paid_at": AT,
        "quantity": D("2.0000"),
        "paid_amount": D("100.00"),
        "currency": "CNY",
        "channel_id": "pdd",
        "store_id": "a",
        "mappings": [Mapping("m", "001", D("2.0000"), PAST)],
        "costs": [Cost("base", "001", "base", D("10.0000"), "CNY", PAST)],
        "rates": {},
    }
    data.update(overrides)
    return make_snapshot(**data)


def test_payment_snapshot_unit_conversion_and_three_level_priority():
    costs = [
        Cost("base", "001", "base", D("10.0000"), "CNY", PAST),
        Cost("channel", "001", "channel", D("9.0000"), "CNY", PAST, channel_id="pdd"),
        Cost("store", "001", "store", D("8.0000"), "CNY", PAST, channel_id="pdd", store_id="a"),
        Cost("other", "001", "store", D("1.0000"), "CNY", PAST, channel_id="pdd", store_id="b"),
    ]
    result = snapshot(costs=costs)
    assert result.cost_id == "store"
    assert result.standard_quantity == D("4.0000")
    assert result.cost_cny == D("32.00")
    assert snapshot(costs=costs[:-2]).cost_cny == D("36.00")
    assert snapshot(costs=costs[:1]).cost_cny == D("40.00")


def test_half_open_intervals_future_cost_not_historical():
    future = datetime(2026, 11, 1, tzinfo=UTC)
    costs = [
        Cost("old", "001", "base", D("10.0000"), "CNY", PAST, future),
        Cost("new", "001", "base", D("20.0000"), "CNY", future),
    ]
    assert snapshot(costs=costs).cost_id == "old"
    assert snapshot(paid_at=future, costs=costs).cost_id == "new"
    with pytest.raises(ValueError, match="不唯一"):
        snapshot(costs=[costs[0], replace(costs[0], cost_id="duplicate")])


def test_cross_currency_exact_line_rounding_and_missing_not_identity():
    result = snapshot(currency="USD", paid_amount=D("10.01"), rates={"USD": D("7.12345678")})
    assert result.revenue_cny == D("71.31")
    assert snapshot(currency="USD").revenue_cny is None
    assert snapshot(currency="USD").status == "missing_fx"
    assert snapshot(costs=[]).cost_cny is None
    assert snapshot(costs=[]).revenue_cny == D("100.00")
    assert snapshot(mappings=[]).standard_quantity is None
    assert snapshot(mappings=[], currency="USD").missing == ("missing_mapping", "missing_fx")


def test_quantity_conversion_does_not_silently_round():
    with pytest.raises(ValueError, match="四位"):
        snapshot(quantity=D("0.0001"), mappings=[Mapping("m", "001", D("0.0001"), PAST)])


@pytest.mark.parametrize("amount", ["10.00", "0.01", "-0.01", "-10.00", "0.00"])
def test_cent_allocation_exact_conservation_and_stable_ties(amount):
    result = allocate_cents(D(amount), {"c": D(1), "b": D(1), "a": D(1)})
    assert sum(result.values()) == D(amount)
    assert result == allocate_cents(D(amount), {"a": D(1), "b": D(1), "c": D(1)})
    if amount == "0.01":
        assert result == {"a": D("0.01"), "b": D("0.00"), "c": D("0.00")}


def test_large_precision_allocation_and_invalid_weight():
    result = allocate_cents(D("9999999999999999.99"), {"a": D("9999999999999999.99"), "b": D(1)})
    assert sum(result.values()) == D("9999999999999999.99")
    with pytest.raises(ValueError):
        allocate_cents(D("1.00"), {"x": D("NaN")})
    with pytest.raises(ValueError):
        allocate_cents(D("1.00"), {"x": 1.5})


def test_unknown_payment_and_refund_are_separate_metric_states():
    sale = {
        "kind": "sale",
        "line_id": "l",
        "order_id": "o",
        "revenue": None,
        "cost": D("1.00"),
        "quantity": D(1),
        "unit": "件",
        "complete": False,
    }
    metrics = aggregate([sale], Query())["metrics"]
    assert metrics["sales_amount"] is None
    assert metrics["refund_amount"] == "0.00"
    refund = {
        "kind": "refund",
        "line_id": "l",
        "order_id": "o",
        "refund": None,
        "recovery": D(0),
        "complete": False,
    }
    metrics = aggregate([refund], Query())["metrics"]
    assert metrics["sales_amount"] == "0.00"
    assert metrics["refund_amount"] is None
    assert metrics["net_sales"] is None


def test_different_standard_units_not_added_and_ratios_use_aggregate_numerators():
    sales = [
        {
            "kind": "sale",
            "line_id": "a",
            "order_id": "o",
            "revenue": D("100.00"),
            "cost": D("10.00"),
            "quantity": D(1),
            "unit": "件",
            "complete": True,
        },
        {
            "kind": "sale",
            "line_id": "b",
            "order_id": "o",
            "revenue": D("10.00"),
            "cost": D("10.00"),
            "quantity": D(1),
            "unit": "箱",
            "complete": True,
        },
    ]
    result = aggregate(sales, Query())
    assert result["metrics"]["standard_quantity"] is None
    assert result["quality"]["quantity_by_unit"] == {"件": "1.0000", "箱": "1.0000"}
    assert result["metrics"]["contribution_margin"] == "0.81818182"
    assert result["metrics"]["order_count"] == 1


def test_refund_only_keeps_cost_and_return_recovers_original_snapshot():
    result = calculate_refunds(
        snapshot(),
        D("100.00"),
        D("2.0000"),
        [
            Refund("r1", AT, D("25.00"), "refund_only"),
            Refund("r2", AT, D("25.00"), "return", D("1.0000"), D("1.0000")),
        ],
    )
    assert result[0].recovered_cost_cny == D("0.00")
    assert result[1].recovered_cost_cny == D("20.00")
    assert sum(row.amount_cny for row in result) == D("50.00")


def test_multiple_partial_foreign_refunds_full_amount_and_cost_conserve_cents():
    original = snapshot(
        paid_amount=D("0.03"),
        currency="USD",
        quantity=D("3.0000"),
        rates={"USD": D("1.50000000")},
        costs=[Cost("c", "001", "base", D("0.0083"), "CNY", PAST)],
    )
    result = calculate_refunds(
        original,
        D("0.03"),
        D("3.0000"),
        [Refund(f"r{i}", AT, D("0.01"), "return", D(1), D(1)) for i in range(3)],
    )
    assert original.revenue_cny == D("0.05")
    assert original.cost_cny == D("0.05")
    assert [row.amount_cny for row in result] == [D("0.02"), D("0.01"), D("0.02")]
    assert sum(row.recovered_cost_cny for row in result) == original.cost_cny


@pytest.mark.parametrize(
    "refund",
    [
        Refund("r", AT, D("101.00"), "refund_only"),
        Refund("r", AT, D("1.00"), "return", D(3), D(1)),
        Refund("r", AT, D("1.00"), "refund_only", D(1), D(1)),
    ],
)
def test_invalid_refunds_rejected(refund):
    with pytest.raises(ValueError):
        calculate_refunds(snapshot(), D("100.00"), D(2), [refund])


def test_pending_refund_excluded_unknown_recovery_not_zero():
    result = calculate_refunds(
        snapshot(costs=[]),
        D("100.00"),
        D(2),
        [
            Refund("pending", AT, D("100.00"), "refund_only", status="pending"),
            Refund("only", AT, D("10.00"), "refund_only"),
            Refund("return", AT, D("10.00"), "return", D(1), D(1)),
        ],
    )
    assert len(result) == 2
    assert result[0].recovered_cost_cny == 0
    assert result[1].recovered_cost_cny is None


@pytest.mark.parametrize("previous", [D(0), D(-1), None])
def test_zero_negative_unknown_denominators_not_fake_growth(previous):
    assert growth(D(1), previous) is None
    assert ratio(D(1), previous) is None


@pytest.mark.parametrize(
    "query",
    [
        Query(dimension="arbitrary-sql"),
        Query(metrics=("DROP TABLE",)),
        Query(page=0),
        Query(page_size=201),
        Query(start="2026-10-02", end="2026-10-01"),
        Query(start="2026-1-1"),
        Query(refund_basis="unknown"),
        Query(store_ids=("x;sql",)),
    ],
)
def test_controlled_query_rejects_invalid_inputs(query):
    with pytest.raises(ValueError):
        query.validate()


def test_metric_catalog_and_version_scope_cache_are_complete():
    catalog = {row["id"]: row for row in metric_catalog()}
    assert set(catalog) == set(METRICS)
    for metric in ["net_sales", "sales_amount", "refund_amount", "contribution_profit", "expense_amount"]:
        assert "汇总金额" in catalog[metric]["aggregation"]
        assert "分母" not in catalog[metric]["aggregation"]
    assert "去重" in catalog["order_count"]["aggregation"]
    assert "不同单位" in catalog["standard_quantity"]["aggregation"]
    for metric in ["average_order_value", "contribution_margin", "refund_ratio", "coverage_ratio"]:
        assert "分子与分母" in catalog[metric]["aggregation"]
        assert "不平均" in catalog[metric]["aggregation"]
    scope = LedgerScope("account:a", "d", "a", 1, frozenset({"ledger.read"}))
    query = Query()
    assert query.cache_key(scope) != query.cache_key(replace(scope, version=2))
    assert query.cache_key(scope) != query.cache_key(replace(scope, dataset_id="other"))
    assert query.cache_key(scope) != replace(query, sku_ids=("001",)).cache_key(scope)
