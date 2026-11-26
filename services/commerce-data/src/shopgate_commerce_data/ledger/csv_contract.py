"""Independent, versioned CSV12 contract; identifiers/text are never coerced to numbers."""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from shopgate_commerce_data.ledger.precision import LIMITS, decimal_text, exact_decimal
from shopgate_commerce_data.ledger.scope import IDENTIFIER

TEMPLATE_VERSION = "1"
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_BATCH_BYTES = 60 * 1024 * 1024
MAX_BATCH_ROWS = 100_000
MAX_FILES = 36
MAX_FIELD_CHARS = 3_000
DATE_TEXT = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class Field:
    name: str
    label: str
    kind: str = "text"
    optional: bool = False
    choices: tuple[str, ...] = ()


def field(name, label, kind="text", optional=False, choices=()):
    return Field(name, label, kind, optional, choices)


SPECS: dict[str, tuple[Field, ...]] = {
    "channels": (
        field("channel_id", "销售平台ID", "id"),
        field("name", "平台名称"),
        field("color", "展示色", "color"),
    ),
    "stores": (
        field("store_id", "店铺ID", "id"),
        field("channel_id", "所属平台ID", "id"),
        field("name", "店铺名称"),
        field("market", "销售市场", optional=True),
        field("mode", "经营模式", optional=True),
        field("currency", "默认原币", "currency"),
        field("timezone", "店铺原始时区", "timezone"),
    ),
    "products": (
        field("product_id", "商品ID", "id"),
        field("name", "商品名称"),
        field("category", "类目", optional=True),
        field("series", "系列", optional=True),
    ),
    "skus": (
        field("sku_id", "标准规格ID", "id"),
        field("product_id", "商品ID", "id"),
        field("name", "规格名称"),
        field("unit", "标准单位"),
    ),
    "mappings": (
        field("listing_id", "平台商品内部ID", "id"),
        field("store_id", "店铺ID", "id"),
        field("platform_sku_id", "平台规格原始编码"),
        field("name", "平台商品名称"),
        field("platform_product_id", "平台商品原始编码", optional=True),
        field("unit", "平台销售单位"),
        field("status", "映射状态", choices=("mapped", "unmapped")),
        field("mapping_id", "映射版本ID", "id", True),
        field("sku_id", "标准规格ID", "id", True),
        field("unit_multiplier", "平台单位对应标准数量", "quantity", True),
        field("valid_from", "生效时间（带时区）", "datetime", True),
        field("valid_to", "结束时间（不含该时点）", "datetime", True),
    ),
    "fx_rates": (
        field("rate_id", "汇率记录ID", "id"),
        field("currency", "原币", "currency"),
        field("rate_date", "业务日期", "date"),
        field("rate", "原币兑人民币汇率", "fx_rate"),
        field("source", "汇率来源"),
    ),
    "costs": (
        field("cost_id", "成本版本ID", "id"),
        field("sku_id", "标准规格ID", "id"),
        field("level", "成本层级", choices=("base", "channel", "store")),
        field("channel_id", "平台ID", "id", True),
        field("store_id", "店铺ID", "id", True),
        field("unit_cost", "原币每标准单位成本", "unit_cost"),
        field("currency", "成本原币", "currency"),
        field("valid_from", "生效时间（带时区）", "datetime"),
        field("valid_to", "结束时间（不含该时点）", "datetime", True),
        field("source", "成本来源"),
    ),
    "orders": (
        field("order_id", "订单内部ID", "id"),
        field("store_id", "店铺ID", "id"),
        field("platform_order_id", "平台原始订单号"),
        field("paid_at", "付款时间（带时区）", "datetime", True),
        field("status", "付款状态", choices=("paid", "unpaid", "cancelled")),
        field(
            "fulfillment_status",
            "履约状态",
            choices=("unknown", "unshipped", "shipped", "delivered"),
        ),
        field("currency", "订单原币", "currency"),
        field("fx_rate", "订单显式汇率（否则查业务日汇率）", "fx_rate", True),
        field("fx_source", "订单显式汇率来源", optional=True),
    ),
    "order_lines": (
        field("line_id", "订单行ID", "id"),
        field("order_id", "订单ID", "id"),
        field("store_id", "店铺ID", "id"),
        field("listing_id", "平台商品内部ID", "id"),
        field("quantity", "平台单位数量", "quantity"),
        field("paid_amount", "商品实收原币金额", "money"),
    ),
    "refunds": (
        field("refund_id", "退款事件ID", "id"),
        field("line_id", "原订单行ID", "id"),
        field("occurred_at", "完成时间（带时区）", "datetime", True),
        field("amount", "退款原币金额（与原订单同币）", "money"),
        field("refund_type", "退款类型", choices=("refund_only", "return", "unshipped_cancel")),
        field("returned_quantity", "退货平台数量", "quantity"),
        field("recoverable_quantity", "可回收平台数量", "quantity"),
        field("cancelled_quantity", "未发货取消平台数量", "quantity"),
        field("reason", "售后原因", optional=True),
        field("status", "处理状态", choices=("completed", "pending")),
    ),
    "expenses": (
        field("expense_id", "费用ID", "id"),
        field("occurred_at", "发生时间（带时区）", "datetime"),
        field("store_id", "来源店铺ID", "id", True),
        field("channel_id", "来源平台ID", "id", True),
        field("line_id", "直接归属订单行ID", "id", True),
        field("amount", "原币费用金额（负数为实际调整）", "signed_money"),
        field("currency", "费用原币", "currency"),
        field(
            "expense_type",
            "科目",
            choices=("platform", "packaging", "logistics", "advertising", "other"),
        ),
        field(
            "allocation_method",
            "分摊规则",
            choices=("direct", "revenue", "quantity", "unallocated"),
        ),
        field("source", "费用来源"),
        field("note", "备注", optional=True),
        field("fx_rate", "费用显式汇率", "fx_rate", True),
        field("fx_source", "费用显式汇率来源", optional=True),
    ),
    "targets": (
        field("store_id", "店铺ID", "id"),
        field("month", "目标自然月首日", "month"),
        field("sales_target", "销售目标人民币金额", "money"),
        field("profit_target", "贡献目标人民币金额", "signed_money", True),
    ),
}
DEPENDENCY_ORDER = tuple(SPECS)
RESOURCE_LABELS = dict(
    zip(
        DEPENDENCY_ORDER,
        (
            "销售平台",
            "店铺",
            "商品",
            "标准规格",
            "平台商品与规格对应关系",
            "汇率",
            "商品成本",
            "订单",
            "订单明细",
            "退款与售后",
            "经营费用",
            "月度目标",
        ),
        strict=True,
    )
)


