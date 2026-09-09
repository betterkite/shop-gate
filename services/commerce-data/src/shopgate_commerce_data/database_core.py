from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg

ROOT_DIR = Path(__file__).resolve().parents[4]


class DatabaseError(RuntimeError):
    """数据库不可用或 commerce 表结构未初始化。"""


def load_local_env_if_needed() -> None:
    if os.getenv("DATABASE_URL"):
        return
    for env_file in (ROOT_DIR / ".env", ROOT_DIR / ".env.local"):
        if not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            if key.strip() == "DATABASE_URL":
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
                return


def database_url_from_env() -> str:
    load_local_env_if_needed()
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise DatabaseError("DATABASE_URL 未配置，无法访问本地 TimescaleDB。")
    if not (url.startswith("postgresql://") or url.startswith("postgres://")):
        raise DatabaseError("DATABASE_URL 必须指向 PostgreSQL/TimescaleDB。")
    parsed = urlsplit(url)
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != "schema"
    ]
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment)
    )


async def connect() -> psycopg.AsyncConnection:
    try:
        return await psycopg.AsyncConnection.connect(database_url_from_env())
    except psycopg.OperationalError as error:
        raise DatabaseError(f"无法连接 TimescaleDB：{error}") from error
