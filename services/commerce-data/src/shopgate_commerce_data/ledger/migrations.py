"""Explicit, transactional migrations; normal API startup never applies DDL."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import psycopg

from shopgate_commerce_data.database_core import database_url_from_env

MIGRATION = Path(__file__).resolve().parents[5] / "sqls" / "006-bi-ledger.sql"


def migrate(connection: psycopg.Connection, *, migration_path: Path = MIGRATION) -> None:
    source = migration_path.read_text(encoding="utf-8")
    digest = hashlib.sha256(source.encode()).hexdigest()
    with connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(618004, 1)")
        connection.execute("CREATE SCHEMA IF NOT EXISTS bi")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS bi.schema_migrations "
            "(revision text PRIMARY KEY, checksum text NOT NULL, "
            "applied_at timestamptz NOT NULL DEFAULT clock_timestamp())"
        )
        existing = connection.execute(
            "SELECT checksum FROM bi.schema_migrations WHERE revision = %s",
            ("006",),
        ).fetchone()
        if existing:
            if existing[0] != digest:
                raise RuntimeError("已应用的经营迁移校验不一致；请新增迁移，不得改写历史。")
            return
        connection.execute(source)
        connection.execute(
            "INSERT INTO bi.schema_migrations (revision, checksum) VALUES (%s, %s)",
            ("006", digest),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="显式安装独立BI账本，不修改旧commerce表。")
    parser.parse_args()
    with psycopg.connect(database_url_from_env(), autocommit=True) as connection:
        migrate(connection)
    print("BI ledger migration 006 verified/applied.")


if __name__ == "__main__":
    main()
