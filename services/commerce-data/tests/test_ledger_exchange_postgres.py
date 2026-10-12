"""Full CSV12 exchange on isolated real PG18; expected money is manually derived."""

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from decimal import Decimal
from uuid import uuid4

import psycopg
import pytest

from shopgate_commerce_data.ledger.csv_contract import SPECS, CsvFile, standard_csv
from shopgate_commerce_data.ledger.exchange import (
    confirm_import,
    download_errors,
    export_csv12,
    list_batches,
    preview_import,
)
from shopgate_commerce_data.ledger.migrations import migrate_all
from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope
from shopgate_commerce_data.ledger.query import Query, query_ledger
from shopgate_commerce_data.ledger.scope import LedgerScope, ScopeError


@pytest.fixture(scope="module")
def exchange_url():
    url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL")
    if not url:
        pytest.fail("Use trusted isolated npm run test:backend; never the daily database.")
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    with psycopg.connect(url, autocommit=True) as connection:
        migrate_all(connection)
        migrate_all(connection)
        connection.execute("CREATE ROLE exchange_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO exchange_app")
        connection.execute("GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA bi TO exchange_app")
        connection.execute("REVOKE ALL ON bi.schema_migrations FROM exchange_app")
    return url


@pytest.fixture
def empty(exchange_url):
    workspace = f"exchange-{uuid4()}"
    scope = LedgerScope(
        workspace, "imported", "operator", 1, frozenset({"ledger.read", "ledger.manage"})
    )
    with psycopg.connect(exchange_url, autocommit=True) as connection:
        connection.execute(
            "INSERT INTO bi.workspaces(workspace_id,name) VALUES (%s,'导入验证空间')", (workspace,)
        )
        connection.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,%s,'正式导入集','import')",
            (workspace, scope.dataset_id),
        )
    return scope, exchange_url.replace("ledger_test_admin@", "exchange_app@"), exchange_url


