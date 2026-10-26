"""Signed HTTP boundary on actual isolated PG18; no daily credentials or model."""

import base64
import hashlib
import hmac
import json
import os
import time
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from shopgate_commerce_data.api import create_app
from shopgate_commerce_data.ledger.csv_contract import SPECS, CsvFile, standard_csv
from shopgate_commerce_data.ledger.demo import DemoPlan, demo_files, generate_demo
from shopgate_commerce_data.ledger.exchange import confirm_import, preview_import
from shopgate_commerce_data.ledger.migrations import migrate_all
from shopgate_commerce_data.ledger.query import Query, query_ledger
from shopgate_commerce_data.ledger.scope import LedgerScope
from shopgate_commerce_data.routers.bi import MAX_JSON_BYTES, BiSettings

SECRET = "bi-http-only-test-key-not-an-external-credential"
PREFIX = "/api/v1/bi"


def token(workspace, *, directory=True, manage=True, **changes):
    now = int(time.time())
    claims = {
        "aud": "shopgate-bi-directory-v1" if directory else "shopgate-bi-v1",
        "workspace_id": workspace,
        "actor_id": "http-user",
        "capabilities": ["datasets.read"] if directory else ["ledger.read"],
        "iat": now,
        "exp": now + 120,
    }
    if manage:
        claims["capabilities"].append("datasets.manage" if directory else "ledger.manage")
    if not directory:
        claims.update(dataset_id="official", version=1)
    claims.update(changes)
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    return f"{encoded}.{signature}"


def headers(workspace, **kwargs):
    return {"authorization": f"Bearer {token(workspace, **kwargs)}"}


def plan(**changes):
    return {
        "dataset_id": "official",
        "name": "正式导入",
        "source_kind": "import",
        "idempotency_key": "create-official",
        "confirmed_by_user": True,
        **changes,
    }


@pytest.fixture(scope="module")
def http_database():
    url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL")
    if not url:
        pytest.fail("Use trusted isolated test:backend; do not use the daily database.")
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    with psycopg.connect(url, autocommit=True) as connection:
        migrate_all(connection)
        connection.execute("CREATE ROLE bi_http_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA bi TO bi_http_app")
        connection.execute("GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA bi TO bi_http_app")
        connection.execute("REVOKE ALL ON bi.schema_migrations FROM bi_http_app")
    return url.replace("ledger_test_admin@", "bi_http_app@"), url


@pytest.fixture
def client(http_database):
    app_url, admin = http_database
    settings = BiSettings(app_url, SECRET, True)
    with TestClient(create_app(bi_settings=settings)) as browser:
        yield browser, f"http-{uuid4()}", settings, admin


def test_http_directory_creation_persisted_conflicts_and_foreign_header_cannot_grant_scope(client):
    browser, workspace, _, _ = client
    auth = {**headers(workspace), "x-user-id": "foreign", "x-workspace-id": "foreign"}
    assert browser.get(PREFIX + "/datasets", headers=auth).json()["data"]["total"] == 0
    result = browser.post(PREFIX + "/datasets", headers=auth, json=plan())
    assert result.status_code == 200 and result.json()["data"]["workspace_id"] == workspace
    assert result.json()["data"]["source_kind"] == "import"
    assert "尚未导入" in result.json()["data"]["notice"]
    assert browser.post(PREFIX + "/datasets", headers=auth, json=plan()).json() == result.json()
    assert (
        browser.post(PREFIX + "/datasets", headers=auth, json=plan(name="覆盖名称")).status_code
        == 409
    )
    listing = browser.get(PREFIX + "/datasets", headers=auth)
    assert listing.json()["data"]["total"] == 1
    assert listing.json()["data"]["rows"][0]["name"] == "正式导入"
    assert "no-store" in listing.headers["cache-control"]
    assert listing.headers["x-content-type-options"] == "nosniff"
    assert len(listing.headers["x-request-id"]) == 36
    assert (
        browser.get(PREFIX + "/datasets", headers=headers("foreign")).json()["data"]["total"] == 0
    )
    assert SECRET not in listing.text and auth["authorization"] not in listing.text


