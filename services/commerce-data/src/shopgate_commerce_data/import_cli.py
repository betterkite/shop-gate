"""Shop Gate 零售数据导入 CLI（PRD §5，console 脚本 ``shopgate-commerce-import``）。

子命令：

- ``import-userbehavior``：读取天池 UserBehavior CSV，抽样 N 个用户全量行为入库；
- ``generate-synthetic-behavior``：无 CSV 时的合成行为流兜底（source='synthetic'）；
- ``generate-synthetic-master``：按事件流 DISTINCT (item_id, category_id) 生成合成主数据；
- ``aggregate-daily``：生成商品/类目日聚合（GMV = buy × 合成价格）。

所有命令可重复执行前的重跑语义：行为导入用 ``TRUNCATE`` 清空后整批写入
（本地单数据源口径）；主数据与聚合用幂等 upsert / 重建。
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from shopgate_commerce_data.database_core import database_url_from_env
from shopgate_commerce_data.synthetic import (
    DEFAULT_ANALYTICS_DATASET_ID,
    DEFAULT_ITEM_POOL_SIZE,
    batched_events,
    synthetic_analytics_dataset,
    synthetic_behavior_events,
    synthetic_master_rows,
)

EVENT_COLUMNS = ("user_id", "item_id", "category_id", "behavior_type", "timestamp")
VALID_BEHAVIORS = {"pv", "fav", "cart", "buy"}
PRICE_EXPERIMENT_ASSIGNMENT_COLUMNS = (
    "experiment_id",
    "user_id",
    "variant",
    "assigned_at",
    "allocation_method",
)
PRICE_EXPERIMENT_OBSERVATION_COLUMNS = (
    "experiment_id",
    "observation_date",
    "item_id",
    "variant",
    "selling_price",
    "exposed_users",
    "purchasers",
    "units",
    "assignment_unit",
    "allocation_method",
)
PRICE_EXPERIMENT_OUTCOME_COLUMNS = (
    "experiment_id",
    "user_id",
    "outcome_date",
    "variant",
    "purchased",
    "units",
)
EXPERIMENT_VARIANTS = {"control", "treatment"}


def _read_contract_csv(
    csv_path: Path,
    expected_columns: tuple[str, ...],
    row_parser,
) -> tuple[list[dict[str, Any]], list[str]]:
    """读取固定列 CSV；只负责结构和类型解析，不写入数据库。"""

    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    if not csv_path.is_file():
        return rows, [f"文件不存在：{csv_path}"]
    try:
        handle = csv_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as error:
        return rows, [f"无法读取文件 {csv_path}：{error}"]
    with handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header is None:
            return rows, [f"CSV 为空：{csv_path}"]
        if tuple(column.strip() for column in header) != expected_columns:
            return rows, [
                f"{csv_path} 表头必须严格为 {list(expected_columns)}，实际为 {header}"
            ]
        for line_number, values in enumerate(reader, start=2):
            if not values or all(not value.strip() for value in values):
                continue
            if len(values) != len(expected_columns):
                errors.append(
                    f"{csv_path} 第 {line_number} 行列数为 {len(values)}，"
                    f"应为 {len(expected_columns)}"
                )
                continue
            try:
                rows.append(row_parser(values, line_number))
            except ValueError as error:
                errors.append(f"{csv_path} 第 {line_number} 行：{error}")
    return rows, errors


def _required_text(value: str, field: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field} 不能为空")
    return cleaned


def _positive_int(value: str, field: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as error:
        raise ValueError(f"{field} 必须是整数") from error
    if parsed <= 0:
        raise ValueError(f"{field} 必须大于 0")
    return parsed


def _nonnegative_int(value: str, field: str) -> int:
    try:
        parsed = int(value.strip())
    except ValueError as error:
        raise ValueError(f"{field} 必须是整数") from error
    if parsed < 0:
        raise ValueError(f"{field} 不能小于 0")
    return parsed


def _nonnegative_decimal(value: str, field: str) -> Decimal:
    try:
        parsed = Decimal(value.strip())
    except InvalidOperation as error:
        raise ValueError(f"{field} 必须是数字") from error
    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{field} 不能小于 0 且必须是有限数字")
    return parsed


def _parse_assignment_row(values: list[str], _line_number: int) -> dict[str, Any]:
    variant = _required_text(values[2], "variant")
    if variant not in EXPERIMENT_VARIANTS:
        raise ValueError("variant 只能是 control 或 treatment")
    try:
        assigned_at = datetime.fromisoformat(values[3].strip().replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("assigned_at 必须是 ISO 8601 日期时间") from error
    if assigned_at.tzinfo is None:
        raise ValueError("assigned_at 必须包含时区")
    return {
        "experiment_id": _required_text(values[0], "experiment_id"),
        "user_id": _positive_int(values[1], "user_id"),
        "variant": variant,
        "assigned_at": assigned_at,
        "allocation_method": _required_text(values[4], "allocation_method"),
    }


def _parse_observation_row(values: list[str], _line_number: int) -> dict[str, Any]:
    variant = _required_text(values[3], "variant")
    if variant not in EXPERIMENT_VARIANTS:
        raise ValueError("variant 只能是 control 或 treatment")
    try:
        observation_date = date.fromisoformat(values[1].strip())
    except ValueError as error:
        raise ValueError("observation_date 必须是 YYYY-MM-DD") from error
    assignment_unit = _required_text(values[8], "assignment_unit")
    if assignment_unit != "user":
        raise ValueError("assignment_unit 必须是 user，才能与用户分组证据对应")
    exposed_users = _nonnegative_int(values[5], "exposed_users")
    purchasers = _nonnegative_int(values[6], "purchasers")
    units = _nonnegative_int(values[7], "units")
    if purchasers > exposed_users:
        raise ValueError("purchasers 不能大于 exposed_users")
    if units < purchasers:
        raise ValueError("units 不能小于 purchasers")
    return {
        "experiment_id": _required_text(values[0], "experiment_id"),
        "observation_date": observation_date,
        "item_id": _positive_int(values[2], "item_id"),
        "variant": variant,
        "selling_price": _nonnegative_decimal(values[4], "selling_price"),
        "exposed_users": exposed_users,
        "purchasers": purchasers,
        "units": units,
        "assignment_unit": assignment_unit,
        "allocation_method": _required_text(values[9], "allocation_method"),
    }


def _parse_outcome_row(values: list[str], _line_number: int) -> dict[str, Any]:
    variant = _required_text(values[3], "variant")
    if variant not in EXPERIMENT_VARIANTS:
        raise ValueError("variant 只能是 control 或 treatment")
    try:
        outcome_date = date.fromisoformat(values[2].strip())
    except ValueError as error:
        raise ValueError("outcome_date 必须是 YYYY-MM-DD") from error
    purchased = _nonnegative_int(values[4], "purchased")
    if purchased not in {0, 1}:
        raise ValueError("purchased 只能是 0 或 1")
    units = _nonnegative_int(values[5], "units")
    if (purchased == 0 and units != 0) or (purchased == 1 and units < 1):
        raise ValueError("purchased=0 时 units 必须为 0，purchased=1 时 units 至少为 1")
    return {
        "experiment_id": _required_text(values[0], "experiment_id"),
        "user_id": _positive_int(values[1], "user_id"),
        "outcome_date": outcome_date,
        "variant": variant,
        "purchased": purchased,
        "units": units,
    }


def read_price_experiment_assignments_csv(
    csv_path: Path,
) -> tuple[list[dict[str, Any]], list[str]]:
    """读取用户分组文件，返回解析行和可展示的校验错误。"""

    return _read_contract_csv(
        csv_path, PRICE_EXPERIMENT_ASSIGNMENT_COLUMNS, _parse_assignment_row
    )


def read_price_experiment_observations_csv(
    csv_path: Path,
) -> tuple[list[dict[str, Any]], list[str]]:
    """读取价格实验汇总观察文件，返回解析行和可展示的校验错误。"""

    return _read_contract_csv(
        csv_path, PRICE_EXPERIMENT_OBSERVATION_COLUMNS, _parse_observation_row
    )


def read_price_experiment_outcomes_csv(
    csv_path: Path,
) -> tuple[list[dict[str, Any]], list[str]]:
    """读取用户级实验结果文件，返回解析行和可展示的校验错误。"""

    return _read_contract_csv(
        csv_path, PRICE_EXPERIMENT_OUTCOME_COLUMNS, _parse_outcome_row
    )


def validate_price_experiment_csv_files(
    assignments_path: Path,
    observations_path: Path,
    *,
    outcomes_path: Path | None = None,
    source: str = "observed_price_experiment_csv",
) -> dict[str, Any]:
    """校验真实实验输入契约；该函数只读文件，不连接数据库、不写业务表。"""

    assignments, errors = read_price_experiment_assignments_csv(assignments_path)
    observations, observation_errors = read_price_experiment_observations_csv(
        observations_path
    )
    errors.extend(observation_errors)
    outcomes: list[dict[str, Any]] = []
    if outcomes_path is not None:
        outcomes, outcome_errors = read_price_experiment_outcomes_csv(outcomes_path)
        errors.extend(outcome_errors)
    warnings: list[str] = []
    assignment_by_experiment: dict[str, list[dict[str, Any]]] = {}
    observation_by_experiment: dict[str, list[dict[str, Any]]] = {}
    outcome_by_experiment: dict[str, list[dict[str, Any]]] = {}
    for row in assignments:
        assignment_by_experiment.setdefault(row["experiment_id"], []).append(row)
    for row in observations:
        observation_by_experiment.setdefault(row["experiment_id"], []).append(row)
    for row in outcomes:
        outcome_by_experiment.setdefault(row["experiment_id"], []).append(row)

    assignment_keys: set[tuple[str, int]] = set()
    for row in assignments:
        key = (row["experiment_id"], row["user_id"])
        if key in assignment_keys:
            errors.append(
                f"实验 {row['experiment_id']} 中 user_id={row['user_id']} 被重复分组"
            )
        assignment_keys.add(key)
    observation_keys: set[tuple[str, date, int, str]] = set()
    for row in observations:
        key = (
            row["experiment_id"],
            row["observation_date"],
            row["item_id"],
            row["variant"],
        )
        if key in observation_keys:
            errors.append(
                "实验观察行重复："
                f"{row['experiment_id']}/{row['observation_date']}/{row['item_id']}/{row['variant']}"
            )
        observation_keys.add(key)
    outcome_keys: set[tuple[str, int]] = set()
    assignment_by_key = {
        (row["experiment_id"], row["user_id"]): row["variant"] for row in assignments
    }
    for row in outcomes:
        key = (row["experiment_id"], row["user_id"])
        if key in outcome_keys:
            errors.append(
                f"实验 {row['experiment_id']} 中 user_id={row['user_id']} 的结果重复"
            )
        outcome_keys.add(key)
        assigned_variant = assignment_by_key.get(key)
        if assigned_variant is None:
            errors.append(
                f"实验 {row['experiment_id']} 的结果用户 user_id={row['user_id']} 没有分组记录"
            )
        elif assigned_variant != row["variant"]:
            errors.append(
                f"实验 {row['experiment_id']} 的 user_id={row['user_id']} 结果分组与分配不一致"
            )

    assignment_experiments = set(assignment_by_experiment)
    observation_experiments = set(observation_by_experiment)
    if assignment_experiments != observation_experiments:
        missing_observations = sorted(assignment_experiments - observation_experiments)
        missing_assignments = sorted(observation_experiments - assignment_experiments)
        if missing_observations:
            errors.append(f"实验缺少观察数据：{missing_observations}")
        if missing_assignments:
            errors.append(f"实验缺少用户分组数据：{missing_assignments}")
    if outcomes_path is not None and assignment_experiments != set(outcome_by_experiment):
        missing_outcomes = sorted(assignment_experiments - set(outcome_by_experiment))
        extra_outcomes = sorted(set(outcome_by_experiment) - assignment_experiments)
        if missing_outcomes:
            errors.append(f"实验缺少用户结果数据：{missing_outcomes}")
        if extra_outcomes:
            errors.append(f"用户结果包含未分配的实验：{extra_outcomes}")

    experiments: list[dict[str, Any]] = []
    for experiment_id in sorted(assignment_experiments | observation_experiments):
        experiment_assignments = assignment_by_experiment.get(experiment_id, [])
        experiment_observations = observation_by_experiment.get(experiment_id, [])
        assignment_variants = {row["variant"] for row in experiment_assignments}
        observation_variants = {row["variant"] for row in experiment_observations}
        if assignment_variants != EXPERIMENT_VARIANTS:
            errors.append(f"实验 {experiment_id} 的用户分组必须同时包含 control 和 treatment")
        if observation_variants != EXPERIMENT_VARIANTS:
            errors.append(f"实验 {experiment_id} 的观察数据必须同时包含 control 和 treatment")
        experiment_outcomes = outcome_by_experiment.get(experiment_id, [])
        if outcomes_path is not None:
            assignment_users = {
                row["user_id"] for row in experiment_assignments
            }
            outcome_users = {row["user_id"] for row in experiment_outcomes}
            missing_users = sorted(assignment_users - outcome_users)
            if missing_users:
                errors.append(
                    f"实验 {experiment_id} 缺少用户结果：{missing_users[:20]}"
                    + ("（其余省略）" if len(missing_users) > 20 else "")
                )
        allocation_methods = {
            row["allocation_method"]
            for row in experiment_assignments + experiment_observations
        }
        if len(allocation_methods) > 1:
            warnings.append(
                f"实验 {experiment_id} 同时出现多个 allocation_method：{sorted(allocation_methods)}"
            )
        experiments.append(
            {
                "experiment_id": experiment_id,
                "assignment_rows": len(experiment_assignments),
                "assigned_users": len(
                    {(row["experiment_id"], row["user_id"]) for row in experiment_assignments}
                ),
                "control_assigned_users": sum(
                    row["variant"] == "control" for row in experiment_assignments
                ),
                "treatment_assigned_users": sum(
                    row["variant"] == "treatment" for row in experiment_assignments
                ),
                "observation_rows": len(experiment_observations),
                "observation_days": len(
                    {row["observation_date"] for row in experiment_observations}
                ),
                "observed_items": len({row["item_id"] for row in experiment_observations}),
                "outcome_rows": len(experiment_outcomes),
                "outcome_users": len({row["user_id"] for row in experiment_outcomes}),
            }
        )

    return {
        "valid": not errors and bool(experiments),
        "contract_version": "p28-price-experiment-input-v1",
        "source_kind": "observed",
        "source": source,
        "synthetic": False,
        "causal_claim": "not_verified",
        "assignment_rows": len(assignments),
        "observation_rows": len(observations),
        "outcome_rows": len(outcomes),
        "outcome_status": (
            "complete" if outcomes_path is not None and not errors else
            "invalid" if outcomes_path is not None else
            "not_provided"
        ),
        "experiment_count": len(experiments),
        "experiments": experiments,
        "warnings": sorted(set(warnings)),
        "errors": sorted(set(errors)),
    }


def import_observed_price_experiment_csv(
    connection: psycopg.Connection[dict[str, Any]],
    dataset_id: str,
    assignments_path: Path,
    observations_path: Path,
    *,
    outcomes_path: Path | None = None,
    source: str = "observed_price_experiment_csv",
) -> dict[str, Any]:
    """把通过校验的真实实验记录幂等写入已有数据集。

    该函数不提交事务；调用方需在质量扫描通过后统一 commit，任一错误都可由关闭连接回滚。
    """

    report = validate_price_experiment_csv_files(
        assignments_path,
        observations_path,
        outcomes_path=outcomes_path,
        source=source,
    )
    if not report["valid"]:
        return report

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT * FROM commerce.dataset_contracts WHERE dataset_id = %s FOR UPDATE",
            (dataset_id,),
        )
        contract = cursor.fetchone()
        if contract is None:
            report["valid"] = False
            report["errors"] = [f"目标数据集不存在：{dataset_id}"]
            return report

        observations, observation_errors = read_price_experiment_observations_csv(
            observations_path
        )
        assignments, assignment_errors = read_price_experiment_assignments_csv(
            assignments_path
        )
        outcomes: list[dict[str, Any]] = []
        outcome_errors: list[str] = []
        if outcomes_path is not None:
            outcomes, outcome_errors = read_price_experiment_outcomes_csv(outcomes_path)
        if observation_errors or assignment_errors or outcome_errors:
            report["valid"] = False
            report["errors"] = sorted(
                set(observation_errors + assignment_errors + outcome_errors)
            )
            return report
        window_start = contract["window_start"]
        window_end = contract["window_end"]
        outside_window = sorted({
            str(row["observation_date"])
            for row in observations
            if row["observation_date"] < window_start or row["observation_date"] > window_end
        })
        if outside_window:
            report["valid"] = False
            report["errors"] = [
                f"观察日期超出目标数据集窗口 {window_start} 至 {window_end}：{outside_window}"
            ]
            return report

        item_ids = sorted({int(row["item_id"]) for row in observations})
        cursor.execute(
            """
            SELECT item_id
            FROM commerce.dataset_item_economics
            WHERE dataset_id = %s AND item_id = ANY(%s)
            """,
            (dataset_id, item_ids),
        )
        existing_item_ids = {int(row["item_id"]) for row in cursor.fetchall()}
        missing_item_ids = sorted(set(item_ids) - existing_item_ids)
        if missing_item_ids:
            report["valid"] = False
            report["errors"] = [
                f"目标数据集缺少商品 ID：{missing_item_ids[:20]}"
                + ("（其余省略）" if len(missing_item_ids) > 20 else "")
            ]
            return report

        experiment_ids = sorted({
            str(row["experiment_id"])
            for row in report["experiments"]
        })
        if outcomes_path is None:
            cursor.execute(
                """
                SELECT COUNT(*) AS outcome_rows
                FROM commerce.dataset_price_experiment_outcomes
                WHERE dataset_id = %s AND experiment_id = ANY(%s)
                """,
                (dataset_id, experiment_ids),
            )
            existing_outcomes = int(cursor.fetchone()["outcome_rows"] or 0)
            if existing_outcomes:
                report["valid"] = False
                report["errors"] = [
                    "目标数据集已有用户级结果；重新导入该实验时必须同时提供 outcomes CSV"
                ]
                return report
        cursor.execute(
            """
            DELETE FROM commerce.dataset_price_experiment_assignments
            WHERE dataset_id = %s AND experiment_id = ANY(%s)
            """,
            (dataset_id, experiment_ids),
        )
        if outcomes_path is not None:
            cursor.execute(
                """
                DELETE FROM commerce.dataset_price_experiment_outcomes
                WHERE dataset_id = %s AND experiment_id = ANY(%s)
                """,
                (dataset_id, experiment_ids),
            )
        cursor.execute(
            """
            DELETE FROM commerce.dataset_price_experiment_observations
            WHERE dataset_id = %s AND experiment_id = ANY(%s)
            """,
            (dataset_id, experiment_ids),
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_price_experiment_assignments
              (dataset_id, experiment_id, user_id, variant, assigned_at,
               allocation_method, source, synthetic)
            VALUES (%s, %s, %s, %s, %s, %s, %s, false)
            """,
            [
                (
                    dataset_id,
                    row["experiment_id"],
                    row["user_id"],
                    row["variant"],
                    row["assigned_at"],
                    row["allocation_method"],
                    source,
                )
                for row in assignments
            ],
        )
        if outcomes_path is not None:
            cursor.executemany(
                """
                INSERT INTO commerce.dataset_price_experiment_outcomes
                  (dataset_id, experiment_id, user_id, outcome_date, variant,
                   purchased, units, source, synthetic)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, false)
                """,
                [
                    (
                        dataset_id,
                        row["experiment_id"],
                        row["user_id"],
                        row["outcome_date"],
                        row["variant"],
                        row["purchased"],
                        row["units"],
                        source,
                    )
                    for row in outcomes
                ],
            )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_price_experiment_observations
              (dataset_id, experiment_id, observation_date, item_id, variant,
               selling_price, exposed_users, purchasers, units, assignment_unit,
               allocation_method, source, synthetic)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, false)
            """,
            [
                (
                    dataset_id,
                    row["experiment_id"],
                    row["observation_date"],
                    row["item_id"],
                    row["variant"],
                    row["selling_price"],
                    row["exposed_users"],
                    row["purchasers"],
                    row["units"],
                    row["assignment_unit"],
                    row["allocation_method"],
                    source,
                )
                for row in observations
            ],
        )

        cursor.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM commerce.dataset_price_experiment_assignments
               WHERE dataset_id = %s) AS assignment_rows,
              (SELECT COUNT(*) FROM commerce.dataset_price_experiment_observations
               WHERE dataset_id = %s) AS observation_rows,
              (SELECT COUNT(*) FROM commerce.dataset_price_experiment_outcomes
               WHERE dataset_id = %s) AS outcome_rows
            """,
            (dataset_id, dataset_id, dataset_id),
        )
        counts = cursor.fetchone()
        row_counts = dict(contract["row_counts"] or {})
        row_counts["price_experiment_assignments"] = int(counts["assignment_rows"])
        row_counts["price_experiment_observations"] = int(counts["observation_rows"])
        if outcomes_path is not None:
            row_counts["price_experiment_outcomes"] = int(counts["outcome_rows"])
        current_source_kind = str(contract["source_kind"])
        next_source_kind = (
            "mixed" if current_source_kind in {"synthetic", "mixed"} else "observed"
        )
        limitations = list(contract["limitations"] or [])
        imported_limitation = (
            f"已导入真实实验文件来源 {source}；分组记录仍需结合实验平台规则核对，"
            "不能仅凭文件结构证明随机化或因果关系"
        )
        if imported_limitation not in limitations:
            limitations.append(imported_limitation)
        generation_rule = str(contract["generation_rule"])
        provenance_note = f"真实实验来源 {source} 已按 Issue #48 导入并覆盖同名 experiment_id。"
        if provenance_note not in generation_rule:
            generation_rule = f"{generation_rule} {provenance_note}"
        cursor.execute(
            """
            UPDATE commerce.dataset_contracts
            SET source_kind = %s,
                row_counts = %s,
                limitations = %s,
                generation_rule = %s
            WHERE dataset_id = %s
            """,
            (
                next_source_kind,
                Jsonb(row_counts),
                Jsonb(limitations),
                generation_rule,
                dataset_id,
            ),
        )

    report["dataset_id"] = dataset_id
    report["imported"] = True
    report["replaced_experiment_ids"] = experiment_ids
    report["dataset_source_kind"] = next_source_kind
    report["dataset_row_counts"] = row_counts
    return report


