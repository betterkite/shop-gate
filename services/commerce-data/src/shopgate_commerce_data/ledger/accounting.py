"""One exact accounting engine for pages, exports and controlled Agent tools."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, localcontext

from shopgate_commerce_data.ledger.precision import exact_decimal

ZERO = Decimal(0)
CENT = Decimal("0.01")


def money(value: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = 80
        return exact_decimal(value.quantize(CENT, rounding=ROUND_HALF_UP), "money")


def ratio(numerator: Decimal | None, denominator: Decimal | None) -> Decimal | None:
    if numerator is None or denominator is None or denominator <= 0:
        return None
    with localcontext() as context:
        context.prec = 80
        return (numerator / denominator).quantize(Decimal("0.00000001"), ROUND_HALF_UP)


def growth(current: Decimal | None, previous: Decimal | None) -> Decimal | None:
    return ratio(None if current is None or previous is None else current - previous, previous)


@dataclass(frozen=True)
class Mapping:
    mapping_id: str
    sku_id: str
    multiplier: Decimal
    valid_from: datetime
    valid_to: datetime | None = None


@dataclass(frozen=True)
class Cost:
    cost_id: str
    sku_id: str
    level: str
    unit_cost: Decimal
    currency: str
    valid_from: datetime
    valid_to: datetime | None = None
    channel_id: str | None = None
    store_id: str | None = None


@dataclass(frozen=True)
class Snapshot:
    mapping_id: str | None
    sku_id: str | None
    unit_multiplier: Decimal | None
    standard_quantity: Decimal | None
    cost_id: str | None
    unit_cost: Decimal | None
    revenue_fx_rate: Decimal | None
    cost_fx_rate: Decimal | None
    revenue_cny: Decimal | None
    cost_cny: Decimal | None
    missing: tuple[str, ...]

    @property
    def status(self) -> str:
        return self.missing[0] if self.missing else "complete"


def in_interval(at: datetime, start: datetime, end: datetime | None) -> bool:
    if at.tzinfo is None or start.tzinfo is None or end is not None and end.tzinfo is None:
        raise ValueError("经营时间必须包含时区。")
    return start <= at and (end is None or at < end)


def choose_mapping(at: datetime, mappings: list[Mapping]) -> Mapping | None:
    matches = [row for row in mappings if in_interval(at, row.valid_from, row.valid_to)]
    if len(matches) > 1:
        raise ValueError("映射生效区间不唯一，不能任选一条。")
    return matches[0] if matches else None


def choose_cost(
    at: datetime, sku_id: str, channel_id: str, store_id: str, costs: list[Cost]
) -> Cost | None:
    ranks = {"base": 1, "channel": 2, "store": 3}
    matches = []
    for row in costs:
        if row.level not in ranks:
            raise ValueError("成本层级无效。")
        if row.sku_id != sku_id or not in_interval(at, row.valid_from, row.valid_to):
            continue
        if row.level == "channel" and row.channel_id != channel_id:
            continue
        if row.level == "store" and (row.store_id != store_id or row.channel_id != channel_id):
            continue
        matches.append(row)
    if not matches:
        return None
    rank = max(ranks[row.level] for row in matches)
    preferred = [row for row in matches if ranks[row.level] == rank]
    if len(preferred) != 1:
        raise ValueError("同层成本生效区间不唯一。")
    return preferred[0]


def make_snapshot(
    *,
    paid_at: datetime,
    quantity: Decimal,
    paid_amount: Decimal,
    currency: str,
    channel_id: str,
    store_id: str,
    mappings: list[Mapping],
    costs: list[Cost],
    rates: dict[str, Decimal],
    payment_fx_rate: Decimal | None = None,
) -> Snapshot:
    quantity = exact_decimal(quantity, "quantity")
    paid_amount = exact_decimal(paid_amount, "money")
    if quantity <= 0 or paid_amount < 0:
        raise ValueError("付款数量必须为正，实收不能为负。")
    # Identity for actual CNY is not an invented foreign exchange rate.
    revenue_rate = (
        payment_fx_rate
        if payment_fx_rate is not None
        else (Decimal(1) if currency == "CNY" else rates.get(currency))
    )
    if currency == "CNY" and revenue_rate != 1:
        raise ValueError("人民币原币汇率必须为1。")
    if revenue_rate is not None:
        revenue_rate = exact_decimal(revenue_rate, "fx_rate")
    mapping = choose_mapping(paid_at, mappings)
    cost = choose_cost(paid_at, mapping.sku_id, channel_id, store_id, costs) if mapping else None
    cost_rate = None
    if cost:
        exact_decimal(cost.unit_cost, "unit_cost")
        cost_rate = Decimal(1) if cost.currency == "CNY" else rates.get(cost.currency)
        if cost_rate is not None:
            cost_rate = exact_decimal(cost_rate, "fx_rate")
    standard_quantity = None
    with localcontext() as context:
        context.prec = 80
        if mapping:
            multiplier = exact_decimal(mapping.multiplier, "quantity")
            if multiplier <= 0:
                raise ValueError("单位换算倍数必须为正。")
            raw = quantity * multiplier
            standard_quantity = raw.quantize(Decimal("0.0001"), ROUND_HALF_UP)
            if standard_quantity != raw:
                raise ValueError("换算后数量超过四位精度，需修正原始单位或数量。")
            exact_decimal(standard_quantity, "quantity")
        revenue = money(paid_amount * revenue_rate) if revenue_rate is not None else None
        cost_amount = (
            money(standard_quantity * cost.unit_cost * cost_rate)
            if cost and cost_rate is not None and standard_quantity is not None
            else None
        )
    missing = []
    if not mapping:
        missing.append("missing_mapping")
    elif not cost:
        missing.append("missing_cost")
    if revenue_rate is None or cost and cost_rate is None:
        missing.append("missing_fx")
    return Snapshot(
        mapping.mapping_id if mapping else None,
        mapping.sku_id if mapping else None,
        mapping.multiplier if mapping else None,
        standard_quantity,
        cost.cost_id if cost else None,
        cost.unit_cost if cost else None,
        revenue_rate,
        cost_rate,
        revenue,
        cost_amount,
        tuple(missing),
    )


def allocate_cents(total: Decimal, weights: dict[str, Decimal]) -> dict[str, Decimal]:
    """Largest remainder, stable ID tie break, signed adjustments, exact conservation."""
    total = exact_decimal(total, "money")
    if not weights:
        return {}
    if any(
        not isinstance(value, Decimal) or not value.is_finite() or value <= 0
        for value in weights.values()
    ):
        raise ValueError("分摊权重必须是有限正数。")
    with localcontext() as context:
        context.prec = 80
        cents = int(total.copy_abs() * 100)
        denominator = sum(weights.values(), ZERO)
        raw = {key: Decimal(cents) * value / denominator for key, value in weights.items()}
        floors = {
            key: int(value.to_integral_value(rounding=ROUND_FLOOR)) for key, value in raw.items()
        }
        remainder = cents - sum(floors.values())
        for key in sorted(raw, key=lambda key: (-(raw[key] - floors[key]), key))[:remainder]:
            floors[key] += 1
        sign = -1 if total < 0 else 1
        return {key: Decimal(value * sign) * CENT for key, value in floors.items()}


@dataclass(frozen=True)
class Refund:
    refund_id: str
    occurred_at: datetime
    amount: Decimal
    refund_type: str
    returned_quantity: Decimal = ZERO
    recoverable_quantity: Decimal = ZERO
    status: str = "completed"
    cancelled_quantity: Decimal = ZERO


@dataclass(frozen=True)
class RefundResult:
    refund_id: str
    amount_cny: Decimal | None
    recovered_cost_cny: Decimal | None


def calculate_refunds(
    snapshot: Snapshot, paid_amount: Decimal, platform_quantity: Decimal, refunds: list[Refund]
) -> list[RefundResult]:
    """Cumulative rounding avoids partial refunds losing/creating cents on full return."""
    paid_amount = exact_decimal(paid_amount, "money")
    platform_quantity = exact_decimal(platform_quantity, "quantity")
    if platform_quantity <= 0:
        raise ValueError("原订单数量必须为正。")
    cumulative_amount = cumulative_return = cumulative_recover = ZERO
    previous_amount = previous_cost = ZERO
    results = []
    # Pending events may legitimately have no completion timestamp; exclude before sorting.
    completed = [row for row in refunds if row.status != "pending"]
    for row in sorted(completed, key=lambda row: (row.occurred_at, row.refund_id)):
        if row.status != "completed" or row.refund_type not in {
            "refund_only",
            "return",
            "unshipped_cancel",
        }:
            raise ValueError("退款状态或类型无效。")
        amount = exact_decimal(row.amount, "money")
        returned = exact_decimal(row.returned_quantity, "quantity")
        recovered = exact_decimal(row.recoverable_quantity, "quantity")
        cancelled = exact_decimal(row.cancelled_quantity, "quantity")
        if amount <= 0 or returned < 0 or not ZERO <= recovered <= returned or cancelled < 0:
            raise ValueError("退款金额或退货数量无效。")
        if row.refund_type == "refund_only" and (returned != 0 or recovered != 0):
            raise ValueError("仅退款不能回收商品成本。")
        if row.refund_type == "unshipped_cancel":
            if returned != 0 or recovered != 0 or cancelled <= 0:
                raise ValueError("未发货取消须使用取消数量，不作为已退货处理。")
        elif cancelled != 0:
            raise ValueError("非未发货取消不能提供取消数量。")
        cumulative_amount += amount
        cumulative_return += returned + cancelled
        cumulative_recover += recovered + cancelled
        if cumulative_amount > paid_amount or cumulative_return > platform_quantity:
            raise ValueError("累计退款金额或退货数量超过原订单行。")
        with localcontext() as context:
            context.prec = 80
            converted = (
                money(cumulative_amount * snapshot.revenue_fx_rate)
                if snapshot.revenue_fx_rate is not None
                else None
            )
            # No return = known zero cost recovery, even if original cost is unknown.
            cost = (
                money(snapshot.cost_cny * cumulative_recover / platform_quantity)
                if snapshot.cost_cny is not None
                else ZERO
                if cumulative_recover == 0
                else None
            )
        results.append(
            RefundResult(
                row.refund_id,
                converted - previous_amount if converted is not None else None,
                cost - previous_cost if cost is not None else None,
            )
        )
        if converted is not None:
            previous_amount = converted
        if cost is not None:
            previous_cost = cost
    return results
