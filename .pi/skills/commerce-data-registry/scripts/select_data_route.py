#!/usr/bin/env python3
"""Choose the smallest auditable Shop Gate retail endpoint for an operation."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]
DATASET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ITEM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

ROUTES = {
    "dataset_discovery": ("/api/v1/commerce/datasets", "发现可用数据集"),
    "dataset_meta": ("/api/v1/commerce/meta", "读取窗口、来源、行数和数据质量"),
    "overview": ("/api/v1/commerce/analytics/overview", "读取经营总览"),
    "funnel": ("/api/v1/commerce/analytics/funnel", "读取曝光、收藏、加购、购买漏斗"),
    "categories": ("/api/v1/commerce/analytics/categories", "读取类目结构与排名"),
    "inventory": ("/api/v1/commerce/analytics/inventory", "读取库存、动销和库销比"),
    "lifecycle": ("/api/v1/commerce/analytics/lifecycle", "读取商品经营阶段"),
    "price_elasticity": ("/api/v1/commerce/analytics/price-elasticity", "读取价格弹性与数据边界"),
    "profit": ("/api/v1/commerce/analytics/profit", "读取收入、成本和毛利"),
    "drilldown": ("/api/v1/commerce/analytics/drilldown", "读取可下钻的商品或类目证据"),
    "item_events": ("/api/v1/commerce/items/{item_id}/events", "读取单商品窗口内行为明细"),
}


def read_json(source: str) -> JsonRecord:
    text = source if source.lstrip().startswith("{") else sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("输入 JSON 必须是对象。")
    return value


def route(request: JsonRecord) -> JsonRecord:
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in ROUTES:
        raise ValueError(f"operation 必须是以下之一：{', '.join(ROUTES)}")
    endpoint, purpose = ROUTES[operation]

    dataset_id = request.get("dataset_id")
    if operation != "dataset_discovery":
        if not isinstance(dataset_id, str) or not DATASET_ID.fullmatch(dataset_id):
            raise ValueError("除 dataset_discovery 外，dataset_id 必须是安全的数据集标识。")
        endpoint = f"{endpoint}?dataset_id={dataset_id}"

    item_id = request.get("item_id")
    if operation == "item_events":
        if not isinstance(item_id, str) or not ITEM_ID.fullmatch(item_id):
            raise ValueError("item_events 必须提供安全的 item_id。")
        endpoint = endpoint.format(item_id=item_id)

    return {
        "status": "selected",
        "operation": operation,
        "dataset_id": dataset_id if isinstance(dataset_id, str) else None,
        "item_id": item_id if isinstance(item_id, str) else None,
        "decision": "local_retail_analytics",
        "endpoint": endpoint,
        "purpose": purpose,
        "next_skill": "commerce-market-data" if operation in {"overview", "funnel", "categories", "inventory", "lifecycle", "price_elasticity", "profit", "drilldown", "item_events"} else "commerce-data-registry",
        "evidence_required": ["dataset_id", "source", "as_of", "fetched_at", "row_count", "data_quality"],
        "external_provider_allowed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="为 Shop Gate 零售任务选择可审计的数据端点。")
    parser.add_argument("--input", required=True, help="JSON 对象、JSON 文件路径或 -（stdin）。")
    args = parser.parse_args()
    try:
        print(json.dumps(route(read_json(args.input)), ensure_ascii=False, indent=2))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"select_data_route: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
