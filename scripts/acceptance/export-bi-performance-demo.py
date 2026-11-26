"""Export the fixed synthetic 100k-order acceptance case as seven importable batches."""

import argparse
import json
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory

from shopgate_commerce_data.ledger.csv_contract import (
    MAX_BATCH_BYTES,
    MAX_BATCH_ROWS,
    MAX_FILE_BYTES,
    standard_csv,
)
from shopgate_commerce_data.ledger.demo import DemoPlan, generate_demo


def export(destination: Path):
    if destination.exists():
        raise ValueError("输出目录已存在，请选择一个新目录。")
    plan = DemoPlan(seed=70819, start_date="2026-01-01", days=180, sku_count=1000,
                    order_count=100000)
    generated = generate_demo(plan)
    records = generated["records"]
    orders = {row["order_id"]: i // 15000 for i, row in enumerate(records["orders"])}
    lines = {row["line_id"]: orders[row["order_id"]] for row in records["order_lines"]}
    batches = [defaultdict(list) for _ in range(max(orders.values()) + 1)]
    for table, inputs in records.items():
        for row in inputs:
            if table in ("orders", "order_lines"):
                bucket = orders[row["order_id"]]
            elif table == "refunds":
                bucket = lines[row["line_id"]]
            elif table == "expenses":
                bucket = lines[row["line_id"]] if row.get("line_id") else len(batches) - 1
            else:
                bucket = 0
            batches[bucket][table].append(row)

    destination.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=destination.parent) as temporary:
        output = Path(temporary) / "demo"
        output.mkdir()
        for i, batch in enumerate(batches, 1):
            folder = output / f"batch-{i}"
            folder.mkdir()
            if sum(map(len, batch.values())) > MAX_BATCH_ROWS:
                raise ValueError("生成记录超过单批行数上限。")
            size = 0
            for table, rows in batch.items():
                data = standard_csv(table, rows)
                if len(data) > MAX_FILE_BYTES:
                    raise ValueError("生成文件超过标准文件上限。")
                size += len(data)
                (folder / f"{table}.csv").write_bytes(data)
            if size > MAX_BATCH_BYTES:
                raise ValueError("生成文件超过单批大小上限。")
        manifest = {**generated["manifest"], "import_batches": len(batches)}
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        output.rename(destination)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="输出 180 天、1000 个规格、10 万张订单的模拟数据。")
    parser.add_argument("destination", type=Path)
    try:
        manifest = export(parser.parse_args().destination)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")
    print(f"已输出 {manifest['import_batches']} 批，内容摘要 {manifest['content_hash']}")
