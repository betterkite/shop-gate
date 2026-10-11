"""Real PostgreSQL tests, not mocks. npm run test:backend supplies a fresh cluster."""

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from shopgate_commerce_data.ledger.migrations import MIGRATION, migrate
from shopgate_commerce_data.ledger.operations import (
    MutationResult,
    OperationConflict,
    bind_scope,
    confirm_operation,
    create_preview,
)
from shopgate_commerce_data.ledger.scope import LedgerScope, ScopeError


@pytest.fixture(scope="module")
def admin_url():
    url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL")
    if not url:
        pytest.fail("Real ledger integration requires npm run test:backend; never use daily DB.")
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    with psycopg.connect(url, autocommit=True) as connection:
        migrate(connection)
        migrate(connection)
        connection.execute("CREATE ROLE ledger_test_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO ledger_test_app")
        connection.execute(
            "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA bi TO ledger_test_app"
        )
        connection.execute("REVOKE ALL ON bi.schema_migrations FROM ledger_test_app")
    return url


@pytest.fixture
def context(admin_url):
    workspace_id = f"space-{uuid4()}"
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "INSERT INTO bi.workspaces(workspace_id,name) VALUES (%s,'测试空间')", (workspace_id,)
        )
        connection.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,'demo','测试数据集','demo')",
            (workspace_id,),
        )
    scope = LedgerScope(
        workspace_id, "demo", "member-a", 1, frozenset({"ledger.read", "ledger.manage"})
    )
    app_url = admin_url.replace("ledger_test_admin@", "ledger_test_app@")
    return scope, app_url, admin_url


def apply_target(connection, kind, payload):
    assert kind == "target"
    connection.execute(
        "INSERT INTO bi.targets "
        "(workspace_id,dataset_id,store_id,month,sales_target) "
        "VALUES (current_setting('shopgate.workspace_id'),"
        "current_setting('shopgate.dataset_id'),%s,%s,%s)",
        (payload["store_id"], payload["month"], payload["sales_target"]),
    )
    return MutationResult(True, {"sales_target": payload["sales_target"]})


def seed_store(admin_url, scope):
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "INSERT INTO bi.channels VALUES (%s,%s,'pdd','拼多多')",
            (scope.workspace_id, scope.dataset_id),
        )
        connection.execute(
            "INSERT INTO bi.stores VALUES (%s,%s,'store-a','pdd','测试店铺')",
            (scope.workspace_id, scope.dataset_id),
        )


def preview_target(connection, scope, **kwargs):
    return create_preview(
        connection,
        scope,
        "target",
        {"store_id": "store-a", "month": "2026-10-01", "sales_target": "100.01"},
        {"stores": 1},
        **kwargs,
    )


def test_migration_repeat_and_checksum_not_silent_mutation(context, tmp_path):
    _, _, admin_url = context
    with psycopg.connect(admin_url, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM bi.schema_migrations WHERE revision='006'"
            ).fetchone()[0]
            == 1
        )
        altered = tmp_path / "changed.sql"
        altered.write_text(MIGRATION.read_text() + "\n-- changed\n")
        with pytest.raises(RuntimeError, match="校验"):
            migrate(connection, migration_path=altered)
        assert connection.execute("SELECT checksum FROM bi.schema_migrations").fetchone()


def test_versioned_migration_is_not_a_startup_bootstrap():
    assert MIGRATION.parent.name == "ledger"
    assert not (MIGRATION.parent.parent / MIGRATION.name).exists()


def test_scope_binding_requires_a_transaction(context):
    scope, app_url, _ = context
    with (
        psycopg.connect(app_url, autocommit=True) as connection,
        pytest.raises(ScopeError, match="事务"),
    ):
        bind_scope(connection, scope)


def test_ddl_failure_is_atomic_on_a_separate_database(context, tmp_path):
    _, _, admin_url = context
    database = f"ledger_migration_{uuid4().hex}"
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    target_url = admin_url.rsplit("/", 1)[0] + "/" + database
    bad = tmp_path / "bad.sql"
    bad.write_text(MIGRATION.read_text() + "\nSELECT this_function_does_not_exist();")
    with psycopg.connect(target_url, autocommit=True) as connection:
        with pytest.raises(psycopg.Error):
            migrate(connection, migration_path=bad)
        assert connection.execute("SELECT to_regnamespace('bi')").fetchone()[0] is None
        migrate(connection)
        assert connection.execute("SELECT to_regclass('bi.orders')").fetchone()[0]


