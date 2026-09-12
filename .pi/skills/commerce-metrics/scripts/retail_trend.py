#!/usr/bin/env python3
"""Summarize daily retail metrics without inventing missing days."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def read_json(source: str) -> dict[str, Any]:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def build(data: dict[str, Any]) -> dict[str, Any]:
    daily = data.get("daily") or data.get("daily_metrics") or data.get("trend") or []
    if not isinstance(daily, list):
        raise ValueError("daily/daily_metrics/trend 必须是数组。")
    rows = []
    for index, row in enumerate(daily):
        if not isinstance(row, dict):
            raise ValueError(f"第 {index} 条日指标必须是对象。")
        rows.append({
            "date": row.get("date") or row.get("event_date"),
            "pv": number(row.get("pv") or row.get("views")),
            "uv": number(row.get("uv") or row.get("visitors")),
            "cart": number(row.get("cart") or row.get("carts")),
            "buy": number(row.get("buy") or row.get("buys")),
            "gmv": number(row.get("gmv")),
        })
    rows.sort(key=lambda row: str(row["date"] or ""))
    return {
        "method": "retail_daily_trend_v1",
        "dataset_id": data.get("dataset_id"),
        "rows": rows,
        "metrics": ["pv", "uv", "cart", "buy", "gmv"],
        "data_quality": {"status": "warning" if not rows else "ok", "warnings": ["没有日指标数据。"] if not rows else []},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 Shop Gate 零售日趋势摘要。")
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
        print(f"retail_trend: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
