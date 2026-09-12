#!/usr/bin/env python3
"""Validate explainable retail rules and metric consistency."""

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
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def read_json(source: str) -> dict[str, Any]:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def validate(data: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    rows = data.get("rows") or data.get("items") or data.get("products") or []
    if not isinstance(rows, list):
        raise ValueError("rows/items/products 必须是数组。")
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append(f"rows[{index}] 必须是对象。")
            continue
        pv = number(row.get("pv") or row.get("views"))
        buy = number(row.get("buy") or row.get("buys"))
        favorite = number(row.get("favorite") or row.get("favorites"))
        cart = number(row.get("cart") or row.get("carts"))
        if pv is not None and pv < 0 or buy is not None and buy < 0:
            errors.append(f"rows[{index}] 行为数量不能为负数。")
        if pv is not None and buy is not None and buy > pv:
            errors.append(f"rows[{index}] buy 不能大于 pv。")
        if pv is not None and favorite is not None and favorite > pv:
            errors.append(f"rows[{index}] favorite 不能大于 pv。")
        if pv is not None and cart is not None and cart > pv:
            errors.append(f"rows[{index}] cart 不能大于 pv。")
        price = number(row.get("price") or row.get("unit_price"))
        gmv = number(row.get("gmv"))
        if price is not None and buy is not None and gmv is not None and abs(gmv - price * buy) > max(0.01, abs(gmv) * 0.0001):
            errors.append(f"rows[{index}] gmv 与 buy×price 不一致。")
        if row.get("synthetic_price") is True:
            warnings.append(f"rows[{index}] 使用合成价格，GMV 只能作为估算，不得描述为真实成交金额。")
    if not rows:
        warnings.append("没有可校验的商品或日指标记录。")
    return {
        "ok": not errors,
        "dataset_id": data.get("dataset_id"),
        "checked_rows": len(rows),
        "errors": errors,
        "warnings": warnings,
        "rules": ["PV≥收藏/加购/购买", "购买量≤浏览量", "GMV=购买量×实际价格（价格缺失时不反推）"],
        "data_quality": "error" if errors else "warning" if warnings else "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 Shop Gate 零售行为、GMV 和库存规则。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("-o", "--output", help="输出 JSON 路径；不传则打印到 stdout。")
    args = parser.parse_args()
    try:
        payload = json.dumps(validate(read_json(args.input)), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(payload, encoding="utf-8")
        else:
            sys.stdout.write(payload)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"validate_retail_rules: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
