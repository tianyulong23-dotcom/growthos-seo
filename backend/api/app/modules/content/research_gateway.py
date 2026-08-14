from __future__ import annotations

import asyncio
import hashlib
import html
import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from app.modules.settings.provider_privacy import apply_provider_privacy


class ResearchError(Exception):
    def __init__(
        self, code: str, *, failures: tuple[ResearchFailure, ...] = ()
    ) -> None:
        super().__init__(code)
        self.code = code
        self.failures = failures

    def failure_details(self) -> list[dict[str, Any]]:
        return [failure.as_dict() for failure in self.failures]


class ResearchProviderError(ResearchError):
    def __init__(
        self,
        code: str,
        *,
        retryable: bool,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class ProviderFailure:
    provider: str
    model: str
    code: str
    attempts: int
    circuit_open: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider[:80],
            "model": self.model[:120],
            "code": _sanitize_error_code(self.code),
            "attempts": max(0, min(self.attempts, 10)),
            "circuit_open": self.circuit_open,
        }


@dataclass(frozen=True)
class ResearchFailure:
    query: str
    providers: tuple[ProviderFailure, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "query": " ".join(self.query.split())[:500],
            "providers": [failure.as_dict() for failure in self.providers[:2]],
        }


class _ResearchAttemptError(ResearchError):
    def __init__(self, code: str, attempts: int) -> None:
        super().__init__(code)
        self.attempts = attempts


class ResearchCache(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ex: int) -> Any: ...


@dataclass(frozen=True)
class ResearchRequest:
    keyword: str
    country: str
    language: str
    questions: list[str] = field(default_factory=list)
    exact_queries: bool = False


@dataclass(frozen=True)
class ResearchCitation:
    url: str
    title: str = ""
    excerpt: str = ""
    queries: tuple[str, ...] = ()
    provider: str = ""
    model: str = ""
    claim: str = ""
    exact_quote: str = ""


@dataclass(frozen=True)
class ResearchResult:
    answer: str
    citations: list[ResearchCitation]
    provider: str
    model: str
    queries: list[str] = field(default_factory=list)
    failed_queries: list[str] = field(default_factory=list)
    cached_queries: list[str] = field(default_factory=list)
    research_failures: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class ResearchProviderConfig:
    provider: str
    base_url: str
    api_key: str
    model: str
    reasoning_effort: str = "medium"

    @property
    def configured(self) -> bool:
        return all((self.provider, self.base_url, self.api_key, self.model))


