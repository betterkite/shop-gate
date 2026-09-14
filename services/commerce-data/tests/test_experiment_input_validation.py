"""真实价格实验 CSV 输入契约的纯函数校验。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from shopgate_commerce_data import import_cli
from shopgate_commerce_data.import_cli import validate_price_experiment_csv_files

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
