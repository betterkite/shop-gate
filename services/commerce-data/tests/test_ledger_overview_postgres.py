"""Actual authorized PG18 snapshot, manual121, all-page and concurrent import tests."""

import os
from dataclasses import replace
from decimal import Decimal
from uuid import uuid4

import psycopg
import pytest
from test_ledger_exchange_postgres import commit, manual_records

from shopgate_commerce_data.ledger import query as query_module
from shopgate_commerce_data.ledger.cost_changes import CostChange, confirm_costs, preview_costs
from shopgate_commerce_data.ledger.cost_directory import CostDirectoryRequest, cost_directory
from shopgate_commerce_data.ledger.cost_simulation import simulate_cost
from shopgate_commerce_data.ledger.datasets import DatasetPlan, create_dataset
from shopgate_commerce_data.ledger.evidence import (
    EvidenceRequest,
    SourceRequest,
    quality_evidence,
    source_records,
)
from shopgate_commerce_data.ledger.exchange import export_csv12
from shopgate_commerce_data.ledger.mapping_changes import (
    MappingChange,
    confirm_mapping,
    preview_mapping,
)
from shopgate_commerce_data.ledger.migrations import migrate_all
from shopgate_commerce_data.ledger.operations import OperationConflict, create_preview
from shopgate_commerce_data.ledger.overview import OverviewRequest, overview
from shopgate_commerce_data.ledger.query import Query, ledger_read_snapshot, query_ledger
from shopgate_commerce_data.ledger.recalculation import confirm_recalculation, preview_recalculation
from shopgate_commerce_data.ledger.references import ReferenceRequest, reference_names, references
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


def test_directory_includes_all_idle_products_skus_and_stores_and_literal_search(context):
    records = manual_records()
    for i in range(23):
        key = f"idle-{i:03}"
        records["products"].append({
            "product_id": key, "name": "100%纯棉" if i == 22 else "无交易商品",
            "category": "" if i == 0 else "家居", "series": "基础款",
        })
        records["skus"].append({"sku_id": key, "product_id": key, "name": "规格", "unit": "件"})
        records["stores"].append({**records["stores"][0], "store_id": key, "name": "未开单店铺"})
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        for kind in ("product", "sku", "store"):
            pages = [references(connection, scope, ReferenceRequest(kind=kind, page=n))
                     for n in (1, 2)]
            assert [len(page["rows"]) for page in pages] == [20, 5]
            assert all(page["total"] == 25 for page in pages)
            assert len({row["key"] for page in pages for row in page["rows"]}) == 25
            assert all(page["version"] == page["accounting_revision"] == 2 for page in pages)
        literal = references(connection, scope, ReferenceRequest(search="%"))
        assert [row["key"] for row in literal["rows"]] == ["idle-022"]
        categories = references(connection, scope, ReferenceRequest(kind="category"))
        assert {row["key"] for row in categories["rows"]} == {"", "家居", "日用品"}
        empty_category = references(connection, scope, ReferenceRequest(category=""))
        assert [row["key"] for row in empty_category["rows"]] == ["idle-000"]
        assert references(connection, scope, ReferenceRequest(page=3))["rows"] == []
        idle = overview(connection, scope, OverviewRequest(query=Query(product_ids=("idle-000",))))
        assert idle["scope_names"] == [{"kind": "product", "key": "idle-000", "name": "无交易商品"}]
        assert all(row["state"] == "no_records" for row in idle["trend"]["rows"])
        unchanged = query_ledger(connection, scope, Query())
        assert unchanged["summary"]["metrics"]["accounted_contribution"] == "121.00"


def test_exact_quality_evidence_deduplicates_lines_and_paginates_every_refund(context):
    records = manual_records()
    records["costs"] = []
    records["fx_rates"] = []
    records["orders"][0]["fx_rate"] = None
    records["orders"][0]["fx_source"] = None
    records["mappings"][0]["name"] = "100%棉服"
    for i in range(23):
        records["order_lines"].append({
            **records["order_lines"][0], "line_id": f"extra-{i:03}",
        })
    for i in range(25):
        records["refunds"].append({
            **records["refunds"][0], "refund_id": f"refund-{i:03}", "amount": "0.10",
        })
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        current = overview(connection, scope, OverviewRequest())
        pages = [quality_evidence(connection, scope, EvidenceRequest(page=page))
                 for page in (1, 2)]
        assert [len(page["rows"]) for page in pages] == [20, 5]
        assert all(page["total"] == page["scope_total"] == 25 for page in pages)
        assert len({row["key"] for page in pages for row in page["rows"]}) == 25
        assert current["summary"]["quality"]["unknown_cost_lines"] == 25
        # No cost version means its currency is unknown. A missing payment FX
        # rate must not invent a second, cost-currency explanation.
        assert all(row["reasons"] == ["缺少付款时适用的商品成本。"]
                   for page in pages for row in page["rows"])
        literal = quality_evidence(connection, scope, EvidenceRequest(search="%"))
        assert literal["total"] == 24 and literal["scope_total"] == 25
        refund_request = EvidenceRequest(quality_key="unknown_refund_lines", record_key="line-o1")
        first = quality_evidence(connection, scope, refund_request)
        second = quality_evidence(connection, scope, replace(refund_request, event_page=2))
        assert first["scope_total"] == current["summary"]["quality"]["unknown_refund_lines"] == 1
        assert first["rows"][0]["event_count"] == 27
        assert first["events"]["total"] == second["events"]["total"] == 27
        assert [len(first["events"]["rows"]), len(second["events"]["rows"])] == [20, 7]
        details = first["events"]["rows"] + second["events"]["rows"]
        assert {row["refund_id"] for row in details} == {"r1", "r2"} | {
            f"refund-{i:03}" for i in range(25)
        }
        assert all(row["currency"] == "USD" and row["amount_cny"] is None for row in details)
        assert all(row["paid_at"].startswith("2026-07-01") for row in details)
        assert all(row["occurred_at"].startswith("2026-07-02") for row in details)
        assert all("汇率" in row["reason"] for row in details)
        for selected, expected in (
            (Query(start="2026-07-02", end="2026-07-02"), 0),
            (Query(start="2026-07-02", end="2026-07-02", refund_basis="occurred"), 1),
            (Query(store_ids=("002",)), 0),
        ):
            narrowed = quality_evidence(connection, scope, replace(refund_request, query=selected))
            assert narrowed["scope_total"] == expected
            if not expected:
                assert narrowed["events"]["total"] == 0
        empty_search = quality_evidence(
            connection, scope, replace(refund_request, search="foreign")
        )
        assert empty_search["scope_total"] == 1 and empty_search["events"]["rows"] == []
        with pytest.raises(OperationConflict):
            quality_evidence(connection, replace(scope, version=1), refund_request)
        for denied in (replace(scope, workspace_id="foreign"), replace(scope, dataset_id="foreign"),
                       replace(scope, capabilities=frozenset())):
            with pytest.raises(ScopeError):
                quality_evidence(connection, denied, refund_request)


