"""零售 commerce-data 最小 API（PRD §3 / §8.1）。

领域无关的平台端点（/health、/ready）在 api.py；本路由只承载四个 v1
capability 需要的只读查询。金额字段均来自合成主数据，消费方必须带
“合成口径”标注（PRD §5.3）。
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import BaseModel, Field

from shopgate_commerce_data import analytics, analytics_jobs, retail


class AnalyticsDatasetImportRequest(BaseModel):
    """受控的合成经营分析数据集生成参数。"""

    dataset_id: str = Field(min_length=1, max_length=120)
    users: int = Field(default=1_000, ge=1, le=5_000)
    items: int = Field(default=1_000, ge=1, le=5_000)
    days: int = Field(default=30, ge=1, le=180)
    seed: int = 20251203
    end_day: str = Field(default="2025-12-03", min_length=10, max_length=10)


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

    @router.get("/datasets")
    async def datasets(
        dataset_id: Annotated[str | None, Query(max_length=120)] = None,
    ) -> list[dict[str, Any]]:
        """扩展经营分析数据集契约，明确来源、版本和限制。"""

        return await retail.analytics_dataset_contracts(dataset_id)

    @router.post("/datasets/import", status_code=202)
    async def import_dataset(payload: AnalyticsDatasetImportRequest) -> dict[str, Any]:
        """异步生成并扫描一个隔离的合成经营分析数据集。"""

        try:
            return await analytics_jobs.enqueue_dataset_import(payload.model_dump())
        except analytics_jobs.AnalyticsDatasetImportError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("/datasets/import")
    async def dataset_import_jobs(
        dataset_id: Annotated[str | None, Query(max_length=120)] = None,
        limit: Annotated[int, Query(ge=1, le=50)] = 10,
    ) -> list[dict[str, Any]]:
        """返回最近的数据集导入任务，供工作台展示审计状态。"""

        return await analytics_jobs.list_dataset_import_jobs(dataset_id, limit)

    @router.get("/datasets/import/{job_id}")
    async def dataset_import_job(job_id: str) -> dict[str, Any]:
        """返回数据集生成任务状态，供 BI 工作台轮询。"""

        job = await analytics_jobs.get_dataset_import_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="数据集导入任务不存在。")
        return job

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
                {
                    "id": "retail.analytics-dataset-contract",
                    "name": "经营分析数据契约",
                    "endpoints": ["/api/v1/commerce/datasets"],
                },
                {
                    "id": "retail.advanced-analytics",
                    "name": "用户、渠道、利润与库存分析",
                    "endpoints": [
                        "/api/v1/commerce/analytics/overview",
                        "/api/v1/commerce/analytics/rfm",
                        "/api/v1/commerce/analytics/channel-campaign",
                        "/api/v1/commerce/analytics/profit",
                        "/api/v1/commerce/analytics/inventory",
                        "/api/v1/commerce/analytics/lifecycle",
                        "/api/v1/commerce/analytics/price-elasticity",
                    ],
                },
            ],
            "synthetic_fields": [
                "price",
                "stock",
                "brand",
                "shop",
                "gmv",
                "dataset_user_profiles",
                "dataset_sessions",
                "dataset_item_economics",
                "dataset_orders",
                "dataset_inventory_snapshots",
            ],
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

    @router.get("/analytics/overview")
    async def analytics_overview(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
    ) -> dict[str, Any]:
        try:
            return await analytics.analytics_overview(dataset_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/analytics/rfm")
    async def analytics_rfm(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> dict[str, Any]:
        try:
            return await analytics.rfm_segments(dataset_id, limit)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/analytics/channel-campaign")
    async def analytics_channel_campaign(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
    ) -> dict[str, Any]:
        try:
            return await analytics.channel_campaign_metrics(dataset_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/analytics/profit")
    async def analytics_profit(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
    ) -> dict[str, Any]:
        try:
            return await analytics.profit_metrics(dataset_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/analytics/inventory")
    async def analytics_inventory(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> dict[str, Any]:
        try:
            return await analytics.inventory_analytics(dataset_id, limit)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/analytics/lifecycle")
    async def analytics_lifecycle(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        page: Annotated[int, Query(ge=1, le=500)] = 1,
        stage: Annotated[str | None, Query(max_length=20)] = None,
    ) -> dict[str, Any]:
        try:
            return await analytics.lifecycle_metrics(dataset_id, limit, page, stage)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("/analytics/price-elasticity")
    async def analytics_price_elasticity(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
    ) -> dict[str, Any]:
        try:
            return await analytics.price_band_comparison(dataset_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/analytics/drilldown")
    async def analytics_drilldown(
        dataset_id: Annotated[str, Query(min_length=1, max_length=120)],
        dimension: Annotated[str, Query(min_length=1, max_length=20)],
        value: Annotated[str, Query(min_length=1, max_length=120)],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> dict[str, Any]:
        try:
            return await analytics.analytics_drilldown(dataset_id, dimension, value, limit)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    return router
