"""Seven operating reports. Page and CSV share one signed accounting snapshot and column schema."""

import csv
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal
from io import StringIO

from .metrics import REFUND_TYPES
from .precision import decimal_text
from .query import Query, _group, aggregate, ledger_read_snapshot
from .recalculation import BUSINESS_ZONE, rows

GROUPS = {"daily": "day", "channels": "channel", "stores": "store", "products": "sku"}
TYPES = (*GROUPS, "orders", "refunds", "costs")
COMMON = {
    "sales_amount": "付款成交金额（元）",
    "net_sales": "净销售额（元）",
    "refund_amount": "退款金额（元）",
    "product_cost": "商品成本净额（元）",
    "expense_amount": "经营费用（元）",
    "accounted_contribution": "已核算经营贡献（元）",
    "contribution_profit": "经营贡献利润（元）",
    "order_count": "付款订单数",
}
ORDER = {
    "order_id": "订单编号",
    "key": "付款明细编号",
    "store_name": "店铺",
    "name": "商品",
    "sku_id": "标准规格编号",
    "date": "付款日期",
    "sales_amount": "付款成交金额（元）",
    "cost": "付款时商品成本（元）",
    "cost_id": "付款时成本版本",
    "accounted_contribution": "已核算经营贡献（元）",
    "contribution_profit": "经营贡献利润（元）",
    "status": "付款核算情况",
}
REFUND = {
    "key": "退款编号",
    "order_id": "原订单编号",
    "line_id": "付款明细编号",
    "store_name": "店铺",
    "name": "商品",
    "date": "退款日期",
    "payment_date": "付款日期",
    "refund_type": "售后类型",
    "reason": "退款原因",
    "amount": "退款金额（元）",
    "recovery": "退回商品收回成本（元）",
    "returned_quantity": "退回标准数量",
}
COST = {
    "key": "成本版本编号",
    "sku_id": "标准规格编号",
    "name": "规格名称",
    "level": "适用范围",
    "before_cost": "调整前单位成本",
    "before_currency": "原币种",
    "unit_cost": "调整后单位成本",
    "currency": "新币种",
    "date": "生效时间（北京时间）",
    "created_version": "登记版本",
    "status": "版本状态",
    "source": "变更说明",
}
NUMERIC = {
    *COMMON,
    "cost",
    "amount",
    "recovery",
    "returned_quantity",
    "before_cost",
    "unit_cost",
    "created_version",
}
GROUP_NAMES = {
    "daily": "业务日期",
    "channels": "平台名称",
    "stores": "店铺名称",
    "products": "规格名称",
}
MISSING = {
    "missing_mapping": "未对应标准规格",
    "missing_cost": "缺少付款成本",
    "missing_fx": "缺少换算汇率",
}


def report_columns(kind):
    if kind in GROUPS:
        return {
            "key": "日期" if kind == "daily" else "编号",
            **({"name": GROUP_NAMES[kind]} if kind != "daily" else {}),
            **COMMON,
        }
    return {"orders": ORDER, "refunds": REFUND, "costs": COST}[kind]


@dataclass(frozen=True)
class Report:
    report_type: str
    query: Query = field(default_factory=Query)
    search: str = ""
    sort: str | None = None
    descending: bool = True
    columns: tuple[str, ...] = ()
    page: int = 1

    def validate(self):
        self.query.validate()
        if not isinstance(self.report_type, str) or self.report_type not in TYPES:
            raise ValueError("请选择七类经营报表之一。")
        allowed = report_columns(self.report_type)
        if not isinstance(self.search, str) or len(self.search) > 200:
            raise ValueError("搜索内容最多 200 字。")
        if (
            not isinstance(self.columns, (tuple, list))
            or any(not isinstance(x, str) or x not in allowed for x in self.columns)
            or len(set(self.columns)) != len(self.columns)
        ):
            raise ValueError("显示列无效。")
        if (
            self.sort is not None
            and (not isinstance(self.sort, str) or self.sort not in allowed)
            or type(self.descending) is not bool
            or type(self.page) is not int
            or not 1 <= self.page <= 1000000
        ):
            raise ValueError("排序或页码无效。")


