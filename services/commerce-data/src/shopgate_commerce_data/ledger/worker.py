"""Independent durable BI worker. Startup never installs schema or generates data."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
from uuid import uuid4

from shopgate_commerce_data.cli import load_commerce_environment
from shopgate_commerce_data.ledger.job_scope import CurrentAuthorization
from shopgate_commerce_data.ledger.jobs import claim_job, execute_job
from shopgate_commerce_data.routers.bi import BiSettings

LOG = logging.getLogger(__name__)


def run_once(settings, authorize, *, worker_id=None):
    worker_id = worker_id or str(uuid4())
    with settings.connection() as connection:
        job = claim_job(connection, worker_id)
        if job is None:
            return False
        execute_job(
            connection,
            job,
            worker_id,
            authorize,
            settings.secret,
            demo_allowed=settings.demo_allowed,
        )
        return True


def main():
    parser = argparse.ArgumentParser(description="独立经营任务worker，不迁移或重置数据。")
    parser.add_argument("--once", action="store_true", help="只处理一个已持久化任务后退出")
    arguments = parser.parse_args()
    load_commerce_environment()
    secret = os.getenv("SHOPGATE_BI_SERVICE_SECRET", "")
    mode = os.getenv("SHOPGATE_BI_DEMO_ENABLED", "0")
    if mode not in {"0", "1"}:
        raise SystemExit("经营worker演示开关配置无效。")
    settings = BiSettings(os.getenv("SHOPGATE_BI_WORKER_DATABASE_URL", ""), secret, mode == "1")
    authorize = CurrentAuthorization(os.getenv("SHOPGATE_BI_AUTH_ORIGIN", ""), secret)
    worker_id = str(uuid4())
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        try:
            processed = run_once(settings, authorize, worker_id=worker_id)
        except Exception:
            # Unexpected failures leave a persisted lease for recovery. Never print DSNs/SQL.
            LOG.error("BI worker execution failed; inspect the private job state.")
            if arguments.once:
                raise SystemExit(1) from None
            processed = False
        if arguments.once:
            return
        if not processed:
            stop.wait(1)


if __name__ == "__main__":
    main()
