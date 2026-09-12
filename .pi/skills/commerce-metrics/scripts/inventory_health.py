#!/usr/bin/env python3
"""Compute retail inventory health and stock-to-sales indicators."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None


def read_json(source: str) -> dict[str, Any]:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def build(data: dict[str, Any]) -> dict[str, Any]:
    source = data.get("items") or data.get("products") or data.get("rows") or []
    if not isinstance(source, list):
        raise ValueError("items/products/rows 必须是数组。")
    rows = []
    for index, item in enumerate(source):
        if not isinstance(item, dict):
            raise ValueError(f"商品记录 {index} 必须是对象。")
        stock = number(item.get("stock") or item.get("inventory"))
        sales = number(item.get("sales") or item.get("buys") or item.get("purchase_count")) or 0
        ratio = stock / sales if stock is not None and sales > 0 else None
        status = "缺少库存" if stock is None else "无销量" if sales == 0 else "需关注" if ratio is not None and ratio >= 30 else "健康"
        rows.append({
            "item_id": item.get("item_id") or item.get("id") or f"item-{index + 1}",
            "name": item.get("name") or item.get("title") or f"商品 {index + 1}",
            "stock": stock,
            "sales": sales,
            "stock_to_sales": round(ratio, 4) if ratio is not None else None,
            "status": status,
        })
    return {
        "method": "retail_inventory_health_v1",
        "dataset_id": data.get("dataset_id"),
        "rows": rows,
        "attention_count": sum(row["status"] in {"需关注", "无销量", "缺少库存"} for row in rows),
        "rule": "库销比=库存÷窗口购买量；无购买时不把库销比写成 0。",
        "data_quality": {"status": "ok", "warnings": []},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="计算 Shop Gate 零售库存健康和库销比。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("-o", "--output", help="输出 JSON 路径；不传则打印到 stdout。")
    args = parser.parse_args()
    try:
        payload = json.dumps(build(read_json(args.input)), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(payload, encoding="utf-8")
        else:
            sys.stdout.write(payload)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"inventory_health: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