def manual_records():
    """260 sales - 96 refunds - (66 cost - 33 recovered) - 10 expenses = 121.

    The USD payment uses explicit 8, product cost uses daily 7, never the payment rate.
    Unpaid/cancelled and pending refunds are independently recorded but excluded.
    """
    start = "2026-01-01T00:00:00Z"
    paid = "2026-07-01T00:00:00Z"
    refund = "2026-07-02T00:00:00Z"
    return {
        "channels": [{"channel_id": "pdd", "name": "拼多多", "color": "#0e7490"}],
        "stores": [
            {
                "store_id": store,
                "channel_id": "pdd",
                "name": f"店铺{store}",
                "market": "中国",
                "mode": "自营",
                "currency": "CNY",
                "timezone": "Asia/Shanghai",
            }
            for store in ("001", "002")
        ],
        "products": [
            {"product_id": f"p{i}", "name": f"商品{i}", "category": "日用品", "series": "基础款"}
            for i in ("001", "002")
        ],
        "skus": [
            {"sku_id": i, "product_id": f"p{i}", "name": f"规格{i}", "unit": "件"}
            for i in ("001", "002")
        ],
        "mappings": [
            {
                "listing_id": f"l{i}",
                "store_id": i,
                "platform_sku_id": f"000{i}",
                "name": f"平台商品{i}",
                "platform_product_id": f"原始{i}",
                "unit": "包",
                "status": "mapped",
                "mapping_id": f"m{i}",
                "sku_id": i,
                "unit_multiplier": "2" if i == "001" else "1",
                "valid_from": start,
                "valid_to": None,
            }
            for i in ("001", "002")
        ]
        + [
            {
                "listing_id": "unknown",
                "store_id": "001",
                "platform_sku_id": "待映射000",
                "name": "未知规格",
                "platform_product_id": "",
                "unit": "件",
                "status": "unmapped",
            }
        ],
        "fx_rates": [
            {
                "rate_id": "usd-july",
                "currency": "USD",
                "rate_date": "2026-07-01",
                "rate": "7",
                "source": "人工复算汇率",
            }
        ],
        "costs": [
            {
                "cost_id": f"c{i}",
                "sku_id": i,
                "level": "base",
                "channel_id": None,
                "store_id": None,
                "unit_cost": "2" if i == "001" else "10",
                "currency": "USD" if i == "001" else "CNY",
                "valid_from": start,
                "valid_to": None,
                "source": "人工复算成本",
            }
            for i in ("001", "002")
        ],
        "orders": [
            {
                "order_id": oid,
                "store_id": store,
                "platform_order_id": f"000原单{oid}",
                "paid_at": None if status == "unpaid" else paid,
                "status": status,
                "fulfillment_status": "unshipped" if oid == "o2" else "delivered",
                "currency": "USD" if oid == "o1" else "CNY",
                "fx_rate": "8" if oid == "o1" else None,
                "fx_source": "订单原始汇率" if oid == "o1" else None,
            }
            for oid, store, status in (
                ("o1", "001", "paid"),
                ("o2", "002", "paid"),
                ("o3", "001", "unpaid"),
                ("o4", "001", "cancelled"),
            )
        ],
        "order_lines": [
            {
                "line_id": f"line-{oid}",
                "order_id": oid,
                "store_id": store,
                "listing_id": f"l{store}",
                "quantity": qty,
                "paid_amount": amount,
            }
            for oid, store, qty, amount in (
                ("o1", "001", "2", "20"),
                ("o2", "002", "1", "100"),
                ("o3", "001", "1", "999"),
                ("o4", "001", "1", "200"),
            )
        ],
        "refunds": [
            {
                "refund_id": rid,
                "line_id": line,
                "occurred_at": time,
                "amount": amount,
                "refund_type": kind,
                "returned_quantity": returned,
                "recoverable_quantity": returned,
                "cancelled_quantity": cancelled,
                "reason": "测试售后",
                "status": status,
            }
            for rid, line, time, amount, kind, returned, cancelled, status in (
                ("r1", "line-o1", refund, "2", "refund_only", "0", "0", "completed"),
                ("r2", "line-o1", refund, "5", "return", "1", "0", "completed"),
                ("r3", "line-o2", refund, "40", "unshipped_cancel", "0", "0.5", "completed"),
                ("r4", "line-o1", None, "10", "refund_only", "0", "0", "pending"),
            )
        ],
        "expenses": [
            {
                "expense_id": eid,
                "occurred_at": paid,
                "store_id": store,
                "channel_id": "pdd",
                "line_id": line,
                "amount": amount,
                "currency": "CNY",
                "expense_type": "logistics",
                "allocation_method": method,
                "source": "真实费用来源",
                "note": "",
                "fx_rate": None,
                "fx_source": None,
            }
            for eid, store, line, amount, method in (
                ("e1", "001", "line-o1", "4", "direct"),
                ("e2", None, None, "6", "unallocated"),
            )
        ],
        "targets": [
            {
                "store_id": "001",
                "month": "2026-07-01",
                "sales_target": "1000",
                "profit_target": "200",
            }
        ],
    }


def files(records=None):
    records = manual_records() if records is None else records
    return [
        CsvFile(resource, f"{resource}.csv", standard_csv(resource, entries))
        for resource, entries in records.items()
    ]


def commit(empty, records=None, key="import"):
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files(records))
        assert preview["state"] == "preview", preview["errors"]
        result = confirm_import(
            connection, scope, preview["preview_id"], key, confirmed_by_user=True
        )
    return replace(scope, version=result["version"]), preview, result


def count_sources(empty):
    scope, _, admin_url = empty
    with psycopg.connect(admin_url, autocommit=True) as connection:
        return connection.execute(
            "SELECT (SELECT count(*) FROM bi.orders WHERE workspace_id=%s),"
            "(SELECT count(*) FROM bi.line_snapshots WHERE workspace_id=%s),"
            "(SELECT version FROM bi.datasets WHERE workspace_id=%s)",
            (scope.workspace_id,) * 3,
        ).fetchone()


