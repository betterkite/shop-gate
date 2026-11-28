"""Prepare the disposable commerce database used by the hosted release questions."""

import json
import os
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from shopgate_commerce_data.database_core import database_url_from_env
from shopgate_commerce_data.import_cli import (
    derive_item_category,
    rebuild_daily_aggregates,
    replace_synthetic_analytics_dataset,
    scan_synthetic_analytics_dataset,
    upsert_master_rows,
)
from shopgate_commerce_data.synthetic import (
    DEFAULT_ANALYTICS_DATASET_ID,
    synthetic_analytics_dataset,
    synthetic_behavior_events,
    synthetic_master_rows,
)

SEED = 20251203
# R04 asks specifically about this business date.
WINDOW_END = datetime(2017, 12, 3, tzinfo=UTC)
WINDOW_START = WINDOW_END - timedelta(days=8)

# The master, aggregate and analytics importers can replace existing rows.
# Analytics detail tables reference dataset_contracts.
EMPTY_TABLES = (
    "user_behavior_events",
    "daily_item_metrics",
    "daily_category_metrics",
    "brands",
    "shops",
    "categories",
    "items",
    "dataset_contracts",
)


def prepare_release_fixture(connection: psycopg.Connection) -> dict:
    with connection.transaction():
        connection.execute("SET LOCAL TIME ZONE 'UTC'")
        tables = [sql.Identifier("commerce", name) for name in EMPTY_TABLES]
        connection.execute(
            sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE NOWAIT").format(
                sql.SQL(", ").join(tables)
            )
        )
        for table in tables:
            if connection.execute(sql.SQL("SELECT 1 FROM {} LIMIT 1").format(table)).fetchone():
                raise ValueError(f"Release fixture requires an empty table: {table.as_string()}")

        columns = ("user_id", "item_id", "category_id", "behavior_type", "event_ts", "source")
        events = synthetic_behavior_events(1000, 9, SEED, item_pool_size=1000, end_day=WINDOW_END)
        with (
            connection.cursor() as cursor,
            cursor.copy(
                sql.SQL("COPY commerce.user_behavior_events ({}) FROM STDIN").format(
                    sql.SQL(", ").join(map(sql.Identifier, columns))
                )
            ) as copy,
        ):
            for event in events:
                copy.write_row(tuple(event[column] for column in columns))

        master = synthetic_master_rows(derive_item_category(connection), SEED, WINDOW_START)
        upsert_master_rows(connection, master)
        rebuild_daily_aggregates(connection)
        analytics = synthetic_analytics_dataset(
            users=1000, items=1000, days=30, seed=SEED, end_day=WINDOW_END
        )
        replace_synthetic_analytics_dataset(connection, analytics)
        scan = scan_synthetic_analytics_dataset(connection, DEFAULT_ANALYTICS_DATASET_ID)
        if scan["issue_count"]:
            raise ValueError(f"Expanded analytics fixture failed quality checks: {scan['issues']}")

        required_metrics = (
            "orders_rows",
            "inventory_snapshots_rows",
            "price_experiment_observations_rows",
        )
        if any(scan["metrics"].get(metric, 0) <= 0 for metric in required_metrics):
            raise ValueError(
                "Missing orders, inventory or price observations for the release questions."
            )

        coverage = connection.execute("""
            SELECT min(stat_date) AS first_day, max(stat_date) AS last_day,
                   count(DISTINCT stat_date) AS days, count(DISTINCT category_id) AS categories
            FROM commerce.daily_category_metrics WHERE gmv > 0 AND buy > 0
        """).fetchone()
        if (
            coverage["first_day"] != WINDOW_START.date()
            or coverage["last_day"] != WINDOW_END.date()
            or coverage["days"] != 9
            or coverage["categories"] < 10
        ):
            raise ValueError(f"Missing sales coverage for the release questions: {coverage}")

        summary = {
            "source": "synthetic",
            "seed": SEED,
            **coverage,
            "dataset_id": DEFAULT_ANALYTICS_DATASET_ID,
            "analytics": scan["metrics"],
        }
    return summary


def main() -> None:
    if (
        os.getenv("GITHUB_ACTIONS") != "true"
        or os.getenv("RUNNER_ENVIRONMENT") != "github-hosted"
        or os.getenv("SHOPGATE_EVAL_TRIGGER") != "release"
    ):
        raise SystemExit("The release fixture requires a hosted release job.")
    raw_url = os.environ.get("DATABASE_URL", "")
    target = urlsplit(raw_url)
    if (
        target.scheme != "postgresql"
        or target.hostname != "127.0.0.1"
        or target.port != 35433
        or target.path != "/shopgate"
        or target.query != "schema=public"
        or target.fragment
    ):
        raise SystemExit("Expected the dedicated loopback database for release checks.")
    with psycopg.connect(database_url_from_env(), row_factory=dict_row) as connection:
        summary = prepare_release_fixture(connection)
    print(json.dumps(summary, default=str, ensure_ascii=False))


if __name__ == "__main__":
    main()
