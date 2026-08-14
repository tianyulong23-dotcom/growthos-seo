from __future__ import annotations

import asyncio
from contextvars import ContextVar, Token
from dataclasses import replace
import json
from collections.abc import Sequence
from typing import Any
from uuid import uuid4

import httpx
import pycountry

from app.cache.client import get_redis
from app.core.config import Settings, get_settings
from app.modules.agent.providers import ProviderConfig, ProviderRequest, build_provider
from app.modules.content.dataforseo import (
    DataForSEOClient,
    normalize_language_code,
)
from app.modules.content_plan.domain import CandidateClassification, SeedCandidate
from app.modules.content_plan.service import (
    AICallResult,
    BusinessContext,
    ExpansionResult,
    ExpansionRow,
    ExpansionSeed,
    TopicClassificationInput,
)
from app.modules.settings.data_sources import (
    DataForSEOSettingsService,
    build_dataforseo_settings_service,
)
from app.modules.settings.service import AISettingsService, build_ai_settings_service


SYSTEM_PROMPT = "You are an SEO content-plan decision service."

ITEMS_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "content_plan_items",
        "strict": False,
        "schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {"type": "object"},
                }
            },
            "required": ["items"],
            "additionalProperties": False,
        },
    },
}

CLASSIFICATION_REASON_CODES = [
    "answers_how_to",
    "answers_cost_question",
    "answers_comparison",
    "answers_frequency",
    "answers_definition",
    "same_article_variant",
    "same_article_subquestion",
    "service_transactional",
    "product_transactional",
    "navigational_or_fragment",
    "too_narrow_for_primary",
    "unrelated_business",
    "uncertain_relevance",
]

RETRYABLE_HTTP_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

_organization_id: ContextVar[str | None] = ContextVar(
    "content_plan_organization_id", default=None
)


def bind_content_plan_organization(organization_id: str) -> Token[str | None]:
    return _organization_id.set(organization_id)


def reset_content_plan_organization(token: Token[str | None]) -> None:
    _organization_id.reset(token)


def current_content_plan_organization() -> str:
    organization_id = _organization_id.get()
    if not organization_id:
        raise RuntimeError("content_plan_organization_not_bound")
    return organization_id


