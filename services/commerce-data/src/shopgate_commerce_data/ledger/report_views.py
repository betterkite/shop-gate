"""Personal report configurations and explicitly bookmarked evidence, scoped to a dataset."""

from dataclasses import asdict
from datetime import UTC, datetime
from uuid import UUID

from psycopg.types.json import Jsonb

from .operations import OperationConflict, bind_scope, checked_dataset
from .recalculation import rows
from .reports import Report
from .scope import ScopeError


def identifier(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("保存的视图编号无效。")
    return value


def view_name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 120:
        raise ValueError("请输入 1 至 120 个字的名称。")
    return value.strip()


def public(record):
    config = record["config"]
    return {
        "view_id": record["view_id"],
        "name": record["name"],
        "report_type": record["report_type"],
        "created_at": record["created_at"].isoformat(),
        "revision": config.get("revision", 1),
        "saved_version": config.get("saved_version"),
        "options": config.get("options", {}),
        "topic": config.get("topic"),
    }


def check_version(connection, scope, *, lock=False):
    bind_scope(connection, scope)
    if checked_dataset(connection, scope, lock=lock) != scope.version:
        raise OperationConflict("数据集已更新，请刷新数据后重试。")


def list_views(connection, scope, page, *, view_id=None):
    if type(page) is not int or not 1 <= page <= 1000000:
        raise ValueError("页码无效。")
    if view_id is not None:
        identifier(view_id)
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        check_version(connection, scope)
        where = "WHERE actor_id=%s AND NOT (config ? 'deleted_at')"
        params = [scope.actor_id]
        if view_id is not None:
            where += " AND view_id=%s"
            params.append(view_id)
        total = connection.execute(
            "SELECT count(*) FROM bi.saved_views " + where, params
        ).fetchone()[0]
        found = rows(
            connection,
            "SELECT * FROM bi.saved_views "
            + where
            + " ORDER BY created_at DESC,view_id LIMIT 20 OFFSET %s",
            (*params, (page - 1) * 20),
        )
        return {"page": page, "page_size": 20, "total": total, "rows": [public(r) for r in found]}


def change_view(
    connection, scope, action, view_id, *, name=None, revision=None, options=None, topic=None
):
    identifier(view_id)
    if action not in ("create", "rename", "delete"):
        raise ValueError("保存操作无效。")
    if action in ("create", "rename"):
        name = view_name(name)
    if action != "create" and (type(revision) is not int or revision < 1):
        raise ValueError("视图版本无效。")
    if action == "create":
        if not isinstance(options, Report):
            raise ValueError("请选择报表和范围。")
        options.validate()
        options = asdict(options)
        options["page"] = 1
        options["columns"] = list(options["columns"])
        options["query"] = {
            k: list(v) if isinstance(v, tuple) else v
            for k, v in options["query"].items()
            if k not in ("metrics", "dimension", "sort", "page", "page_size", "descending")
        }
        if topic is not None:
            if not isinstance(topic, dict) or set(topic) != {
                "conversation_id",
                "run_id",
                "dataset_version",
            }:
                raise ValueError("专题分析引用无效。")
            identifier(topic["run_id"])
            identifier(topic["conversation_id"])
            if (
                type(topic["dataset_version"]) is not int
                or not 1 <= topic["dataset_version"] <= scope.version
            ):
                raise ValueError("专题的数据版本无效。")
    now = datetime.now(UTC).isoformat()
    with connection.transaction():
        check_version(connection, scope, lock=True)
        found = rows(
            connection, "SELECT * FROM bi.saved_views WHERE view_id=%s FOR UPDATE", (view_id,)
        )
        old = found[0] if found else None
        if old and old["actor_id"] != scope.actor_id:
            raise ScopeError("当前账号无法修改此视图。")
        if action == "create":
            if old:
                cfg = old["config"]
                if (
                    old["name"] == name
                    and cfg.get("options") == options
                    and cfg.get("topic") == topic
                    and cfg.get("revision") == 1
                    and "deleted_at" not in cfg
                ):
                    return public(old)
                raise OperationConflict("视图编号已经被使用。")
            cfg = {
                "options": options,
                "topic": topic,
                "revision": 1,
                "saved_version": scope.version,
                "history": [{"action": action, "at": now, "name": name}],
            }
            record = rows(
                connection,
                "INSERT INTO bi.saved_views(workspace_id,dataset_id,view_id,actor_id,name,"
                "report_type,config) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (
                    scope.workspace_id,
                    scope.dataset_id,
                    view_id,
                    scope.actor_id,
                    name,
                    options["report_type"],
                    Jsonb(cfg),
                ),
            )[0]
        else:
            if not old:
                raise ScopeError("视图不存在或当前账号无法修改。")
            cfg = old["config"]
            if cfg.get("revision", 1) != revision or "deleted_at" in cfg:
                raise OperationConflict("视图已经修改，请刷新后重试。")
            cfg["revision"] = revision + 1
            cfg.setdefault("history", []).append(
                {"action": action, "at": now, "name": name or old["name"]}
            )
            if action == "delete":
                cfg["deleted_at"] = now
            record = rows(
                connection,
                "UPDATE bi.saved_views SET config=%s,name=%s "
                "WHERE view_id=%s AND actor_id=%s RETURNING *",
                (Jsonb(cfg), name or old["name"], view_id, scope.actor_id),
            )[0]
        return public(record)
