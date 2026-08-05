from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import dataclass, replace
from typing import Any, Generic, Literal, TypeVar
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from app.modules.content.prompts import BASE_RULES, CALL_INSTRUCTIONS, FORMAT_REPAIR
from app.modules.settings.provider_privacy import apply_provider_privacy
from app.modules.settings.service import (
    AIProviderConnectionError,
    AIProviderSettingsRecord,
    build_ai_settings_service,
)


class WritingOutputError(Exception):
    def __init__(
        self,
        code: str,
        *,
        attempts: int = 0,
        format_attempts: int = 0,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.attempts = attempts
        self.format_attempts = format_attempts


class WritingRequestError(AIProviderConnectionError):
    def __init__(
        self,
        code: str,
        *,
        retryable: bool,
        attempts: int = 1,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.attempts = attempts


MAX_TIMEOUT_RETRIES = 1
FAILURES_BEFORE_CIRCUIT_OPEN = 2


class EvidenceClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_id: str = Field(min_length=1, max_length=100)
    claim: str = Field(min_length=1, max_length=1000)
    source_url: str = Field(min_length=1, max_length=2000)
    source_title: str = Field(default="", max_length=500)
    quote: str = Field(default="", max_length=2000)
    supported: bool = True
    section_id: str | None = Field(default=None, max_length=100)


class OutlineSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section_id: str = Field(min_length=1, max_length=100)
    heading: str = Field(min_length=1, max_length=300)
    objective: str = Field(min_length=1, max_length=1000)
    required_questions: list[str] = Field(default_factory=list, max_length=10)
    claim_ids: list[str] = Field(default_factory=list, max_length=20)
    internal_urls: list[str] = Field(default_factory=list, max_length=10)
    coverage_points: list[str] = Field(default_factory=list, max_length=12)
    section_type: Literal[
        "intro",
        "body_how_to",
        "body_comparison",
        "body_explanation",
        "body_list",
        "faq",
        "conclusion",
    ] = "body_explanation"
    word_target: int = Field(default=300, ge=100, le=1200)
    strategic_angle: str = Field(default="", max_length=1000)
    engagement_hook: str = Field(default="", max_length=500)
    competitor_gaps: list[str] = Field(default_factory=list, max_length=10)
    data_requirements: list[str] = Field(default_factory=list, max_length=10)
    cta_type: Literal["soft", "medium", "strong"] | None = None
    featured_snippet_target: bool = False


class ContractSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section_id: str = Field(min_length=1, max_length=100)
    required_questions: list[str] = Field(default_factory=list, max_length=10)
    allowed_claim_ids: list[str] = Field(default_factory=list, max_length=20)
    allowed_source_urls: list[str] = Field(default_factory=list, max_length=20)
    allowed_internal_urls: list[str] = Field(default_factory=list, max_length=10)


class ArticleContract(BaseModel):
    model_config = ConfigDict(extra="forbid")

    article_type: str = Field(min_length=1, max_length=100)
    search_intent: str = Field(min_length=1, max_length=500)
    required_questions: list[str] = Field(default_factory=list, max_length=20)
    sections: list[ContractSection] = Field(min_length=1, max_length=12)
    faq_questions: list[str] = Field(default_factory=list, max_length=10)
    unsupported_claim_boundaries: list[str] = Field(default_factory=list, max_length=20)


class ArticlePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    search_intent: str = Field(min_length=1, max_length=500)
    article_type: str = Field(min_length=1, max_length=100)
    meta_title: str = Field(min_length=1, max_length=300)
    meta_description: str = Field(min_length=1, max_length=500)
    slug: str = Field(min_length=1, max_length=200)
    total_word_target: int = Field(default=0, ge=0, le=12000)
    gap_to_section_mapping: dict[str, str] = Field(default_factory=dict)
    claims: list[EvidenceClaim] = Field(default_factory=list, max_length=100)
    sections: list[OutlineSection] = Field(min_length=1, max_length=12)
    contract: ArticleContract | None = None


class SectionDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section_id: str = Field(min_length=1, max_length=100)
    markdown: str = Field(min_length=1, max_length=30000)
    used_claim_ids: list[str] = Field(default_factory=list, max_length=30)
    used_source_urls: list[str] = Field(default_factory=list, max_length=30)
    used_internal_urls: list[str] = Field(default_factory=list, max_length=20)
    summary: str = Field(default="", max_length=1000)


class UnifiedArticle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    meta_title: str = Field(min_length=1, max_length=300)
    meta_description: str = Field(min_length=1, max_length=500)
    slug: str = Field(min_length=1, max_length=200)
    sections: list[SectionDraft] = Field(min_length=1, max_length=12)


class SectionIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section_id: str = Field(min_length=1, max_length=100)
    code: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=1000)
    category: Literal["evidence", "prose", "structure", "format"] = "prose"
    repairable: bool = True


class SemanticQualityResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passed: bool
    issues: list[SectionIssue] = Field(default_factory=list, max_length=50)


class RevisedSections(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sections: list[SectionDraft] = Field(default_factory=list, max_length=12)


WritingCall = Literal[
    "plan_article",
    "write_and_edit_section",
    "unify_article",
    "revise_quality",
    "check_article",
    "revise_sections",
]
T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class WritingResult(Generic[T]):
    value: T
    model: str
    base_url: str
    provider_request_id: str | None
    usage: dict[str, Any]


class WritingGateway:
    def __init__(
        self,
        model_snapshot: dict[str, Any] | None = None,
    ) -> None:
        self.model_snapshot = dict(model_snapshot or {})
        self._consecutive_failures = 0

    async def configured_record(self) -> AIProviderSettingsRecord:
        current = await build_ai_settings_service().effective_record()
        if not self.model_snapshot:
            return current
        return replace(
            current,
            provider=str(
                self.model_snapshot.get("provider") or current.provider
            ),
            base_url=str(self.model_snapshot.get("base_url") or current.base_url),
            model=str(self.model_snapshot.get("model") or current.model),
            request_timeout_seconds=int(
                self.model_snapshot.get("request_timeout_seconds")
                or current.request_timeout_seconds
            ),
            max_retries=int(
                self.model_snapshot.get("max_retries")
                if self.model_snapshot.get("max_retries") is not None
                else current.max_retries
            ),
        )

    async def generate(
        self,
        call_type: WritingCall,
        payload: dict[str, Any],
        output_type: type[T],
        *,
        request_key: str | None = None,
    ) -> WritingResult[T]:
        record = await self.configured_record()
        if self._circuit_is_open():
            raise WritingRequestError(
                "writing_provider_circuit_open",
                retryable=False,
                attempts=0,
            )
        output_schema = output_type.model_json_schema()
        messages = [
            {"role": "system", "content": BASE_RULES},
            {"role": "system", "content": CALL_INSTRUCTIONS[call_type]},
            {
                "role": "system",
                "content": (
                    "Required output JSON Schema:\n"
                    + json.dumps(
                        output_schema,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                ),
            },
            {
                "role": "user",
                "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            },
        ]
        usages: list[dict[str, int | float | str | None]] = []
        request_attempts = 0
        try:
            for format_attempt in range(2):
                try:
                    response = await self._request_with_retries(
                        record,
                        messages,
                        idempotency_key=(
                            f"{request_key}:{format_attempt}" if request_key else None
                        ),
                    )
                except WritingRequestError as exc:
                    request_attempts += exc.attempts
                    raise
                except WritingOutputError as exc:
                    request_attempts += max(1, exc.attempts)
                    exc.attempts = request_attempts
                    raise
                request_attempts += 1
                usages.append(parse_usage(response))
                try:
                    content = str(response["choices"][0]["message"]["content"])
                    value = TypeAdapter(output_type).validate_json(strip_json_fence(content))
                    provider_request_id = (
                        str(response.get("id"))
                        if response.get("id") is not None
                        else None
                    )
                    usage = merge_usage(usages)
                    usage.update(
                        {
                            "models": [record.model],
                            "base_urls": [record.base_url],
                            "provider_request_ids": (
                                [provider_request_id] if provider_request_id else []
                            ),
                        }
                    )
                    self._reset_circuit()
                    return WritingResult(
                        value=value,
                        model=record.model,
                        base_url=record.base_url,
                        provider_request_id=provider_request_id,
                        usage=usage,
                    )
                except (KeyError, IndexError, TypeError, ValidationError, ValueError) as exc:
                    if format_attempt == 1:
                        raise WritingOutputError(
                            "writing_output_invalid",
                            attempts=request_attempts,
                            format_attempts=2,
                        ) from exc
                    previous = ""
                    try:
                        previous = str(response["choices"][0]["message"]["content"])
                    except (KeyError, IndexError, TypeError):
                        pass
                    messages.extend(
                        [
                            {"role": "assistant", "content": previous[:50000]},
                            {
                                "role": "user",
                                "content": (
                                    FORMAT_REPAIR
                                    + "\nRequired output JSON Schema:\n"
                                    + json.dumps(
                                        output_schema,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    )
                                ),
                            },
                        ]
                    )
        except (WritingOutputError, WritingRequestError):
            self._register_failure()
            raise
        raise WritingOutputError(
            "writing_output_invalid",
            attempts=request_attempts,
            format_attempts=2,
        )

    async def _request_with_retries(
        self,
        record: AIProviderSettingsRecord,
        messages: list[dict[str, str]],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        timeout_failures = 0
        for attempt in range(record.max_retries + 1):
            try:
                return await asyncio.to_thread(
                    self._request, record, messages, idempotency_key
                )
            except WritingRequestError as exc:
                if exc.code == "writing_provider_timeout":
                    timeout_failures += 1
                retry_limit = (
                    min(record.max_retries, MAX_TIMEOUT_RETRIES)
                    if exc.code == "writing_provider_timeout"
                    else record.max_retries
                )
                if not exc.retryable or attempt >= retry_limit:
                    exc.attempts = attempt + 1
                    raise
                await asyncio.sleep(min(0.25 * (2**attempt), 1.0))
        raise WritingRequestError(
            "writing_provider_no_response",
            retryable=False,
            attempts=max(1, timeout_failures),
        )

    def _request(
        self,
        record: AIProviderSettingsRecord,
        messages: list[dict[str, str]],
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        endpoint = (
            record.base_url
            if record.base_url.endswith("/chat/completions")
            else record.base_url.rstrip("/") + "/chat/completions"
        )
        body = json.dumps(
            apply_provider_privacy(record.base_url, {
                "model": record.model,
                "messages": messages,
                "response_format": {"type": "json_object"},
            })
        ).encode("utf-8")
        headers = {
            "Authorization": "Bearer " + record.api_key,
            "Content-Type": "application/json",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = Request(
            endpoint,
            data=body,
            method="POST",
            headers=headers,
        )
        try:
            with urlopen(request, timeout=record.request_timeout_seconds) as response:
                response_body = response.read(4 * 1024 * 1024 + 1)
        except HTTPError as exc:
            if exc.code in {401, 403}:
                raise WritingRequestError(
                    "writing_provider_auth_error", retryable=False
                ) from exc
            if exc.code == 429:
                raise WritingRequestError(
                    "writing_provider_rate_limited", retryable=True
                ) from exc
            raise WritingRequestError(
                f"writing_provider_http_{exc.code}",
                retryable=500 <= exc.code < 600,
            ) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise WritingRequestError(
                "writing_provider_timeout", retryable=True
            ) from exc
        except (URLError, OSError) as exc:
            raise WritingRequestError(
                "writing_provider_network_error", retryable=True
            ) from exc
        if len(response_body) > 4 * 1024 * 1024:
            raise WritingRequestError(
                "writing_provider_response_too_large", retryable=False
            )
        try:
            value = json.loads(response_body)
        except json.JSONDecodeError as exc:
            raise WritingOutputError("writing_response_invalid") from exc
        if not isinstance(value, dict):
            raise WritingOutputError("writing_response_invalid")
        return value

    def _circuit_is_open(self) -> bool:
        return self._consecutive_failures >= FAILURES_BEFORE_CIRCUIT_OPEN

    def _register_failure(self) -> None:
        self._consecutive_failures += 1

    def _reset_circuit(self) -> None:
        self._consecutive_failures = 0


def parse_usage(payload: dict[str, Any]) -> dict[str, Any]:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    input_tokens = usage.get("prompt_tokens", usage.get("input_tokens"))
    output_tokens = usage.get("completion_tokens", usage.get("output_tokens"))
    cost = usage.get("cost", usage.get("total_cost", payload.get("cost")))
    currency = usage.get("cost_currency", usage.get("currency"))
    normalized_input = int(input_tokens) if isinstance(input_tokens, (int, float)) else None
    normalized_output = int(output_tokens) if isinstance(output_tokens, (int, float)) else None
    reported_cost = float(cost) if isinstance(cost, (int, float)) else None
    return {
        "input_tokens": normalized_input,
        "output_tokens": normalized_output,
        "unreported_input_tokens": normalized_input if reported_cost is None else 0,
        "unreported_output_tokens": normalized_output if reported_cost is None else 0,
        "reported_cost": reported_cost,
        "estimated_cost": None,
        "cost_currency": str(currency)[:20] if currency else None,
        "estimation_basis": {},
    }


def merge_usage(
    usages: list[dict[str, Any]],
) -> dict[str, Any]:
    currencies = {
        str(item.get("cost_currency"))[:20]
        for item in usages
        if item.get("cost_currency")
    }
    reported_values = [
        float(item.get("reported_cost", item.get("cost")))
        for item in usages
        if item.get("reported_cost", item.get("cost")) is not None
    ]
    estimated_values = [
        float(item["estimated_cost"])
        for item in usages
        if item.get("estimated_cost") is not None
    ]
    models = list(
        dict.fromkeys(
            str(model)
            for item in usages
            for model in item.get("models", [])
            if model
        )
    )
    base_urls = list(
        dict.fromkeys(
            str(base_url)
            for item in usages
            for base_url in item.get("base_urls", [])
            if base_url
        )
    )
    request_ids = list(
        dict.fromkeys(
            str(request_id)
            for item in usages
            for request_id in item.get("provider_request_ids", [])
            if request_id
        )
    )
    return {
        "input_tokens": sum(int(item.get("input_tokens") or 0) for item in usages) or None,
        "output_tokens": sum(int(item.get("output_tokens") or 0) for item in usages) or None,
        "unreported_input_tokens": sum(
            int(
                item.get(
                    "unreported_input_tokens",
                    item.get("input_tokens")
                    if item.get("reported_cost", item.get("cost")) is None
                    else 0,
                )
                or 0
            )
            for item in usages
        ),
        "unreported_output_tokens": sum(
            int(
                item.get(
                    "unreported_output_tokens",
                    item.get("output_tokens")
                    if item.get("reported_cost", item.get("cost")) is None
                    else 0,
                )
                or 0
            )
            for item in usages
        ),
        "reported_cost": sum(reported_values) if reported_values else None,
        "estimated_cost": (
            None if reported_values else sum(estimated_values) if estimated_values else None
        ),
        "cost_currency": next(iter(currencies)) if len(currencies) == 1 else None,
        "estimation_basis": (
            {}
            if reported_values
            else next(
                (
                    dict(item.get("estimation_basis") or {})
                    for item in usages
                    if item.get("estimated_cost") is not None
                ),
                {},
            )
        ),
        "models": models,
        "base_urls": base_urls,
        "provider_request_ids": request_ids,
    }


def strip_json_fence(value: str) -> str:
    value = value.strip()
    if value.startswith("```json"):
        value = value[7:]
    elif value.startswith("```"):
        value = value[3:]
    if value.endswith("```"):
        value = value[:-3]
    return value.strip()