class ContentPlanAIGateway:
    def __init__(self, settings_service: AISettingsService | None = None) -> None:
        self.settings_service = settings_service or build_ai_settings_service()

    async def decide(
        self,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        candidate_refs = {
            row.candidate_id: f"c{index}"
            for index, row in enumerate(candidates, start=1)
        }
        retained_refs = {
            row.candidate_id: f"r{index}"
            for index, row in enumerate(retained, start=1)
        }
        ref_to_candidate_id = {
            ref: candidate_id
            for candidate_id, ref in {**candidate_refs, **retained_refs}.items()
        }
        result = await self._complete(
            current_content_plan_organization(),
            "For every candidate return a decision in items. Each item must contain "
            "keyword_id, action (keep or drop), same_topic_as (keyword_id or null), "
            "and reason. Return each candidate keyword_id exactly once. Keep distinct "
            "article topics. Drop wording variants and bind them to their representative "
            "with same_topic_as. For candidates dropped without a representative, such "
            "as irrelevant or navigational queries, set same_topic_as to null.",
            {
                "business_context": business_context.to_payload(),
                "country": country,
                "language": language,
                "candidates": [
                    {
                        "keyword_id": candidate_refs[row.candidate_id],
                        "keyword": row.keyword,
                        "source_rank": row.source_rank,
                    }
                    for row in candidates
                ],
                "retained": [
                    {
                        "keyword_id": retained_refs[row.candidate_id],
                        "keyword": row.keyword,
                        "source_rank": row.source_rank,
                    }
                    for row in retained
                ],
                "validation_error": validation_error,
            },
            response_format=_seed_decision_response_format(
                list(candidate_refs.values()),
                [*candidate_refs.values(), *retained_refs.values()],
            ),
        )
        return replace(
            result,
            output=[
                {
                    **row,
                    "keyword_id": ref_to_candidate_id.get(
                        str(row.get("keyword_id")), str(row.get("keyword_id", ""))
                    ),
                    "same_topic_as": (
                        ref_to_candidate_id.get(
                            str(row.get("same_topic_as")),
                            str(row.get("same_topic_as")),
                        )
                        if row.get("same_topic_as") is not None
                        else None
                    ),
                }
                for row in result.output
                if isinstance(row, dict)
            ],
        )

    async def classify(
        self,
        seed_keyword: str,
        candidates: Sequence[CandidateClassification],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        candidate_ids = [row.candidate_id for row in candidates]
        return await self._complete(
            current_content_plan_organization(),
            "For every candidate return one item with candidate_id, relevance "
            "(same_topic or unrelated), keyword_type (informational, service, product, "
            "or unknown), primary_fit (strong, acceptable, or ineligible), "
            "secondary_candidate_ids, and reason_code. reason_code must be one of: "
            "answers_how_to, answers_cost_question, answers_comparison, "
            "answers_frequency, answers_definition, same_article_variant, "
            "same_article_subquestion, service_transactional, product_transactional, "
            "navigational_or_fragment, too_narrow_for_primary, unrelated_business, "
            "uncertain_relevance. Return every supplied candidate_id exactly once and "
            "never invent or alter an id. Only informational candidates may be primary.",
            {
                "business_context": business_context.to_payload(),
                "country": country,
                "language": language,
                "seed_keyword": seed_keyword,
                "candidates": [
                    {
                        "candidate_id": row.candidate_id,
                        "keyword": row.keyword,
                        "source": row.source,
                        "search_volume": row.search_volume,
                        "provider_position": row.provider_position,
                        "keyword_difficulty": row.keyword_difficulty,
                        "provider_intent": row.provider_intent,
                    }
                    for row in candidates
                ],
                "validation_error": validation_error,
            },
            response_format=_classification_response_format(candidate_ids),
        )

    async def classify_topics(
        self,
        topics: Sequence[TopicClassificationInput],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
    ) -> AICallResult:
        topic_refs = {
            topic.topic_id: f"t{topic_index}"
            for topic_index, topic in enumerate(topics, start=1)
        }
        candidate_refs = {
            candidate.candidate_id: f"t{topic_index}c{candidate_index}"
            for topic_index, topic in enumerate(topics, start=1)
            for candidate_index, candidate in enumerate(topic.candidates, start=1)
        }
        ref_to_topic_id = {ref: topic_id for topic_id, ref in topic_refs.items()}
        ref_to_candidate_id = {
            ref: candidate_id for candidate_id, ref in candidate_refs.items()
        }
        result = await self._complete(
            current_content_plan_organization(),
            "Classify every candidate in every topic independently. Return one item per "
            "candidate with topic_id, candidate_id, relevance (same_topic or unrelated), "
            "keyword_type (informational, service, product, or unknown), primary_fit "
            "(strong, acceptable, or ineligible), secondary_candidate_ids, and reason_code. "
            "Use only ids supplied for that topic. Never put an unrelated candidate in "
            "secondary_candidate_ids. Return every supplied candidate exactly once. Only "
            "informational candidates may be primary.",
            {
                "business_context": business_context.to_payload(),
                "country": country,
                "language": language,
                "topics": [
                    {
                        "topic_id": topic_refs[topic.topic_id],
                        "seed_keyword": topic.seed_keyword,
                        "candidates": [
                            {
                                "candidate_id": candidate_refs[candidate.candidate_id],
                                "keyword": candidate.keyword,
                                "source": candidate.source,
                                "search_volume": candidate.search_volume,
                                "provider_position": candidate.provider_position,
                                "keyword_difficulty": candidate.keyword_difficulty,
                                "provider_intent": candidate.provider_intent,
                            }
                            for candidate in topic.candidates
                        ],
                    }
                    for topic in topics
                ],
            },
            response_format=_bulk_classification_response_format(
                list(topic_refs.values()),
                list(candidate_refs.values()),
            ),
            minimum_timeout_seconds=360,
        )
        return replace(
            result,
            output=[
                {
                    **row,
                    "topic_id": ref_to_topic_id.get(
                        str(row.get("topic_id")), str(row.get("topic_id", ""))
                    ),
                    "candidate_id": ref_to_candidate_id.get(
                        str(row.get("candidate_id")), str(row.get("candidate_id", ""))
                    ),
                    "secondary_candidate_ids": [
                        ref_to_candidate_id.get(str(candidate_id), str(candidate_id))
                        for candidate_id in row.get("secondary_candidate_ids", [])
                    ],
                }
                for row in result.output
                if isinstance(row, dict)
            ],
        )

    async def generate(
        self,
        seed_keyword: str,
        *,
        business_context: BusinessContext,
        language: str,
        limit: int,
        validation_error: str | None = None,
    ) -> AICallResult:
        return await self._complete(
            current_content_plan_organization(),
            "Return items containing keyword and generation_reason. Generate distinct, "
            "natural informational long-tail keywords directly relevant to the business.",
            {
                "business_context": business_context.to_payload(),
                "seed_keyword": seed_keyword,
                "language": language,
                "limit": limit,
                "validation_error": validation_error,
            },
        )

    async def preview(
        self,
        primary_keyword: str,
        secondary_keywords: Sequence[str],
        *,
        evidence: dict[str, Any],
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        return await self._complete(
            current_content_plan_organization(),
            "Return one item with title, writing_direction, and evidence_ids. The title "
            "must be plain text up to 120 characters. writing_direction must be 1 to 3 "
            "plain-text sentences up to 600 characters, not an outline. evidence_ids must "
            "contain only ids supplied in the SERP evidence.",
            {
                "primary_keyword": primary_keyword,
                "secondary_keywords": list(secondary_keywords),
                "country": country,
                "language": language,
                "evidence": evidence,
                "validation_error": validation_error,
            },
        )

    async def _complete(
        self,
        organization_id: str,
        instruction: str,
        payload: dict[str, Any],
        *,
        response_format: dict[str, Any] | None = None,
        minimum_timeout_seconds: int = 0,
    ) -> AICallResult:
        record = await self.settings_service.effective_record_for_organization(
            organization_id
        )
        record = record.for_task("content")
        provider = build_provider(
            ProviderConfig(
                provider=record.provider,
                api_protocol=record.api_protocol,
                base_url=record.base_url,
                api_key=record.api_key,
                model=record.model,
                timeout_seconds=max(
                    record.request_timeout_seconds, minimum_timeout_seconds
                ),
                max_retries=0,
                reasoning_effort=record.reasoning_effort,
            )
        )
        result = await provider.complete(
            ProviderRequest(
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "system", "content": instruction},
                    {
                        "role": "user",
                        "content": json.dumps(
                            payload, ensure_ascii=False, separators=(",", ":")
                        ),
                    },
                ],
                response_format=response_format or ITEMS_RESPONSE_FORMAT,
            )
        )
        content = str(result.message.get("content") or "").strip()
        if content.startswith("```"):
            content = content.removeprefix("```json").removeprefix("```")
            content = content.removesuffix("```").strip()
        parsed = json.loads(content)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("items"), list):
            raise ValueError("content plan AI response must contain an items array")
        return AICallResult(
            output=parsed["items"],
            provider=result.provider,
            model=result.response_model,
            request_id=result.response_id or f"ai-{uuid4().hex}",
            input_tokens=result.usage.input_tokens or 0,
            output_tokens=result.usage.output_tokens or 0,
            cost_usd=result.usage.cost or 0,
        )


