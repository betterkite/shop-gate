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


def aggregation_description(metric: str) -> str:
    if metric == "contribution_profit":
        return (
            "按所选范围汇总金额后计算差额。成本净额和费用允许负调整，"
            "经营贡献利润可能高于净销售额，不能假定它一定更小。"
            "完整利润与已核算范围贡献都计入同范围的未分摊已知费用，"
            "不能把两者的差异归因于未分摊费用"
        )
    if metric == "accounted_contribution":
        return (
            "按已具备完整依据的记录汇总金额，再计入相应已知费用；"
            "同范围未分摊已知费用只计入一次，完整利润也会计入。"
            "有核算缺项时，完整利润可能未知，本指标只代表已核算部分"
        )
    if metric == "order_count":
        return "在所选范围内按订单去重，同一订单只计一次；不同分组的订单数不能直接相加"
    if metric == "standard_quantity":
        return "只汇总相同标准单位的数量，不把不同单位直接相加"
    if metric in {"average_order_value", "contribution_margin", "refund_ratio", "coverage_ratio"}:
        return "先分别汇总所选范围的分子与分母，再相除；不平均各条明细或各分组的比率"
    return "按所选范围汇总金额；明细已处理退款、成本冲回与费用分摊，不重复计入"


def metric_catalog() -> list[dict]:
    return [
        {
            "id": key,
            "name": value[0],
            "unit": value[1],
            "formula": value[2],
            "missing_policy": value[3],
            "dimensions": sorted(DIMENSIONS),
            "source": "订单及付款记录、已完成退款记录、历史成本与费用分摊记录",
            "aggregation": aggregation_description(key),
        }
        for key, value in METRICS.items()
    ]
