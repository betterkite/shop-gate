"""Rebuild derived query blocks for one upgraded dataset under its normal runtime role."""

import argparse
import os

import psycopg

from .operations import OperationConflict
from .read_index import rebuild_existing
from .scope import IDENTIFIER, LedgerScope, ScopeError


def main():
    parser = argparse.ArgumentParser(description="为指定数据集版本重建经营查询索引。")
    for name in ("workspace", "dataset", "actor"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--version", type=int, required=True)
    args = parser.parse_args()
    ids = (args.workspace, args.dataset, args.actor)
    if args.version < 1 or not all(IDENTIFIER.fullmatch(value) for value in ids):
        parser.error("请输入有效的工作空间、数据集、操作账号和正整数版本。")
    dsn = os.getenv("SHOPGATE_BI_DATABASE_URL")
    if not dsn:
        parser.error("请指定具有该数据集读写权限的经营数据库连接 SHOPGATE_BI_DATABASE_URL。")
    scope = LedgerScope(*ids, args.version, frozenset({"ledger.read", "ledger.manage"}))
    try:
        with psycopg.connect(dsn, autocommit=True, connect_timeout=5) as conn:
            populated = rebuild_existing(conn, scope)
    except (OperationConflict, ScopeError) as error:
        raise SystemExit(str(error)) from None
    except psycopg.Error:
        raise SystemExit("索引重建未提交，请检查连接、权限和迁移版本后重试。") from None
    print("指定版本的查询索引已就绪。" if populated else "该版本还没有经营记录。")


if __name__ == "__main__":
    main()
