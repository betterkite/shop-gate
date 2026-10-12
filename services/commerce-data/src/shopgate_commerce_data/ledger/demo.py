"""Independent fictional trading facts, not behavior estimates or random chart values.

Pure generation only: no DB, file writes, API calls, model calls or startup/reset hooks.
Every amount is decimal text; source labels explicitly say simulated.
"""

from __future__ import annotations

import hashlib
import json
from bisect import bisect_right
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from random import Random
from zoneinfo import ZoneInfo

from shopgate_commerce_data.ledger.csv_contract import SPECS, CsvFile, standard_csv

ZONE = ZoneInfo("Asia/Shanghai")
GENERATOR_VERSION = "retail-facts-v1"
CATEGORIES = (
    ("日用清洁", ("除尘布", "清洁刷", "收纳袋", "洗衣袋"), 800, 4800),
    ("居家生活", ("桌面收纳盒", "杯垫", "抱枕套", "厨房置物架"), 1500, 16000),
    ("服饰配件", ("棉袜", "帆布帽", "围巾", "休闲腰带"), 1000, 18000),
    ("数码配件", ("数据线", "手机支架", "电脑收纳包", "桌面理线器"), 1200, 25000),
    ("运动户外", ("运动毛巾", "水壶袋", "弹力带", "防水收纳包"), 1800, 21000),
)
COLORS = ("浅灰", "青蓝", "米白", "墨黑", "浅绿")
STORE_PLAN = (
    ("pdd-a", "pdd", "日用直营店", "中国", "自营", "CNY", "Asia/Shanghai"),
    ("pdd-b", "pdd", "家居精选店", "中国", "自营", "CNY", "Asia/Shanghai"),
    ("pdd-c", "pdd", "生活折扣店", "中国", "经销", "CNY", "Asia/Shanghai"),
    ("temu-a", "temu", "北美生活店", "美国", "半托管", "USD", "America/Los_Angeles"),
    ("temu-b", "temu", "海外配件店", "美国", "半托管", "USD", "America/New_York"),
    ("temu-c", "temu", "北美家居店", "美国", "半托管", "USD", "America/Chicago"),
    ("b2b-a", "1688", "日用批发店", "中国", "批发", "CNY", "Asia/Shanghai"),
    ("b2b-b", "1688", "家居供货店", "中国", "批发", "CNY", "Asia/Shanghai"),
    ("pdd-quiet", "pdd", "筹备中店铺", "中国", "自营", "CNY", "Asia/Shanghai"),
)


@dataclass(frozen=True)
class DemoPlan:
    start_date: str
    seed: int = 1729
    days: int = 180
    sku_count: int = 1000
    order_count: int = 12000

    def validate(self):
        for name, minimum, maximum in (
            ("seed", 0, 2**32 - 1),
            ("days", 7, 366),
            ("sku_count", 10, 10000),
            ("order_count", 10, 100000),
        ):
            value = getattr(self, name)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"{name}超出允许范围。")
        if not isinstance(self.start_date, str):
            raise ValueError("开始日期须为YYYY-MM-DD。")
        start = date.fromisoformat(self.start_date)
        if start.isoformat() != self.start_date or not 2000 <= start.year <= 2100:
            raise ValueError("开始日期须为2000–2100年的YYYY-MM-DD。")


def fixed(value: Decimal | int, scale: int = 2) -> str:
    return format(
        Decimal(value).quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_UP), f".{scale}f"
    )


def timestamp(day: date, hour: int = 0, minute: int = 0) -> str:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZONE).isoformat()


