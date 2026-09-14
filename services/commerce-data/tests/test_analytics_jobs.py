"""P31 Web 数据集导入参数与任务契约单测。"""

from __future__ import annotations

from pathlib import Path

import pytest

from shopgate_commerce_data.analytics_jobs import (
    AnalyticsDatasetImportError,
    _read_behavior_csv,
    validate_csv_import_request,
    validate_import_request,
)


def valid_import_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "project_id": "project-demo",
        "idempotency_key": "request-1",
        "dataset_id": "retail-demo-p31",
    }
    payload.update(overrides)
    return payload


def test_validate_import_request_normalises_defaults() -> None:
    result = validate_import_request(
        {
            "project_id": "project-demo",
            "idempotency_key": "dataset-import:demo-1",
            "dataset_id": "retail-demo-p31",
        }
    )

    assert result == {
        "project_id": "project-demo",
        "idempotency_key": "dataset-import:demo-1",
        "dataset_id": "retail-demo-p31",
        "users": 1_000,
        "items": 1_000,
        "days": 30,
        "seed": 20251203,
        "end_day": "2025-12-03",
    }


def test_validate_csv_import_request_keeps_dataset_and_seed() -> None:
    assert validate_csv_import_request(
        "retail-upload", 42, "project-demo", "csv-import:demo-1"
    ) == {
        "project_id": "project-demo",
        "idempotency_key": "csv-import:demo-1",
        "dataset_id": "retail-upload",
        "seed": 42,
    }


def test_read_behavior_csv_parses_contract(tmp_path: Path) -> None:
    csv_path = tmp_path / "events.csv"
    csv_path.write_text(
        "user_id,item_id,category_id,behavior_type,timestamp\n"
        "7,11,3,pv,1511875200\n"
        "7,11,3,buy,1511875300\n",
        encoding="utf-8",
    )

    events = _read_behavior_csv(csv_path)

    assert len(events) == 2
    assert events[0]["user_id"] == 7
    assert events[0]["source"] == "userbehavior_csv"
    assert events[1]["event_ts"].isoformat() == "2017-11-28T13:21:40+00:00"


def test_read_behavior_csv_rejects_invalid_behavior(tmp_path: Path) -> None:
    csv_path = tmp_path / "events.csv"
    csv_path.write_text(
        "user_id,item_id,category_id,behavior_type,timestamp\n7,11,3,view,1511875200\n",
        encoding="utf-8",
    )

    with pytest.raises(AnalyticsDatasetImportError, match="behavior_type"):
        _read_behavior_csv(csv_path)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"dataset_id": "retail-demo-p31"}, "project_id"),
        (valid_import_payload(project_id="bad/id"), "project_id"),
        (valid_import_payload(idempotency_key=None), "idempotency_key"),
        (valid_import_payload(dataset_id="bad/id"), "dataset_id"),
        (valid_import_payload(users=0), "users"),
        (valid_import_payload(items=5_001), "items"),
        (valid_import_payload(days=181), "days"),
        (valid_import_payload(end_day="2025/12/03"), "end_day"),
    ],
)
def test_validate_import_request_rejects_unsafe_or_oversized_input(
    payload: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(AnalyticsDatasetImportError, match=message):
        validate_import_request(payload)
