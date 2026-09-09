from __future__ import annotations

import json
import os
from typing import Any

import redis.asyncio as redis
from redis.exceptions import RedisError


class RedisJsonCache:
    """commerce-data 的可选 Redis JSON 缓存；不可用时安全降级。"""

    def __init__(
        self,
        *,
        url: str | None = None,
        namespace: str | None = None,
        enabled: bool | None = None,
    ) -> None:
        self.url = url if url is not None else os.getenv("REDIS_URL", "").strip()
        self.namespace = namespace or os.getenv("REDIS_NAMESPACE", "shopgate")
        self.enabled = redis_enabled_from_env() if enabled is None else enabled
        self._client: redis.Redis | None = None
        self._available = True

    @property
    def configured(self) -> bool:
        return bool(self.url)

    @property
    def available(self) -> bool:
        return self.enabled and self.configured and self._available

    def key(self, cache_key: str) -> str:
        if cache_key.startswith(f"{self.namespace}:"):
            return cache_key
        return f"{self.namespace}:commerce-data:{cache_key}"

    async def read(self, cache_key: str) -> dict[str, Any] | None:
        if not self.available:
            return None
        client = self._get_client()
        try:
            raw = await client.get(self.key(cache_key))
        except RedisError:
            self._available = False
            return None
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            await self.delete(cache_key)
            return None

    async def write(self, cache_key: str, *, ttl_seconds: int, payload: dict[str, Any]) -> bool:
        if not self.available or ttl_seconds <= 0:
            return False
        client = self._get_client()
        try:
            await client.set(
                self.key(cache_key),
                json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")),
                ex=ttl_seconds,
            )
            return True
        except (TypeError, RedisError):
            self._available = False
            return False

    async def delete(self, cache_key: str) -> None:
        if not self.available:
            return
        try:
            await self._get_client().delete(self.key(cache_key))
        except RedisError:
            self._available = False

    async def ping(self) -> bool:
        if not self.enabled or not self.configured:
            return False
        try:
            await self._get_client().ping()
            self._available = True
            return True
        except RedisError:
            self._available = False
            return False

    async def close(self) -> None:
        if self._client is None:
            return
        await self._client.aclose()
        self._client = None

    def _get_client(self) -> redis.Redis:
        if self._client is None:
            self._client = redis.from_url(
                self.url,
                decode_responses=True,
                socket_connect_timeout=0.5,
                socket_timeout=1.5,
                health_check_interval=30,
            )
        return self._client


def redis_enabled_from_env() -> bool:
    raw_value = os.getenv("SHOPGATE_REDIS_CACHE_ENABLED")
    if raw_value is None:
        return True
    return raw_value.strip().lower() not in {"0", "false", "no", "off", "disabled"}


def ttl_from_env(name: str, default_seconds: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default_seconds
    try:
        return max(0, int(raw_value))
    except ValueError:
        return default_seconds
