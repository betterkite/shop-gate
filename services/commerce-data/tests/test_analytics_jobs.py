"""P31 Web 数据集导入参数与任务契约单测。"""

from __future__ import annotations

import pytest

from shopgate_commerce_data.analytics_jobs import (
    AnalyticsDatasetImportError,
    validate_import_request,
)


def test_validate_import_request_normalises_defaults() -> None:
    result = validate_import_request({"dataset_id": "retail-demo-p31"})

    assert result == {
        "dataset_id": "retail-demo-p31",
        "users": 1_000,
        "items": 1_000,
        "days": 30,
        "seed": 20251203,
        "end_day": "2025-12-03",
    }


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"dataset_id": "bad/id"}, "dataset_id"),
        ({"dataset_id": "retail-demo-p31", "users": 0}, "users"),
        ({"dataset_id": "retail-demo-p31", "items": 5_001}, "items"),
        ({"dataset_id": "retail-demo-p31", "days": 181}, "days"),
        ({"dataset_id": "retail-demo-p31", "end_day": "2025/12/03"}, "end_day"),
    ],
)
def test_validate_import_request_rejects_unsafe_or_oversized_input(
    payload: dict[str, object], message: str,
) -> None:
    with pytest.raises(AnalyticsDatasetImportError, match=message):
        validate_import_request(payload)
