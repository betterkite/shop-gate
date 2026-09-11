"""P31 经营分析数据集导入任务。

Web 入口只允许生成受控的合成经营分析数据集；它复用 P27 的确定性生成器、
数据替换和质量扫描逻辑，并把任务状态写入 ``commerce.platform_jobs``。
CSV/第三方真实数据仍必须走离线连接器，不通过这个接口绕过来源和质量契约。
"""

from __future__ import annotations

import asyncio
import csv
import re
import tempfile
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from shopgate_commerce_data.database_core import database_url_from_env
from shopgate_commerce_data.import_cli import (
    EVENT_COLUMNS,
    VALID_BEHAVIORS,
    replace_synthetic_analytics_dataset,
    scan_synthetic_analytics_dataset,
)
from shopgate_commerce_data.synthetic import (
    analytics_dataset_from_behavior_events,
    synthetic_analytics_dataset,
)

DATASET_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
MAX_USERS = 5_000
MAX_ITEMS = 5_000
MAX_DAYS = 180
MAX_CSV_BYTES = 50 * 1024 * 1024
MAX_CSV_ROWS = 500_000
IMPORT_JOB_TYPE = "analytics_dataset_import"
DASHBOARD_JOB_TYPE = "analytics_dashboard_generation"
_ACTIVE_TASKS: set[asyncio.Task[None]] = set()


class AnalyticsDatasetImportError(ValueError):
    """用户提交的经营分析数据集导入参数不合法。"""


def validate_import_request(payload: dict[str, Any]) -> dict[str, Any]:
    dataset_id = str(payload.get("dataset_id", "")).strip()
    if not DATASET_ID_PATTERN.fullmatch(dataset_id):
        raise AnalyticsDatasetImportError(
            "dataset_id 只能包含字母、数字、点、下划线和短横线，且长度不超过 120。"
        )

    def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
        raw = payload.get(name, default)
        try:
            value = int(raw)
        except (TypeError, ValueError) as error:
            raise AnalyticsDatasetImportError(f"{name} 必须是整数。") from error
        if not minimum <= value <= maximum:
            raise AnalyticsDatasetImportError(f"{name} 必须在 {minimum} 到 {maximum} 之间。")
        return value

    end_day_raw = str(payload.get("end_day", "2025-12-03")).strip()
    try:
        end_day = date.fromisoformat(end_day_raw)
    except ValueError as error:
        raise AnalyticsDatasetImportError("end_day 必须是 YYYY-MM-DD。") from error

    try:
        seed = int(payload.get("seed", 20251203))
    except (TypeError, ValueError) as error:
        raise AnalyticsDatasetImportError("seed 必须是整数。") from error

    return {
        "dataset_id": dataset_id,
        "users": bounded_int("users", 1_000, 1, MAX_USERS),
        "items": bounded_int("items", 1_000, 1, MAX_ITEMS),
        "days": bounded_int("days", 30, 1, MAX_DAYS),
        "seed": seed,
        "end_day": end_day.isoformat(),
    }


def validate_csv_import_request(dataset_id: str, seed: int) -> dict[str, Any]:
    dataset_id = dataset_id.strip()
    if not DATASET_ID_PATTERN.fullmatch(dataset_id):
        raise AnalyticsDatasetImportError(
            "dataset_id 只能包含字母、数字、点、下划线和短横线，且长度不超过 120。"
        )
    try:
        normalised_seed = int(seed)
    except (TypeError, ValueError) as error:
        raise AnalyticsDatasetImportError("seed 必须是整数。") from error
    return {"dataset_id": dataset_id, "seed": normalised_seed}