def shift_target_end(anchor_end: str, time_shift: str):
    """计算平移目标窗口末日。

    ``last-week``：最近一个完整周（上周一 ~ 上周日）；
    ``none``：保持 anchor_end 原样。
    """

    anchor = date.fromisoformat(anchor_end)
    if time_shift != "last-week":
        return anchor
    today = date.today()
    days_since_monday = today.weekday()
    this_monday = today - timedelta(days=days_since_monday)
    last_monday = this_monday - timedelta(days=7)
    return last_monday + timedelta(days=6)


def compute_time_shift_days(anchor_end: str, time_shift: str):
    """返回平移天数（time_shift=none 时为 None）。"""

    if time_shift != "last-week":
        return None
    target_end = shift_target_end(anchor_end, time_shift)
    anchor = date.fromisoformat(anchor_end)
    return (target_end - anchor).days


def _connect() -> psycopg.Connection[dict[str, Any]]:
    return psycopg.connect(
        database_url_from_env(),
        row_factory=dict_row,
        autocommit=False,
    )


def _shift_event_timestamps(
    events: Iterator[dict[str, Any]],
    shift_days: int | None,
) -> Iterator[dict[str, Any]]:
    """按需平移事件时间戳（PRD 演示口径：窗口平移到最近完整周）。"""

    if not shift_days:
        yield from events
        return
    for event in events:
        event["event_ts"] = event["event_ts"] + timedelta(days=shift_days)
        yield event


