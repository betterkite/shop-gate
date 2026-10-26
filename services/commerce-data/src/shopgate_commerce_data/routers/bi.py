"""Private, signed BI service endpoints; no browser identity or startup DDL.

Long import/export/demo work is deliberately not implemented as a blocking POST.
The same-origin Node gateway supplies purpose-bound tokens, never browser headers.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass, fields
from uuid import uuid4

import psycopg
from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.concurrency import run_in_threadpool

from shopgate_commerce_data.ledger.csv_contract import (
    MAX_BATCH_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    SPECS,
    CsvFile,
    description,
    standard_csv,
)
from shopgate_commerce_data.ledger.datasets import (
    DatasetPlan,
    create_dataset,
    dataset_metadata,
    list_datasets,
)
from shopgate_commerce_data.ledger.exchange import batch_history, download_errors
from shopgate_commerce_data.ledger.job_scope import verify_job_scope
from shopgate_commerce_data.ledger.jobs import (
    change_job,
    download_job_output,
    read_jobs,
    submit_job,
)
from shopgate_commerce_data.ledger.metrics import metric_catalog
from shopgate_commerce_data.ledger.operations import OperationConflict
from shopgate_commerce_data.ledger.query import Query, query_ledger
from shopgate_commerce_data.ledger.scope import (
    ScopeError,
    verify_directory_token,
    verify_scope_token,
)

LOG = logging.getLogger(__name__)
MAX_JSON_BYTES = 64 * 1024
MAX_UPLOAD_JSON_BYTES = 4 * ((MAX_BATCH_BYTES + 2) // 3) + MAX_JSON_BYTES
HEADERS = {"Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff"}


class BiUnavailable(Exception):
    pass


class BiInputError(Exception):
    def __init__(self, code="BI_INPUT_INVALID", status=422):
        self.code, self.status = code, status


@dataclass(frozen=True)
class BiSettings:
    database_url: str
    secret: str
    demo_allowed: bool = False

    @classmethod
    def from_environment(cls):
        # No DATABASE_URL fallback: that legacy connection may have admin privileges.
        mode = os.getenv("SHOPGATE_BI_DEMO_ENABLED", "0")
        if mode not in {"0", "1"}:
            raise BiUnavailable()
        return cls(
            os.getenv("SHOPGATE_BI_DATABASE_URL", ""),
            os.getenv("SHOPGATE_BI_SERVICE_SECRET", ""),
            mode == "1",
        )

    def token(self, request):
        if not isinstance(self.secret, str) or len(self.secret.encode()) < 32:
            raise BiUnavailable()
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            raise ScopeError("Missing service scope.")
        return header[7:]

    def connection(self):
        if not isinstance(self.database_url, str) or not self.database_url:
            raise BiUnavailable()
        connection = psycopg.connect(
            self.database_url,
            autocommit=True,
            connect_timeout=5,
            options="-c statement_timeout=15000 -c lock_timeout=5000",
        )
        try:
            role = connection.execute(
                "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
            ).fetchone()
            if role[0] or role[1]:
                raise BiUnavailable()
        except Exception:
            connection.close()
            raise
        return connection


def error_response(code, status, request_id):
    messages = {
        "BI_SCOPE_DENIED": "授权无效、已过期或无权访问，请重新登录后重试。",
        "BI_CONFLICT": "数据或请求已变化，请刷新并重新确认；未覆盖已有记录。",
        "BI_UNAVAILABLE": "经营数据服务尚未就绪，请联系管理员检查配置与迁移。",
        "BI_TIMEOUT": "本次操作超时，请刷新检查状态；创建重试须使用原请求标识。",
        "BI_INPUT_TOO_LARGE": "请求内容过大，请减少筛选对象或使用数据导入入口。",
        "BI_INPUT_INVALID": "请求参数无效，请检查名称、来源、日期、指标和筛选条件。",
        "BI_MEDIA_UNSUPPORTED": "此接口只接受未压缩的 JSON 请求。",
        "BI_INTERNAL_ERROR": "经营数据处理失败，请稍后重试并提供本次请求编号。",
    }
    return JSONResponse(
        {"success": False, "error": code, "message": messages[code], "request_id": request_id},
        status_code=status,
        headers={**HEADERS, "X-Request-ID": request_id},
    )


class SafeBiRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def safe(request):
            request_id = str(uuid4())  # Not a caller-controlled log value.
            try:
                response = await handler(request)
                response.headers.update({**HEADERS, "X-Request-ID": request_id})
                return response
            except BiInputError as error:
                code, status = error.code, error.status
            except ScopeError:
                code, status = "BI_SCOPE_DENIED", 403
            except OperationConflict:
                code, status = "BI_CONFLICT", 409
            except RequestValidationError, ValidationError, ValueError, TypeError:
                code, status = "BI_INPUT_INVALID", 422
            except psycopg.errors.QueryCanceled:
                code, status = "BI_TIMEOUT", 504
            except BiUnavailable, psycopg.Error:
                code, status = "BI_UNAVAILABLE", 503
            except Exception:
                code, status = "BI_INTERNAL_ERROR", 500
            # Never log SQL, exception repr, request bodies, DSNs or service tokens.
            LOG.warning("BI request %s outcome %s", request_id, code)
            return error_response(code, status, request_id)

        return safe


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BiInputError()
        result[key] = value
    return result


async def read_json(request, *, limit=MAX_JSON_BYTES):
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json" or (
        request.headers.get("content-encoding", "identity") != "identity"
    ):
        raise BiInputError("BI_MEDIA_UNSUPPORTED", 415)
    declared = request.headers.get("content-length")
    if declared is not None:
        if not declared.isascii() or not declared.isdigit():
            raise BiInputError()
        if len(declared) > 10 or int(declared) > limit:
            raise BiInputError("BI_INPUT_TOO_LARGE", 413)
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise BiInputError("BI_INPUT_TOO_LARGE", 413)
        body.extend(chunk)
    try:
        result = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda _: (_ for _ in ()).throw(BiInputError()),
        )
    except (UnicodeError, ValueError, RecursionError) as error:
        raise BiInputError() from error
    if not isinstance(result, dict):
        raise BiInputError()
    return result


class DatasetInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    dataset_id: str
    name: str
    source_kind: str
    idempotency_key: str
    confirmed_by_user: bool


class JobFileInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    resource: str
    filename: str
    content_base64: str


class JobInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    kind: str
    parameters: dict
    idempotency_key: str
    files: list[JobFileInput] = []


def decode_files(files):
    if len(files) > MAX_FILES:
        raise BiInputError("BI_INPUT_TOO_LARGE", 413)
    result, total = [], 0
    for file in files:
        if len(file.content_base64) > 4 * ((MAX_FILE_BYTES + 2) // 3):
            raise BiInputError("BI_INPUT_TOO_LARGE", 413)
        try:
            content = base64.b64decode(file.content_base64, validate=True)
        except (ValueError, UnicodeError) as error:
            raise BiInputError() from error
        total += len(content)
        if len(content) > MAX_FILE_BYTES or total > MAX_BATCH_BYTES:
            raise BiInputError("BI_INPUT_TOO_LARGE", 413)
        result.append(CsvFile(file.resource, file.filename, content))
    return result


def query_input(value):
    if not isinstance(value, dict) or not set(value).issubset({f.name for f in fields(Query)}):
        raise BiInputError()
    values = dict(value)
    for key in ("metrics", "channel_ids", "store_ids", "product_ids", "sku_ids", "listing_ids"):
        if key in values:
            if not isinstance(values[key], list) or len(values[key]) > 100:
                raise BiInputError()
            values[key] = tuple(values[key])
    # Validate types before Query membership checks; no list/dict hashing failures.
    for key in ("dimension", "refund_basis", "sort", "search"):
        if key in values and not isinstance(values[key], str):
            raise BiInputError()
    if "metrics" in values and any(not isinstance(x, str) for x in values["metrics"]):
        raise BiInputError()
    query = Query(**values)
    query.validate()
    if query.page > 1_000_000 or query.page_size > 100:
        raise BiInputError()
    return query


def directory_params(request):
    allowed = {"page", "page_size", "source_kind"}
    if any(key not in allowed for key in request.query_params):
        raise BiInputError()
    if any(len(request.query_params.getlist(key)) != 1 for key in request.query_params):
        raise BiInputError()
    result = {}
    for key in ("page", "page_size"):
        value = request.query_params.get(key)
        if value is not None:
            if not value.isascii() or not value.isdigit() or len(value) > 7:
                raise BiInputError()
            result[key] = int(value)
    if "source_kind" in request.query_params:
        result["source_kind"] = request.query_params["source_kind"]
    return result


def create_bi_router(settings: BiSettings | None = None):
    router = APIRouter(prefix="/api/v1/bi", tags=["bi"], route_class=SafeBiRoute)

    def configured():
        return settings if settings is not None else BiSettings.from_environment()

    @router.get("/batches")
    @router.get("/batches/{batch_id}")
    async def batches(request: Request, batch_id: str | None = None):
        config = configured()
        token = config.token(request)
        verify_scope_token(token, config.secret).require("ledger.read")
        allowed = set() if batch_id is not None else {"page"}
        if set(request.query_params) - allowed or len(request.query_params.getlist("page")) > 1:
            raise BiInputError()
        page = request.query_params.get("page", "1")
        if not page.isascii() or not page.isdigit() or len(page) > 7:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return batch_history(
                    connection,
                    verify_scope_token(token, config.secret),
                    page=int(page),
                    batch_id=batch_id,
                )

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.get("/batches/{batch_id}/errors")
    async def batch_errors(batch_id: str, request: Request):
        config = configured()
        token = config.token(request)
        verify_scope_token(token, config.secret).require("ledger.read")
        if request.query_params:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return download_errors(
                    connection, verify_scope_token(token, config.secret), batch_id
                )

        return Response(
            await run_in_threadpool(execute),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="shopgate-errors-v1.csv"'},
        )

    @router.post("/jobs", status_code=202)
    async def submit(request: Request):
        config = configured()
        token = config.token(request)
        verify_job_scope(token, config.secret).require("jobs.read")
        value = JobInput.model_validate(await read_json(request, limit=MAX_UPLOAD_JSON_BYTES))

        def execute():
            scope = verify_job_scope(token, config.secret)
            files = decode_files(value.files)
            with config.connection() as connection:
                return submit_job(
                    connection,
                    scope,
                    value.kind,
                    value.parameters,
                    value.idempotency_key,
                    files=files,
                    demo_allowed=config.demo_allowed,
                )

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.get("/jobs")
    async def jobs(request: Request):
        config = configured()
        token = config.token(request)
        verify_job_scope(token, config.secret).require("jobs.read")
        if set(request.query_params) - {"page"} or len(request.query_params.getlist("page")) > 1:
            raise BiInputError()
        page = request.query_params.get("page", "1")
        if not page.isascii() or not page.isdigit() or len(page) > 7:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return read_jobs(connection, verify_job_scope(token, config.secret), page=int(page))

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.get("/jobs/{job_id}")
    async def job(job_id: str, request: Request):
        config = configured()
        token = config.token(request)
        verify_job_scope(token, config.secret).require("jobs.read")
        if request.query_params:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return read_jobs(connection, verify_job_scope(token, config.secret), job_id=job_id)

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.post("/jobs/{job_id}/{action}")
    async def change(job_id: str, action: str, request: Request):
        config = configured()
        token = config.token(request)
        verify_job_scope(token, config.secret).require("jobs.read")
        if action not in {"cancel", "reauthorize"} or await read_json(request) != {}:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return change_job(
                    connection, verify_job_scope(token, config.secret), job_id, action=action
                )

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.get("/jobs/{job_id}/files/{resource}")
    async def download(job_id: str, resource: str, request: Request):
        config = configured()
        token = config.token(request)
        verify_job_scope(token, config.secret).require("jobs.read")
        if request.query_params:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return download_job_output(
                    connection, verify_job_scope(token, config.secret), job_id, resource
                )

        content = await run_in_threadpool(execute)
        return Response(
            content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="shopgate-{resource}-v1.csv"'},
        )

    @router.get("/datasets")
    async def datasets(request: Request):
        config = configured()
        token = config.token(request)
        verify_directory_token(token, config.secret).require("datasets.read")
        params = directory_params(request)

        def execute():
            scope = verify_directory_token(token, config.secret)
            with config.connection() as connection:
                return list_datasets(connection, scope, **params)

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.post("/datasets")
    async def create(request: Request):
        config = configured()
        token = config.token(request)
        verify_directory_token(token, config.secret).require("datasets.manage")
        value = DatasetInput.model_validate(await read_json(request))

        def execute():
            scope = verify_directory_token(token, config.secret)
            with config.connection() as connection:
                return create_dataset(
                    connection,
                    scope,
                    DatasetPlan(value.dataset_id, value.name, value.source_kind),
                    value.idempotency_key,
                    confirmed_by_user=value.confirmed_by_user,
                    demo_allowed=config.demo_allowed,
                )

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.get("/datasets/{dataset_id}")
    async def metadata(dataset_id: str, request: Request):
        config = configured()
        token = config.token(request)
        verify_directory_token(token, config.secret).require("datasets.read")
        if request.query_params:
            raise BiInputError()

        def execute():
            with config.connection() as connection:
                return dataset_metadata(
                    connection, verify_directory_token(token, config.secret), dataset_id
                )

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.post("/query")
    async def query(request: Request):
        config = configured()
        token = config.token(request)
        verify_scope_token(token, config.secret).require("ledger.read")
        parsed = query_input(await read_json(request))

        def execute():
            scope = verify_scope_token(token, config.secret)
            with config.connection() as connection:
                return query_ledger(connection, scope, parsed)

        return {"success": True, "data": await run_in_threadpool(execute)}

    @router.get("/catalog")
    async def catalog(request: Request):
        config = configured()
        verify_directory_token(config.token(request), config.secret).require("datasets.read")
        if request.query_params:
            raise BiInputError()
        return {
            "success": True,
            "data": {"metrics": metric_catalog(), "templates": [description(key) for key in SPECS]},
        }

    @router.get("/templates/{resource}")
    async def template(resource: str, request: Request):
        config = configured()
        verify_directory_token(config.token(request), config.secret).require("datasets.read")
        if resource not in SPECS or request.query_params:
            raise BiInputError()
        return Response(
            standard_csv(resource, []),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="shopgate-{resource}-v1.csv"'},
        )

    return router
