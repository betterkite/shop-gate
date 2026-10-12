"""Small manually reproducible ledger, on the isolated real PG18 test cluster only."""

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from shopgate_commerce_data.ledger.migrations import migrate_all
from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope
from shopgate_commerce_data.ledger.query import Query, query_ledger
from shopgate_commerce_data.ledger.recalculation import (
    confirm_recalculation,
    preview_recalculation,
)
from shopgate_commerce_data.ledger.scope import LedgerScope, ScopeError


@pytest.fixture(scope="module")
def accounting_url():
    url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL")
    if not url:
        pytest.fail("Use trusted npm run test:backend; never the daily database.")
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    with psycopg.connect(url, autocommit=True) as connection:
        migrate_all(connection)
        migrate_all(connection)
        connection.execute("CREATE ROLE accounting_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO accounting_app")
        connection.execute(
            "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA bi TO accounting_app"
        )
        connection.execute("REVOKE ALL ON bi.schema_migrations FROM accounting_app")
        assert connection.execute(
            "SELECT revision FROM bi.schema_migrations ORDER BY revision"
        ).fetchall() == [("006",), ("007",), ("008",), ("009",)]
    return url


@pytest.fixture
def golden(accounting_url):
    workspace = f"golden-{uuid4()}"
    scope = LedgerScope(
        workspace, "golden", "member-a", 1, frozenset({"ledger.read", "ledger.manage"})
    )
    prefix = (workspace, "golden")
    with psycopg.connect(accounting_url, autocommit=True) as connection:
        connection.execute(
            "INSERT INTO bi.workspaces(workspace_id,name) VALUES (%s,'复算空间')", (workspace,)
        )
        connection.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,%s,'逐笔核算样例','demo')",
            prefix,
        )
        for channel, name in (("pdd", "拼多多"), ("temu", "Temu 半托管")):
            connection.execute(
                "INSERT INTO bi.channels VALUES (%s,%s,%s,%s)", (*prefix, channel, name)
            )
        for store, channel in (("a", "pdd"), ("b", "temu"), ("empty", "pdd")):
            connection.execute(
                "INSERT INTO bi.stores VALUES (%s,%s,%s,%s,%s)",
                (*prefix, store, channel, f"店铺{store}"),
            )
        for sku in ("001", "002"):
            connection.execute(
                "INSERT INTO bi.products VALUES (%s,%s,%s,%s,'日用品')",
                (*prefix, f"p{sku}", f"商品{sku}"),
            )
            connection.execute(
                "INSERT INTO bi.skus VALUES (%s,%s,%s,%s,%s,'件')",
                (*prefix, sku, f"p{sku}", f"规格{sku}"),
            )
            connection.execute(
                "INSERT INTO bi.cost_versions VALUES (%s,%s,%s,%s,'base',"
                "NULL,NULL,10.0000,'CNY','2026-01-01',NULL,'固定复算',1)",
                (*prefix, f"base{sku}", sku),
            )
        connection.execute(
            "INSERT INTO bi.cost_versions VALUES (%s,%s,'channel001','001','channel',"
            "'pdd',NULL,9.0000,'CNY','2026-01-01',NULL,'固定复算',1)",
            prefix,
        )
        connection.execute(
            "INSERT INTO bi.cost_versions VALUES (%s,%s,'store001','001','store',"
            "'pdd','a',8.0000,'CNY','2026-01-01',NULL,'固定复算',1)",
            prefix,
        )
        for listing, store, sku, multiplier in (
            ("la", "a", "001", "2.0000"),
            ("lb", "a", "002", "1.0000"),
            ("lc", "b", "001", "1.0000"),
        ):
            connection.execute(
                "INSERT INTO bi.listings VALUES (%s,%s,%s,%s,%s,%s)",
                (*prefix, listing, store, f"00{listing}", f"平台商品{listing}"),
            )
            connection.execute(
                "INSERT INTO bi.mappings VALUES (%s,%s,%s,%s,%s,%s,'2026-01-01',NULL,1)",
                (*prefix, f"m{listing}", listing, sku, multiplier),
            )
        for order, store, currency in (("oa", "a", "CNY"), ("oc", "b", "USD")):
            connection.execute(
                "INSERT INTO bi.orders VALUES (%s,%s,%s,%s,'2026-10-01T02:00:00Z',%s,'paid')",
                (*prefix, order, store, currency),
            )
        for line, order, store, listing, quantity, paid in (
            ("line-a", "oa", "a", "la", "2.0000", "100.00"),
            ("line-b", "oa", "a", "lb", "1.0000", "50.00"),
            ("line-c", "oc", "b", "lc", "1.0000", "10.00"),
        ):
            connection.execute(
                "INSERT INTO bi.order_lines VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (*prefix, line, order, store, listing, quantity, paid),
            )
        connection.execute(
            "INSERT INTO bi.fx_rates VALUES (%s,%s,'usd1','USD','2026-10-01',"
            "7.00000000,'固定复算汇率')",
            prefix,
        )
        for refund, line, day, amount, kind, qty, recovered, status in (
            ("r1", "line-a", "2026-10-02", "25.00", "refund_only", "0", "0", "completed"),
            ("r2", "line-a", "2026-10-03", "25.00", "return", "1", "1", "completed"),
            ("r3", "line-c", "2026-10-04", "2.00", "refund_only", "0", "0", "completed"),
            ("pending", "line-b", "2026-10-03", "50.00", "refund_only", "0", "0", "pending"),
        ):
            connection.execute(
                "INSERT INTO bi.refunds VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'测试原因',%s)",
                (*prefix, refund, line, day, amount, kind, qty, recovered, status),
            )
        for expense, day, store, amount, method in (
            ("fee", "2026-10-01", "a", "10.01", "revenue"),
            ("adjust", "2026-10-01", "a", "-0.01", "quantity"),
            ("no-sales", "2026-10-02", "empty", "5.00", "revenue"),
        ):
            connection.execute(
                "INSERT INTO bi.expenses VALUES (%s,%s,%s,%s,%s,'pdd',NULL,%s,'CNY',"
                "'advertising',%s,'固定复算','')",
                (*prefix, expense, day, store, amount, method),
            )
    return scope, accounting_url.replace("ledger_test_admin@", "accounting_app@"), accounting_url


