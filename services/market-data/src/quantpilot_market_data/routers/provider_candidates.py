from __future__ import annotations

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.provider_candidates import (
    CandidateProviderProbeResponse,
    CandidateProviderRegistry,
)
from quantpilot_market_data.services.provider_candidates import (
    CandidateProviderNotFoundError,
    get_provider_candidates,
    probe_provider_candidates,
)

router = APIRouter(prefix="/api/v1/provider-candidates", tags=["provider-candidates"])


@router.get("", response_model=CandidateProviderRegistry)
async def get_provider_candidates_endpoint() -> CandidateProviderRegistry:
    return await get_provider_candidates()


@router.get("/probe", response_model=CandidateProviderProbeResponse)
async def probe_provider_candidates_endpoint(
    provider_id: str | None = None,
) -> CandidateProviderProbeResponse:
    try:
        return await probe_provider_candidates(provider_id=provider_id)
    except CandidateProviderNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
