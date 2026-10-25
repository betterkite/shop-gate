"""CSV exchange over scoped facts, never arbitrary SQL or model-authored mutations.

Preview performs the proposed inserts/calculation inside a rolled-back savepoint.
Only canonical private staging and validation evidence survive. Confirmation repeats
validation under the dataset lock and commits sources, accounting and audit together.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.pq import TransactionStatus
from psycopg.types.json import Jsonb

from shopgate_commerce_data.ledger.csv_contract import (
    DEPENDENCY_ORDER,
    SPECS,
    TEMPLATE_VERSION,
    CsvError,
    CsvFile,
    convert,
    error_csv,
    parse_batch,
    standard_csv,
)
from shopgate_commerce_data.ledger.operations import (
    MutationResult,
    OperationConflict,
    bind_scope,
    checked_dataset,
    confirm_operation,
    create_preview,
)
from shopgate_commerce_data.ledger.recalculation import (
    ALGORITHM_VERSION,
    rebuild_accounting,
    rows,
)
from shopgate_commerce_data.ledger.scope import IDENTIFIER, LedgerScope, ScopeError

# All table/column/identity names are internal constants. CSV headers cannot become SQL.
TABLES = {resource: resource for resource in SPECS if resource != "mappings"}
TABLES["costs"] = "cost_versions"
KEYS = {
    "channels": ("channel_id",),
    "stores": ("store_id",),
    "products": ("product_id",),
    "skus": ("sku_id",),
    "fx_rates": ("rate_id",),
    "costs": ("cost_id",),
    "orders": ("order_id",),
    "order_lines": ("line_id",),
    "refunds": ("refund_id",),
    "expenses": ("expense_id",),
    "targets": ("store_id", "month"),
    "listings": ("listing_id",),
    "mappings": ("mapping_id",),
}
KEYS["cost_versions"] = KEYS["costs"]
LISTING_FIELDS = (
    "listing_id",
    "store_id",
    "platform_sku_id",
    "name",
    "platform_product_id",
    "unit",
)
MAPPING_FIELDS = ("mapping_id", "listing_id", "sku_id", "unit_multiplier", "valid_from", "valid_to")
EMPTY_TEXT = frozenset(
    {"category", "series", "market", "mode", "note", "reason", "platform_product_id"}
)


class ImportValidationError(ValueError):
    def __init__(self, errors: list[CsvError]):
        super().__init__("整批数据校验未通过，未提交任何经营事实。")
        self.errors = [error.public() for error in errors]


def require_idle(connection: psycopg.Connection):
    if connection.info.transaction_status != TransactionStatus.IDLE:
        raise ValueError("数据交换需要独立事务，不能复用未提交的事务。")


def digest_records(records: dict[str, list[dict]]) -> str:
    digest = hashlib.sha256()
    for resource in DEPENDENCY_ORDER:
        for record in records[resource]:
            encoded = json.dumps(
                [resource, record],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()


def canonical(resource: str, record: dict) -> dict:
    result = {}
    for spec in SPECS[resource]:
        value = record.get(spec.name)
        if isinstance(value, datetime):
            value = value.astimezone(UTC).isoformat()
        elif isinstance(value, date):
            value = value.isoformat()
        elif isinstance(value, Decimal):
            value = format(value, "f")
        result[spec.name] = convert(spec, "" if value is None else str(value))
    return result


def insert_or_duplicate(
    connection, scope, table: str, fields: tuple[str, ...], record: dict, resource: str
) -> bool:
    identity = KEYS[table]
    condition = sql.SQL(" AND ").join(
        sql.SQL("{}=%s").format(sql.Identifier(key)) for key in identity
    )
    prefix = (scope.workspace_id, scope.dataset_id)
    selected = rows(
        connection,
        sql.SQL("SELECT * FROM bi.{} WHERE workspace_id=%s AND dataset_id=%s AND ").format(
            sql.Identifier(table)
        )
        + condition,
        (*prefix, *(record[key] for key in identity)),
    )
    if selected:
        expected = canonical(resource, record)
        actual = canonical(resource, {**record, **selected[0]})
        if any(expected[field] != actual[field] for field in fields):
            raise ValueError("同一身份的记录内容不一致；请使用对应维护流程，不会覆盖原记录。")
        return False
    columns = ("workspace_id", "dataset_id", *fields)
    values = [record.get(key) if key not in EMPTY_TEXT else record.get(key) or "" for key in fields]
    if table in {"mappings", "cost_versions"}:
        columns += ("created_version",)
        values.append(scope.version + 1)
    connection.execute(
        sql.SQL("INSERT INTO bi.{} ({}) VALUES ({})").format(
            sql.Identifier(table),
            sql.SQL(",").join(map(sql.Identifier, columns)),
            sql.SQL(",").join(sql.Placeholder() for _ in columns),
        ),
        (*prefix, *values),
    )
    return True


def _apply_rows(connection, scope, records: dict[str, list[dict]]) -> tuple[dict, list[CsvError]]:
    counts = {resource: {"inserted": 0, "duplicates": 0} for resource in SPECS}
    errors = []
    for resource in DEPENDENCY_ORDER:
        for record in records[resource]:
            try:
                # A failed row rolls back its components; the caller owns batch atomicity.
                with connection.transaction():
                    if resource == "mappings":
                        changed = insert_or_duplicate(
                            connection, scope, "listings", LISTING_FIELDS, record, resource
                        )
                        if record["status"] == "mapped":
                            changed = (
                                insert_or_duplicate(
                                    connection, scope, "mappings", MAPPING_FIELDS, record, resource
                                )
                                or changed
                            )
                        elif rows(
                            connection,
                            "SELECT mapping_id FROM bi.mappings WHERE listing_id=%s",
                            (record["listing_id"],),
                        ):
                            raise ValueError("该平台规格已有映射历史，不能以未映射行清除历史。")
                    else:
                        changed = insert_or_duplicate(
                            connection,
                            scope,
                            TABLES[resource],
                            tuple(spec.name for spec in SPECS[resource]),
                            record,
                            resource,
                        )
                counts[resource]["inserted" if changed else "duplicates"] += 1
            except (ValueError, psycopg.IntegrityError) as error:
                # PostgreSQL error details include private source values: do not echo them.
                message = (
                    str(error)
                    if isinstance(error, ValueError)
                    else {
                        "23503": "关联记录不存在或不属于当前店铺/数据集。",
                        "23505": "原始业务身份重复，请检查平台订单号或规格编码等唯一身份。",
                        "23514": "业务约束未通过，请检查精度、范围、时间、累计退款或有效期重叠。",
                        "23502": "必填业务字段缺失。",
                    }.get(error.sqlstate, "数据约束未通过，未写入该记录。")
                )
                errors.append(CsvError(record["_filename"], resource, record["_row"], "", message))
    return counts, errors


IMPORT_CHUNK_SIZE = 500


def _insert_many_or_duplicate(connection, scope, table, fields, entries, resource):
    """Internal bounded fast path; constraints/RLS still run for every INSERT.

    The dataset lock prevents concurrent source changes. Track new identities in
    input order as well as existing facts; do not use ON CONFLICT to hide conflicts.
    A failed chunk is rolled back before the original row-by-row diagnostic path.
    """
    if not entries:
        return []
    identity = KEYS[table]
    conditions = sql.SQL(" OR ").join(
        sql.SQL("({})").format(
            sql.SQL(" AND ").join(sql.SQL("{}=%s").format(sql.Identifier(key)) for key in identity)
        )
        for _ in entries
    )
    selected = rows(
        connection,
        sql.SQL("SELECT * FROM bi.{} WHERE workspace_id=%s AND dataset_id=%s AND ({})").format(
            sql.Identifier(table), conditions
        ),
        (
            scope.workspace_id,
            scope.dataset_id,
            *(record[key] for record in entries for key in identity),
        ),
    )
    existing = {}
    for record in selected:
        # Mapping CSV combines listing + mapping fields, unlike either SQL table.
        value = canonical(resource, {**entries[0], **record})
        existing[tuple(value[key] for key in identity)] = record
    changes, new_rows = [], []
    for record in entries:
        expected = canonical(resource, record)
        key = tuple(expected[name] for name in identity)
        if key in existing:
            actual = canonical(resource, {**record, **existing[key]})
            if any(expected[field] != actual[field] for field in fields):
                raise ValueError("同一身份的记录内容不一致；请使用对应维护流程，不会覆盖原记录。")
            changes.append(False)
        else:
            existing[key] = record
            new_rows.append(record)
            changes.append(True)
    if new_rows:
        columns = ("workspace_id", "dataset_id", *fields)
        versioned = table in {"mappings", "cost_versions"}
        if versioned:
            columns += ("created_version",)
        statement = sql.SQL("INSERT INTO bi.{} ({}) VALUES ({})").format(
            sql.Identifier(table),
            sql.SQL(",").join(map(sql.Identifier, columns)),
            sql.SQL(",").join(sql.Placeholder() for _ in columns),
        )
        with connection.cursor() as cursor:
            cursor.executemany(
                statement,
                [
                    (
                        scope.workspace_id,
                        scope.dataset_id,
                        *[
                            record.get(key) if key not in EMPTY_TEXT else record.get(key) or ""
                            for key in fields
                        ],
                        *((scope.version + 1,) if versioned else ()),
                    )
                    for record in new_rows
                ],
            )
    return changes


def _apply_chunk(connection, scope, resource, entries):
    if resource != "mappings":
        return _insert_many_or_duplicate(
            connection,
            scope,
            TABLES[resource],
            tuple(spec.name for spec in SPECS[resource]),
            entries,
            resource,
        )
    changed = _insert_many_or_duplicate(
        connection, scope, "listings", LISTING_FIELDS, entries, resource
    )
    mapped = [record for record in entries if record["status"] == "mapped"]
    mapping_changes = iter(
        _insert_many_or_duplicate(connection, scope, "mappings", MAPPING_FIELDS, mapped, resource)
    )
    for index, record in enumerate(entries):
        if record["status"] == "mapped":
            changed[index] = next(mapping_changes) or changed[index]
    unmapped = [record["listing_id"] for record in entries if record["status"] != "mapped"]
    if unmapped and rows(
        connection,
        "SELECT mapping_id FROM bi.mappings WHERE listing_id=ANY(%s) LIMIT 1",
        (unmapped,),
    ):
        raise ValueError("该平台规格已有映射历史，不能以未映射行清除历史。")
    return changed


def apply_records(connection, scope, records: dict[str, list[dict]]) -> tuple[dict, list[CsvError]]:
    counts = {resource: {"inserted": 0, "duplicates": 0} for resource in SPECS}
    errors = []
    for resource in DEPENDENCY_ORDER:
        for offset in range(0, len(records[resource]), IMPORT_CHUNK_SIZE):
            entries = records[resource][offset : offset + IMPORT_CHUNK_SIZE]
            try:
                with connection.transaction():
                    changes = _apply_chunk(connection, scope, resource, entries)
                counts[resource]["inserted"] += sum(changes)
                counts[resource]["duplicates"] += len(changes) - sum(changes)
            except ValueError, psycopg.IntegrityError:
                # The whole fast chunk was rolled back, including earlier successful INSERTs.
                # Retry in original order to preserve exact filename/row and dependency errors.
                fallback = {name: entries if name == resource else [] for name in SPECS}
                row_counts, row_errors = _apply_rows(connection, scope, fallback)
                for key in counts[resource]:
                    counts[resource][key] += row_counts[resource][key]
                errors.extend(row_errors)
    return counts, errors


def rebuild_import(connection, scope):
    # New paid lines get snapshots; source repair never silently rewrites existing line history.
    result = rebuild_accounting(connection, scope, revision=scope.version + 1, line_ids=[])
    if not result["changed"]:
        # Metadata/target changes still produce a consistent same-facts accounting watermark.
        connection.execute(
            "INSERT INTO bi.accounting_runs(workspace_id,dataset_id,revision,"
            "algorithm_version,processed_lines,processed_expenses) "
            "VALUES (%s,%s,%s,%s,0,0)",
            (scope.workspace_id, scope.dataset_id, scope.version + 1, ALGORITHM_VERSION),
        )
    return result


def preview_import(
    connection: psycopg.Connection,
    scope: LedgerScope,
    files: list[CsvFile],
    *,
    lifetime_seconds: int = 300,
    on_complete=None,
    include_impact=False,
) -> dict:
    scope.require("ledger.manage")
    require_idle(connection)
    if type(lifetime_seconds) is not int or not 1 <= lifetime_seconds <= 900:
        raise ValueError("预览期限无效。")
    records, errors = parse_batch(files)
    batch_id = str(uuid4())
    digest = digest_records(records)
    summary = {resource: {"inserted": 0, "duplicates": 0} for resource in SPECS}
    accounting = None
    impact = None
    if type(include_impact) is not bool:
        raise ValueError("预览范围无效。")
    with connection.transaction():
        bind_scope(connection, scope)
        connection.execute("SELECT set_config('statement_timeout','60000',true)")
        if checked_dataset(connection, scope, lock=True) != scope.version:
            raise OperationConflict("数据已更新，请刷新后重新预览。")
        if include_impact:
            from shopgate_commerce_data.ledger.query import Query, query_ledger

            impact_query = Query(start="0001-01-01", end="9999-12-31")
            before = query_ledger(connection, scope, impact_query, _preview_transaction=True)[
                "summary"
            ]
        with connection.transaction(force_rollback=True):
            summary, relational_errors = apply_records(connection, scope, records)
            errors.extend(relational_errors)
            if not errors and any(count["inserted"] for count in summary.values()):
                try:
                    accounting = rebuild_import(connection, scope)
                    if include_impact:
                        from dataclasses import replace

                        connection.execute(
                            "UPDATE bi.datasets SET version=%s", (scope.version + 1,)
                        )
                        after = query_ledger(
                            connection,
                            replace(scope, version=scope.version + 1),
                            impact_query,
                            _preview_transaction=True,
                        )["summary"]
                        impact = {
                            "before": before,
                            "after": after,
                            "notice": "全部源事实范围的导入前后试算；未知不补零，尚未写入账本。",
                        }
                except ValueError, psycopg.IntegrityError:
                    errors.append(
                        CsvError(
                            "",
                            "accounting",
                            0,
                            "",
                            "核算未通过；请检查单位换算精度或金额范围，整批未提交。",
                        )
                    )
        if include_impact and not errors and impact is None:
            impact = {
                "before": before,
                "after": before,
                "notice": "没有新增事实，不改变指标或数据版本。",
            }
        evidence = {
            "resources": summary,
            "accounting": accounting,
            "impact": impact,
            "files": [
                {
                    "resource": file.resource,
                    "filename": file.filename,
                    "sha256": hashlib.sha256(file.content).hexdigest(),
                }
                for file in files
            ],
            "template_version": TEMPLATE_VERSION,
        }
        connection.execute(
            "INSERT INTO bi.import_batches(workspace_id,dataset_id,batch_id,actor_id,"
            "resource_type,content_hash,state,row_count,error_count,result,version,errors,"
            "expires_at) VALUES (%s,%s,%s,%s,'bundle',%s,%s,%s,%s,%s,%s,%s,"
            "clock_timestamp()+%s)",
            (
                scope.workspace_id,
                scope.dataset_id,
                batch_id,
                scope.actor_id,
                digest,
                "rejected" if errors else "preview",
                sum(map(len, records.values())),
                len(errors),
                Jsonb(evidence),
                scope.version,
                Jsonb([error.public() for error in errors]),
                timedelta(seconds=lifetime_seconds),
            ),
        )
        # Immutable canonical staging is scoped in PG, not raw upload files in Git or model context.
        for resource, entries in records.items():
            if entries:
                with connection.cursor() as cursor:
                    cursor.executemany(
                        "INSERT INTO bi.import_rows VALUES (%s,%s,%s,%s,%s,%s)",
                        [
                            (
                                scope.workspace_id,
                                scope.dataset_id,
                                batch_id,
                                resource,
                                ordinal,
                                Jsonb(record),
                            )
                            for ordinal, record in enumerate(entries, 1)
                        ],
                    )
        preview_id = None
        if not errors:
            preview_id = create_preview(
                connection,
                scope,
                "import",
                {
                    "batch_id": batch_id,
                    "content_hash": digest,
                    "template_version": TEMPLATE_VERSION,
                },
                evidence,
                lifetime_seconds=lifetime_seconds,
            )
            connection.execute(
                "UPDATE bi.import_batches SET preview_id=%s WHERE batch_id=%s",
                (preview_id, batch_id),
            )
        result = {
            "batch_id": batch_id,
            "template_version": TEMPLATE_VERSION,
            "source_files": evidence["files"],
            "preview_id": preview_id,
            "preview_expires_at": (
                connection.execute(
                    "SELECT expires_at FROM bi.operation_previews WHERE preview_id=%s",
                    (preview_id,),
                )
                .fetchone()[0]
                .isoformat()
                if preview_id
                else None
            ),
            "state": "rejected" if errors else "preview",
            "version": scope.version,
            "summary": summary,
            "accounting": accounting,
            "impact": impact,
            "error_count": len(errors),
            "errors": [error.public() for error in errors[:100]],
        }
        if on_complete is not None:
            on_complete(connection, result)
    return result


def confirm_import(
    connection: psycopg.Connection,
    scope: LedgerScope,
    preview_id: str,
    idempotency_key: str,
    *,
    confirmed_by_user: bool,
    on_complete=None,
) -> dict:
    require_idle(connection)

    def apply(connection, kind, payload):
        if kind != "import" or payload.get("template_version") != TEMPLATE_VERSION:
            raise OperationConflict("不是当前版本的数据导入预览。")
        batch = rows(
            connection,
            "SELECT *,expires_at<=clock_timestamp() AS expired "
            "FROM bi.import_batches WHERE batch_id=%s FOR UPDATE",
            (payload["batch_id"],),
        )
        if not batch or batch[0]["actor_id"] != scope.actor_id:
            raise ScopeError("当前身份无权提交该导入批次。")
        batch = batch[0]
        if batch["state"] != "preview" or batch["expired"] or batch["preview_id"] != preview_id:
            raise OperationConflict("导入批次不可提交或已过期。")
        records = {resource: [] for resource in SPECS}
        for row in rows(
            connection,
            "SELECT resource_type,record FROM bi.import_rows "
            "WHERE batch_id=%s ORDER BY resource_type,row_number",
            (payload["batch_id"],),
        ):
            records[row["resource_type"]].append(row["record"])
        if (
            digest_records(records) != payload["content_hash"]
            or batch["content_hash"] != payload["content_hash"]
        ):
            raise OperationConflict("暂存内容校验不一致，请重新预览。")
        connection.execute("SELECT set_config('statement_timeout','60000',true)")
        summary, errors = apply_records(connection, scope, records)
        if errors:
            raise ImportValidationError(errors)
        changed = any(count["inserted"] for count in summary.values())
        accounting = rebuild_import(connection, scope) if changed else None
        result = {"batch_id": payload["batch_id"], "resources": summary, "accounting": accounting}
        connection.execute(
            "UPDATE bi.import_batches SET state='committed',result=%s,version=%s WHERE batch_id=%s",
            (Jsonb(result), scope.version + int(changed), payload["batch_id"]),
        )
        return MutationResult(changed, result)

    return confirm_operation(
        connection,
        scope,
        preview_id,
        idempotency_key,
        confirmed_by_user=confirmed_by_user,
        apply=apply,
        on_complete=on_complete,
    )


def export_csv12(connection: psycopg.Connection, scope: LedgerScope) -> dict:
    """Complete facts, not a current-page export; one read-only consistent version."""
    require_idle(connection)
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        bind_scope(connection, scope)
        if checked_dataset(connection, scope) != scope.version:
            raise OperationConflict("数据已更新，请刷新后重新导出。")
        result = {}
        for resource in SPECS:
            if resource == "mappings":
                records = rows(
                    connection,
                    "SELECT l.*,m.mapping_id,m.sku_id,m.unit_multiplier,"
                    "m.valid_from,m.valid_to,CASE WHEN m.mapping_id IS NULL THEN 'unmapped' "
                    "ELSE 'mapped' END AS status FROM bi.listings l LEFT JOIN bi.mappings m "
                    "USING(workspace_id,dataset_id,listing_id) "
                    "ORDER BY l.listing_id,m.valid_from,m.mapping_id",
                )
            else:
                records = rows(
                    connection,
                    sql.SQL("SELECT * FROM bi.{} ORDER BY {}").format(
                        sql.Identifier(TABLES[resource]),
                        sql.SQL(",").join(map(sql.Identifier, KEYS[TABLES[resource]])),
                    ),
                )
            result[resource] = standard_csv(
                resource, [canonical(resource, record) for record in records]
            )
        return {"dataset_id": scope.dataset_id, "version": scope.version, "files": result}


def list_batches(connection: psycopg.Connection, scope: LedgerScope, *, page: int = 1) -> dict:
    require_idle(connection)
    if type(page) is not int or not 1 <= page <= 1_000_000:
        raise ValueError("页码无效。")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        bind_scope(connection, scope)
        version = checked_dataset(connection, scope)
        count = connection.execute("SELECT count(*) FROM bi.import_batches").fetchone()[0]
        records = rows(
            connection,
            "SELECT batch_id,actor_id,resource_type,state,row_count,error_count,"
            "version,created_at,expires_at,expires_at<=clock_timestamp() AS expired "
            "FROM bi.import_batches ORDER BY created_at DESC,batch_id LIMIT 20 OFFSET %s",
            ((page - 1) * 20,),
        )
        return {"version": version, "page": page, "page_size": 20, "total": count, "rows": records}


def download_errors(connection: psycopg.Connection, scope: LedgerScope, batch_id: str) -> bytes:
    require_idle(connection)
    if not isinstance(batch_id, str) or not IDENTIFIER.fullmatch(batch_id):
        raise ValueError("批次标识无效。")
    with connection.transaction():
        bind_scope(connection, scope)
        checked_dataset(connection, scope)
        records = rows(
            connection,
            "SELECT actor_id,errors FROM bi.import_batches WHERE batch_id=%s",
            (batch_id,),
        )
        if not records or records[0]["actor_id"] != scope.actor_id:
            raise ScopeError("批次不存在或当前身份无权下载。")
        return error_csv(records[0]["errors"])