def calculate(golden):
    scope, app_url, _ = golden
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_recalculation(connection, scope)
        result = confirm_recalculation(
            connection, scope, preview, "initial", confirmed_by_user=True
        )
    return replace(scope, version=result["version"])


def read(golden, scope=None, **overrides):
    scope = scope or calculate(golden)
    data = {"start": "2026-10-01", "end": "2026-10-05"}
    data.update(overrides)
    with psycopg.connect(golden[1], autocommit=True) as connection:
        return query_ledger(connection, scope, Query(**data))


def test_golden_whole_ledger_exact_manual_reconciliation(golden):
    result = read(golden)
    metrics = result["summary"]["metrics"]
    assert metrics["sales_amount"] == "220.00"
    assert metrics["refund_amount"] == "64.00"
    assert metrics["net_sales"] == "156.00"
    assert metrics["product_cost"] == "36.00"
    assert metrics["expense_amount"] == "15.00"
    assert metrics["contribution_profit"] == "105.00"
    assert metrics["accounted_contribution"] == "105.00"
    assert metrics["order_count"] == 2  # 3 lines, not 3 orders.
    assert metrics["average_order_value"] == "110.00"
    assert metrics["standard_quantity"] == "6.0000"
    assert metrics["coverage_ratio"] == "1.00000000"
    assert result["summary"]["quality"]["unallocated_expenses_cny"] == "5.00"


def test_filter_does_not_reallocate_source_fee_and_groups_reconcile(golden):
    scope = calculate(golden)
    result = read(golden, scope, dimension="sku", sort="key", descending=False)
    values = {row["key"]: row["metrics"] for row in result["rows"]}
    assert values["001"]["contribution_profit"] == "73.34"
    assert values["002"]["contribution_profit"] == "36.66"
    assert values["__unattributed__"]["contribution_profit"] == "-5.00"
    selected = read(golden, scope, sku_ids=("001",))
    assert selected["summary"]["metrics"]["expense_amount"] == "6.66"
    assert selected["summary"]["metrics"]["contribution_profit"] == "73.34"
    assert read(golden, scope, dimension="store")["summary"] == result["summary"]


