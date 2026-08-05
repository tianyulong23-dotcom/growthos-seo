from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pycountry


class DataForSEOError(Exception):
    pass


COUNTRY_LOCATION_CODES = {
    "US": 2840,
    "GB": 2826,
    "CN": 2156,
}


class Cache(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ex: int) -> Any: ...


@dataclass(frozen=True)
class OrganicResult:
    position: int | None
    url: str
    domain: str
    title: str
    description: str


@dataclass(frozen=True)
class SERPResult:
    keyword: str
    organic_results: list[OrganicResult] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    people_also_ask: list[str] = field(default_factory=list)
    related_searches: list[str] = field(default_factory=list)
    featured_snippet: dict[str, Any] | None = None
    cached: bool = False
    request_cost_usd: float = 0.0
    provider_request_id: str | None = None
    raw_response: dict[str, Any] | None = field(
        default=None, repr=False, compare=False
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "keyword": self.keyword,
            "organic_results": [asdict(item) for item in self.organic_results],
            "features": list(self.features),
            "people_also_ask": list(self.people_also_ask),
            "related_searches": list(self.related_searches),
            "featured_snippet": self.featured_snippet,
            "cached": self.cached,
        }

    def cache_value(self) -> str:
        payload = self.to_dict()
        payload["cached"] = False
        payload["raw_response"] = self.raw_response
        return json.dumps(payload, ensure_ascii=False)


