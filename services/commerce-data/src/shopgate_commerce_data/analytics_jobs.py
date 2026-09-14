"""P32 经营分析跨服务编排任务。

Web 入口只允许生成受控的合成经营分析数据集；它复用 P27 的确定性生成器、
数据替换和质量扫描逻辑，并把任务状态写入 ``commerce.platform_jobs``。
CSV/第三方真实数据仍必须走离线连接器，不通过这个接口绕过来源和质量契约。
每个任务必须显式绑定主应用 ``project_id``，并用幂等键和持久事件把导入结果
交给后续 Agent 看板编排，不能从浏览器当前页面猜测目标项目。
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
PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
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
    project_id = _validate_token(
        payload.get("project_id"),
        "project_id",
        PROJECT_ID_PATTERN,
        200,
        "Agent 项目编号",
    )
    idempotency_key = _validate_token(
        payload.get("idempotency_key"),
        "idempotency_key",
        IDEMPOTENCY_KEY_PATTERN,
        200,
        "幂等请求键",
    )
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
        "project_id": project_id,
        "idempotency_key": idempotency_key,
        "dataset_id": dataset_id,
        "users": bounded_int("users", 1_000, 1, MAX_USERS),
        "items": bounded_int("items", 1_000, 1, MAX_ITEMS),
        "days": bounded_int("days", 30, 1, MAX_DAYS),
        "seed": seed,
        "end_day": end_day.isoformat(),
    }


def _validate_token(
    raw: Any,
    name: str,
    pattern: re.Pattern[str],
    max_length: int,
    label: str,
) -> str:
    value = str(raw or "").strip()
    if not value or len(value) > max_length or not pattern.fullmatch(value):
        raise AnalyticsDatasetImportError(
            f"{label}（{name}）不能为空，只能包含字母、数字、点、下划线、"
            f"短横线和冒号，且长度不超过 {max_length}。"
        )
    return value


def validate_csv_import_request(
    dataset_id: str,
    seed: int,
    project_id: Any,
    idempotency_key: Any,
) -> dict[str, Any]:
    normalised_project_id = _validate_token(
        project_id,
        "project_id",
        PROJECT_ID_PATTERN,
        200,
        "Agent 项目编号",
    )
    normalised_idempotency_key = _validate_token(
        idempotency_key,
        "idempotency_key",
        IDEMPOTENCY_KEY_PATTERN,
        200,
        "幂等请求键",
    )
    dataset_id = dataset_id.strip()
    if not DATASET_ID_PATTERN.fullmatch(dataset_id):
        raise AnalyticsDatasetImportError(
            "dataset_id 只能包含字母、数字、点、下划线和短横线，且长度不超过 120。"
        )
    try:
        normalised_seed = int(seed)
    except (TypeError, ValueError) as error:
        raise AnalyticsDatasetImportError("seed 必须是整数。") from error
    return {
        "project_id": normalised_project_id,
        "idempotency_key": normalised_idempotency_key,
        "dataset_id": dataset_id,
        "seed": normalised_seed,
    }


def _read_behavior_csv(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, None)
            if header != list(EVENT_COLUMNS):
                raise AnalyticsDatasetImportError(f"CSV 列必须严格为 {list(EVENT_COLUMNS)}。")
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
                    raise AnalyticsDatasetImportError(f"CSV 行数不能超过 {MAX_CSV_ROWS:,} 行。")
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


def _serialise_job(row: dict[str, Any], *, idempotent_replay: bool = False) -> dict[str, Any]:
    result = dict(row)
    for key in ("started_at", "completed_at", "created_at", "updated_at"):
        if result.get(key) is not None:
            result[key] = result[key].isoformat()
    result["idempotent_replay"] = idempotent_replay
    return result


def _job_response(
    *,
    job_id: str,
    job_type: str,
    payload: dict[str, Any],
    status: str,
    progress: float,
    created_at: datetime,
    idempotent_replay: bool = False,
) -> dict[str, Any]:
    return {
        "job_id": job_id,
        "job_type": job_type,
        "project_id": payload["project_id"],
        "dataset_id": payload["dataset_id"],
        "idempotency_key": payload["idempotency_key"],
        "status": status,
        "progress": progress,
        "created_at": created_at.isoformat(),
        "idempotent_replay": idempotent_replay,
    }


def _insert_orchestration_event(
    cursor: psycopg.Cursor[dict[str, Any]],
    job_id: str,
    event_type: str,
    event_payload: dict[str, Any] | None = None,
) -> bool:
    cursor.execute(
        """
        SELECT project_id, idempotency_key, payload->>'dataset_id' AS dataset_id
        FROM commerce.platform_jobs
        WHERE id = %s
        FOR UPDATE
        """,
        (job_id,),
    )
    job = cursor.fetchone()
    if not job or not job["project_id"] or not job["idempotency_key"] or not job["dataset_id"]:
        raise RuntimeError(f"任务 {job_id} 缺少项目或数据集绑定，无法写入编排事件。")

    cursor.execute(
        """
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM commerce.analytics_orchestration_events
        WHERE job_id = %s
        """,
        (job_id,),
    )
    next_sequence = int(cursor.fetchone()["next_sequence"])
    envelope = {
        "event_type": event_type,
        "schema_version": "v1",
        "project_id": job["project_id"],
        "dataset_id": job["dataset_id"],
        "job_id": job_id,
        "idempotency_key": job["idempotency_key"],
        "sequence": next_sequence,
        "payload": event_payload or {},
    }
    cursor.execute(
        """
        INSERT INTO commerce.analytics_orchestration_events
          (id, event_type, schema_version, job_id, project_id, dataset_id,
           idempotency_key, sequence, payload)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (project_id, idempotency_key, event_type) DO NOTHING
        RETURNING id
        """,
        (
            f"analytics-event-{uuid4()}",
            event_type,
            "v1",
            job_id,
            job["project_id"],
            job["dataset_id"],
            job["idempotency_key"],
            next_sequence,
            Jsonb(envelope),
        ),
    )
    return cursor.fetchone() is not None


def _create_job(
    payload: dict[str, Any],
    *,
    job_type: str = IMPORT_JOB_TYPE,
    job_prefix: str = "import",
    event_type: str | None = None,
    event_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    job_id = _job_id(job_prefix)
    now = datetime.now(UTC)
    with _connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
                INSERT INTO commerce.platform_jobs
                  (id, job_type, queue, status, priority, progress, control, payload,
                   result, project_id, idempotency_key, created_at, updated_at)
                VALUES (%s, %s, 'analytics', 'queued', 100,
                        0, 'run', %s, '{}'::jsonb, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                RETURNING id, job_type, status, progress, project_id, idempotency_key,
                          created_at, updated_at
            """,
            (
                job_id,
                job_type,
                Jsonb(payload),
                payload["project_id"],
                payload["idempotency_key"],
                now,
                now,
            ),
        )
        inserted = cursor.fetchone()
        if inserted:
            if event_type:
                _insert_orchestration_event(cursor, job_id, event_type, event_payload)
            connection.commit()
            return _job_response(
                job_id=job_id,
                job_type=job_type,
                payload=payload,
                status="queued",
                progress=0,
                created_at=now,
            )

        cursor.execute(
            """
            SELECT id, job_type, status, progress, project_id, idempotency_key,
                   payload, result, error, started_at, completed_at, created_at, updated_at
            FROM commerce.platform_jobs
            WHERE job_type = %s AND project_id = %s AND idempotency_key = %s
            """,
            (job_type, payload["project_id"], payload["idempotency_key"]),
        )
        existing = cursor.fetchone()
        if not existing:
            raise RuntimeError("无法读取幂等任务，请稍后重试。")
        connection.commit()
        return _serialise_job(dict(existing), idempotent_replay=True)


