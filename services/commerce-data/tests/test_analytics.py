"""P28 经营分析的可解释规则单测。"""

from datetime import date

from shopgate_commerce_data.analytics import (
    classify_lifecycle_stage,
    classify_rfm,
    inventory_health_label,
)


def test_rfm_labels_are_user_facing_and_stable() -> None:
    assert classify_rfm(30, 8, 1000, 800) == "流失风险"
    assert classify_rfm(5, 6, 1000, 800) == "高价值"
    assert classify_rfm(7, 1, 30, 800) == "新近购买"
    assert classify_rfm(10, 2, 200, 800) == "稳定复购"


def test_inventory_health_labels_explain_stock_state() -> None:
    assert inventory_health_label(0, 2, 0) == "缺货风险"
    assert inventory_health_label(100, 0, 10000) == "有库存但无销量"
    assert inventory_health_label(1000, 10, 100) == "库存积压"
    assert inventory_health_label(20, 5, 4) == "库存正常"


def test_lifecycle_stage_rules_are_user_facing_and_stable() -> None:
    window_start = date(2025, 11, 4)
    window_end = date(2025, 12, 3)
    assert classify_lifecycle_stage(window_start, window_end, None, None)[0] == "未启动"
    assert classify_lifecycle_stage(
        window_start, window_end, date(2025, 11, 25), date(2025, 12, 3)
    )[0] == "成长期"
    assert classify_lifecycle_stage(
        window_start, window_end, date(2025, 11, 4), date(2025, 11, 26)
    )[0] == "稳定期"
    assert classify_lifecycle_stage(
        window_start, window_end, date(2025, 11, 4), date(2025, 11, 10)
    )[0] == "衰退风险"