def test_refund_two_date_bases_negative_sales_and_no_fake_ratio(golden):
    scope = calculate(golden)
    occurred = read(golden, scope, start="2026-10-02", end="2026-10-03", refund_basis="occurred")
    metrics = occurred["summary"]["metrics"]
    assert metrics["refund_amount"] == "50.00"
    assert metrics["net_sales"] == "-50.00"
    assert metrics["product_cost"] == "-16.00"
    assert metrics["contribution_profit"] == "-39.00"
    assert metrics["refund_ratio"] is None
    assert metrics["contribution_margin"] is None
    payment = read(golden, scope, start="2026-10-02", end="2026-10-03")
    assert payment["summary"]["metrics"]["refund_amount"] == "0.00"
    assert payment["summary"]["metrics"]["contribution_profit"] == "-5.00"


def test_preview_numerical_impact_no_fact_version_and_noop_no_bump(golden):
    scope, app_url, admin_url = golden
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_recalculation(connection, scope)
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.line_snapshots").fetchone()[0] == 0
            assert connection.execute("SELECT version FROM bi.datasets").fetchone()[0] == 1
            impact = connection.execute("SELECT impact FROM bi.operation_previews").fetchone()[0]
            assert impact["changed_lines"] == 3
            assert impact["known_cost_after_cny"] == "52.00"
        result = confirm_recalculation(
            connection, scope, preview, "initial", confirmed_by_user=True
        )
        scope = replace(scope, version=result["version"])
        another = preview_recalculation(connection, scope)
        no_op = confirm_recalculation(connection, scope, another, "no-op", confirmed_by_user=True)
        assert no_op["changed"] is False
        assert no_op["version"] == 2
    with psycopg.connect(admin_url, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM bi.line_snapshots WHERE workspace_id=%s",
                (scope.workspace_id,),
            ).fetchone()[0]
            == 3
        )


def test_current_cost_change_never_rewrites_historical_and_partial_recalc(golden):
    scope = calculate(golden)
    with psycopg.connect(golden[2], autocommit=True) as connection:
        prefix = (scope.workspace_id, scope.dataset_id)
        connection.execute(
            "UPDATE bi.cost_versions SET valid_to='2026-10-05' WHERE "
            "workspace_id=%s AND dataset_id=%s AND cost_id='store001'",
            prefix,
        )
        connection.execute(
            "INSERT INTO bi.cost_versions VALUES (%s,%s,'future','001','store',"
            "'pdd','a',100.0000,'CNY','2026-10-05',NULL,'未来',2)",
            prefix,
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "UPDATE bi.cost_versions SET unit_cost=11 WHERE workspace_id=%s "
                "AND dataset_id=%s AND cost_id='base002'",
                prefix,
            )
    assert read(golden, scope)["summary"]["metrics"]["product_cost"] == "36.00"
    with psycopg.connect(golden[1], autocommit=True) as connection:
        preview = preview_recalculation(connection, scope, line_ids=["line-a"])
        result = confirm_recalculation(
            connection, scope, preview, "future-noop", confirmed_by_user=True
        )
        assert result["changed"] is False


def test_unknown_mapping_fx_cost_and_unknown_fee_are_not_zero(golden):
    scope, app_url, admin_url = golden
    with psycopg.connect(admin_url, autocommit=True) as connection:
        prefix = (scope.workspace_id, scope.dataset_id)
        # Fixture-only changes before any snapshots; never touches daily data.
        connection.execute(
            "DELETE FROM bi.mappings WHERE workspace_id=%s AND dataset_id=%s AND listing_id='lb'",
            prefix,
        )
        connection.execute(
            "DELETE FROM bi.fx_rates WHERE workspace_id=%s AND dataset_id=%s", prefix
        )
        connection.execute(
            "INSERT INTO bi.expenses VALUES (%s,%s,'unknown-fee','2026-10-01',"
            "'a','pdd',NULL,1.00,'EUR','platform','revenue','缺汇率','')",
            prefix,
        )
    current = calculate(golden)
    result = read(golden, current)
    metrics = result["summary"]["metrics"]
    assert metrics["sales_amount"] is None
    assert metrics["product_cost"] is None
    assert metrics["expense_amount"] is None
    assert metrics["contribution_profit"] is None
    assert result["summary"]["quality"]["unknown_expenses"] == 1
    selected = read(golden, current, sku_ids=("001",))
    assert selected["summary"]["metrics"]["contribution_profit"] is None
    with psycopg.connect(app_url, autocommit=True) as connection, connection.transaction():
        bind_scope(connection, current)
        assert (
            connection.execute(
                "SELECT accounting_status FROM bi.expense_snapshots WHERE expense_id='adjust'"
            ).fetchone()[0]
            == "missing_weight"
        )


