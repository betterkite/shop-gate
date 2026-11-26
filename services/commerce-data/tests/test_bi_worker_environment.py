"""The durable worker never discovers shared Web/model/administrator dotenv values."""

import os

import pytest

from shopgate_commerce_data.ledger.worker_environment import WORKER_KEYS, load_worker_environment


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    for key in (*WORKER_KEYS, "SHOPGATE_BI_WORKER_ENV_FILE", "DATABASE_URL", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(key, raising=False)


def test_no_implicit_root_environment_discovery(tmp_path, monkeypatch):
    for name in (".env", ".env.local"):
        (tmp_path / name).write_text(
            "DATABASE_URL=admin-private\nDEEPSEEK_API_KEY=model-private\n"
            "SHOPGATE_BI_WORKER_DATABASE_URL=shared-private\n",
            encoding="utf-8",
        )
    monkeypatch.chdir(tmp_path)
    load_worker_environment()
    assert not any(key in os.environ for key in (*WORKER_KEYS, "DATABASE_URL", "DEEPSEEK_API_KEY"))


def test_explicit_minimal_file_does_not_override_manager_settings(tmp_path, monkeypatch):
    source = tmp_path / "worker-private.env"
    source.write_text(
        "SHOPGATE_BI_WORKER_DATABASE_URL=worker-only\n"
        "SHOPGATE_BI_SERVICE_SECRET=file-only\n"
        "SHOPGATE_BI_AUTH_ORIGIN=http://127.0.0.1:3333\n"
        "SHOPGATE_BI_DEMO_ENABLED=0\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SHOPGATE_BI_WORKER_ENV_FILE", str(source))
    monkeypatch.setenv("SHOPGATE_BI_SERVICE_SECRET", "manager-only")
    load_worker_environment()
    assert os.environ["SHOPGATE_BI_WORKER_DATABASE_URL"] == "worker-only"
    assert os.environ["SHOPGATE_BI_SERVICE_SECRET"] == "manager-only"
    assert os.environ["SHOPGATE_BI_DEMO_ENABLED"] == "0"
    assert "DATABASE_URL" not in os.environ and "DEEPSEEK_API_KEY" not in os.environ


@pytest.mark.parametrize(
    "unexpected", ["DATABASE_URL=admin-private", "DEEPSEEK_API_KEY=model-private", "UNSET_KEY"]
)
def test_shared_or_incomplete_file_is_rejected_before_partial_loading(
    tmp_path, monkeypatch, unexpected
):
    source = tmp_path / "private.env"
    source.write_text("SHOPGATE_BI_SERVICE_SECRET=file-only\n" + unexpected, encoding="utf-8")
    monkeypatch.setenv("SHOPGATE_BI_WORKER_ENV_FILE", str(source))
    with pytest.raises(ValueError, match="独立的四项配置模板") as error:
        load_worker_environment()
    assert "private" not in str(error.value)
    assert "SHOPGATE_BI_SERVICE_SECRET" not in os.environ


def test_missing_explicit_file_fails_without_private_path_in_message(tmp_path, monkeypatch):
    monkeypatch.setenv("SHOPGATE_BI_WORKER_ENV_FILE", str(tmp_path / "private-missing"))
    with pytest.raises(ValueError, match="配置文件无效") as error:
        load_worker_environment()
    assert "private-missing" not in str(error.value)


def test_file_values_cannot_interpolate_an_administrator_dsn(tmp_path, monkeypatch):
    source = tmp_path / "worker.env"
    source.write_text("SHOPGATE_BI_WORKER_DATABASE_URL=${DATABASE_URL}\n", encoding="utf-8")
    monkeypatch.setenv("DATABASE_URL", "administrator-private")
    monkeypatch.setenv("SHOPGATE_BI_WORKER_ENV_FILE", str(source))
    load_worker_environment()
    assert os.environ["SHOPGATE_BI_WORKER_DATABASE_URL"] == "${DATABASE_URL}"