def test_selected_dataset_metadata_cannot_be_forged_or_read_across_workspaces(client):
    browser, workspace, _, _ = client
    auth = headers(workspace)
    assert browser.post(PREFIX + "/datasets", headers=auth, json=plan()).status_code == 200
    selected = browser.get(PREFIX + "/datasets/official", headers=auth)
    assert selected.status_code == 200
    assert selected.json()["data"]["workspace_id"] == workspace
    assert selected.json()["data"]["version"] == 1
    assert browser.get(PREFIX + "/datasets/official", headers=headers("foreign")).status_code == 403
    assert (
        browser.get(
            PREFIX + "/datasets/official", headers=headers(workspace, directory=False)
        ).status_code
        == 403
    )
    assert (
        browser.get(PREFIX + "/datasets/official?actor_id=admin", headers=auth).status_code == 422
    )


def test_signed_full_batch_history_and_private_errors_for_direct_imports(client):
    browser, workspace, settings, _ = client
    assert (
        browser.post(PREFIX + "/datasets", headers=headers(workspace), json=plan()).status_code
        == 200
    )
    scope = LedgerScope(
        workspace, "official", "http-user", 1, frozenset({"ledger.read", "ledger.manage"})
    )
    with settings.connection() as connection:
        preview = preview_import(
            connection,
            scope,
            [
                # Missing required product name: invalid input stays private to its submitter.
                CsvFile(
                    "products",
                    "private-file.csv",
                    b"template_version,product_id,name,category,series\n1,001,,test,\n",
                )
            ],
        )
    auth = headers(workspace, directory=False)
    listed = browser.get(PREFIX + "/batches", headers=auth)
    assert listed.status_code == 200 and listed.json()["data"]["total"] == 1
    batch_id = preview["batch_id"]
    detail = browser.get(PREFIX + f"/batches/{batch_id}", headers=auth)
    assert detail.status_code == 200 and detail.json()["data"]["batch"]["state"] == "rejected"
    assert detail.json()["data"]["batch"]["errors"]
    assert "actor_id" not in detail.json()["data"]["batch"]
    other = browser.get(
        PREFIX + f"/batches/{batch_id}",
        headers=headers(workspace, directory=False, actor_id="other"),
    )
    assert other.status_code == 200 and "private-file" not in other.text
    download = browser.get(PREFIX + f"/batches/{batch_id}/errors", headers=auth)
    assert download.status_code == 200 and download.headers["content-type"].startswith("text/csv")
    assert (
        browser.get(
            PREFIX + f"/batches/{batch_id}/errors",
            headers=headers(workspace, directory=False, actor_id="other"),
        ).status_code
        == 403
    )
    assert browser.get(PREFIX + "/batches", headers=headers(workspace)).status_code == 403
    assert (
        browser.get(PREFIX + "/batches", headers=headers("foreign", directory=False)).status_code
        == 403
    )
    for suffix in ("?page=0", "?page=1&page=2", "?actor_id=forged"):
        assert browser.get(PREFIX + "/batches" + suffix, headers=auth).status_code == 422
    assert browser.get(PREFIX + f"/batches/{batch_id}?page=1", headers=auth).status_code == 422
    assert "no-store" in detail.headers["cache-control"]


@pytest.mark.parametrize("kind", ["missing", "forged", "expired", "purpose", "self_identity"])
def test_directory_rejects_unsigned_expired_wrong_purpose_and_self_reported_identity(client, kind):
    browser, workspace, _, _ = client
    options = {
        "missing": {},
        "forged": {"authorization": "Bearer forged.signature"},
        "expired": headers(workspace, exp=int(time.time()) - 1),
        "purpose": headers(workspace, directory=False),
        "self_identity": {"x-workspace-id": workspace, "x-actor-id": "http-user"},
    }
    response = browser.get(PREFIX + "/datasets", headers=options[kind])
    assert response.status_code == 403 and response.json()["error"] == "BI_SCOPE_DENIED"


def test_read_permission_and_explicit_confirmation_required_before_creation(client):
    browser, workspace, _, _ = client
    assert (
        browser.post(
            PREFIX + "/datasets", headers=headers(workspace, manage=False), json=plan()
        ).status_code
        == 403
    )
    assert (
        browser.post(
            PREFIX + "/datasets", headers=headers(workspace), json=plan(confirmed_by_user=False)
        ).status_code
        == 403
    )
    assert (
        browser.get(PREFIX + "/datasets", headers=headers(workspace)).json()["data"]["total"] == 0
    )