@pytest.mark.parametrize("text", ["1.001", "NaN", "Infinity", "10000000000000000"])
def test_database_rejects_not_rounds_money(context, text):
    _, _, admin_url = context
    with (
        psycopg.connect(admin_url, autocommit=True) as connection,
        pytest.raises(psycopg.errors.CheckViolation),
    ):
        connection.execute("SELECT %s::bi.money", (text,))


def test_cross_scope_foreign_key_and_store_channel_constraints(context):
    scope, _, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,'other','其他','demo')",
            (scope.workspace_id,),
        )
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            connection.execute(
                "INSERT INTO bi.stores VALUES (%s,'other','bad','pdd','跨数据集')",
                (scope.workspace_id,),
            )
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            connection.execute(
                "INSERT INTO bi.stores VALUES ('other-space','demo','bad','pdd','跨空间')"
            )


def test_rls_no_scope_no_leak_and_local_settings_clear(context):
    scope, app_url, _ = context
    with psycopg.connect(app_url, autocommit=True) as connection:
        assert connection.execute("SELECT * FROM bi.datasets").fetchall() == []
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT workspace_id FROM bi.datasets").fetchall() == [
                (scope.workspace_id,)
            ]
            with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
                connection.execute("INSERT INTO bi.channels VALUES ('another','demo','x','x')")
        assert connection.execute("SELECT * FROM bi.datasets").fetchall() == []


def test_runtime_superuser_is_rejected(context):
    scope, _, admin_url = context
    with (
        psycopg.connect(admin_url, autocommit=True) as connection,
        connection.transaction(),
        pytest.raises(ScopeError, match="超级用户"),
    ):
        bind_scope(connection, scope)


def seed_catalog(admin_url, scope):
    seed_store(admin_url, scope)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        prefix = (scope.workspace_id, scope.dataset_id)
        connection.execute("INSERT INTO bi.products VALUES (%s,%s,'p-001','商品','日用品')", prefix)
        connection.execute("INSERT INTO bi.skus VALUES (%s,%s,'001','p-001','规格','件')", prefix)
        connection.execute(
            "INSERT INTO bi.listings VALUES (%s,%s,'l-001','store-a','00001','平台商品')", prefix
        )
        connection.execute(
            "INSERT INTO bi.orders VALUES (%s,%s,'o-001','store-a',"
            "'2026-10-01T00:00:00Z','CNY','paid')",
            prefix,
        )
        connection.execute(
            "INSERT INTO bi.order_lines VALUES (%s,%s,'line-001','o-001',"
            "'store-a','l-001',2.0000,100.00)",
            prefix,
        )


def test_temporal_mapping_and_cost_intervals_not_ambiguous(context):
    scope, _, admin_url = context
    seed_catalog(admin_url, scope)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        prefix = (scope.workspace_id, scope.dataset_id)
        connection.execute(
            "INSERT INTO bi.mappings VALUES (%s,%s,'m-1','l-001','001',"
            "2.0000,'2026-01-01','2026-06-01',1)",
            prefix,
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "INSERT INTO bi.mappings VALUES (%s,%s,'m-2','l-001','001',"
                "1.0000,'2026-05-01',NULL,1)",
                prefix,
            )
        connection.execute(
            "INSERT INTO bi.mappings VALUES (%s,%s,'m-2','l-001','001',1.0000,'2026-06-01',NULL,1)",
            prefix,
        )
        connection.execute(
            "INSERT INTO bi.cost_versions VALUES (%s,%s,'c-1','001','base',"
            "NULL,NULL,10.1234,'CNY','2026-01-01',NULL,'test',1)",
            prefix,
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "INSERT INTO bi.cost_versions VALUES (%s,%s,'c-2','001','base',"
                "NULL,NULL,11.0000,'CNY','2026-02-01',NULL,'test',1)",
                prefix,
            )
        connection.execute(
            "INSERT INTO bi.cost_versions VALUES (%s,%s,'c-3','001','store',"
            "'pdd','store-a',9.0000,'CNY','2026-02-01',NULL,'test',1)",
            prefix,
        )


