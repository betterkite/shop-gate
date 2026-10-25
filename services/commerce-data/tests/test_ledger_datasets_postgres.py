"""Workspace directory/creation on actual isolated PG18, not daily user databases."""

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from shopgate_commerce_data.ledger.csv_contract import CsvFile, standard_csv
from shopgate_commerce_data.ledger.datasets import (
    DatasetPlan,
    bind_directory,
    create_dataset,
    dataset_metadata,
    list_datasets,
)
from shopgate_commerce_data.ledger.exchange import confirm_import, preview_import
from shopgate_commerce_data.ledger.migrations import MIGRATION, migrate, migrate_all
from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope
from shopgate_commerce_data.ledger.query import Query, query_ledger
from shopgate_commerce_data.ledger.scope import DirectoryScope, LedgerScope, ScopeError


@pytest.fixture(scope="module")
def directory_url():
    url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL")
    if not url:
        pytest.fail("Use trusted isolated npm run test:backend, not the daily database.")
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    with psycopg.connect(url, autocommit=True) as connection:
        migrate_all(connection)
        migrate_all(connection)
        connection.execute("CREATE ROLE directory_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO directory_app")
        connection.execute(
            "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA bi TO directory_app"
        )
        connection.execute("REVOKE ALL ON bi.schema_migrations FROM directory_app")
    return url


@pytest.fixture
def directory(directory_url):
    return (
        DirectoryScope(
            f"directory-{uuid4()}", "operator", frozenset({"datasets.read", "datasets.manage"})
        ),
        directory_url.replace("ledger_test_admin@", "directory_app@"),
        directory_url,
    )


def create(connection, scope, dataset="official", kind="import", key=None):
    return create_dataset(
        connection,
        scope,
        DatasetPlan(dataset, f"数据集{dataset}", kind),
        key or f"create-{dataset}",
        confirmed_by_user=True,
        demo_allowed=True,
    )


def fact_scope(scope, dataset="official", version=1):
    return LedgerScope(
        scope.workspace_id,
        dataset,
        scope.actor_id,
        version,
        frozenset({"ledger.read", "ledger.manage"}),
    )


def test_creation_is_confirmed_empty_accounting_and_metadata_atomic_not_startup_generation(
    directory,
):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        assert list_datasets(connection, scope)["total"] == 0
        result = create(connection, scope)
        assert result["source_kind"] == "import" and result["version"] == 1
        assert "尚未导入" in result["notice"]
        queried = query_ledger(connection, fact_scope(scope), Query())
        assert queried["version"] == queried["accounting_revision"] == 1
        assert queried["data_cutoff"] is None
        assert queried["summary"]["metrics"]["order_count"] == 0
        with connection.transaction():
            bind_scope(connection, fact_scope(scope))
            assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM bi.skus").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM bi.accounting_runs").fetchone()[0] == 1
        assert list_datasets(connection, scope)["rows"][0]["dataset_id"] == "official"
    # A new process/connection sees durable catalog, original kind, version and creation evidence.
    with psycopg.connect(app, autocommit=True) as connection:
        assert create(connection, scope) == result
        assert list_datasets(connection, scope)["total"] == 1
        with connection.transaction():
            bind_directory(connection, scope)
            assert (
                connection.execute("SELECT count(*) FROM bi.dataset_creations").fetchone()[0] == 1
            )


def test_selected_metadata_is_available_off_page_without_broadening_facts(directory):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        for index in range(23):
            create(connection, scope, f"data-{index:02}")
        assert "data-22" not in {
            row["dataset_id"] for row in list_datasets(connection, scope)["rows"]
        }
        selected = dataset_metadata(connection, scope, "data-22")
        assert selected["dataset_id"] == "data-22" and selected["version"] == 1
        with pytest.raises(ScopeError):
            dataset_metadata(connection, replace(scope, workspace_id="foreign"), "data-22")
        with connection.transaction():
            bind_scope(connection, fact_scope(scope, "data-22"))
            connection.execute("UPDATE bi.datasets SET state='archived'")
        with pytest.raises(ScopeError):
            dataset_metadata(connection, scope, "data-22")


