"""Plan and atomically confirm effective-dated SKU cost rules; original costs stay on orders."""

import re
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, localcontext
from uuid import uuid4

from .accounting import Cost, choose_cost
from .cost_directory import cost_public
from .operations import (
    MutationResult,
    OperationConflict,
    bind_scope,
    checked_dataset,
    confirm_operation,
    create_preview,
)
from .precision import decimal_text, exact_decimal
from .query import Query, query_ledger
from .recalculation import carry_unchanged_accounting, rebuild_accounting, rows
from .scope import IDENTIFIER, ScopeError

IMPACT_METRICS = (
    "product_cost",
    "refund_cost_recovery",
    "contribution_profit",
    "accounted_contribution",
    "coverage_ratio",
)


@dataclass(frozen=True)
class CostChange:
    sku_ids: list[str]
    level: str
    method: str
    value: str
    currency: str
    effective_at: str
    note: str
    scope_id: str | None = None
    allow_zero: bool = False

    def normalized(self):
        if (
            not isinstance(self.sku_ids, list)
            or not 1 <= len(self.sku_ids) <= 1000
            or any(not isinstance(k, str) or not IDENTIFIER.fullmatch(k) for k in self.sku_ids)
            or len(set(self.sku_ids)) != len(self.sku_ids)
        ):
            raise ValueError("每次请选择 1 至 1000 个不同的标准规格。")
        if self.level not in ("base", "channel", "store") or (
            self.scope_id is not None
            if self.level == "base"
            else not isinstance(self.scope_id, str) or not IDENTIFIER.fullmatch(self.scope_id)
        ):
            raise ValueError("请选择成本生效的层级及对应店铺或平台。")
        if self.method not in ("fixed", "amount", "percent") or not isinstance(self.value, str):
            raise ValueError("请选择固定成本、金额增减或百分比增减。")
        if (
            not isinstance(self.currency, str)
            or not re.fullmatch(r"[A-Z]{3}", self.currency)
            or type(self.allow_zero) is not bool
        ):
            raise ValueError("成本币种或零成本确认无效。")
        if not isinstance(self.note, str) or not self.note.strip() or len(self.note) > 240:
            raise ValueError("请简要说明这次成本调整的来源或原因，最多 240 字。")
        try:
            at = datetime.fromisoformat(self.effective_at)
            if at.utcoffset() is None:
                raise ValueError
        except TypeError, ValueError:
            raise ValueError("请填写带时区的生效时间。") from None
        value = exact_decimal(self.value, "unit_cost" if self.method == "fixed" else "quantity")
        return {
            "sku_ids": sorted(self.sku_ids),
            "level": self.level,
            "scope_id": self.scope_id,
            "method": self.method,
            "value": format(value, "f"),
            "currency": self.currency,
            "effective_at": at.astimezone(UTC).isoformat(),
            "note": self.note.strip(),
            "allow_zero": self.allow_zero,
        }