def transaction_rows(events, kind, query):
    if kind in GROUPS:
        dimension = GROUPS[kind]
        groups = defaultdict(list)
        for e in events:
            groups[_group(e, dimension)].append(e)
        for (key, name), members in groups.items():
            yield {"key": key, "name": name, **aggregate(members, query)["metrics"]}
        return
    if kind == "orders":
        by_line = defaultdict(list)
        for e in events:
            if e.get("line_id"):
                by_line[e["line_id"]].append(e)
        for e in events:
            if e["kind"] != "sale":
                continue
            metrics = aggregate(by_line[e["line_id"]], query)["metrics"]
            yield {
                **metrics,
                "order_id": e["order_id"],
                "key": e["line_id"],
                "store_name": e["store_name"],
                "name": e["listing_name"],
                "sku_id": e["sku_id"],
                "date": e["date"].isoformat(),
                "cost_id": e["source"].get("cost_id"),
                "cost": decimal_text(e["cost"], "money"),
                "status": "、".join(MISSING.get(k, k) for k in e["source"]["missing"]) or "已核算",
            }
        return
    for e in events:
        if e["kind"] == "refund":
            source = e["source"]
            yield {
                "key": e["refund_id"],
                "order_id": e["order_id"],
                "line_id": e["line_id"],
                "name": e["listing_name"],
                "store_name": e["store_name"],
                "date": local_day(source["occurred_at"]),
                "payment_date": local_day(source["paid_at"]),
                "reason": source["reason"] or "未填写",
                "refund_type": REFUND_TYPES[source["refund_type"]],
                "amount": decimal_text(e["refund"], "money"),
                "recovery": decimal_text(e["recovery"], "money"),
                "returned_quantity": source["returned_quantity"],
            }


def local_day(value):
    return datetime.fromisoformat(value).astimezone(BUSINESS_ZONE).date().isoformat()


def cost_rows(connection, query, span, events):
    # Compute previous price before filtering dates. A same-time replacement remains traceable.
    sql = """
        SELECT c.*, s.name,p.category,s.product_id,st.name AS store_name,ch.name AS channel_name,
               lag(c.unit_cost) OVER price AS before_cost,
               lag(c.currency) OVER price AS before_currency
        FROM bi.cost_versions c JOIN bi.skus s USING(workspace_id,dataset_id,sku_id)
        JOIN bi.products p USING(workspace_id,dataset_id,product_id)
        LEFT JOIN bi.stores st ON (st.workspace_id,st.dataset_id,st.store_id)=
                                  (c.workspace_id,c.dataset_id,c.store_id)
        LEFT JOIN bi.channels ch ON (ch.workspace_id,ch.dataset_id,ch.channel_id)=
                                    (c.workspace_id,c.dataset_id,c.channel_id)
        WINDOW price AS (PARTITION BY c.sku_id,c.level,c.channel_id,c.store_id
                         ORDER BY c.valid_from,c.created_version,c.cost_id)
    """
    channels = set(query.channel_ids)
    if query.store_ids:
        channels.update(
            r["channel_id"]
            for r in rows(
                connection,
                "SELECT channel_id FROM bi.stores WHERE store_id=ANY(%s)",
                (list(query.store_ids),),
            )
        )
    eligible = {e.get("sku_id") for e in events} if query.group_condition or query.search else None
    mappings = defaultdict(list)
    if query.listing_ids:
        for record in rows(
            connection,
            "SELECT sku_id,valid_from,valid_to FROM bi.mappings "
            "WHERE listing_id=ANY(%s) AND superseded_version IS NULL",
            (list(query.listing_ids),),
        ):
            mappings[record["sku_id"]].append((record["valid_from"], record["valid_to"]))
    for r in rows(connection, sql):
        moment = r["valid_from"].astimezone(BUSINESS_ZONE)
        day = moment.date().isoformat()
        if (
            (span["start"] and day < span["start"])
            or (span["end"] and day > span["end"])
            or query.sku_ids
            and r["sku_id"] not in query.sku_ids
            or query.product_ids
            and r["product_id"] not in query.product_ids
            or query.category is not None
            and r["category"] != query.category
            or channels
            and r["channel_id"]
            and r["channel_id"] not in channels
            or query.store_ids
            and r["store_id"]
            and r["store_id"] not in query.store_ids
            or eligible is not None
            and r["sku_id"] not in eligible
        ):
            continue
        if query.listing_ids and not any(
            start <= moment and (end is None or moment < end)
            for start, end in mappings[r["sku_id"]]
        ):
            continue
        yield {
            "key": r["cost_id"],
            "sku_id": r["sku_id"],
            "name": r["name"],
            "level": r["store_name"] or r["channel_name"] or "基础成本",
            "before_cost": decimal_text(r["before_cost"], "unit_cost"),
            "before_currency": r["before_currency"],
            "unit_cost": decimal_text(r["unit_cost"], "unit_cost"),
            "currency": r["currency"],
            "date": moment.isoformat(timespec="seconds"),
            "created_version": r["created_version"],
            "status": "已被替代"
            if r["superseded_version"]
            else "已结束"
            if r["valid_to"]
            else "已登记",
            "source": r["source"],
        }