def test_preview_does_not_change_sources_and_confirm_is_manually_reproducible(empty):
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files())
        assert preview["state"] == "preview", preview["errors"]
        assert count_sources(empty) == (0, 0, 1)
        result = confirm_import(
            connection, scope, preview["preview_id"], "first", confirmed_by_user=True
        )
        current = replace(scope, version=2)
        metrics = query_ledger(connection, current, Query())["summary"]["metrics"]
        assert metrics["sales_amount"] == "260.00"
        assert metrics["refund_amount"] == "96.00"
        assert metrics["net_sales"] == "164.00"
        assert metrics["product_cost"] == "33.00"
        assert metrics["expense_amount"] == "10.00"
        assert metrics["contribution_profit"] == "121.00"
        assert metrics["order_count"] == 2
        assert count_sources(empty) == (4, 2, 2)
        assert (
            confirm_import(
                connection, scope, preview["preview_id"], "first", confirmed_by_user=True
            )
            == result
        )
        assert len(list_batches(connection, current)["rows"]) == 1


def test_all_twelve_export_import_roundtrip_exact_duplicate_no_version_bump(empty):
    current, _, _ = commit(empty)
    with psycopg.connect(empty[1], autocommit=True) as connection:
        exported = export_csv12(connection, current)
        assert set(exported["files"]) == set(SPECS)
        assert b"000001" in exported["files"]["mappings"]
        preview = preview_import(
            connection,
            current,
            [CsvFile(r, f"{r}.csv", content) for r, content in exported["files"].items()],
        )
        assert preview["state"] == "preview", preview["errors"]
        assert all(
            count["duplicates"] and not count["inserted"] for count in preview["summary"].values()
        )
        result = confirm_import(
            connection, current, preview["preview_id"], "repeat", confirmed_by_user=True
        )
        assert result["version"] == 2 and result["changed"] is False
        assert export_csv12(connection, current) == exported
        with connection.transaction():
            bind_scope(connection, current)
            assert connection.execute("SELECT count(*) FROM bi.accounting_runs").fetchone()[0] == 1


def test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values(empty):
    current, _, _ = commit(empty)
    with psycopg.connect(empty[1], autocommit=True) as connection:
        exported = export_csv12(connection, current)["files"]
    with psycopg.connect(empty[2], autocommit=True) as admin:
        admin.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,'restored','标准往返集','import')",
            (current.workspace_id,),
        )
    restored = replace(current, dataset_id="restored", version=1)
    with psycopg.connect(empty[1], autocommit=True) as connection:
        preview = preview_import(
            connection, restored, [CsvFile(r, f"{r}.csv", value) for r, value in exported.items()]
        )
        assert preview["state"] == "preview", preview["errors"]
        result = confirm_import(
            connection, restored, preview["preview_id"], "restore", confirmed_by_user=True
        )
        restored = replace(restored, version=result["version"])
        assert export_csv12(connection, restored)["files"] == exported
        assert (
            query_ledger(connection, restored, Query())["summary"]["metrics"]["contribution_profit"]
            == "121.00"
        )


def test_batch_pagination_full_count_and_private_scope_after_reconnection(empty):
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        for _ in range(23):
            preview_import(
                connection, scope, [CsvFile("products", "空.csv", standard_csv("products", []))]
            )
    with psycopg.connect(app_url, autocommit=True) as connection:
        first = list_batches(connection, scope)
        second = list_batches(connection, scope, page=2)
        assert first["total"] == second["total"] == 23
        assert len(first["rows"]) == 20 and len(second["rows"]) == 3
        assert len({row["batch_id"] for row in first["rows"] + second["rows"]}) == 23
        assert list_batches(connection, scope, page=3)["rows"] == []
        assert count_sources(empty) == (0, 0, 1)
        with pytest.raises(ScopeError):
            list_batches(connection, replace(scope, workspace_id="unrelated"))