def _register_ingestion_job(
    connection: psycopg.Connection[dict[str, Any]],
    *,
    provider: str,
    rows_received: int,
    metadata: dict[str, Any],
) -> str:
    job_id = f"import-{provider}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}"
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO commerce.market_data_ingestion_jobs
              (id, provider, timeframe, adjustment, status, total_symbols,
               completed_symbols, rows_received, rows_upserted, metadata,
               started_at, completed_at)
            VALUES (%s, %s, 'daily', 'none', 'completed', 1, 1, %s, %s, %s,
                    now(), now())
            """,
            (job_id, provider, rows_received, rows_received, Jsonb(metadata)),
        )
        cursor.execute(
            """
            INSERT INTO commerce.market_data_sync_state
              (symbol, timeframe, adjustment, provider, last_success_at, metadata)
            VALUES (%s, 'daily', 'none', %s, now(), %s)
            ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE
            SET last_success_at = now(), metadata = EXCLUDED.metadata
            """,
            (f"dataset:{provider}", provider, Jsonb(metadata)),
        )
    return job_id


def _insert_events(
    connection: psycopg.Connection[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> None:
    with connection.cursor() as cursor, cursor.copy(
        """
            COPY commerce.user_behavior_events
              (user_id, item_id, category_id, behavior_type, event_ts, source)
            FROM STDIN
            """
    ) as copy:
        for row in rows:
            copy.write_row(
                (
                    row["user_id"],
                    row["item_id"],
                    row["category_id"],
                    row["behavior_type"],
                    row["event_ts"],
                    row.get("source", "tianchi_userbehavior"),
                )
            )


def scan_userbehavior_csv(
    csv_path: Path,
) -> tuple[int, set[int]]:
    """第一遍扫描：统计行数并收集用户集合（全量 1 亿行也只留用户 ID 集合）。"""

    user_ids: set[int] = set()
    row_count = 0
    with csv_path.open("r", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header is not None and [column.strip() for column in header] != list(
            EVENT_COLUMNS
        ):
            raise SystemExit(
                f"CSV 列必须严格为 {list(EVENT_COLUMNS)}，实际为 {header}"
            )
        for line_number, row in enumerate(reader, start=2):
            if not row or all(not cell.strip() for cell in row):
                continue
            if len(row) != 5:
                raise SystemExit(f"第 {line_number} 行列数不是 5：{row}")
            behavior_type = row[3].strip()
            if behavior_type not in VALID_BEHAVIORS:
                raise SystemExit(
                    f"第 {line_number} 行 behavior_type 非法：{behavior_type}"
                )
            int(row[0].strip())
            int(row[1].strip())
            int(row[2].strip())
            int(row[4].strip())
            user_ids.add(int(row[0].strip()))
            row_count += 1
    if row_count == 0:
        raise SystemExit("CSV 中没有可导入的事件行")
    return row_count, user_ids


def iter_userbehavior_events(
    csv_path: Path,
    sampled_users: set[int],
) -> Iterator[dict[str, Any]]:
    """第二遍流式读取：只产出被抽样用户的事件（不整表进内存）。"""

    with csv_path.open("r", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        next(reader, None)
        for row in reader:
            if not row or all(not cell.strip() for cell in row):
                continue
            user_id = int(row[0].strip())
            if user_id not in sampled_users:
                continue
            yield {
                "user_id": user_id,
                "item_id": int(row[1].strip()),
                "category_id": int(row[2].strip()),
                "behavior_type": row[3].strip(),
                "event_ts": datetime.fromtimestamp(int(row[4].strip()), tz=UTC),
                "source": "tianchi_userbehavior",
            }


def import_events(
    connection: psycopg.Connection[dict[str, Any]],
    events: Iterator[dict[str, Any]],
    *,
    provider: str,
    meta: dict[str, Any],
    batch_size: int,
) -> None:
    _truncate_events(connection)
    inserted = 0
    for batch in batched_events(events, batch_size):
        _insert_events(connection, batch)
        inserted += len(batch)
        if inserted % (batch_size * 10) == 0:
            print(f"[import] 已写入 {inserted}", flush=True)
    job_id = _register_ingestion_job(
        connection,
        provider=provider,
        rows_received=inserted,
        metadata=meta,
    )
    connection.commit()
    print(f"[import] 完成：job={job_id} rows={inserted}")


def _truncate_events(connection: psycopg.Connection[dict[str, Any]]) -> None:
    with connection.cursor() as cursor:
        cursor.execute("TRUNCATE commerce.user_behavior_events")
        cursor.execute("TRUNCATE commerce.daily_item_metrics")
        cursor.execute("TRUNCATE commerce.daily_category_metrics")


def derive_item_category(
    connection: psycopg.Connection[dict[str, Any]],
) -> dict[int, int]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT item_id, category_id FROM commerce.user_behavior_events"
        )
        mapping = {row["item_id"]: row["category_id"] for row in cursor.fetchall()}
    if not mapping:
        raise SystemExit("事件表为空：先导入行为数据再生成主数据")
    return mapping


def upsert_master_rows(
    connection: psycopg.Connection[dict[str, Any]],
    master: dict[str, list[dict[str, Any]]],
) -> None:
    with connection.cursor() as cursor:
        item_ids = [int(item["item_id"]) for item in master["items"]]
        if item_ids:
            # 主数据由当前行为流派生。只 upsert 不会移除上一次数据源留下的
            # 商品，进而把库存健康分母和库存金额外推严重放大。
            cursor.execute(
                "DELETE FROM commerce.items WHERE NOT (item_id = ANY(%s))",
                (item_ids,),
            )
        cursor.executemany(
            """
            INSERT INTO commerce.categories (category_id, name, synthetic_name, parent_id)
            VALUES (%(category_id)s, %(name)s, %(synthetic_name)s, %(parent_id)s)
            ON CONFLICT (category_id) DO UPDATE
            SET name = EXCLUDED.name, synthetic_name = EXCLUDED.synthetic_name
            """,
            master["categories"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.brands (brand_id, name, synthetic)
            VALUES (%(brand_id)s, %(name)s, %(synthetic)s)
            ON CONFLICT (brand_id) DO UPDATE
            SET name = EXCLUDED.name, synthetic = EXCLUDED.synthetic
            """,
            master["brands"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.shops (shop_id, name, tier, synthetic)
            VALUES (%(shop_id)s, %(name)s, %(tier)s, %(synthetic)s)
            ON CONFLICT (shop_id) DO UPDATE
            SET name = EXCLUDED.name, tier = EXCLUDED.tier, synthetic = EXCLUDED.synthetic
            """,
            master["shops"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.items
              (item_id, category_id, title, brand_id, shop_id, price, stock,
               listed_at, synthetic_master)
            VALUES (%(item_id)s, %(category_id)s, %(title)s, %(brand_id)s,
                    %(shop_id)s, %(price)s, %(stock)s, %(listed_at)s,
                    %(synthetic_master)s)
            ON CONFLICT (item_id) DO UPDATE
            SET category_id = EXCLUDED.category_id, title = EXCLUDED.title,
                brand_id = EXCLUDED.brand_id, shop_id = EXCLUDED.shop_id,
                price = EXCLUDED.price, stock = EXCLUDED.stock,
                listed_at = EXCLUDED.listed_at,
                synthetic_master = EXCLUDED.synthetic_master
            """,
            master["items"],
        )
        cursor.execute(
            "DELETE FROM commerce.categories c WHERE NOT EXISTS "
            "(SELECT 1 FROM commerce.items i WHERE i.category_id = c.category_id)"
        )
        cursor.execute(
            "DELETE FROM commerce.brands b WHERE NOT EXISTS "
            "(SELECT 1 FROM commerce.items i WHERE i.brand_id = b.brand_id)"
        )
        cursor.execute(
            "DELETE FROM commerce.shops s WHERE NOT EXISTS "
            "(SELECT 1 FROM commerce.items i WHERE i.shop_id = s.shop_id)"
        )