def plan_changes(conn, change):
    ids, level = change["sku_ids"], change["level"]
    channel = change["scope_id"] if level == "channel" else None
    store = change["scope_id"] if level == "store" else None
    if store:
        match = rows(conn, "SELECT channel_id FROM bi.stores WHERE store_id=%s", (store,))
        if not match:
            raise ScopeError("所选店铺不存在。")
        channel = match[0]["channel_id"]
    if channel and not rows(conn, "SELECT 1 FROM bi.channels WHERE channel_id=%s", (channel,)):
        raise ScopeError("所选平台不存在。")
    skus = rows(
        conn, "SELECT sku_id,name,unit FROM bi.skus WHERE sku_id=ANY(%s) ORDER BY sku_id", (ids,)
    )
    if len(skus) != len(ids):
        raise ScopeError("部分标准规格不存在于当前数据集。")
    grouped = defaultdict(list)
    for r in rows(
        conn,
        "SELECT * FROM bi.cost_versions WHERE superseded_version IS NULL AND sku_id=ANY(%s) "
        "AND (level='base' OR (level='channel' AND channel_id=%s) OR (level='store' AND"
        " store_id=%s)) "
        "ORDER BY valid_from",
        (ids, channel, store),
    ):
        grouped[r["sku_id"]].append(r)
    at = datetime.fromisoformat(change["effective_at"])
    delta = Decimal(change["value"])
    plan = []
    for sku in skus:
        rules = grouped[sku["sku_id"]]
        costs = [Cost(**{key: r[key] for key in Cost.__dataclass_fields__}) for r in rules]
        effective = choose_cost(at, sku["sku_id"], channel, store, costs)
        previous = next((r for r in rules if effective and r["cost_id"] == effective.cost_id), None)
        owned = previous if previous and previous["level"] == level else None
        next_start = next(
            (r["valid_from"] for r in rules if r["level"] == level and r["valid_from"] > at), None
        )
        until = owned["valid_to"] if owned else next_start
        if change["method"] == "fixed":
            price = delta
        else:
            if not previous or previous["currency"] != change["currency"]:
                raise ValueError(f"{sku['sku_id']} 缺少相同币种的原成本，请使用固定金额。")
            with localcontext() as ctx:
                ctx.prec = 80
                price = previous["unit_cost"] + (
                    delta if change["method"] == "amount" else previous["unit_cost"] * delta / 100
                )
                price = price.quantize(Decimal("0.0001"), ROUND_HALF_UP)
        formatted = decimal_text(price, "unit_cost")
        if price == 0 and not change["allow_zero"]:
            raise ValueError("含零成本规格，请核对原因并明确确认零成本。")
        plan.append(
            {
                **sku,
                "previous": cost_public(previous),
                "replaces": owned["cost_id"] if owned else None,
                "valid_to": until.isoformat() if until else None,
                "channel_id": channel,
                "store_id": store,
                "unit_cost": formatted,
                "changed": not owned
                or owned["unit_cost"] != price
                or owned["currency"] != change["currency"],
            }
        )
    return plan


def apply_rules(conn, scope, change, plan):
    at = datetime.fromisoformat(change["effective_at"])
    prefix = (scope.workspace_id, scope.dataset_id)
    created = []
    for item in plan:
        if not item["changed"]:
            continue
        if prior := item["replaces"]:
            if datetime.fromisoformat(item["previous"]["valid_from"]) == at:
                conn.execute(
                    "UPDATE bi.cost_versions SET superseded_version=%s WHERE workspace_id=%s "
                    "AND dataset_id=%s AND cost_id=%s",
                    (scope.version + 1, *prefix, prior),
                )
            else:
                conn.execute(
                    "UPDATE bi.cost_versions SET valid_to=%s WHERE workspace_id=%s "
                    "AND dataset_id=%s AND cost_id=%s",
                    (at, *prefix, prior),
                )
        key = "cost-" + uuid4().hex
        conn.execute(
            "INSERT INTO bi.cost_versions"
            " (workspace_id,dataset_id,cost_id,sku_id,level,channel_id,store_id,"
            "unit_cost,currency,valid_from,valid_to,source,created_version) VALUES "
            "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                *prefix,
                key,
                item["sku_id"],
                change["level"],
                item["channel_id"],
                item["store_id"],
                item["unit_cost"],
                change["currency"],
                at,
                item["valid_to"],
                change["note"],
                scope.version + 1,
            ),
        )
        created.append(key)
    return created