@pytest.mark.parametrize(
    "problem", ["reference", "late_refund", "refund_overpaid", "shipped_cancel", "expense_scope"]
)
def test_relational_errors_reject_entire_preview_without_partial_facts(empty, problem):
    records = manual_records()
    if problem == "reference":
        records["skus"][0]["product_id"] = "not-found"
    elif problem == "late_refund":
        records["refunds"][0]["occurred_at"] = "2026-06-01T00:00:00Z"
    elif problem == "refund_overpaid":
        records["refunds"][0]["amount"] = "30"
    elif problem == "shipped_cancel":
        records["orders"][1]["fulfillment_status"] = "shipped"
    else:
        records["expenses"][0]["store_id"] = "002"
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files(records))
        assert preview["state"] == "rejected" and preview["preview_id"] is None
        assert preview["error_count"] > 0
        assert count_sources(empty) == (0, 0, 1)
        assert "错误说明" in download_errors(connection, scope, preview["batch_id"]).decode(
            "utf-8-sig"
        )
    # A fresh connection sees persisted batch evidence, not only process-local state.
    with psycopg.connect(app_url, autocommit=True) as connection:
        assert list_batches(connection, scope)["rows"][0]["state"] == "rejected"


def test_accounting_failure_rolls_back_last_stage_and_can_retry_same_key(empty, monkeypatch):
    from shopgate_commerce_data.ledger import exchange

    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files())
        original = exchange.rebuild_import

        def fail_after_snapshots(*args):
            original(*args)
            raise RuntimeError("test only: late-stage failure")

        monkeypatch.setattr(exchange, "rebuild_import", fail_after_snapshots)
        with pytest.raises(RuntimeError, match="late-stage"):
            confirm_import(
                connection, scope, preview["preview_id"], "rollback", confirmed_by_user=True
            )
        assert count_sources(empty) == (0, 0, 1)
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.operations").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM bi.audit_events").fetchone()[0] == 0
            assert (
                connection.execute("SELECT state FROM bi.import_batches").fetchone()[0] == "preview"
            )
            assert (
                connection.execute("SELECT consumed_at FROM bi.operation_previews").fetchone()[0]
                is None
            )
        monkeypatch.setattr(exchange, "rebuild_import", original)
        assert (
            confirm_import(
                connection, scope, preview["preview_id"], "rollback", confirmed_by_user=True
            )["version"]
            == 2
        )


def test_conflicting_existing_facts_not_overwritten_and_different_request_key_rejected(empty):
    current, original, _ = commit(empty)
    records = manual_records()
    records["products"][0]["name"] = "试图覆盖"
    with psycopg.connect(empty[1], autocommit=True) as connection:
        rejected = preview_import(connection, current, files(records))
        assert rejected["state"] == "rejected"
        second = preview_import(connection, current, files())
        with pytest.raises(OperationConflict, match="不同操作"):
            confirm_import(
                connection, current, second["preview_id"], "import", confirmed_by_user=True
            )
        assert original["preview_id"] != second["preview_id"]
        assert count_sources(empty) == (4, 2, 2)


def test_import_requires_manage_human_same_actor_and_current_version(empty):
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        viewer = replace(scope, capabilities=frozenset({"ledger.read"}))
        with pytest.raises(ScopeError):
            preview_import(connection, viewer, files())
        preview = preview_import(connection, scope, files())
        with pytest.raises(ScopeError, match="确认"):
            confirm_import(
                connection, scope, preview["preview_id"], "no-human", confirmed_by_user=False
            )
        with pytest.raises(ScopeError):
            confirm_import(
                connection,
                replace(scope, actor_id="other"),
                preview["preview_id"],
                "other-actor",
                confirmed_by_user=True,
            )
        with pytest.raises(OperationConflict):
            confirm_import(
                connection,
                replace(scope, version=2),
                preview["preview_id"],
                "future",
                confirmed_by_user=True,
            )
        with pytest.raises(ScopeError):
            download_errors(connection, replace(scope, actor_id="other"), preview["batch_id"])
        assert count_sources(empty) == (0, 0, 1)