def field_label(resource: str, name: str) -> str:
    if name == "template_version":
        return "模板版本"
    return next((spec.label for spec in SPECS.get(resource, ()) if spec.name == name), name)


@dataclass(frozen=True)
class CsvFile:
    resource: str
    filename: str
    content: bytes


@dataclass(frozen=True)
class CsvError:
    filename: str
    resource: str
    row: int
    field: str
    message: str

    def public(self):
        # Do not include source cell contents in logs/error downloads by default.
        return {
            "filename": self.filename,
            "resource": self.resource,
            "row": self.row,
            "field": self.field,
            "field_label": field_label(self.resource, self.field),
            "message": self.message,
        }


def convert(spec: Field, value: str) -> str | None:
    if len(value) > MAX_FIELD_CHARS or "\x00" in value:
        raise ValueError("字段过长或包含非法空字符。")
    if value == "":
        if spec.optional:
            return None
        raise ValueError("必填字段不能为空。")
    if spec.choices and value not in spec.choices:
        raise ValueError("不属于字段说明允许的选项。")
    if spec.kind == "id" and not IDENTIFIER.fullmatch(value):
        raise ValueError("内部ID须为1–120位字母、数字、点、冒号、下划线或连字符。")
    if spec.kind == "currency" and not re.fullmatch(r"[A-Z]{3}", value):
        raise ValueError("币种须为三位大写代码。")
    if spec.kind == "color" and not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("展示色须为六位十六进制颜色。")
    if spec.kind == "timezone":
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("时区无效。") from error
    if spec.kind in {"money", "signed_money", "quantity", "unit_cost", "fx_rate"}:
        kind = "money" if spec.kind == "signed_money" else spec.kind
        try:
            number = exact_decimal(value, kind)
        except ValueError as error:
            scale, digits = LIMITS[kind]
            sign = (
                "可为负数"
                if spec.kind == "signed_money"
                else ("须大于0" if kind == "fx_rate" else "不能为负数")
            )
            raise ValueError(
                f"{spec.label}请填写普通数字，最多{scale}位小数、整数部分最多{digits}位，"
                f"{sign}；不要使用千位逗号、科学计数法或无效数值。"
            ) from error
        if spec.kind != "signed_money" and number < 0:
            raise ValueError("该字段不能为负数。")
        return decimal_text(number, kind)
    if spec.kind in {"date", "month"}:
        if not DATE_TEXT.fullmatch(value):
            raise ValueError("日期须为YYYY-MM-DD。")
        try:
            parsed = date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("日期不存在，请检查月份和天数。") from error
        if spec.kind == "month" and parsed.day != 1:
            raise ValueError("目标月份须用该自然月首日。")
        return parsed.isoformat()
    if spec.kind == "datetime":
        if "T" not in value or re.search(r"\.\d{7,}", value):
            raise ValueError("时间须为带时区的ISO格式，最多6位小数秒。")
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError as error:
            raise ValueError("日期或时间不存在，请按字段示例填写。") from error
        if parsed.tzinfo is None:
            raise ValueError("时间必须包含时区。")
        return parsed.astimezone(UTC).isoformat()
    return value