def test_version_cross_workspace_read_only_and_scope_cache(golden):
    scope = calculate(golden)
    with psycopg.connect(golden[1], autocommit=True) as connection:
        with pytest.raises(OperationConflict, match="更新"):
            query_ledger(connection, replace(scope, version=1), Query())
        with pytest.raises(ScopeError):
            query_ledger(connection, replace(scope, workspace_id="another"), Query())
        read_only = replace(scope, capabilities=frozenset({"ledger.read"}))
        assert query_ledger(connection, read_only, Query())["version"] == 2
        with pytest.raises(ScopeError):
            preview_recalculation(connection, read_only)


def test_pagination_stable_full_summary_search_and_dataset_latest_date(golden):
    scope = calculate(golden)
    first = read(golden, scope, dimension="sku", page_size=1, sort="key", descending=False)
    second = read(golden, scope, dimension="sku", page_size=1, page=2, sort="key", descending=False)
    third = read(golden, scope, dimension="sku", page_size=1, page=3, sort="key", descending=False)
    assert {first["rows"][0]["key"], second["rows"][0]["key"], third["rows"][0]["key"]} == {
        "001",
        "002",
        "__unattributed__",
    }
    assert first["summary"] == second["summary"] == third["summary"]
    assert first["total"] == 3
    assert read(golden, scope, dimension="sku", page=100)["rows"] == []
    assert read(golden, scope, dimension="sku", search="规格002")["total"] == 1
    with psycopg.connect(golden[1], autocommit=True) as connection:
        latest = query_ledger(connection, scope, Query())
    assert (
        latest["range"]["end"] == "2026-10-04"
    )  # most recent completed refund is a business event even in payment-basis analysis
    assert latest["range"]["start"] == "2026-09-05"


def test_concurrent_recalc_one_commit_idempotent_replay_and_history_protection(golden):
    scope, app_url, admin_url = golden
    with psycopg.connect(app_url, autocommit=True) as connection:
        previews = [preview_recalculation(connection, scope) for _ in range(2)]

    def confirm(index):
        with psycopg.connect(app_url, autocommit=True) as connection:
            try:
                return confirm_recalculation(
                    connection, scope, previews[index], f"k{index}", confirmed_by_user=True
                )
            except OperationConflict:
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(confirm, (0, 1)))
    assert sum(result is not None for result in results) == 1
    winner = next(index for index, result in enumerate(results) if result is not None)
    with psycopg.connect(app_url, autocommit=True) as connection:
        assert (
            confirm_recalculation(
                connection, scope, previews[winner], f"k{winner}", confirmed_by_user=True
            )
            == results[winner]
        )
        with pytest.raises(OperationConflict):
            confirm_recalculation(
                connection, scope, previews[1 - winner], f"k{winner}", confirmed_by_user=True
            )
    with psycopg.connect(admin_url, autocommit=True, row_factory=dict_row) as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM bi.accounting_runs WHERE workspace_id=%s",
                (scope.workspace_id,),
            ).fetchone()["n"]
            == 1
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "UPDATE bi.expense_snapshots SET amount_cny=0 WHERE workspace_id=%s",
                (scope.workspace_id,),
            )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "DELETE FROM bi.expense_allocations WHERE workspace_id=%s", (scope.workspace_id,)
            )