def test_partial_refund_cumulative_limits_and_refund_only_no_recovery(context):
    scope, _, admin_url = context
    seed_catalog(admin_url, scope)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        prefix = (scope.workspace_id, scope.dataset_id)
        connection.execute(
            "INSERT INTO bi.refunds VALUES (%s,%s,'r-1','line-001',"
            "'2026-10-02',40.00,'refund_only',0,0,'test','completed')",
            prefix,
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "INSERT INTO bi.refunds VALUES (%s,%s,'r-2','line-001',"
                "'2026-10-03',61.00,'refund_only',0,0,'test','completed')",
                prefix,
            )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "INSERT INTO bi.refunds VALUES (%s,%s,'r-2','line-001',"
                "'2026-10-03',10.00,'refund_only',1,1,'test','completed')",
                prefix,
            )
        connection.execute(
            "INSERT INTO bi.refunds VALUES (%s,%s,'r-2','line-001',"
            "'2026-10-03',60.00,'return',1,1,'test','completed')",
            prefix,
        )


def test_preview_then_confirm_version_idempotency_and_audit(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)
        with psycopg.connect(admin_url, autocommit=True) as admin:
            assert (
                admin.execute(
                    "SELECT version FROM bi.datasets WHERE workspace_id=%s", (scope.workspace_id,)
                ).fetchone()[0]
                == 1
            )
            assert (
                admin.execute(
                    "SELECT * FROM bi.targets WHERE workspace_id=%s", (scope.workspace_id,)
                ).fetchall()
                == []
            )
        result = confirm_operation(
            connection, scope, preview_id, "submit-a", confirmed_by_user=True, apply=apply_target
        )
        assert result == {"version": 2, "changed": True, "data": {"sales_target": "100.01"}}
        assert (
            confirm_operation(
                connection,
                scope,
                preview_id,
                "submit-a",
                confirmed_by_user=True,
                apply=lambda *_: pytest.fail("Replay"),
            )
            == result
        )
        with pytest.raises(OperationConflict):
            confirm_operation(
                connection,
                scope,
                preview_id,
                "other-key",
                confirmed_by_user=True,
                apply=apply_target,
            )
    with psycopg.connect(admin_url, autocommit=True) as admin:
        assert (
            admin.execute(
                "SELECT count(*) FROM bi.audit_events WHERE workspace_id=%s", (scope.workspace_id,)
            ).fetchone()[0]
            == 1
        )
        assert (
            str(
                admin.execute(
                    "SELECT sales_target FROM bi.targets WHERE workspace_id=%s",
                    (scope.workspace_id,),
                ).fetchone()[0]
            )
            == "100.01"
        )


def test_requires_confirmation_capability_and_same_actor(context):
    scope, app_url, _ = context
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)
        with pytest.raises(ScopeError):
            confirm_operation(
                connection,
                scope,
                preview_id,
                "unconfirmed",
                confirmed_by_user=False,
                apply=apply_target,
            )
        with pytest.raises(ScopeError):
            preview_target(connection, replace(scope, capabilities=frozenset({"ledger.read"})))
        with pytest.raises(ScopeError):
            confirm_operation(
                connection,
                replace(scope, actor_id="another-user"),
                preview_id,
                "forged",
                confirmed_by_user=True,
                apply=apply_target,
            )


def test_same_key_different_preview_and_stale_version_rejected(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        first = preview_target(connection, scope)
        second = preview_target(connection, scope)
        confirm_operation(
            connection, scope, first, "key-a", confirmed_by_user=True, apply=apply_target
        )
        with pytest.raises(OperationConflict, match="标识"):
            confirm_operation(
                connection, scope, second, "key-a", confirmed_by_user=True, apply=apply_target
            )
        with pytest.raises(OperationConflict, match="更新"):
            confirm_operation(
                connection, scope, second, "key-b", confirmed_by_user=True, apply=apply_target
            )


def test_expired_preview_and_callback_failure_rollback_every_effect(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(
                "UPDATE bi.operation_previews SET expires_at=clock_timestamp() "
                "- interval '1 second' WHERE preview_id=%s",
                (preview_id,),
            )
        with pytest.raises(OperationConflict, match="过期"):
            confirm_operation(
                connection, scope, preview_id, "expired", confirmed_by_user=True, apply=apply_target
            )
        new_preview = preview_target(connection, scope)

        def fail_after_write(conn, kind, payload):
            apply_target(conn, kind, payload)
            raise RuntimeError("故意验证整批回滚")

        with pytest.raises(RuntimeError):
            confirm_operation(
                connection,
                scope,
                new_preview,
                "rollback-a",
                confirmed_by_user=True,
                apply=fail_after_write,
            )
        assert (
            confirm_operation(
                connection,
                scope,
                new_preview,
                "rollback-a",
                confirmed_by_user=True,
                apply=apply_target,
            )["version"]
            == 2
        )


def test_noop_does_not_increase_business_version(context):
    scope, app_url, _ = context
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)
        result = confirm_operation(
            connection,
            scope,
            preview_id,
            "noop",
            confirmed_by_user=True,
            apply=lambda *_: MutationResult(False, {"duplicate": True}),
        )
        assert result["version"] == 1 and result["changed"] is False


def test_simultaneous_retry_returns_same_result_once(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)

    def retry(_):
        with psycopg.connect(app_url, autocommit=True) as connection:
            return confirm_operation(
                connection,
                scope,
                preview_id,
                "same-request",
                confirmed_by_user=True,
                apply=apply_target,
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(retry, (0, 1)))
    assert results[0] == results[1] and results[0]["version"] == 2
    with psycopg.connect(admin_url, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM bi.audit_events WHERE workspace_id=%s", (scope.workspace_id,)
            ).fetchone()[0]
            == 1
        )