def validate_record(resource: str, row: dict) -> None:
    if resource in {"orders", "expenses"}:
        if bool(row["fx_rate"]) != bool(row["fx_source"]):
            raise ValueError("显式汇率和来源必须同时填写或同时留空。")
        if row["currency"] == "CNY" and row["fx_rate"] and Decimal(row["fx_rate"]) != 1:
            raise ValueError("人民币原币汇率必须为1。")
    if resource == "orders":
        if row["status"] == "paid" and not row["paid_at"]:
            raise ValueError("已付款订单须提供付款时间。")
        if row["status"] == "unpaid" and row["paid_at"]:
            raise ValueError("未付款订单不能提供付款时间。")
    if (
        resource in {"mappings", "costs"}
        and row.get("valid_to")
        and (not row.get("valid_from") or row["valid_to"] <= row["valid_from"])
    ):
        raise ValueError("结束时间必须晚于生效时间。")
    if resource == "mappings":
        details = [row[key] for key in ("mapping_id", "sku_id", "unit_multiplier", "valid_from")]
        if row["status"] == "mapped" and (not all(details) or Decimal(row["unit_multiplier"]) <= 0):
            raise ValueError("已映射规格须提供版本ID、标准规格、正倍数及生效时间。")
        if row["status"] == "unmapped" and (any(details) or row["valid_to"]):
            raise ValueError("未映射规格应留空映射信息，不能伪造倍数1。")
    if resource == "costs":
        expected = {"base": (False, False), "channel": (True, False), "store": (True, True)}
        if (bool(row["channel_id"]), bool(row["store_id"])) != expected[row["level"]]:
            raise ValueError("成本层级与平台/店铺范围不一致。")
    if resource == "order_lines" and Decimal(row["quantity"]) <= 0:
        raise ValueError("付款数量须为正数。")
    if resource == "expenses":
        if row["store_id"] and not row["channel_id"]:
            raise ValueError("店铺费用须同时提供所属平台。")
        if row["allocation_method"] == "direct" and not row["line_id"]:
            raise ValueError("直接分摊须提供订单行。")
        if row["allocation_method"] != "direct" and row["line_id"]:
            raise ValueError("非直接分摊不应填写订单行。")
    if resource == "refunds":
        returned, recovered, cancelled = (
            Decimal(row[key])
            for key in ("returned_quantity", "recoverable_quantity", "cancelled_quantity")
        )
        if Decimal(row["amount"]) <= 0 or recovered > returned:
            raise ValueError("退款金额须为正，可回收数量不能超过退货数量。")
        if row["status"] == "completed" and not row["occurred_at"]:
            raise ValueError("已完成退款须提供完成时间。")
        if row["refund_type"] == "refund_only" and (returned or recovered or cancelled):
            raise ValueError("仅退款不能填写退货/取消数量。")
        if row["refund_type"] == "unshipped_cancel":
            if returned or recovered or cancelled <= 0:
                raise ValueError("未发货取消须填写取消数量，不填写退货/回收数量。")
        elif cancelled:
            raise ValueError("非未发货取消不能填写取消数量。")