class ContentPlanDataForSEOGateway:
    def __init__(
        self,
        settings: Settings | None = None,
        settings_service: DataForSEOSettingsService | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.settings_service = settings_service or build_dataforseo_settings_service()

    async def search(
        self,
        keyword: str,
        country: str,
        language: str,
        device: str = "desktop",
    ):
        record = await self.settings_service.effective_record_for_organization(
            current_content_plan_organization()
        )
        client = DataForSEOClient(
            login=record.login,
            password=record.password,
            base_url=self.settings.dataforseo_base_url,
            cache=get_redis(),
            cache_ttl_seconds=self.settings.dataforseo_cache_ttl_seconds,
            timeout_seconds=self.settings.dataforseo_timeout_seconds,
        )
        return await client.search(keyword, country, language, device)

    async def submit_serp_task(
        self,
        keyword: str,
        country: str,
        language: str,
        device: str = "desktop",
        *,
        tag: str,
    ):
        client = await self._serp_client()
        return await client.submit_serp_task(
            keyword,
            country,
            language,
            device,
            tag=tag,
        )

    async def get_serp_task(self, task_id: str, keyword: str):
        client = await self._serp_client()
        return await client.get_serp_task(task_id, keyword)

    async def find_ready_serp_task(self, tag: str) -> str | None:
        client = await self._serp_client()
        return await client.find_ready_serp_task(tag)

    async def _serp_client(self) -> DataForSEOClient:
        record = await self.settings_service.effective_record_for_organization(
            current_content_plan_organization()
        )
        return DataForSEOClient(
            login=record.login,
            password=record.password,
            base_url=self.settings.dataforseo_base_url,
            cache=get_redis(),
            cache_ttl_seconds=self.settings.dataforseo_cache_ttl_seconds,
            timeout_seconds=self.settings.dataforseo_timeout_seconds,
        )

    async def expand(
        self,
        seeds: Sequence[ExpansionSeed],
        *,
        country: str,
        language: str,
    ) -> list[ExpansionResult]:
        if len(seeds) > 30:
            raise ValueError("Related Keywords 一个逻辑批次最多接受 30 个种子词")
        if len({seed.request_index for seed in seeds}) != len(seeds):
            raise ValueError("Related Keywords request_index 必须唯一")
        if len({seed.tag for seed in seeds}) != len(seeds):
            raise ValueError("Related Keywords tag 必须唯一")
        record = await self.settings_service.effective_record_for_organization(
            current_content_plan_organization()
        )
        semaphore = asyncio.Semaphore(5)
        async with httpx.AsyncClient(
            base_url=self.settings.dataforseo_base_url.rstrip("/") + "/v3",
            auth=(record.login, record.password),
            timeout=self.settings.dataforseo_timeout_seconds,
        ) as client:
            async def fetch(seed: ExpansionSeed) -> ExpansionResult:
                async with semaphore:
                    return await self._related_request(
                        client, seed, country=country, language=language
                    )

            results = await asyncio.gather(*(fetch(seed) for seed in seeds))
        request_order = {
            seed.preparation_id: seed.request_index for seed in seeds
        }
        return sorted(results, key=lambda row: request_order[row.preparation_id])

    async def _related_request(
        self,
        client: httpx.AsyncClient,
        seed: ExpansionSeed,
        *,
        country: str,
        language: str,
    ) -> ExpansionResult:
        task = {
            "keyword": seed.keyword,
            "location_name": _country_name(country),
            "language_code": normalize_language_code(language),
            "limit": 100,
            "include_seed_keyword": True,
            "include_serp_info": False,
            "tag": seed.tag,
        }
        try:
            response = await client.post(
                "dataforseo_labs/google/related_keywords/live", json=[task]
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.TransportError as exc:
            return ExpansionResult(
                preparation_id=seed.preparation_id,
                status="uncertain",
                error_code="external_request_outcome_unknown",
                error_detail=str(exc),
            )
        except httpx.HTTPStatusError as exc:
            status = (
                "retryable_failed"
                if exc.response.status_code in RETRYABLE_HTTP_STATUSES
                else "failed"
            )
            return ExpansionResult(
                preparation_id=seed.preparation_id,
                status=status,
                error_code=(
                    "expansion_failed"
                    if status == "retryable_failed"
                    else "expansion_request_rejected"
                ),
                error_detail=str(exc),
            )
        except ValueError as exc:
            return ExpansionResult(
                preparation_id=seed.preparation_id,
                status="uncertain",
                error_code="external_request_outcome_unknown",
                error_detail=str(exc),
            )
        tasks = payload.get("tasks") if isinstance(payload, dict) else None
        provider_task = tasks[0] if isinstance(tasks, list) and tasks else None
        if not isinstance(provider_task, dict):
            return ExpansionResult(
                preparation_id=seed.preparation_id,
                status="uncertain",
                error_code="external_request_outcome_unknown",
                error_detail="DataForSEO response did not contain one task",
            )
        cost = _number(provider_task.get("cost"))
        request_id = str(provider_task.get("id") or "") or None
        task_data = provider_task.get("data")
        response_tag = task_data.get("tag") if isinstance(task_data, dict) else None
        if response_tag != seed.tag:
            return ExpansionResult(
                preparation_id=seed.preparation_id,
                status="uncertain",
                provider_request_id=request_id,
                cost_usd=cost,
                error_code="external_response_mismatch",
                error_detail="DataForSEO response tag did not match the request",
            )
        if provider_task.get("status_code") != 20000:
            return ExpansionResult(
                preparation_id=seed.preparation_id,
                status="charged_failed" if cost > 0 else "retryable_failed",
                provider_request_id=request_id,
                cost_usd=cost,
                error_code=(
                    "expansion_charged_failed" if cost > 0 else "expansion_failed"
                ),
                error_detail=str(provider_task.get("status_message") or "task failed"),
            )
        results = provider_task.get("result") or []
        first = results[0] if isinstance(results, list) and results else {}
        items = first.get("items") if isinstance(first, dict) else []
        rows: list[ExpansionRow] = []
        for index, raw in enumerate(items or [], start=1):
            if not isinstance(raw, dict):
                continue
            data = raw.get("keyword_data")
            data = data if isinstance(data, dict) else raw
            keyword = data.get("keyword")
            if not isinstance(keyword, str) or not keyword.strip():
                continue
            info = data.get("keyword_info") if isinstance(data.get("keyword_info"), dict) else {}
            props = data.get("keyword_properties") if isinstance(data.get("keyword_properties"), dict) else {}
            intent = data.get("search_intent_info") if isinstance(data.get("search_intent_info"), dict) else {}
            rows.append(
                ExpansionRow(
                    keyword=keyword.strip(),
                    provider_position=index,
                    search_volume=_integer(info.get("search_volume")),
                    keyword_difficulty=_integer(props.get("keyword_difficulty")),
                    provider_intent=(
                        str(intent.get("main_intent")) if intent.get("main_intent") else None
                    ),
                    raw_item=raw,
                )
            )
        return ExpansionResult(
            preparation_id=seed.preparation_id,
            status="completed",
            rows=tuple(rows),
            provider_request_id=request_id,
            cost_usd=cost,
        )


def _country_name(country: str) -> str:
    value = country.strip()
    if len(value) == 2:
        match = pycountry.countries.get(alpha_2=value.upper())
        if match is not None:
            return str(match.name)
    return value


def _seed_decision_response_format(
    candidate_refs: list[str],
    reference_refs: list[str],
) -> dict[str, Any]:
    decision_properties = {
        "keyword_id": {"type": "string", "enum": candidate_refs},
        "action": {"type": "string", "enum": ["keep", "drop"]},
        "same_topic_as": {
            "anyOf": [
                {"type": "string", "enum": reference_refs},
                {"type": "null"},
            ]
        },
        "reason": {"type": "string"},
    }
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "content_plan_seed_decision",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "minItems": len(candidate_refs),
                        "maxItems": len(candidate_refs),
                        "items": {
                            "type": "object",
                            "properties": decision_properties,
                            "required": list(decision_properties),
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["items"],
                "additionalProperties": False,
            },
        },
    }


