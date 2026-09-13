from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from dotenv import dotenv_values

COMMERCE_ENVIRONMENT_KEYS = {
    "DATABASE_URL",
    "SHOPGATE_DATABASE_ENABLED",
    "SHOPGATE_DATABASE_REQUIRED",
    "SHOPGATE_DEGRADATION_MODE",
    "SHOPGATE_COMMERCE_HOST",
    "SHOPGATE_COMMERCE_PORT",
    "SHOPGATE_COMMERCE_RELOAD",
    "SHOPGATE_REDIS_CACHE_ENABLED",
    "SHOPGATE_REDIS_REQUIRED",
    "REDIS_NAMESPACE",
    "REDIS_URL",
}


def load_commerce_environment(root: Path | None = None) -> None:
    """Load only the environment values owned by the isolated commerce service."""
    project_root = root or Path(__file__).resolve().parents[4]
    configured: dict[str, str] = {}
    for env_file in (project_root / ".env", project_root / ".env.local"):
        if not env_file.is_file():
            continue
        for key, value in dotenv_values(env_file).items():
            if key in COMMERCE_ENVIRONMENT_KEYS and value is not None:
                configured[key] = value
    for key, value in configured.items():
        os.environ.setdefault(key, value)


def main() -> None:
    load_commerce_environment()
    host = os.getenv("SHOPGATE_COMMERCE_HOST", "127.0.0.1")
    port = int(os.getenv("SHOPGATE_COMMERCE_PORT", "8000"))
    uvicorn.run(
        "shopgate_commerce_data.api:app",
        host=host,
        port=port,
        reload=os.getenv("SHOPGATE_COMMERCE_RELOAD", "0") == "1",
    )


if __name__ == "__main__":
    main()