def rebuild_daily_aggregates(connection: psycopg.Connection[dict[str, Any]]) -> int:
    with connection.cursor() as cursor:
        cursor.execute("TRUNCATE commerce.daily_item_metrics")
        cursor.execute("TRUNCATE commerce.daily_category_metrics")
        cursor.execute(
            """
            INSERT INTO commerce.daily_item_metrics
              (stat_date, item_id, category_id, pv, fav, cart, buy, gmv)
            SELECT
              e.event_ts::date,
              e.item_id,
              e.category_id,
              COUNT(*) FILTER (WHERE e.behavior_type = 'pv'),
              COUNT(*) FILTER (WHERE e.behavior_type = 'fav'),
              COUNT(*) FILTER (WHERE e.behavior_type = 'cart'),
              COUNT(*) FILTER (WHERE e.behavior_type = 'buy'),
              COALESCE(SUM(CASE WHEN e.behavior_type = 'buy' THEN i.price END), 0)
            FROM commerce.user_behavior_events e
            JOIN commerce.items i ON i.item_id = e.item_id
            GROUP BY 1, 2, 3
            """
        )
        cursor.execute(
            """
            INSERT INTO commerce.daily_category_metrics
              (stat_date, category_id, pv, fav, cart, buy, buyers, gmv)
            SELECT
              stat_date,
              category_id,
              SUM(pv),
              SUM(fav),
              SUM(cart),
              SUM(buy),
              0,
              SUM(gmv)
            FROM commerce.daily_item_metrics
            GROUP BY stat_date, category_id
            """
        )
        cursor.execute(
            """
            UPDATE commerce.daily_category_metrics m
            SET buyers = u.buyers
            FROM (
              SELECT event_ts::date AS stat_date, category_id,
                     COUNT(DISTINCT user_id) AS buyers
              FROM commerce.user_behavior_events
              WHERE behavior_type = 'buy'
              GROUP BY 1, 2
            ) u
            WHERE u.stat_date = m.stat_date AND u.category_id = m.category_id
            """
        )
        cursor.execute("SELECT COUNT(*) AS rows FROM commerce.daily_item_metrics")
        count = cursor.fetchone()["rows"] if cursor.description else 0
    return int(count or 0)


