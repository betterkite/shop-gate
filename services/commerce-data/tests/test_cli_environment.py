from __future__ import annotations

import os

from shopgate_commerce_data.cli import load_commerce_environment


def test_commerce_environment_uses_allowlist_and_local_precedence(tmp_path, monkeypatch) -> None:
    (tmp_path / ".env").write_text(
        "REDIS_URL=redis://base:6379/0\nDEEPSEEK_API_KEY=must-not-enter-commerce-process\n",
        encoding="utf8",
    )
    (tmp_path / ".env.local").write_text(
        "REDIS_URL=redis://local:6379/0\nSHOPGATE_REDIS_REQUIRED=1\n",
        encoding="utf8",
    )
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("SHOPGATE_REDIS_REQUIRED", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    load_commerce_environment(tmp_path)

    assert os.environ["REDIS_URL"] == "redis://local:6379/0"
    assert os.environ["SHOPGATE_REDIS_REQUIRED"] == "1"
    assert "DEEPSEEK_API_KEY" not in os.environ


def test_commerce_environment_never_overrides_injected_runtime_secret(
    tmp_path, monkeypatch
) -> None:
    (tmp_path / ".env").write_text("REDIS_URL=redis://file:6379/0\n", encoding="utf8")
    monkeypatch.setenv("REDIS_URL", "rediss://injected:6380/0")

    load_commerce_environment(tmp_path)

    assert os.environ["REDIS_URL"] == "rediss://injected:6380/0"


def test_bi_configuration_allowlist_preserves_injected_database_and_no_model_secret(
    tmp_path, monkeypatch
):
    (tmp_path / ".env.local").write_text(
        "SHOPGATE_BI_DATABASE_URL=postgresql://file-value\n"
        "SHOPGATE_BI_DEMO_ENABLED=1\n"
        "SHOPGATE_BI_SERVICE_SECRET=bi-service-test-only\n"
        "OPENAI_API_KEY=must-not-load\n",
        encoding="utf8",
    )
    monkeypatch.setenv("SHOPGATE_BI_DATABASE_URL", "postgresql://injected-runtime")
    for key in ("SHOPGATE_BI_DEMO_ENABLED", "SHOPGATE_BI_SERVICE_SECRET", "OPENAI_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    load_commerce_environment(tmp_path)
    assert os.environ["SHOPGATE_BI_DATABASE_URL"] == "postgresql://injected-runtime"
    assert os.environ["SHOPGATE_BI_DEMO_ENABLED"] == "1"
    assert os.environ["SHOPGATE_BI_SERVICE_SECRET"] == "bi-service-test-only"
    assert "OPENAI_API_KEY" not in os.environ
