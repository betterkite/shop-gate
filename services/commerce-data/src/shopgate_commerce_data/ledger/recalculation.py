"""Explicit accounting writes; ordinary reads never replace historical snapshots."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict
from datetime import datetime
from decimal import Decimal, localcontext
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from shopgate_commerce_data.ledger.accounting import (
    Cost,
    Mapping,
    Snapshot,
    allocate_cents,
    make_snapshot,
    money,
)
from shopgate_commerce_data.ledger.operations import (
    MutationResult,
    OperationConflict,
    bind_scope,
    checked_dataset,
    confirm_operation,
    create_preview,
)
from shopgate_commerce_data.ledger.scope import IDENTIFIER, LedgerScope

ALGORITHM_VERSION = "bi-accounting-v1"
BUSINESS_ZONE = ZoneInfo("Asia/Shanghai")


def business_date(value: datetime):
    return value.astimezone(BUSINESS_ZONE).date()


def rows(connection: psycopg.Connection, query: str, params=()) -> list[dict]:
    with connection.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(query, params).fetchall()


def carry_unchanged_accounting(connection, scope):
    """Internal only: caller proves unchanged facts inside the locked mutation.

    Metadata/targets need a current accounting watermark without rewriting any
    original snapshots. This is not an alternative to accounting changed facts.
    """
    scope.require("ledger.manage")
    connection.execute(
        "INSERT INTO bi.accounting_runs(workspace_id,dataset_id,revision,"
        "algorithm_version,processed_lines,processed_expenses) "
        "VALUES (%s,%s,%s,%s,0,0)",
        (scope.workspace_id, scope.dataset_id, scope.version + 1, ALGORITHM_VERSION),
    )


class _BufferedInsert:
    """Bound pipeline memory while retaining all SQL constraints and one outer transaction."""

    def __init__(self, connection, statement):
        self.connection = connection
        self.statement = statement
        self.pending = []

    def add(self, values):
        self.pending.append(values)
        if len(self.pending) >= 500:
            self.flush()

    def flush(self):
        if self.pending:
            with self.connection.cursor() as cursor:
                cursor.executemany(self.statement, self.pending)
            self.pending.clear()


def load_lines(connection: psycopg.Connection) -> list[dict]:
    return rows(
        connection,
        "SELECT l.*, o.paid_at, o.currency, o.fx_rate AS payment_fx_rate, "
        "o.fx_source AS payment_fx_source, s.channel_id FROM bi.order_lines l "
        "JOIN bi.orders o USING(workspace_id,dataset_id,order_id,store_id) "
        "JOIN bi.stores s USING(workspace_id,dataset_id,store_id) "
        "WHERE o.status='paid' ORDER BY l.line_id",
    )


def snapshot_from_row(row: dict) -> Snapshot:
    names = tuple(Snapshot.__dataclass_fields__)
    data = {name: row[name] for name in names if name != "missing"}
    reasons = row.get("missing_reasons")
    data["missing"] = (
        tuple(reasons)
        if reasons
        else (() if row["accounting_status"] == "complete" else (row["accounting_status"],))
    )
    return Snapshot(**data)


def rebuild_accounting(
    connection: psycopg.Connection,
    scope: LedgerScope,
    *,
    revision: int,
    line_ids: list[str] | None = None,
    only_missing: bool = False,
) -> dict:
    """Internal trusted mutation callback, inside dataset lock/transaction and signed scope.

    Imports must call this in their atomic commit; not exposed as a model tool.
    Existing line snapshots are retained unless selected for an explicitly confirmed recalc.
    Expense sources are always entire dataset/day, never a screen's SKU/date subset.
    """
    scope.require("ledger.manage")
    if revision != scope.version + 1:
        raise OperationConflict("核算写入必须属于下一经营版本。")
    bind_scope(connection, scope)
    if checked_dataset(connection, scope, lock=True) != scope.version:
        raise OperationConflict("数据已更新，请重新预览。")
    dataset = rows(connection, "SELECT reporting_currency FROM bi.datasets")[0]
    if dataset["reporting_currency"] != "CNY":
        raise ValueError("当前统一核算币种为人民币，其他原币需提供汇率。")
    lines = load_lines(connection)
    line_map = {row["line_id"]: row for row in lines}
    selected_ids = set(line_ids) if line_ids is not None else None
    if line_ids is not None and not set(line_ids).issubset(line_map):
        raise ValueError("重算对象不存在或不属于当前可见付款订单。")
    mappings = defaultdict(list)
    for row in rows(connection, "SELECT * FROM bi.mappings"):
        mappings[row["listing_id"]].append(
            Mapping(
                row["mapping_id"],
                row["sku_id"],
                row["unit_multiplier"],
                row["valid_from"],
                row["valid_to"],
            )
        )
    costs = [
        Cost(**{name: row[name] for name in Cost.__dataclass_fields__})
        for row in rows(connection, "SELECT * FROM bi.cost_versions")
    ]
    costs_by_sku = defaultdict(list)
    costs_by_id = {cost.cost_id: cost for cost in costs}
    for cost in costs:
        costs_by_sku[cost.sku_id].append(cost)
    sku_units = {
        row["sku_id"]: row["unit"] for row in rows(connection, "SELECT sku_id,unit FROM bi.skus")
    }
    exchange = {
        (row["currency"], row["rate_date"]): row
        for row in rows(connection, "SELECT * FROM bi.fx_rates")
    }
    rates_by_day = defaultdict(dict)
    lines_by_day = defaultdict(list)
    for (currency, day), row in exchange.items():
        rates_by_day[day][currency] = row["rate"]
    for line in lines:
        lines_by_day[business_date(line["paid_at"])].append(line)
    old = {
        row["line_id"]: row
        for row in rows(
            connection,
            "SELECT DISTINCT ON(line_id) * FROM bi.line_snapshots ORDER BY line_id,revision DESC",
        )
    }
    snapshots: dict[str, Snapshot] = {}
    processed = 0
    snapshot_columns = tuple(name for name in Snapshot.__dataclass_fields__ if name != "missing")
    line_inserts = _BufferedInsert(
        connection,
        "INSERT INTO bi.line_snapshots(workspace_id,dataset_id,line_id,revision,"
        + ",".join(snapshot_columns)
        + ",accounting_status,revenue_fx_source,cost_fx_source,missing_reasons) VALUES ("
        + ",".join(["%s"] * (len(snapshot_columns) + 8))
        + ")",
    )
    for line in lines:
        previous = old.get(line["line_id"])
        selected = selected_ids is None or line["line_id"] in selected_ids
        needs = (
            previous is None
            or selected
            and (not only_missing or previous["accounting_status"] != "complete")
        )
        if not needs:
            snapshots[line["line_id"]] = snapshot_from_row(previous)
            continue
        day = business_date(line["paid_at"])
        listing_mappings = mappings[line["listing_id"]]
        candidate_skus = {mapping.sku_id for mapping in listing_mappings}
        snapshot = make_snapshot(
            paid_at=line["paid_at"],
            quantity=line["quantity"],
            paid_amount=line["paid_amount"],
            currency=line["currency"],
            channel_id=line["channel_id"],
            store_id=line["store_id"],
            mappings=listing_mappings,
            costs=[cost for sku in candidate_skus for cost in costs_by_sku[sku]],
            rates=rates_by_day[day],
            payment_fx_rate=line["payment_fx_rate"],
        )
        data = asdict(snapshot)
        data.pop("missing")
        columns = tuple(data)
        # Column names are internal dataclass constants, never browser/model input.
        values = [data[name] for name in columns]
        cost = costs_by_id.get(snapshot.cost_id)

        def source(currency, day=day):
            row = exchange.get((currency, day))
            return (
                "人民币原币"
                if currency == "CNY"
                else (f"{row['rate_id']} / {day} / {row['source']}" if row else None)
            )

        revenue_source = (
            f"订单显式汇率 / {line['payment_fx_source']}"
            if line["payment_fx_rate"] is not None
            else source(line["currency"])
        )
        cost_source = source(cost.currency) if cost else None
        snapshots[line["line_id"]] = snapshot
        if (
            previous
            and snapshot_from_row(previous) == snapshot
            and previous.get("revenue_fx_source") == revenue_source
            and previous.get("cost_fx_source") == cost_source
        ):
            continue
        line_inserts.add(
            (
                scope.workspace_id,
                scope.dataset_id,
                line["line_id"],
                revision,
                *values,
                snapshot.status,
                revenue_source,
                cost_source,
                Jsonb(list(snapshot.missing)),
            ),
        )
        snapshots[line["line_id"]] = snapshot
        processed += 1
    line_inserts.flush()
    expenses = rows(connection, "SELECT * FROM bi.expenses ORDER BY expense_id")
    old_expenses = {
        row["expense_id"]: row
        for row in rows(
            connection,
            "SELECT DISTINCT ON(expense_id) * FROM bi.expense_snapshots "
            "ORDER BY expense_id,revision DESC",
        )
    }
    old_allocations = defaultdict(dict)
    for row in rows(
        connection,
        "SELECT a.* FROM bi.expense_allocations a JOIN "
        "(SELECT expense_id,max(revision) AS revision FROM bi.expense_snapshots "
        "GROUP BY expense_id) s USING(expense_id,revision)",
    ):
        old_allocations[row["expense_id"]][row["line_id"]] = (row["amount_cny"], row["weight"])
    processed_expenses = 0
    allocation_inserts = _BufferedInsert(
        connection,
        "INSERT INTO bi.expense_allocations"
        "(workspace_id,dataset_id,expense_id,line_id,revision,amount_cny,weight) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
    )
    expense_inserts = _BufferedInsert(
        connection,
        "INSERT INTO bi.expense_snapshots(workspace_id,dataset_id,expense_id,revision,"
        "amount_cny,fx_rate,fx_source,accounting_status,allocated_lines) VALUES "
        "(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
    )
    for expense in expenses:
        day = business_date(expense["occurred_at"])
        fx = exchange.get((expense["currency"], day))
        rate = (
            expense["fx_rate"]
            if expense["fx_rate"] is not None
            else (Decimal(1) if expense["currency"] == "CNY" else fx["rate"] if fx else None)
        )
        with localcontext() as context:
            context.prec = 80
            amount = money(expense["amount"] * rate) if rate is not None else None
        candidates = (
            ([line_map[expense["line_id"]]] if expense["line_id"] in line_map else [])
            if expense["allocation_method"] == "direct"
            else lines_by_day[day]
        )
        eligible = [
            line
            for line in candidates
            if (expense["store_id"] is None or line["store_id"] == expense["store_id"])
            and (expense["channel_id"] is None or line["channel_id"] == expense["channel_id"])
            and (
                line["line_id"] == expense["line_id"]
                if expense["allocation_method"] == "direct"
                else business_date(line["paid_at"]) == day
            )
        ]
        weights = {}
        status = "missing_fx" if rate is None else "unallocated"
        if amount is not None and eligible and expense["allocation_method"] != "unallocated":
            if expense["allocation_method"] == "direct":
                weights = {line["line_id"]: Decimal(1) for line in eligible}
            else:
                key = (
                    "revenue_cny"
                    if expense["allocation_method"] == "revenue"
                    else "standard_quantity"
                )
                values = {
                    line["line_id"]: getattr(snapshots[line["line_id"]], key) for line in eligible
                }
                units = {sku_units.get(snapshots[line["line_id"]].sku_id) for line in eligible}
                if any(value is None for value in values.values()) or (
                    expense["allocation_method"] == "quantity" and len(units) != 1
                ):
                    status = "missing_weight"
                else:
                    weights = {key: value for key, value in values.items() if value > 0}
            if weights:
                status = "allocated"
        allocations = allocate_cents(amount, weights) if amount is not None else {}
        fx_source = (
            f"费用显式汇率 / {expense['fx_source']}"
            if expense["fx_rate"] is not None
            else (
                "人民币原币"
                if expense["currency"] == "CNY"
                else (f"{fx['rate_id']} / {day} / {fx['source']}" if fx else None)
            )
        )
        previous = old_expenses.get(expense["expense_id"])
        if (
            previous
            and previous["amount_cny"] == amount
            and previous["fx_rate"] == rate
            and previous["fx_source"] == fx_source
            and previous["accounting_status"] == status
            and old_allocations[expense["expense_id"]]
            == {key: (value, weights[key]) for key, value in allocations.items()}
        ):
            continue
        processed_expenses += 1
        for line_id, allocated in allocations.items():
            allocation_inserts.add(
                (
                    scope.workspace_id,
                    scope.dataset_id,
                    expense["expense_id"],
                    line_id,
                    revision,
                    allocated,
                    weights[line_id],
                ),
            )
        expense_inserts.add(
            (
                scope.workspace_id,
                scope.dataset_id,
                expense["expense_id"],
                revision,
                amount,
                rate,
                fx_source,
                status,
                len(allocations),
            ),
        )
    allocation_inserts.flush()
    expense_inserts.flush()
    previous_run = rows(connection, "SELECT revision FROM bi.accounting_runs LIMIT 1")
    changed = bool(processed or processed_expenses or not previous_run)
    if changed:
        connection.execute(
            "INSERT INTO bi.accounting_runs(workspace_id,dataset_id,revision,algorithm_version,"
            "processed_lines,processed_expenses) VALUES (%s,%s,%s,%s,%s,%s)",
            (
                scope.workspace_id,
                scope.dataset_id,
                revision,
                ALGORITHM_VERSION,
                processed,
                len(expenses),
            ),
        )
    return {
        "changed": changed,
        "processed_lines": processed,
        "processed_expenses": processed_expenses,
        "algorithm_version": ALGORITHM_VERSION,
    }


def preview_recalculation(
    connection: psycopg.Connection,
    scope: LedgerScope,
    *,
    line_ids: list[str] | None = None,
    only_missing: bool = False,
) -> str:
    if (
        type(only_missing) is not bool
        or line_ids is not None
        and (
            not isinstance(line_ids, list)
            or not line_ids
            or len(line_ids) > 100_000
            or any(
                not isinstance(value, str) or not IDENTIFIER.fullmatch(value) for value in line_ids
            )
            or len(set(line_ids)) != len(line_ids)
        )
    ):
        raise ValueError("重算对象或范围无效。")
    with connection.transaction():
        bind_scope(connection, scope)
        checked_dataset(connection, scope, lock=True)
        lines = load_lines(connection)
        if line_ids is not None and not set(line_ids).issubset({line["line_id"] for line in lines}):
            raise ValueError("重算对象不存在或当前用户无权访问。")
        # Savepoint rollback provides an actual numerical preview without leaving facts/version.
        before = rows(
            connection,
            "SELECT coalesce(sum(cost_cny),0)::text AS known_cost "
            "FROM (SELECT DISTINCT ON(line_id) cost_cny FROM bi.line_snapshots "
            "ORDER BY line_id,revision DESC) s",
        )[0]["known_cost"]
        with connection.transaction(force_rollback=True):
            proposed = rebuild_accounting(
                connection,
                scope,
                revision=scope.version + 1,
                line_ids=line_ids,
                only_missing=only_missing,
            )
            after = rows(
                connection,
                "SELECT coalesce(sum(cost_cny),0)::text AS known_cost "
                "FROM (SELECT DISTINCT ON(line_id) cost_cny FROM bi.line_snapshots "
                "ORDER BY line_id,revision DESC) s",
            )[0]["known_cost"]
        return create_preview(
            connection,
            scope,
            "recalculate",
            {"line_ids": line_ids, "only_missing": only_missing, "algorithm": ALGORITHM_VERSION},
            {
                "candidate_lines": len(line_ids) if line_ids else len(lines),
                "changed_lines": proposed["processed_lines"],
                "changed_expenses": proposed["processed_expenses"],
                "known_cost_before_cny": before,
                "known_cost_after_cny": after,
                "note": "确认后追加所选历史快照；费用仍在完整来源范围分摊。",
            },
        )


def confirm_recalculation(
    connection: psycopg.Connection,
    scope: LedgerScope,
    preview_id: str,
    idempotency_key: str,
    *,
    confirmed_by_user: bool,
) -> dict:
    def apply(connection, kind, payload):
        if kind != "recalculate" or payload.get("algorithm") != ALGORITHM_VERSION:
            raise OperationConflict("核算规则已变化，请重新预览。")
        result = rebuild_accounting(
            connection,
            scope,
            revision=scope.version + 1,
            line_ids=payload["line_ids"],
            only_missing=payload["only_missing"],
        )
        return MutationResult(result["changed"], result)

    return confirm_operation(
        connection,
        scope,
        preview_id,
        idempotency_key,
        confirmed_by_user=confirmed_by_user,
        apply=apply,
    )
