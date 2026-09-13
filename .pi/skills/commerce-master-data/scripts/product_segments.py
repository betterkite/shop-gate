#!/usr/bin/env python3
"""Build deterministic product operating segments from retail master data."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None


def read_json(source: str) -> JsonRecord:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def products(data: JsonRecord) -> list[JsonRecord]:
    rows = data.get("products") or data.get("items") or data.get("rows")
    if not isinstance(rows, list):
        raise ValueError("输入必须包含 products、items 或 rows 数组。")
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("每个商品记录必须是对象。")
    return rows


def segment(row: JsonRecord, index: int) -> JsonRecord:
    item_id = str(row.get("item_id") or row.get("id") or f"item-{index + 1}")
    name = str(row.get("name") or row.get("title") or item_id)
    views = number(row.get("views") or row.get("pv")) or 0
    buys = number(row.get("buys") or row.get("purchase_count") or row.get("orders")) or 0
    stock = number(row.get("stock") or row.get("inventory"))
    price = number(row.get("price") or row.get("unit_price"))
    conversion = buys / views if views > 0 else 0.0
    if views == 0 and buys == 0:
        stage = "未启动"
    elif buys == 0:
        stage = "成长期"
    elif stock is not None and stock <= buys * 2:
        stage = "成熟期"
    elif conversion >= 0.03:
        stage = "成熟期"
    else:
        stage = "衰退期"
    return {
        "item_id": item_id,
        "name": name,
        "category": row.get("category"),
        "stage": stage,
        "metrics": {
            "views": round(views, 4),
            "buys": round(buys, 4),
            "conversion_rate": round(conversion, 6),
            "stock": round(stock, 4) if stock is not None else None,
            "price": round(price, 4) if price is not None else None,
        },
        "rule": "按窗口内浏览、购买、转化率和可售库存判断，仅用于经营分组，不替代人工判断。",
    }


def build_segments(data: JsonRecord) -> JsonRecord:
    rows = [segment(row, index) for index, row in enumerate(products(data))]
    stage_counts: dict[str, int] = {}
    for row in rows:
        stage_counts[row["stage"]] = stage_counts.get(row["stage"], 0) + 1
    return {
        "method": "retail_product_operating_segments_v1",
        "dataset_id": data.get("dataset_id"),
        "rows": rows,
        "stage_counts": stage_counts,
        "data_quality": {"status": "ok", "warnings": []},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="从零售商品主数据生成经营阶段分组。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("-o", "--output", help="输出 JSON 路径；不传则打印到 stdout。")
    args = parser.parse_args()
    try:
        payload = json.dumps(build_segments(read_json(args.input)), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(payload, encoding="utf-8")
        else:
            sys.stdout.write(payload)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"product_segments: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