def test_snapshot_unknown_is_null_and_history_is_append_only(context):
    scope, _, admin_url = context
    seed_catalog(admin_url, scope)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        prefix = (scope.workspace_id, scope.dataset_id)
        connection.execute(
            "INSERT INTO bi.line_snapshots "
            "(workspace_id,dataset_id,line_id,revision,accounting_status) "
            "VALUES (%s,%s,'line-001',1,'missing_mapping')",
            prefix,
        )
        assert connection.execute(
            "SELECT unit_cost, cost_cny FROM bi.line_snapshots "
            "WHERE workspace_id=%s AND line_id='line-001'",
            (scope.workspace_id,),
        ).fetchone() == (None, None)
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "UPDATE bi.line_snapshots SET cost_cny=0 WHERE workspace_id=%s",
                (scope.workspace_id,),
            )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "INSERT INTO bi.line_snapshots "
                "(workspace_id,dataset_id,line_id,revision,accounting_status) "
                "VALUES (%s,%s,'line-001',2,'complete')",
                prefix,
            )


def test_audit_and_committed_idempotency_results_cannot_be_overwritten(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)
        confirm_operation(
            connection, scope, preview_id, "immutable", confirmed_by_user=True, apply=apply_target
        )
    with psycopg.connect(admin_url, autocommit=True) as connection:
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "UPDATE bi.operations SET committed_version=3 WHERE workspace_id=%s",
                (scope.workspace_id,),
            )
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "DELETE FROM bi.audit_events WHERE workspace_id=%s", (scope.workspace_id,)
            )


def test_concurrent_confirms_exactly_one_commits(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        previews = [preview_target(connection, scope), preview_target(connection, scope)]

    def run(index):
        with psycopg.connect(app_url, autocommit=True) as conn:
            try:
                return confirm_operation(
                    conn,
                    scope,
                    previews[index],
                    f"concurrent-{index}",
                    confirmed_by_user=True,
                    apply=apply_target,
                )
            except OperationConflict:
                return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, (0, 1)))
    assert results.count("conflict") == 1
    assert sum(isinstance(result, dict) and result["version"] == 2 for result in results) == 1
    with psycopg.connect(admin_url, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM bi.targets WHERE workspace_id=%s", (scope.workspace_id,)
            ).fetchone()[0]
            == 1
        )


def test_zz_real_cluster_restart_preserves_committed_ledger(context):
    scope, app_url, admin_url = context
    seed_store(admin_url, scope)
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview_id = preview_target(connection, scope)
        confirm_operation(
            connection,
            scope,
            preview_id,
            "before-restart",
            confirmed_by_user=True,
            apply=apply_target,
        )
    directory = os.environ["SHOPGATE_LEDGER_TEST_CLUSTER"]
    assert Path(directory).name == "cluster" and Path(directory).parent.name.startswith(
        "shopgate-ledger-test-"
    )
    environment = {**os.environ, **json.loads(os.environ["SHOPGATE_LEDGER_TEST_PG_ENV"])}
    subprocess.run(
        [
            os.environ["SHOPGATE_LEDGER_TEST_PG_CTL"],
            "-D",
            directory,
            "-w",
            "-l",
            str(Path(directory).parent / "postgres.log"),
            "-m",
            "fast",
            "restart",
        ],
        check=True,
        capture_output=True,
        env=environment,
    )
    with psycopg.connect(admin_url, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT version FROM bi.datasets WHERE workspace_id=%s", (scope.workspace_id,)
            ).fetchone()[0]
            == 2
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM bi.audit_events WHERE workspace_id=%s", (scope.workspace_id,)
            ).fetchone()[0]
            == 1
        )
