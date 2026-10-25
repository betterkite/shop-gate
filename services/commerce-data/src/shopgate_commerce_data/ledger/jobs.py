"""Durable, private BI queue; ledger effects and terminal state commit together.

An independent worker owns a session advisory lock plus a fenced lease. The long
calculation does not hold the job row lock, so cancellation stays responsive. Its
final short row lock orders cancellation/current authorization against commit.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict
from datetime import UTC, datetime
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from shopgate_commerce_data.ledger.csv_contract import (
    MAX_BATCH_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    SPECS,
    CsvFile,
)
from shopgate_commerce_data.ledger.datasets import require_idle
from shopgate_commerce_data.ledger.demo import DemoPlan, demo_files, generate_demo
from shopgate_commerce_data.ledger.exchange import (
    confirm_import,
    download_errors,
    export_csv12,
    preview_import,
)
from shopgate_commerce_data.ledger.job_scope import JOB_KINDS, JobScope, verify_grant
from shopgate_commerce_data.ledger.operations import (
    OperationConflict,
    bind_scope,
    checked_dataset,
    payload_hash,
)
from shopgate_commerce_data.ledger.recalculation import rows
from shopgate_commerce_data.ledger.scope import IDENTIFIER, ScopeError

TERMINAL = frozenset({"ready_preview", "rejected", "committed", "completed", "failed", "cancelled"})
STAGES = {
    "queued": "等待处理",
    "running": "正在处理",
    "awaiting_auth": "等待重新登录授权",
    "ready_preview": "预览已完成，请确认是否导入",
    "rejected": "发现数据问题，请修正后重新预览",
    "committed": "已写入经营账本",
    "completed": "处理完成",
    "failed": "处理失败",
    "cancelled": "已取消，未写入经营账本",
}


class JobCancelled(Exception):
    pass


def _identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError("任务或请求标识无效。")
    return value


def _bind(connection, scope):
    scope.require("jobs.read")
    bind_scope(connection, scope.ledger())
    connection.execute("SELECT set_config('shopgate.actor_id',%s,true)", (scope.actor_id,))


def _where(scope):
    return (scope.workspace_id, scope.dataset_id, scope.actor_id)


def public_job(job):
    result = {
        key: job[key]
        for key in (
            "workspace_id",
            "dataset_id",
            "job_id",
            "kind",
            "base_version",
            "state",
            "result",
            "cancel_requested",
            "attempts",
            "error_code",
            "created_at",
            "updated_at",
            "expires_at",
        )
    }
    for key in ("created_at", "updated_at", "expires_at"):
        result[key] = result[key].isoformat()
    result["expired"] = job["expires_at"] <= datetime.now(UTC)
    result["stage_label"] = (
        "正在取消，请等待确认结果"
        if job["cancel_requested"] and job["state"] == "running"
        else "任务已过期，请重新提交"
        if result["expired"] and job["state"] not in TERMINAL
        else STAGES[job["state"]]
    )
    return result


def _validated(kind, parameters, files):
    if not isinstance(kind, str) or kind not in JOB_KINDS or not isinstance(parameters, dict):
        raise ValueError("经营任务类型或参数无效。")
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise ValueError("导入文件数量超出限制。")
    metadata, total = [], 0
    for file in files:
        if (
            not isinstance(file, CsvFile)
            or file.resource not in SPECS
            or not isinstance(file.content, bytes)
        ):
            raise ValueError("标准文件类型无效。")
        if (
            not isinstance(file.filename, str)
            or not 1 <= len(file.filename) <= 200
            or any(ord(char) < 32 for char in file.filename)
        ):
            raise ValueError("文件显示名称无效。")
        if not 0 < len(file.content) <= MAX_FILE_BYTES:
            raise ValueError("单个文件必须非空且不超过20MiB。")
        total += len(file.content)
        metadata.append(
            {
                "resource": file.resource,
                "filename": file.filename,
                "bytes": len(file.content),
                "sha256": hashlib.sha256(file.content).hexdigest(),
            }
        )
    if total > MAX_BATCH_BYTES:
        raise ValueError("单批文件不能超过60MiB。")
    if kind == "preview_import":
        if not files or parameters:
            raise ValueError("导入预览需要标准文件，不能附加其他参数。")
        normalized = {}
    elif kind == "prepare_demo":
        if files or parameters.get("confirmed_by_user") is not True:
            raise ScopeError("生成演示源事实需要用户明确确认。")
        allowed = {"start_date", "seed", "days", "sku_count", "order_count", "confirmed_by_user"}
        if not set(parameters).issubset(allowed) or "start_date" not in parameters:
            raise ValueError("演示计划参数无效。")
        plan = DemoPlan(**{k: v for k, v in parameters.items() if k != "confirmed_by_user"})
        plan.validate()
        normalized = {**asdict(plan), "confirmed_by_user": True}
    elif kind == "confirm_import":
        if files or set(parameters) != {"preview_id", "confirmed_by_user"}:
            raise ValueError("确认导入参数无效。")
        if parameters["confirmed_by_user"] is not True:
            raise ScopeError("正式写入需要用户明确确认。")
        normalized = {
            "preview_id": _identifier(parameters["preview_id"]),
            "confirmed_by_user": True,
        }
    else:
        if (
            files
            or set(parameters) != {"resources"}
            or not isinstance(parameters["resources"], list)
        ):
            raise ValueError("请选择标准导出资源。")
        resources = parameters["resources"]
        if (
            not resources
            or any(not isinstance(x, str) or x not in SPECS for x in resources)
            or len(set(resources)) != len(resources)
        ):
            raise ValueError("标准导出资源无效或重复。")
        normalized = {"resources": sorted(resources)}
    return normalized, metadata


def submit_job(
    connection,
    scope: JobScope,
    kind,
    parameters,
    idempotency_key,
    *,
    files=None,
    demo_allowed=False,
):
    require_idle(connection)
    scope.require("jobs.read")
    if kind != "export_standard":
        scope.require("jobs.manage")
    _identifier(idempotency_key)
    files = [] if files is None else files
    parameters, metadata = _validated(kind, parameters, files)
    if kind == "prepare_demo" and demo_allowed is not True:
        raise ScopeError("当前模式不允许生成演示数据。")
    digest = payload_hash(
        {"kind": kind, "version": scope.version, "parameters": parameters, "files": metadata}
    )
    with connection.transaction():
        _bind(connection, scope)
        # Dataset lock serializes creation, idempotency, version and active-job quota.
        version = checked_dataset(connection, scope.ledger(), lock=True)
        previous = rows(
            connection,
            "SELECT * FROM bi.jobs WHERE workspace_id=%s AND dataset_id=%s "
            "AND actor_id=%s AND idempotency_key=%s",
            (*_where(scope), idempotency_key),
        )
        if previous:
            if previous[0]["request_hash"] != digest:
                raise OperationConflict("同一任务请求标识不能用于不同内容或版本。")
            return public_job(previous[0])
        if version != scope.version:
            raise OperationConflict("数据已更新，请刷新后重新预览。")
        if kind == "prepare_demo":
            source = connection.execute("SELECT source_kind FROM bi.datasets").fetchone()[0]
            if source != "demo" or version != 1:
                raise OperationConflict(
                    "仅空演示数据集可生成源事实；请创建新演示集，不会重置原数据。"
                )
        count = connection.execute(
            "SELECT count(*) FROM bi.jobs WHERE workspace_id=%s AND dataset_id=%s AND actor_id=%s "
            "AND state IN ('queued','running','awaiting_auth') AND expires_at>clock_timestamp()",
            _where(scope),
        ).fetchone()[0]
        if count >= 3:
            raise OperationConflict("当前已有3个未结束任务，请先完成或取消。")
        job_id = str(uuid4())
        payload = {"parameters": parameters, "files": metadata}
        connection.execute(
            "INSERT INTO bi.jobs(workspace_id,dataset_id,job_id,actor_id,session_id,kind,"
            "base_version,"
            "idempotency_key,request_hash,payload) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                scope.workspace_id,
                scope.dataset_id,
                job_id,
                scope.actor_id,
                scope.session_id,
                kind,
                scope.version,
                idempotency_key,
                digest,
                Jsonb(payload),
            ),
        )
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO bi.job_files VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                [
                    (
                        scope.workspace_id,
                        scope.dataset_id,
                        job_id,
                        index,
                        f.resource,
                        f.filename,
                        f.content,
                        metadata[index]["sha256"],
                    )
                    for index, f in enumerate(files)
                ],
            )
        return public_job(rows(connection, "SELECT * FROM bi.jobs WHERE job_id=%s", (job_id,))[0])


def read_jobs(connection, scope, *, job_id=None, page=1):
    require_idle(connection)
    scope.require("jobs.read")
    if type(page) is not int or not 1 <= page <= 1_000_000:
        raise ValueError("页码无效。")
    if job_id is not None:
        _identifier(job_id)
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        _bind(connection, scope)
        checked_dataset(connection, scope.ledger())
        predicate = "workspace_id=%s AND dataset_id=%s AND actor_id=%s"
        if job_id is not None:
            found = rows(
                connection,
                "SELECT * FROM bi.jobs WHERE " + predicate + " AND job_id=%s",
                (*_where(scope), job_id),
            )
            if not found:
                raise ScopeError("任务不存在或当前身份无权访问。")
            return public_job(found[0])
        count = connection.execute(
            "SELECT count(*) FROM bi.jobs WHERE " + predicate, _where(scope)
        ).fetchone()[0]
        found = rows(
            connection,
            "SELECT * FROM bi.jobs WHERE "
            + predicate
            + " ORDER BY created_at DESC,job_id LIMIT 20 OFFSET %s",
            (*_where(scope), (page - 1) * 20),
        )
        return {
            "rows": [public_job(job) for job in found],
            "page": page,
            "page_size": 20,
            "total": count,
        }


def change_job(connection, scope, job_id, *, action):
    """Explicit cancellation or same-actor fresh-session renewal; never changes input."""
    require_idle(connection)
    scope.require("jobs.read")
    _identifier(job_id)
    if action not in {"cancel", "reauthorize"}:
        raise ValueError("任务操作无效。")
    with connection.transaction():
        _bind(connection, scope)
        current_version = checked_dataset(connection, scope.ledger())
        found = rows(
            connection,
            "SELECT * FROM bi.jobs WHERE workspace_id=%s AND dataset_id=%s "
            "AND actor_id=%s AND job_id=%s FOR NO KEY UPDATE",
            (*_where(scope), job_id),
        )
        if not found:
            raise ScopeError("任务不存在或当前身份无权访问。")
        job = found[0]
        if job["kind"] != "export_standard":
            scope.require("jobs.manage")
        if action == "cancel":
            if job["state"] in TERMINAL:
                return public_job(job)  # Committed never becomes cancelled.
            state = "running" if job["state"] == "running" else "cancelled"
            connection.execute(
                "UPDATE bi.jobs SET state=%s,cancel_requested=true,updated_at=clock_timestamp() "
                "WHERE job_id=%s",
                (state, job_id),
            )
        else:
            if job["state"] != "awaiting_auth" or job["cancel_requested"]:
                raise OperationConflict("只有等待授权且未取消的任务可重新授权。")
            if job["base_version"] != scope.version or current_version != scope.version:
                raise OperationConflict("版本已变化，请重新预览，不会暗中更换版本提交。")
            if job["expires_at"] <= datetime.now(UTC):
                raise OperationConflict("任务已过期，请重新提交。")
            connection.execute(
                "UPDATE bi.jobs SET session_id=%s,state='queued',error_code=NULL,"
                "updated_at=clock_timestamp() WHERE job_id=%s",
                (scope.session_id, job_id),
            )
        return public_job(rows(connection, "SELECT * FROM bi.jobs WHERE job_id=%s", (job_id,))[0])


def _worker(connection):
    require_idle(connection)
    role = connection.execute(
        "SELECT rolsuper,rolbypassrls,"
        "pg_has_role(current_user,'shopgate_bi_worker','MEMBER') "
        "FROM pg_roles WHERE rolname=current_user"
    ).fetchone()
    if role[0] or role[1] or not role[2]:
        raise ScopeError("经营worker必须使用专用非管理员队列角色。")


def release_job_lock(connection, job_id):
    connection.execute(
        "SELECT pg_advisory_unlock(hashtext('shopgate.bi.jobs'),hashtext(%s))", (job_id,)
    )


def claim_job(connection, worker_id, *, lease_seconds=900):
    _worker(connection)
    _identifier(worker_id)
    if type(lease_seconds) is not int or not 1 <= lease_seconds <= 900:
        raise ValueError("任务租约无效。")
    with connection.transaction():
        candidates = rows(
            connection,
            "SELECT * FROM bi.jobs WHERE expires_at>clock_timestamp() AND "
            "(state='queued' OR (state='running' AND lease_until<=clock_timestamp())) "
            "ORDER BY created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 100",
        )
        for job in candidates:
            if not connection.execute(
                "SELECT pg_try_advisory_lock(hashtext('shopgate.bi.jobs'),hashtext(%s))",
                (job["job_id"],),
            ).fetchone()[0]:
                continue
            try:
                claimed = rows(
                    connection,
                    "UPDATE bi.jobs SET state='running',stage='running',lease_owner=%s,"
                    "lease_until=clock_timestamp()+make_interval(secs=>%s),attempts=attempts+1,"
                    "updated_at=clock_timestamp() WHERE job_id=%s RETURNING *",
                    (worker_id, lease_seconds, job["job_id"]),
                )[0]
                claimed["_claim_backend_pid"] = connection.info.backend_pid
                return claimed
            except BaseException:
                release_job_lock(connection, job["job_id"])
                raise
    return None


def _fenced(connection, job, worker_id):
    current = rows(
        connection,
        "SELECT *,lease_until>clock_timestamp() AS lease_valid "
        "FROM bi.jobs WHERE job_id=%s FOR NO KEY UPDATE",
        (job["job_id"],),
    )
    if (
        not current
        or current[0]["state"] != "running"
        or current[0]["lease_owner"] != worker_id
        or not current[0]["lease_valid"]
    ):
        raise OperationConflict("任务执行权已变化，不能提交旧执行结果。")
    if current[0]["cancel_requested"]:
        raise JobCancelled()
    return current[0]


def _finish(connection, job, worker_id, state, result, authorize, secret):
    current = _fenced(connection, job, worker_id)
    grant = authorize(current, "commit")
    verify_grant(grant, secret, current, "commit")
    connection.execute(
        "UPDATE bi.jobs SET state=%s,stage=%s,result=%s,error_code=NULL,lease_owner=NULL,"
        "lease_until=NULL,updated_at=clock_timestamp() WHERE job_id=%s",
        (state, state, Jsonb(result), job["job_id"]),
    )


def execute_job(connection, job, worker_id, authorize, secret, *, demo_allowed=False):
    """Must use the same worker connection that holds the claim's session lock."""
    _worker(connection)
    if job.get("_claim_backend_pid") != connection.info.backend_pid:
        raise ScopeError("任务必须由持有领取锁的同一worker连接执行。")
    try:
        with connection.transaction():
            current = _fenced(connection, job, worker_id)
        if current["request_hash"] != payload_hash(
            {
                "kind": current["kind"],
                "version": current["base_version"],
                "parameters": current["payload"]["parameters"],
                "files": current["payload"]["files"],
            }
        ):
            raise OperationConflict("任务输入摘要不一致。")
        job = current
        verify_grant(authorize(job, "start"), secret, job, "start")
        scope = JobScope(
            job["workspace_id"],
            job["dataset_id"],
            job["actor_id"],
            job["base_version"],
            frozenset({"jobs.read", "jobs.manage"})
            if job["kind"] != "export_standard"
            else frozenset({"jobs.read"}),
            job["session_id"],
        )
        parameters = job["payload"]["parameters"]
        if job["kind"] in {"preview_import", "prepare_demo"}:
            if job["kind"] == "prepare_demo":
                if demo_allowed is not True:
                    raise ScopeError("当前worker不允许演示生成。")
                with connection.transaction():
                    _bind(connection, scope)
                    if checked_dataset(connection, scope.ledger()) != scope.version:
                        raise OperationConflict("数据已更新，请重新预览。")
                    if (
                        connection.execute("SELECT source_kind FROM bi.datasets").fetchone()[0]
                        != "demo"
                        or scope.version != 1
                    ):
                        raise OperationConflict("只允许为空演示集准备源事实，不能重置原数据。")
                generated = generate_demo(
                    DemoPlan(**{k: v for k, v in parameters.items() if k != "confirmed_by_user"})
                )
                files = demo_files(generated)
            else:
                with connection.transaction():
                    content = rows(
                        connection,
                        "SELECT * FROM bi.job_files WHERE job_id=%s ORDER BY ordinal",
                        (job["job_id"],),
                    )
                    files = [
                        CsvFile(row["resource_type"], row["filename"], bytes(row["content"]))
                        for row in content
                    ]
                _, metadata = _validated("preview_import", {}, files)
                if metadata != job["payload"]["files"]:
                    raise OperationConflict("任务文件摘要不一致。")

            def completed(conn, result):
                final = (
                    {**result, "manifest": generated["manifest"]}
                    if job["kind"] == "prepare_demo"
                    else result
                )
                _finish(
                    conn,
                    job,
                    worker_id,
                    "ready_preview" if result["state"] == "preview" else "rejected",
                    final,
                    authorize,
                    secret,
                )

            preview_import(
                connection,
                scope.ledger(),
                files,
                lifetime_seconds=900,
                on_complete=completed,
                include_impact=True,
            )
        elif job["kind"] == "confirm_import":
            confirm_import(
                connection,
                scope.ledger(),
                parameters["preview_id"],
                f"job:{job['job_id']}",
                confirmed_by_user=parameters["confirmed_by_user"],
                on_complete=lambda conn, result: _finish(
                    conn, job, worker_id, "committed", result, authorize, secret
                ),
            )
        else:
            exported = export_csv12(connection, scope.ledger())
            with connection.transaction():
                _bind(connection, scope)
                _fenced(connection, job, worker_id)
                manifest = []
                for resource in parameters["resources"]:
                    content = exported["files"][resource]
                    digest = hashlib.sha256(content).hexdigest()
                    connection.execute(
                        "INSERT INTO bi.job_outputs VALUES(%s,%s,%s,%s,%s,%s)",
                        (
                            scope.workspace_id,
                            scope.dataset_id,
                            job["job_id"],
                            resource,
                            content,
                            digest,
                        ),
                    )
                    manifest.append({"resource": resource, "bytes": len(content), "sha256": digest})
                _finish(
                    connection,
                    job,
                    worker_id,
                    "completed",
                    {"version": exported["version"], "files": manifest},
                    authorize,
                    secret,
                )
    except (ScopeError, JobCancelled, OperationConflict, ValueError, psycopg.Error) as error:
        # Ledger transaction has rolled back. Only safe categories become durable status.
        with connection.transaction():
            found = rows(
                connection,
                "SELECT * FROM bi.jobs WHERE job_id=%s FOR NO KEY UPDATE",
                (job["job_id"],),
            )
            if found and found[0]["state"] == "running" and found[0]["lease_owner"] == worker_id:
                state = (
                    "cancelled"
                    if found[0]["cancel_requested"] or isinstance(error, JobCancelled)
                    else "awaiting_auth"
                    if isinstance(error, ScopeError)
                    else "failed"
                )
                code = (
                    None
                    if state == "cancelled"
                    else "BI_JOB_AUTH_REQUIRED"
                    if state == "awaiting_auth"
                    else "BI_JOB_CONFLICT"
                    if isinstance(error, OperationConflict)
                    else "BI_JOB_FAILED"
                )
                connection.execute(
                    "UPDATE bi.jobs SET state=%s,stage=%s,error_code=%s,lease_owner=NULL,"
                    "lease_until=NULL,updated_at=clock_timestamp() WHERE job_id=%s",
                    (state, state, code, job["job_id"]),
                )
    finally:
        release_job_lock(connection, job["job_id"])


