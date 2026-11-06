"""Actual authorized PG18 snapshot, manual121, all-page and concurrent import tests."""

import os
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest
from test_ledger_exchange_postgres import commit, manual_records

from shopgate_commerce_data.ledger import query as query_module
from shopgate_commerce_data.ledger.datasets import DatasetPlan, create_dataset
from shopgate_commerce_data.ledger.migrations import migrate_all
from shopgate_commerce_data.ledger.operations import OperationConflict, create_preview
from shopgate_commerce_data.ledger.overview import OverviewRequest, overview
from shopgate_commerce_data.ledger.query import Query, ledger_read_snapshot, query_ledger
from shopgate_commerce_data.ledger.scope import DirectoryScope, LedgerScope, ScopeError
from shopgate_commerce_data.ledger.targets import TargetChange, confirm_target, preview_target


@pytest.fixture(scope="module")
def overview_database():
    admin = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL", "")
    assert admin.startswith("postgresql://ledger_test_admin@127.0.0.1:"), (
        "Use the trusted owned backend harness, never a daily database."
    )
    with psycopg.connect(admin, autocommit=True) as connection:
        migrate_all(connection)
        connection.execute("CREATE ROLE overview_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO overview_app")
        connection.execute("GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA bi TO overview_app")
        connection.execute("REVOKE ALL ON bi.schema_migrations FROM overview_app")
    return admin.replace("ledger_test_admin@", "overview_app@"), admin


@pytest.fixture
def context(overview_database):
    app, admin = overview_database
    workspace = f"overview-{uuid4()}"
    directory = DirectoryScope(
        workspace, "operator", frozenset({"datasets.read", "datasets.manage"})
    )
    with psycopg.connect(app, autocommit=True) as connection:
        create_dataset(
            connection,
            directory,
            DatasetPlan("official", "总览核对", "import"),
            "create-overview",
            confirmed_by_user=True,
            demo_allowed=False,
        )
    return (
        LedgerScope(
            workspace, "official", "operator", 1, frozenset({"ledger.read", "ledger.manage"})
        ),
        app,
        admin,
    )