def impacted_lines(conn, created):
    if not created:
        return []
    return [
        r["line_id"]
        for r in rows(
            conn,
            """
        SELECT l.line_id FROM bi.order_lines l
          JOIN bi.orders o USING(workspace_id,dataset_id,order_id,store_id)
        JOIN bi.stores s USING(workspace_id,dataset_id,store_id)
        JOIN bi.mappings m ON m.workspace_id=l.workspace_id AND m.dataset_id=l.dataset_id
          AND m.listing_id=l.listing_id AND m.superseded_version IS NULL
          AND m.valid_from<=o.paid_at AND (m.valid_to IS NULL OR o.paid_at<m.valid_to)
        JOIN LATERAL (SELECT cost_id FROM bi.cost_versions c WHERE c.workspace_id=l.workspace_id
          AND c.dataset_id=l.dataset_id AND c.sku_id=m.sku_id AND c.superseded_version IS NULL
          AND c.valid_from<=o.paid_at AND (c.valid_to IS NULL OR o.paid_at<c.valid_to)
          AND (c.level='base' OR (c.level='channel' AND c.channel_id=s.channel_id)
               OR (c.level='store' AND c.store_id=l.store_id))
          ORDER BY CASE c.level WHEN 'store' THEN 1 WHEN 'channel' THEN 2
            ELSE 3 END LIMIT 1) rule ON true
        WHERE o.status='paid' AND rule.cost_id=ANY(%s) ORDER BY l.line_id
        """,
            (created,),
        )
    ]


def preview_costs(conn, scope, proposal: CostChange):
    scope.require("ledger.manage")
    change = proposal.normalized()
    with conn.transaction():
        bind_scope(conn, scope)
        if checked_dataset(conn, scope, lock=True) != scope.version:
            raise OperationConflict("数据已更新，请刷新并重新预览。")
        plan = plan_changes(conn, change)
        # Compare all historical bookings, including rules with a future start.
        query = Query(
            start="0001-01-01", end="9999-12-31", dimension="overall", metrics=IMPACT_METRICS
        )

        def totals(read_scope):
            return query_ledger(conn, read_scope, query, _preview_transaction=True)["summary"][
                "metrics"
            ]

        before = totals(scope)
        after = before
        with conn.transaction(force_rollback=True):
            ids = impacted_lines(conn, apply_rules(conn, scope, change, plan))
            if ids:
                next_scope = replace(scope, version=scope.version + 1)
                rebuild_accounting(conn, scope, revision=next_scope.version, line_ids=ids)
                conn.execute(
                    "UPDATE bi.datasets SET version=%s WHERE workspace_id=%s AND dataset_id=%s",
                    (next_scope.version, scope.workspace_id, scope.dataset_id),
                )
                after = totals(next_scope)
        impact = {
            "items": plan,
            "historical_paid_lines": len(ids),
            "before": before,
            "after": after,
            "change": change,
        }
        preview_id = create_preview(conn, scope, "costs", {"change": change}, impact)
        expiry = rows(
            conn, "SELECT expires_at FROM bi.operation_previews WHERE preview_id=%s", (preview_id,)
        )[0]
        return {
            "workspace_id": scope.workspace_id,
            "dataset_id": scope.dataset_id,
            "version": scope.version,
            "preview_id": preview_id,
            "expires_at": expiry["expires_at"].isoformat(),
            "impact": impact,
        }


def confirm_costs(conn, scope, preview_id, idempotency_key, *, confirmed_by_user):
    def apply(conn, kind, payload):
        if kind != "costs" or set(payload) != {"change"}:
            raise OperationConflict("请选择已核对的成本预览。")
        change = CostChange(**payload["change"]).normalized()
        plan = plan_changes(conn, change)
        created = apply_rules(conn, scope, change, plan)
        if created:
            carry_unchanged_accounting(conn, scope)
        return MutationResult(
            bool(created),
            {"cost_ids": created, "sku_ids": change["sku_ids"], "level": change["level"]},
        )

    result = confirm_operation(
        conn,
        scope,
        preview_id,
        idempotency_key,
        confirmed_by_user=confirmed_by_user,
        apply=apply,
        expected_kind="costs",
    )
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "accounting_revision": result["version"],
        **result,
    }
