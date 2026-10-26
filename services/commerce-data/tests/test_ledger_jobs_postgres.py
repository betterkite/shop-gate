"""Durable queue on owned PG18, including actual worker-process crash/recovery.

The first loopback fixture below is explicitly a signed service test double.
The real_node_authorizer fixture runs the actual Node handler/Prisma authorization
against real sessions, users, policies and memberships in the owned PG18 database.
Neither fixture replaces actual Next/login/browser acceptance before #87 closes.
"""

import base64
import json
import os
import select
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from test_ledger_exchange_postgres import files as golden_files

from shopgate_commerce_data.api import create_app
from shopgate_commerce_data.ledger.csv_contract import SPECS, CsvFile, standard_csv
from shopgate_commerce_data.ledger.datasets import DatasetPlan, create_dataset
from shopgate_commerce_data.ledger.exchange import export_csv12
from shopgate_commerce_data.ledger.job_scope import (
    AUTH_FIELDS,
    CurrentAuthorization,
    JobScope,
    authorization_claims,
    sign_claims,
)
from shopgate_commerce_data.ledger.jobs import (
    change_job,
    claim_job,
    download_job_output,
    execute_job,
    read_jobs,
    submit_job,
)
from shopgate_commerce_data.ledger.migrations import migrate_all
from shopgate_commerce_data.ledger.operations import OperationConflict, bind_scope
from shopgate_commerce_data.ledger.query import Query, query_ledger
from shopgate_commerce_data.ledger.scope import DirectoryScope, ScopeError, _verified_claims
from shopgate_commerce_data.routers.bi import BiSettings

SECRET = "durable-jobs-test-key-not-an-external-credential"


def authorized(job, phase):
    now = int(time.time())
    return sign_claims(
        {
            **authorization_claims(job, phase, now=now),
            "aud": "shopgate-bi-job-grant-v1",
            "capabilities": ["job.authorized"],
            "exp": now + 20,
        },
        SECRET,
    )


