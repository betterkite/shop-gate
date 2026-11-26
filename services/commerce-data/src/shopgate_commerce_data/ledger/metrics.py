"""Controlled public metric dictionary. Never accepts model-provided formulas or SQL."""

REFUND_TYPES = {"refund_only": "仅退款", "return": "退货退款", "unshipped_cancel": "未发货取消"}
REFUND_MEASURES = frozenset({
    "refund_amount", "refund_event_count", "refund_order_count", "refund_cost_recovery",
})
REFUND_DIMENSIONS = frozenset({"refund_event", "refund_reason", "refund_type"})

DIMENSIONS = frozenset(
    {"overall", "day", "week", "channel", "store", "product", "sku", "listing", "order", "line"}
) | REFUND_DIMENSIONS
FEE_LABELS = {"platform": "平台费用", "packaging": "包装费用", "logistics": "物流费用",
              "advertising": "广告费用", "other": "其他费用"}
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
        "按付款时有效的店铺、平台、基础成本依次取用，再扣除可回收退货及已证实取消的冲回",
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
    "selling_channels": ("发生付款的平台数", "个", "按付款明细的平台编号去重", "无付款时为零"),
    "selling_stores": ("发生付款的店铺数", "家", "按付款明细的店铺编号去重", "无付款时为零"),
    "average_unit_price": (
        "平均单位售价", "元/标准单位", "付款成交金额除以对应标准销量",
        "成交金额或换算数量未知、单位混合或没有销量时待核算",
    ),
    "weighted_unit_cost": (
        "历史加权单位成本", "元/标准单位", "付款时已知的原始商品成本除以对应的标准销量",
        "只使用已有历史成本和换算依据的明细，缺少依据或单位混合时待核算",
    ),
    "costed_quantity": (
        "有成本依据的标准销量", "标准单位", "仅汇总同时有付款时成本与标准数量的付款明细",
        "不同标准单位不能相加",
    ),
    **{f"{kind}_expense": (label, "元", "本范围承担的此类费用，保留负数调减",
                           "此类费用缺汇率或未确定归属时未知")
       for kind, label in FEE_LABELS.items()},
    "refund_event_count": ("已完成退款笔数", "笔", "逐笔统计已完成退款事件", "无事件时为零"),
    "refund_order_count": ("发生退款的订单数", "笔", "按已完成退款的原始订单去重", "无事件时为零"),
    "refund_cost_recovery": (
        "退款冲回的商品成本", "元", "按原始成本快照合计可回收退货与未发货取消的成本冲回",
        "仅退款不冲回成本，缺少必要快照时完整金额未知",
    ),
    "known_unallocated_expenses": (
        "已知未分摊费用", "元", "单列在本范围的未分摊来源费用中已折算的金额",
        "尚不能换算的部分另列，不分配给具体商品",
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
    if metric == "refund_order_count":
        return "按所选退款的原订单去重，不可将不同退款原因或类型的订单数直接相加"
    if metric == "refund_event_count":
        return "只计已完成的退款，每个退款编号计一次"
    if metric == "order_count":
        return "在所选范围内按订单去重，同一订单只计一次；不同分组的订单数不能直接相加"
    if metric in {"selling_channels", "selling_stores"}:
        return "在当前付款明细范围内去重，各分组数量不能直接相加"
    if metric in {"standard_quantity", "costed_quantity"}:
        return "只汇总相同标准单位的数量，不把不同单位直接相加"
    if metric in {"average_unit_price", "weighted_unit_cost"}:
        return "以相同标准单位的销量作为权重，从原始付款明细重新计算"
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
            "dimensions": sorted(
                DIMENSIONS if key in REFUND_MEASURES else DIMENSIONS - REFUND_DIMENSIONS
            ),
            "source": "订单及付款记录、已完成退款记录、历史成本与费用分摊记录",
            "aggregation": aggregation_description(key),
        }
        for key, value in METRICS.items()
    ]
