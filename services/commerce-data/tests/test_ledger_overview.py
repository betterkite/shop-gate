"""Independent expectations for comparison and strict overview options."""

from dataclasses import replace

import pytest

from shopgate_commerce_data.ledger.evidence import EvidenceRequest
from shopgate_commerce_data.ledger.overview import OverviewRequest, compare_value


@pytest.mark.parametrize(
    "current,previous,state,growth,difference",
    [
        ("164.00", "50.00", "comparable", "2.28000000", "114.00"),
        ("0.00", "10.00", "comparable", "-1.00000000", "-10.00"),
        ("10.00", "0.00", "zero_base", None, "10.00"),
        ("10.00", "-10.00", "negative_base", None, "20.00"),
        (None, "10.00", "missing", None, None),
        ("10.00", None, "missing", None, None),
        (4, 2, "comparable", "1.00000000", "2"),
    ],
)
def test_comparison_is_exact_and_does_not_invent_growth(
    current, previous, state, growth, difference
):
    value = compare_value(current, previous)
    assert value == {
        "current": current,
        "previous": previous,
        "state": state,
        "difference": difference,
        "growth_ratio": growth,
    }
    assert compare_value(current, previous, history_sufficient=False)["growth_ratio"] is None
    assert compare_value(current, previous, history_sufficient=False)["state"] == (
        "history_insufficient"
    )


@pytest.mark.parametrize(
    "change",
    [
        {"interval": "month"},
        {"channel_metric": "arbitrary_sql"},
        {"channel_page": True},
        {"target_page": 0},
        {"target_page": 1.5},
        {"target_month": "2026-07-02"},
        {"target_month": "2026-7-01"},
        {"channel_page": 1_000_001},
    ],
)
def test_overview_options_are_validated_without_silent_truncation(change):
    with pytest.raises(ValueError):
        replace(OverviewRequest(), **change).validate()


@pytest.mark.parametrize("change", [
    {"quality_key": "sql"}, {"quality_key": []}, {"page": True}, {"page": 0},
    {"event_page": 1000000}, {"page_size": 100}, {"sort": []}, {"descending": 1},
    {"search": "x" * 201}, {"record_key": "../foreign"}, {"record_key": []},
])
def test_evidence_rejects_unbounded_or_unregistered_inputs(change):
    with pytest.raises(ValueError):
        replace(EvidenceRequest(), **change).validate()