def choose_sku(rng: Random, count: int) -> int:
    head = max(1, count // 10)
    middle = max(head + 1, count * 4 // 10)
    draw = rng.randrange(100)
    if draw < 65:
        return rng.randrange(head)
    if draw < 90:
        return rng.randrange(head, middle)
    return rng.randrange(middle, count)


def generate_demo(plan: DemoPlan) -> dict:
    plan.validate()
    rng = Random(plan.seed)
    start = date.fromisoformat(plan.start_date)
    dates = [start + timedelta(days=index) for index in range(plan.days)]
    end = dates[-1]
    change_day = dates[plan.days // 2]
    records = {resource: [] for resource in SPECS}
    records["channels"] = [
        {"channel_id": key, "name": name, "color": color}
        for key, name, color in (
            ("pdd", "拼多多", "#0e7490"),
            ("temu", "Temu 半托管", "#0d9488"),
            ("1688", "1688", "#0369a1"),
        )
    ]
    records["stores"] = [
        dict(
            zip(
                ("store_id", "channel_id", "name", "market", "mode", "currency", "timezone"),
                values,
                strict=True,
            )
        )
        for values in STORE_PLAN
    ]
    prices = []
    for index in range(plan.sku_count):
        product_index = index // 2
        category, nouns, low, high = CATEGORIES[product_index % len(CATEGORIES)]
        noun = nouns[(product_index // len(CATEGORIES)) % len(nouns)]
        product = f"product-{product_index:06}"
        sku = f"{index:06}"
        name = f"{noun} {COLORS[index % len(COLORS)]}"
        if index % 2 == 0:
            records["products"].append(
                {
                    "product_id": product,
                    "name": f"演示{noun}{product_index:04}",
                    "category": category,
                    "series": f"生活系列{index % 7 + 1}",
                }
            )
        records["skus"].append({"sku_id": sku, "product_id": product, "name": name, "unit": "件"})
        price = (
            Decimal(rng.randrange(low, high + 1)) / 100
            if index % 2 == 0
            else prices[-1] * Decimal("1.12")
        )
        prices.append(price)
        cost = (price * Decimal(rng.randrange(42, 73)) / 100).quantize(
            Decimal("0.0001"), rounding=ROUND_HALF_UP
        )
        if index % 97 != 0:
            for suffix, first, last, factor in (
                ("a", start, change_day, Decimal(1)),
                ("b", change_day, None, Decimal("1.08")),
            ):
                records["costs"].append(
                    {
                        "cost_id": f"base-{sku}-{suffix}",
                        "sku_id": sku,
                        "level": "base",
                        "channel_id": None,
                        "store_id": None,
                        "unit_cost": fixed(cost * factor, 4),
                        "currency": "CNY",
                        "valid_from": timestamp(first),
                        "valid_to": timestamp(last) if last else None,
                        "source": "模拟采购成本",
                    }
                )
            if index % 5 == 0:
                records["costs"].append(
                    {
                        "cost_id": f"channel-{sku}",
                        "sku_id": sku,
                        "level": "channel",
                        "channel_id": "1688",
                        "store_id": None,
                        "unit_cost": fixed(cost * Decimal("0.94"), 4),
                        "currency": "CNY",
                        "valid_from": timestamp(start),
                        "valid_to": None,
                        "source": "模拟批发采购条件",
                    }
                )
            if index % 11 == 0:
                records["costs"].append(
                    {
                        "cost_id": f"store-{sku}",
                        "sku_id": sku,
                        "level": "store",
                        "channel_id": "pdd",
                        "store_id": "pdd-a",
                        "unit_cost": fixed(cost * Decimal("0.92"), 4),
                        "currency": "CNY",
                        "valid_from": timestamp(start),
                        "valid_to": None,
                        "source": "模拟店铺协议采购",
                    }
                )
            if index % 13 == 0:
                records["costs"].append(
                    {
                        "cost_id": f"usd-cost-{sku}",
                        "sku_id": sku,
                        "level": "store",
                        "channel_id": "temu",
                        "store_id": "temu-a",
                        "unit_cost": fixed(cost / Decimal("7.10"), 4),
                        "currency": "USD",
                        "valid_from": timestamp(start),
                        "valid_to": None,
                        "source": "模拟外币采购协议",
                    }
                )
        for store, channel, *_ in STORE_PLAN[:-1]:
            listing = f"{store}-{sku}"
            multiplier = 12 if channel == "1688" else 2 if channel == "pdd" else 1
            record = {
                "listing_id": listing,
                "store_id": store,
                "platform_sku_id": f"00{sku}",
                "platform_product_id": f"00{product}",
                "name": name,
                "unit": "箱" if multiplier == 12 else "包" if multiplier == 2 else "件",
                "status": "unmapped" if index % 89 == 0 else "mapped",
                "mapping_id": None,
                "sku_id": None,
                "unit_multiplier": None,
                "valid_from": None,
                "valid_to": None,
            }
            if record["status"] == "mapped":
                record.update(
                    mapping_id=f"map-{listing}",
                    sku_id=sku,
                    unit_multiplier=str(multiplier),
                    valid_from=timestamp(start),
                )
            records["mappings"].append(record)
    rates = {}
    missing_fx_days = []
    for index, day in enumerate(dates):
        rate = Decimal("7.10") + Decimal((index % 19) - 9) / 1000
        rates[day] = rate
        if index % 53 == 17:
            missing_fx_days.append(day.isoformat())
        else:
            records["fx_rates"].append(
                {
                    "rate_id": f"usd-{day.isoformat()}",
                    "currency": "USD",
                    "rate_date": day.isoformat(),
                    "rate": fixed(rate, 8),
                    "source": "模拟业务日汇率",
                }
            )

    # Integer weights separate weekday, fictional campaign and trend factors from seed.
    weights = []
    campaigns = {plan.days // 3, plan.days * 2 // 3}
    for index, day in enumerate(dates):
        weekday = (86, 94, 100, 104, 112, 128, 120)[day.weekday()]
        campaign = 180 if any(abs(index - center) <= 2 for center in campaigns) else 100
        weights.append(weekday * campaign * (100 + index * 35 // plan.days))
    cumulative = []
    for value in weights:
        cumulative.append(value + (cumulative[-1] if cumulative else 0))
    daily_units = {(store[0], day): 0 for store in STORE_PLAN for day in dates}
    scenario_examples = {
        key: []
        for key in (
            "refund_only",
            "return",
            "unshipped_cancel",
            "pending_refund",
            "partial_refund",
            "missing_cost",
            "missing_mapping",
            "missing_fx",
            "loss",
            "unpaid",
            "cancelled",
        )
    }

    def example(kind, identifier):
        if len(scenario_examples[kind]) < 20:
            scenario_examples[kind].append(identifier)

    for ordinal in range(plan.order_count):
        day = dates[bisect_right(cumulative, rng.randrange(cumulative[-1]))]
        store, channel, _, _, _, currency, _ = STORE_PLAN[rng.randrange(len(STORE_PLAN) - 1)]
        oid = f"demo-order-{ordinal:07}"
        status = "unpaid" if ordinal % 29 == 0 else "cancelled" if ordinal % 47 == 0 else "paid"
        refund_case = ordinal % 3
        cancel = status == "paid" and ordinal % 13 == 0 and refund_case == 2
        paid = timestamp(day, rng.randrange(9, 17), rng.randrange(60))
        explicit = currency == "USD" and ordinal % 7 == 0
        records["orders"].append(
            {
                "order_id": oid,
                "store_id": store,
                "platform_order_id": f"000{ordinal:010}",
                "paid_at": paid if status == "paid" else None,
                "status": status,
                "fulfillment_status": "unshipped" if cancel or status != "paid" else "delivered",
                "currency": currency,
                "fx_rate": fixed(rates[day], 8) if explicit else None,
                "fx_source": "模拟订单结算汇率" if explicit else None,
            }
        )
        if status != "paid":
            example(status, oid)
        for line_index in range(2 if rng.randrange(100) < 35 else 1):
            index = choose_sku(rng, plan.sku_count)
            sku = f"{index:06}"
            qty = rng.randrange(1, 5)
            multiplier = 12 if channel == "1688" else 2 if channel == "pdd" else 1
            discount = Decimal("0.38") if index % 23 == 3 else Decimal(rng.randrange(84, 113)) / 100
            cny = prices[index] * discount * multiplier * qty
            amount = Decimal(fixed(cny / rates[day] if currency == "USD" else cny))
            lid = f"{oid}-{line_index}"
            records["order_lines"].append(
                {
                    "line_id": lid,
                    "order_id": oid,
                    "store_id": store,
                    "listing_id": f"{store}-{sku}",
                    "quantity": str(qty),
                    "paid_amount": fixed(amount),
                }
            )
            if status != "paid":
                continue
            daily_units[(store, day)] += multiplier * qty
            if index % 97 == 0:
                example("missing_cost", lid)
            if index % 89 == 0:
                example("missing_mapping", lid)
            if currency == "USD" and day.isoformat() in missing_fx_days and not explicit:
                example("missing_fx", lid)
            if index % 23 == 3:
                example("loss", lid)
            records["expenses"].append(
                {
                    "expense_id": f"fee-{lid}",
                    "occurred_at": paid,
                    "store_id": store,
                    "channel_id": channel,
                    "line_id": lid,
                    "amount": fixed(amount * Decimal("0.025")),
                    "currency": currency,
                    "expense_type": "platform",
                    "allocation_method": "direct",
                    "source": "模拟交易费用（非平台真实费率）",
                    "note": "演示计划",
                    "fx_rate": None,
                    "fx_source": None,
                }
            )
            if line_index != 0:
                continue
            remaining = (end - day).days
            refund_day = (
                day + timedelta(days=rng.randrange(1, min(10, remaining) + 1)) if remaining else day
            )
            occurred = timestamp(refund_day, 18)

            def refund(
                suffix,
                kind,
                ratio,
                returned="0",
                recovered="0",
                cancelled="0",
                pending=False,
                *,
                oid=oid,
                lid=lid,
                occurred=occurred,
                amount=amount,
            ):
                rid = f"refund-{oid}-{suffix}"
                records["refunds"].append(
                    {
                        "refund_id": rid,
                        "line_id": lid,
                        "occurred_at": None if pending else occurred,
                        "amount": fixed(amount * ratio),
                        "refund_type": kind,
                        "returned_quantity": returned,
                        "recoverable_quantity": recovered,
                        "cancelled_quantity": cancelled,
                        "reason": "模拟售后：尺寸不适"
                        if kind == "return"
                        else "模拟售后：订单调整",
                        "status": "pending" if pending else "completed",
                    }
                )
                example("pending_refund" if pending else kind, rid)

            if ordinal % 13 == 0:
                if refund_case == 0:
                    refund("a", "refund_only", Decimal("0.25"))
                elif refund_case == 1:
                    refund("a", "return", Decimal("0.40"), "1", "1" if ordinal % 2 else "0")
                else:
                    refund("a", "unshipped_cancel", Decimal("0.40"), cancelled="1")
            elif ordinal % 41 == 0:
                refund("a", "refund_only", Decimal("0.10"))
                refund("b", "refund_only", Decimal("0.15"))
                example("partial_refund", lid)
            elif ordinal % 23 == 0:
                refund("pending", "refund_only", Decimal("0.10"), pending=True)

    for store, channel, *_ in STORE_PLAN:
        for index, day in enumerate(dates):
            units = daily_units[(store, day)]
            for kind, cents, method in (
                ("packaging", units * 35, "quantity"),
                ("logistics", units * 120, "revenue"),
                ("advertising", 3500 + index * 25 + rng.randrange(2200), "revenue"),
            ):
                records["expenses"].append(
                    {
                        "expense_id": f"{kind}-{store}-{day}",
                        "occurred_at": timestamp(day, 20),
                        "store_id": store,
                        "channel_id": channel,
                        "line_id": None,
                        "amount": fixed(Decimal(cents) / 100),
                        "currency": "CNY",
                        "expense_type": kind,
                        "allocation_method": method,
                        "source": "模拟日费用记录",
                        "note": "模拟经营计划",
                        "fx_rate": None,
                        "fx_source": None,
                    }
                )
            if index % 17 == 5:
                records["expenses"].append(
                    {
                        "expense_id": f"adjust-{store}-{day}",
                        "occurred_at": timestamp(day, 20),
                        "store_id": store,
                        "channel_id": channel,
                        "line_id": None,
                        "amount": "-20.00",
                        "currency": "CNY",
                        "expense_type": "other",
                        "allocation_method": "unallocated",
                        "source": "模拟实际费用调整",
                        "note": "负数调整示例",
                        "fx_rate": None,
                        "fx_source": None,
                    }
                )
        for month in sorted({day.replace(day=1) for day in dates}):
            records["targets"].append(
                {
                    "store_id": store,
                    "month": month.isoformat(),
                    "sales_target": "80000.00",
                    "profit_target": "12000.00",
                }
            )
    encoded = json.dumps(
        records, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()
    return {
        "records": records,
        "manifest": {
            "generator": GENERATOR_VERSION,
            "source_kind": "demo",
            "notice": "独立构造的演示经营事实，不是真实店铺或市场观测，不补齐正式数据。",
            "plan": asdict(plan),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "row_counts": {key: len(value) for key, value in records.items()},
            "content_hash": hashlib.sha256(encoded).hexdigest(),
            "missing_fx_days": missing_fx_days,
            "examples": scenario_examples,
            "no_sales_store": "pdd-quiet",
            "campaign_days": [dates[index].isoformat() for index in sorted(campaigns)],
        },
    }


def demo_files(generated: dict) -> list[CsvFile]:
    return [
        CsvFile(
            resource, f"demo-{resource}.csv", standard_csv(resource, generated["records"][resource])
        )
        for resource in SPECS
    ]
