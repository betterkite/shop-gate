"""Admin migration CLI must never discover a daily database or print credentials."""
import os
import subprocess
import sys
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from shopgate_commerce_data.ledger.migrations import migration_database_url


def test_migration_connection_never_loads_dotenv_or_falls_back(monkeypatch, tmp_path):
    monkeypatch.delenv("SHOPGATE_BI_MIGRATION_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://private-password@daily.invalid/daily")
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text(
        "SHOPGATE_BI_MIGRATION_DATABASE_URL=postgresql://admin@daily.invalid/never-discover\n"
    )
    with pytest.raises(ValueError, match="独立的经营迁移连接"):
        migration_database_url()


@pytest.mark.parametrize("value", [
    "sqlite:///private", "postgresql://admin@host", "postgresql://admin@host/",
    "postgresql://host/db", "postgresql://admin@host:invalid/db",
    "postgresql://admin@host:0/db", "postgresql://admin@host/db#private-secret",
])
def test_migration_target_must_be_explicit_without_echoing_it(monkeypatch, value):
    monkeypatch.setenv("SHOPGATE_BI_MIGRATION_DATABASE_URL", value)
    with pytest.raises(ValueError) as rejected:
        migration_database_url()
    assert value not in str(rejected.value) and "private-secret" not in str(rejected.value)


def test_explicit_migration_connection_preserves_tls_options(monkeypatch):
    value = "postgresql://operator@db.internal/confirmed_target?sslmode=verify-full"
    monkeypatch.setenv("SHOPGATE_BI_MIGRATION_DATABASE_URL", value)
    assert migration_database_url() == value


def test_actual_cli_new_database_repeat_and_missing_connection():
    admin_url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL", "")
    assert admin_url.startswith("postgresql://ledger_test_admin@127.0.0.1:"), (
        "Only the trusted isolated backend harness may execute this test."
    )
    database = f"migration_cli_{uuid4().hex}"
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    target = admin_url.rsplit("/", 1)[0] + "/" + database
    environment = {
        key: value for key, value in os.environ.items()
        if key in {"PATH", "LD_PRELOAD", "PYTHONPATH", "PYTHONHOME", "SYSTEMROOT"}
    }
    environment.update({"SHOPGATE_BI_MIGRATION_DATABASE_URL": target,
                        "DATABASE_URL": "postgresql://private-password@daily.invalid/never-used"})
    command = [sys.executable, "-m", "shopgate_commerce_data.ledger.migrations"]
    results = [subprocess.run(command, env=environment, capture_output=True, text=True,
                              timeout=30) for _ in range(2)]
    for result in results:
        assert result.returncode == 0, result.stderr
        assert "006/007/008/009/010/011 verified/applied" in result.stdout
        assert "postgresql://" not in result.stdout + result.stderr
        assert "private-password" not in result.stdout + result.stderr
    with psycopg.connect(target, autocommit=True) as connection:
        assert [row[0] for row in connection.execute(
            "SELECT revision FROM bi.schema_migrations ORDER BY revision"
        )] == ["006", "007", "008", "009", "010", "011"]
        assert connection.execute("SELECT count(*) FROM bi.workspaces").fetchone() == (0,)
    environment.pop("SHOPGATE_BI_MIGRATION_DATABASE_URL")
    missing = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=15)
    assert missing.returncode != 0 and "独立的经营迁移连接" in missing.stderr
    assert "private-password" not in missing.stdout + missing.stderr
    assert "daily.invalid" not in missing.stdout + missing.stderr
