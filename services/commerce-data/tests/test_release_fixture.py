"""Release-only data preparation; the backend harness supplies a disposable PostgreSQL 18."""

import os
from datetime import date
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from shopgate_commerce_data.release_fixture import main, prepare_release_fixture


def test_rejects_non_hosted_jobs_and_non_release_databases(monkeypatch):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    with pytest.raises(SystemExit, match="hosted release job"):
        main()
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("RUNNER_ENVIRONMENT", "github-hosted")
    monkeypatch.setenv("SHOPGATE_EVAL_TRIGGER", "release")
    monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/daily")
    with pytest.raises(SystemExit, match="loopback database"):
        main()


def test_atomic_seed_has_rankings_inventory_prices_and_preserves_existing_data():
    url = os.environ["SHOPGATE_LEDGER_TEST_DATABASE_URL"]
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    ddl = Path(__file__).resolve().parents[3] / "sqls"
    with (
        psycopg.connect(url, autocommit=True, row_factory=dict_row) as conn,
        conn.transaction(force_rollback=True),
    ):
        assert (
            conn.execute("SELECT to_regnamespace('commerce') AS schema").fetchone()["schema"]
            is None
        )
        # The test server is plain PostgreSQL; the commerce tables themselves use standard SQL.
        for file in sorted(ddl.glob("[0-9]*.sql")):
            sql = file.read_text().replace("CREATE EXTENSION IF NOT EXISTS timescaledb;", "")
            conn.execute(sql)

        conn.execute(
            "ALTER TABLE commerce.dataset_contracts ADD CONSTRAINT reject_fixture_test "
            "CHECK (source_kind <> 'synthetic')"
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            prepare_release_fixture(conn)
        assert conn.execute("SELECT count(*) AS n FROM commerce.items").fetchone()["n"] == 0
        assert (
            conn.execute("SELECT count(*) AS n FROM commerce.user_behavior_events").fetchone()["n"]
            == 0
        )
        conn.execute("ALTER TABLE commerce.dataset_contracts DROP CONSTRAINT reject_fixture_test")
        result = prepare_release_fixture(conn)
        assert (result["first_day"], result["last_day"]) == (date(2017, 11, 25), date(2017, 12, 3))
        assert result["days"] == 9 and result["categories"] >= 10
        assert result["analytics"]["inventory_snapshots_rows"] == 30 * 1000
        assert result["analytics"]["price_experiment_assignments_rows"] > 0
        compared_items = conn.execute("""
            SELECT count(*) AS n FROM (
                SELECT item_id FROM commerce.dataset_price_experiment_observations
                WHERE synthetic AND exposed_users > 0
                GROUP BY item_id
                HAVING count(DISTINCT variant) = 2 AND min(selling_price) < max(selling_price)
            ) prices
        """).fetchone()
        assert compared_items["n"] > 0
        counts = "SELECT source, count(*) AS n FROM commerce.user_behavior_events GROUP BY source"
        original = conn.execute(counts).fetchall()
        assert (
            len(original) == 1 and original[0]["source"] == "synthetic" and original[0]["n"] > 1000
        )
        with pytest.raises(ValueError, match="empty table"):
            prepare_release_fixture(conn)
        assert conn.execute(counts).fetchall() == original