@pytest.fixture(scope="module")
def cluster():
    url = os.getenv("SHOPGATE_LEDGER_TEST_DATABASE_URL")
    if not url:
        pytest.fail("Use trusted isolated test:backend, never a daily DB.")
    assert url.startswith("postgresql://ledger_test_admin@127.0.0.1:")
    with psycopg.connect(url, autocommit=True) as connection:
        migrate_all(connection)
        connection.execute("CREATE ROLE jobs_app LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("CREATE ROLE jobs_worker LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT shopgate_bi_worker TO jobs_worker")
    return url


@pytest.fixture
def context(cluster):
    # Each test owns a fresh DB so the global dispatch queue cannot pick another test's job.
    name = "bi_jobs_test_" + uuid4().hex
    with psycopg.connect(cluster, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    admin = cluster.rsplit("/", 1)[0] + "/" + name
    with psycopg.connect(admin, autocommit=True) as connection:
        migrate_all(connection)
        for role in ("jobs_app", "jobs_worker"):
            connection.execute(
                sql.SQL("GRANT USAGE ON SCHEMA bi TO {}").format(sql.Identifier(role))
            )
            connection.execute(
                sql.SQL(
                    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA bi TO {}"
                ).format(sql.Identifier(role))
            )
            connection.execute(
                sql.SQL("REVOKE ALL ON bi.schema_migrations FROM {}").format(sql.Identifier(role))
            )
    app = admin.replace("ledger_test_admin@", "jobs_app@")
    worker = admin.replace("ledger_test_admin@", "jobs_worker@")
    directory = DirectoryScope(
        "jobs-space", "operator", frozenset({"datasets.read", "datasets.manage"})
    )
    with psycopg.connect(app, autocommit=True) as connection:
        for dataset, kind in (("official", "import"), ("demo", "demo")):
            create_dataset(
                connection,
                directory,
                DatasetPlan(dataset, dataset, kind),
                "create-" + dataset,
                confirmed_by_user=True,
                demo_allowed=True,
            )
    scope = JobScope(
        "jobs-space",
        "official",
        "operator",
        1,
        frozenset({"jobs.read", "jobs.manage"}),
        "session-original",
    )
    return scope, app, worker, admin


def submit(context, kind="preview_import", parameters=None, key=None, source=None):
    scope, app, _, _ = context
    source = (
        golden_files()
        if source is None and kind == "preview_import"
        else []
        if source is None
        else source
    )
    with psycopg.connect(app, autocommit=True) as connection:
        return submit_job(
            connection,
            scope,
            kind,
            parameters or {},
            key or str(uuid4()),
            files=source,
            demo_allowed=True,
        )


def process(context, authorize=authorized, *, demo_allowed=True):
    _, _, worker, _ = context
    with psycopg.connect(worker, autocommit=True) as connection:
        job = claim_job(connection, "worker-one")
        assert job is not None
        execute_job(connection, job, "worker-one", authorize, SECRET, demo_allowed=demo_allowed)
        return job["job_id"]


def status(context, job_id):
    scope, app, _, _ = context
    with psycopg.connect(app, autocommit=True) as connection:
        return read_jobs(connection, scope, job_id=job_id)


def test_complete_preview_manual_money_confirmation_and_all_twelve_exports(context):
    scope, app, _, _ = context
    job = submit(context)
    assert job["state"] == "queued" and "session_id" not in job and "payload" not in job
    process(context)
    preview = status(context, job["job_id"])
    assert preview["state"] == "ready_preview"
    assert preview["result"]["preview_expires_at"]
    assert preview["result"]["template_version"] == "1"
    assert len(preview["result"]["source_files"]) == 12
    impact = preview["result"]["impact"]
    assert impact["before"]["metrics"]["net_sales"] == "0.00"
    assert impact["after"]["metrics"]["net_sales"] == "164.00"
    assert impact["after"]["metrics"]["contribution_profit"] == "121.00"
    with psycopg.connect(app, autocommit=True) as connection:
        original = query_ledger(connection, scope.ledger(), Query())
        assert original["summary"]["metrics"]["order_count"] == 0 and original["version"] == 1
    confirm = submit(
        context,
        "confirm_import",
        {"preview_id": preview["result"]["preview_id"], "confirmed_by_user": True},
    )
    process(context)
    committed = status(context, confirm["job_id"])
    assert committed["state"] == "committed" and committed["result"]["version"] == 2
    current = (replace(scope, version=2), *context[1:])
    with psycopg.connect(app, autocommit=True) as connection:
        actual = query_ledger(
            connection, current[0].ledger(), Query(start="0001-01-01", end="9999-12-31")
        )
        assert actual["summary"] == impact["after"]
    export = submit(
        current,
        "export_standard",
        {"resources": list(SPECS)},
    )
    process(current)
    done = status(current, export["job_id"])
    assert done["state"] == "completed" and len(done["result"]["files"]) == 12
    with psycopg.connect(app, autocommit=True) as connection:
        canonical = export_csv12(connection, current[0].ledger())
        for resource in SPECS:
            assert (
                download_job_output(connection, current[0], export["job_id"], resource)
                == canonical["files"][resource]
            )
        assert (
            change_job(connection, current[0], confirm["job_id"], action="cancel")["state"]
            == "committed"
        )
        with connection.transaction():
            bind_scope(connection, current[0].ledger())
            assert connection.execute("SELECT count(*) FROM bi.audit_events").fetchone()[0] == 1


def test_idempotency_private_owner_scope_full_pagination_and_input_is_immutable(context):
    scope, app, worker, _ = context
    job = submit(context, key="same")
    assert submit(context, key="same") == job
    with psycopg.connect(app, autocommit=True) as connection:
        with pytest.raises(OperationConflict):
            submit_job(connection, scope, "export_standard", {"resources": ["products"]}, "same")
        for index in range(23):
            created = submit_job(
                connection, scope, "export_standard", {"resources": ["products"]}, f"export-{index}"
            )
            change_job(connection, scope, created["job_id"], action="cancel")
        first, second = read_jobs(connection, scope), read_jobs(connection, scope, page=2)
        assert first["total"] == second["total"] == 24
        assert len(first["rows"]) == 20 and len(second["rows"]) == 4
        for other in (replace(scope, actor_id="other"), replace(scope, dataset_id="demo")):
            assert read_jobs(connection, other)["rows"] == []
            with pytest.raises(ScopeError):
                read_jobs(connection, other, job_id=job["job_id"])
        assert connection.execute("SELECT * FROM bi.jobs").fetchall() == []
        assert connection.execute("SELECT * FROM bi.job_files").fetchall() == []
        with connection.transaction():
            bind_scope(connection, scope.ledger())
            connection.execute("SELECT set_config('shopgate.actor_id',%s,true)", (scope.actor_id,))
            with pytest.raises(psycopg.errors.CheckViolation), connection.transaction():
                connection.execute(
                    "UPDATE bi.jobs SET payload='{}' WHERE job_id=%s", (job["job_id"],)
                )
    # Dispatcher can see queue inputs but cannot see any unbound trading facts.
    with psycopg.connect(worker, autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.jobs").fetchone()[0] == 24
        for table in ("datasets", "products", "orders", "order_lines", "line_snapshots"):
            assert (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM bi.{}").format(sql.Identifier(table))
                ).fetchone()[0]
                == 0
            )


def test_parallel_claims_do_not_duplicate_held_job_or_allow_app_dispatch(context):
    scope, app, worker, admin = context
    job = submit(context)
    with psycopg.connect(app, autocommit=True) as connection, pytest.raises(ScopeError):
        claim_job(connection, "app")
    with psycopg.connect(admin, autocommit=True) as connection, pytest.raises(ScopeError):
        claim_job(connection, "admin")
    with psycopg.connect(worker, autocommit=True) as first:
        claimed = claim_job(first, "one", lease_seconds=1)
        assert claimed["job_id"] == job["job_id"]
        time.sleep(1.1)

        def another(index):
            with psycopg.connect(worker, autocommit=True) as connection:
                return claim_job(connection, f"other-{index}")

        with ThreadPoolExecutor(max_workers=3) as pool:
            assert list(pool.map(another, range(3))) == [None, None, None]
        with psycopg.connect(worker, autocommit=True) as different, pytest.raises(ScopeError):
            execute_job(different, claimed, "one", authorized, SECRET)
    # Closing the actual claimant connection releases its session lock; expired lease recovers.
    assert process(context) == job["job_id"]
    assert status(context, job["job_id"])["attempts"] == 2


@pytest.mark.parametrize("phase", ["start", "commit"])
def test_revoked_authority_rolls_back_preview_and_requires_explicit_new_session(context, phase):
    scope, app, _, admin = context
    job = submit(context)

    def revoked(job, requested):
        if requested == phase:
            raise ScopeError("private authority details must not leak")
        return authorized(job, requested)

    process(context, revoked)
    waiting = status(context, job["job_id"])
    assert waiting["state"] == "awaiting_auth" and "private" not in json.dumps(waiting)
    with psycopg.connect(admin, autocommit=True) as connection:
        for table in ("orders", "import_batches", "operation_previews"):
            assert (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM bi.{}").format(sql.Identifier(table))
                ).fetchone()[0]
                == 0
            )
    with psycopg.connect(app, autocommit=True) as connection:
        renewed = change_job(
            connection,
            replace(scope, session_id="session-new"),
            job["job_id"],
            action="reauthorize",
        )
        assert renewed["state"] == "queued"
    seen = []

    def fresh(job, requested):
        seen.append(job["session_id"])
        return authorized(job, requested)

    process(context, fresh)
    assert (
        set(seen) == {"session-new"} and status(context, job["job_id"])["state"] == "ready_preview"
    )


def test_revoked_commit_rolls_back_facts_version_operation_and_job_atomically(context):
    scope, app, _, admin = context
    preview = submit(context)
    process(context)
    confirm = submit(
        context,
        "confirm_import",
        {
            "preview_id": status(context, preview["job_id"])["result"]["preview_id"],
            "confirmed_by_user": True,
        },
    )

    def reject_commit(job, phase):
        if phase == "commit":
            raise ScopeError("revoked before commit")
        return authorized(job, phase)

    process(context, reject_commit)
    assert status(context, confirm["job_id"])["state"] == "awaiting_auth"
    with psycopg.connect(admin, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT version FROM bi.datasets WHERE dataset_id='official'"
            ).fetchone()[0]
            == 1
        )
        for table in ("orders", "operations", "audit_events"):
            assert (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM bi.{}").format(sql.Identifier(table))
                ).fetchone()[0]
                == 0
            )
    with psycopg.connect(app, autocommit=True) as connection:
        change_job(connection, scope, confirm["job_id"], action="reauthorize")
    process(context)
    assert status(context, confirm["job_id"])["result"]["version"] == 2