def test_overview_manual121_one_transaction_no_model_and_recordless_days_are_not_zero(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = overview(
            connection, scope, OverviewRequest(query=Query(start="2026-07-01", end="2026-07-02"))
        )
        assert connection.execute("SHOW shopgate.workspace_id").fetchone() == ("",)
    assert result["version"] == result["accounting_revision"] == 2
    assert result["summary"]["metrics"]["net_sales"] == "164.00"
    assert result["summary"]["metrics"]["accounted_contribution"] == "121.00"
    assert result["summary"]["metrics"]["order_count"] == 2
    assert result["previous"]["range"]["start"] == "2026-06-29"
    assert result["previous"]["history_sufficient"] is False
    assert all(value["state"] == "history_insufficient" for value in result["comparison"].values())
    assert result["channels"]["rows"][0]["metrics"]["net_sales"] == "164.00"
    assert result["channels"]["rows"][0]["shares"]["net_sales"] == "1.00000000"
    assert result["channels"]["share_states"]["net_sales"] == "comparable"
    assert result["trend"]["rows"][0]["metrics"]["accounted_contribution"] == "121.00"
    assert result["trend"]["rows"][1]["metrics"] is None
    assert result["trend"]["rows"][1]["state"] == "no_records"
    assert result["targets"]["rows"][0]["net_sales"] == "104.00"
    assert result["targets"]["rows"][0]["completion_ratio"] == "0.10400000"


def test_comparable_previous_window_and_week_boundary_have_independent_amounts(context):
    records = manual_records()
    records["orders"].append(
        {
            "order_id": "previous",
            "platform_order_id": "000previous",
            "store_id": "002",
            "paid_at": "2026-06-30T00:00:00Z",
            "status": "paid",
            "currency": "CNY",
            "fulfillment_status": "delivered",
        }
    )
    records["order_lines"].append(
        {
            "line_id": "previous-line",
            "order_id": "previous",
            "store_id": "002",
            "listing_id": "l002",
            "quantity": "1",
            "paid_amount": "50",
        }
    )
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = overview(
            connection,
            scope,
            OverviewRequest(query=Query(start="2026-07-01", end="2026-07-01"), interval="week"),
        )
    assert result["previous"]["history_sufficient"]
    assert result["comparison"]["net_sales"] == {
        "current": "164.00",
        "previous": "50.00",
        "difference": "114.00",
        "growth_ratio": "2.28000000",
        "state": "comparable",
    }
    assert result["trend"]["rows"][0]["key"] == "2026-06-29"
    assert result["trend"]["rows"][0]["start"] == "2026-07-01"
    assert result["trend"]["rows"][0]["end"] == "2026-07-01"
    assert result["trend"]["rows"][0]["metrics"]["net_sales"] == "164.00"


def test_month_targets_ignore_item_and_partial_dates_but_inherit_store_platform(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = overview(
            connection,
            scope,
            OverviewRequest(
                query=Query(
                    start="2026-07-02",
                    end="2026-07-02",
                    product_ids=("p002",),
                    refund_basis="occurred",
                )
            ),
        )
        assert result["summary"]["metrics"]["net_sales"] == "-40.00"
        assert result["summary"]["metrics"]["refund_ratio"] is None
        assert result["targets"]["rows"][0]["net_sales"] == "104.00"
        assert result["targets"]["range"] == {"start": "2026-07-01", "end": "2026-07-31"}
        selected = overview(connection, scope, OverviewRequest(query=Query(store_ids=("002",))))
        assert selected["targets"]["total"] == 1
        assert selected["targets"]["rows"][0]["state"] == "not_set"
        assert selected["targets"]["rows"][0]["sales_target"] is None
        assert selected["targets"]["configured_count"] == 0
        assert selected["targets"]["sales_target_total"] is None


def test_unknown_cost_does_not_become_profit_or_healthy_diagnosis(context):
    records = manual_records()
    records["costs"] = []
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = overview(connection, scope, OverviewRequest())
    assert result["summary"]["metrics"]["contribution_profit"] is None
    assert result["summary"]["metrics"]["contribution_margin"] is None
    assert any(row["id"] == "unknown_cost_lines" for row in result["attention"]["rows"])
    assert result["comparison"]["contribution_margin"]["growth_ratio"] is None


def test_empty_explicit_dates_and_low_calendar_boundary_are_safe(context):
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = overview(connection, context[0], OverviewRequest())
        assert result["state"] == "empty" and result["trend"]["rows"] == []
        explicit = overview(
            connection,
            context[0],
            OverviewRequest(query=Query(start="2026-07-01", end="2026-07-02")),
        )
        assert explicit["state"] == "empty" and explicit["targets"] is None
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        early = overview(
            connection, scope, OverviewRequest(query=Query(start="0001-01-01", end="0001-01-01"))
        )
        assert early["previous"] is None
        assert early["comparison"]["net_sales"]["growth_ratio"] is None


def test_snapshot_shares_one_source_load_and_cannot_escape_its_transaction(context, monkeypatch):
    scope, _, _ = commit(context)
    original = query_module.load_lines
    calls = []

    def counted(connection):
        calls.append(True)
        return original(connection)

    monkeypatch.setattr(query_module, "load_lines", counted)
    with psycopg.connect(context[1], autocommit=True) as connection:
        with ledger_read_snapshot(connection, scope) as read:
            assert read.query(Query())["summary"]["metrics"]["net_sales"] == "164.00"
            read.query(Query(dimension="channel"))
            read.query(Query(refund_basis="occurred"))
            read.query(Query(dimension="sku"))
            assert len(calls) == 1
            assert connection.execute("SHOW transaction_read_only").fetchone() == ("on",)
        with pytest.raises(ValueError, match="快照已结束"):
            read.query(Query())
        with connection.transaction(), pytest.raises(ValueError, match="独立事务"):
            query_ledger(connection, scope, Query())


def test_concurrent_new_import_cannot_mix_overview_snapshot_or_cross_workspace(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        with ledger_read_snapshot(connection, scope) as read:
            first = read.query(Query())
            newer, _, _ = commit(
                (scope, context[1], context[2]),
                {
                    "products": [
                        {
                            "product_id": "next-version",
                            "name": "新增元信息",
                            "category": "",
                            "series": "",
                        }
                    ]
                },
                key="parallel-metadata",
            )
            second = read.query(Query(dimension="channel"))
            assert first["version"] == second["version"] == 2
            assert second["summary"]["metrics"]["contribution_profit"] == "121.00"
        with pytest.raises(OperationConflict):
            overview(connection, scope, OverviewRequest())
        result = overview(connection, newer, OverviewRequest())
        assert result["version"] == 3 and result["summary"]["metrics"]["net_sales"] == "164.00"
        with pytest.raises(ScopeError):
            overview(connection, replace(newer, workspace_id="foreign"), OverviewRequest())


def test_all23_channels_and24_stores_including_unset_target_have_stable20_paging(context):
    records = manual_records()
    for index in range(22):
        key = f"extra-{index:02}"
        records["channels"].append(
            {"channel_id": key, "name": f"平台{index:02}", "color": "#0891b2"}
        )
        records["stores"].append(
            {
                "store_id": key,
                "channel_id": key,
                "name": f"店铺{index:02}",
                "currency": "CNY",
                "timezone": "Asia/Shanghai",
            }
        )
        records["expenses"].append(
            {
                "expense_id": key,
                "channel_id": key,
                "store_id": key,
                "occurred_at": "2026-07-01T00:00:00Z",
                "amount": "1",
                "currency": "CNY",
                "expense_type": "advertising",
                "allocation_method": "unallocated",
                "source": "固定样例",
            }
        )
        records["targets"].append({"store_id": key, "month": "2026-07-01", "sales_target": "100"})
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        first = overview(connection, scope, OverviewRequest())
        second = overview(connection, scope, OverviewRequest(channel_page=2, target_page=2))
    assert first["channels"]["total"] == second["channels"]["total"] == 23
    assert len(first["channels"]["rows"]) == 20 and len(second["channels"]["rows"]) == 3
    assert len({row["key"] for data in (first, second) for row in data["channels"]["rows"]}) == 23
    assert first["channels"]["share_states"]["accounted_contribution"] == "negative_values"
    assert second["channels"]["share_states"]["accounted_contribution"] == "negative_values"
    assert all(row["shares"]["accounted_contribution"] is None
               for data in (first, second) for row in data["channels"]["rows"])
    assert first["channels"]["rows"][0]["shares"]["net_sales"] == "1.00000000"
    assert all(row["shares"]["net_sales"] == "0.00000000"
               for row in second["channels"]["rows"])
    assert first["targets"]["total"] == 24
    assert len(second["targets"]["rows"]) == 4
    assert first["targets"]["configured_count"] == second["targets"]["configured_count"] == 23
    all_targets = first["targets"]["rows"] + second["targets"]["rows"]
    assert len({row["store_id"] for row in all_targets}) == 24
    unset = next(row for row in all_targets if row["store_id"] == "002")
    assert unset["state"] == "not_set" and unset["sales_target"] is None
    assert unset["net_sales"] == "60.00" and unset["completion_ratio"] is None
    assert (
        first["targets"]["sales_target_total"]
        == second["targets"]["sales_target_total"]
        == ("3200.00")
    )
    assert first["summary"]["metrics"]["accounted_contribution"] == "99.00"


def _source_snapshot(context):
    scope, _, admin = context
    with psycopg.connect(admin, autocommit=True) as connection:
        return {
            table: connection.execute(
                f"SELECT to_jsonb(t) FROM bi.{table} t "
                "WHERE workspace_id=%s AND dataset_id=%s ORDER BY to_jsonb(t)::text",
                (scope.workspace_id, scope.dataset_id),
            ).fetchall()
            for table in (
                "orders",
                "order_lines",
                "refunds",
                "expenses",
                "line_snapshots",
                "expense_snapshots",
                "expense_allocations",
            )
        }


def test_target_preview_confirm_preserves_all_facts_and_new_accounting_queries(context):
    scope, _, _ = commit(context)
    before = _source_snapshot(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        preview = preview_target(
            connection, scope, TargetChange("001", "2026-07-01", "1500.25", "-50")
        )
        assert preview["impact"]["previous"] == {
            "sales_target": "1000.00",
            "profit_target": "200.00",
        }
        assert preview["impact"]["expected_version_after"] == 3
        assert (
            query_ledger(connection, scope, Query())["summary"]["metrics"]["contribution_profit"]
            == "121.00"
        )
        with pytest.raises(ScopeError):
            confirm_target(
                connection, scope, preview["preview_id"], "target-edit", confirmed_by_user=False
            )
        result = confirm_target(
            connection, scope, preview["preview_id"], "target-edit", confirmed_by_user=True
        )
        assert result["version"] == result["accounting_revision"] == 3 and result["changed"]
        assert (
            confirm_target(
                connection, scope, preview["preview_id"], "target-edit", confirmed_by_user=True
            )
            == result
        )
        with pytest.raises(OperationConflict):
            query_ledger(connection, scope, Query())
    assert _source_snapshot(context) == before
    # Fresh connection represents a restarted HTTP/worker process, not in-memory state.
    with psycopg.connect(context[1], autocommit=True) as connection:
        current = overview(connection, replace(scope, version=3), OverviewRequest())
        assert current["summary"]["metrics"]["contribution_profit"] == "121.00"
        target = next(row for row in current["targets"]["rows"] if row["store_id"] == "001")
        assert target["sales_target"] == "1500.25" and target["profit_target"] == "-50.00"
        assert target["net_sales"] == "104.00" and target["profit_completion_ratio"] is None


def test_target_no_change_does_not_increment_version_or_add_watermark(context):
    scope, _, _ = commit(context)
    admin = context[2]
    with psycopg.connect(context[1], autocommit=True) as connection:
        preview = preview_target(
            connection, scope, TargetChange("001", "2026-07-01", "1000.00", "200.00")
        )
        assert preview["impact"]["changed"] is False
        result = confirm_target(
            connection, scope, preview["preview_id"], "same-target", confirmed_by_user=True
        )
        assert result["changed"] is False and result["version"] == 2
    with psycopg.connect(admin, autocommit=True) as connection:
        assert connection.execute(
            "SELECT max(revision) FROM bi.accounting_runs WHERE workspace_id=%s",
            (scope.workspace_id,),
        ).fetchone() == (2,)


def test_target_first_setting_zero_is_distinct_from_unset_and_stays_queryable(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        preview = preview_target(connection, scope, TargetChange("002", "2026-07-01", "0"))
        assert preview["impact"]["previous"] is None and preview["impact"]["changed"]
        confirm_target(
            connection, scope, preview["preview_id"], "zero-target", confirmed_by_user=True
        )
        result = overview(connection, replace(scope, version=3), OverviewRequest())
        target = next(row for row in result["targets"]["rows"] if row["store_id"] == "002")
        assert target["sales_target"] == "0.00" and target["state"] == "recorded"
        assert target["completion_ratio"] is None and target["profit_target"] is None
        assert result["targets"]["configured_count"] == 2


def test_target_scope_readonly_actor_expiry_and_other_preview_cannot_write(context):
    scope, _, _ = commit(context)
    admin = context[2]
    readonly = replace(scope, capabilities=frozenset({"ledger.read"}))
    with psycopg.connect(context[1], autocommit=True) as connection:
        change = TargetChange("001", "2026-07-01", "2000")
        with pytest.raises(ScopeError):
            preview_target(connection, readonly, change)
        with pytest.raises(ScopeError):
            preview_target(connection, scope, replace(change, store_id="foreign"))
        preview = preview_target(connection, scope, change)
        wrong_kind = create_preview(connection, scope, "costs", {}, {})
        with pytest.raises(OperationConflict):
            confirm_target(connection, scope, wrong_kind, "wrong-kind", confirmed_by_user=True)
        for denied in (
            readonly,
            replace(scope, actor_id="other"),
            replace(scope, workspace_id="foreign"),
        ):
            with pytest.raises(ScopeError):
                confirm_target(
                    connection, denied, preview["preview_id"], "denied", confirmed_by_user=True
                )
        with psycopg.connect(admin, autocommit=True) as owner:
            owner.execute(
                "UPDATE bi.operation_previews "
                "SET expires_at=clock_timestamp()-interval '1 second' WHERE preview_id=%s",
                (preview["preview_id"],),
            )
        with pytest.raises(OperationConflict):
            confirm_target(
                connection, scope, preview["preview_id"], "expired", confirmed_by_user=True
            )
        assert (
            overview(connection, scope, OverviewRequest())["targets"]["sales_target_total"]
            == "1000.00"
        )


def test_stale_target_preview_after_import_and_conflicting_idempotency_are_rejected(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        first = preview_target(connection, scope, TargetChange("001", "2026-07-01", "2000"))
        second = preview_target(connection, scope, TargetChange("002", "2026-07-01", "3000"))
        confirm_target(connection, scope, first["preview_id"], "one-key", confirmed_by_user=True)
        for key in ("one-key", "other-key"):
            with pytest.raises(OperationConflict):
                confirm_target(connection, scope, second["preview_id"], key, confirmed_by_user=True)
        current = overview(connection, replace(scope, version=3), OverviewRequest())
        assert current["targets"]["configured_count"] == 1
        assert current["targets"]["sales_target_total"] == "2000.00"
        version3 = replace(scope, version=3)
        pending = preview_target(connection, version3, TargetChange("001", "2026-07-01", "2500"))
        version4, _, _ = commit(
            (version3, context[1], context[2]),
            {
                "products": [
                    {
                        "product_id": "after-target",
                        "name": "导入新增元信息",
                        "category": "",
                        "series": "",
                    }
                ]
            },
            key="import-after-target",
        )
        assert version4.version == 4
        with pytest.raises(OperationConflict):
            confirm_target(
                connection,
                version3,
                pending["preview_id"],
                "stale-after-import",
                confirmed_by_user=True,
            )
        assert (
            overview(connection, version4, OverviewRequest())["targets"]["sales_target_total"]
            == "2000.00"
        )


def test_simultaneous_target_confirmations_have_only_one_version_winner(context):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        previews = [
            preview_target(connection, scope, TargetChange(store, "2026-07-01", "2000"))[
                "preview_id"
            ]
            for store in ("001", "002")
        ]
    barrier = Barrier(2)

    def confirm(preview):
        with psycopg.connect(context[1], autocommit=True) as connection:
            barrier.wait(timeout=10)
            try:
                return confirm_target(connection, scope, preview, preview, confirmed_by_user=True)[
                    "version"
                ]
            except OperationConflict:
                return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(confirm, previews))
    assert results.count(3) == results.count("conflict") == 1
    with psycopg.connect(context[1], autocommit=True) as connection:
        assert (
            overview(connection, replace(scope, version=3), OverviewRequest())["summary"][
                "metrics"
            ]["net_sales"]
            == "164.00"
        )
