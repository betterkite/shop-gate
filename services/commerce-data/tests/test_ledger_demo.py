"""Fictional source facts must be self-consistent before any UI uses them."""

from collections import Counter, defaultdict
from dataclasses import replace
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest

from shopgate_commerce_data.ledger.csv_contract import parse_batch
from shopgate_commerce_data.ledger.demo import DemoPlan, demo_files, generate_demo


@pytest.fixture(scope="module")
def demo():
    return generate_demo(DemoPlan(start_date="2026-01-01"))


def test_default_is_complete_named_1000_specs_180_days_not_1000_products(demo):
    records, manifest = demo["records"], demo["manifest"]
    assert len(records["skus"]) == 1000 and len(records["products"]) == 500
    assert len(records["orders"]) == 12000
    assert len(records["channels"]) == 3 and len(records["stores"]) == 9
    assert (
        date.fromisoformat(manifest["end_date"]) - date.fromisoformat(manifest["start_date"])
    ).days == 179
    assert manifest["source_kind"] == "demo" and "不是真实" in manifest["notice"]
    assert all(product["name"].startswith("演示") for product in records["products"])
    assert all(cost["source"].startswith("模拟") for cost in records["costs"])
    assert all(expense["source"].startswith("模拟") for expense in records["expenses"])
    assert sum(manifest["row_counts"].values()) < 100000


def test_same_plan_is_reproducible(demo):
    regenerated = generate_demo(DemoPlan(start_date="2026-01-01"))
    assert regenerated["manifest"] == demo["manifest"]
    assert regenerated["records"] == demo["records"]


@pytest.mark.parametrize("seed", [0, 1, 1729])
def test_seed_and_business_date_are_separate_inputs(seed):
    plan = DemoPlan(start_date="2026-02-01", seed=seed, days=14, sku_count=20, order_count=80)
    a = generate_demo(plan)
    b = generate_demo(replace(plan, start_date="2026-03-01"))
    assert a["records"]["products"] == b["records"]["products"]
    assert a["records"]["skus"] == b["records"]["skus"]
    assert a["manifest"]["plan"]["seed"] == b["manifest"]["plan"]["seed"] == seed
    assert a["manifest"]["start_date"] != b["manifest"]["start_date"]
    assert a["manifest"]["content_hash"] != b["manifest"]["content_hash"]
    assert [row["unit_cost"] for row in a["records"]["costs"]] == [
        row["unit_cost"] for row in b["records"]["costs"]
    ]


def test_different_seed_changes_samples_not_requested_period():
    plan = DemoPlan(start_date="2026-02-01", days=14, sku_count=20, order_count=80)
    a, b = generate_demo(plan), generate_demo(replace(plan, seed=987))
    assert a["manifest"]["start_date"] == b["manifest"]["start_date"]
    assert a["manifest"]["end_date"] == b["manifest"]["end_date"]
    assert a["manifest"]["content_hash"] != b["manifest"]["content_hash"]


@pytest.mark.parametrize(
    "update",
    [
        {"seed": True},
        {"seed": -1},
        {"seed": 2**32},
        {"seed": 1.2},
        {"days": 6},
        {"days": 367},
        {"sku_count": 9},
        {"sku_count": 10001},
        {"order_count": 9},
        {"order_count": 100001},
        {"start_date": "2026-2-01"},
        {"start_date": "2026-02-29"},
        {"start_date": "1800-01-01"},
        {"start_date": None},
    ],
)
def test_invalid_plan_is_rejected_before_work(update):
    with pytest.raises(ValueError):
        replace(DemoPlan(start_date="2026-01-01"), **update).validate()


def test_all_twelve_demo_files_pass_versioned_csv_validation(demo):
    parsed, errors = parse_batch(demo_files(demo))
    assert errors == []
    assert {resource: len(entries) for resource, entries in parsed.items()} == demo["manifest"][
        "row_counts"
    ]
    assert parsed["skus"][0]["sku_id"] == "000000"


def test_fact_identifiers_references_and_original_order_codes_are_unique(demo):
    records = demo["records"]
    products = {row["product_id"] for row in records["products"]}
    skus = {row["sku_id"] for row in records["skus"]}
    stores = {row["store_id"] for row in records["stores"]}
    channels = {row["channel_id"] for row in records["channels"]}
    listings = {row["listing_id"]: row for row in records["mappings"]}
    orders = {row["order_id"]: row for row in records["orders"]}
    lines = {row["line_id"]: row for row in records["order_lines"]}
    assert len(products) == len(records["products"]) and len(skus) == len(records["skus"])
    assert len(orders) == len(records["orders"]) and len(lines) == len(records["order_lines"])
    assert all(row["product_id"] in products for row in records["skus"])
    assert all(
        row["store_id"] in stores and row["channel_id"] in channels for row in records["stores"]
    )
    assert all(
        row["store_id"]
        == orders[row["order_id"]]["store_id"]
        == listings[row["listing_id"]]["store_id"]
        for row in lines.values()
    )
    assert len({(row["store_id"], row["platform_order_id"]) for row in orders.values()}) == len(
        orders
    )
    assert all(row["platform_order_id"].startswith("000") for row in orders.values())
    assert all(row["line_id"] in lines for row in records["refunds"])
    assert all(row["line_id"] is None or row["line_id"] in lines for row in records["expenses"])


