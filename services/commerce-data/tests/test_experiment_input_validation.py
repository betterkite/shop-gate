"""真实价格实验 CSV 输入契约的纯函数校验。"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

from shopgate_commerce_data import import_cli
from shopgate_commerce_data.import_cli import (
    import_observed_price_experiment_csv,
    validate_price_experiment_csv_files,
)

ASSIGNMENT_HEADER = (
    "experiment_id,user_id,variant,assigned_at,allocation_method\n"
)
OBSERVATION_HEADER = (
    "experiment_id,observation_date,item_id,variant,selling_price,"
    "exposed_users,purchasers,units,assignment_unit,allocation_method\n"
)


def _write_valid_files(tmp_path: Path) -> tuple[Path, Path]:
    assignments = tmp_path / "assignments.csv"
    assignments.write_text(
        ASSIGNMENT_HEADER
        + "exp-1,101,control,2026-09-01T09:00:00Z,hash_user_id\n"
        + "exp-1,102,treatment,2026-09-01T09:00:00Z,hash_user_id\n",
        encoding="utf8",
    )
    observations = tmp_path / "observations.csv"
    observations.write_text(
        OBSERVATION_HEADER
        + "exp-1,2026-09-01,1001,control,99.00,1,0,0,user,hash_user_id\n"
        + "exp-1,2026-09-01,1001,treatment,89.00,1,1,1,user,hash_user_id\n",
        encoding="utf8",
    )
    return assignments, observations


def test_valid_price_experiment_files_produce_observed_report(tmp_path: Path) -> None:
    assignments, observations = _write_valid_files(tmp_path)

    result = validate_price_experiment_csv_files(assignments, observations)

    assert result["valid"] is True
    assert result["source_kind"] == "observed"
    assert result["synthetic"] is False
    assert result["causal_claim"] == "not_verified"
    assert result["assignment_rows"] == 2
    assert result["observation_rows"] == 2
    assert result["experiments"] == [
        {
            "experiment_id": "exp-1",
            "assignment_rows": 2,
            "assigned_users": 2,
            "control_assigned_users": 1,
            "treatment_assigned_users": 1,
            "observation_rows": 2,
            "observation_days": 1,
            "observed_items": 1,
        }
    ]


def test_invalid_price_experiment_files_report_contract_errors(tmp_path: Path) -> None:
    assignments, observations = _write_valid_files(tmp_path)
    assignments.write_text(
        ASSIGNMENT_HEADER
        + "exp-1,101,control,2026-09-01T09:00:00Z,hash_user_id\n"
        + "exp-1,101,treatment,2026-09-01T09:00:00Z,hash_user_id\n",
        encoding="utf8",
    )
    observations.write_text(
        OBSERVATION_HEADER
        + "exp-1,2026-09-01,1001,control,99.00,1,2,1,user,hash_user_id\n"
        + "exp-1,2026-09-01,1001,treatment,89.00,1,1,1,session,hash_user_id\n",
        encoding="utf8",
    )

    result = validate_price_experiment_csv_files(assignments, observations)

    assert result["valid"] is False
    assert any("被重复分组" in error for error in result["errors"])
    assert any("purchasers 不能大于 exposed_users" in error for error in result["errors"])
    assert any("assignment_unit 必须是 user" in error for error in result["errors"])


def test_missing_variant_and_header_are_rejected(tmp_path: Path) -> None:
    assignments = tmp_path / "assignments.csv"
    assignments.write_text(
        "experiment_id,user_id,variant,assigned_at\n"
        "exp-1,101,control,2026-09-01T09:00:00Z\n",
        encoding="utf8",
    )
    observations = tmp_path / "observations.csv"
    observations.write_text(
        OBSERVATION_HEADER
        + "exp-1,2026-09-01,1001,control,99.00,10,1,1,user,hash_user_id\n",
        encoding="utf8",
    )

    result = validate_price_experiment_csv_files(assignments, observations)

    assert result["valid"] is False
    assert any("表头必须严格" in error for error in result["errors"])
    assert any("必须同时包含 control 和 treatment" in error for error in result["errors"])


def test_validation_cli_is_read_only_and_does_not_open_database(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    assignments, observations = _write_valid_files(tmp_path)
    monkeypatch.setattr(sys, "argv", [
        "shopgate-commerce-import",
        "validate-price-experiment-csv",
        "--assignments",
        str(assignments),
        "--observations",
        str(observations),
    ])

    def fail_if_database_is_opened():
        raise AssertionError("只读校验不应连接数据库")

    monkeypatch.setattr(import_cli, "_connect", fail_if_database_is_opened)
    import_cli.main()

    report = json.loads(capsys.readouterr().out)
    assert report["valid"] is True
    assert report["source_kind"] == "observed"


class _FakeCursor:
    def __init__(self, contract, existing_items):
        self.contract = contract
        self.existing_items = existing_items
        self.statements: list[tuple[str, object]] = []
        self._fetchone_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params=()):
        self.statements.append((query, params))

    def executemany(self, query, params):
        self.statements.append((query, list(params)))

    def fetchone(self):
        self._fetchone_calls += 1
        if self._fetchone_calls == 1:
            return self.contract
        return {"assignment_rows": 2, "observation_rows": 2}

    def fetchall(self):
        return [{"item_id": item_id} for item_id in self.existing_items]


class _FakeConnection:
    def __init__(self, contract, existing_items):
        self.cursor_instance = _FakeCursor(contract, existing_items)

    def cursor(self):
        return self.cursor_instance


def test_import_is_idempotent_and_updates_mixed_contract(tmp_path: Path) -> None:
    assignments, observations = _write_valid_files(tmp_path)
    contract = {
        "source_kind": "synthetic",
        "source_name": "synthetic_analytics",
        "window_start": date(2026, 9, 1),
        "window_end": date(2026, 9, 7),
        "row_counts": {
            "price_experiment_assignments": 2,
            "price_experiment_observations": 2,
        },
        "limitations": [],
        "generation_rule": "seeded demo",
    }
    connection = _FakeConnection(contract, [1001])

    result = import_observed_price_experiment_csv(
        connection,
        "retail-demo",
        assignments,
        observations,
        source="store-platform",
    )

    assert result["valid"] is True
    assert result["imported"] is True
    assert result["dataset_source_kind"] == "mixed"
    assert result["replaced_experiment_ids"] == ["exp-1"]
    assert any("DELETE FROM commerce.dataset_price_experiment_assignments" in query
               for query, _ in connection.cursor_instance.statements)
    assert any("INSERT INTO commerce.dataset_price_experiment_observations" in query
               for query, _ in connection.cursor_instance.statements)


def test_import_rejects_missing_item_before_mutation(tmp_path: Path) -> None:
    assignments, observations = _write_valid_files(tmp_path)
    contract = {
        "source_kind": "synthetic",
        "source_name": "synthetic_analytics",
        "window_start": date(2026, 9, 1),
        "window_end": date(2026, 9, 7),
        "row_counts": {},
        "limitations": [],
        "generation_rule": "seeded demo",
    }
    connection = _FakeConnection(contract, [])

    result = import_observed_price_experiment_csv(
        connection,
        "retail-demo",
        assignments,
        observations,
    )

    assert result["valid"] is False
    assert any("缺少商品 ID" in error for error in result["errors"])
    assert not any("DELETE FROM" in query for query, _ in connection.cursor_instance.statements)
