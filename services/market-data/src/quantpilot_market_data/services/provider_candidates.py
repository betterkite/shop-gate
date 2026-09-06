from __future__ import annotations

from quantpilot_market_data.provider_candidates import (
    CANDIDATE_PROVIDERS,
    CandidateProviderProbeResponse,
    CandidateProviderRegistry,
    get_candidate_provider,
    probe_candidate_provider,
)


class CandidateProviderNotFoundError(ValueError):
    def __init__(self, provider_id: str) -> None:
        super().__init__(f"候选信源不存在：{provider_id}")
        self.provider_id = provider_id


async def get_provider_candidates() -> CandidateProviderRegistry:
    return CandidateProviderRegistry(providers=CANDIDATE_PROVIDERS)


async def probe_provider_candidates(
    provider_id: str | None = None,
) -> CandidateProviderProbeResponse:
    providers = CANDIDATE_PROVIDERS
    if provider_id:
        provider = get_candidate_provider(provider_id)
        if provider is None:
            raise CandidateProviderNotFoundError(provider_id)
        providers = [provider]

    results = [await probe_candidate_provider(provider) for provider in providers]
    return CandidateProviderProbeResponse(results=results)