def test_refund_time_quantities_totals_and_unshipped_evidence(demo):
    records = demo["records"]
    orders = {row["order_id"]: row for row in records["orders"]}
    lines = {row["line_id"]: row for row in records["order_lines"]}
    totals = defaultdict(lambda: [Decimal(0), Decimal(0)])
    end = date.fromisoformat(demo["manifest"]["end_date"])
    for refund in records["refunds"]:
        line = lines[refund["line_id"]]
        order = orders[line["order_id"]]
        assert order["status"] == "paid"
        returned, recovered, cancelled = (
            Decimal(refund[key])
            for key in ("returned_quantity", "recoverable_quantity", "cancelled_quantity")
        )
        assert 0 <= recovered <= returned
        if refund["status"] == "pending":
            assert refund["occurred_at"] is None
            continue
        assert datetime.fromisoformat(refund["occurred_at"]) >= datetime.fromisoformat(
            order["paid_at"]
        )
        assert datetime.fromisoformat(refund["occurred_at"]).date() <= end
        assert Decimal(refund["amount"]) > 0
        if refund["refund_type"] == "refund_only":
            assert returned == recovered == cancelled == 0
        if refund["refund_type"] == "unshipped_cancel":
            assert order["fulfillment_status"] == "unshipped" and cancelled > 0
        totals[line["line_id"]][0] += Decimal(refund["amount"])
        totals[line["line_id"]][1] += returned + cancelled
    assert all(
        amount <= Decimal(lines[lid]["paid_amount"]) and quantity <= Decimal(lines[lid]["quantity"])
        for lid, (amount, quantity) in totals.items()
    )


def test_cost_intervals_layers_and_unknowns_are_real_facts(demo):
    records = demo["records"]
    groups = defaultdict(list)
    for cost in records["costs"]:
        groups[(cost["sku_id"], cost["level"], cost["channel_id"], cost["store_id"])].append(cost)
    for versions in groups.values():
        ordered = sorted(versions, key=lambda row: row["valid_from"])
        for old, new in zip(ordered, ordered[1:], strict=False):
            assert old["valid_to"] and old["valid_to"] <= new["valid_from"]
    assert {cost["level"] for cost in records["costs"]} == {"base", "channel", "store"}
    assert {cost["currency"] for cost in records["costs"]} == {"CNY", "USD"}
    assert not any(cost["sku_id"] == "000000" for cost in records["costs"])
    assert all(
        row["sku_id"] is None and row["unit_multiplier"] is None
        for row in records["mappings"]
        if row["status"] == "unmapped"
    )
    assert all(
        day not in {row["rate_date"] for row in records["fx_rates"]}
        for day in demo["manifest"]["missing_fx_days"]
    )
    assert all(demo["manifest"]["examples"].values())


def test_nonflat_demand_long_tail_and_no_sales_expense(demo):
    records = demo["records"]
    orders = {row["order_id"]: row for row in records["orders"]}
    by_day = Counter(
        order["paid_at"][:10] for order in orders.values() if order["status"] == "paid"
    )
    assert len(by_day) == 180 and max(by_day.values()) > min(by_day.values()) * 2
    paid_lines = [
        line for line in records["order_lines"] if orders[line["order_id"]]["status"] == "paid"
    ]
    selected = Counter(int(line["listing_id"].rsplit("-", 1)[1]) for line in paid_lines)
    assert sum(count for sku, count in selected.items() if sku < 100) > len(paid_lines) // 2
    assert len(selected) > 800
    assert not any(order["store_id"] == "pdd-quiet" for order in orders.values())
    assert any(
        expense["store_id"] == "pdd-quiet" and Decimal(expense["amount"]) > 0
        for expense in records["expenses"]
    )
    assert any(Decimal(expense["amount"]) < 0 for expense in records["expenses"])
    assert any(order["fx_rate"] and order["currency"] == "USD" for order in orders.values())
    assert all(order["paid_at"] is None for order in orders.values() if order["status"] != "paid")
    # Requested dates are the period; no fixture or seed chooses a hidden date window.
    assert max(date.fromisoformat(day) for day in by_day) == date(2026, 1, 1) + timedelta(days=179)