def _read_behavior_csv(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, None)
            if header != list(EVENT_COLUMNS):
                raise AnalyticsDatasetImportError(
                    f"CSV 列必须严格为 {list(EVENT_COLUMNS)}。"
                )
            for line_number, row in enumerate(reader, start=2):
                if not row or all(not cell.strip() for cell in row):
                    continue
                if len(row) != len(EVENT_COLUMNS):
                    raise AnalyticsDatasetImportError(f"第 {line_number} 行必须有 5 列。")
                behavior_type = row[3].strip()
                if behavior_type not in VALID_BEHAVIORS:
                    raise AnalyticsDatasetImportError(
                        f"第 {line_number} 行 behavior_type 只能是 pv、fav、cart 或 buy。"
                    )
                try:
                    user_id = int(row[0].strip())
                    item_id = int(row[1].strip())
                    category_id = int(row[2].strip())
                    timestamp = int(row[4].strip())
                    event_ts = datetime.fromtimestamp(timestamp, tz=UTC)
                except (TypeError, ValueError, OverflowError) as error:
                    raise AnalyticsDatasetImportError(
                        f"第 {line_number} 行用户、商品、类目或时间戳格式错误。"
                    ) from error
                events.append(
                    {
                        "user_id": user_id,
                        "item_id": item_id,
                        "category_id": category_id,
                        "behavior_type": behavior_type,
                        "event_ts": event_ts,
                        "source": "userbehavior_csv",
                    }
                )
                if len(events) > MAX_CSV_ROWS:
                    raise AnalyticsDatasetImportError(
                        f"CSV 行数不能超过 {MAX_CSV_ROWS:,} 行。"
                    )
    except UnicodeDecodeError as error:
        raise AnalyticsDatasetImportError("CSV 必须使用 UTF-8 编码。") from error
    if not events:
        raise AnalyticsDatasetImportError("CSV 中没有可导入的行为事件。")
    return events


def _connect() -> psycopg.Connection[dict[str, Any]]:
    return psycopg.connect(
        database_url_from_env(),
        row_factory=dict_row,
        autocommit=False,
    )


def _job_id(prefix: str = "import") -> str:
    return f"analytics-{prefix}-{uuid4()}"


def _create_job(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = _job_id()
    now = datetime.now(UTC)
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO commerce.platform_jobs
                  (id, job_type, queue, status, priority, progress, control, payload,
                   result, created_at, updated_at)
                VALUES (%s, %s, 'analytics', 'queued', 100,
                        0, 'run', %s, '{}'::jsonb, %s, %s)
                """,
                (job_id, IMPORT_JOB_TYPE, Jsonb(payload), now, now),
            )
        connection.commit()
    return {
        "job_id": job_id,
        "dataset_id": payload["dataset_id"],
        "status": "queued",
        "progress": 0,
        "created_at": now.isoformat(),
    }


def _create_dashboard_job(dataset_id: str, import_job_id: str) -> dict[str, Any]:
    job_id = _job_id("dashboard")
    now = datetime.now(UTC)
    payload = {
        "dataset_id": dataset_id,
        "import_job_id": import_job_id,
        "template_id": "analytics-bi",
    }
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO commerce.platform_jobs
                  (id, job_type, queue, status, priority, progress, control, payload,
                   result, created_at, updated_at)
                VALUES (%s, %s, 'analytics', 'queued', 100,
                        0, 'run', %s, '{}'::jsonb, %s, %s)
                """,
                (job_id, DASHBOARD_JOB_TYPE, Jsonb(payload), now, now),
            )
        connection.commit()
    return {
        "job_id": job_id,
        "dataset_id": dataset_id,
        "status": "queued",
        "progress": 0,
        "created_at": now.isoformat(),
    }


def _update_job(
    job_id: str,
    *,
    status: str,
    progress: float,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE commerce.platform_jobs
                SET status = %s,
                    progress = %s,
                    result = COALESCE(%s, result),
                    error = %s,
                    started_at = CASE WHEN %s = 'running' AND started_at IS NULL
                                      THEN now() ELSE started_at END,
                    completed_at = CASE WHEN %s IN ('completed', 'failed')
                                        THEN now() ELSE completed_at END,
                    heartbeat_at = now(),
                    updated_at = now()
                WHERE id = %s
                """,
                (
                    status,
                    progress,
                    Jsonb(result) if result is not None else None,
                    error,
                    status,
                    status,
                    job_id,
                ),
            )
        connection.commit()


def _get_job(job_id: str) -> dict[str, Any] | None:
    with _connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, job_type, status, progress, payload, result, error,
                   started_at, completed_at, created_at, updated_at
            FROM commerce.platform_jobs
            WHERE id = %s AND job_type IN (%s, %s)
            """,
            (job_id, IMPORT_JOB_TYPE, DASHBOARD_JOB_TYPE),
        )
        row = cursor.fetchone()
    if not row:
        return None
    for key in ("started_at", "completed_at", "created_at", "updated_at"):
        if row.get(key) is not None:
            row[key] = row[key].isoformat()
    return dict(row)