def _classification_response_format(candidate_ids: list[str]) -> dict[str, Any]:
    decision_properties = {
        "candidate_id": {"type": "string", "enum": candidate_ids},
        "relevance": {"type": "string", "enum": ["same_topic", "unrelated"]},
        "keyword_type": {
            "type": "string",
            "enum": ["informational", "service", "product", "unknown"],
        },
        "primary_fit": {
            "type": "string",
            "enum": ["strong", "acceptable", "ineligible"],
        },
        "secondary_candidate_ids": {
            "type": "array",
            "items": {"type": "string", "enum": candidate_ids},
        },
        "reason_code": {"type": "string", "enum": CLASSIFICATION_REASON_CODES},
    }
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "content_plan_classification",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "minItems": len(candidate_ids),
                        "maxItems": len(candidate_ids),
                        "items": {
                            "type": "object",
                            "properties": decision_properties,
                            "required": list(decision_properties),
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["items"],
                "additionalProperties": False,
            },
        },
    }


def _bulk_classification_response_format(
    topic_ids: list[str],
    candidate_ids: list[str],
) -> dict[str, Any]:
    response_format = _classification_response_format(candidate_ids)
    json_schema = response_format["json_schema"]
    json_schema["name"] = "content_plan_bulk_classification"
    decision_schema = json_schema["schema"]["properties"]["items"]["items"]
    decision_schema["properties"] = {
        "topic_id": {"type": "string", "enum": topic_ids},
        **decision_schema["properties"],
    }
    decision_schema["required"] = list(decision_schema["properties"])
    return response_format


def _integer(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _number(value: Any) -> float:
    return max(0.0, float(value)) if isinstance(value, (int, float)) else 0.0


__all__ = [
    "ContentPlanAIGateway",
    "ContentPlanDataForSEOGateway",
    "bind_content_plan_organization",
    "reset_content_plan_organization",
]