def test_expense_evidence_never_assigns_full_source_amount_to_selected_product(context):
    records = manual_records()
    records["expenses"][1]["currency"] = "EUR"  # No known conversion rate.
    for product in records["products"]:
        product["category"] = ""
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = quality_evidence(connection, scope, EvidenceRequest(
            quality_key="unknown_expenses", record_key="e2"
        ))
        assert result["scope_total"] == 1
        event = result["events"]["rows"][0]
        assert event["original_amount"] == "6.00" and event["currency"] == "EUR"
        assert event["source_amount_cny"] is None and event["amount_cny"] is None
        for selected in (Query(product_ids=("p001",)), Query(category="")):
            current = overview(connection, scope, OverviewRequest(query=selected))
            evidence = quality_evidence(connection, scope, EvidenceRequest(
                quality_key="unknown_attribution_expenses", query=selected, record_key="e2"
            ))
            assert evidence["scope_total"] == current["summary"]["quality"][
                "unknown_attribution_expenses"
            ] == 1
            assert all(row["amount_cny"] is None for row in evidence["events"]["rows"])
            assert all("不等于" in row["reason"] for row in evidence["events"]["rows"])
        # Read-only evidence did not manufacture a conversion rate or change the version.
        unchanged = query_ledger(connection, scope, Query())
        assert unchanged["version"] == 2
        assert unchanged["summary"]["metrics"]["net_sales"] == "164.00"