def replace_synthetic_analytics_dataset(
    connection: psycopg.Connection[dict[str, Any]],
    dataset: dict[str, Any],
) -> None:
    """幂等替换一个扩展演示数据集，其他 dataset_id 不受影响。"""

    contract = dataset["contract"]
    dataset_id = contract["dataset_id"]
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM commerce.dataset_contracts WHERE dataset_id = %s",
            (dataset_id,),
        )
        cursor.execute(
            """
            INSERT INTO commerce.dataset_contracts
              (dataset_id, version, source_kind, source_name, schema_version,
               window_start, window_end, generation_seed, row_counts,
               synthetic_fields, limitations, generation_rule)
            VALUES (%(dataset_id)s, %(version)s, %(source_kind)s, %(source_name)s,
                    %(schema_version)s, %(window_start)s, %(window_end)s,
                    %(generation_seed)s, %(row_counts)s, %(synthetic_fields)s,
                    %(limitations)s, %(generation_rule)s)
            """,
            {
                **contract,
                "row_counts": Jsonb(contract["row_counts"]),
                "synthetic_fields": Jsonb(contract["synthetic_fields"]),
                "limitations": Jsonb(contract["limitations"]),
            },
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_behavior_events
              (dataset_id, user_id, item_id, category_id, behavior_type,
               event_ts, source, synthetic)
            VALUES (%(dataset_id)s, %(user_id)s, %(item_id)s, %(category_id)s,
                    %(behavior_type)s, %(event_ts)s, %(source)s, %(synthetic)s)
            """,
            dataset["behavior_events"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_user_profiles
              (dataset_id, user_id, age_band, gender, city_tier, member_level,
               registered_at, source, synthetic)
            VALUES (%(dataset_id)s, %(user_id)s, %(age_band)s, %(gender)s,
                    %(city_tier)s, %(member_level)s, %(registered_at)s,
                    %(source)s, %(synthetic)s)
            """,
            dataset["profiles"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_channels
              (dataset_id, channel_id, name, channel_type, source, synthetic)
            VALUES (%(dataset_id)s, %(channel_id)s, %(name)s, %(channel_type)s,
                    %(source)s, %(synthetic)s)
            """,
            dataset["channels"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_campaigns
              (dataset_id, campaign_id, name, campaign_type, starts_at, ends_at,
               source, synthetic)
            VALUES (%(dataset_id)s, %(campaign_id)s, %(name)s, %(campaign_type)s,
                    %(starts_at)s, %(ends_at)s, %(source)s, %(synthetic)s)
            """,
            dataset["campaigns"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_sessions
              (dataset_id, session_id, user_id, started_at, ended_at, channel_id,
               campaign_id, source, synthetic)
            VALUES (%(dataset_id)s, %(session_id)s, %(user_id)s, %(started_at)s,
                    %(ended_at)s, %(channel_id)s, %(campaign_id)s, %(source)s,
                    %(synthetic)s)
            """,
            dataset["sessions"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_item_economics
              (dataset_id, item_id, category_id, list_price, cost_price,
               discount_rate, source, synthetic)
            VALUES (%(dataset_id)s, %(item_id)s, %(category_id)s, %(list_price)s,
                    %(cost_price)s, %(discount_rate)s, %(source)s, %(synthetic)s)
            """,
            dataset["item_economics"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_orders
              (dataset_id, order_id, user_id, item_id, session_id, channel_id,
               campaign_id, ordered_at, quantity, selling_price, discount_amount,
               refund_amount, payment_status, fulfillment_status, source, synthetic)
            VALUES (%(dataset_id)s, %(order_id)s, %(user_id)s, %(item_id)s,
                    %(session_id)s, %(channel_id)s, %(campaign_id)s, %(ordered_at)s,
                    %(quantity)s, %(selling_price)s, %(discount_amount)s,
                    %(refund_amount)s, %(payment_status)s, %(fulfillment_status)s,
                    %(source)s, %(synthetic)s)
            """,
            dataset["orders"],
        )
        price_experiment_observations = dataset.get("price_experiment_observations", [])
        if price_experiment_observations:
            cursor.executemany(
                """
                INSERT INTO commerce.dataset_price_experiment_observations
                  (dataset_id, experiment_id, observation_date, item_id, variant,
                   selling_price, exposed_users, purchasers, units, assignment_unit,
                   allocation_method, source, synthetic)
                VALUES (%(dataset_id)s, %(experiment_id)s, %(observation_date)s,
                        %(item_id)s, %(variant)s, %(selling_price)s, %(exposed_users)s,
                        %(purchasers)s, %(units)s, %(assignment_unit)s,
                        %(allocation_method)s, %(source)s, %(synthetic)s)
                """,
                price_experiment_observations,
            )
        price_experiment_assignments = dataset.get("price_experiment_assignments", [])
        if price_experiment_assignments:
            cursor.executemany(
                """
                INSERT INTO commerce.dataset_price_experiment_assignments
                  (dataset_id, experiment_id, user_id, variant, assigned_at,
                   allocation_method, source, synthetic)
                VALUES (%(dataset_id)s, %(experiment_id)s, %(user_id)s, %(variant)s,
                        %(assigned_at)s, %(allocation_method)s, %(source)s, %(synthetic)s)
                """,
                price_experiment_assignments,
            )
        cursor.executemany(
            """
            INSERT INTO commerce.dataset_inventory_snapshots
              (dataset_id, snapshot_date, item_id, opening_stock, inbound_qty,
               sold_qty, reserved_qty, closing_stock, source, synthetic)
            VALUES (%(dataset_id)s, %(snapshot_date)s, %(item_id)s,
                    %(opening_stock)s, %(inbound_qty)s, %(sold_qty)s,
                    %(reserved_qty)s, %(closing_stock)s, %(source)s, %(synthetic)s)
            """,
            dataset["inventories"],
        )


def scan_synthetic_analytics_dataset(
    connection: psycopg.Connection[dict[str, Any]],
    dataset_id: str,
) -> dict[str, Any]:
    """检查扩展数据集的契约行数、来源标记和关键关联，并写入质量扫描结果。"""

    table_counts = {
        "behavior_events": "dataset_behavior_events",
        "user_profiles": "dataset_user_profiles",
        "channels": "dataset_channels",
        "campaigns": "dataset_campaigns",
        "sessions": "dataset_sessions",
        "item_economics": "dataset_item_economics",
        "orders": "dataset_orders",
        "inventory_snapshots": "dataset_inventory_snapshots",
        "price_experiment_observations": "dataset_price_experiment_observations",
        "price_experiment_assignments": "dataset_price_experiment_assignments",
        "price_experiment_outcomes": "dataset_price_experiment_outcomes",
    }
    issues: list[str] = []
    metrics: dict[str, Any] = {}
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT * FROM commerce.dataset_contracts WHERE dataset_id = %s",
            (dataset_id,),
        )
        contract = cursor.fetchone()
        if contract is None:
            raise SystemExit(f"数据集不存在：{dataset_id}")
        expected_counts = contract["row_counts"] or {}
        for key, table in table_counts.items():
            if key not in expected_counts:
                # 兼容在价格实验表加入前生成的旧数据集契约。
                continue
            cursor.execute(
                f"SELECT COUNT(*) AS count FROM commerce.{table} WHERE dataset_id = %s",
                (dataset_id,),
            )
            actual = int(cursor.fetchone()["count"])
            expected = int(expected_counts.get(key, -1))
            metrics[f"{key}_rows"] = actual
            if actual != expected:
                issues.append(f"{table} 行数 {actual} 与契约 {expected} 不一致")

        marked_tables = tuple(
            (name, table) for name, table in table_counts.items() if name in expected_counts
        )
        for name, table in marked_tables:
            allow_observed = (
                name
                in {
                    "behavior_events",
                    "price_experiment_observations",
                    "price_experiment_assignments",
                    "price_experiment_outcomes",
                }
                and contract["source_kind"] != "synthetic"
            )
            cursor.execute(
                f"""
                SELECT COUNT(*) AS count
                FROM commerce.{table}
                WHERE dataset_id = %s
                  AND ((synthetic IS TRUE AND source <> %s)
                       OR (synthetic IS NOT TRUE AND %s = false))
                """,
                (dataset_id, contract["source_name"], allow_observed),
            )
            unmarked = int(cursor.fetchone()["count"])
            metrics[f"{table}_unmarked_rows"] = unmarked
            if unmarked:
                issues.append(f"{table} 有 {unmarked} 行来源或 synthetic 标记不符合契约")

        checks = {
            "orphan_orders": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_orders o
                LEFT JOIN commerce.dataset_sessions s
                  ON s.dataset_id = o.dataset_id AND s.session_id = o.session_id
                WHERE o.dataset_id = %s AND s.session_id IS NULL
            """,
            "orphan_order_items": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_orders o
                LEFT JOIN commerce.dataset_item_economics i
                  ON i.dataset_id = o.dataset_id AND i.item_id = o.item_id
                WHERE o.dataset_id = %s AND i.item_id IS NULL
            """,
            "negative_inventory": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_inventory_snapshots
                WHERE dataset_id = %s
                  AND (opening_stock < 0 OR inbound_qty < 0 OR sold_qty < 0
                       OR reserved_qty < 0 OR closing_stock < 0)
            """,
            "invalid_inventory_rollforward": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_inventory_snapshots
                WHERE dataset_id = %s
                  AND closing_stock <> GREATEST(opening_stock + inbound_qty - sold_qty, 0)
            """,
            "invalid_economics": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_item_economics
                WHERE dataset_id = %s
                  AND (cost_price > list_price OR discount_rate < 0 OR discount_rate > 1)
            """,
            "duplicate_experiment_assignments": """
                SELECT COALESCE(SUM(assignment_rows - assigned_users), 0) AS count
                FROM (
                  SELECT experiment_id, COUNT(*) AS assignment_rows,
                         COUNT(DISTINCT user_id) AS assigned_users
                  FROM commerce.dataset_price_experiment_assignments
                  WHERE dataset_id = %s
                  GROUP BY experiment_id
                ) duplicates
            """,
            "experiment_assignments_without_both_variants": """
                SELECT COUNT(*) AS count
                FROM (
                  SELECT experiment_id,
                         COUNT(*) FILTER (WHERE variant = 'control') AS control_users,
                         COUNT(*) FILTER (WHERE variant = 'treatment') AS treatment_users
                  FROM commerce.dataset_price_experiment_assignments
                  WHERE dataset_id = %s
                  GROUP BY experiment_id
                ) variants
                WHERE control_users = 0 OR treatment_users = 0
            """,
            "orphan_experiment_outcomes": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_price_experiment_outcomes o
                LEFT JOIN commerce.dataset_price_experiment_assignments a
                  ON a.dataset_id = o.dataset_id
                 AND a.experiment_id = o.experiment_id
                 AND a.user_id = o.user_id
                WHERE o.dataset_id = %s AND a.user_id IS NULL
            """,
            "outcome_variant_mismatches": """
                SELECT COUNT(*) AS count
                FROM commerce.dataset_price_experiment_outcomes o
                JOIN commerce.dataset_price_experiment_assignments a
                  ON a.dataset_id = o.dataset_id
                 AND a.experiment_id = o.experiment_id
                 AND a.user_id = o.user_id
                WHERE o.dataset_id = %s AND o.variant <> a.variant
            """,
            "experiments_with_incomplete_outcomes": """
                SELECT COUNT(*) AS count
                FROM (
                  SELECT a.experiment_id,
                         COUNT(DISTINCT a.user_id) AS assigned_users,
                         COUNT(DISTINCT o.user_id) AS outcome_users
                  FROM commerce.dataset_price_experiment_assignments a
                  LEFT JOIN commerce.dataset_price_experiment_outcomes o
                    ON o.dataset_id = a.dataset_id
                   AND o.experiment_id = a.experiment_id
                   AND o.user_id = a.user_id
                  WHERE a.dataset_id = %s
                    AND EXISTS (
                      SELECT 1
                      FROM commerce.dataset_price_experiment_outcomes declared
                      WHERE declared.dataset_id = a.dataset_id
                        AND declared.experiment_id = a.experiment_id
                    )
                  GROUP BY a.experiment_id
                ) coverage
                WHERE assigned_users <> outcome_users
            """,
        }
        for name, query in checks.items():
            cursor.execute(query, (dataset_id,))
            count = int(cursor.fetchone()["count"])
            metrics[name] = count
            if count:
                issues.append(f"{name}={count}")

        checked_rows = sum(
            int(value) for key, value in metrics.items() if key.endswith("_rows")
        )
        scan_id = f"analytics-quality-{dataset_id}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}"
        severity = "ok" if not issues else "error"
        cursor.execute(
            """
            INSERT INTO commerce.data_quality_scans
              (id, universe_id, symbol, scope, timeframe, adjustment, status,
               severity, checked_symbols, passed_symbols, warning_symbols,
               failed_symbols, checked_rows, issue_count, issues, metrics,
               started_at, completed_at)
            VALUES (%s, %s, %s, 'analytics_dataset', 'daily', 'none', 'completed',
                    %s, 1, %s, 0, %s, %s, %s, %s, %s, now(), now())
            """,
            (
                scan_id,
                dataset_id,
                dataset_id,
                severity,
                1 if not issues else 0,
                0 if not issues else 1,
                checked_rows,
                len(issues),
                Jsonb(issues),
                Jsonb(metrics),
            ),
        )
    return {
        "id": scan_id,
        "dataset_id": dataset_id,
        "severity": severity,
        "issue_count": len(issues),
        "issues": issues,
        "metrics": metrics,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Shop Gate 零售数据导入工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_parser = subparsers.add_parser(
        "import-userbehavior", help="导入天池 UserBehavior CSV（确定性用户抽样）"
    )
    import_parser.add_argument("--csv", required=True, type=Path)
    import_parser.add_argument("--users", type=int, default=10_000)
    import_parser.add_argument("--seed", type=int, default=20251203)
    import_parser.add_argument("--batch-size", type=int, default=10_000)
    import_parser.add_argument(
        "--time-shift",
        dest="time_shift",
        default="last-week",
        help="last-week: 平移到最近一个完整周；none: 保持原始时间戳",
    )
    import_parser.add_argument(
        "--anchor-end",
        default="2017-12-03",
        help="原始数据窗口末日（用于平移计算）",
    )

    synthetic_parser = subparsers.add_parser(
        "generate-synthetic-behavior", help="合成行为流兜底（无 CSV 时，PRD R1）"
    )
    synthetic_parser.add_argument("--users", type=int, default=10_000)
    synthetic_parser.add_argument("--days", type=int, default=9)
    synthetic_parser.add_argument(
        "--items", type=int, default=DEFAULT_ITEM_POOL_SIZE,
        help="商品池规模；默认 1000，按头部/腰部/长尾分布抽样",
    )
    synthetic_parser.add_argument("--seed", type=int, default=20251203)
    synthetic_parser.add_argument("--batch-size", type=int, default=10_000)
    synthetic_parser.add_argument(
        "--time-shift",
        dest="time_shift",
        default="last-week",
        help="last-week: 平移到最近一个完整周；none: 锚定 anchor_end",
    )
    synthetic_parser.add_argument(
        "--anchor-end",
        default="2017-12-03",
        help="合成窗口末日锚点",
    )

    subparsers.add_parser(
        "generate-synthetic-master", help="按事件流生成合成商品主数据（PRD §5.2）"
    ).add_argument("--seed", type=int, default=20251203)

    subparsers.add_parser("aggregate-daily", help="重建商品/类目日聚合")

    analytics_parser = subparsers.add_parser(
        "generate-synthetic-analytics-dataset",
        help="生成按 dataset_id 隔离的电商经营分析演示数据集",
    )
    analytics_parser.add_argument("--dataset-id", default=DEFAULT_ANALYTICS_DATASET_ID)
    analytics_parser.add_argument("--users", type=int, default=1_000)
    analytics_parser.add_argument("--items", type=int, default=DEFAULT_ITEM_POOL_SIZE)
    analytics_parser.add_argument("--days", type=int, default=30)
    analytics_parser.add_argument("--seed", type=int, default=20251203)
    analytics_parser.add_argument("--end-day", default="2025-12-03")

    quality_parser = subparsers.add_parser(
        "scan-analytics-dataset",
        help="检查扩展经营分析数据集并写入 data_quality_scans",
    )
    quality_parser.add_argument("--dataset-id", default=DEFAULT_ANALYTICS_DATASET_ID)

    experiment_parser = subparsers.add_parser(
        "validate-price-experiment-csv",
        help="只读校验真实价格实验的用户分组 CSV 与观察 CSV",
    )
    experiment_parser.add_argument(
        "--assignments",
        required=True,
        type=Path,
        help="用户分组 CSV：experiment_id,user_id,variant,assigned_at,allocation_method",
    )
    experiment_parser.add_argument(
        "--observations",
        required=True,
        type=Path,
        help=(
            "实验观察 CSV：experiment_id,observation_date,item_id,variant,"
            "selling_price,exposed_users,purchasers,units,assignment_unit,allocation_method"
        ),
    )
    experiment_parser.add_argument(
        "--outcomes",
        type=Path,
        help="可选用户结果 CSV：experiment_id,user_id,outcome_date,variant,purchased,units",
    )
    experiment_parser.add_argument(
        "--source",
        default="observed_price_experiment_csv",
        help="报告中记录的外部来源名称",
    )

    import_experiment_parser = subparsers.add_parser(
        "import-price-experiment-csv",
        help="将已通过校验的真实价格实验 CSV 幂等写入指定数据集",
    )
    import_experiment_parser.add_argument("--dataset-id", required=True)
    import_experiment_parser.add_argument("--assignments", required=True, type=Path)
    import_experiment_parser.add_argument("--observations", required=True, type=Path)
    import_experiment_parser.add_argument("--outcomes", type=Path)
    import_experiment_parser.add_argument(
        "--source",
        required=True,
        help="真实实验来源名称，写入 source 字段和数据契约限制",
    )

    args = parser.parse_args()
    if args.command == "validate-price-experiment-csv":
        result = validate_price_experiment_csv_files(
            args.assignments,
            args.observations,
            outcomes_path=args.outcomes,
            source=args.source,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        if not result["valid"]:
            raise SystemExit(1)
        return

    connection = _connect()
    try:
        if args.command == "import-userbehavior":
            if not args.csv.is_file():
                raise SystemExit(f"CSV 不存在：{args.csv}")
            row_count, user_ids = scan_userbehavior_csv(args.csv)
            ordered_users = sorted(user_ids)
            if args.users >= len(ordered_users):
                sampled = set(ordered_users)
                sampled_count = len(ordered_users)
            else:
                sampled = set(
                    random.Random(f"sample|{args.seed}").sample(ordered_users, args.users)
                )
                sampled_count = args.users
            meta = {
                "mode": "tianchi_userbehavior",
                "csv_rows": row_count,
                "csv_users": len(ordered_users),
                "sampled_users": sampled_count,
                "seed": args.seed,
                "time_shift": args.time_shift,
                "shift_days": compute_time_shift_days(args.anchor_end, args.time_shift),
            }
            print(f"[import] 抽样完成：{meta}", flush=True)
            import_events(
                connection,
                _shift_event_timestamps(
                    iter_userbehavior_events(args.csv, sampled),
                    compute_time_shift_days(args.anchor_end, args.time_shift),
                ),
                provider="userbehavior_csv",
                meta=meta,
                batch_size=args.batch_size,
            )
        elif args.command == "generate-synthetic-behavior":
            meta = {
                "mode": "synthetic_fallback",
                "users": args.users,
                "days": args.days,
                "items": args.items,
                "seed": args.seed,
                "time_shift": args.time_shift,
                "anchor_end": args.anchor_end,
            }
            import_events(
                connection,
                synthetic_behavior_events(
                    users=args.users,
                    days=args.days,
                    seed=args.seed,
                    item_pool_size=args.items,
                    end_day=shift_target_end(args.anchor_end, args.time_shift),
                ),
                provider="synthetic",
                meta=meta,
                batch_size=args.batch_size,
            )
        elif args.command == "generate-synthetic-master":
            item_category = derive_item_category(connection)
            window_start = datetime(2017, 11, 25, tzinfo=UTC)
            master = synthetic_master_rows(item_category, args.seed, window_start)
            upsert_master_rows(connection, master)
            connection.commit()
            print(
                "[master] 完成："
                f"categories={len(master['categories'])} brands={len(master['brands'])} "
                f"shops={len(master['shops'])} items={len(master['items'])}"
            )
        elif args.command == "aggregate-daily":
            rows = rebuild_daily_aggregates(connection)
            connection.commit()
            print(f"[aggregate] 完成：daily_item_metrics rows={rows}")
        elif args.command == "generate-synthetic-analytics-dataset":
            try:
                end_day = datetime.fromisoformat(args.end_day).replace(tzinfo=UTC)
            except ValueError as error:
                raise SystemExit("--end-day 必须是 YYYY-MM-DD") from error
            dataset = synthetic_analytics_dataset(
                users=args.users,
                items=args.items,
                days=args.days,
                seed=args.seed,
                dataset_id=args.dataset_id,
                end_day=end_day,
            )
            replace_synthetic_analytics_dataset(connection, dataset)
            connection.commit()
            print(f"[analytics] 完成：{dataset['contract']}")
        elif args.command == "scan-analytics-dataset":
            result = scan_synthetic_analytics_dataset(connection, args.dataset_id)
            connection.commit()
            print(f"[quality] 完成：{result}")
            if result["issue_count"]:
                raise SystemExit(1)
        elif args.command == "import-price-experiment-csv":
            result = import_observed_price_experiment_csv(
                connection,
                args.dataset_id,
                args.assignments,
                args.observations,
                outcomes_path=args.outcomes,
                source=args.source,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
            if not result["valid"]:
                raise SystemExit(1)
            quality = scan_synthetic_analytics_dataset(connection, args.dataset_id)
            print(json.dumps({"quality_scan": quality}, ensure_ascii=False, indent=2))
            if quality["issue_count"]:
                raise SystemExit(1)
            connection.commit()
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
