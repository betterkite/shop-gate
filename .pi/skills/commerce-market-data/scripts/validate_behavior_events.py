#!/usr/bin/env python3
"""Validate windowed retail behavior events and funnel ordering."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]
EVENTS = ("view", "favorite", "cart", "buy")


def read_json(source: str) -> JsonRecord:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def extract_events(data: JsonRecord) -> list[JsonRecord]:
    events = data.get("events") or data.get("behavior_events") or data.get("items")
    if not isinstance(events, list):
        raise ValueError("输入必须包含 events、behavior_events 或 items 数组。")
    if any(not isinstance(event, dict) for event in events):
        raise ValueError("每条行为事件必须是对象。")
    return events


def validate(data: JsonRecord) -> JsonRecord:
    events = extract_events(data)
    errors: list[str] = []
    warnings: list[str] = []
    counts = Counter()
    dataset_id = data.get("dataset_id")
    for index, event in enumerate(events):
        kind = event.get("event_type") or event.get("event") or event.get("type")
        if kind not in EVENTS:
            errors.append(f"events[{index}] 的 event_type 必须是 {', '.join(EVENTS)}。")
            continue
        counts[kind] += 1
        if not event.get("item_id"):
            errors.append(f"events[{index}] 缺少 item_id。")
        if not event.get("occurred_at") and not event.get("event_date") and not event.get("date"):
            errors.append(f"events[{index}] 缺少 occurred_at/event_date。")
        if dataset_id is not None and event.get("dataset_id") not in (None, dataset_id):
            errors.append(f"events[{index}] 的 dataset_id 与输入不一致。")

    ordered_counts = [counts[event] for event in EVENTS]
    if not all(left >= right for left, right in zip(ordered_counts, ordered_counts[1:], strict=False)):
        warnings.append("事件总量未满足 view≥favorite≥cart≥buy；请检查窗口口径，不能把漏斗顺序当作真实事实。")
    if not events:
        warnings.append("窗口内没有行为事件，经营指标只能返回空状态。")
    return {
        "ok": not errors,
        "dataset_id": dataset_id,
        "event_count": len(events),
        "event_counts": dict(counts),
        "funnel_order": list(EVENTS),
        "errors": errors,
        "warnings": warnings,
        "data_quality": "error" if errors else "warning" if warnings else "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 Shop Gate 零售行为事件和漏斗顺序。")
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
        print(f"validate_behavior_events: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