def _list_jobs(dataset_id: str | None, limit: int) -> list[dict[str, Any]]:
    with _connect() as connection, connection.cursor() as cursor:
        if dataset_id:
            cursor.execute(
                """
                SELECT id, job_type, status, progress, payload, result, error,
                       started_at, completed_at, created_at, updated_at
                FROM commerce.platform_jobs
                WHERE job_type IN (%s, %s)
                  AND payload->>'dataset_id' = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (IMPORT_JOB_TYPE, DASHBOARD_JOB_TYPE, dataset_id, limit),
            )
        else:
            cursor.execute(
                """
                SELECT id, job_type, status, progress, payload, result, error,
                       started_at, completed_at, created_at, updated_at
                FROM commerce.platform_jobs
                WHERE job_type IN (%s, %s)
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (IMPORT_JOB_TYPE, DASHBOARD_JOB_TYPE, limit),
            )
        rows = cursor.fetchall()
    for row in rows:
        for key in ("started_at", "completed_at", "created_at", "updated_at"):
            if row.get(key) is not None:
                row[key] = row[key].isoformat()
    return [dict(row) for row in rows]


def _run_dashboard_job_sync(job_id: str, payload: dict[str, Any]) -> None:
    """为当前数据集生成可追踪的 BI 配置清单，等待后续 Agent 预览编排。"""

    _update_job(job_id, status="running", progress=0.2)
    try:
        with _connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT dataset_id, source_kind, source_name, window_start, window_end,
                       version, schema_version
                FROM commerce.dataset_contracts
                WHERE dataset_id = %s
                """,
                (payload["dataset_id"],),
            )
            contract = cursor.fetchone()
            cursor.execute(
                """
                SELECT id, severity, issue_count
                FROM commerce.data_quality_scans
                WHERE universe_id = %s AND scope = 'analytics_dataset'
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (payload["dataset_id"],),
            )
            quality = cursor.fetchone()
        if not contract:
            raise RuntimeError(f"数据集不存在：{payload['dataset_id']}")
        if not quality or quality["severity"] != "ok":
            raise RuntimeError("数据质量扫描未通过，暂不生成看板配置。")
        _update_job(job_id, status="running", progress=0.7)
        manifest = {
            "dataset_id": payload["dataset_id"],
            "template_id": payload["template_id"],
            "mode": "analytics_workbench_manifest",
            "preview_ready": False,
            "source_kind": contract["source_kind"],
            "source_name": contract["source_name"],
            "window": {
                "start": contract["window_start"].isoformat(),
                "end": contract["window_end"].isoformat(),
            },
            "contract_version": contract["version"],
            "schema_version": contract["schema_version"],
            "quality_scan_id": quality["id"],
            "views": [
                "overview",
                "customers",
                "channels",
                "profit",
                "inventory",
                "lifecycle",
                "elasticity",
            ],
            "next_step": "由 Agent 任务编排按 dataset_id 生成可持久化看板预览。",
        }
        _update_job(
            job_id,
            status="completed",
            progress=1,
            result={"dataset_id": payload["dataset_id"], "manifest": manifest},
        )
    except Exception as error:
        _update_job(job_id, status="failed", progress=1, error=str(error))


def _generate_dashboard_manifest(dataset_id: str, import_job_id: str) -> dict[str, Any]:
    dashboard_job = _create_dashboard_job(dataset_id, import_job_id)
    _run_dashboard_job_sync(dashboard_job["job_id"], {
        "dataset_id": dataset_id,
        "import_job_id": import_job_id,
        "template_id": "analytics-bi",
    })
    final = _get_job(dashboard_job["job_id"])
    return {
        "job_id": dashboard_job["job_id"],
        "status": final["status"] if final else "failed",
    }


