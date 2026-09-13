#!/usr/bin/env python3
"""Assess whether a retail task is missing execution-critical information."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ENTITY_CODE_PATTERN = re.compile(r"(?:item|cat|channel|campaign|user):[A-Za-z0-9_-]+", re.I)
RETAIL_KEYWORDS = re.compile(
    r"商品|货品|SKU|类目|品类|渠道|活动|用户|客户|数据集|浏览|PV|UV|收藏|加购|购买|订单|成交总额|GMV|转化|库存|库销比|补货|利润|毛利|留存|生命周期|价格|看板|经营|分析|销量",
    re.I,
)
GOAL_KEYWORDS = re.compile(
    r"对比|比较|排名|趋势|诊断|看板|分析|明细|转化|库存|补货|利润|毛利|留存|生命周期|价格|弹性|分群|日报|怎么|如何|哪些|多少",
    re.I,
)
COMPARISON = re.compile(r"对比|比较|排名|最高|最低|最好|最差|前\s*\d+|后\s*\d+", re.I)
GENERIC_WORDS = {
    "商品",
    "货品",
    "类目",
    "品类",
    "渠道",
    "活动",
    "用户",
    "客户",
    "数据集",
    "看板",
    "页面",
    "分析",
    "比较",
    "对比",
    "一些商品",
    "几个商品",
}


def clean_candidate(value: str) -> str | None:
    candidate = re.sub(r"\s+", "", value)
    candidate = re.sub(
        r"^(请|麻烦|帮我|帮忙|分析|查询|查看|看看|研究|诊断|评估|生成|做一个|做下|比较|对比|一下)+",
        "",
        candidate,
    )
    candidate = re.sub(
        r"(商品|货品|SKU|类目|品类|渠道|活动|用户|客户)?"
        r"(最近|近期|近|这段时间|的|数据|表现|情况|怎么样|如何|怎么|看板|页面).*$",
        "",
        candidate,
        flags=re.I,
    )
    if len(candidate) < 2 or len(candidate) > 24 or candidate in GENERIC_WORDS:
        return None
    return candidate


def entity_candidates(question: str) -> list[str]:
    result: list[str] = ENTITY_CODE_PATTERN.findall(question.strip())
    parts = re.split(r"[，。！？?；;、,：:\n\r]|(?:和)|(?:与)|(?:及)|(?:以及)", question)
    for raw in parts:
        candidate = clean_candidate(raw)
        if candidate and candidate not in result:
            result.append(candidate)
    return result[:8]


def build_questions(missing: list[str], comparison: bool) -> list[str]:
    questions: list[str] = []
    if "entity" in missing:
        questions.append("请告诉我商品、类目、渠道、活动或用户分群范围。")
    if "comparison_scope" in missing:
        questions.append("要比较哪些商品、类目、渠道或活动？请至少提供两个范围。")
    if "analysis_goal" in missing:
        questions.append(
            "你更想看趋势、转化、库存、利润、留存，还是商品明细？"
            if not comparison
            else "你想按浏览量、购买量、成交总额、转化率还是库存比较？"
        )
    return questions[:3]


def assess(question: str, capability: str | None = None) -> dict[str, Any]:
    text = " ".join(question.split())
    if not text or not (RETAIL_KEYWORDS.search(text) or capability):
        return {
            "required": False,
            "reason": "当前请求不需要零售经营数据规划。",
            "missing": [],
            "questions": [],
            "confidence": 0.9,
        }

    candidates = entity_candidates(text)
    has_entity = bool(candidates)
    is_comparison = bool(COMPARISON.search(text))
    has_goal = bool(GOAL_KEYWORDS.search(text))
    missing: list[str] = []
    if not has_entity and not has_goal:
        missing.append("entity")
    if is_comparison and len(candidates) < 2 and not re.search(r"全店|全量|全部|所有|整体", text):
        missing.append("comparison_scope")
    if has_entity and not has_goal:
        missing.append("analysis_goal")
    unique_missing = list(dict.fromkeys(missing))
    return {
        "required": bool(unique_missing),
        "reason": (
            f"任务缺少关键输入：{', '.join(unique_missing)}。"
            if unique_missing
            else "任务意图足够明确，可进入零售数据、证据和看板流程。"
        ),
        "missing": unique_missing,
        "questions": build_questions(unique_missing, is_comparison),
        "confidence": 0.82 if unique_missing else 0.86,
        "target_candidates": candidates,
    }


def load_json_input(value: str) -> dict[str, Any]:
    """Load a JSON object from a literal, a file path, or stdin."""

    raw = sys.stdin.read() if value == "-" else value
    if value != "-":
        candidate = Path(value)
        try:
            if candidate.is_file():
                raw = candidate.read_text(encoding="utf-8")
        except OSError:
            pass
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("--input 必须解析为 JSON 对象")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--question", help="用户问题")
    source.add_argument("--input", help="JSON 对象、JSON 文件路径或 -")
    parser.add_argument("--capability", default=None, help="可选的零售能力 ID")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        payload = load_json_input(args.input) if args.input is not None else {}
        question = payload.get("question", args.question)
        capability = payload.get("capability", args.capability)
        if not isinstance(question, str) or not question.strip():
            raise ValueError("question 必须是非空字符串")
        if capability is not None and not isinstance(capability, str):
            raise ValueError("capability 必须是字符串或 null")
        result = assess(question, capability)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