def test_directory_permission_gives_metadata_not_facts_and_no_unscoped_or_foreign_rows(directory):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        create(connection, scope)
        create(connection, scope, "demo", "demo")
        assert {r["source_kind"] for r in list_datasets(connection, scope)["rows"]} == {
            "import",
            "demo",
        }
        assert (
            list_datasets(connection, replace(scope, workspace_id="other-workspace"))["rows"] == []
        )
        assert connection.execute("SELECT * FROM bi.dataset_directory").fetchall() == []
        with connection.transaction():
            bind_directory(connection, scope)
            assert (
                connection.execute("SELECT count(*) FROM bi.dataset_directory").fetchone()[0] == 2
            )
            for table in ("datasets", "orders", "products", "cost_versions", "import_rows"):
                assert (
                    connection.execute(
                        sql.SQL("SELECT count(*) FROM bi.{}").format(sql.Identifier(table))
                    ).fetchone()[0]
                    == 0
                )
            with pytest.raises(ScopeError):
                bind_scope(connection, scope)
            assert (
                connection.execute(
                    "UPDATE bi.dataset_directory SET name='forged' "
                    "WHERE dataset_id='official' RETURNING name"
                ).fetchall()
                == []
            )
            with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
                connection.execute(
                    "INSERT INTO bi.dataset_directory VALUES "
                    "(%s,'forged','forged','demo',1,'CNY','active',clock_timestamp())",
                    (scope.workspace_id,),
                )
            assert (
                connection.execute(
                    "DELETE FROM bi.dataset_directory RETURNING dataset_id"
                ).fetchall()
                == []
            )
        assert connection.execute("SELECT * FROM bi.datasets").fetchall() == []


def test_catalog_syncs_import_version_same_transaction_and_archiving_hides_selection(directory):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        create(connection, scope)
        initial = list_datasets(connection, scope)["rows"][0]
        facts = fact_scope(scope)
        file = CsvFile(
            "products",
            "商品.csv",
            standard_csv(
                "products",
                [
                    {"product_id": "00001", "name": "商品", "category": "日用", "series": ""},
                ],
            ),
        )
        preview = preview_import(connection, facts, [file])
        assert list_datasets(connection, scope)["rows"][0]["version"] == 1
        result = confirm_import(
            connection, facts, preview["preview_id"], "import", confirmed_by_user=True
        )
        updated = list_datasets(connection, scope)["rows"][0]
        assert (
            result["version"] == updated["version"] == 2
            and updated["updated_at"] > initial["updated_at"]
        )
        with connection.transaction():
            bind_scope(connection, replace(facts, version=2))
            connection.execute(
                "UPDATE bi.datasets SET state='archived',updated_at=clock_timestamp()"
            )
        assert list_datasets(connection, scope)["total"] == 0
        with pytest.raises(ScopeError):
            query_ledger(connection, replace(facts, version=2), Query())


def test_directory_all_23_accessible_with_stable_paging_source_filters_and_no_restart_reset(
    directory,
):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        for index in range(23):
            create(connection, scope, f"set-{index:02d}", "demo" if index % 2 else "import")
        first, second = list_datasets(connection, scope), list_datasets(connection, scope, page=2)
        assert first["total"] == second["total"] == 23
        assert len(first["rows"]) == 20 and len(second["rows"]) == 3
        assert [r["dataset_id"] for r in first["rows"] + second["rows"]] == [
            f"set-{index:02d}" for index in range(23)
        ]
        assert list_datasets(connection, scope, page=3)["rows"] == []
        assert list_datasets(connection, scope, source_kind="import")["total"] == 12
        assert list_datasets(connection, scope, source_kind="demo")["total"] == 11
    with psycopg.connect(app, autocommit=True) as connection:
        assert list_datasets(connection, scope, page=2) == second


def test_idempotency_conflicts_actor_reuse_and_demo_never_replace_formal_origin(directory):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        result = create(connection, scope, key="same-key")
        assert create(connection, scope, key="same-key") == result
        for dataset, kind, key, actor in (
            ("changed", "import", "same-key", scope.actor_id),
            ("official", "demo", "new-key", scope.actor_id),
            ("official", "import", "new-key", scope.actor_id),
            ("other-target", "import", "same-key", "another-member"),
        ):
            with pytest.raises(OperationConflict):
                create(connection, replace(scope, actor_id=actor), dataset, kind, key)
        assert list_datasets(connection, scope)["total"] == 1
        assert list_datasets(connection, scope)["rows"][0]["source_kind"] == "import"
        with connection.transaction():
            bind_scope(connection, fact_scope(scope))
            with pytest.raises(psycopg.errors.CheckViolation), connection.transaction():
                connection.execute("UPDATE bi.datasets SET source_kind='demo'")
            assert connection.execute("SELECT source_kind,version FROM bi.datasets").fetchone() == (
                "import",
                1,
            )
        with connection.transaction():
            bind_directory(connection, replace(scope, actor_id="another-member"))
            assert connection.execute("SELECT * FROM bi.dataset_creations").fetchall() == []


def test_parallel_create_retries_once_and_different_requests_do_not_partially_commit(directory):
    scope, app, _ = directory

    def submit(dataset="official", key="concurrent"):
        with psycopg.connect(app, autocommit=True) as connection:
            try:
                return create(connection, scope, dataset, key=key)
            except OperationConflict:
                return "conflict"

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: submit(), range(4)))
    assert all(result == results[0] for result in results)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda dataset: submit(dataset, "different"), ("a", "b")))
    assert sum(result == "conflict" for result in results) == 1
    with psycopg.connect(app, autocommit=True) as connection:
        assert list_datasets(connection, scope)["total"] == 2
        with connection.transaction():
            bind_directory(connection, scope)
            assert (
                connection.execute("SELECT count(*) FROM bi.dataset_creations").fetchone()[0] == 2
            )