def _create_dashboard_job(
    dataset_id: str,
    import_job_id: str,
    project_id: str,
) -> dict[str, Any]:
    payload = {
        "project_id": project_id,
        "dataset_id": dataset_id,
        "import_job_id": import_job_id,
        "template_id": "analytics-bi",
        "idempotency_key": f"dashboard:{import_job_id}",
    }
    return _create_job(
        payload,
        job_type=DASHBOARD_JOB_TYPE,
        job_prefix="dashboard",
        event_type="analytics_dashboard_generation.requested",
        event_payload={"import_job_id": import_job_id, "template_id": "analytics-bi"},
    )


def _update_job(
    job_id: str,
    *,
    status: str,
    progress: float,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    event_type: str | None = None,
    event_payload: dict[str, Any] | None = None,
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
            if event_type:
                _insert_orchestration_event(cursor, job_id, event_type, event_payload)
        connection.commit()


def _get_job(job_id: str, project_id: str | None = None) -> dict[str, Any] | None:
    with _connect() as connection, connection.cursor() as cursor:
        query = """
            SELECT id, job_type, status, progress, payload, result, error,
                   project_id, idempotency_key,
                   started_at, completed_at, created_at, updated_at
            FROM commerce.platform_jobs
            WHERE id = %s AND job_type IN (%s, %s)
        """
        params: list[Any] = [job_id, IMPORT_JOB_TYPE, DASHBOARD_JOB_TYPE]
        if project_id:
            query += " AND project_id = %s"
            params.append(project_id)
        cursor.execute(query, params)
        row = cursor.fetchone()
    if not row:
        return None
    return _serialise_job(dict(row))


def _list_jobs(project_id: str, dataset_id: str | None, limit: int) -> list[dict[str, Any]]:
    with _connect() as connection, connection.cursor() as cursor:
        params: list[Any] = [IMPORT_JOB_TYPE, DASHBOARD_JOB_TYPE, project_id]
        query = """
            SELECT id, job_type, status, progress, payload, result, error,
                   project_id, idempotency_key,
                   started_at, completed_at, created_at, updated_at
            FROM commerce.platform_jobs
            WHERE job_type IN (%s, %s)
              AND project_id = %s
        """
        if dataset_id:
            query += " AND payload->>'dataset_id' = %s"
            params.append(dataset_id)
        query += " ORDER BY created_at DESC LIMIT %s"
        params.append(limit)
        cursor.execute(query, params)
        rows = cursor.fetchall()
    return [_serialise_job(dict(row)) for row in rows]


def _list_orchestration_events(
    project_id: str,
    limit: int,
    include_consumed: bool,
) -> list[dict[str, Any]]:
    with _connect() as connection, connection.cursor() as cursor:
        query = """
            SELECT id, event_type, schema_version, job_id, project_id, dataset_id,
                   idempotency_key, sequence, payload, consumed_at, created_at
            FROM commerce.analytics_orchestration_events
            WHERE project_id = %s
        """
        params: list[Any] = [project_id]
        if not include_consumed:
            query += " AND consumed_at IS NULL"
        query += " ORDER BY created_at ASC, sequence ASC LIMIT %s"
        params.append(limit)
        cursor.execute(query, params)
        rows = cursor.fetchall()
    for row in rows:
        for key in ("consumed_at", "created_at"):
            if row.get(key) is not None:
                row[key] = row[key].isoformat()
    return [dict(row) for row in rows]


def _ack_orchestration_event(project_id: str, event_id: str) -> dict[str, Any] | None:
    with _connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE commerce.analytics_orchestration_events
            SET consumed_at = COALESCE(consumed_at, now())
            WHERE id = %s AND project_id = %s
            RETURNING id, event_type, schema_version, job_id, project_id, dataset_id,
                      idempotency_key, sequence, payload, consumed_at, created_at
            """,
            (event_id, project_id),
        )
        row = cursor.fetchone()
        connection.commit()
    if not row:
        return None
    for key in ("consumed_at", "created_at"):
        if row.get(key) is not None:
            row[key] = row[key].isoformat()
    return dict(row)


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
            event_type="analytics_dashboard_manifest.ready",
            event_payload={
                "import_job_id": payload["import_job_id"],
                "template_id": payload["template_id"],
                "manifest": manifest,
            },
        )
    except Exception as error:
        _update_job(
            job_id,
            status="failed",
            progress=1,
            error=str(error),
            event_type="analytics_dashboard_generation.failed",
            event_payload={"error": str(error)},
        )


def _generate_dashboard_manifest(
    dataset_id: str,
    import_job_id: str,
    project_id: str,
) -> dict[str, Any]:
    dashboard_job = _create_dashboard_job(dataset_id, import_job_id, project_id)
    if not dashboard_job["idempotent_replay"]:
        _run_dashboard_job_sync(
            dashboard_job["job_id"],
            {
                "project_id": project_id,
                "dataset_id": dataset_id,
                "import_job_id": import_job_id,
                "template_id": "analytics-bi",
            },
        )
    final = _get_job(dashboard_job["job_id"], project_id)
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
        dashboard = _generate_dashboard_manifest(
            payload["dataset_id"], job_id, payload["project_id"]
        )
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
            event_type="analytics_dataset_import.completed",
            event_payload={
                "quality_scan": quality,
                "row_counts": row_counts,
                "dashboard_job_id": dashboard["job_id"],
                "dashboard_status": dashboard["status"],
            },
        )
    except Exception as error:
        if connection is not None:
            connection.rollback()
        _update_job(
            job_id,
            status="failed",
            progress=1,
            error=str(error),
            event_type="analytics_dataset_import.failed",
            event_payload={"error": str(error)},
        )
    finally:
        if connection is not None:
            connection.close()


async def enqueue_dataset_import(payload: dict[str, Any]) -> dict[str, Any]:
    normalised = validate_import_request(payload)
    job = await asyncio.to_thread(_create_job, normalised)
    if not job["idempotent_replay"]:
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
        dashboard = _generate_dashboard_manifest(
            payload["dataset_id"], job_id, payload["project_id"]
        )
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
            event_type="analytics_dataset_import.completed",
            event_payload={
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
        _update_job(
            job_id,
            status="failed",
            progress=1,
            error=str(error),
            event_type="analytics_dataset_import.failed",
            event_payload={"error": str(error)},
        )
    finally:
        if connection is not None:
            connection.close()
        path.unlink(missing_ok=True)


async def enqueue_csv_dataset_import(
    dataset_id: str,
    seed: int,
    filename: str,
    content: bytes,
    project_id: str,
    idempotency_key: str,
) -> dict[str, Any]:
    normalised = validate_csv_import_request(dataset_id, seed, project_id, idempotency_key)
    if not content:
        raise AnalyticsDatasetImportError("CSV 文件不能为空。")
    if len(content) > MAX_CSV_BYTES:
        raise AnalyticsDatasetImportError(f"CSV 文件不能超过 {MAX_CSV_BYTES // (1024 * 1024)} MB。")
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
        if not job["idempotent_replay"]:
            task = asyncio.create_task(
                asyncio.to_thread(_run_csv_job_sync, job["job_id"], payload, path)
            )
            _ACTIVE_TASKS.add(task)
            task.add_done_callback(_ACTIVE_TASKS.discard)
        else:
            path.unlink(missing_ok=True)
        return job
    except Exception:
        if path is not None:
            path.unlink(missing_ok=True)
        raise


async def get_dataset_import_job(
    job_id: str,
    project_id: str,
) -> dict[str, Any] | None:
    return await asyncio.to_thread(_get_job, job_id, project_id)


async def list_dataset_import_jobs(
    project_id: str,
    dataset_id: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 50))
    return await asyncio.to_thread(_list_jobs, project_id, dataset_id, bounded_limit)


async def list_orchestration_events(
    project_id: str,
    limit: int = 50,
    include_consumed: bool = False,
) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 200))
    return await asyncio.to_thread(
        _list_orchestration_events, project_id, bounded_limit, include_consumed
    )


async def ack_orchestration_event(
    project_id: str,
    event_id: str,
) -> dict[str, Any] | None:
    return await asyncio.to_thread(_ack_orchestration_event, project_id, event_id)
