"""Human-confirmed historical recalculation and scoped, paged maintenance history."""

from dataclasses import replace

from .operations import OperationConflict
from .query import ledger_read_snapshot
from .recalculation import confirm_recalculation, preview_recalculation, rows
from .scope import IDENTIFIER


def preview_cost_recalculation(conn, scope, query, sku_ids, only_missing):
    scope.require("ledger.manage")
    if (
        not isinstance(sku_ids, list)
        or len(sku_ids) > 1000
        or any(not isinstance(s, str) or not IDENTIFIER.fullmatch(s) for s in sku_ids)
        or len(set(sku_ids)) != len(sku_ids)
        or type(only_missing) is not bool
    ):
        raise ValueError("请选择有效的规格和重算范围。")
    selected = set(sku_ids)
    with ledger_read_snapshot(conn, scope) as read:
        events, _, span, _ = read.selected_events(replace(query, refund_basis="payment"))
        ids = sorted(
            {
                e["line_id"]
                for e in events
                if e["kind"] == "sale"
                and (not selected or e["sku_id"] in selected)
                and (not only_missing or not e["complete"])
            }
        )
    if not ids:
        raise ValueError("当前规格、付款期间及所选条件下没有需要重算的付款明细。")
    preview = preview_recalculation(conn, scope, line_ids=ids, only_missing=only_missing)
    with ledger_read_snapshot(conn, scope):
        row = rows(
            conn,
            "SELECT impact,expires_at FROM bi.operation_previews WHERE preview_id=%s"
            " AND actor_id=%s",
            (preview, scope.actor_id),
        )[0]
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "version": scope.version,
        "preview_id": preview,
        "expires_at": row["expires_at"].isoformat(),
        "impact": {**row["impact"], "range": span},
    }


def confirm_cost_recalculation(conn, scope, preview_id, idempotency_key, *, confirmed_by_user):
    result = confirm_recalculation(
        conn, scope, preview_id, idempotency_key, confirmed_by_user=confirmed_by_user
    )
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "accounting_revision": result["version"],
        **result,
    }


def cost_operations(conn, scope, page=1, preview_id=None):
    if (
        type(page) is not int
        or not 1 <= page <= 1_000_000
        or preview_id is not None
        and (not isinstance(preview_id, str) or not IDENTIFIER.fullmatch(preview_id))
    ):
        raise ValueError("维护记录页码或编号无效。")
    with ledger_read_snapshot(conn, scope):
        join = (
            " FROM bi.operations o JOIN bi.operation_previews p"
            " USING(workspace_id,dataset_id,preview_id)"
            " WHERE p.kind IN ('costs','recalculate')"
        )
        if preview_id:
            detail = rows(
                conn,
                "SELECT p.kind,p.impact,o.result,p.payload,o.actor_id"
                + join
                + " AND o.preview_id=%s",
                (preview_id,),
            )
            if not detail:
                raise OperationConflict("当前数据集中没有这条已确认维护记录。")
            detail = detail[0]
            if detail["kind"] == "costs":
                entries = [
                    {
                        "key": i["sku_id"],
                        "name": i["name"],
                        "before": i["previous"],
                        "after": i["unit_cost"],
                        "unit": i["unit"],
                    }
                    for i in detail["impact"]["items"]
                ]
            else:
                entries = [{"key": i} for i in (detail["payload"].get("line_ids") or [])]
            items = entries[(page - 1) * 20 : page * 20]
            count = len(entries)
        else:
            count = rows(conn, "SELECT count(*) AS n" + join)[0]["n"]
            items = rows(
                conn,
                "SELECT o.preview_id,o.actor_id,o.committed_version,p.kind,p.consumed_at,"
                "p.payload->'change'->>'note' AS note,p.payload->'change'->>'currency' AS currency,"
                "coalesce(p.impact->>'historical_paid_lines',"
                "p.impact->>'candidate_lines') AS lines,"
                "o.result->'changed' AS changed"
                + join
                + " ORDER BY p.consumed_at DESC,o.preview_id LIMIT 20 OFFSET %s",
                ((page - 1) * 20,),
            )
            for r in items:
                r["consumed_at"] = r["consumed_at"].isoformat()
        return {
            "workspace_id": scope.workspace_id,
            "dataset_id": scope.dataset_id,
            "version": scope.version,
            "preview_id": preview_id,
            "page": page,
            "page_size": 20,
            "total": count,
            "rows": items,
        }
