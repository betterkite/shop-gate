from __future__ import annotations

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.models import (
    FinancialReportsResponse,
    FundamentalIndicatorsResponse,
)
from quantpilot_market_data.providers.base import FinancialReportProvider
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.fundamentals import (
    get_financial_reports,
    get_fundamental_indicators,
)


def create_fundamentals_router(
    *,
    client: FinancialReportProvider,
    cache: MarketDataCache,
    financial_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(tags=["fundamentals"])

    @router.get(
        "/api/v1/fundamentals/financials/{symbol}",
        response_model=FinancialReportsResponse,
    )
    async def get_financial_reports_endpoint(
        symbol: str,
        limit: int = 8,
    ) -> FinancialReportsResponse:
        try:
            return await get_financial_reports(
                client,
                cache,
                symbol=symbol,
                limit=limit,
                ttl_seconds=financial_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get(
        "/api/v1/indicators/fundamental/{symbol}",
        response_model=FundamentalIndicatorsResponse,
    )
    async def get_fundamental_indicators_endpoint(
        symbol: str,
        limit: int = 8,
    ) -> FundamentalIndicatorsResponse:
        try:
            return await get_fundamental_indicators(
                client,
                cache,
                symbol=symbol,
                limit=limit,
                ttl_seconds=financial_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router
