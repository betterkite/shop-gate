"""Worker configuration is explicit and independent of the Web/API dotenv files."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

WORKER_KEYS = frozenset(
    {
        "SHOPGATE_BI_WORKER_DATABASE_URL",
        "SHOPGATE_BI_SERVICE_SECRET",
        "SHOPGATE_BI_AUTH_ORIGIN",
        "SHOPGATE_BI_DEMO_ENABLED",
    }
)


def load_worker_environment() -> None:
    """Use inherited dedicated settings, or an explicitly selected private file.

    No discovery of .env/.env.local, no shared DATABASE_URL fallback, and no
    interpolation from the Web's authentication/model/administrator environment.
    File values never override settings already supplied by the service manager.
    """
    selected = os.environ.get("SHOPGATE_BI_WORKER_ENV_FILE")
    if not selected:
        return
    try:
        source = Path(selected)
        if not source.is_file():
            raise ValueError("missing")
        values = dotenv_values(source, interpolate=False)
        if set(values) - WORKER_KEYS or any(value is None for value in values.values()):
            raise ValueError("unsupported")
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError("经营worker配置文件无效，请使用独立的四项配置模板。") from error
    for key, value in values.items():
        os.environ.setdefault(key, value)
