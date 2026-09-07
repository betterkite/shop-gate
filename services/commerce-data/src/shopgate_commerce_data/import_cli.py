"""Shop Gate 零售数据导入 CLI（PRD §5，console 脚本 ``shopgate-commerce-import``）。

子命令：

- ``import-userbehavior``：读取天池 UserBehavior CSV，抽样 N 个用户全量行为入库；
- ``generate-synthetic-behavior``：无 CSV 时的合成行为流兜底（source='synthetic'）；
- ``generate-synthetic-master``：按事件流 DISTINCT (item_id, category_id) 生成合成主数据；
- ``aggregate-daily``：生成商品/类目日聚合（GMV = buy × 合成价格）。

所有命令可重复执行前的重跑语义：行为导入用 ``TRUNCATE`` 清空后整批写入
（本地单数据源口径）；主数据与聚合用幂等 upsert / 重建。
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from shopgate_commerce_data.database_core import database_url_from_env
from shopgate_commerce_data.synthetic import (
    batched_events,
    synthetic_behavior_events,
    synthetic_master_rows,
)

EVENT_COLUMNS = ("user_id", "item_id", "category_id", "behavior_type", "timestamp")
VALID_BEHAVIORS = {"pv", "fav", "cart", "buy"}


def shift_target_end(anchor_end: str, time_shift: str):
    """计算平移目标窗口末日。

    ``last-week``：最近一个完整周（上周一 ~ 上周日）；
    ``none``：保持 anchor_end 原样。
    """

    anchor = date.fromisoformat(anchor_end)
    if time_shift != "last-week":
        return anchor
    today = date.today()
    days_since_monday = today.weekday()
    this_monday = today - timedelta(days=days_since_monday)
    last_monday = this_monday - timedelta(days=7)
    return last_monday + timedelta(days=6)


def compute_time_shift_days(anchor_end: str, time_shift: str):
    """返回平移天数（time_shift=none 时为 None）。"""

    if time_shift != "last-week":
        return None
    target_end = shift_target_end(anchor_end, time_shift)
    anchor = date.fromisoformat(anchor_end)
    return (target_end - anchor).days


def _connect() -> psycopg.Connection[dict[str, Any]]:
    return psycopg.connect(
        database_url_from_env(),
        row_factory=dict_row,
        autocommit=False,
    )


def _shift_event_timestamps(
    events: Iterator[dict[str, Any]],
    shift_days: int | None,
) -> Iterator[dict[str, Any]]:
    """按需平移事件时间戳（PRD 演示口径：窗口平移到最近完整周）。"""

    if not shift_days:
        yield from events
        return
    for event in events:
        event["event_ts"] = event["event_ts"] + timedelta(days=shift_days)
        yield event


def _register_ingestion_job(
    connection: psycopg.Connection[dict[str, Any]],
    *,
    provider: str,
    rows_received: int,
    metadata: dict[str, Any],
) -> str:
    job_id = f"import-{provider}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}"
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO commerce.market_data_ingestion_jobs
              (id, provider, timeframe, adjustment, status, total_symbols,
               completed_symbols, rows_received, rows_upserted, metadata,
               started_at, completed_at)
            VALUES (%s, %s, 'daily', 'none', 'completed', 1, 1, %s, %s, %s,
                    now(), now())
            """,
            (job_id, provider, rows_received, rows_received, Jsonb(metadata)),
        )
        cursor.execute(
            """
            INSERT INTO commerce.market_data_sync_state
              (symbol, timeframe, adjustment, provider, last_success_at, metadata)
            VALUES (%s, 'daily', 'none', %s, now(), %s)
            ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE
            SET last_success_at = now(), metadata = EXCLUDED.metadata
            """,
            (f"dataset:{provider}", provider, Jsonb(metadata)),
        )
    return job_id