class DataForSEOClient:
    endpoint = "/v3/serp/google/organic/live/advanced"

    def __init__(
        self,
        *,
        login: str | None,
        password: str | None,
        base_url: str,
        cache: Cache | None,
        cache_ttl_seconds: int,
        timeout_seconds: int,
    ) -> None:
        self.login = login
        self.password = password
        self.base_url = base_url.rstrip("/")
        self.cache = cache
        self.cache_ttl_seconds = cache_ttl_seconds
        self.timeout_seconds = timeout_seconds

    async def search(
        self, keyword: str, country: str, language: str, device: str = "desktop"
    ) -> SERPResult:
        if not self.login or not self.password:
            raise DataForSEOError("dataforseo_not_configured")
        language_code = normalize_language_code(language)
        cache_key = self._cache_key(keyword, country, language_code, device)
        cached = await self._cache_get(cache_key)
        if cached is not None:
            try:
                return self._parse_cached(cached)
            except DataForSEOError:
                pass

        response = await asyncio.to_thread(
            self._request, keyword, country, language_code, device
        )
        result = parse_serp_response(response, keyword)
        if not result.organic_results and not result.people_also_ask:
            raise DataForSEOError("dataforseo_empty_result")
        await self._cache_set(cache_key, result.cache_value())
        return result

    def _request(
        self, keyword: str, country: str, language: str, device: str
    ) -> dict[str, Any]:
        credentials = base64.b64encode(
            f"{self.login}:{self.password}".encode("utf-8")
        ).decode("ascii")
        request_item = {
            "keyword": keyword,
            "language_code": language,
            "device": device,
            "os": "windows",
            "depth": 20,
            **location_parameter(country),
        }
        payload = [request_item]
        request = Request(
            self.base_url + self.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DataForSEOError("dataforseo_request_failed") from exc

    async def _cache_get(self, key: str) -> str | None:
        if self.cache is None:
            return None
        try:
            return await self.cache.get(key)
        except Exception:
            return None

    async def _cache_set(self, key: str, value: str) -> None:
        if self.cache is None:
            return
        try:
            await self.cache.set(key, value, ex=self.cache_ttl_seconds)
        except Exception:
            return

    @staticmethod
    def _cache_key(keyword: str, country: str, language: str, device: str) -> str:
        normalized = " ".join(keyword.lower().split())
        digest = hashlib.sha256(
            f"{country.lower()}|{language.lower()}|{device}|{normalized}".encode()
        ).hexdigest()
        return f"article:serp:{digest}"

    @staticmethod
    def _parse_cached(value: str) -> SERPResult:
        try:
            data = json.loads(value)
            raw_response = (
                data.get("raw_response")
                if isinstance(data.get("raw_response"), dict)
                else None
            )
            features = list(data.get("features", []))
            if "features" not in data and raw_response is not None:
                features = parse_serp_response(
                    raw_response, str(data["keyword"])
                ).features
            return SERPResult(
                keyword=str(data["keyword"]),
                organic_results=[OrganicResult(**item) for item in data["organic_results"]],
                features=features,
                people_also_ask=list(data.get("people_also_ask", [])),
                related_searches=list(data.get("related_searches", [])),
                featured_snippet=data.get("featured_snippet"),
                cached=True,
                request_cost_usd=0.0,
                provider_request_id=None,
                raw_response=raw_response,
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise DataForSEOError("dataforseo_cache_invalid") from exc


def parse_serp_response(response: dict[str, Any], keyword: str) -> SERPResult:
    if response.get("status_code") != 20000:
        raise DataForSEOError("dataforseo_response_failed")
    tasks = response.get("tasks") or []
    if not tasks or tasks[0].get("status_code") != 20000:
        raise DataForSEOError("dataforseo_task_failed")
    task = tasks[0]
    results = task.get("result") or []
    if not results:
        raise DataForSEOError("dataforseo_empty_result")

    organic: list[OrganicResult] = []
    questions: list[str] = []
    related: list[str] = []
    features: list[str] = []
    featured: dict[str, Any] | None = None
    for item in results[0].get("items") or []:
        item_type = str(item.get("type") or "")
        if item_type == "organic":
            if item.get("url") and len(organic) < 20:
                organic.append(
                    OrganicResult(
                        position=item.get("rank_absolute"),
                        url=str(item["url"]),
                        domain=str(item.get("domain") or ""),
                        title=str(item.get("title") or ""),
                        description=str(item.get("description") or ""),
                    )
                )
        elif item_type:
            features.append(item_type)
            if item_type == "people_also_ask":
                questions.extend(_texts(item, ("title", "question")))
            elif item_type == "related_searches":
                related.extend(_texts(item, ("title", "query", "keyword")))
            elif item_type in {"featured_snippet", "answer_box"} and featured is None:
                featured = {
                    key: item.get(key)
                    for key in ("title", "text", "description", "url", "domain")
                    if item.get(key)
                }
    return SERPResult(
        keyword=keyword,
        organic_results=organic,
        features=_unique(features),
        people_also_ask=_unique(questions),
        related_searches=_unique(related),
        featured_snippet=featured,
        request_cost_usd=_task_cost(task),
        provider_request_id=str(task["id"]) if task.get("id") else None,
        raw_response=response,
    )


def location_parameter(country: str) -> dict[str, str | int]:
    normalized = country.strip()
    location_code = COUNTRY_LOCATION_CODES.get(normalized.upper())
    if location_code is not None:
        return {"location_code": location_code}
    if len(normalized) == 2:
        match = pycountry.countries.get(alpha_2=normalized.upper())
        if match is not None:
            return {"location_name": str(match.name)}
    if len(normalized) > 2:
        return {"location_name": normalized}
    raise DataForSEOError("dataforseo_location_unsupported")


def normalize_language_code(language: str) -> str:
    normalized = language.strip().replace("_", "-").lower()
    if not normalized:
        return "en"
    base = normalized.split("-", 1)[0]
    if len(base) == 2:
        return base
    try:
        match = pycountry.languages.lookup(normalized)
    except LookupError:
        return "en"
    code = getattr(match, "alpha_2", None)
    return str(code).lower() if code else "en"


def _texts(item: dict[str, Any], keys: tuple[str, ...]) -> list[str]:
    values: list[str] = []
    candidates = [item, *(item.get("items") or [])]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for key in keys:
            value = candidate.get(key)
            if isinstance(value, str) and value.strip():
                values.append(value.strip())
                break
    return values


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _task_cost(task: dict[str, Any]) -> float:
    try:
        return max(0.0, float(task.get("cost") or 0.0))
    except (TypeError, ValueError):
        return 0.0
