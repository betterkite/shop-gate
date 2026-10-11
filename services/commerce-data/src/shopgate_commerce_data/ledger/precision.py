from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Literal

PrecisionKind = Literal["money", "quantity", "unit_cost", "fx_rate"]
LIMITS: dict[PrecisionKind, tuple[int, int]] = {
    "money": (2, 16),
    "quantity": (4, 12),
    "unit_cost": (4, 12),
    "fx_rate": (8, 8),
}
DECIMAL_TEXT = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?$")


def exact_decimal(value: str | Decimal | int, kind: PrecisionKind) -> Decimal:
    """Reject loss of precision, nonfinite values and binary floats before storage."""
    if isinstance(value, bool) or not isinstance(value, (str, Decimal, int)):
        raise ValueError(f"{kind}: 必须使用十进制字符串，不能使用浮点数。")
    if isinstance(value, str) and (len(value) > 80 or not DECIMAL_TEXT.fullmatch(value)):
        raise ValueError(f"{kind}: 十进制格式无效。")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"{kind}: 十进制格式无效。") from error
    scale, integer_digits = LIMITS[kind]
    if not result.is_finite() or result.as_tuple().exponent < -scale:
        raise ValueError(f"{kind}: 非有限值或超过允许精度。")
    if result.copy_abs() >= Decimal(10) ** integer_digits:
        raise ValueError(f"{kind}: 数值超出允许范围。")
    if kind == "unit_cost" and result < 0 or kind == "fx_rate" and result <= 0:
        raise ValueError(f"{kind}: 数值必须符合正数约束。")
    return result


def decimal_text(value: Decimal | None, kind: PrecisionKind) -> str | None:
    if value is None:
        return None
    result = exact_decimal(value, kind)
    return format(result, f".{LIMITS[kind][0]}f")
