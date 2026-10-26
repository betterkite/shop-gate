"""Explicit, transactional migrations; normal API startup never applies DDL."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

MIGRATION = Path(__file__).resolve().parents[5] / "sqls" / "ledger" / "006-bi-ledger.sql"
MIGRATIONS = (
    ("006", "006-bi-ledger.sql"),
    ("007", "007-bi-accounting.sql"),
    ("008", "008-bi-exchange.sql"),
    ("009", "009-bi-datasets.sql"),
    ("010", "010-bi-jobs.sql"),
    ("011", "011-bi-private-retention.sql"),
)


def migration_database_url() -> str:
    """No dotenv discovery or daily/runtime DATABASE_URL fallback for admin DDL."""
    url = os.getenv("SHOPGATE_BI_MIGRATION_DATABASE_URL", "").strip()
    if not url:
        raise ValueError("请显式配置独立的经营迁移连接 SHOPGATE_BI_MIGRATION_DATABASE_URL。")
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or not parsed.hostname
            or not parsed.username
            or not parsed.path.startswith("/")
            or parsed.path == "/"
            or parsed.fragment
            or parsed.port == 0
        ):
            raise ValueError()
    except ValueError:
        raise ValueError("经营迁移连接须明确 PostgreSQL 主机、账号和目标数据库。") from None
    return url


def migrate(
    connection: psycopg.Connection, *, migration_path: Path = MIGRATION, revision: str = "006"
) -> None:
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
            (revision,),
        ).fetchone()
        if existing:
            if existing[0] != digest:
                raise RuntimeError("已应用的经营迁移校验不一致；请新增迁移，不得改写历史。")
            return
        connection.execute(source)
        connection.execute(
            "INSERT INTO bi.schema_migrations (revision, checksum) VALUES (%s, %s)",
            (revision, digest),
        )


def migrate_all(connection: psycopg.Connection) -> None:
    # Apply the ordered series atomically, including on a fresh database.
    with connection.transaction():
        for revision, filename in MIGRATIONS:
            migrate(
                connection,
                migration_path=MIGRATION.with_name(filename),
                revision=revision,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="显式安装独立BI账本，不修改旧commerce表。")
    parser.parse_args()
    try:
        url = migration_database_url()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    try:
        with psycopg.connect(url, autocommit=True, connect_timeout=5) as connection:
            migrate_all(connection)
    except (psycopg.Error, RuntimeError):
        # Do not echo administrator credentials, private SQL or source values.
        raise SystemExit("经营账本迁移未完成；请检查目标库权限、迁移校验和及私有运维记录。") from None
    print(f"BI ledger migrations {'/'.join(revision for revision, _ in MIGRATIONS)} verified/applied.")


if __name__ == "__main__":
    main()