@pytest.mark.parametrize(
    "change",
    [
        {"confirmed_by_user": "yes"},
        {"actor_id": "other"},
        {"workspace_id": "other"},
        {"demo_allowed": True},
        {"name": {"private": "secret-cell"}},
        {"source_kind": "unknown"},
        {"dataset_id": "../foreign"},
        {"idempotency_key": []},
    ],
)
def test_creation_strict_input_rejects_extra_identity_mode_and_echoes_no_cells(client, change):
    browser, workspace, _, _ = client
    response = browser.post(PREFIX + "/datasets", headers=headers(workspace), json=plan(**change))
    assert response.status_code == 422
    assert "secret-cell" not in response.text and "input" not in response.json()


@pytest.mark.parametrize(
    "query",
    [
        "page=0",
        "page_size=101",
        "page=1&page=2",
        "actor_id=other",
        "source_kind=unknown",
        "page=１",
    ],
)
def test_directory_query_parameters_are_bounded_and_unambiguous(client, query):
    browser, workspace, _, _ = client
    assert browser.get(PREFIX + "/datasets?" + query, headers=headers(workspace)).status_code == 422


def test_all_twelve_csv_templates_and_catalog_are_authenticated_and_exact(client):
    browser, workspace, _, _ = client
    catalog = browser.get(PREFIX + "/catalog", headers=headers(workspace, manage=False))
    assert catalog.status_code == 200 and len(catalog.json()["data"]["templates"]) == 12
    assert catalog.json()["data"]["metrics"][0]["name"] == "付款成交金额"
    for resource in SPECS:
        response = browser.get(PREFIX + f"/templates/{resource}", headers=headers(workspace))
        assert response.content == standard_csv(resource, [])
        assert response.headers["content-disposition"].endswith(f'{resource}-v1.csv"')
        assert browser.get(PREFIX + f"/templates/{resource}").status_code == 403
    assert browser.get(PREFIX + "/templates/secret", headers=headers(workspace)).status_code == 422
    assert (
        browser.get(PREFIX + "/catalog?sql=select", headers=headers(workspace)).status_code == 422
    )


def test_signed_query_matches_same_version_core_exact_decimals_and_immutable_sources(client):
    browser, workspace, config, _ = client
    assert (
        browser.post(
            PREFIX + "/datasets",
            headers=headers(workspace),
            json=plan(dataset_id="demo", source_kind="demo"),
        ).status_code
        == 200
    )
    scope = LedgerScope(
        workspace, "demo", "http-user", 1, frozenset({"ledger.read", "ledger.manage"})
    )
    source = generate_demo(DemoPlan("2026-01-01", days=7, sku_count=10, order_count=30))
    with config.connection() as connection:
        preview = preview_import(connection, scope, demo_files(source))
        assert preview["state"] == "preview", preview["errors"]
        result = confirm_import(
            connection, scope, preview["preview_id"], "import-demo", confirmed_by_user=True
        )
        assert result["version"] == 2
    auth = headers(workspace, directory=False, dataset_id="demo", version=2)
    # Day one deliberately lacks foreign FX; use the remaining known-revenue days
    # while preserving missing mapping/cost as unknown, rather than inventing inputs.
    query = {"dimension": "store", "start": "2026-01-02", "end": "2026-01-07"}
    response = browser.post(PREFIX + "/query", headers=auth, json=query)
    assert response.status_code == 200
    with config.connection() as connection:
        expected = query_ledger(
            connection,
            LedgerScope(workspace, "demo", "http-user", 2, scope.capabilities),
            Query(**query),
        )
    assert response.json()["data"] == expected
    metrics = expected["summary"]["metrics"]
    assert isinstance(metrics["sales_amount"], str) and "." in metrics["sales_amount"]
    # Deliberate missing cost remains unknown, not zero; no model needed for exact calculation.
    assert expected["summary"]["quality"]["unknown_cost_lines"] > 0
    assert metrics["contribution_profit"] is None
    stale = browser.post(
        PREFIX + "/query",
        headers=headers(workspace, directory=False, dataset_id="demo", version=1),
        json=query,
    )
    assert stale.status_code == 409
    assert (
        browser.post(PREFIX + "/query", headers=headers(workspace), json=query).status_code == 403
    )
    assert (
        browser.post(
            PREFIX + "/query",
            headers=headers("other", directory=False, dataset_id="demo", version=2),
            json=query,
        ).status_code
        == 403
    )
    assert (
        browser.get(PREFIX + "/datasets", headers=headers(workspace)).json()["data"]["rows"][0][
            "version"
        ]
        == 2
    )