def _insert_events(
    connection: psycopg.Connection[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> None:
    with connection.cursor() as cursor, cursor.copy(
        """
            COPY commerce.user_behavior_events
              (user_id, item_id, category_id, behavior_type, event_ts, source)
            FROM STDIN
            """
    ) as copy:
        for row in rows:
            copy.write_row(
                (
                    row["user_id"],
                    row["item_id"],
                    row["category_id"],
                    row["behavior_type"],
                    row["event_ts"],
                    row.get("source", "tianchi_userbehavior"),
                )
            )


def scan_userbehavior_csv(
    csv_path: Path,
) -> tuple[int, set[int]]:
    """第一遍扫描：统计行数并收集用户集合（全量 1 亿行也只留用户 ID 集合）。"""

    user_ids: set[int] = set()
    row_count = 0
    with csv_path.open("r", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header is not None and [column.strip() for column in header] != list(
            EVENT_COLUMNS
        ):
            raise SystemExit(
                f"CSV 列必须严格为 {list(EVENT_COLUMNS)}，实际为 {header}"
            )
        for line_number, row in enumerate(reader, start=2):
            if not row or all(not cell.strip() for cell in row):
                continue
            if len(row) != 5:
                raise SystemExit(f"第 {line_number} 行列数不是 5：{row}")
            behavior_type = row[3].strip()
            if behavior_type not in VALID_BEHAVIORS:
                raise SystemExit(
                    f"第 {line_number} 行 behavior_type 非法：{behavior_type}"
                )
            int(row[0].strip())
            int(row[1].strip())
            int(row[2].strip())
            int(row[4].strip())
            user_ids.add(int(row[0].strip()))
            row_count += 1
    if row_count == 0:
        raise SystemExit("CSV 中没有可导入的事件行")
    return row_count, user_ids


def iter_userbehavior_events(
    csv_path: Path,
    sampled_users: set[int],
) -> Iterator[dict[str, Any]]:
    """第二遍流式读取：只产出被抽样用户的事件（不整表进内存）。"""

    with csv_path.open("r", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        next(reader, None)
        for row in reader:
            if not row or all(not cell.strip() for cell in row):
                continue
            user_id = int(row[0].strip())
            if user_id not in sampled_users:
                continue
            yield {
                "user_id": user_id,
                "item_id": int(row[1].strip()),
                "category_id": int(row[2].strip()),
                "behavior_type": row[3].strip(),
                "event_ts": datetime.fromtimestamp(int(row[4].strip()), tz=UTC),
                "source": "tianchi_userbehavior",
            }


def import_events(
    connection: psycopg.Connection[dict[str, Any]],
    events: Iterator[dict[str, Any]],
    *,
    provider: str,
    meta: dict[str, Any],
    batch_size: int,
) -> None:
    _truncate_events(connection)
    inserted = 0
    for batch in batched_events(events, batch_size):
        _insert_events(connection, batch)
        inserted += len(batch)
        if inserted % (batch_size * 10) == 0:
            print(f"[import] 已写入 {inserted}", flush=True)
    job_id = _register_ingestion_job(
        connection,
        provider=provider,
        rows_received=inserted,
        metadata=meta,
    )
    connection.commit()
    print(f"[import] 完成：job={job_id} rows={inserted}")


def _truncate_events(connection: psycopg.Connection[dict[str, Any]]) -> None:
    with connection.cursor() as cursor:
        cursor.execute("TRUNCATE commerce.user_behavior_events")
        cursor.execute("TRUNCATE commerce.daily_item_metrics")
        cursor.execute("TRUNCATE commerce.daily_category_metrics")


def derive_item_category(
    connection: psycopg.Connection[dict[str, Any]],
) -> dict[int, int]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT item_id, category_id FROM commerce.user_behavior_events"
        )
        mapping = {row["item_id"]: row["category_id"] for row in cursor.fetchall()}
    if not mapping:
        raise SystemExit("事件表为空：先导入行为数据再生成主数据")
    return mapping


def upsert_master_rows(
    connection: psycopg.Connection[dict[str, Any]],
    master: dict[str, list[dict[str, Any]]],
) -> None:
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO commerce.categories (category_id, name, synthetic_name, parent_id)
            VALUES (%(category_id)s, %(name)s, %(synthetic_name)s, %(parent_id)s)
            ON CONFLICT (category_id) DO UPDATE
            SET name = EXCLUDED.name, synthetic_name = EXCLUDED.synthetic_name
            """,
            master["categories"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.brands (brand_id, name, synthetic)
            VALUES (%(brand_id)s, %(name)s, %(synthetic)s)
            ON CONFLICT (brand_id) DO UPDATE
            SET name = EXCLUDED.name, synthetic = EXCLUDED.synthetic
            """,
            master["brands"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.shops (shop_id, name, tier, synthetic)
            VALUES (%(shop_id)s, %(name)s, %(tier)s, %(synthetic)s)
            ON CONFLICT (shop_id) DO UPDATE
            SET name = EXCLUDED.name, tier = EXCLUDED.tier, synthetic = EXCLUDED.synthetic
            """,
            master["shops"],
        )
        cursor.executemany(
            """
            INSERT INTO commerce.items
              (item_id, category_id, title, brand_id, shop_id, price, stock,
               listed_at, synthetic_master)
            VALUES (%(item_id)s, %(category_id)s, %(title)s, %(brand_id)s,
                    %(shop_id)s, %(price)s, %(stock)s, %(listed_at)s,
                    %(synthetic_master)s)
            ON CONFLICT (item_id) DO UPDATE
            SET category_id = EXCLUDED.category_id, title = EXCLUDED.title,
                brand_id = EXCLUDED.brand_id, shop_id = EXCLUDED.shop_id,
                price = EXCLUDED.price, stock = EXCLUDED.stock,
                listed_at = EXCLUDED.listed_at,
                synthetic_master = EXCLUDED.synthetic_master
            """,
            master["items"],
        )


def rebuild_daily_aggregates(connection: psycopg.Connection[dict[str, Any]]) -> int:
    with connection.cursor() as cursor:
        cursor.execute("TRUNCATE commerce.daily_item_metrics")
        cursor.execute("TRUNCATE commerce.daily_category_metrics")
        cursor.execute(
            """
            INSERT INTO commerce.daily_item_metrics
              (stat_date, item_id, category_id, pv, fav, cart, buy, gmv)
            SELECT
              e.event_ts::date,
              e.item_id,
              e.category_id,
              COUNT(*) FILTER (WHERE e.behavior_type = 'pv'),
              COUNT(*) FILTER (WHERE e.behavior_type = 'fav'),
              COUNT(*) FILTER (WHERE e.behavior_type = 'cart'),
              COUNT(*) FILTER (WHERE e.behavior_type = 'buy'),
              COALESCE(SUM(CASE WHEN e.behavior_type = 'buy' THEN i.price END), 0)
            FROM commerce.user_behavior_events e
            JOIN commerce.items i ON i.item_id = e.item_id
            GROUP BY 1, 2, 3
            """
        )
        cursor.execute(
            """
            INSERT INTO commerce.daily_category_metrics
              (stat_date, category_id, pv, fav, cart, buy, buyers, gmv)
            SELECT
              stat_date,
              category_id,
              SUM(pv),
              SUM(fav),
              SUM(cart),
              SUM(buy),
              0,
              SUM(gmv)
            FROM commerce.daily_item_metrics
            GROUP BY stat_date, category_id
            """
        )
        cursor.execute(
            """
            UPDATE commerce.daily_category_metrics m
            SET buyers = u.buyers
            FROM (
              SELECT event_ts::date AS stat_date, category_id,
                     COUNT(DISTINCT user_id) AS buyers
              FROM commerce.user_behavior_events
              WHERE behavior_type = 'buy'
              GROUP BY 1, 2
            ) u
            WHERE u.stat_date = m.stat_date AND u.category_id = m.category_id
            """
        )
        cursor.execute("SELECT COUNT(*) AS rows FROM commerce.daily_item_metrics")
        count = cursor.fetchone()["rows"] if cursor.description else 0
    return int(count or 0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Shop Gate 零售数据导入工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_parser = subparsers.add_parser(
        "import-userbehavior", help="导入天池 UserBehavior CSV（确定性用户抽样）"
    )
    import_parser.add_argument("--csv", required=True, type=Path)
    import_parser.add_argument("--users", type=int, default=10_000)
    import_parser.add_argument("--seed", type=int, default=20251203)
    import_parser.add_argument("--batch-size", type=int, default=10_000)
    import_parser.add_argument(
        "--time-shift",
        dest="time_shift",
        default="last-week",
        help="last-week: 平移到最近一个完整周；none: 保持原始时间戳",
    )
    import_parser.add_argument(
        "--anchor-end",
        default="2017-12-03",
        help="原始数据窗口末日（用于平移计算）",
    )

    synthetic_parser = subparsers.add_parser(
        "generate-synthetic-behavior", help="合成行为流兜底（无 CSV 时，PRD R1）"
    )
    synthetic_parser.add_argument("--users", type=int, default=10_000)
    synthetic_parser.add_argument("--days", type=int, default=9)
    synthetic_parser.add_argument("--seed", type=int, default=20251203)
    synthetic_parser.add_argument("--batch-size", type=int, default=10_000)
    synthetic_parser.add_argument(
        "--time-shift",
        dest="time_shift",
        default="last-week",
        help="last-week: 平移到最近一个完整周；none: 锚定 anchor_end",
    )
    synthetic_parser.add_argument(
        "--anchor-end",
        default="2017-12-03",
        help="合成窗口末日锚点",
    )

    subparsers.add_parser(
        "generate-synthetic-master", help="按事件流生成合成商品主数据（PRD §5.2）"
    ).add_argument("--seed", type=int, default=20251203)

    subparsers.add_parser("aggregate-daily", help="重建商品/类目日聚合")

    args = parser.parse_args()
    connection = _connect()
    try:
        if args.command == "import-userbehavior":
            if not args.csv.is_file():
                raise SystemExit(f"CSV 不存在：{args.csv}")
            row_count, user_ids = scan_userbehavior_csv(args.csv)
            ordered_users = sorted(user_ids)
            if args.users >= len(ordered_users):
                sampled = set(ordered_users)
                sampled_count = len(ordered_users)
            else:
                sampled = set(
                    random.Random(f"sample|{args.seed}").sample(ordered_users, args.users)
                )
                sampled_count = args.users
            meta = {
                "mode": "tianchi_userbehavior",
                "csv_rows": row_count,
                "csv_users": len(ordered_users),
                "sampled_users": sampled_count,
                "seed": args.seed,
                "time_shift": args.time_shift,
                "shift_days": compute_time_shift_days(args.anchor_end, args.time_shift),
            }
            print(f"[import] 抽样完成：{meta}", flush=True)
            import_events(
                connection,
                _shift_event_timestamps(
                    iter_userbehavior_events(args.csv, sampled),
                    compute_time_shift_days(args.anchor_end, args.time_shift),
                ),
                provider="userbehavior_csv",
                meta=meta,
                batch_size=args.batch_size,
            )
        elif args.command == "generate-synthetic-behavior":
            meta = {
                "mode": "synthetic_fallback",
                "users": args.users,
                "days": args.days,
                "seed": args.seed,
                "time_shift": args.time_shift,
                "anchor_end": args.anchor_end,
            }
            import_events(
                connection,
                synthetic_behavior_events(
                    users=args.users,
                    days=args.days,
                    seed=args.seed,
                    end_day=shift_target_end(args.anchor_end, args.time_shift),
                ),
                provider="synthetic",
                meta=meta,
                batch_size=args.batch_size,
            )
        elif args.command == "generate-synthetic-master":
            item_category = derive_item_category(connection)
            window_start = datetime(2017, 11, 25, tzinfo=UTC)
            master = synthetic_master_rows(item_category, args.seed, window_start)
            upsert_master_rows(connection, master)
            connection.commit()
            print(
                "[master] 完成："
                f"categories={len(master['categories'])} brands={len(master['brands'])} "
                f"shops={len(master['shops'])} items={len(master['items'])}"
            )
        elif args.command == "aggregate-daily":
            rows = rebuild_daily_aggregates(connection)
            connection.commit()
            print(f"[aggregate] 完成：daily_item_metrics rows={rows}")
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
