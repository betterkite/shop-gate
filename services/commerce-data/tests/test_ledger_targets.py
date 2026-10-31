"""User target values remain exact and distinguish unset, zero and negative plans."""

import pytest

from shopgate_commerce_data.ledger.targets import TargetChange


def test_target_canonical_money_and_unset_profit_are_not_zero():
    assert TargetChange("001", "2026-07-01", "0").normalized() == {
        "store_id": "001",
        "month": "2026-07-01",
        "sales_target": "0.00",
        "profit_target": None,
    }
    assert (
        TargetChange("001", "2026-07-01", "1500.25", "-50").normalized()["profit_target"]
        == "-50.00"
    )


@pytest.mark.parametrize(
    "change",
    [
        {"store_id": "../private"},
        {"store_id": True},
        {"month": "2026-07-02"},
        {"month": "2026-7-01"},
        {"month": "2026-02-29"},
        {"month": None},
        {"sales_target": "-1"},
        {"sales_target": "1.001"},
        {"sales_target": "NaN"},
        {"sales_target": "1e3"},
        {"sales_target": 100},
        {"sales_target": True},
        {"profit_target": ""},
        {"profit_target": "0.001"},
        {"profit_target": 0},
    ],
)
def test_invalid_target_values_are_rejected_without_guessing(change):
    inputs = {"store_id": "001", "month": "2026-07-01", "sales_target": "100"}
    with pytest.raises(ValueError):
        TargetChange(**(inputs | change)).normalized()
