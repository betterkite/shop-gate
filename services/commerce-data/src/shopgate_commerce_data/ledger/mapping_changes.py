"""Effective-dated platform-to-standard unit changes with a human-reviewed impact."""

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from .operations import MutationResult, OperationConflict, confirm_operation, create_preview
from .precision import decimal_text, exact_decimal
from .query import ledger_read_snapshot
from .recalculation import carry_unchanged_accounting, rows
from .scope import IDENTIFIER, ScopeError


@dataclass(frozen=True)
class MappingChange:
    listing_id: str
    sku_id: str
    multiplier: str
    effective_at: str

    def normalized(self):
        for key in (self.listing_id, self.sku_id):
            if not isinstance(key, str) or not IDENTIFIER.fullmatch(key):
                raise ValueError("请选择平台货号和标准规格。")
        if not isinstance(self.multiplier, str):
            raise ValueError("换算数量须为大于零的数字，最多四位小数。")
        factor = exact_decimal(self.multiplier, "quantity")
        if factor <= 0:
            raise ValueError("换算数量必须大于零。")
        try:
            at = datetime.fromisoformat(self.effective_at)
            if at.utcoffset() is None:
                raise ValueError
        except (TypeError, ValueError):
            raise ValueError("请填写带时区的生效时间。") from None
        return {"listing_id": self.listing_id, "sku_id": self.sku_id,
                "multiplier": decimal_text(factor, "quantity"),
                "effective_at": at.astimezone(UTC).isoformat()}


def _impact(connection, change):
    listing, sku, at = change["listing_id"], change["sku_id"], change["effective_at"]
    pair = rows(connection,
                "SELECT l.name,l.platform_sku_id,l.unit,s.name AS store_name,k.name AS sku_name,"
                "k.unit AS standard_unit FROM bi.listings l JOIN bi.stores s "
                "USING(workspace_id,dataset_id,store_id) JOIN bi.skus k "
                "USING(workspace_id,dataset_id) WHERE l.listing_id=%s AND k.sku_id=%s",
                (listing, sku))
    if not pair:
        raise ScopeError("平台货号或标准规格不存在于当前数据集。")
    active = rows(connection,
                  "SELECT m.mapping_id,m.sku_id,k.name AS sku_name,k.unit,m.unit_multiplier,"
                  "m.valid_from,m.valid_to FROM bi.mappings m JOIN bi.skus k "
                  "USING(workspace_id,dataset_id,sku_id) WHERE m.listing_id=%s "
                  "AND m.superseded_version IS NULL AND m.valid_from<=%s "
                  "AND (m.valid_to IS NULL OR m.valid_to>%s)", (listing, at, at))
    previous = None
    if active:
        rule = active[0]
        end = rule["valid_to"]
        previous = {"mapping_id": rule["mapping_id"], "sku_id": rule["sku_id"],
                    "sku_name": rule["sku_name"], "unit": rule["unit"],
                    "multiplier": decimal_text(rule["unit_multiplier"], "quantity"),
                    "valid_from": rule["valid_from"].astimezone(UTC).isoformat(),
                    "valid_to": end.astimezone(UTC).isoformat() if end else None}
        until = previous["valid_to"]
    else:
        future = rows(connection,
                      "SELECT min(valid_from) AS next_start FROM bi.mappings WHERE listing_id=%s "
                      "AND superseded_version IS NULL AND valid_from>%s", (listing, at))
        next_start = future[0]["next_start"]
        until = next_start.astimezone(UTC).isoformat() if next_start else None
    changed = previous is None or (previous["sku_id"], previous["multiplier"]) != (
        sku, change["multiplier"])
    affected = rows(connection,
                    "SELECT count(*) AS lines FROM bi.order_lines l JOIN bi.orders o "
                    "USING(workspace_id,dataset_id,order_id,store_id) WHERE l.listing_id=%s "
                    "AND o.status='paid' AND o.paid_at>=%s "
                    "AND (%s::timestamptz IS NULL OR o.paid_at<%s)",
                    (listing, at, until, until))[0]["lines"] if changed else 0
    return {**pair[0], "previous": previous, "proposed": change, "valid_to": until,
            "changed": changed, "historical_paid_lines": affected}


def preview_mapping(connection, scope, change: MappingChange):
    scope.require("ledger.manage")
    proposed = change.normalized()
    with ledger_read_snapshot(connection, scope):
        impact = _impact(connection, proposed)
    preview_id = create_preview(connection, scope, "mapping", {"impact": impact}, impact)
    with ledger_read_snapshot(connection, scope):
        expiry = rows(connection, "SELECT expires_at FROM bi.operation_previews "
                      "WHERE preview_id=%s AND actor_id=%s", (preview_id, scope.actor_id))[0]
    return {"workspace_id": scope.workspace_id, "dataset_id": scope.dataset_id,
            "version": scope.version, "preview_id": preview_id,
            "expires_at": expiry["expires_at"].isoformat(), "impact": impact}


def confirm_mapping(connection, scope, preview_id, idempotency_key, *, confirmed_by_user):
    def apply(connection, kind, payload):
        if kind != "mapping" or set(payload) != {"impact"}:
            raise OperationConflict("请选择已预览的规格对应变更。")
        impact = payload["impact"]
        change = MappingChange(**impact["proposed"]).normalized()
        if _impact(connection, change) != impact:
            raise OperationConflict("规则或涉及的订单已变化，请重新预览。")
        if not impact["changed"]:
            return MutationResult(False, impact)
        params = (scope.workspace_id, scope.dataset_id)
        version = scope.version + 1
        listing, at = change["listing_id"], change["effective_at"]

        def insert(sku, factor, start, end):
            new_id = "map-" + uuid4().hex
            connection.execute(
                "INSERT INTO bi.mappings(workspace_id,dataset_id,mapping_id,listing_id,sku_id,"
                "unit_multiplier,valid_from,valid_to,created_version) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (*params, new_id, listing, sku, factor, start, end, version))
            return new_id

        previous = impact["previous"]
        if previous:
            if datetime.fromisoformat(previous["valid_from"]) < datetime.fromisoformat(at):
                connection.execute("UPDATE bi.mappings SET valid_to=%s WHERE workspace_id=%s "
                                   "AND dataset_id=%s AND mapping_id=%s",
                                   (at, *params, previous["mapping_id"]))
            else:
                # Original payments reference this exact rule. Retire it instead of overwriting it.
                connection.execute("UPDATE bi.mappings SET superseded_version=%s "
                                   "WHERE workspace_id=%s AND dataset_id=%s AND mapping_id=%s",
                                   (version, *params, previous["mapping_id"]))
        mapping_id = insert(change["sku_id"], change["multiplier"], at, impact["valid_to"])
        carry_unchanged_accounting(connection, scope)
        return MutationResult(True, {**impact, "mapping_id": mapping_id})

    result = confirm_operation(
        connection, scope, preview_id, idempotency_key, confirmed_by_user=confirmed_by_user,
        apply=apply, expected_kind="mapping",
    )
    return {"workspace_id": scope.workspace_id, "dataset_id": scope.dataset_id,
            "accounting_revision": result["version"], **result}
