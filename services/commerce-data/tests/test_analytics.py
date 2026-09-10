"""P28 经营分析的可解释规则单测。"""

from shopgate_commerce_data.analytics import classify_rfm, inventory_health_label


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
