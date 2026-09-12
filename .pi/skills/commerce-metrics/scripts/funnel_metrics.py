#!/usr/bin/env python3
"""Compute deterministic retail funnel and conversion metrics."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


EVENTS = ("view", "favorite", "cart", "buy")


def read_json(source: str) -> dict[str, Any]:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def count_events(data: dict[str, Any]) -> Counter[str]:
    events = data.get("events") or data.get("behavior_events") or []
    if not isinstance(events, list):
        raise ValueError("events/behavior_events 必须是数组。")
    counts: Counter[str] = Counter()
    for event in events:
        if isinstance(event, dict):
            kind = event.get("event_type") or event.get("event") or event.get("type")
            if kind in EVENTS:
                counts[kind] += 1
    return counts


def build(data: dict[str, Any]) -> dict[str, Any]:
    counts = count_events(data)
    values = [counts[event] for event in EVENTS]
    conversion = counts["buy"] / counts["view"] if counts["view"] else None
    return {
        "method": "retail_event_funnel_v1",
        "dataset_id": data.get("dataset_id"),
        "stages": [{"event": event, "count": counts[event]} for event in EVENTS],
        "conversion": {
            "view_to_buy": round(conversion, 6) if conversion is not None else None,
            "cart_to_buy": round(counts["buy"] / counts["cart"], 6) if counts["cart"] else None,
        },
        "data_quality": {
            "status": "warning" if not values or not counts["view"] else "ok",
            "warnings": ["没有浏览事件，无法计算购买转化率。"] if not counts["view"] else [],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="计算 Shop Gate 零售行为漏斗和转化率。")
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
        print(f"funnel_metrics: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
