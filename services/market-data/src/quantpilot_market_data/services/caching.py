from __future__ import annotations

from quantpilot_market_data.cache import MarketDataCache


def read_cached_response[T](
    cache: MarketDataCache,
    cache_key: str,
    model_type: type[T],
) -> T | None:
    cached = cache.read(cache_key)
    if cached is None:
        return None
    return model_type.model_validate(cached.payload).model_copy(  # type: ignore[attr-defined, no-any-return]
        update={"fetch": cached.to_fetch_metadata("hit")}
    )


def cache_response[T](
    cache: MarketDataCache,
    cache_key: str,
    ttl_seconds: int,
    response: T,
    model_type: type[T],
) -> T:
    if not hasattr(response, "model_dump") or not hasattr(response, "model_copy"):
        return response

    if not cache.enabled:
        return response.model_copy(  # type: ignore[union-attr, no-any-return]
            update={"fetch": cache.disabled_metadata(cache_key, ttl_seconds)}
        )

    response_with_metadata = response.model_copy(  # type: ignore[union-attr]
        update={"fetch": cache.miss_metadata(cache_key, ttl_seconds)}
    )
    cached = cache.write(
        cache_key,
        ttl_seconds=ttl_seconds,
        payload=response_with_metadata.model_dump(mode="json"),  # type: ignore[union-attr]
    )
    if cached is None:
        return response_with_metadata  # type: ignore[return-value]

    return model_type.model_validate(  # type: ignore[attr-defined, no-any-return]
        response_with_metadata.model_dump(mode="json")  # type: ignore[union-attr]
    ).model_copy(update={"fetch": cached.to_fetch_metadata("miss")})
