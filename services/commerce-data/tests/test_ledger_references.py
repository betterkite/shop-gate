"""Reject invalid directory/query authority before opening a database connection."""

import pytest

from shopgate_commerce_data.ledger.references import ReferenceRequest, references


@pytest.mark.parametrize("options", [
    {"kind": []}, {"kind": "orders; DROP TABLE bi.orders"}, {"page": True},
    {"page": 0}, {"page": 1000000}, {"page_size": 200}, {"page_size": True},
    {"sort": []}, {"sort": "revenue"}, {"descending": "false"},
    {"search": {}}, {"search": "x" * 201}, {"category": "x" * 201},
    {"product_id": "parent"}, {"kind": "store", "channel_id": "bad/id"},
    {"kind": "sku", "product_id": 123}, {"kind": "category", "category": "服装"},
])
def test_directory_rejects_invalid_or_unsupported_scope(options):
    with pytest.raises(ValueError):
        references(None, None, ReferenceRequest(**options))


def test_uncategorized_is_a_real_filter_and_leading_zero_parents_are_preserved():
    ReferenceRequest(kind="product", category="").validate()
    ReferenceRequest(kind="sku", category="", product_id="0001").validate()
    ReferenceRequest(kind="listing", store_id="001", channel_id="pdd").validate()



@pytest.mark.parametrize("options", [
    {"kind": "mapping"}, {"kind": "mapping", "as_of": "2026-02-30"},
    {"kind": "mapping", "as_of": "20260701"}, {"kind": "listing", "as_of": "2026-07-01"},
    {"kind": "mapping", "as_of": "2026-07-01", "mapping_status": "unknown"},
    {"kind": "product", "mapping_status": "missing"}, {"kind": "store", "sku_id": "001"},
])
def test_mapping_directory_rejects_invalid_or_unrelated_filters(options):
    with pytest.raises(ValueError):
        references(None, None, ReferenceRequest(**options))


@pytest.mark.parametrize("change", [
    {"as_of": None}, {"listing_id": None}, {"store_id": "001"},
    {"mapping_status": "missing"}, {"sort": "unknown"},
])
def test_store_cost_history_requires_a_scoped_listing_and_date(change):
    with pytest.raises(ValueError):
        references(None, None, ReferenceRequest(**{
            "kind": "listing_cost", "listing_id": "l001", "as_of": "2026-07-01", **change,
        }))
