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
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        status_message: str | None = None,
        task_id: str | None = None,
        cost_usd: float = 0.0,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.status_message = status_message
        self.task_id = task_id
        self.cost_usd = cost_usd
        self.retryable = retryable


class DataForSEOOutcomeUnknown(DataForSEOError):
    pass


class DataForSEOEmptyResult(DataForSEOError):
    def __init__(self, result: SERPResult) -> None:
        super().__init__("dataforseo_empty_result")
        self.result = result


class DataForSEOTaskPending(DataForSEOError):
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


@dataclass(frozen=True)
class SerpTaskReceipt:
    task_id: str
    tag: str
    cost_usd: float
    status_code: int
    status_message: str


class DataForSEOClient:
    endpoint = "/v3/serp/google/organic/live/advanced"
    task_post_endpoint = "/v3/serp/google/organic/task_post"
    tasks_ready_endpoint = "/v3/serp/google/organic/tasks_ready"

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
        if (
            not result.organic_results
            and not result.people_also_ask
            and not result.related_searches
        ):
            raise DataForSEOEmptyResult(result)
        await self._cache_set(cache_key, result.cache_value())
        return result

    async def submit_serp_task(
        self,
        keyword: str,
        country: str,
        language: str,
        device: str = "desktop",
        *,
        tag: str,
    ) -> SerpTaskReceipt:
        self._require_credentials()
        language_code = normalize_language_code(language)
        request_item = self._request_item(
            keyword, country, language_code, device, tag=tag
        )
        response = await asyncio.to_thread(
            self._request_json,
            "POST",
            self.task_post_endpoint,
            [request_item],
        )
        task = _require_provider_task(response, accepted_statuses={20000, 20100})
        task_id = str(task.get("id") or "")
        task_data = task.get("data")
        response_tag = task_data.get("tag") if isinstance(task_data, dict) else None
        if not task_id or response_tag != tag:
            raise DataForSEOOutcomeUnknown(
                "dataforseo_task_submission_mismatch",
                task_id=task_id or None,
                cost_usd=_task_cost(task),
            )
        return SerpTaskReceipt(
            task_id=task_id,
            tag=tag,
            cost_usd=_task_cost(task),
            status_code=int(task.get("status_code") or 0),
            status_message=str(task.get("status_message") or ""),
        )

    async def get_serp_task(self, task_id: str, keyword: str) -> SERPResult:
        self._require_credentials()
        response = await asyncio.to_thread(
            self._request_json,
            "GET",
            f"/v3/serp/google/organic/task_get/advanced/{task_id}",
        )
        task = _first_task(response)
        status_code = _status_code(task)
        if status_code in {20100, 40601, 40602, 40603}:
            raise DataForSEOTaskPending(
                "dataforseo_task_pending",
                status_code=status_code,
                status_message=str(task.get("status_message") or ""),
                task_id=task_id,
                cost_usd=_task_cost(task),
                retryable=True,
            )
        result = parse_serp_response(response, keyword)
        if (
            not result.organic_results
            and not result.people_also_ask
            and not result.related_searches
        ):
            raise DataForSEOEmptyResult(result)
        return result

    async def find_ready_serp_task(self, tag: str) -> str | None:
        self._require_credentials()
        response = await asyncio.to_thread(
            self._request_json, "GET", self.tasks_ready_endpoint
        )
        task = _require_provider_task(response, accepted_statuses={20000})
        results = task.get("result") or []
        for item in results if isinstance(results, list) else []:
            if not isinstance(item, dict) or item.get("tag") != tag:
                continue
            task_id = str(item.get("id") or "")
            if task_id:
                return task_id
        return None

    def _request(
        self, keyword: str, country: str, language: str, device: str
    ) -> dict[str, Any]:
        request_item = self._request_item(keyword, country, language, device)
        return self._request_json("POST", self.endpoint, [request_item])

    def _request_json(
        self,
        method: str,
        endpoint: str,
        payload: Any | None = None,
    ) -> dict[str, Any]:
        self._require_credentials()
        credentials = base64.b64encode(
            f"{self.login}:{self.password}".encode("utf-8")
        ).decode("ascii")
        request = Request(
            self.base_url + endpoint,
            data=(
                json.dumps(payload).encode("utf-8")
                if payload is not None
                else None
            ),
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise DataForSEOError("dataforseo_request_failed") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DataForSEOOutcomeUnknown(
                "dataforseo_request_outcome_unknown"
            ) from exc

    @staticmethod
    def _request_item(
        keyword: str,
        country: str,
        language: str,
        device: str,
        *,
        tag: str | None = None,
    ) -> dict[str, Any]:
        item: dict[str, Any] = {
            "keyword": keyword,
            "language_code": language,
            "device": device,
            "os": "windows",
            "depth": 20,
            **location_parameter(country),
        }
        if tag is not None:
            item["tag"] = tag
        return item

    def _require_credentials(self) -> None:
        if not self.login or not self.password:
            raise DataForSEOError("dataforseo_not_configured")

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
    task = _require_provider_task(response, accepted_statuses={20000})
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


def _status_code(value: dict[str, Any]) -> int | None:
    raw = value.get("status_code")
    return int(raw) if isinstance(raw, int) else None


def _first_task(response: dict[str, Any]) -> dict[str, Any]:
    response_status = _status_code(response)
    if response_status != 20000:
        raise _provider_error(response, "dataforseo_response_failed")
    tasks = response.get("tasks") or []
    if not isinstance(tasks, list) or not tasks or not isinstance(tasks[0], dict):
        raise DataForSEOOutcomeUnknown("dataforseo_task_missing")
    return tasks[0]


def _require_provider_task(
    response: dict[str, Any], *, accepted_statuses: set[int]
) -> dict[str, Any]:
    task = _first_task(response)
    if _status_code(task) not in accepted_statuses:
        raise _provider_error(task, "dataforseo_task_failed")
    return task


def _provider_error(value: dict[str, Any], message: str) -> DataForSEOError:
    status_code = _status_code(value)
    cost = _task_cost(value)
    retryable = status_code in {40202, 40209, 50301, 50303, 50401}
    return DataForSEOError(
        message,
        status_code=status_code,
        status_message=str(value.get("status_message") or ""),
        task_id=str(value.get("id") or "") or None,
        cost_usd=cost,
        retryable=retryable and cost == 0,
    )
