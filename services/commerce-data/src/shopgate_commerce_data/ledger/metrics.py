"""Controlled public metric dictionary. Never accepts model-provided formulas or SQL."""

DIMENSIONS = frozenset(
    {"overall", "day", "week", "channel", "store", "product", "sku", "listing", "order", "line"}
)
METRICS = {
    "sales_amount": (
        "付款成交金额",
        "元",
        "付款订单行实收×付款时汇率，逐行四舍五入到分",
        "缺汇率未知",
    ),
    "refund_amount": (
        "已完成退款金额",
        "元",
        "原付款汇率换算，按原行累计舍入后分配到退款事件",
        "缺原付款汇率未知",
    ),
    "net_sales": ("净销售额", "元", "付款成交金额－已完成退款金额", "任一输入未知则未知"),
    "order_count": ("付款订单数", "笔", "所选范围付款订单ID去重", "没有付款订单为0"),
    "average_order_value": ("付款客单价", "元/笔", "付款成交金额÷付款订单数", "零订单未知"),
    "standard_quantity": (
        "标准单位销量",
        "标准单位",
        "付款数量×付款时映射倍数",
        "缺映射未知；不同标准单位不混加",
    ),
    "product_cost": (
        "商品成本净额",
        "元",
        "付款历史成本－可回收退货及有未发货证据的取消成本冲回",
        "缺成本/映射/汇率未知",
    ),
    "expense_amount": (
        "已知经营费用",
        "元",
        "精确分摊及未分摊费用，保留负调整",
        "缺汇率费用另列，完整费用未知",
    ),
    "contribution_profit": (
        "经营贡献利润",
        "元",
        "净销售额－商品成本净额－经营费用",
        "缺任一核算输入则未知；不含未接入固定支出",
    ),
    "accounted_contribution": (
        "已核算范围贡献金额",
        "元",
        "完整订单行收入退款成本及已知费用；未分摊已知费用单列承担",
        "不是全范围净利润；未知费用数另列",
    ),
    "contribution_margin": (
        "经营贡献利润率",
        "%",
        "经营贡献利润÷净销售额",
        "零/负净销售额或利润未知则未知",
    ),
    "refund_ratio": (
        "退款金额占付款金额比",
        "%",
        "归属原付款订单的退款÷同范围付款金额",
        "退款发生日口径无适当分母，返回未知",
    ),
    "accounted_revenue": (
        "已核算订单成交金额",
        "元",
        "历史成本和收入均完整的订单行成交金额",
        "覆盖范围不是当前页",
    ),
    "coverage_ratio": (
        "成交金额核算覆盖率",
        "%",
        "已核算订单成交金额÷全部付款成交金额",
        "零/未知成交金额无比例",
    ),
}


def metric_catalog() -> list[dict]:
    return [
        {
            "id": key,
            "name": value[0],
            "unit": value[1],
            "formula": value[2],
            "missing_policy": value[3],
            "dimensions": sorted(DIMENSIONS),
            "source": "bi订单/付款快照、已完成退款、历史费用分摊",
            "aggregation": "分子分母先按全范围合计，最后计算比例，不平均单行比率",
        }
        for key, value in METRICS.items()
    ]