@pytest.mark.parametrize(
    "body",
    [
        {"sql": "SELECT secret FROM private"},
        {"dimension": []},
        {"metrics": [{}]},
        {"metrics": ["fake"]},
        {"page": True},
        {"page_size": 101},
        {"page": 1000001},
        {"channel_ids": ["../foreign"]},
        {"start": "2026-02-30"},
        {"sort": {}},
    ],
)
def test_query_is_whitelisted_and_never_accepts_arbitrary_sql(client, body):
    browser, workspace, _, _ = client
    response = browser.post(
        PREFIX + "/query", headers=headers(workspace, directory=False), json=body
    )
    assert response.status_code == 422 and "SELECT" not in response.text


def test_request_media_duplicate_fields_declared_and_streamed_limits(client):
    browser, workspace, _, _ = client
    auth = headers(workspace)
    assert (
        browser.post(PREFIX + "/datasets", headers=auth, content="private-raw").status_code == 415
    )
    typed = {**auth, "content-type": "application/json"}
    assert (
        browser.post(
            PREFIX + "/datasets", headers=typed, content='{"name":"a","name":"secret-cell"}'
        ).status_code
        == 422
    )
    assert (
        browser.post(
            PREFIX + "/datasets", headers={**typed, "content-encoding": "gzip"}, content="{}"
        ).status_code
        == 415
    )
    declared = browser.post(
        PREFIX + "/datasets",
        headers={**typed, "content-length": str(MAX_JSON_BYTES + 1)},
        content="{}",
    )
    assert declared.status_code == 413
    streamed = browser.post(
        PREFIX + "/datasets",
        headers={**typed, "content-length": "2"},
        content=b" " * (MAX_JSON_BYTES + 1),
    )
    assert streamed.status_code == 413 and "private-raw" not in streamed.text


def test_no_fallback_no_runtime_admin_no_startup_ddl_and_demo_server_switch(client, monkeypatch):
    _, workspace, config, admin = client
    monkeypatch.setenv("DATABASE_URL", admin)
    monkeypatch.delenv("SHOPGATE_BI_DATABASE_URL", raising=False)
    monkeypatch.setenv("SHOPGATE_BI_SERVICE_SECRET", SECRET)
    # Constructing/startup app is never a database migration or source generation.
    with TestClient(create_app()) as browser:
        response = browser.get(PREFIX + "/datasets", headers=headers(workspace))
        assert response.status_code == 503 and admin not in response.text
    with TestClient(create_app(bi_settings=BiSettings(admin, SECRET))) as browser:
        assert browser.get(PREFIX + "/datasets", headers=headers(workspace)).status_code == 503
    with TestClient(
        create_app(bi_settings=BiSettings(config.database_url, SECRET, False))
    ) as browser:
        assert (
            browser.post(
                PREFIX + "/datasets", headers=headers(workspace), json=plan(source_kind="demo")
            ).status_code
            == 403
        )
        assert (
            browser.post(PREFIX + "/datasets", headers=headers(workspace), json=plan()).status_code
            == 200
        )


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("private SQL password=secret-cell"),
        psycopg.OperationalError("private DSN secret-cell"),
    ],
)
def test_unexpected_and_database_errors_are_redacted_from_response_and_log(
    client, monkeypatch, caplog, error
):
    browser, workspace, _, _ = client

    def broken(_):
        raise error

    monkeypatch.setattr(BiSettings, "connection", broken)
    response = browser.get(PREFIX + "/datasets", headers=headers(workspace))
    assert response.status_code in {500, 503}
    assert "secret-cell" not in response.text + caplog.text
    assert "password" not in response.text + caplog.text
    assert "authorization" not in response.json()