def test_cancel_queued_running_and_final_confirmation_with_no_partial_facts(context):
    scope, app, worker, admin = context
    queued = submit(context)
    with psycopg.connect(app, autocommit=True) as connection:
        assert (
            change_job(connection, scope, queued["job_id"], action="cancel")["state"] == "cancelled"
        )
    running = submit(context)

    def cancel_during_start(job, phase):
        if phase == "start":
            with psycopg.connect(app, autocommit=True) as connection:
                changed = change_job(connection, scope, job["job_id"], action="cancel")
                assert changed["state"] == "running" and changed["cancel_requested"]
        return authorized(job, phase)

    process(context, cancel_during_start)
    assert status(context, running["job_id"])["state"] == "cancelled"
    with psycopg.connect(admin, autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.import_batches").fetchone()[0] == 0
    prepared = submit(context)
    process(context)
    confirm = submit(
        context,
        "confirm_import",
        {
            "preview_id": status(context, prepared["job_id"])["result"]["preview_id"],
            "confirmed_by_user": True,
        },
    )
    process(context, cancel_during_start)
    assert status(context, confirm["job_id"])["state"] == "cancelled"
    with psycopg.connect(admin, autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 0


def test_bad_csv_is_rejected_with_private_formula_safe_error_download(context):
    scope, app, _, _ = context
    source = [
        CsvFile(
            "products",
            "p.csv",
            standard_csv("products", [{"product_id": "001", "name": "中文"}]),
        )
    ]
    source.append(
        CsvFile(
            "skus",
            "=danger.csv",
            standard_csv(
                "skus", [{"sku_id": "001", "product_id": "missing", "name": "规格", "unit": "件"}]
            ),
        )
    )
    job = submit(context, source=source)
    process(context)
    result = status(context, job["job_id"])
    assert result["state"] == "rejected"
    with psycopg.connect(app, autocommit=True) as connection:
        errors = download_job_output(connection, scope, job["job_id"], "errors").decode("utf-8-sig")
        assert "missing" not in errors and "shopgate" not in errors
        assert "'=danger.csv" in errors
        with pytest.raises(ScopeError):
            download_job_output(
                connection, replace(scope, actor_id="foreign"), job["job_id"], "errors"
            )


def test_commit_wins_concurrent_cancel_and_cannot_be_reported_cancelled(context):
    scope, app, _, admin = context
    prepared = submit(context)
    process(context)
    confirm = submit(
        context,
        "confirm_import",
        {
            "preview_id": status(context, prepared["job_id"])["result"]["preview_id"],
            "confirmed_by_user": True,
        },
    )
    at_commit, release = threading.Event(), threading.Event()

    def current(job, phase):
        if phase == "commit":
            at_commit.set()
            assert release.wait(5)
        return authorized(job, phase)

    def cancel():
        with psycopg.connect(app, autocommit=True) as connection:
            return change_job(connection, scope, confirm["job_id"], action="cancel")

    with ThreadPoolExecutor(max_workers=2) as pool:
        work = pool.submit(process, context, current)
        assert at_commit.wait(5)
        request = pool.submit(cancel)
        try:
            time.sleep(0.1)
            assert not request.done()  # Ordered behind the actual short commit row lock.
        finally:
            release.set()
        assert work.result(timeout=10) == confirm["job_id"]
        assert request.result(timeout=10)["state"] == "committed"
    assert status(context, confirm["job_id"])["state"] == "committed"
    with psycopg.connect(admin, autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.audit_events").fetchone()[0] == 1


def test_demo_plan_is_confirmed_new_empty_demo_only_and_never_auto_commits(context):
    scope, app, _, _ = context
    params = {
        "start_date": "2026-01-01",
        "days": 7,
        "sku_count": 10,
        "order_count": 30,
        "seed": 17,
        "confirmed_by_user": True,
    }
    with psycopg.connect(app, autocommit=True) as connection:
        with pytest.raises(OperationConflict):
            submit_job(
                connection, scope, "prepare_demo", params, "official-demo", demo_allowed=True
            )
        with pytest.raises(ScopeError):
            submit_job(
                connection,
                replace(scope, dataset_id="demo"),
                "prepare_demo",
                params,
                "disabled",
                demo_allowed=False,
            )
    demo = (replace(scope, dataset_id="demo"), *context[1:])
    job = submit(demo, "prepare_demo", params)
    process(demo)
    ready = status(demo, job["job_id"])
    assert ready["state"] == "ready_preview"
    assert ready["result"]["manifest"]["row_counts"]["skus"] == 10
    with psycopg.connect(app, autocommit=True) as connection:
        assert (
            query_ledger(connection, demo[0].ledger(), Query())["summary"]["metrics"]["order_count"]
            == 0
        )
        assert (
            query_ledger(connection, scope.ledger(), Query())["summary"]["metrics"]["order_count"]
            == 0
        )


def test_full_default_demo_durable_preview_confirm_matches_180_day_source_and_official_isolation(
    context,
):
    scope, app, _, _ = context
    demo = (replace(scope, dataset_id="demo"), *context[1:])
    prepared = submit(demo, "prepare_demo", {"start_date": "2026-01-01", "confirmed_by_user": True})
    process(demo)
    ready = status(demo, prepared["job_id"])
    assert ready["state"] == "ready_preview", {
        key: ready[key] for key in ("state", "error_code", "stage_label", "attempts")
    }
    manifest = ready["result"]["manifest"]
    assert manifest["row_counts"]["skus"] == 1000
    assert manifest["row_counts"]["products"] == 500
    assert manifest["row_counts"]["orders"] == 12000
    assert manifest["start_date"] == "2026-01-01" and manifest["end_date"] == "2026-06-29"
    with psycopg.connect(app, autocommit=True) as connection:
        assert (
            query_ledger(connection, demo[0].ledger(), Query())["summary"]["metrics"]["order_count"]
            == 0
        )
        assert query_ledger(connection, scope.ledger(), Query())["version"] == 1
    confirmed = submit(
        demo,
        "confirm_import",
        {"preview_id": ready["result"]["preview_id"], "confirmed_by_user": True},
    )
    process(demo)
    result = status(demo, confirmed["job_id"])
    assert result["state"] == "committed" and result["result"]["version"] == 2
    with psycopg.connect(app, autocommit=True) as connection:
        actual = query_ledger(
            connection,
            replace(demo[0], version=2).ledger(),
            Query(start="2026-01-01", end="2026-06-29"),
        )
        assert actual["summary"]["metrics"]["order_count"] == 11339
        all_source = query_ledger(
            connection,
            replace(demo[0], version=2).ledger(),
            Query(start="0001-01-01", end="9999-12-31"),
        )
        assert all_source["summary"] == ready["result"]["impact"]["after"]
        assert (
            query_ledger(connection, scope.ledger(), Query())["summary"]["metrics"]["order_count"]
            == 0
        )


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (psycopg.errors.QueryCanceled("private SQL password=hidden"), "BI_JOB_TIMEOUT"),
        (ValueError("private input contents"), "BI_JOB_INPUT_INVALID"),
        (OperationConflict("private conflict contents"), "BI_JOB_CONFLICT"),
        (psycopg.errors.InsufficientPrivilege("private SQL source"), "BI_JOB_FAILED"),
    ],
)
def test_failures_have_actionable_safe_category_and_logs_without_partial_records(
    context, monkeypatch, caplog, error, code
):
    import shopgate_commerce_data.ledger.jobs as jobs

    def reject(*args, **kwargs):
        raise error

    monkeypatch.setattr(jobs, "preview_import", reject)
    job = submit(context)
    process(context)
    failed = status(context, job["job_id"])
    assert failed["state"] == "failed" and failed["error_code"] == code
    assert "private" not in caplog.text and "hidden" not in caplog.text
    assert "private" not in json.dumps(failed) and job["job_id"] in caplog.text
    with psycopg.connect(context[3], autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.import_batches").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM bi.orders").fetchone()[0] == 0


def test_signed_http_job_submit_202_owner_isolation_state_and_download(context):
    scope, app, _, _ = context
    now = int(time.time())
    claim = {
        "aud": "shopgate-bi-jobs-v1",
        "workspace_id": scope.workspace_id,
        "dataset_id": scope.dataset_id,
        "actor_id": scope.actor_id,
        "session_id": scope.session_id,
        "version": 1,
        "capabilities": ["jobs.read", "jobs.manage"],
        "iat": now,
        "exp": now + 120,
    }
    headers = {"authorization": "Bearer " + sign_claims(claim, SECRET)}
    with TestClient(create_app(bi_settings=BiSettings(app, SECRET, True))) as browser:
        source = golden_files()
        payload = {
            "kind": "preview_import",
            "parameters": {},
            "idempotency_key": "http-import",
            "files": [
                {
                    "resource": f.resource,
                    "filename": f.filename,
                    "content_base64": base64.b64encode(f.content).decode(),
                }
                for f in source
            ],
        }
        response = browser.post("/api/v1/bi/jobs", headers=headers, json=payload)
        assert response.status_code == 202
        job_id = response.json()["data"]["job_id"]
        assert "session_id" not in response.text and "content_base64" not in response.text
        process(context)
        assert (
            browser.get(f"/api/v1/bi/jobs/{job_id}", headers=headers).json()["data"]["state"]
            == "ready_preview"
        )
        assert browser.get("/api/v1/bi/jobs?page=1", headers=headers).json()["data"]["total"] == 1
        foreign = {
            "authorization": "Bearer " + sign_claims({**claim, "actor_id": "foreign"}, SECRET)
        }
        assert browser.get(f"/api/v1/bi/jobs/{job_id}", headers=foreign).status_code == 403
        assert (
            browser.post(
                "/api/v1/bi/jobs", headers=headers, json={**payload, "actor_id": "forged"}
            ).status_code
            == 422
        )
        assert (
            browser.post(
                "/api/v1/bi/jobs",
                headers=headers,
                json={
                    **payload,
                    "idempotency_key": "bad",
                    "files": [
                        {"resource": "products", "filename": "a.csv", "content_base64": "!!"}
                    ],
                },
            ).status_code
            == 422
        )
        assert browser.get("/api/v1/bi/jobs").status_code == 403


def test_actual_crashed_claimant_process_and_new_worker_recover_from_durable_lease(context):
    scope, app, worker, _ = context
    job = submit(
        context,
        source=[
            CsvFile(
                "products",
                "p.csv",
                standard_csv("products", [{"product_id": "0001", "name": "实际进程验证"}]),
            )
        ],
    )
    # Actual child exits after its claim transaction, before any preview or write.
    code = (
        "import os,psycopg; from shopgate_commerce_data.ledger.jobs import claim_job; "
        "c=psycopg.connect(os.environ['JOB_TEST_URL'],autocommit=True); "
        "j=claim_job(c,'crashed',lease_seconds=1); print(j['job_id'],flush=True); os._exit(17)"
    )
    environment = {**os.environ, "JOB_TEST_URL": worker}
    child = subprocess.run(
        [sys.executable, "-c", code], env=environment, capture_output=True, text=True, timeout=30
    )
    assert child.returncode == 17 and child.stdout.strip() == job["job_id"]
    assert status(context, job["job_id"])["state"] == "running"
    time.sleep(1.1)

    class Service(BaseHTTPRequestHandler):
        def do_POST(self):
            assert self.path == "/api/internal/bi/job-authorization"
            claims = _verified_claims(
                self.headers.get("authorization")[7:],
                SECRET,
                now=None,
                audience="shopgate-bi-job-auth-v1",
                fields=AUTH_FIELDS,
                capabilities=frozenset({"job.authorize"}),
            )
            assert claims["actor_id"] == scope.actor_id and claims["session_id"] == scope.session_id
            now = int(time.time())
            token = sign_claims(
                {
                    **claims,
                    "aud": "shopgate-bi-job-grant-v1",
                    "capabilities": ["job.authorized"],
                    "iat": now,
                    "exp": now + 20,
                },
                SECRET,
            )
            body = json.dumps({"success": True, "data": {"token": token}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass  # Do not print private service headers.

    server = ThreadingHTTPServer(("127.0.0.1", 0), Service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        environment = {
            **os.environ,
            "SHOPGATE_BI_WORKER_DATABASE_URL": worker,
            "SHOPGATE_BI_SERVICE_SECRET": SECRET,
            "SHOPGATE_BI_DEMO_ENABLED": "0",
            "SHOPGATE_BI_AUTH_ORIGIN": f"http://127.0.0.1:{server.server_port}",
        }
        result = subprocess.run(
            [sys.executable, "-m", "shopgate_commerce_data.ledger.worker", "--once"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=40,
        )
        assert result.returncode == 0, result.stderr
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    recovered = status(context, job["job_id"])
    assert recovered["state"] == "ready_preview" and recovered["attempts"] == 2
    with psycopg.connect(app, autocommit=True) as connection:
        assert query_ledger(connection, scope.ledger(), Query())["version"] == 1


def _node_test_environment():
    # No dotenv discovery, daily database URL, model configuration or bearer tokens.
    return {
        key: os.environ[key]
        for key in ("PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH")
        if key in os.environ
    }


@pytest.fixture
def real_node_authorizer(context):
    """Actual Prisma migrations and Node DAL; no auth/repository/handler mocks."""
    _, _, _, admin = context
    environment = {
        **_node_test_environment(),
        "DATABASE_URL": admin,
        "NODE_ENV": "test",
        "SHOPGATE_AUTH_MODE": "local",
        "SHOPGATE_AUTH_SECRET": "owned-pg-auth-fixture-not-an-external-secret",
        "SHOPGATE_BI_SERVICE_SECRET": SECRET,
        "BETTER_AUTH_URL": "http://127.0.0.1",
        "SHOPGATE_BI_AUTH_TEST_FIXTURE": "owned-pg18",
    }
    provision = subprocess.run(
        ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert provision.returncode == 0, "Actual Prisma migrations must apply to the fresh owned DB."
    with psycopg.connect(admin, autocommit=True) as connection:
        if not connection.execute(
            "SELECT 1 FROM pg_roles WHERE rolname='jobs_auth_reader'"
        ).fetchone():
            connection.execute("CREATE ROLE jobs_auth_reader LOGIN NOSUPERUSER NOBYPASSRLS")
        connection.execute("GRANT USAGE ON SCHEMA public TO jobs_auth_reader")
        connection.execute(
            "GRANT SELECT ON auth_users,auth_sessions,projects,project_memberships,"
            "permission_profiles,permission_profile_grants,user_permission_overrides "
            "TO jobs_auth_reader"
        )
        assert not connection.execute(
            "SELECT has_table_privilege('jobs_auth_reader','bi.orders','SELECT')"
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO permission_profiles(id,key,name,is_default,updated_at) "
            "VALUES('bi-member','member-default','测试经营成员',true,now())"
        )
        for permission in ("commerce.data.read", "commerce.operation.manage", "project.read"):
            connection.execute(
                "INSERT INTO permission_profile_grants(id,profile_id,permission_key,updated_at) "
                "VALUES(%s,'bi-member',%s,now())",
                (str(uuid4()), permission),
            )
        for actor in ("operator", "other-owner"):
            connection.execute(
                "INSERT INTO auth_users(id,name,email,permission_profile_id,updated_at) "
                "VALUES(%s,%s,%s,'bi-member',now())",
                (actor, actor, f"{actor}@owned.invalid"),
            )
        # Operator is an editor, never the owner/admin who would bypass role changes.
        connection.execute(
            "INSERT INTO projects(id,name,owner_id,updated_at) "
            "VALUES('jobs-space','经营权限集成测试','other-owner',now())"
        )
        connection.execute(
            "INSERT INTO project_memberships(id,project_id,user_id,role,updated_at) "
            "VALUES('operator-member','jobs-space','operator','editor',now())"
        )
        connection.execute(
            "INSERT INTO auth_sessions(id,user_id,token,expires_at,updated_at) "
            "VALUES('session-original','operator',%s,now()+interval '1 hour',now())",
            (uuid4().hex,),
        )
    environment["DATABASE_URL"] = admin.replace("ledger_test_admin@", "jobs_auth_reader@")
    with tempfile.TemporaryFile(mode="w+t") as errors:
        child = subprocess.Popen(
            ["node", "--import", "tsx", "scripts/checks/bi-job-authorization-fixture.ts"],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=errors,
            text=True,
        )
        try:
            deadline = time.monotonic() + 30
            origin = None
            while time.monotonic() < deadline:
                if select.select([child.stdout], [], [], 1)[0]:
                    line = child.stdout.readline()
                    assert line, "Actual Node authorization service exited before readiness."
                    try:
                        ready = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(ready, dict) and ready.get("role") == "jobs_auth_reader":
                        origin = ready["origin"]
                        break
                assert child.poll() is None, "Actual Node authorization fixture must remain alive."
            assert origin and origin.startswith("http://127.0.0.1:"), "Node readiness deadline."
            yield origin
        finally:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()


def _real_node_worker(context, origin):
    # Actual independent Python worker, with only its four explicit runtime settings.
    environment = {
        **_node_test_environment(),
        "SHOPGATE_BI_WORKER_DATABASE_URL": context[2],
        "SHOPGATE_BI_SERVICE_SECRET": SECRET,
        "SHOPGATE_BI_DEMO_ENABLED": "0",
        "SHOPGATE_BI_AUTH_ORIGIN": origin,
    }
    result = subprocess.run(
        [sys.executable, "-m", "shopgate_commerce_data.ledger.worker", "--once"],
        env=environment,
        capture_output=True,
        text=True,
        timeout=50,
    )
    assert result.returncode == 0, "Owned worker must complete without a substitute authorization."


@pytest.mark.parametrize(
    "revocation",
    [
        "session_deleted",
        "session_expired",
        "account_banned",
        "password_changed",
        "password_required",
        "policy_denied",
        "member_removed",
        "member_viewer",
    ],
)
def test_real_node_current_authority_at_commit_rolls_back_and_new_session_recovers(
    context, real_node_authorizer, revocation
):
    scope, app, _, admin = context
    preview_job = submit(context)
    _real_node_worker(context, real_node_authorizer)
    preview = status(context, preview_job["job_id"])
    assert preview["state"] == "ready_preview"
    assert preview["result"]["impact"]["after"]["metrics"]["contribution_profit"] == "121.00"
    confirmation = submit(
        context,
        "confirm_import",
        {"preview_id": preview["result"]["preview_id"], "confirmed_by_user": True},
    )
    current = CurrentAuthorization(real_node_authorizer, SECRET)
    phases = []

    def revoke_before_real_node_lookup(job, phase):
        phases.append(phase)
        if phase == "commit":
            statements = {
                "session_deleted": "DELETE FROM auth_sessions WHERE id='session-original'",
                "session_expired": "UPDATE auth_sessions SET expires_at=now()-interval '1 minute' "
                "WHERE id='session-original'",
                "account_banned": "UPDATE auth_users SET banned=true WHERE id='operator'",
                "password_changed": "UPDATE auth_users SET password_changed_at=now() "
                "WHERE id='operator'",
                "password_required": "UPDATE auth_users SET must_change_password=true "
                "WHERE id='operator'",
                "policy_denied": "INSERT INTO user_permission_overrides"
                "(id,user_id,permission_key,effect,updated_at) "
                "VALUES('deny-manage','operator','commerce.operation.manage','deny',now())",
                "member_removed": "DELETE FROM project_memberships WHERE user_id='operator'",
                "member_viewer": "UPDATE project_memberships SET role='viewer' "
                "WHERE user_id='operator'",
            }
            with psycopg.connect(admin, autocommit=True) as connection:
                connection.execute(statements[revocation])
        return current(job, phase)  # Real HTTP, actual Prisma, no fabricated grant.

    process(context, revoke_before_real_node_lookup)
    assert phases == ["start", "commit"]
    assert status(context, confirmation["job_id"])["state"] == "awaiting_auth"
    with psycopg.connect(admin, autocommit=True) as connection:
        assert (
            connection.execute(
                "SELECT version FROM bi.datasets WHERE dataset_id='official'"
            ).fetchone()[0]
            == 1
        )
        for table in ("orders", "operations", "audit_events"):
            assert (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM bi.{}").format(sql.Identifier(table))
                ).fetchone()[0]
                == 0
            )
        assert (
            connection.execute(
                "SELECT state FROM bi.import_batches WHERE batch_id=%s",
                (preview["result"]["batch_id"],),
            ).fetchone()[0]
            == "preview"
        )
        assert (
            connection.execute(
                "SELECT consumed_at FROM bi.operation_previews WHERE preview_id=%s",
                (preview["result"]["preview_id"],),
            ).fetchone()[0]
            is None
        )
        # Admin fixture restores current access, but never revives the old session.
        connection.execute("DELETE FROM auth_sessions WHERE user_id='operator'")
        connection.execute(
            "UPDATE auth_users SET banned=false,must_change_password=false,"
            "password_changed_at=NULL "
            "WHERE id='operator'"
        )
        connection.execute("DELETE FROM user_permission_overrides WHERE user_id='operator'")
        connection.execute("DELETE FROM project_memberships WHERE user_id='operator'")
        connection.execute(
            "INSERT INTO project_memberships(id,project_id,user_id,role,updated_at) "
            "VALUES('renewed-member','jobs-space','operator','editor',now())"
        )
        connection.execute(
            "INSERT INTO auth_sessions(id,user_id,token,expires_at,updated_at) "
            "VALUES('session-new','operator',%s,now()+interval '1 hour',now())",
            (uuid4().hex,),
        )
    renewed = (replace(scope, session_id="session-new"), *context[1:])
    # Restoring membership alone cannot revive a task bound to a deleted session.
    _real_node_worker(context, real_node_authorizer)
    assert status(context, confirmation["job_id"])["state"] == "awaiting_auth"
    with psycopg.connect(app, autocommit=True) as connection:
        change_job(connection, renewed[0], confirmation["job_id"], action="reauthorize")
    _real_node_worker(renewed, real_node_authorizer)
    done = status(renewed, confirmation["job_id"])
    assert done["state"] == "committed" and done["result"]["version"] == 2
    with psycopg.connect(app, autocommit=True) as connection:
        actual = query_ledger(
            connection,
            replace(renewed[0], version=2).ledger(),
            Query(start="0001-01-01", end="9999-12-31"),
        )
        assert actual["summary"] == preview["result"]["impact"]["after"]
    with psycopg.connect(admin, autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.audit_events").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM bi.operations").fetchone()[0] == 1


def test_real_node_rejects_forged_identity_and_revoked_session_before_preview(
    context, real_node_authorizer
):
    scope, _, worker, admin = context
    created = submit(context)
    with psycopg.connect(worker, autocommit=True) as connection:
        claimed = claim_job(connection, "real-auth-protocol")
        claims = authorization_claims(claimed, "start")
        url = real_node_authorizer + "/api/internal/bi/job-authorization"
        for changes in (
            {"aud": "shopgate-bi-v1"},
            {"actor_id": "other-owner"},
            {"workspace_id": "account:other-owner"},
            {"workspace_id": "unrelated-project"},
        ):
            response = httpx.post(
                url,
                headers={"authorization": "Bearer " + sign_claims({**claims, **changes}, SECRET)},
                timeout=5,
                trust_env=False,
            )
            assert response.status_code == 403
            assert response.json()["error"] == "BI_SCOPE_DENIED"
            assert response.headers["cache-control"] == "no-store, max-age=0"
            assert "token" not in response.json().get("data", {})
        response = httpx.post(url, headers={"cookie": "fake-session"}, timeout=5, trust_env=False)
        assert response.status_code == 403
        with psycopg.connect(admin, autocommit=True) as fixture:
            fixture.execute("DELETE FROM auth_sessions WHERE id='session-original'")
        execute_job(
            connection,
            claimed,
            "real-auth-protocol",
            CurrentAuthorization(real_node_authorizer, SECRET),
            SECRET,
        )
    assert status(context, created["job_id"])["state"] == "awaiting_auth"
    with psycopg.connect(admin, autocommit=True) as connection:
        for table in ("orders", "import_batches", "operation_previews", "audit_events"):
            assert (
                connection.execute(
                    sql.SQL("SELECT count(*) FROM bi.{}").format(sql.Identifier(table))
                ).fetchone()[0]
                == 0
            )
    assert scope.session_id == "session-original"


def test_real_node_current_viewer_can_export_but_cannot_preview(context, real_node_authorizer):
    _, _, _, admin = context
    with psycopg.connect(admin, autocommit=True) as connection:
        connection.execute("UPDATE project_memberships SET role='viewer' WHERE user_id='operator'")
        connection.execute(
            "INSERT INTO user_permission_overrides(id,user_id,permission_key,effect,updated_at) "
            "VALUES('deny-manage','operator','commerce.operation.manage','deny',now())"
        )
    export = submit(context, "export_standard", {"resources": ["products"]})
    _real_node_worker(context, real_node_authorizer)
    assert status(context, export["job_id"])["state"] == "completed"
    preview = submit(context)
    _real_node_worker(context, real_node_authorizer)
    assert status(context, preview["job_id"])["state"] == "awaiting_auth"
    with psycopg.connect(admin, autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM bi.operation_previews").fetchone()[0] == 0