@pytest.mark.parametrize(
    "case", ["read_only", "no_confirmation", "truthy_confirmation", "demo_disabled", "mode_invalid"]
)
def test_creation_management_confirmation_and_runtime_mode_guard(directory, case):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        with pytest.raises((ScopeError, ValueError)):
            create_dataset(
                connection,
                replace(scope, capabilities=frozenset({"datasets.read"}))
                if case == "read_only"
                else scope,
                DatasetPlan("demo", "演示数据", "demo"),
                "new",
                confirmed_by_user=False
                if case == "no_confirmation"
                else "yes"
                if case == "truthy_confirmation"
                else True,
                demo_allowed=False
                if case == "demo_disabled"
                else "yes"
                if case == "mode_invalid"
                else True,
            )
        assert list_datasets(connection, scope)["total"] == 0
        # Disabling demos does not disable explicitly confirmed formal imports.
        assert (
            create_dataset(
                connection,
                scope,
                DatasetPlan("official", "正式数据", "import"),
                "formal",
                confirmed_by_user=True,
                demo_allowed=False,
            )["source_kind"]
            == "import"
        )


def test_creation_error_rolls_back_workspace_catalog_accounting_and_audit_in_real_db(directory):
    scope, _, admin = directory
    with psycopg.connect(admin, autocommit=True) as connection:
        connection.execute("CREATE ROLE directory_atomic_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO directory_atomic_app")
        connection.execute(
            "GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA bi TO directory_atomic_app"
        )
        connection.execute("REVOKE INSERT ON bi.accounting_runs FROM directory_atomic_app")
    app = admin.replace("ledger_test_admin@", "directory_atomic_app@")
    with psycopg.connect(app, autocommit=True) as connection:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            create(connection, scope)
        assert list_datasets(connection, scope)["total"] == 0
    with psycopg.connect(admin, autocommit=True) as connection:
        for table in (
            "workspaces",
            "datasets",
            "dataset_directory",
            "dataset_creations",
            "accounting_runs",
        ):
            assert (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM bi.{} WHERE workspace_id=%s").format(
                        sql.Identifier(table)
                    ),
                    (scope.workspace_id,),
                ).fetchone()[0]
                == 0
            )
        connection.execute("GRANT INSERT ON bi.accounting_runs TO directory_atomic_app")
    with psycopg.connect(app, autocommit=True) as connection:
        assert create(connection, scope)["version"] == 1


def test_directory_scope_requires_transaction_and_rejects_admin_role(directory):
    scope, app, admin = directory
    with (
        psycopg.connect(app, autocommit=True) as connection,
        pytest.raises(ScopeError, match="事务"),
    ):
        bind_directory(connection, scope)
    with psycopg.connect(admin, autocommit=True) as connection:
        with pytest.raises(ScopeError, match="超级用户"):
            list_datasets(connection, scope)
        with pytest.raises(ScopeError, match="超级用户"):
            create(connection, scope)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"page": 0},
        {"page": True},
        {"page": 1_000_001},
        {"page_size": 0},
        {"page_size": 101},
        {"source_kind": []},
    ],
)
def test_directory_invalid_pagination_source_and_no_nested_transactions(directory, kwargs):
    scope, app, _ = directory
    with psycopg.connect(app, autocommit=True) as connection:
        with pytest.raises(ValueError):
            list_datasets(connection, scope, **kwargs)
        with connection.transaction(), pytest.raises(ValueError, match="独立事务"):
            list_datasets(connection, scope)


def test_forward_migration_backfills_only_metadata_and_has_no_security_definer(directory):
    _, _, admin = directory
    database = f"directory_migration_{uuid4().hex}"
    with psycopg.connect(admin, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    target = admin.rsplit("/", 1)[0] + "/" + database
    with psycopg.connect(target, autocommit=True) as connection:
        for revision, filename in (
            ("006", "006-bi-ledger.sql"),
            ("007", "007-bi-accounting.sql"),
            ("008", "008-bi-exchange.sql"),
        ):
            migrate(connection, migration_path=MIGRATION.with_name(filename), revision=revision)
        connection.execute("INSERT INTO bi.workspaces(workspace_id,name) VALUES ('old','旧空间')")
        connection.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind,version) "
            "VALUES ('old','existing','已有数据','import',7)"
        )
        migrate_all(connection)
        migrate_all(connection)
        assert connection.execute(
            "SELECT name,source_kind,version FROM bi.dataset_directory"
        ).fetchone() == ("已有数据", "import", 7)
        assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 0
        assert (
            connection.execute(
                "SELECT prosecdef FROM pg_proc "
                "WHERE oid='bi.sync_dataset_directory()'::regprocedure"
            ).fetchone()[0]
            is False
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM bi.schema_migrations WHERE revision='009'"
            ).fetchone()[0]
            == 1
        )
