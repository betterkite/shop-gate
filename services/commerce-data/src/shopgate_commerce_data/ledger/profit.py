"""Reconcile signed operating profit components from one versioned ledger read."""

from decimal import Decimal

from shopgate_commerce_data.ledger.accounting import ratio
from shopgate_commerce_data.ledger.metrics import FEE_LABELS
from shopgate_commerce_data.ledger.precision import decimal_text


def _signed(value, sign):
    return None if value is None else decimal_text((Decimal(value) * sign) or Decimal(0), "money")


def _difference(current, previous):
    if current is None or previous is None:
        return None
    return decimal_text(Decimal(current) - Decimal(previous), "money")


def _components(summary):
    metrics, quality = summary["metrics"], summary["quality"]
    parts = {}
    for key, known, sign in (
        ("sales_amount", "known_sales_cny", 1),
        ("refund_amount", "known_refunds_cny", -1),
        ("product_cost", "known_product_cost_cny", -1),
    ):
        parts[key] = (_signed(metrics[key], sign), _signed(quality[known], sign), None)
    fees = metrics["expense_amount"]
    for kind in FEE_LABELS:
        fee = summary["expense_breakdown"].get(kind, {"amount": "0.00", "known_amount": "0.00"})
        amount = fee["amount"]
        share = ratio(Decimal(amount), Decimal(fees)) if amount is not None and fees else None
        parts[kind] = (_signed(amount, -1), _signed(fee["known_amount"], -1),
                       format(share, "f") if share is not None else None)
    return parts


def profit_statement(current, previous):
    """A negative expense adjustment increases profit. Incomplete totals stay unknown."""
    parts = _components(current)
    previous_parts = _components(previous) if previous is not None else {}
    rows = []
    for key, (amount, known_amount, fee_share) in parts.items():
        before = previous_parts[key][0] if previous is not None else None
        rows.append({"key": key, "amount": amount, "known_amount": known_amount,
                     "previous": before, "change": _difference(amount, before),
                     "fee_share": fee_share})
    metrics = current["metrics"]
    before = previous["metrics"]["contribution_profit"] if previous is not None else None
    return {"rows": rows, "profit": metrics["contribution_profit"],
            "accounted": metrics["accounted_contribution"], "previous_profit": before,
            "change": _difference(metrics["contribution_profit"], before),
            "unallocated": current["quality"]["unallocated_expenses_cny"]}