def test_expired_preview_and_tampered_batch_digest_cannot_commit(empty):
    scope, app_url, admin_url = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files())
        second = preview_import(connection, scope, files())
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(
                "UPDATE bi.operation_previews SET expires_at=clock_timestamp()-interval '1 second' "
                "WHERE preview_id=%s",
                (preview["preview_id"],),
            )
            admin.execute(
                "UPDATE bi.import_batches SET content_hash=%s WHERE batch_id=%s",
                ("a" * 64, second["batch_id"]),
            )
            with pytest.raises(psycopg.errors.CheckViolation):
                admin.execute(
                    "UPDATE bi.import_rows SET record='{}' WHERE batch_id=%s", (second["batch_id"],)
                )
        with pytest.raises(OperationConflict, match="过期"):
            confirm_import(
                connection, scope, preview["preview_id"], "expired", confirmed_by_user=True
            )
        with pytest.raises(OperationConflict, match="校验"):
            confirm_import(
                connection, scope, second["preview_id"], "tampered", confirmed_by_user=True
            )
        assert count_sources(empty) == (0, 0, 1)


def test_parallel_same_key_commits_exactly_once(empty):
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files())

    def submit(_):
        with psycopg.connect(app_url, autocommit=True) as connection:
            return confirm_import(
                connection, scope, preview["preview_id"], "parallel", confirmed_by_user=True
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = list(pool.map(submit, range(2)))
    assert a == b and a["version"] == 2
    assert count_sources(empty) == (4, 2, 2)


def test_parallel_different_previews_reject_stale_second_transaction(empty):
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        previews = [preview_import(connection, scope, files()) for _ in range(2)]

    def submit(index):
        with psycopg.connect(app_url, autocommit=True) as connection:
            try:
                return confirm_import(
                    connection,
                    scope,
                    previews[index]["preview_id"],
                    f"parallel-{index}",
                    confirmed_by_user=True,
                )["version"]
            except OperationConflict:
                return "stale"

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(submit, range(2)), key=str) == [2, "stale"]
    assert count_sources(empty) == (4, 2, 2)


def test_cross_dataset_export_and_batch_error_cannot_leak(empty):
    current, preview, _ = commit(empty)
    with psycopg.connect(empty[2], autocommit=True) as admin:
        admin.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,'other','其他导入','import')",
            (current.workspace_id,),
        )
    other = replace(current, dataset_id="other", version=1)
    with psycopg.connect(empty[1], autocommit=True) as connection:
        exported = export_csv12(connection, other)
        assert all(
            len(content.decode("utf-8-sig").splitlines()) == 1
            for content in exported["files"].values()
        )
        assert list_batches(connection, other)["total"] == 0
        with pytest.raises(ScopeError):
            download_errors(connection, other, preview["batch_id"])
        with pytest.raises(ScopeError):
            confirm_import(
                connection, other, preview["preview_id"], "cross", confirmed_by_user=True
            )


def test_new_metadata_only_import_has_current_accounting_watermark_and_full_export(empty):
    current, _, _ = commit(empty)
    new = {
        "products": [
            {"product_id": f"extra-{i:03}", "name": f"商品{i}", "category": "", "series": ""}
            for i in range(25)
        ]
    }
    current, _, result = commit((current, empty[1], empty[2]), new, key="metadata")
    assert result["version"] == 3
    with psycopg.connect(empty[1], autocommit=True) as connection:
        assert (
            query_ledger(connection, current, Query())["summary"]["metrics"]["contribution_profit"]
            == "121.00"
        )
        csv = export_csv12(connection, current)["files"]["products"]
        assert (
            len(csv.decode("utf-8-sig").splitlines()) == 28
        )  # 27 facts + header, not page size20.