def download_job_output(connection, scope, job_id, resource):
    require_idle(connection)
    scope.require("jobs.read")
    _identifier(job_id)
    if resource not in SPECS and resource != "errors":
        raise ValueError("下载资源无效。")
    with connection.transaction():
        _bind(connection, scope)
        checked_dataset(connection, scope.ledger())
        found = rows(
            connection,
            "SELECT * FROM bi.jobs WHERE workspace_id=%s AND dataset_id=%s "
            "AND actor_id=%s AND job_id=%s",
            (*_where(scope), job_id),
        )
        if not found:
            raise ScopeError("任务不存在或当前身份无权下载。")
        job = found[0]
        if resource == "errors":
            batch = job["result"].get("batch_id")
            if not batch or job["state"] not in {"ready_preview", "rejected"}:
                raise OperationConflict("此任务尚无可下载的校验结果。")
        else:
            if job["state"] != "completed":
                raise OperationConflict("导出尚未完成。")
            output = rows(
                connection,
                "SELECT content,content_hash FROM bi.job_outputs WHERE job_id=%s "
                "AND resource_type=%s",
                (job_id, resource),
            )
            if not output:
                raise ScopeError("此导出任务不含所选文件。")
            content = bytes(output[0]["content"])
            if hashlib.sha256(content).hexdigest() != output[0]["content_hash"]:
                raise OperationConflict("导出文件校验不一致。")
            return content
    return download_errors(connection, scope.ledger(), batch)