def run_report(connection, scope, report, *, export=False, evidence=False):
    report.validate()
    kind = report.report_type
    labels = report_columns(kind)
    columns = report.columns or tuple(labels)
    sort = report.sort or (
        "date" if kind not in GROUPS else "key" if kind == "daily" else "net_sales"
    )
    dimension = GROUPS.get(kind, "line" if kind == "orders" else "overall")
    q = replace(report.query, dimension=dimension, metrics=tuple(COMMON))
    with ledger_read_snapshot(connection, scope) as read:
        events, _, span, cutoff = read.selected_events(q)
        found = (
            cost_rows(connection, q, span, events)
            if kind == "costs"
            else transaction_rows(events, kind, q)
        )
        search = report.search.casefold()
        data = [
            r
            for r in found
            if not search
            or any(search in str(r[k]).casefold() for k in labels if r.get(k) is not None)
        ]
    data.sort(key=lambda r: r["key"])
    known = [r for r in data if r.get(sort) is not None]
    known.sort(
        key=lambda r: Decimal(r[sort]) if sort in NUMERIC else r[sort], reverse=report.descending
    )
    ordered = known + [r for r in data if r.get(sort) is None]
    if evidence:
        return report_evidence(scope, report, span, cutoff, ordered, columns)
    if export:
        output = StringIO(newline="")
        output.write("\ufeff")
        writer = csv.writer(output)
        writer.writerow([labels[k] for k in columns])
        for r in ordered:
            writer.writerow([export_cell(k, r.get(k)) for k in columns])
        return output.getvalue()
    offset = (report.page - 1) * 20
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "version": scope.version,
        "accounting_revision": scope.version,
        "range": span,
        "data_cutoff": cutoff,
        "report_type": kind,
        "labels": labels,
        "columns": columns,
        "sort": sort,
        "descending": report.descending,
        "total": len(ordered),
        "page": report.page,
        "page_size": 20,
        "rows": [
            {"id": r["key"], "values": {k: r.get(k) for k in columns}}
            for r in ordered[offset : offset + 20]
        ],
    }


def export_cell(key, value):
    if value is None:
        return (
            "未记录" if key in {"before_cost", "before_currency", "sku_id", "cost_id"} else "待核算"
        )
    text = str(value)
    if key not in NUMERIC and (
        text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n"))
    ):
        return "'" + text
    return text


def report_evidence(scope, report, span, cutoff, ordered, columns):
    labels = report_columns(report.report_type)
    fields = {k: k for k in COMMON if k in labels}
    if report.report_type == "refunds":
        fields.update(refund_amount="amount", refund_cost_recovery="recovery")
    additive = set(fields) - {"order_count"}
    summary = {}
    for metric in additive:
        values = [r.get(fields[metric]) for r in ordered]
        if all(v is not None for v in values):
            summary[metric] = decimal_text(sum((Decimal(v) for v in values), Decimal(0)), "money")
        else:
            summary[metric] = None
    if report.report_type == "orders":
        summary["order_count"] = len({r["order_id"] for r in ordered})
    if report.report_type == "refunds":
        summary["refund_event_count"] = len(ordered)
    offset = (report.page - 1) * 100
    return {
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "version": scope.version,
        "accounting_revision": scope.version,
        "algorithm_version": "report-v1",
        "range": span,
        "data_cutoff": cutoff,
        "summary": {"metrics": summary, "quality": {"report_rows": len(ordered)}},
        "page": report.page,
        "page_size": 100,
        "total": len(ordered),
        "notes": ["合计限于可加金额。成本规则的价格可能使用不同币种，不合计单位价格。"],
        "rows": [
            {
                "key": r["key"],
                "name": " · ".join(
                    labels[k] + " " + str(r.get(k) if r.get(k) is not None else "未记录")
                    for k in columns
                ),
                "metrics": {metric: r.get(col) for metric, col in fields.items()},
                "quality": {"report_cells": {labels[k]: r.get(k) for k in columns}},
            }
            for r in ordered[offset : offset + 100]
        ],
    }