def test_missing_cost_fx_and_mapping_preserved_until_explicit_recalculation(empty):
    records = manual_records()
    records["costs"] = []
    records["fx_rates"] = []
    current, _, _ = commit(empty, records)
    with psycopg.connect(empty[1], autocommit=True) as connection:
        before = query_ledger(connection, current, Query())["summary"]["metrics"]
        assert before["sales_amount"] == "260.00"  # explicit order FX does not supply cost FX
        assert before["product_cost"] is None
    repairs = {"costs": manual_records()["costs"], "fx_rates": manual_records()["fx_rates"]}
    current, _, _ = commit((current, empty[1], empty[2]), repairs, key="repair-sources")
    with psycopg.connect(empty[1], autocommit=True) as connection:
        assert (
            query_ledger(connection, current, Query())["summary"]["metrics"]["product_cost"] is None
        )
        with connection.transaction():
            bind_scope(connection, current)
            assert connection.execute("SELECT count(*) FROM bi.line_snapshots").fetchone()[0] == 2


def test_no_mapping_is_unknown_not_zero_revenue_and_calculation_preview_error_is_persisted(empty):
    records = manual_records()
    records["mappings"][0].update(
        status="unmapped", mapping_id=None, sku_id=None, unit_multiplier=None, valid_from=None
    )
    current, _, _ = commit(empty, records)
    with psycopg.connect(empty[1], autocommit=True) as connection:
        metrics = query_ledger(connection, current, Query())["summary"]["metrics"]
        assert metrics["sales_amount"] == "260.00" and metrics["product_cost"] is None
    # Separate fresh dataset: multiplier product needs 8 decimals and cannot be silently rounded.
    with psycopg.connect(empty[2], autocommit=True) as admin:
        admin.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,'broken','坏换算','import')",
            (current.workspace_id,),
        )
    bad = manual_records()
    bad["mappings"][0]["unit_multiplier"] = "0.0001"
    bad["order_lines"][0]["quantity"] = "0.0001"
    bad["refunds"] = []
    with psycopg.connect(empty[1], autocommit=True) as connection:
        preview = preview_import(
            connection, replace(current, dataset_id="broken", version=1), files(bad)
        )
        assert preview["state"] == "rejected"
        assert any(error["resource"] == "accounting" for error in preview["errors"])


def test_bulk_import_keeps_same_and_cross_chunk_duplicates_idempotent(empty):
    products = [
        {
            "product_id": f"bulk-{index:04d}",
            "name": f"商品{index}",
            "category": "日用品",
            "series": "",
        }
        for index in range(601)
    ]
    entries = [products[0], *products, products[0]]
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        uploaded = [CsvFile("products", "商品.csv", standard_csv("products", entries))]
        preview = preview_import(connection, scope, uploaded)
        assert preview["state"] == "preview", preview["errors"]
        assert preview["summary"]["products"] == {"inserted": 601, "duplicates": 2}
        result = confirm_import(
            connection, scope, preview["preview_id"], "bulk", confirmed_by_user=True
        )
        scope = replace(scope, version=result["version"])
        repeat = preview_import(connection, scope, uploaded)
        assert repeat["summary"]["products"] == {"inserted": 0, "duplicates": 603}
        assert (
            confirm_import(
                connection, scope, repeat["preview_id"], "repeat-bulk", confirmed_by_user=True
            )["version"]
            == 2
        )
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.products").fetchone()[0] == 601


