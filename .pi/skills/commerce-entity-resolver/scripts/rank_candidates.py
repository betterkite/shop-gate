#!/usr/bin/env python3
"""Resolve product/category candidates without unsupported business assumptions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]
KIND_ORDER = {"item": 0, "category": 1, "channel": 2, "campaign": 3}


def read_json(source: str) -> JsonRecord:
    text = source if source.lstrip().startswith("{") else sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def normalize(candidate: Any, index: int) -> JsonRecord:
    if not isinstance(candidate, dict):
        raise ValueError(f"candidate {index} 必须是对象。")
    entity_id = candidate.get("entity_id") or candidate.get("item_id") or candidate.get("category_id") or candidate.get("id")
    name = candidate.get("name") or candidate.get("title")
    kind = str(candidate.get("kind") or candidate.get("entity_type") or "item").strip().lower()
    if not isinstance(entity_id, str) or not entity_id.strip():
        raise ValueError(f"candidate {index}.entity_id 必须是非空字符串。")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"candidate {index}.name 必须是非空字符串。")
    if kind not in KIND_ORDER:
        raise ValueError(f"candidate {index}.kind 必须是 item/category/channel/campaign。")
    return {
        "entity_id": entity_id.strip(),
        "name": name.strip(),
        "kind": kind,
        "category": candidate.get("category"),
        "source": candidate.get("source") or "commerce-data",
    }


def resolve(request: JsonRecord) -> JsonRecord:
    query = request.get("query")
    results = request.get("results")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query 必须是非空字符串。")
    if not isinstance(results, list):
        raise ValueError("results 必须是数组。")
    candidates = [normalize(item, index) for index, item in enumerate(results)]
    query_value = query.strip().casefold()

    def priority(item: JsonRecord) -> tuple[int, int]:
        exact = item["name"].casefold() == query_value or item["entity_id"].casefold() == query_value
        return (0 if exact else 1, KIND_ORDER[item["kind"]])

    candidates.sort(key=lambda item: (*priority(item), item["name"], item["entity_id"]))
    if not candidates:
        return {"status": "not_found", "query": query.strip(), "selected": None, "clarification_candidates": []}
    top = candidates[0]
    same_priority = [item for item in candidates if priority(item) == priority(top)]
    ambiguous = len(same_priority) > 1
    return {
        "status": "ambiguous" if ambiguous else "resolved",
        "query": query.strip(),
        "selected": None if ambiguous else top,
        "clarification_candidates": same_priority if ambiguous else [],
        "candidate_count": len(candidates),
        "resolution_rule": "精确名称/标识优先，其次按实体类型优先；同优先级多个候选必须澄清。",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="为 Shop Gate 零售任务排序商品、类目和渠道候选。")
    parser.add_argument("--input", required=True, help="JSON 对象、JSON 文件路径或 -（stdin）。")
    args = parser.parse_args()
    try:
        print(json.dumps(resolve(read_json(args.input)), ensure_ascii=False, indent=2))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"rank_candidates: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
