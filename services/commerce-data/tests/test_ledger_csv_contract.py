"""CSV version and source fidelity, independent from accounting calculations."""

import csv
import io

import pytest

from shopgate_commerce_data.ledger.csv_contract import (
    SPECS,
    CsvFile,
    convert,
    description,
    error_csv,
    field,
    parse_batch,
    standard_csv,
    validate_record,
)


@pytest.mark.parametrize("resource", list(SPECS))
def test_all_twelve_templates_have_chinese_field_docs_and_version(resource):
    assert len(SPECS) == 12
    document = description(resource)
    assert document["version"] == "1"
    assert all(entry["label"] and entry["name"] for entry in document["fields"])
    parsed, errors = parse_batch([CsvFile(resource, "空模板.csv", standard_csv(resource, []))])
    assert errors == [] and parsed[resource] == []


def test_text_roundtrip_preserves_bom_chinese_zero_formula_quotes_and_newlines():
    original = {
        "product_id": "000001",
        "name": '=商品,"A"\n第二行',
        "category": "日用品",
        "series": "",
    }
    content = standard_csv("products", [original])
    assert content.startswith(b"\xef\xbb\xbf")
    for raw in (content, content[3:]):
        records, errors = parse_batch([CsvFile("products", "商品.csv", raw)])
        assert not errors
        assert records["products"][0]["product_id"] == "000001"
        assert records["products"][0]["name"] == original["name"]
        assert records["products"][0]["series"] is None
        assert records["products"][0]["_row"] == 2


@pytest.mark.parametrize(
    "kind,value",
    [
        ("money", "0.001"),
        ("money", "NaN"),
        ("money", "Infinity"),
        ("money", "1e3"),
        ("money", "1,000"),
        ("money", "-1"),
        ("quantity", "0.00001"),
        ("unit_cost", "-1"),
        ("fx_rate", "0"),
        ("fx_rate", "1.000000001"),
        ("date", "2026-02-29"),
        ("date", "2026-1-01"),
        ("month", "2026-01-02"),
        ("datetime", "2026-01-01T12:00:00"),
        ("datetime", "2026-01-01T12:00:00.1234567Z"),
        ("currency", "cny"),
        ("timezone", "No/SuchZone"),
        ("id", "../私有ID"),
        ("color", "javascript:bad"),
        ("text", "a\x00b"),
    ],
)
def test_invalid_scalar_is_rejected_not_rounded_or_guessed(kind, value):
    with pytest.raises(ValueError):
        convert(field("v", "测试字段", kind), value)


@pytest.mark.parametrize(
    "kind,value,expected",
    [
        ("signed_money", "-1.2", "-1.20"),
        ("quantity", "1.25", "1.2500"),
        ("fx_rate", "7.25", "7.25000000"),
        ("unit_cost", "0", "0.0000"),
        ("datetime", "2026-07-01T08:00:00+08:00", "2026-07-01T00:00:00+00:00"),
        ("text", "000你好", "000你好"),
    ],
)
def test_valid_scalar_canonical_format(kind, value, expected):
    assert convert(field("v", "测试字段", kind), value) == expected


@pytest.mark.parametrize(
    "header",
    [
        "template_version,product_id,name,category",
        "template_version,product_id,name,category,series,secret",
        "template_version,product_id,name,name,series",
    ],
)
def test_missing_extra_duplicate_columns_rejected(header):
    _, errors = parse_batch([CsvFile("products", "商品.csv", header.encode())])
    assert len(errors) == 1 and errors[0].row == 1


def test_invalid_rows_errors_do_not_echo_private_cells_and_report_is_safe():
    content = (
        b"template_version,product_id,name,category,series\n2,001,secret,,\n1,001,\x00secret,,\n"
    )
    records, errors = parse_batch([CsvFile("products", "=secret.csv", content)])
    assert not records["products"] and len(errors) == 2
    assert errors[1].field == "name"
    report = error_csv([error.public() for error in errors]).decode("utf-8-sig")
    parsed = list(csv.reader(io.StringIO(report)))
    assert parsed[1][0] == "'=secret.csv"
    assert all("secret" not in error.message for error in errors)


def test_invalid_money_has_actionable_chinese_field_and_precision_in_page_and_download():
    row = {
        "line_id": "001",
        "order_id": "0001",
        "store_id": "001",
        "listing_id": "001",
        "quantity": "1",
        "paid_amount": "999.001",
    }
    records, errors = parse_batch(
        [CsvFile("order_lines", "订单明细.csv", standard_csv("order_lines", [row]))]
    )
    assert not records["order_lines"] and len(errors) == 1
    public = errors[0].public()
    assert public["field"] == "paid_amount"
    assert public["field_label"] == "商品实收原币金额"
    assert "最多2位小数" in public["message"]
    assert "money:" not in public["message"] and "999.001" not in public["message"]
    report = list(csv.reader(io.StringIO(error_csv([public]).decode("utf-8-sig"))))
    assert report[1][1] == "订单明细（order_lines）"
    assert report[1][3] == "商品实收原币金额（paid_amount）"
    assert report[1][4] == public["message"]
    legacy = {key: value for key, value in public.items() if key != "field_label"}
    assert error_csv([legacy]) == error_csv([public])


@pytest.mark.parametrize("content", [b"\xff", b'"unterminated', b"a,b\n1"])
def test_bad_encoding_or_structure(content):
    _, errors = parse_batch([CsvFile("products", "bad.csv", content)])
    assert errors


def test_reordered_header_is_supported_and_wrong_row_width_rejected():
    content = b"series,name,product_id,category,template_version\n,abc,0001,,1\n,bad\n"
    records, errors = parse_batch([CsvFile("products", "商品.csv", content)])
    assert records["products"][0]["product_id"] == "0001"
    assert errors[0].row == 3


def test_dependency_semantics_are_not_silently_filled():
    with pytest.raises(ValueError, match="倍数"):
        validate_record(
            "mappings",
            {
                "status": "mapped",
                "mapping_id": "m",
                "sku_id": "s",
                "unit_multiplier": "0",
                "valid_from": "2026-01-01",
                "valid_to": None,
            },
        )
    with pytest.raises(ValueError, match="退款"):
        validate_record(
            "refunds",
            {
                "amount": "1",
                "returned_quantity": "1",
                "recoverable_quantity": "1",
                "cancelled_quantity": "0",
                "occurred_at": "2026-01-01",
                "status": "completed",
                "refund_type": "refund_only",
            },
        )


def test_limits_are_enforced_before_database_work(monkeypatch):
    from shopgate_commerce_data.ledger import csv_contract

    with pytest.raises(ValueError, match="1–36"):
        parse_batch([])
    with pytest.raises(ValueError, match="文件结构"):
        parse_batch([CsvFile("products", "x.csv", "not bytes")])
    with pytest.raises(ValueError, match="类型"):
        parse_batch([CsvFile("sql", "x.csv", b"")])
    monkeypatch.setattr(csv_contract, "MAX_FILE_BYTES", 2)
    with pytest.raises(ValueError, match="单文件"):
        parse_batch([CsvFile("products", "x.csv", b"aaa")])
    monkeypatch.setattr(csv_contract, "MAX_BATCH_BYTES", 1)
    with pytest.raises(ValueError, match="整批文件"):
        parse_batch([CsvFile("products", "x.csv", b"aa")])