def test_bulk_failure_restores_chunks_and_exact_rows_before_whole_batch_rollback(empty):
    records = {name: [] for name in SPECS}
    records["products"] = [
        {"product_id": f"bulk-{index:04d}", "name": f"商品{index}", "category": "", "series": ""}
        for index in range(601)
    ]
    records["skus"] = [
        {
            "sku_id": f"sku-{index:04d}",
            "product_id": row["product_id"],
            "name": "规格",
            "unit": "件",
        }
        for index, row in enumerate(records["products"])
    ]
    for index in (240, 540):
        records["skus"][index]["product_id"] = "private-missing-parent"
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, files(records))
        assert preview["state"] == "rejected" and preview["preview_id"] is None
        assert [(error["resource"], error["row"]) for error in preview["errors"]] == [
            ("skus", 242),
            ("skus", 542),
        ]
        assert "private-missing-parent" not in str(preview["errors"])
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.products").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM bi.skus").fetchone()[0] == 0
        for index in (240, 540):
            records["skus"][index]["product_id"] = records["products"][index]["product_id"]
        repaired = preview_import(connection, scope, files(records))
        assert repaired["state"] == "preview", repaired["errors"]
        assert repaired["summary"]["skus"] == {"inserted": 601, "duplicates": 0}
        assert (
            confirm_import(
                connection, scope, repaired["preview_id"], "repaired-bulk", confirmed_by_user=True
            )["version"]
            == 2
        )


@pytest.mark.parametrize("offset", [10, 501])
def test_bulk_conflict_same_or_cross_chunk_never_overwrites_identity(empty, offset):
    entries = [
        {"product_id": f"bulk-{index:04d}", "name": f"商品{index}", "category": "", "series": ""}
        for index in range(offset)
    ]
    entries.append({**entries[0], "name": "冲突名称"})
    scope, app_url, _ = empty
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(
            connection, scope, [CsvFile("products", "商品.csv", standard_csv("products", entries))]
        )
        assert preview["state"] == "rejected"
        assert preview["error_count"] == 1 and preview["errors"][0]["row"] == offset + 2
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.products").fetchone()[0] == 0


def test_full_1000_spec_180_day_demo_imports_and_queries_on_real_pg_without_replacing_official(
    empty,
):
    from shopgate_commerce_data.ledger.demo import DemoPlan, demo_files, generate_demo

    original, app_url, admin_url = empty
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(
            "INSERT INTO bi.datasets(workspace_id,dataset_id,name,source_kind) "
            "VALUES (%s,'demo-ledger','独立演示经营集','demo')",
            (original.workspace_id,),
        )
    scope = replace(original, dataset_id="demo-ledger")
    generated = generate_demo(DemoPlan(start_date="2026-01-01"))
    with psycopg.connect(app_url, autocommit=True) as connection:
        preview = preview_import(connection, scope, demo_files(generated))
        assert preview["state"] == "preview", preview["errors"]
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 0
        result = confirm_import(
            connection, scope, preview["preview_id"], "demo-confirm", confirmed_by_user=True
        )
        assert result["version"] == 2
        scope = replace(scope, version=2)
        full_period = Query(
            start=generated["manifest"]["start_date"], end=generated["manifest"]["end_date"]
        )
        metrics = query_ledger(connection, scope, full_period)["summary"]["metrics"]
        # 12000 ordinals minus multiples of29 or47 (including0), overlap counted once.
        assert metrics["order_count"] == 11339
        assert metrics["product_cost"] is None  # deliberately missing facts are not invented zeros
        assert (
            metrics["accounted_revenue"] is not None and Decimal(metrics["accounted_revenue"]) > 0
        )
        recent = query_ledger(connection, scope, Query())
        assert recent["range"]["end"] == generated["manifest"]["end_date"]
        assert recent["range"]["start"] == "2026-05-31"
        assert 0 < recent["summary"]["metrics"]["order_count"] < 11339
        with connection.transaction():
            bind_scope(connection, scope)
            assert connection.execute("SELECT count(*) FROM bi.skus").fetchone()[0] == 1000
            assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 12000
            assert connection.execute("SELECT source_kind FROM bi.datasets").fetchone()[0] == "demo"
        with connection.transaction():
            bind_scope(connection, original)
            assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 0
            assert connection.execute("SELECT source_kind,version FROM bi.datasets").fetchone() == (
                "import",
                1,
            )