@dataclass
class _ProviderCircuit:
    consecutive_failures: int = 0
    open: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ResearchGateway:
    def __init__(
        self,
        primary: ResearchProviderConfig,
        fallback: ResearchProviderConfig,
        timeout_seconds: int,
        cache: ResearchCache | None = None,
        cache_ttl_seconds: int = 86_400,
        max_concurrency: int = 2,
        max_retries: int = 2,
        timeout_max_retries: int = 1,
        circuit_failure_threshold: int = 2,
        retry_initial_seconds: float = 0.5,
        retry_max_seconds: float = 5.0,
    ) -> None:
        self.primary = primary
        self.fallback = fallback
        self.timeout_seconds = timeout_seconds
        self.cache = cache
        self.cache_ttl_seconds = cache_ttl_seconds
        self.max_concurrency = max(1, max_concurrency)
        self.max_retries = max(0, max_retries)
        self.timeout_max_retries = max(0, min(timeout_max_retries, self.max_retries))
        self.circuit_failure_threshold = max(1, circuit_failure_threshold)
        self.retry_initial_seconds = max(0.0, retry_initial_seconds)
        self.retry_max_seconds = max(0.0, retry_max_seconds)
        self._circuits: dict[tuple[str, str, str, str], _ProviderCircuit] = {}

    async def research(self, request: ResearchRequest) -> ResearchResult:
        if not any(config.configured for config in (self.primary, self.fallback)):
            raise ResearchError("research_not_configured")
        questions = research_questions(request)
        self._circuits = {
            self._provider_key(config): _ProviderCircuit()
            for config in (self.primary, self.fallback)
            if config.configured
        }
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def bounded_research(question: str) -> ResearchResult:
            async with semaphore:
                return await self._research_question(request, question)

        outcomes = await asyncio.gather(
            *[bounded_research(question) for question in questions],
            return_exceptions=True,
        )
        results: list[ResearchResult] = []
        failed_queries: list[str] = []
        research_failures: list[ResearchFailure] = []
        for question, outcome in zip(questions, outcomes, strict=True):
            if isinstance(outcome, BaseException):
                failed_queries.append(question)
                research_failures.extend(_failure_details_for_query(question, outcome))
            else:
                results.append(outcome)
        if not results:
            cause = next(
                (outcome for outcome in reversed(outcomes) if isinstance(outcome, BaseException)),
                None,
            )
            raise ResearchError(
                "research_providers_failed", failures=tuple(research_failures)
            ) from cause
        return merge_research_results(
            results,
            questions,
            failed_queries,
            research_failures=research_failures,
        )

    async def _research_question(
        self, request: ResearchRequest, question: str
    ) -> ResearchResult:
        query_request = ResearchRequest(
            keyword=request.keyword,
            country=request.country,
            language=request.language,
            questions=[question],
            exact_queries=True,
        )
        cache_key = research_cache_key(query_request, question)
        cached = await self._cache_get(cache_key)
        if cached is not None:
            try:
                result = research_result_from_cache(cached)
                if result.citations:
                    return ResearchResult(
                        result.answer,
                        result.citations,
                        result.provider,
                        result.model,
                        [question],
                        [],
                        [question],
                    )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                pass

        failures: list[ProviderFailure] = []
        for config in (self.primary, self.fallback):
            if not config.configured:
                continue
            circuit = self._circuits.setdefault(
                self._provider_key(config), _ProviderCircuit()
            )
            if await self._circuit_is_open(circuit):
                failures.append(
                    ProviderFailure(
                        config.provider,
                        config.model,
                        "research_provider_circuit_open",
                        0,
                        circuit_open=True,
                    )
                )
                continue
            try:
                result = await self._request_with_retries(config, query_request)
                if not result.citations:
                    raise ResearchError("research_missing_citations")
                tagged = ResearchResult(
                    result.answer,
                    [
                        ResearchCitation(
                            citation.url,
                            citation.title,
                            citation.excerpt,
                            (question,),
                            config.provider,
                            config.model,
                            citation.claim,
                            citation.exact_quote,
                        )
                        for citation in result.citations
                    ],
                    config.provider,
                    config.model,
                    [question],
                )
                await self._record_provider_success(circuit)
                await self._cache_set(cache_key, tagged)
                return tagged
            except Exception as exc:
                await self._record_provider_failure(circuit)
                failures.append(
                    ProviderFailure(
                        config.provider,
                        config.model,
                        _error_code(exc),
                        _attempt_count(exc),
                    )
                )
        raise ResearchError(
            "research_query_failed",
            failures=(ResearchFailure(question, tuple(failures)),),
        )

    async def _request_with_retries(
        self, config: ResearchProviderConfig, research: ResearchRequest
    ) -> ResearchResult:
        for attempt in range(self.max_retries + 1):
            try:
                return await asyncio.to_thread(self._request, config, research)
            except Exception as exc:
                retry_limit = (
                    self.timeout_max_retries
                    if _is_timeout_failure(exc)
                    else self.max_retries
                )
                if attempt >= retry_limit or not _is_retryable_failure(exc):
                    raise _ResearchAttemptError(
                        _error_code(exc), attempt + 1
                    ) from exc
                delay = self.retry_initial_seconds * (2**attempt)
                retry_after = _retry_after_seconds(exc)
                if retry_after is not None:
                    delay = max(delay, retry_after)
                delay = min(delay, self.retry_max_seconds)
                if delay > 0:
                    await asyncio.sleep(delay)
        raise ResearchError("research_request_failed")

    @staticmethod
    def _provider_key(config: ResearchProviderConfig) -> tuple[str, str, str, str]:
        return (
            config.provider,
            config.base_url,
            config.model,
            config.reasoning_effort,
        )

    @staticmethod
    async def _circuit_is_open(circuit: _ProviderCircuit) -> bool:
        async with circuit.lock:
            return circuit.open

    async def _record_provider_failure(self, circuit: _ProviderCircuit) -> None:
        async with circuit.lock:
            circuit.consecutive_failures += 1
            if circuit.consecutive_failures >= self.circuit_failure_threshold:
                circuit.open = True

    @staticmethod
    async def _record_provider_success(circuit: _ProviderCircuit) -> None:
        async with circuit.lock:
            circuit.consecutive_failures = 0

    def _request(
        self, config: ResearchProviderConfig, research: ResearchRequest
    ) -> ResearchResult:
        if config.provider not in {"openai_responses", "responses"}:
            raise ResearchError("research_provider_not_supported")
        endpoint = (
            config.base_url
            if config.base_url.rstrip("/").endswith("/responses")
            else config.base_url.rstrip("/") + "/responses"
        )
        prompt = {
            "keyword": research.keyword,
            "country": research.country,
            "language": research.language,
            "research_question": research.questions[0] if research.questions else research.keyword,
            "instructions": (
                "Research the question with web search, open useful result pages, and collect "
                "findings that help answer it. Include the source URL, page title, useful passage, "
                "and your concise finding for each source. Represent each finding as "
                "<EVIDENCE><CLAIM>finding</CLAIM><EXACT_QUOTE>useful passage</EXACT_QUOTE>"
                "<SOURCE_URL>page URL</SOURCE_URL><SOURCE_TITLE>page title</SOURCE_TITLE>"
                "</EVIDENCE>, with the provider web citation after the evidence block."
            ),
        }
        body = {
            "model": config.model,
            "reasoning": {"effort": config.reasoning_effort},
            "tools": [{"type": "web_search"}],
            "include": ["web_search_call.action.sources"],
            "input": json.dumps(prompt, ensure_ascii=False),
        }
        body = apply_provider_privacy(config.base_url, body)
        http_request = Request(
            endpoint,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(http_request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            retry_after = _http_retry_after_seconds(exc)
            raise ResearchProviderError(
                f"research_http_{exc.code}",
                retryable=exc.code == 429 or exc.code >= 500,
                retry_after_seconds=retry_after,
            ) from exc
        except TimeoutError as exc:
            raise ResearchProviderError(
                "research_network_timeout", retryable=True
            ) from exc
        except URLError as exc:
            code = (
                "research_network_timeout"
                if isinstance(exc.reason, TimeoutError)
                else "research_network_error"
            )
            raise ResearchProviderError(
                code, retryable=True
            ) from exc
        except json.JSONDecodeError as exc:
            raise ResearchProviderError(
                "research_invalid_response", retryable=False
            ) from exc
        answer, citations = parse_responses_research(payload)
        if not answer:
            raise ResearchError("research_empty_answer")
        return ResearchResult(answer, citations, config.provider, config.model)

    async def _cache_get(self, key: str) -> str | None:
        if self.cache is None:
            return None
        try:
            return await self.cache.get(key)
        except Exception:
            return None

    async def _cache_set(self, key: str, result: ResearchResult) -> None:
        if self.cache is None or not result.citations:
            return
        payload = {
            "answer": result.answer,
            "citations": [
                {
                    "url": item.url,
                    "title": item.title,
                    "excerpt": item.excerpt,
                    "queries": list(item.queries),
                    "provider": item.provider,
                    "model": item.model,
                    "claim": item.claim,
                    "exact_quote": item.exact_quote,
                }
                for item in result.citations
            ],
            "provider": result.provider,
            "model": result.model,
            "queries": result.queries,
        }
        try:
            await self.cache.set(
                key,
                json.dumps(payload, ensure_ascii=False),
                ex=self.cache_ttl_seconds,
            )
        except Exception:
            return


def parse_responses_research(payload: dict[str, Any]) -> tuple[str, list[ResearchCitation]]:
    texts: list[str] = []
    annotation_citations: list[ResearchCitation] = []
    for output in payload.get("output") or []:
        for content in output.get("content") or []:
            if content.get("type") in {"output_text", "text"} and content.get("text"):
                texts.append(str(content["text"]))
            for annotation in content.get("annotations") or []:
                url = annotation.get("url")
                if _is_http_url(url):
                    annotation_quote = _annotation_quote(annotation)
                    annotation_citations.append(
                        ResearchCitation(
                            str(url),
                            str(annotation.get("title") or ""),
                            annotation_quote,
                            claim=annotation_quote,
                            exact_quote=annotation_quote,
                        )
                    )
    if not texts and isinstance(payload.get("output_text"), str):
        texts.append(payload["output_text"])

    answer = "\n".join(texts).strip()
    annotations_by_url: dict[str, ResearchCitation] = {}
    for citation in annotation_citations:
        normalized = normalize_research_url(citation.url)
        existing = annotations_by_url.get(normalized)
        if existing is None or (not existing.title and citation.title):
            annotations_by_url[normalized] = citation

    citations: list[ResearchCitation] = []
    enriched_urls: set[str] = set()
    for evidence in _parse_evidence_blocks(answer):
        normalized = normalize_research_url(evidence["url"])
        annotation = annotations_by_url.get(normalized)
        if annotation is None:
            continue
        citations.append(
            ResearchCitation(
                annotation.url,
                evidence["title"] or annotation.title,
                evidence["claim"],
                claim=evidence["claim"],
                exact_quote=evidence["exact_quote"],
            )
        )
        enriched_urls.add(normalized)
    citations.extend(
        citation
        for normalized, citation in annotations_by_url.items()
        if normalized not in enriched_urls
    )

    unique: dict[tuple[str, str, str], ResearchCitation] = {}
    for citation in citations:
        normalized = normalize_research_url(citation.url)
        key = (normalized, citation.claim, citation.exact_quote)
        existing = unique.get(key)
        if existing is None:
            unique[key] = citation
            continue
        unique[key] = ResearchCitation(
            existing.url,
            existing.title or citation.title,
            _merge_evidence_text(existing.excerpt, citation.excerpt),
            claim=_merge_evidence_text(existing.claim, citation.claim),
            exact_quote=_merge_evidence_text(existing.exact_quote, citation.exact_quote),
        )
    return answer, list(unique.values())


def research_questions(request: ResearchRequest) -> list[str]:
    supplied = [" ".join(item.split()) for item in request.questions if item.strip()]
    if request.exact_queries:
        return list(dict.fromkeys(supplied))[:4]
    questions = [request.keyword, *supplied[:2]]
    questions.append(
        f"Official or first-party information, practical steps, compatibility, and limitations "
        f"for {request.keyword} in {request.country}"
    )
    return list(dict.fromkeys(question for question in questions if question))[:4]


def merge_research_results(
    results: list[ResearchResult],
    queries: list[str],
    failed_queries: list[str],
    *,
    research_failures: list[ResearchFailure] | None = None,
) -> ResearchResult:
    merged: dict[tuple[str, str, str], ResearchCitation] = {}
    for result in results:
        for citation in result.citations:
            normalized = normalize_research_url(citation.url)
            key = (normalized, citation.claim, citation.exact_quote)
            existing = merged.get(key)
            if existing is None:
                merged[key] = citation
                continue
            merged[key] = ResearchCitation(
                existing.url,
                existing.title or citation.title,
                _merge_evidence_text(existing.excerpt, citation.excerpt),
                tuple(dict.fromkeys([*existing.queries, *citation.queries])),
                existing.provider or citation.provider,
                existing.model or citation.model,
                _merge_evidence_text(existing.claim, citation.claim),
                _merge_evidence_text(existing.exact_quote, citation.exact_quote),
            )
    providers = list(dict.fromkeys(item.provider for item in results if item.provider))
    models = list(dict.fromkeys(item.model for item in results if item.model))
    cached_queries = [
        query for result in results for query in result.cached_queries if query
    ]
    return ResearchResult(
        "\n\n".join(result.answer for result in results if result.answer),
        list(merged.values()),
        providers[0] if len(providers) == 1 else "mixed",
        models[0] if len(models) == 1 else "mixed",
        queries,
        failed_queries,
        list(dict.fromkeys(cached_queries)),
        [failure.as_dict() for failure in research_failures or []],
    )


def research_cache_key(request: ResearchRequest, question: str) -> str:
    normalized = "|".join(
        " ".join(value.casefold().split())
        for value in (request.keyword, request.country, request.language, question)
    )
    return f"article:research:v3:{hashlib.sha256(normalized.encode('utf-8')).hexdigest()}"


def research_result_from_cache(value: str) -> ResearchResult:
    payload = json.loads(value)
    citations = [
        ResearchCitation(
            str(item["url"]),
            str(item.get("title") or ""),
            str(item.get("excerpt") or ""),
            tuple(str(query) for query in item.get("queries") or []),
            str(item.get("provider") or ""),
            str(item.get("model") or ""),
            str(item.get("claim") or item.get("excerpt") or ""),
            str(item.get("exact_quote") or ""),
        )
        for item in payload["citations"]
        if _is_http_url(item.get("url"))
    ]
    return ResearchResult(
        str(payload["answer"]),
        citations,
        str(payload.get("provider") or ""),
        str(payload.get("model") or ""),
        [str(item) for item in payload.get("queries") or []],
    )


def normalize_research_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    scheme = parsed.scheme.lower()
    host = parsed.netloc.lower()
    if scheme == "http" and host.endswith(":80"):
        host = host[:-3]
    elif scheme == "https" and host.endswith(":443"):
        host = host[:-4]
    query = urlencode(
        [
            (key, item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
            if key.casefold() not in _TRACKING_QUERY_PARAMETERS
        ],
        doseq=True,
    )
    return urlunsplit((scheme, host, parsed.path or "/", query, ""))


_TRACKING_QUERY_PARAMETERS = {
    "fbclid",
    "gclid",
    "utm_campaign",
    "utm_content",
    "utm_medium",
    "utm_source",
    "utm_term",
}
_EVIDENCE_BLOCK_PATTERN = re.compile(
    r"<EVIDENCE>(?P<body>.*?)</EVIDENCE>", re.IGNORECASE | re.DOTALL
)


def _parse_evidence_blocks(text: str) -> list[dict[str, str]]:
    evidence: list[dict[str, str]] = []
    for match in _EVIDENCE_BLOCK_PATTERN.finditer(text):
        body = match.group("body")
        claim = _evidence_field(body, "CLAIM")
        exact_quote = _evidence_field(body, "EXACT_QUOTE")
        url = _evidence_field(body, "SOURCE_URL")
        title = _evidence_field(body, "SOURCE_TITLE")
        if claim and exact_quote and _is_http_url(url):
            evidence.append(
                {
                    "claim": claim[:4000],
                    "exact_quote": exact_quote[:4000],
                    "url": url,
                    "title": title[:1000],
                }
            )
    return evidence


def _evidence_field(body: str, name: str) -> str:
    match = re.search(
        rf"<{name}>\s*(.*?)\s*</{name}>", body, re.IGNORECASE | re.DOTALL
    )
    return " ".join(html.unescape(match.group(1)).split()) if match else ""


def _merge_evidence_text(*values: str) -> str:
    return "\n".join(dict.fromkeys(value for value in values if value))[:4000]


def _annotation_quote(annotation: dict[str, Any]) -> str:
    supplied = annotation.get("quote") or annotation.get("excerpt")
    if isinstance(supplied, str) and supplied.strip():
        return supplied.strip()[:2000]
    return ""


def _is_http_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _is_retryable_failure(exc: Exception) -> bool:
    if isinstance(exc, ResearchProviderError):
        return exc.retryable
    if isinstance(exc, HTTPError):
        return exc.code == 429 or exc.code >= 500
    return isinstance(exc, (URLError, TimeoutError))


def _is_timeout_failure(exc: Exception) -> bool:
    if isinstance(exc, ResearchProviderError):
        return exc.code == "research_network_timeout"
    return isinstance(exc, TimeoutError)


def _retry_after_seconds(exc: Exception) -> float | None:
    if isinstance(exc, ResearchProviderError):
        return exc.retry_after_seconds
    if isinstance(exc, HTTPError):
        return _http_retry_after_seconds(exc)
    return None


def _http_retry_after_seconds(exc: HTTPError) -> float | None:
    value = exc.headers.get("Retry-After") if exc.headers is not None else None
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def _failure_details_for_query(
    question: str, outcome: BaseException
) -> tuple[ResearchFailure, ...]:
    if isinstance(outcome, ResearchError) and outcome.failures:
        return outcome.failures
    return (
        ResearchFailure(
            question,
            (
                ProviderFailure(
                    "gateway",
                    "",
                    _error_code(outcome),
                    _attempt_count(outcome),
                ),
            ),
        ),
    )


def _attempt_count(exc: BaseException) -> int:
    attempts = getattr(exc, "attempts", 1)
    return attempts if isinstance(attempts, int) else 1


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, ResearchError):
        return _sanitize_error_code(exc.code)
    return "research_unexpected_error"


def _sanitize_error_code(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9_]+", "_", value.casefold()).strip("_")
    if not normalized.startswith("research_"):
        return "research_unexpected_error"
    return normalized[:80]