def _run_job_sync(job_id: str, payload: dict[str, Any]) -> None:
    _update_job(job_id, status="running", progress=0.05)
    connection: psycopg.Connection[dict[str, Any]] | None = None
    try:
        dataset = synthetic_analytics_dataset(
            users=payload["users"],
            items=payload["items"],
            days=payload["days"],
            seed=payload["seed"],
            dataset_id=payload["dataset_id"],
            end_day=datetime.fromisoformat(payload["end_day"]).replace(tzinfo=UTC),
        )
        _update_job(job_id, status="running", progress=0.45)
        connection = _connect()
        replace_synthetic_analytics_dataset(connection, dataset)
        connection.commit()
        _update_job(job_id, status="running", progress=0.75)

        quality = scan_synthetic_analytics_dataset(connection, payload["dataset_id"])
        connection.commit()
        if quality["severity"] != "ok":
            raise RuntimeError(f"数据质量扫描未通过：{'; '.join(quality['issues'])}")

        row_counts = dataset["contract"].get("row_counts", {})
        dashboard = _generate_dashboard_manifest(payload["dataset_id"], job_id)
        _update_job(
            job_id,
            status="completed",
            progress=1,
            result={
                "dataset_id": payload["dataset_id"],
                "quality_scan": quality,
                "row_counts": row_counts,
                "dashboard_job_id": dashboard["job_id"],
                "dashboard_status": dashboard["status"],
            },
        )
    except Exception as error:
        if connection is not None:
            connection.rollback()
        _update_job(job_id, status="failed", progress=1, error=str(error))
    finally:
        if connection is not None:
            connection.close()


async def enqueue_dataset_import(payload: dict[str, Any]) -> dict[str, Any]:
    normalised = validate_import_request(payload)
    job = await asyncio.to_thread(_create_job, normalised)
    task = asyncio.create_task(asyncio.to_thread(_run_job_sync, job["job_id"], normalised))
    _ACTIVE_TASKS.add(task)
    task.add_done_callback(_ACTIVE_TASKS.discard)
    return job


def _run_csv_job_sync(job_id: str, payload: dict[str, Any], path: Path) -> None:
    _update_job(job_id, status="running", progress=0.05)
    connection: psycopg.Connection[dict[str, Any]] | None = None
    try:
        events = _read_behavior_csv(path)
        _update_job(job_id, status="running", progress=0.25)
        dataset = analytics_dataset_from_behavior_events(
            events,
            seed=payload["seed"],
            dataset_id=payload["dataset_id"],
            source_name=payload["source_name"],
        )
        _update_job(job_id, status="running", progress=0.45)
        connection = _connect()
        replace_synthetic_analytics_dataset(connection, dataset)
        connection.commit()
        _update_job(job_id, status="running", progress=0.75)
        quality = scan_synthetic_analytics_dataset(connection, payload["dataset_id"])
        connection.commit()
        if quality["severity"] != "ok":
            raise RuntimeError(f"数据质量扫描未通过：{'; '.join(quality['issues'])}")
        dashboard = _generate_dashboard_manifest(payload["dataset_id"], job_id)
        _update_job(
            job_id,
            status="completed",
            progress=1,
            result={
                "dataset_id": payload["dataset_id"],
                "quality_scan": quality,
                "row_counts": dataset["contract"].get("row_counts", {}),
                "behavior_source": payload["source_name"],
                "dashboard_job_id": dashboard["job_id"],
                "dashboard_status": dashboard["status"],
            },
        )
    except Exception as error:
        if connection is not None:
            connection.rollback()
        _update_job(job_id, status="failed", progress=1, error=str(error))
    finally:
        if connection is not None:
            connection.close()
        path.unlink(missing_ok=True)


async def enqueue_csv_dataset_import(
    dataset_id: str,
    seed: int,
    filename: str,
    content: bytes,
) -> dict[str, Any]:
    normalised = validate_csv_import_request(dataset_id, seed)
    if not content:
        raise AnalyticsDatasetImportError("CSV 文件不能为空。")
    if len(content) > MAX_CSV_BYTES:
        raise AnalyticsDatasetImportError(
            f"CSV 文件不能超过 {MAX_CSV_BYTES // (1024 * 1024)} MB。"
        )
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="shopgate-analytics-import-", suffix=".csv", delete=False
        ) as temporary:
            path = Path(temporary.name)
            temporary.write(content)
        payload = {
            **normalised,
            "filename": filename[:200] or "upload.csv",
            "source_name": "userbehavior_csv",
        }
        assert path is not None
        job = await asyncio.to_thread(_create_job, payload)
        task = asyncio.create_task(
            asyncio.to_thread(_run_csv_job_sync, job["job_id"], payload, path)
        )
        _ACTIVE_TASKS.add(task)
        task.add_done_callback(_ACTIVE_TASKS.discard)
        return job
    except Exception:
        if path is not None:
            path.unlink(missing_ok=True)
        raise


async def get_dataset_import_job(job_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(_get_job, job_id)


async def list_dataset_import_jobs(
    dataset_id: str | None = None, limit: int = 10,
) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 50))
    return await asyncio.to_thread(_list_jobs, dataset_id, bounded_limit)