def test_recalc_error_rolls_back_all_and_explicit_confirmation_required(golden):
    scope, app_url, admin_url = golden
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_recalculation(connection, scope)
        with pytest.raises(ScopeError):
            confirm_recalculation(
                connection, scope, preview, "not-confirmed", confirmed_by_user=False
            )
    # Simulate an invalid source introduced by an out-of-protocol administrative write.
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE bi.order_lines SET quantity=0.0001 WHERE workspace_id=%s AND line_id='line-a'",
            (scope.workspace_id,),
        )
        connection.execute(
            "UPDATE bi.mappings SET unit_multiplier=0.0001 "
            "WHERE workspace_id=%s AND listing_id='la'",
            (scope.workspace_id,),
        )
    with psycopg.connect(app_url, autocommit=True) as connection:
        with pytest.raises(ValueError, match="四位"):
            confirm_recalculation(connection, scope, preview, "broken", confirmed_by_user=True)
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT version FROM bi.datasets").fetchone()[0] == 1
            assert connection.execute("SELECT count(*) FROM bi.line_snapshots").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM bi.operations").fetchone()[0] == 0


def test_missing_cost_repair_requires_confirmation_preserves_old_snapshot(golden):
    scope, app_url, admin_url = golden
    prefix = (scope.workspace_id, scope.dataset_id)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "DELETE FROM bi.cost_versions WHERE workspace_id=%s "
            "AND dataset_id=%s AND cost_id='base002'",
            prefix,
        )
    scope = calculate(golden)
    initial = read(golden, scope)["summary"]["metrics"]
    assert initial["product_cost"] is None
    assert initial["accounted_revenue"] == "170.00"
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "INSERT INTO bi.cost_versions VALUES (%s,%s,'repair002','002','base',"
            "NULL,NULL,10.0000,'CNY','2026-01-01',NULL,'缺失修复',3)",
            prefix,
        )
    # Merely repairing source cost does not rewrite old paid-order snapshots.
    assert read(golden, scope)["summary"]["metrics"]["product_cost"] is None
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_recalculation(connection, scope, only_missing=True)
        with connection.transaction():
            bind_scope(connection, scope)
            impact = connection.execute(
                "SELECT impact FROM bi.operation_previews WHERE preview_id=%s", (preview,)
            ).fetchone()[0]
            assert impact["changed_lines"] == 1
            assert impact["known_cost_before_cny"] == "42.00"
            assert impact["known_cost_after_cny"] == "52.00"
        result = confirm_recalculation(connection, scope, preview, "repair", confirmed_by_user=True)
        assert result["version"] == 3
        assert (
            confirm_recalculation(connection, scope, preview, "repair", confirmed_by_user=True)
            == result
        )
    current = replace(scope, version=3)
    assert read(golden, current)["summary"]["metrics"]["contribution_profit"] == "105.00"
    with psycopg.connect(admin_url, autocommit=True) as connection:
        history = connection.execute(
            "SELECT revision,cost_cny,accounting_status "
            "FROM bi.line_snapshots WHERE workspace_id=%s AND dataset_id=%s AND line_id='line-b' "
            "ORDER BY revision",
            prefix,
        ).fetchall()
        assert history[0] == (2, None, "missing_cost")
        assert str(history[1][1]) == "10.00"
        assert history[1][0] == 3


def test_mixed_unit_expense_is_not_falsely_assigned_and_platform_store_mismatch_rejected(golden):
    scope, _, admin_url = golden
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE bi.skus SET unit='箱' WHERE workspace_id=%s AND sku_id='002'",
            (scope.workspace_id,),
        )
    scope = calculate(golden)
    overall = read(golden, scope)
    assert overall["summary"]["metrics"]["contribution_profit"] == "105.00"
    assert overall["summary"]["metrics"]["standard_quantity"] is None
    selected = read(golden, scope, sku_ids=("001",))
    assert selected["summary"]["quality"]["unknown_attribution_expenses"] == 1
    assert selected["summary"]["metrics"]["contribution_profit"] is None
    grouped = read(golden, scope, dimension="sku")
    assert grouped["summary"] == overall["summary"]
    with pytest.raises(ValueError, match="平台"):
        read(golden, scope, channel_ids=("temu",), store_ids=("a",))
