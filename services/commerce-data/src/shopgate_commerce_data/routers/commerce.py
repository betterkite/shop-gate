"""零售 commerce-data 最小 API（PRD §3 / §8.1）。

领域无关的平台端点（/health、/ready）在 api.py；本路由只承载四个 v1
capability 需要的只读查询。金额字段均来自合成主数据，消费方必须带
“合成口径”标注（PRD §5.3）。
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Query

from shopgate_commerce_data import retail


def _parse_date(value: str | None, fallback: date | None) -> date | None:
    try:
        return retail.parse_iso_date(value, fallback)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def create_commerce_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/commerce", tags=["commerce"])

    @router.get("/meta")
    async def meta() -> dict[str, Any]:
        """数据集口径：窗口、规模与真实/合成来源计数。"""

        return await retail.dataset_meta()

    @router.get("/resolve")
    async def resolve(
        term: Annotated[str, Query(min_length=1, max_length=64)],
        limit: Annotated[int, Query(ge=1, le=50)] = 10,
    ) -> dict[str, Any]:
        """实体解析：``item:<id>``/``cat:<id>`` 显式形式 + 类目名/商品标题模糊匹配。"""

        return await retail.resolve_entities(term, limit)

    @router.get("/capabilities")
    async def capabilities() -> dict[str, Any]:
        """四个 v1 capability 的发现信息（供 Agent 能力注入与人工核对）。"""

        return {
            "domain_pack": "retail.core",
            "capabilities": [
                {
                    "id": "retail.traffic-funnel",
                    "name": "流量与转化漏斗",
                    "endpoints": ["/api/v1/commerce/funnel", "/api/v1/commerce/funnel/daily"],
                },
                {
                    "id": "retail.catalog-structure",
                    "name": "类目与商品结构",
                    "endpoints": [
                        "/api/v1/commerce/categories/top",
                        "/api/v1/commerce/items/{item_id}/daily",
                    ],
                },
                {
                    "id": "retail.price-inventory",
                    "name": "价格与库存（合成口径）",
                    "endpoints": ["/api/v1/commerce/inventory-risk"],
                },
                {
                    "id": "retail.daily-brief",
                    "name": "经营情报日报",
                    "endpoints": ["/api/v1/commerce/summary"],
                },
            ],
            "synthetic_fields": ["price", "stock", "brand", "shop", "gmv"],
        }

    @router.get("/funnel")
    async def funnel(
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
        category_id: Annotated[int | None, Query()] = None,
    ) -> dict[str, Any]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        return await retail.behavior_funnel(start_date, end_date, category_id)

    @router.get("/funnel/daily")
    async def funnel_daily(
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
        category_id: Annotated[int | None, Query()] = None,
    ) -> list[dict[str, Any]]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        return await retail.funnel_daily_series(start_date, end_date, category_id)

    @router.get("/categories/top")
    async def categories_top(
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
        metric: Annotated[str, Query()] = "gmv",
        limit: Annotated[int, Query(ge=1, le=100)] = 10,
    ) -> list[dict[str, Any]]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        try:
            return await retail.top_categories(start_date, end_date, metric, limit)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("/items/{item_id}/daily")
    async def item_daily(
        item_id: Annotated[int, Path()],
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
    ) -> list[dict[str, Any]]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        return await retail.item_daily_series(item_id, start_date, end_date)

    @router.get("/inventory-risk")
    async def inventory_risk(
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 20,
    ) -> dict[str, Any]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        return {
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "synthetic_fields": ["price", "stock"],
            "items": await retail.inventory_risk(start_date, end_date, limit),
            "health": await retail.inventory_health(start_date, end_date),
        }

    @router.get("/items")
    async def items_list(
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=100)] = 20,
        category_id: Annotated[int | None, Query()] = None,
        sort: Annotated[str, Query()] = "gmv",
    ) -> dict[str, Any]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        try:
            return await retail.product_pool(
                start_date,
                end_date,
                page=page,
                page_size=page_size,
                category_id=category_id,
                sort=sort,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("/channels")
    async def channels(
        start: Annotated[str | None, Query()] = None,
        end: Annotated[str | None, Query()] = None,
    ) -> list[dict[str, Any]]:
        end_date = _parse_date(end, date.today())
        assert end_date is not None
        start_date = _parse_date(start, end_date - timedelta(days=8))
        if start_date is None or start_date > end_date:
            raise HTTPException(status_code=400, detail="start 不能晚于 end")
        return await retail.channel_metrics(start_date, end_date)

    @router.get("/summary")
    async def summary(
        stat_date: Annotated[str | None, Query(alias="date")] = None,
    ) -> dict[str, Any]:
        parsed = _parse_date(stat_date, date.today())
        assert parsed is not None
        return await retail.daily_summary(parsed)

    return router