def parse_batch(files: list[CsvFile]) -> tuple[dict[str, list[dict]], list[CsvError]]:
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("请选择1–36个标准CSV文件。")
    if any(
        not isinstance(file, CsvFile)
        or not isinstance(file.content, bytes)
        or not isinstance(file.resource, str)
        or not isinstance(file.filename, str)
        for file in files
    ):
        raise ValueError("文件结构或编码内容无效。")
    if sum(len(file.content) for file in files) > MAX_BATCH_BYTES:
        raise ValueError("整批文件超过60MB限制。")
    result = {resource: [] for resource in SPECS}
    errors = []
    count = 0
    for file in files:
        if (
            file.resource not in SPECS
            or len(file.filename) > 200
            or any(char in file.filename for char in "\x00\r\n")
        ):
            raise ValueError("模板类型或文件名无效。")
        if len(file.content) > MAX_FILE_BYTES:
            raise ValueError("单文件超过20MB限制。")
        specs = SPECS[file.resource]
        headers = ["template_version", *[spec.name for spec in specs]]
        try:
            decoded = file.content.decode("utf-8-sig")
            reader = csv.reader(io.StringIO(decoded, newline=""), strict=True)
            actual = next(reader, None)
            if actual is None or len(actual) != len(set(actual)) or set(actual) != set(headers):
                errors.append(
                    CsvError(
                        file.filename,
                        file.resource,
                        1,
                        "",
                        "表头缺失、重复或不匹配，请下载对应模板。",
                    )
                )
                continue
            for ordinal, cells in enumerate(reader, 2):
                count += 1
                if count > MAX_BATCH_ROWS:
                    raise ValueError("整批超过100000行限制。")
                if len(cells) != len(actual):
                    errors.append(
                        CsvError(file.filename, file.resource, ordinal, "", "列数与表头不一致。")
                    )
                    continue
                source = dict(zip(actual, cells, strict=True))
                if source["template_version"] != TEMPLATE_VERSION:
                    errors.append(
                        CsvError(
                            file.filename,
                            file.resource,
                            ordinal,
                            "template_version",
                            "模板版本不支持。",
                        )
                    )
                    continue
                row = {}
                field_name = ""
                try:
                    for spec in specs:
                        field_name = spec.name
                        row[spec.name] = convert(spec, source[spec.name])
                    field_name = ""
                    validate_record(file.resource, row)
                except ValueError as error:
                    errors.append(
                        CsvError(file.filename, file.resource, ordinal, field_name, str(error))
                    )
                    continue
                row["_filename"] = file.filename
                row["_row"] = ordinal
                result[file.resource].append(row)
        except UnicodeError, csv.Error:
            errors.append(
                CsvError(file.filename, file.resource, 1, "", "UTF-8编码或CSV引号结构无效。")
            )
    return result, errors


def standard_csv(resource: str, records: list[dict]) -> bytes:
    if resource not in SPECS:
        raise ValueError("标准模板不存在。")
    stream = io.StringIO(newline="")
    names = ["template_version", *[field.name for field in SPECS[resource]]]
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(names)
    for record in records:
        writer.writerow(
            [
                TEMPLATE_VERSION,
                *["" if record.get(key) is None else record[key] for key in names[1:]],
            ]
        )
    return stream.getvalue().encode("utf-8-sig")


def description(resource: str) -> dict:
    if resource not in SPECS:
        raise ValueError("标准模板不存在。")
    return {
        "resource": resource,
        "version": TEMPLATE_VERSION,
        "fields": [
            {
                "name": spec.name,
                "label": spec.label,
                "kind": spec.kind,
                "required": not spec.optional,
                "choices": list(spec.choices),
            }
            for spec in SPECS[resource]
        ],
        "notice": "标准交换CSV保留原始文本，供本系统回导；不要直接执行其中的表格公式。",
    }


def error_csv(errors: list[dict]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    columns = ("filename", "resource", "row", "field", "message")
    writer.writerow(("文件名", "数据类型", "行号", "字段", "错误说明"))
    for row in errors:
        values = []
        for key in columns:
            value = str(row.get(key, ""))
            if key == "resource" and value in RESOURCE_LABELS:
                value = f"{RESOURCE_LABELS[value]}（{value}）"
            if key == "field" and value:
                label = field_label(str(row.get("resource", "")), value)
                if label != value:
                    value = f"{label}（{value}）"
            if value.lstrip().startswith(("=", "+", "-", "@")):
                value = "'" + value
            values.append(value)
        writer.writerow(values)
    return stream.getvalue().encode("utf-8-sig")
