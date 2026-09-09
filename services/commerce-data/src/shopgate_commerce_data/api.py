"""Shop Gate commerce-data API（零售最小集，PRD §8.1）。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from shopgate_commerce_data.cache import RedisJsonCache
from shopgate_commerce_data.database_core import connect
from shopgate_commerce_data.routers.commerce import create_commerce_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="Shop Gate Commerce Data API",
        description="Shop Gate 零售 Data Agent 的商品与经营数据后端",
        version="0.1.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1):\d+$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(create_commerce_router())

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready() -> JSONResponse:
        async def database_probe() -> None:
            connection = await connect()
            async with connection:
                await connection.execute("SELECT 1")

        redis_probe = RedisJsonCache().ping
        from shopgate_commerce_data.readiness import get_market_readiness

        result = await get_market_readiness(
            database_probe=database_probe,
            redis_probe=redis_probe,
        )
        return JSONResponse(
            content=result,
            status_code=200 if result["ok"] else 503,
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    return app


app = create_app()
