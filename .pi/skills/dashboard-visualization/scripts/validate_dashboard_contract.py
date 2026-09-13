#!/usr/bin/env python3
"""Validate a Shop Gate retail dashboard-data contract without mutating it."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


DATA_KEYS = (
    "kpis",
    "daily",
    "items",
    "categories",
    "channels",
    "inventory",
    "profit",
    "lifecycle",
    "retention",
    "price_experiment",
)
FORBIDDEN_MARKERS = re.compile(r"MOCK_DATA|SAMPLE_DATA|STATIC_QUOTES", re.IGNORECASE)
SECRET_KEYS = re.compile(r"token|api[_-]?key|cookie|authorization|password|secret", re.IGNORECASE)


def read_json(source: str) -> Any:
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        return json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取合法 JSON：{exc}") from exc


def records(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        yield from (item for item in value if isinstance(item, dict))


def collect_entities(payload: dict[str, Any]) -> set[str]:
    entities: set[str] = set()
    for key in ("items", "categories", "channels"):
        for row in records(payload.get(key)):
            for field in ("item_id", "category_id", "channel", "id", "name"):
                value = row.get(field)
                if isinstance(value, str) and value.strip():
                    entities.add(value.strip())
    return entities


def scan_forbidden(value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if SECRET_KEYS.search(str(key)) and isinstance(child, str) and child.strip():
                errors.append(f"发现疑似敏感值：{child_path}")
            errors.extend(scan_forbidden(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(scan_forbidden(child, f"{path}[{index}]"))
    elif isinstance(value, str) and FORBIDDEN_MARKERS.search(value):
        errors.append(f"发现示例或静态数据标记：{path}")
    return errors


def validate(payload: Any, expected_template: str | None) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return {"ok": False, "errors": ["根节点必须是对象"]}

    if not any(payload.get(key) not in (None, [], {}) for key in DATA_KEYS):
        errors.append("没有非空的零售数据区")

    dataset_id = payload.get("dataset_id")
    if not isinstance(dataset_id, str) or not dataset_id.strip():
        errors.append("dataset_id 必须存在")
    if not isinstance(payload.get("source"), str) or not payload["source"].strip():
        errors.append("source 必须存在")

    visualization = payload.get("visualization")
    if not isinstance(visualization, dict):
        errors.append("visualization 必须是对象")
        visualization = {}
    template = visualization.get("template_id") or visualization.get("templateId")
    if not isinstance(template, str) or not template.strip():
        errors.append("visualization.template_id 必须存在")
    elif expected_template and template != expected_template:
        errors.append(f"模板不一致：期望 {expected_template}，实际 {template}")

    required = visualization.get("required_components")
    rendered = visualization.get("rendered_components")
    missing = visualization.get("missing_components")
    if isinstance(required, list) and isinstance(rendered, list):
        required_set = {item for item in required if isinstance(item, str)}
        accounted = {item for item in rendered if isinstance(item, str)}
        if isinstance(missing, list):
            accounted.update(item for item in missing if isinstance(item, str))
        unaccounted = sorted(required_set - accounted)
        if unaccounted:
            errors.append(f"必备组件没有说明：{unaccounted}")

    errors.extend(scan_forbidden(payload))
    return {
        "ok": not errors,
        "dataset_id": dataset_id,
        "template_id": template,
        "entities": sorted(collect_entities(payload)),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="看板 JSON 路径，或使用 - 从标准输入读取")
    parser.add_argument("--expected-template")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        result = validate(read_json(args.input), args.expected_template)
    except ValueError as exc:
        result = {"ok": False, "errors": [str(exc)]}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