def test_directory_parent_restrictions_names_permissions_and_stale_scope(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        stores = references(connection, scope, ReferenceRequest(kind="store", channel_id="pdd"))
        assert {row["key"] for row in stores["rows"]} == {"001", "002"}
        assert {row["channel_name"] for row in stores["rows"]} == {"拼多多"}
        listings = references(connection, scope, ReferenceRequest(kind="listing", store_id="002"))
        assert [row["key"] for row in listings["rows"]] == ["l002"]
        assert references(connection, scope, ReferenceRequest(
            kind="listing", store_id="002", channel_id="foreign"
        ))["total"] == 0
        skus = references(connection, scope, ReferenceRequest(kind="sku", product_id="p001"))
        assert [row["key"] for row in skus["rows"]] == ["001"]
        with ledger_read_snapshot(connection, scope) as snapshot:
            names = reference_names(snapshot, Query(store_ids=("001", "missing")))
            assert names == [{"kind": "store", "key": "001", "name": "店铺001"},
                             {"kind": "store", "key": "missing", "name": None}]
        with pytest.raises(ValueError, match="快照已结束"):
            reference_names(snapshot, Query(store_ids=("001",)))
        with pytest.raises(OperationConflict):
            references(connection, replace(scope, version=1), ReferenceRequest())
        for denied in (replace(scope, workspace_id="foreign"), replace(scope, dataset_id="foreign"),
                       replace(scope, capabilities=frozenset())):
            with pytest.raises(ScopeError):
                references(connection, denied, ReferenceRequest())


def test_uncategorized_filter_keeps_unknown_expense_attribution(context):
    records = manual_records()
    for product in records["products"]:
        product["category"] = ""
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = overview(connection, scope, OverviewRequest(query=Query(category="")))
        assert result["scope_names"] == [{"kind": "category", "key": "", "name": "未分类"}]
        assert result["summary"]["quality"]["unknown_attribution_expenses"] > 0
        assert result["summary"]["metrics"]["contribution_profit"] is None


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
    # A channel-wide expense without a store must not overwrite the actual platform name.
    assert result["channels"]["rows"][0]["name"] == "拼多多"
    assert result["channels"]["rows"][0]["shares"]["net_sales"] == "1.00000000"
    assert result["channels"]["share_states"]["net_sales"] == "comparable"
    assert result["trend"]["rows"][0]["metrics"]["accounted_contribution"] == "121.00"
    assert result["trend"]["rows"][1]["metrics"] is None
    assert result["trend"]["rows"][1]["state"] == "no_records"
    assert result["targets"]["rows"][0]["net_sales"] == "104.00"
    assert result["targets"]["rows"][0]["completion_ratio"] == "0.10400000"
    # Same 61-day example as the Agent's controlled "previous" query. A
    # calendar-month subtraction would silently compare unequal periods.
    with psycopg.connect(context[1], autocommit=True) as connection:
        extended = overview(
            connection, scope, OverviewRequest(query=Query(start="2026-05-03", end="2026-07-02"))
        )
    assert extended["previous"]["range"]["start"] == "2026-03-03"
    assert extended["previous"]["range"]["end"] == "2026-05-02"


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

    def counted(connection, selected_scope):
        assert selected_scope == scope
        calls.append(True)
        return original(connection, selected_scope)

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


def test_channel_periods_use_the_same_ledger_for_each_platform_and_page(context):
    records = manual_records()
    records["channels"].append({"channel_id": "second", "name": "第二平台", "color": "#394862"})
    records["stores"][1]["channel_id"] = "second"
    scope, _, _ = commit(context, records)
    window = Query(start="2026-06-12", end="2026-07-02", refund_basis="occurred")
    with psycopg.connect(context[1], autocommit=True) as conn:
        ordinary = overview(conn, scope, OverviewRequest(query=window))
        assert "channel_trends" not in ordinary
        for page in (1, 2):
            data = overview(conn, scope, OverviewRequest(query=window, channel_period_page=page))
            chart = data["channel_trends"]
            assert chart["period_page"] == page and chart["period_total"] == 21
            assert len(chart["periods"]) == (20 if page == 1 else 1)
            assert {c["key"] for c in chart["channels"]} == {"pdd", "second"}
            for group in chart["channels"]:
                assert len(group["points"]) == len(chart["periods"])
                for period, point in zip(chart["periods"], group["points"], strict=True):
                    if period["end"] < "2026-07-01":
                        assert point is None
                        continue
                    query = replace(
                        window, start=period["start"], end=period["end"],
                        channel_ids=(group["key"],), dimension="channel",
                    )
                    independent = query_ledger(conn, scope, query)["rows"]
                    if not independent:
                        assert point is None
                        continue
                    assert point == {k: independent[0]["metrics"][k] for k in (
                        "net_sales", "contribution_profit", "contribution_margin", "refund_ratio",
                    )}
                    assert point["refund_ratio"] is None

        week = overview(conn, scope, OverviewRequest(
            query=Query(start="2026-07-01", end="2026-07-02", store_ids=("001",)),
            interval="week", channel_period_page=1,
        ))["channel_trends"]
        assert week["periods"] == [
            {"key": "2026-06-29", "start": "2026-07-01", "end": "2026-07-02"}
        ]
        assert [c["key"] for c in week["channels"]] == ["pdd"]
        assert week["channels"][0]["points"][0]["net_sales"] == "104.00"


def test_search_resolves_visible_platform_store_and_transaction_identifiers(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as conn:
        window = Query(start="2026-07-01", end="2026-07-02")
        all_metrics = query_ledger(conn, scope, window)["summary"]["metrics"]
        for term in ("拼多多", "PDD"):
            result = query_ledger(conn, scope, replace(window, search=term))
            assert result["summary"]["metrics"] == all_metrics
            assert result["summary"]["metrics"]["net_sales"] == "164.00"
        store = query_ledger(conn, scope, replace(window, store_ids=("001",)))
        named = query_ledger(conn, scope, replace(window, search="店铺001"))
        assert named["summary"]["metrics"] == store["summary"]["metrics"]
        for dimension in ("product", "sku", "listing"):
            by_platform = query_ledger(conn, scope, replace(window, dimension=dimension))
            searched = query_ledger(conn, scope, replace(window, dimension=dimension, search="pdd"))
            assert searched["summary"] == by_platform["summary"]
            assert searched["rows"] == by_platform["rows"]
        for term in ("r1", "000原单o1"):
            records = query_ledger(conn, scope, replace(window, dimension="order", search=term))
            assert [row["key"] for row in records["rows"]] == ["o1"]
        empty = query_ledger(conn, scope, replace(window, search="尚未登记的门店名"))
        assert empty["total"] == 0


def test_platform_fee_categories_reconcile_with_negative_adjustments_and_unknown_fx(context):
    records = manual_records()
    original = records["expenses"][0]
    records["expenses"].extend([
        {**original, "expense_id": "credit", "expense_type": "platform", "amount": "-2.50"},
        {**original, "expense_id": "unknown-ad", "expense_type": "advertising",
         "amount": "7.00", "currency": "EUR", "fx_rate": None, "fx_source": None},
    ])
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        query = Query(dimension="channel", start="2026-07-01", end="2026-07-02")
        row = query_ledger(conn, scope, query)["rows"][0]
        assert row["expense_breakdown"]["logistics"] == {"amount": "10.00", "known_amount": "10.00"}
        assert row["expense_breakdown"]["platform"] == {"amount": "-2.50", "known_amount": "-2.50"}
        assert row["expense_breakdown"]["advertising"] == {"amount": None, "known_amount": "0.00"}
        assert row["metrics"]["expense_amount"] is None


def test_full_postings_pagination_original_orders_and_date_basis(context):
    records = manual_records()
    for i in range(21):
        records["refunds"].append({
            **records["refunds"][0], "refund_id": f"extra-{i:02}", "amount": "0.10",
        })
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        july2 = Query(start="2026-07-02", end="2026-07-02", refund_basis="occurred")
        request = SourceRequest("refund", query=july2, order_id="o1")
        first = source_records(conn, scope, request)
        last = source_records(conn, scope, replace(request, page=2))
        complete = first["rows"] + last["rows"]
        assert [len(first["rows"]), len(last["rows"])] == [20, 3]
        assert first["total"] == len({e["key"] for e in complete}) == 23
        r1 = next(e for e in complete if e["refund_id"] == "r1")
        assert (r1["date"], r1["order_id"], r1["platform_order_id"]) == (
            "2026-07-02", "o1", "000原单o1",
        )
        assert (r1["original_amount"], r1["line_paid_amount"], r1["currency"]) == (
            "2.00", "20.00", "USD",
        )
        assert (r1["amount_cny"], r1["cost_cny"]) == ("16.00", "0.00")
        for other in (replace(july2, refund_basis="payment"), replace(july2, store_ids=("002",))):
            assert source_records(conn, scope, replace(request, query=other))["total"] == 0
        ordered = source_records(conn, scope, SourceRequest("sale", order_id="o1"))
        assert [row["source_id"] for row in ordered["rows"]] == ["line-o1"]
        for denied in (replace(scope, workspace_id="foreign"), replace(scope, dataset_id="foreign"),
                       replace(scope, capabilities=frozenset())):
            with pytest.raises(ScopeError):
                source_records(conn, denied, request)
        with pytest.raises(OperationConflict):
            source_records(conn, replace(scope, version=1), request)


def test_fee_source_drill_preserves_scope_amounts_and_unallocated_order_attribution(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as conn:
        request = SourceRequest("expense", query=Query(channel_ids=("pdd",)))
        fees = source_records(conn, scope, request)
        assert [(r["source_id"], r["amount_cny"]) for r in fees["rows"]] == [
            ("e1", "4.00"), ("e2", "6.00"),
        ]
        order = source_records(conn, scope, replace(request, order_id="o1"))
        e2 = next(r for r in order["rows"] if r["source_id"] == "e2")
        assert e2["amount_cny"] is None and e2["source_amount_cny"] == "6.00"
        assert e2["expense_type"] == "logistics" and e2["allocation_method"] == "unallocated"
        assert source_records(conn, scope, replace(request, search="不存在"))["rows"] == []


def test_paid_coverage_and_weighted_unit_measures_ignore_refund_cost_reversals(context):
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as conn:
        data = query_ledger(conn, scope, Query(dimension="sku"))
        first = next(r["metrics"] for r in data["rows"] if r["key"] == "001")
        assert first["standard_quantity"] == first["costed_quantity"] == "4.0000"
        assert (first["average_unit_price"], first["weighted_unit_cost"]) == ("40.0000", "14.0000")
        totals = data["summary"]["metrics"]
        assert (totals["selling_channels"], totals["selling_stores"]) == (1, 2)
        assert totals["average_unit_price"] == "52.0000"
        assert totals["weighted_unit_cost"] == "13.2000" and totals["costed_quantity"] == "5.0000"
        only_refunds = query_ledger(conn, scope, Query(
            start="2026-07-02", end="2026-07-02", refund_basis="occurred",
        ))["summary"]["metrics"]
        assert only_refunds["refund_amount"] == "96.00" and only_refunds["selling_stores"] == 0
        assert only_refunds["average_unit_price"] is None
        assert only_refunds["weighted_unit_cost"] is None


def test_unit_measures_disclose_partial_historical_costs_and_incompatible_units(context):
    records = manual_records()
    records["costs"] = records["costs"][:1]
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        totals = query_ledger(conn, scope, Query())["summary"]["metrics"]
        assert totals["product_cost"] is None
        assert totals["weighted_unit_cost"] == "14.0000"
        assert totals["costed_quantity"] == "4.0000" and totals["standard_quantity"] == "5.0000"


def test_different_standard_units_do_not_produce_a_blended_price(context):
    records = manual_records()
    records["skus"][1]["unit"] = "公斤"
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        data = query_ledger(conn, scope, Query(dimension="sku"))
        mixed = data["summary"]["metrics"]
        measures = (
            "standard_quantity", "average_unit_price", "weighted_unit_cost", "costed_quantity",
        )
        for key in measures:
            assert mixed[key] is None
        assert {r["metrics"]["weighted_unit_cost"] for r in data["rows"]
                if r["key"] != "__unattributed__"} == {"14.0000", "10.0000"}


def test_product_performance_filter_is_calculated_before_paging_and_keeps_judgment_period(context):
    records = manual_records()
    records["expenses"] = [{**records["expenses"][0], "amount": "90.00"}]
    for i in range(2):
        order = records["orders"][i]
        later = f"later-{i}"
        records["orders"].append({
            **order, "order_id": later, "platform_order_id": f"原单{later}",
            "paid_at": "2026-07-03T00:00:00Z",
        })
        records["order_lines"].append({
            **records["order_lines"][i], "line_id": f"line-{later}", "order_id": later,
        })
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        selected = Query(
            dimension="sku", start="2026-07-01", end="2026-07-01", condition_grain="sku",
            condition_start="2026-07-01", condition_end="2026-07-01", group_condition="negative",
            page_size=1,
        )
        for rule in ("negative", "low_margin"):
            page = query_ledger(conn, scope, replace(selected, group_condition=rule))
            assert page["total"] == 1 and page["rows"][0]["key"] == "001"
            assert page["summary"]["metrics"]["net_sales"] == "104.00"
        assert query_ledger(conn, scope, replace(selected, page=2))["rows"] == []
        # Follow-up questions and related store/order pages retain the initially classified SKUs.
        later = replace(selected, dimension="order", start="2026-07-03", end="2026-07-03")
        result = query_ledger(conn, scope, later)
        assert [r["key"] for r in result["rows"]] == ["later-0"]
        assert result["summary"]["metrics"]["net_sales"] == "160.00"
        assert query_ledger(conn, scope, replace(
            later, condition_start="2026-07-03", condition_end="2026-07-03",
        ))["total"] == 0
        assert query_ledger(conn, scope, replace(later, store_ids=("002",)))["total"] == 0
        refunds = replace(selected, group_condition="high_refund")
        assert query_ledger(conn, scope, refunds)["total"] == 2
        assert query_ledger(conn, scope, replace(refunds, refund_basis="occurred"))["total"] == 0
        with pytest.raises(ValueError):
            query_ledger(conn, scope, replace(selected, condition_end=None))


def test_incomplete_product_filter_uses_ledger_quality_even_if_revenue_is_known(context):
    records = manual_records()
    records["costs"] = records["costs"][1:]
    records["expenses"] = records["expenses"][:1]
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        selected = Query(dimension="sku", group_condition="incomplete", condition_grain="product",
                         condition_start="2026-07-01", condition_end="2026-07-02")
        data = query_ledger(conn, scope, selected)
        assert [r["key"] for r in data["rows"]] == ["001"]
        assert data["summary"]["metrics"]["product_cost"] is None
        assert data["summary"]["quality"]["unknown_cost_lines"] == 1



def test_product_missing_reasons_match_original_snapshots_and_source_orders(context):
    records = manual_records()
    records["costs"][0].update(valid_from="2026-07-03T00:00:00Z", currency="CNY")
    records["orders"].append({
        **records["orders"][0], "order_id": "later", "platform_order_id": "later001",
        "paid_at": "2026-07-03T01:00:00Z",
    })
    records["order_lines"].append({
        **records["order_lines"][0], "line_id": "line-later", "order_id": "later",
    })
    records["costs"][1]["currency"] = "EUR"  # l002 has a cost but no rate for its currency.
    records["order_lines"].append({
        **records["order_lines"][0], "line_id": "line-unmapped", "listing_id": "unknown",
    })
    scope, _, _ = commit(context, records)
    base = Query(dimension="listing", condition_grain="listing",
                 start="2026-07-01", end="2026-07-02",
                 condition_start="2026-07-01", condition_end="2026-07-02")
    with psycopg.connect(context[1], autocommit=True) as conn:
        for rule, listing, line in (
            ("missing_cost", "l001", "line-o1"), ("missing_mapping", "unknown", "line-unmapped"),
        ):
            query = replace(base, group_condition=rule)
            table = query_ledger(conn, scope, query)
            assert [r["key"] for r in table["rows"]] == [listing]
            assert table["summary"]["metrics"]["order_count"] == 1
            payments = source_records(conn, scope, SourceRequest("sale", query))
            assert payments["total"] == 1
            payment = payments["rows"][0]
            assert (payment["line_id"], payment["payment_missing"]) == (line, [rule])
            assert payment["order_id"] == "o1"
            assert query_ledger(conn, scope, replace(query, store_ids=("002",)))["total"] == 0
        refunds = source_records(conn, scope, SourceRequest(
            "refund", replace(base, group_condition="missing_cost")))
        assert refunds["total"] == 2
        assert all(r["payment_missing"] == ["missing_cost"] for r in refunds["rows"])
        # The same listing has a known cost on its later payment.
        later = replace(base, group_condition="missing_cost", start="2026-07-03", end="2026-07-03")
        payments = source_records(conn, scope, SourceRequest("sale", later))
        assert payments["total"] == 1
        assert payments["rows"][0]["line_id"] == "line-later"
        assert payments["rows"][0]["payment_missing"] == []
        reclassified = replace(later, condition_start=later.start, condition_end=later.end)
        assert query_ledger(conn, scope, reclassified)["total"] == 0
        fx_only = source_records(conn, scope, SourceRequest("sale", Query(store_ids=("002",))))
        assert fx_only["rows"][0]["payment_missing"] == ["missing_fx"]
        with pytest.raises(ValueError, match="平台货号"):
            query_ledger(conn, scope, replace(
                base, group_condition="missing_mapping", condition_grain="sku",
            ))


def test_mapping_directory_date_boundary_no_sales_scope_and_full_paging(context):
    records = manual_records()
    # l001 is still effective at the very end of July 1 in Shanghai.
    records["mappings"][0]["valid_to"] = "2026-07-01T16:00:00Z"
    records["mappings"][1]["valid_from"] = "2026-07-01T16:00:00Z"
    for index in range(23):
        records["mappings"].append({
            "listing_id": f"quiet{index:02}", "store_id": "001",
            "platform_sku_id": f"00%{index:02}", "name": "未销售商品",
            "unit": "袋", "status": "unmapped", "platform_product_id": "",
        })
    scope, _, _ = commit(context, records)
    day = ReferenceRequest(kind="mapping", as_of="2026-07-01", sort="key")
    with psycopg.connect(context[1], autocommit=True) as connection:
        lookup = references(connection, scope, replace(day, search="000001"))
        assert lookup["total"] == 1
        row = lookup["rows"][0]
        assert (row["key"], row["sku_id"], row["mapping_status"]) == ("l001", "001", "mapped")
        assert (row["listing_unit"], row["unit"]) == ("包", "件")
        assert Decimal(row["multiplier"]) == 2
        assert references(connection, scope, replace(day, search="规格001"))["total"] == 1
        next_day = replace(day, as_of="2026-07-02")
        active = references(connection, scope, replace(next_day, mapping_status="mapped"))
        assert [r["key"] for r in active["rows"]] == ["l002"]
        gone = references(connection, scope, replace(next_day, listing_id="l001"))["rows"][0]
        assert gone["mapping_status"] == "missing" and gone["multiplier"] is None
        quiet = replace(day, search="%", mapping_status="missing", store_id="001")
        first = references(connection, scope, quiet)
        last = references(connection, scope, replace(quiet, page=2))
        assert first["as_of"] == "2026-07-01" and first["total"] == last["total"] == 23
        keys = [r["key"] for r in first["rows"] + last["rows"]]
        assert keys == [f"quiet{i:02}" for i in range(23)]
        different_store = replace(day, sku_id="001", store_id="002")
        assert references(connection, scope, different_store)["total"] == 0
        with pytest.raises(OperationConflict):
            references(connection, replace(scope, version=1), day)
        with pytest.raises(ScopeError):
            references(connection, replace(scope, workspace_id="elsewhere"), day)

def test_mapping_version_replacement_preserves_original_payments_until_confirmed_recalc(context):
    scope, _, _ = commit(context)
    change = MappingChange("l001", "002", "3", "2026-01-01T08:00:00+08:00")
    day = ReferenceRequest(kind="mapping", listing_id="l001", as_of="2026-07-01")
    with psycopg.connect(context[1], autocommit=True) as conn:
        def original_sku(current):
            return query_ledger(conn, current, Query(dimension="sku", listing_ids=("l001",)))[
                "rows"
            ][0]["key"]

        assert original_sku(scope) == "001"
        with pytest.raises(ValueError, match="操作标识"):
            confirm_mapping(conn, scope, None, "bad-type", confirmed_by_user=True)
        preview = preview_mapping(conn, scope, change)
        assert preview["impact"]["previous"]["multiplier"] == "2.0000"
        assert preview["impact"]["historical_paid_lines"] == 1
        assert references(conn, scope, day)["rows"][0]["sku_id"] == "001"
        with pytest.raises(ScopeError):
            confirm_mapping(conn, scope, preview["preview_id"], "mapping-review",
                            confirmed_by_user=False)
        result = confirm_mapping(conn, scope, preview["preview_id"], "mapping-review",
                                 confirmed_by_user=True)
        assert result["changed"] and result["version"] == 3
        assert confirm_mapping(conn, scope, preview["preview_id"], "mapping-review",
                               confirmed_by_user=True) == result
        with pytest.raises(OperationConflict):
            confirm_target(conn, scope, preview["preview_id"], "mapping-review",
                           confirmed_by_user=True)
        updated = replace(scope, version=3)
        assert original_sku(updated) == "001"
        after = references(conn, updated, day)["rows"][0]
        assert after["sku_id"] == "002" and Decimal(after["multiplier"]) == 3
        exports = export_csv12(conn, updated)["files"]["mappings"].decode("utf-8-sig")
        assert "m001" not in exports and result["data"]["mapping_id"] in exports
        again = preview_mapping(conn, updated, change)
        assert not again["impact"]["changed"]
        no_change = confirm_mapping(conn, updated, again["preview_id"], "same-mapping",
                                    confirmed_by_user=True)
        assert not no_change["changed"] and no_change["version"] == 3
        recalc = preview_recalculation(conn, updated, line_ids=["line-o1"])
        assert original_sku(updated) == "001"
        refreshed = confirm_recalculation(conn, updated, recalc, "explicit-mapping-recalc",
                                          confirmed_by_user=True)
        assert refreshed["version"] == 4
        assert original_sku(replace(scope, version=4)) == "002"


def test_mapping_interval_gap_prior_future_and_stale_preview(context):
    records = manual_records()
    records["mappings"][0]["valid_from"] = "2026-06-01T00:00:00Z"
    records["mappings"][0]["valid_to"] = "2026-08-01T00:00:00Z"
    scope, _, _ = commit(context, records)
    day = ReferenceRequest(kind="mapping", listing_id="l001", as_of="2026-05-01")
    with psycopg.connect(context[1], autocommit=True) as conn:
        change = MappingChange("l001", "002", "4", "2026-04-01T08:00:00+08:00")
        for denied in (replace(scope, capabilities=frozenset({"ledger.read"})),
                       replace(scope, dataset_id="elsewhere")):
            with pytest.raises(ScopeError):
                preview_mapping(conn, denied, change)
        future = preview_mapping(conn, scope, replace(change, multiplier="5"))
        p = preview_mapping(conn, scope, change)
        assert p["impact"]["previous"] is None and p["impact"]["valid_to"].startswith("2026-06-01")
        with pytest.raises(ScopeError):
            confirm_mapping(conn, replace(scope, actor_id="other"), p["preview_id"], "other",
                            confirmed_by_user=True)
        confirm_mapping(conn, scope, p["preview_id"], "fill-gap", confirmed_by_user=True)
        with pytest.raises(OperationConflict):
            confirm_mapping(conn, scope, future["preview_id"], "stale-gap", confirmed_by_user=True)
        updated = replace(scope, version=3)
        assert references(conn, updated, day)["rows"][0]["sku_id"] == "002"
        july = replace(day, as_of="2026-07-01")
        assert references(conn, updated, july)["rows"][0]["sku_id"] == "001"
        cut = replace(change, effective_at="2026-07-01T08:00:00+08:00")
        mid = preview_mapping(conn, updated, cut)
        assert mid["impact"]["valid_to"].startswith("2026-08-01")
        confirm_mapping(conn, updated, mid["preview_id"], "split", confirmed_by_user=True)
        latest = replace(scope, version=4)
        june = references(conn, latest, replace(day, as_of="2026-06-30"))
        assert june["rows"][0]["sku_id"] == "001"
        assert references(conn, latest, july)["rows"][0]["sku_id"] == "002"
        august = references(conn, latest, replace(day, as_of="2026-08-02"))
        assert august["rows"][0]["mapping_status"] == "missing"


def test_store_cost_history_resolves_layers_at_business_day_end_and_paginates(context):
    from datetime import date, timedelta

    records = manual_records()
    base = records["costs"][0]
    records["costs"] += [
        {**base, "cost_id": "channel", "level": "channel", "channel_id": "pdd",
         "valid_from": "2026-06-30T16:00:00Z", "unit_cost": "3"},
        {**base, "cost_id": "shop", "level": "store", "channel_id": "pdd", "store_id": "001",
         "valid_from": "2026-07-01T16:00:00Z", "valid_to": "2026-07-02T16:00:00Z",
         "unit_cost": "0", "source": "新品首批免成本"},
        {**base, "cost_id": "other-shop", "level": "store", "channel_id": "pdd", "store_id": "002"},
    ]
    for i in range(22):
        start = date(2025, 12, 1) + timedelta(days=i)
        records["costs"].append({**base, "cost_id": f"archive-{i:02}", "source": "导入100%",
                                 "valid_from": f"{start}T00:00:00Z",
                                 "valid_to": f"{start + timedelta(days=1)}T00:00:00Z"})
    scope, _, _ = commit(context, records)
    request = ReferenceRequest(kind="listing_cost", as_of="2026-07-01", listing_id="l001",
                               sort="valid_from", descending=True)
    with psycopg.connect(context[1], autocommit=True) as connection:
        for day, key in [("2026-06-30", "c001"), ("2026-07-01", "channel"),
                         ("2026-07-02", "shop"), ("2026-07-03", "channel")]:
            history = references(connection, scope, replace(request, as_of=day))
            assert history["total"] == 25
            assert history["applied"]["cost_id"] == key
            assert history["listing"]["platform_sku_id"] == "000001"
            assert history["applied"]["currency"] == "USD"
            if key == "shop":
                assert Decimal(history["applied"]["unit_cost"]) == 0
        page2 = references(connection, scope, replace(request, page=2, search="100%"))
        assert len(page2["rows"]) == 2 and page2["total"] == 22
        assert page2["applied"]["cost_id"] == "channel"
        assert all(row["cost_id"].startswith("archive-") for row in page2["rows"])
        for item in ("unknown", "no-such-id"):
            empty = references(connection, scope, replace(request, listing_id=item))
            assert empty["rows"] == [] and empty["total"] == 0 and empty["applied"] is None
            assert bool(empty["listing"]) == (item == "unknown")


def test_store_cost_history_reports_absence_of_cost_separately_from_zero(context):
    records = manual_records()
    records["costs"] = []
    scope, _, _ = commit(context, records)
    request = ReferenceRequest(kind="listing_cost", as_of="2026-07-02", listing_id="l001")
    with psycopg.connect(context[1], autocommit=True) as connection:
        result = references(connection, scope, request)
        assert result["listing"]["sku_id"] == "001" and result["applied"] is None
        assert result["total"] == 0 and result["rows"] == []


def test_profit_statement_reconciles_two_periods_credit_fees_and_scope(context):
    records = manual_records()
    records["expenses"].append({
        **records["expenses"][1], "expense_id": "credit", "amount": "-3",
        "occurred_at": "2026-07-02T01:00:00Z", "expense_type": "advertising",
    })
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        july1 = Query(start="2026-07-01", end="2026-07-01")
        first = overview(conn, scope, OverviewRequest(july1, include_profit=True))
        statement = first["profit_statement"]
        assert statement["profit"] == statement["accounted"] == "121.00"
        assert statement["previous_profit"] is None and statement["change"] is None
        assert statement["unallocated"] == "6.00"
        parts = {row["key"]: row for row in statement["rows"]}
        assert {k: parts[k]["amount"] for k in ("sales_amount", "refund_amount", "product_cost",
                "logistics", "advertising")} == {
            "sales_amount": "260.00", "refund_amount": "-96.00", "product_cost": "-33.00",
            "logistics": "-10.00", "advertising": "0.00",
        }
        assert parts["logistics"]["fee_share"] == "1.00000000"
        july2 = replace(july1, start="2026-07-02", end="2026-07-02")
        next_day = overview(conn, scope, OverviewRequest(july2, include_profit=True))
        bridge = next_day["profit_statement"]
        assert next_day["previous"]["history_sufficient"]
        assert (bridge["profit"], bridge["previous_profit"], bridge["change"]) == (
            "3.00", "121.00", "-118.00",
        )
        assert sum(Decimal(row["change"]) for row in bridge["rows"]) == Decimal("-118")
        ad = next(row for row in bridge["rows"] if row["key"] == "advertising")
        assert ad["amount"] == "3.00" and ad["fee_share"] is None
        # The SKU has a direct fee, but its share of the platform fee is undetermined.
        scoped = replace(july1, dimension="sku", sku_ids=("001",))
        row = query_ledger(conn, scope, scoped)["summary"]["metrics"]
        assert row["logistics_expense"] is None and row["known_unallocated_expenses"] == "0.00"
        item = overview(conn, scope, OverviewRequest(scoped, include_profit=True))
        logistics = next(r for r in item["profit_statement"]["rows"] if r["key"] == "logistics")
        assert logistics["amount"] is None and logistics["known_amount"] == "-4.00"
        assert item["profit_statement"]["profit"] is None
        assert not overview(conn, scope, OverviewRequest(july1)).get("profit_statement")


def test_profit_statement_distinguishes_incomplete_and_known_components(context):
    records = manual_records()
    records["costs"] = records["costs"][1:]
    scope, _, _ = commit(context, records)
    with psycopg.connect(context[1], autocommit=True) as conn:
        data = overview(conn, scope, OverviewRequest(include_profit=True))
        statement = data["profit_statement"]
        assert statement["profit"] is None
        assert data["summary"]["quality"]["payment_missing_reasons"]["missing_cost"] == 1
        assert statement["accounted"] == data["summary"]["metrics"]["accounted_contribution"]
        cost = next(row for row in statement["rows"] if row["key"] == "product_cost")
        assert cost["amount"] is None and cost["known_amount"] == "-5.00"


def test_refund_analysis_matches_filtered_postings_and_preserves_original_denominator(context):
    records = manual_records()
    reasons = {"r1": "", "r2": "包装破损", "r3": "改变主意"}
    for refund in records["refunds"]:
        refund["reason"] = reasons.get(refund["refund_id"], "未完成")
    scope, _, _ = commit(context, records)
    july1 = Query(start="2026-07-01", end="2026-07-01")
    with psycopg.connect(context[1], autocommit=True) as connection:
        request = SourceRequest("refund", query=july1, refund_analysis=True, sort="amount")
        result = source_records(connection, scope, request)
        report = result["refund_analysis"]
        assert result["total"] == 3
        assert report["totals"] == {
            "sales_amount": "260.00", "refund_amount": "96.00", "refund_ratio": "0.36923077",
            "refund_event_count": 3, "refund_order_count": 2, "refund_cost_recovery": "33.00",
        }
        by_reason = {r["name"]: r for r in report["refund_reason"]["rows"]}
        assert set(by_reason) == {"包装破损", "改变主意", "未填写原因"}
        filtered = replace(july1, refund_reason_id=by_reason["包装破损"]["key"])
        subset = source_records(connection, scope, replace(request, query=filtered))
        assert subset["refund_analysis"]["totals"]["refund_ratio"] == "0.15384615"
        assert len(subset["rows"]) == 1
        event = subset["rows"][0]
        assert (event["source_id"], event["order_id"], event["reason"]) == ("r2", "o1", "包装破损")
        assert Decimal(event["recoverable_quantity"]) > 0 and event["cost_cny"] == "28.00"
        evidence = query_ledger(connection, scope, replace(filtered, dimension="refund_event"))
        assert len(evidence["rows"]) == 1 and evidence["rows"][0]["key"] == "r2"
        assert "o1" in evidence["rows"][0]["name"]
        assert evidence["rows"][0]["metrics"]["contribution_profit"] is None
        assert evidence["summary"]["metrics"]["refund_amount"] == "40.00"
        occurred = replace(july1, refund_basis="occurred", start="2026-07-02", end="2026-07-02")
        july2 = source_records(connection, scope, replace(request, query=occurred))
        assert july2["refund_analysis"]["totals"]["refund_ratio"] is None
        assert july2["refund_analysis"]["totals"]["refund_order_count"] == 2
        assert [r["source_id"] for r in july2["rows"]] == ["r2", "r3", "r1"]
        missing = replace(occurred, refund_search="不存在")
        empty = source_records(connection, scope, replace(request, query=missing))
        assert empty["total"] == empty["refund_analysis"]["totals"]["refund_order_count"] == 0
        assert source_records(connection, scope, replace(request, page_size=2, page=2))[
            "rows"
        ][0]["source_id"] == "r1"


def test_directory_separates_active_cost_date_from_original_payments_and_keeps_missing_skus(
    context,
):
    records = manual_records()
    # New master SKU without a listing or a sale must still be visible and searchable.
    records["skus"].append({**records["skus"][0], "sku_id": "unused", "name": "无订单规格"})
    order = records["costs"][0]
    assert order["sku_id"] == "001" and order["level"] == "base"
    for key, level, price, channel, store in (
        ("pc", "channel", "8", "pdd", ""),
        ("sc", "store", "3", "pdd", "001"),
    ):
        records["costs"].append(
            {
                **order,
                "cost_id": key,
                "level": level,
                "unit_cost": price,
                "channel_id": channel,
                "store_id": store,
                "currency": "CNY",
                "valid_from": "2026-07-02T00:00:00+08:00",
            }
        )
    scope, _, _ = commit(context, records)
    q = Query(start="2026-07-01", end="2026-07-01", store_ids=("001",))
    req = CostDirectoryRequest(as_of="2026-07-02", query=q)
    with psycopg.connect(context[1], autocommit=True) as conn:
        current = cost_directory(conn, scope, req)
        rows = {r["key"]: r for r in current["rows"]}
        assert (
            rows["001"]["applied"]["cost_id"] == "sc" and rows["001"]["base"]["cost_id"] == "c001"
        )
        assert rows["001"]["metrics"]["sales_amount"] == "160.00"
        assert rows["unused"]["applied"] is None and not rows["unused"]["has_records"]
        assert current["counts"]["catalog"] == len(records["skus"])
        before = cost_directory(conn, scope, replace(req, as_of="2026-07-01", search="001"))
        assert before["rows"][0]["applied"]["cost_id"] == "c001"
        assert before["rows"][0]["metrics"] == rows["001"]["metrics"]
        platform = cost_directory(
            conn, scope, replace(req, query=replace(q, store_ids=(), channel_ids=("pdd",)))
        )
        assert next(r for r in platform["rows"] if r["key"] == "001")["applied"]["cost_id"] == "pc"
        history = cost_directory(conn, scope, replace(req, history_sku="001"))
        assert {r["cost_id"] for r in history["rows"]} == {"sc", "pc", "c001"}
        assert Decimal(rows["001"]["applied"]["unit_cost"]) == 3
        missing = cost_directory(conn, scope, replace(req, condition="missing", search="无订单"))
        assert [r["key"] for r in missing["rows"]] == ["unused"]
        with pytest.raises(ScopeError):
            cost_directory(conn, replace(scope, capabilities=frozenset()), req)


def test_read_only_cost_simulation_uses_standard_units_and_original_refund_recovery(context):
    scope, _, _ = commit(context, manual_records())
    reader = replace(scope, capabilities=frozenset({"ledger.read"}))
    q = Query(start="2026-07-01", end="2026-07-01", store_ids=("001",))
    with psycopg.connect(context[1], autocommit=True) as conn:
        first = simulate_cost(conn, reader, q, "001", "3")
        assert first["affected_orders"] == 1
        assert first["before"]["standard_quantity"] == "4.0000"
        assert (
            first["before"]["product_cost"] == "28.00" and first["after"]["product_cost"] == "6.00"
        )
        assert first["after"]["refund_cost_recovery"] == "6.00"
        assert first["after"]["net_sales"] == first["before"]["net_sales"] == "104.00"
        # Unknown SKU expense attribution stays unknown even with a hypothetical cost.
        assert (
            first["before"]["contribution_profit"] is None
            and first["profit_difference_cny"] is None
        )
        assert (
            Decimal(first["after"]["accounted_contribution"])
            - Decimal(first["before"]["accounted_contribution"])
            == 22
        )
        occurred = replace(q, start="2026-07-02", end="2026-07-02", refund_basis="occurred")
        refund = simulate_cost(conn, reader, occurred, "001", "3")
        assert refund["after"]["refund_cost_recovery"] == "6.00" and refund["affected_orders"] == 1
        assert simulate_cost(conn, reader, q, "001", "0")["before"] == first["before"]
        with pytest.raises(ValueError):
            simulate_cost(conn, reader, q, "001", "-1")


def test_batch_cost_preview_confirmation_and_separate_historical_recalculation(context):
    scope, _, _ = commit(context, manual_records())
    change = CostChange(
        ["001", "002"], "base", "fixed", "3", "CNY", "2026-01-01T00:00:00Z", "供应商报价"
    )
    with psycopg.connect(context[1], autocommit=True) as conn:
        review = preview_costs(conn, scope, change)
        assert review["impact"]["historical_paid_lines"] == 2
        assert review["impact"]["before"]["contribution_profit"] == "121.00"
        # 4 units of 001 minus 2 recovered; 1 unit of 002 minus half a unit recovered.
        assert review["impact"]["after"]["contribution_profit"] == "146.50"
        before = cost_directory(conn, scope, CostDirectoryRequest("2026-07-01"))
        assert before["rows"][0]["applied"]["unit_cost"] == "2.0000"
        with pytest.raises(ScopeError):
            confirm_costs(
                conn, scope, review["preview_id"], "cost-confirm", confirmed_by_user=False
            )
        result = confirm_costs(
            conn, scope, review["preview_id"], "cost-confirm", confirmed_by_user=True
        )
        assert result["version"] == 3 and len(result["data"]["cost_ids"]) == 2
        assert (
            confirm_costs(conn, scope, review["preview_id"], "cost-confirm", confirmed_by_user=True)
            == result
        )
        current = replace(scope, version=3)
        q = Query(start="2026-07-01", end="2026-07-01", metrics=("contribution_profit",))
        assert (
            query_ledger(conn, current, q)["summary"]["metrics"]["contribution_profit"] == "121.00"
        )
        for mode, value, expected in (
            ("percent", "-12.5", "2.6250"),
            ("amount", "1.2345", "4.2345"),
        ):
            later = replace(change, method=mode, value=value, effective_at="2026-08-01T00:00:00Z")
            price = preview_costs(conn, current, later)
            assert {r["unit_cost"] for r in price["impact"]["items"]} == {expected}
            assert price["impact"]["historical_paid_lines"] == 0
        with pytest.raises(ValueError):
            preview_costs(conn, current, replace(change, method="amount", value="-4"))
        recalc = preview_recalculation(conn, current, line_ids=["line-o1", "line-o2"])
        result = confirm_recalculation(conn, current, recalc, "cost-recalc", confirmed_by_user=True)
        final = query_ledger(conn, replace(scope, version=result["version"]), q)
        assert final["summary"]["metrics"]["contribution_profit"] == "146.50"


def test_report_csv_matches_full_scope_and_personal_view_revision(context):
    import csv
    import io

    from shopgate_commerce_data.ledger.report_views import change_view, list_views
    from shopgate_commerce_data.ledger.reports import TYPES, Report, run_report

    records = manual_records()
    for i in range(22):
        records["refunds"].append(
            {
                **records["refunds"][0],
                "refund_id": f"extra-{i:02}",
                "amount": "0.10",
            }
        )
    scope, _, _ = commit(context, records)
    query = Query(start="2026-01-01", end="2026-12-31")
    view_id = str(uuid4())
    with psycopg.connect(context[1], autocommit=True) as conn:
        for kind in TYPES:
            report = Report(kind, query)
            table = run_report(conn, scope, report)
            exported = run_report(conn, scope, report, export=True)
            parsed = list(csv.reader(io.StringIO(exported.lstrip("\ufeff"))))
            assert table["total"] > 0 and len(parsed) == table["total"] + 1
            assert parsed[0] == [table["labels"][key] for key in table["columns"]]
            evidence = run_report(conn, scope, report, evidence=True)
            assert evidence["total"] == table["total"]
            assert evidence["rows"][0]["key"] == table["rows"][0]["id"]
            if kind == "orders":
                assert all(row["values"]["cost_id"] for row in table["rows"])
        report = Report("refunds", query, search="extra-", columns=("key", "amount"), sort="key")
        table = run_report(conn, scope, replace(report, page=2))
        assert table["total"] == 22 and len(table["rows"]) == 2
        assert table["rows"][-1]["id"] == "extra-00"
        proof = run_report(conn, scope, report, evidence=True)
        # 22 refunds of USD 0.10 at the fixture rate of CNY 8 per dollar.
        assert proof["summary"]["metrics"]["refund_amount"] == "17.60"
        saved = change_view(conn, scope, "create", view_id, name="退款核对", options=report)
        assert change_view(conn, scope, "create", view_id, name="退款核对", options=report) == saved
    with psycopg.connect(context[1], autocommit=True) as conn:
        assert list_views(conn, scope, 1)["rows"][0]["options"]["columns"] == ["key", "amount"]
        outsider = replace(scope, actor_id="another")
        assert list_views(conn, outsider, 1)["total"] == 0
        with pytest.raises(ScopeError):
            change_view(conn, outsider, "delete", view_id, revision=1)
        assert (
            change_view(conn, scope, "rename", view_id, revision=1, name="部分退款")["revision"]
            == 2
        )
        with pytest.raises(OperationConflict):
            change_view(conn, scope, "delete", view_id, revision=1)
        change_view(conn, scope, "delete", view_id, revision=2)
        assert list_views(conn, scope, 1)["total"] == 0


def test_indexed_postings_match_canonical_filters_dates_sources_and_isolation(context, monkeypatch):
    from shopgate_commerce_data.ledger import read_index
    from shopgate_commerce_data.ledger.operations import bind_scope
    from shopgate_commerce_data.ledger.query import LedgerReadSnapshot

    monkeypatch.setattr(read_index, "MIN_ORDERS", 1)
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        choice = OverviewRequest(query=Query(refund_basis="occurred"))
        archived = overview(connection, scope, choice)
        with monkeypatch.context() as patch:
            patch.setattr(query_module, "IndexedEvents", lambda *args, **kwargs: None)
            original = overview(connection, scope, choice)
        assert archived == original
        with ledger_read_snapshot(connection, scope) as indexed:
            assert indexed._index.header[0] == 1
            raw = LedgerReadSnapshot(connection, scope, indexed._run)
            for basis in ("payment", "occurred"):
                for params in (
                    {"dimension": "sku"}, {"dimension": "refund_event"},
                    {"dimension": "channel", "store_ids": ("001",)},
                    {"dimension": "order", "search": "001"},
                    {"start": "2026-07-02", "end": "2026-07-03", "group_condition": "incomplete",
                     "condition_grain": "sku", "condition_start": "2026-07-01",
                     "condition_end": "2026-07-01"},
                ):
                    query = Query(refund_basis=basis, **params)
                    assert indexed.selected_events(query) == raw.selected_events(query)
                    assert indexed.query(query, profit=True) == raw.query(query, profit=True)
            with pytest.raises(ValueError, match="店铺不属于"):
                indexed.query(Query(store_ids=("001",), channel_ids=("foreign",)))
        with connection.transaction():
            bind_scope(connection, replace(scope, workspace_id="foreign"))
            assert connection.execute("SELECT count(*) FROM bi.read_index_parts").fetchone() == (0,)
        preview = preview_target(connection, scope, TargetChange("001", "2026-07-01", "1800", "90"))
        new_version = confirm_target(
            connection, scope, preview["preview_id"], "indexed-target", confirmed_by_user=True
        )["version"]
        updated = replace(scope, version=new_version)
        with ledger_read_snapshot(connection, updated) as advanced:
            assert advanced._index.header[0] == 1
            metrics = advanced.query(Query())["summary"]["metrics"]
            assert metrics["accounted_contribution"] == "121.00"
        with pytest.raises(OperationConflict):
            query_ledger(connection, scope, Query())
        with connection.transaction():
            bind_scope(connection, updated)
            with ledger_read_snapshot(connection, updated, _preview_transaction=True) as preview:
                assert preview._index is None
        assert read_index.rebuild_existing(connection, updated)
        with ledger_read_snapshot(connection, updated) as retry:
            assert retry._index.header[0] == 2
            assert retry.query(Query())["summary"]["metrics"]["accounted_contribution"] == "121.00"


def test_index_failed_rebuild_leaves_prior_projection_and_payment_revision(context, monkeypatch):
    from shopgate_commerce_data.ledger import read_index

    monkeypatch.setattr(read_index, "MIN_ORDERS", 1)
    scope, _, _ = commit(context)
    with psycopg.connect(context[1], autocommit=True) as connection:
        baseline = query_ledger(connection, scope, Query())
        write = read_index._write_basis

        def fail_second_basis(conn, current_scope, basis, generation):
            if basis == "occurred":
                raise RuntimeError("interrupted rebuild")
            return write(conn, current_scope, basis, generation)

        monkeypatch.setattr(read_index, "_write_basis", fail_second_basis)
        with pytest.raises(RuntimeError, match="interrupted rebuild"):
            read_index.rebuild_existing(connection, scope)
        assert query_ledger(connection, scope, Query()) == baseline
        with ledger_read_snapshot(connection, scope) as read:
            assert read._index.header[0] == 1
