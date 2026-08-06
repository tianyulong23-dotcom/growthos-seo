from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import pycountry

from seo_workers.keywords.domain import (
    INITIAL_LIBRARY_APPROVAL_SCORES,
    INITIAL_LIBRARY_REJECTION_REASONS,
    RawKeyword,
    SEED_POOL_LIMIT,
    SEED_POOL_MAX_GROUP_SIZE,
    SEED_POOL_MIN_GROUPS,
    SeedCandidate,
    SeedPoolGroup,
    TopicDuplicatePair,
    display_keyword,
    infer_business_model,
)


LANGUAGE_ALIASES = {
    "zh-hans": "zh",
    "zh-hant": "zh",
    "es-419": "es",
    "pt-br": "pt",
    "pt-pt": "pt",
}

TOPIC_DEDUP_REASONING_EFFORT = "low"
TOPIC_DEDUP_MAX_COMPLETION_TOKENS = 5000
RETRYABLE_FAILURE = "retryable_failed"
CHARGED_FAILURE = "charged_failed"
UNCERTAIN_FAILURE = "uncertain"


class ProviderError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        transient: bool = False,
        failure_status: str = RETRYABLE_FAILURE,
        cost_usd: float = 0.0,
        path: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.transient = transient
        self.failure_status = failure_status
        self.cost_usd = max(cost_usd, 0.0)
        self.path = list(path or [])
        self.metadata = dict(metadata or {})


@dataclass(frozen=True)
class AIProviderConfig:
    base_url: str
    api_key: str = field(repr=False)
    model: str
    timeout_seconds: int
    max_retries: int
    initial_filter_model: str = ""
    topic_dedup_model: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key and self.model)

    @property
    def effective_initial_filter_model(self) -> str:
        return self.initial_filter_model.strip() or self.model

    @property
    def effective_topic_dedup_model(self) -> str:
        return self.topic_dedup_model.strip() or self.model


@dataclass(frozen=True)
class DataForSEOProviderConfig:
    login: str
    password: str = field(repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.login and self.password)


@dataclass(frozen=True)
class GSCProviderConfig:
    project_id: str
    site_url: str
    refresh_token: str = field(repr=False)
    client_id: str
    client_secret: str = field(repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.site_url and self.refresh_token and self.client_id and self.client_secret)


@dataclass(frozen=True)
class DataForSEOBilling:
    cost_usd: float
    path: list[str]


@dataclass(frozen=True)
class GSCQueryRow:
    query: str
    clicks: float
    impressions: float
    ctr: float
    position: float
    raw_payload: dict[str, Any]


@dataclass(frozen=True)
class AIResult:
    payload: dict[str, Any]
    usage: dict[str, int]
    model: str
    cost_usd: float = 0.0


@dataclass(frozen=True)
class CompetitorGap:
    keyword: str
    provider_rank: int
    competitor_rank: int | None
    own_rank: int | None
    competitor_url: str | None
    own_url: str | None
    search_volume: int | None
    cpc: float | None
    competition: float | None
    keyword_difficulty: int | None
    intent: str | None
    monthly_searches: list[dict[str, Any]]
    raw_payload: dict[str, Any]
    competition_level: str | None = None
    metrics_fetched_at: datetime | None = None


@dataclass(frozen=True)
class DiscoveredCompetitor:
    domain: str
    provider_rank: int
    avg_position: float | None
    median_position: float | None
    rating: float | None
    etv: float | None
    keywords_count: int | None
    visibility: float | None
    relevant_serp_items: int | None
    keywords_positions: dict[str, Any]
    raw_payload: dict[str, Any]


def strict_object_schema(
    properties: dict[str, Any],
    *,
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required if required is not None else list(properties),
        "additionalProperties": False,
    }


def string_array_schema(
    *,
    enum: list[str] | None = None,
    min_items: int = 0,
    max_items: int | None = None,
) -> dict[str, Any]:
    item_schema: dict[str, Any] = {"type": "string"}
    if enum is not None:
        item_schema["enum"] = enum
    schema: dict[str, Any] = {
        "type": "array",
        "items": item_schema,
        "minItems": min_items,
    }
    if max_items is not None:
        schema["maxItems"] = max_items
    return schema


def fallback_profile_schema() -> dict[str, Any]:
    return strict_object_schema(
        {
            "business_name": {"type": "string"},
            "business_type": {"type": "string"},
            "business_model": {
                "type": "string",
                "enum": ["product", "service", "software", "content", "mixed"],
            },
            "business_summary": {"type": "string"},
            "products_services": string_array_schema(),
            "target_audiences": string_array_schema(),
            "use_cases": string_array_schema(),
            "content_topics": string_array_schema(),
            "exclusion_terms": string_array_schema(),
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "evidence_summary": {"type": "string"},
        }
    )


def seed_topic_representatives_schema(
    candidates: list[SeedCandidate],
) -> dict[str, Any]:
    candidate_ids = [f"k{index:03d}" for index in range(1, len(candidates) + 1)]
    return strict_object_schema(
        {
            "topics": {
                "type": "array",
                "minItems": 1,
                "maxItems": len(candidate_ids),
                "items": strict_object_schema(
                    {
                        "object": {"type": "string", "minLength": 1, "maxLength": 120},
                        "need": {"type": "string", "minLength": 1, "maxLength": 120},
                        "page_intent": {
                            "type": "string",
                            "enum": [
                                "product",
                                "informational",
                                "commercial",
                                "service",
                            ],
                        },
                        "representative": {
                            "type": "string",
                            "enum": candidate_ids,
                        },
                        "members": string_array_schema(
                            enum=candidate_ids,
                            min_items=1,
                            max_items=min(8, len(candidate_ids)),
                        ),
                    }
                ),
            },
            "excluded": string_array_schema(
                enum=candidate_ids,
                max_items=len(candidate_ids),
            ),
        }
    )


def initial_library_filter_schema(candidates: list[SeedCandidate]) -> dict[str, Any]:
    categories = [*INITIAL_LIBRARY_APPROVAL_SCORES, *INITIAL_LIBRARY_REJECTION_REASONS]
    return strict_object_schema(
        {
            "decisions": {
                "type": "array",
                "items": {"type": "string", "enum": categories},
                "minItems": len(candidates),
                "maxItems": len(candidates),
            }
        }
    )


def topic_selection_schema(
    topics: list[dict[str, Any]],
    duplicate_pairs: list[TopicDuplicatePair],
) -> dict[str, Any]:
    pair_ids = [pair.pair_id for pair in duplicate_pairs]
    return strict_object_schema(
        {
            "duplicate_pair_ids": string_array_schema(
                enum=pair_ids,
                max_items=len(pair_ids),
            ),
        }
    )


def keyword_classification_schema(
    row_count: int,
    seeds: list[dict[str, Any]],
) -> dict[str, Any]:
    keyword_ids = [f"q{index:03d}" for index in range(1, row_count + 1)]
    seed_ids = [str(seed["id"]) for seed in seeds]
    primary_seed_schema: dict[str, Any] = {
        "type": ["string", "null"],
        "enum": [*seed_ids, None],
    }
    return strict_object_schema(
        {
            "items": {
                "type": "array",
                "minItems": row_count,
                "maxItems": row_count,
                "items": strict_object_schema(
                    {
                        "id": {"type": "string", "enum": keyword_ids},
                        "relevant": {"type": "boolean"},
                        "business_topic": {"type": ["string", "null"]},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "review_status": {
                            "type": "string",
                            "enum": ["approved", "needs_review"],
                        },
                        "reason": {"type": "string"},
                        "primary_seed_id": primary_seed_schema,
                        "related_seed_ids": string_array_schema(
                            enum=seed_ids,
                            max_items=min(4, len(seed_ids)),
                        ),
                    }
                ),
            }
        }
    )


def competitor_validation_schema(row_count: int) -> dict[str, Any]:
    gap_ids = [f"g{index:03d}" for index in range(1, min(row_count, 100) + 1)]
    return strict_object_schema(
        {
            "status": {
                "type": "string",
                "enum": ["confirmed", "skipped_unrelated", "skipped_uncertain"],
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "reason": {"type": "string"},
            "relevant_ids": string_array_schema(
                enum=gap_ids,
                max_items=len(gap_ids),
            ),
        }
    )


def competitive_query_selection_schema(candidate_count: int) -> dict[str, Any]:
    ids = [f"q{index:03d}" for index in range(1, candidate_count + 1)]
    return strict_object_schema(
        {
            "queries": {
                "type": "array",
                "minItems": 5,
                "maxItems": 10,
                "items": strict_object_schema(
                    {
                        "id": {"type": "string", "enum": ids},
                        "intent": {
                            "type": "string",
                            "enum": [
                                "informational",
                                "commercial",
                                "comparison",
                                "transactional",
                                "navigational",
                            ],
                        },
                        "reason": {"type": "string"},
                    }
                ),
            },
            "directional": {"type": "boolean"},
        }
    )


def competitive_domain_classification_schema(candidate_count: int) -> dict[str, Any]:
    ids = [f"d{index:03d}" for index in range(1, candidate_count + 1)]
    return strict_object_schema(
        {
            "domains": {
                "type": "array",
                "minItems": candidate_count,
                "maxItems": candidate_count,
                "items": strict_object_schema(
                    {
                        "id": {"type": "string", "enum": ids},
                        "type": {
                            "type": "string",
                            "enum": [
                                "direct_product_competitor",
                                "publisher_media",
                                "marketplace_directory",
                                "community_forum",
                                "documentation_resource",
                            ],
                        },
                        "is_seo_competitor": {"type": "boolean"},
                        "is_business_competitor": {"type": "boolean"},
                        "relevant_publisher": {"type": "boolean"},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "why_they_matter": {"type": "string"},
                        "site_relation": {
                            "type": "string",
                            "enum": ["related", "unrelated", "uncertain"],
                        },
                        "site_reason": {"type": "string"},
                    }
                ),
            }
        }
    )


def backlink_validation_schema(candidate_count: int) -> dict[str, Any]:
    ids = [f"d{index:03d}" for index in range(1, candidate_count + 1)]
    return strict_object_schema(
        {
            "domains": {
                "type": "array",
                "minItems": candidate_count,
                "maxItems": candidate_count,
                "items": strict_object_schema(
                    {
                        "id": {"type": "string", "enum": ids},
                        "needed": {"type": "boolean"},
                        "reason": {"type": "string"},
                    }
                ),
            }
        }
    )


def competitive_landscape_summary_schema(domains: list[str]) -> dict[str, Any]:
    domain_schema: dict[str, Any] = {"type": "string"}
    if domains:
        domain_schema["enum"] = domains
    return strict_object_schema(
        {
            "market_read": {"type": "string"},
            "market_leaders": {
                "type": "array",
                "items": strict_object_schema(
                    {"domain": {"type": "string"}, "why": {"type": "string"}}
                ),
            },
            "most_winnable_opportunity": {"type": "string"},
            "biggest_barrier": {"type": "string"},
            "content_formats": string_array_schema(),
            "winning_themes": string_array_schema(),
            "keyword_theme_gaps": string_array_schema(),
            "backlink_authority_observations": string_array_schema(),
            "competitor_findings": {
                "type": "array",
                "minItems": len(domains),
                "maxItems": len(domains),
                "items": strict_object_schema(
                    {
                        "domain": domain_schema,
                        "type": {
                            "type": "string",
                            "enum": [
                                "direct_product_competitor",
                                "publisher_media",
                                "marketplace_directory",
                                "community_forum",
                                "documentation_resource",
                            ],
                        },
                        "why_they_matter": {"type": "string"},
                        "organic_footprint": {"type": "string"},
                        "winning_themes": string_array_schema(),
                        "weakness_gap": {"type": "string"},
                    }
                ),
            },
            "recommended_workflows": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["competitor_analysis", "keyword_clustering", "content_brief"],
                },
            },
        }
    )


def compact_seed_profile(profile: dict[str, Any]) -> dict[str, Any]:
    def text_value(key: str, limit: int) -> str:
        value = profile.get(key)
        return str(value).strip()[:limit] if isinstance(value, str) else ""

    def list_value(key: str, *, item_limit: int = 30, text_limit: int = 120) -> list[str]:
        value = profile.get(key)
        if not isinstance(value, list):
            return []
        return [
            cleaned[:text_limit] for item in value[:item_limit] if (cleaned := str(item).strip())
        ]

    values = {
        "name": text_value("business_name", 200),
        "model": infer_business_model(profile),
        "type": text_value("business_type", 200),
        "summary": text_value("business_summary", 1_500),
        "offerings": list_value("products_services"),
        "audiences": list_value("target_audiences", item_limit=20),
        "topics": list_value("content_topics"),
        "exclude": list_value("exclusion_terms"),
    }
    return {key: value for key, value in values.items() if value}


def business_model_seed_guidance(model: str) -> str:
    guidance = {
        "product": (
            "Prioritize product categories, product needs, customer problems, use cases, "
            "comparisons, and how-to topics. Product forms are useful only when they lead to "
            "meaningfully different expansion directions."
        ),
        "service": (
            "Prioritize core services, customer problems, desired outcomes, service scenarios, "
            "cost, process, selection, and qualification topics. Service-intent keywords are "
            "valid when the website provides that service. Do not require product keywords."
        ),
        "software": (
            "Prioritize capabilities, jobs to be done, use cases, integrations, customer "
            "problems, comparisons, and alternatives. Do not require physical-product topics."
        ),
        "content": (
            "Prioritize subject areas, recurring audience questions, guides, tutorials, and "
            "problem-solving themes. Do not require product or service keywords."
        ),
        "mixed": (
            "Cover the website's evidenced products, services, capabilities, customer problems, "
            "use cases, comparisons, and informational themes without forcing any one type."
        ),
    }
    return guidance.get(model, guidance["mixed"])


def seed_topic_example_guidance(model: str) -> str:
    examples = {
        "product": (
            "Product-topic normalization examples:\n"
            "- Normalize car, auto, automotive, and vehicle wording to the same object\n"
            "- Use car interior, car glass, car paint, headlight, tire, car wash, and car "
            "detailing as canonical object examples when applicable\n"
            "- tire shine and car tire shine are one topic: tire + shine + product\n"
            "- tire cleaner and car tire cleaner are one topic: tire + cleaning + product\n"
            "- car window cleaner and streak free car window cleaner are one topic: car glass "
            "+ cleaning + product\n"
            "- car scratch remover and scratch remover are one topic when both refer to car "
            "paint scratch removal\n"
            "- car window cleaner and remove water spots from car glass are separate topics\n"
            "- tire cleaner, tire shine, and tire coating are three separate topics\n"
            "- headlight cleaning, restoration, polishing, coating, and scratch removal are "
            "separate needs\n"
            "- car detailing products and car detailing kits are separate when product "
            "sourcing and kit searches produce different expansions\n"
            "- Do not assign different page intents to close wording variations solely to keep "
            "both topics"
        ),
        "service": (
            "Service-topic normalization examples:\n"
            "- plumber and plumbing service may be one general service topic\n"
            "- emergency plumbing, drain cleaning, and water-heater repair are separate "
            "service topics\n"
            "- solar installation, solar installation cost, and solar installation process "
            "are separate when they produce different expansion directions\n"
            "- repair, installation, maintenance, booking, cost, and provider selection are "
            "different needs when explicitly stated\n"
            "- A service category and a specific customer problem may both be retained"
        ),
        "software": (
            "Software-topic normalization examples:\n"
            "- CRM software and customer relationship management software may be one topic\n"
            "- CRM integrations, CRM automation, CRM reporting, CRM alternatives, and CRM "
            "pricing are separate topics\n"
            "- A capability, integration, use case, comparison, and customer problem are "
            "different needs\n"
            "- A broad software category and a meaningful feature topic may both be retained"
        ),
        "content": (
            "Content-topic normalization examples:\n"
            "- how to grow tomatoes and tomato growing guide may be one topic\n"
            "- tomato growing, tomato plant diseases, container gardening, and seasonal "
            "planting are separate topics\n"
            "- A broad subject, recurring problem, tutorial, and comparison may be separate "
            "when users expect different content\n"
            "- Do not merge two subjects merely because the same audience reads both"
        ),
        "mixed": (
            "Mixed-model normalization examples:\n"
            "- Synonyms and wording-only variations may be one topic\n"
            "- A product, related service, customer problem, software capability, and guide "
            "are separate when they have different needs or page purposes\n"
            "- A broad parent topic and a meaningful subtopic may both be retained\n"
            "- Do not merge topics merely because they belong to the same industry"
        ),
    }
    return examples.get(model, examples["mixed"])


def seed_filter_categories(profile: dict[str, Any]) -> list[str]:
    def list_value(key: str) -> list[str]:
        value = profile.get(key)
        if not isinstance(value, list):
            return []
        return [text[:120] for item in value[:30] if (text := str(item).strip())]

    return list_value("content_topics") or list_value("products_services")


def build_seed_ranking_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [f"k{index:03d}", candidate.keyword, candidate.raw.search_volume]
        for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)
    business_model = str(profile_payload.get("model") or "mixed")
    model_guidance = business_model_seed_guidance(business_model)

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are an SEO keyword strategist.\n\n"
        "Input:\n"
        "- Website business information\n"
        "- Target country and language\n"
        "- Candidate keywords\n"
        "- Search volume\n\n"
        "Task:\n"
        "Select the best SEO seed keywords.\n\n"
        f"Website model: {business_model}\n"
        f"Model-specific rule: {model_guidance}\n\n"
        "A seed keyword should:\n"
        "- Be directly related to the website business.\n"
        "- Represent a meaningful SEO topic.\n"
        "- Have clear user intent.\n"
        "- Be expandable into related content.\n\n"
        "Selection priority:\n\n"
        "1. Business relevance\n"
        "2. Search intent\n"
        "3. Topic uniqueness\n"
        "4. Search volume\n\n"
        "Remove keywords that:\n"
        "- Are not directly relevant to the website.\n"
        "- Mainly represent offline services unless the website provides them.\n"
        "- Are navigation queries.\n"
        "- Are unrelated brands.\n"
        "- Are too specific for a single article.\n"
        "- Are only keyword variations of another topic.\n\n"
        "Topic deduplication:\n\n"
        "Group keywords with the same SEO topic.\n\n"
        "Only keep one keyword per topic.\n\n"
        "Two keywords are duplicates when:\n"
        "- They would target the same page.\n"
        "- They have the same SERP intent.\n"
        "- They belong to the same content cluster.\n\n"
        "Apply deduplication to both active and reserve.\n\n"
        "When choosing between similar keywords, keep the one with:\n"
        "- Better business relevance.\n"
        "- Better SEO expansion potential.\n"
        "- Higher search volume.\n\n"
        "Active rules:\n\n"
        "If valid keywords >=20:\n"
        "- Select exactly 20 active keywords.\n"
        "- Each active keyword must represent a unique topic.\n\n"
        "If valid keywords <20:\n"
        "- Select all valid keywords.\n\n"
        "Reserve:\n"
        "- Store remaining valid but lower-priority unique topics.\n"
        "- Do not include rejected or duplicate keywords.\n\n"
        "Output JSON only:\n\n"
        "{\n"
        ' "active":["k001","k002"],\n'
        ' "reserve":["k003","k004"]\n'
        "}\n\n"
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate schema: [id, keyword, search_volume]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


def build_diverse_seed_pool_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [f"k{index:03d}", candidate.keyword, candidate.raw.search_volume]
        for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)
    required_count = min(SEED_POOL_LIMIT, len(candidates))
    minimum_groups = min(SEED_POOL_MIN_GROUPS, required_count)

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are building a diverse candidate pool for SEO seed expansion.\n\n"
        "The candidates were already cleaned by deterministic rules. Select exactly "
        f"{required_count} candidate IDs and organize them into exactly {minimum_groups} "
        "specific SEO topic groups.\n\n"
        "A topic group is one distinct long-tail expansion direction. It is not a broad "
        "industry category. Keywords that would generate substantially the same keyword "
        "ideas belong in the same group.\n\n"
        "Selection rules:\n"
        "- Select only candidates relevant to the website's actual business model\n"
        "- Cover different products, customer problems, solutions, use cases, and purchase "
        "needs\n"
        "- Prefer candidates that can expand into multiple useful long-tail keywords\n"
        "- Use search volume only after business relevance and topic coverage\n"
        "- Do not select malformed phrases, unrelated queries, or offline service queries "
        "that the website does not provide\n"
        "- Do not let one high-volume topic dominate the pool\n\n"
        "Grouping rules:\n"
        f"- Each group must contain exactly {SEED_POOL_MAX_GROUP_SIZE} candidate IDs\n"
        "- Each candidate ID may appear once only\n"
        "- Similar wording and the same expansion direction must stay in one group\n"
        "- Different products, problems, or user needs must remain separate\n"
        "- Topic labels must be short, specific, and unique\n"
        "- Order groups by business value\n"
        "- Within each group, order IDs from strongest to weakest representative\n\n"
        "Output JSON only:\n"
        '{"groups":[{"topic":"specific topic","ids":["k001","k002"]}]}\n\n'
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate schema: [id, keyword, search_volume]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


def build_natural_seed_clustering_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [f"k{index:03d}", candidate.keyword, candidate.raw.search_volume]
        for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are performing bounded SEO seed-topic clustering.\n\n"
        "The candidates were already cleaned by deterministic rules. Analyze every supplied "
        "candidate ID. Do not select final active seeds.\n\n"
        "Step 1 - Filter:\n"
        "- Keep candidates relevant to the website's actual business model\n"
        "- Valid topics may represent products, customer problems, solutions, use cases, "
        "how-to needs, or purchase needs\n"
        "- Exclude malformed phrases, unrelated queries, navigation queries, unrelated brands, "
        "and offline service queries that the website does not provide\n"
        "- Do not exclude a keyword because of low search volume\n\n"
        "Step 2 - Build a topic signature for every kept keyword:\n"
        "- object: the specific thing being searched for, such as tire, car glass, headlight, "
        "paint, or interior\n"
        "- need: the specific action or problem, such as cleaning, shine, water-spot removal, "
        "scratch repair, restoration, or protection\n"
        "- page_intent: the expected page purpose, such as product/category, informational "
        "how-to, commercial comparison, or service\n\n"
        "Step 3 - Cluster by the signature:\n"
        "- Put keywords together only when object, need, and page_intent are all equivalent\n"
        "- Related business topics are not automatically the same topic\n"
        "- Keep different objects, actions, problems, product forms, and page purposes separate\n"
        "- A member must be a true variation that would produce substantially the same "
        "long-tail expansion direction as the representative\n"
        "- car window cleaner and automotive glass cleaners may be grouped\n"
        "- car window cleaner and remove water spots from car glass must be separate\n"
        "- remove water spots from car glass and car glass scratch remover must be separate\n"
        "- tire cleaner, tire shine, and tire coating must be separate\n"
        "- ceramic coating and paint protection must be separate\n\n"
        "Step 4 - Apply bounded group sizes:\n"
        "- There is no required number of topic groups\n"
        "- Create no more than 100 topic groups\n"
        "- Each group may contain 1 to 8 candidate IDs\n"
        "- Never add a keyword to fill a group\n"
        "- If a proposed group has more than 8 members, it is too broad: split it by object, "
        "need, product form, or page_intent before output\n\n"
        "Step 5 - Choose a representative:\n"
        "- The representative must be one of the group's members\n"
        "- Prefer the clearest topic wording, then expansion potential, then search volume\n\n"
        "Output integrity:\n"
        "- Each candidate ID must appear exactly once: either in one group's members or in "
        "excluded\n"
        "- A candidate ID must never appear in more than one place\n"
        "- Topic labels must be short, specific, and unique\n"
        "- Order groups by business value\n"
        "- Within each group, order IDs from strongest to weakest representative\n"
        "- Before returning JSON, verify that all supplied IDs are accounted for exactly once\n\n"
        "Output JSON only:\n"
        '{"topics":[{"topic":"specific topic","object":"specific object",'
        '"need":"specific action or problem","page_intent":"page purpose",'
        '"representative":"k001",'
        '"members":["k001","k002"]}],"excluded":["k003"]}\n\n'
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate schema: [id, keyword, search_volume]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


def build_seed_topic_representatives_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [f"k{index:03d}", candidate.keyword, candidate.raw.search_volume]
        for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)
    business_model = str(profile_payload.get("model") or "mixed")
    model_guidance = business_model_seed_guidance(business_model)
    topic_examples = seed_topic_example_guidance(business_model)

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are selecting unique SEO topic representatives for a website's initial keyword "
        "library.\n\n"
        "The candidates were already cleaned by deterministic rules. Analyze all supplied "
        "candidate IDs and account for every ID exactly once.\n\n"
        "A topic is one distinct SEO page or content-group direction. Long-tail expansion will "
        "happen later when the user creates content.\n\n"
        "Business-model adaptation:\n"
        f"- Canonical website model: {business_model}\n"
        f"- {model_guidance}\n"
        "- Use the website evidence, not a fixed ecommerce template\n"
        "- A valid service, software, or informational topic does not need a product word\n\n"
        "For every topic, determine this signature:\n"
        "- object: the canonical thing being searched for\n"
        "- need: the canonical action, problem, service, capability, or product need\n"
        "- page_intent: exactly one of product, informational, commercial, or service\n\n"
        "Canonicalization is mandatory:\n"
        "- Build one shared canonical vocabulary and reuse the exact same labels throughout "
        "the output\n"
        "- object must be a short base noun phrase, not a copy of the full keyword\n"
        "- Remove wording modifiers that do not change the underlying topic\n"
        "- Normalize singular and plural wording to the singular form\n"
        "- Do not put the action, problem, intent, product form, or descriptive adjectives "
        "inside object merely to make a signature look unique\n"
        "- When an offering form changes the expansion direction, express it canonically in "
        "need, for example service, cost, process, feature, integration, product sourcing, kit, "
        "supply, or tool\n\n"
        "Topic rules:\n"
        "- Two keywords represent the same topic only when object, need, and page_intent are "
        "all equivalent\n"
        "- Related business topics are not automatically the same topic\n"
        "- Different objects, actions, problems, product forms, or page purposes are separate "
        "topics\n"
        "- Never merge two topics that have different canonical objects or different canonical "
        "needs merely because they belong to the same business category\n"
        "- A broad parent topic and a meaningful specific topic may both be retained when they "
        "produce different long-tail expansions\n\n"
        "Duplicate-group boundary:\n"
        "- A topic members array may contain 1 to 8 IDs only\n"
        "- Members must be true wording variants that target the same SEO page; never use a "
        "topic as a broad category bucket\n"
        "- Never add related-but-distinct keywords merely to fill a group\n"
        "- If more than 8 candidates appear related, split them by their specific object, need, "
        "offering form, or explicit page intent; a group larger than 8 is evidence that the "
        "topic is too broad\n\n"
        f"{topic_examples}\n\n"
        "Keep a topic only when it:\n"
        "- Is relevant to the website's actual business model\n"
        "- Represents a useful SEO page or content-group direction\n"
        "- Represents a product, service, capability, problem, solution, use case, comparison, "
        "how-to need, or purchase need appropriate to the website model\n\n"
        "Do not return topics based on:\n"
        "- Malformed or meaningless phrases\n"
        "- Unrelated queries, navigation queries, or unrelated brands\n"
        "- Offline services that the website does not provide\n"
        "- A wording variation already represented by another topic\n\n"
        "Intent rules:\n"
        "- Judge the dominant query intent from the keyword wording; do not relabel a "
        "service-dominant query as product merely because the website sells related products\n"
        "- A different intent requires an explicit wording difference such as how to, best, "
        "products, kit, service, shop, or near me\n"
        "- If the wording does not clearly prove a different intent, merge the variation into "
        "the stronger representative\n\n"
        "Representative selection:\n"
        "- representative must be one supplied candidate ID\n"
        "- representative must also appear in that topic's members array\n"
        "- Prefer the clearest topic wording\n"
        "- Then prefer stronger SEO content potential\n"
        "- Then prefer higher search volume\n\n"
        "Quantity and ordering:\n"
        "- Return every valid distinct topic; there is no fixed topic target\n"
        "- Do not create weak or duplicate topics to reach a number\n"
        "- Order topics by business relevance, SEO content potential, and then search volume\n\n"
        "Coverage check:\n"
        "- Review all candidates again after creating the initial topic list\n"
        "- Check for missing offerings, services, capabilities, products, customer problems, "
        "solutions, use cases, comparisons, and informational topics\n"
        "- Do not stop after listing only broad business categories\n"
        "- When uncertain, retain a relevant topic if it has a different canonical object, "
        "different canonical need, or an explicit different page intent\n\n"
        "Final semantic deduplication:\n"
        "- Compare every pair of proposed topics before output\n"
        "- Canonicalize both signatures again\n"
        "- Remove a topic only when the pair is a true wording variation with the same canonical "
        "object, same canonical need, same explicit intent, and the same expected SEO page\n"
        "- Do not remove related but distinct subtopics during this final check\n\n"
        "Output requirements:\n"
        "- Put every valid candidate ID in exactly one topic members array\n"
        "- Put every unusable candidate ID in excluded\n"
        "- Never put an ID in more than one place\n"
        "- Do not return reasons or explanations\n"
        "- Each representative ID may appear once only\n"
        "- Each object + need + page_intent signature may appear once only\n\n"
        "Output JSON only:\n"
        '{"topics":[{"object":"specific object","need":"specific action or problem",'
        '"page_intent":"page purpose","representative":"k001",'
        '"members":["k001","k002"]}],"excluded":["k003"]}\n\n'
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate schema: [id, keyword, search_volume]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


def build_initial_library_filter_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [f"k{index:03d}", candidate.keyword] for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)
    business_model = str(profile_payload.get("model") or "mixed")

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are a general SEO keyword usability filter.\n\n"
        "Classify every candidate exactly once using only the supplied website business "
        "information. Judge the complete search need, not isolated word overlap. The business "
        "profile is evidence, not permission to infer broader offerings, capabilities, locations, "
        "relationships, or content strategies.\n\n"
        "Allowed decisions:\n"
        "- keep: the query has a clear connection to an evidenced offering, audience need, use "
        "case, problem, solution, or suitable content topic and can serve as a meaningful SEO topic\n"
        "- remove_irrelevant: the underlying search need is clearly outside the evidenced business "
        "and target audience\n"
        "- remove_entity: the useful meaning depends on a brand, company, person, product, platform, "
        "publication, or other named entity that the business profile does not support\n"
        "- remove_navigation: the user is trying to reach a specific site, login, account, contact, "
        "support, official page, or other entity-specific destination\n"
        "- remove_unusable: the phrase is broken, meaningless, or so incomplete that it has no "
        "identifiable search need and cannot form a useful SEO topic\n\n"
        "Universal rules:\n"
        "- Keep broad or specific queries when they still express a clear, useful topic supported "
        "by the business evidence\n"
        "- Use keep only when the complete search need has affirmative support in the business "
        "profile; industry proximity or a shared general word is not affirmative support\n"
        "- If the phrase is understandable but its complete search need has no supported connection "
        "to the business or target audience, use remove_irrelevant\n"
        "- A mention, trial, demo, guide, comparison, compatibility statement, or partnership claim "
        "supports only what it explicitly says; never expand narrow evidence into a broader claim\n"
        "- Descriptive nouns such as app, service, software, store, product, provider, or platform "
        "are not named entities by themselves\n"
        "- Recognizable industry words do not make a broken or incomplete phrase usable; the full "
        "query must express an identifiable subject or search need\n"
        "- Do not remove a keyword because it is similar to another candidate, has low search "
        "volume, or could have more than one intent\n"
        "- Do not group, rank, rewrite, normalize, or deduplicate keywords in this step\n"
        "- Apply the same rules to every website and industry; do not invent domain-specific rules\n\n"
        "Decision order for every candidate:\n"
        "1. Check whether the complete phrase is usable and meaningful.\n"
        "2. Check navigation intent and unsupported named entities.\n"
        "3. Check the complete search need against the supplied business evidence.\n"
        "4. Use keep only after confirming an affirmative connection to the supplied evidence.\n\n"
        "Output integrity:\n"
        "- Return one category string for each candidate, in the exact supplied candidate order\n"
        "- decisions item 1 classifies k001, item 2 classifies k002, and so on\n"
        "- decisions must contain exactly the same number of items as the candidate list\n"
        "- Never include candidate IDs, explanations, scores, or any additional fields\n\n"
        "Return JSON only:\n"
        '{"decisions":["keep","remove_entity","remove_unusable"]}\n\n'
        f"Website business model: {business_model}\n"
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate schema: [id, keyword]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


def build_grouped_active_seed_prompt(
    *,
    groups: list[SeedPoolGroup],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    group_payload = [
        {
            "topic": group.topic,
            "candidates": [
                [candidate_id, candidate.keyword, candidate.raw.search_volume]
                for candidate_id, candidate in zip(
                    group.member_ids,
                    group.members,
                    strict=True,
                )
            ],
        }
        for group in groups
    ]
    profile_payload = compact_seed_profile(profile)
    required_count = min(20, len(groups))

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are selecting the final active SEO seeds from a grouped candidate pool.\n\n"
        f"Select exactly {required_count} candidate IDs. Each selected ID must come from a "
        "different topic group.\n\n"
        "Choose seeds that:\n"
        "- Are directly relevant to the website's business model and offerings\n"
        "- Create useful and distinct long-tail keyword expansion directions\n"
        "- Together cover core products, customer problems, solutions, use cases, and "
        "purchase needs\n"
        "- Are broad and natural representatives of their topic\n\n"
        "Within a topic, prefer the strongest representative. Use higher search volume only "
        "when business relevance and expansion potential are comparable.\n\n"
        "Do not select offline service intent unless the website provides that service. Do "
        "not select more than one ID from the same supplied topic group.\n\n"
        "Order active IDs from highest to lowest priority.\n\n"
        "Output JSON only:\n"
        '{"active":["k001","k002"]}\n\n'
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        f"Grouped candidates: {compact_json(group_payload)}"
    )


def build_seed_filter_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    del country, language

    def text_value(key: str, limit: int) -> str:
        value = profile.get(key)
        return str(value).strip()[:limit] if isinstance(value, str) else ""

    def list_value(key: str, limit: int = 30) -> list[str]:
        value = profile.get(key)
        if not isinstance(value, list):
            return []
        return [text[:120] for item in value[:limit] if (text := str(item).strip())]

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    business_type = text_value("business_type", 200)
    business_summary = text_value("business_summary", 1_500)
    business_model = infer_business_model(profile)
    model_guidance = business_model_seed_guidance(business_model)
    description = ". ".join(value for value in [business_type, business_summary] if value)
    products_or_services = list_value("products_services")
    target_audience = list_value("target_audiences", 20)
    allowed_categories = seed_filter_categories(profile)
    keyword_payload = [candidate.keyword for candidate in candidates]

    return (
        "You are an SEO keyword filtering and classification assistant.\n\n"
        "Evaluate each candidate keyword using the website information below.\n\n"
        "## Website\n\n"
        f"Business model: {business_model}\n\n"
        f"Business-model rule: {model_guidance}\n\n"
        "Description:\n"
        f"{description}\n\n"
        "Products or services:\n"
        f"{compact_json(products_or_services)}\n\n"
        "Target audience:\n"
        f"{compact_json(target_audience)}\n\n"
        "Allowed categories:\n"
        f"{compact_json(allowed_categories)}\n\n"
        "## Candidate Keywords\n\n"
        f"{compact_json(keyword_payload)}\n\n"
        "## Instructions\n\n"
        "For each keyword:\n\n"
        "1. Keep it only if it has a clear connection to the website's products, services, "
        "customer needs, or suitable content topics.\n"
        "2. Remove it if it is irrelevant, malformed, ambiguous, or only shares words with "
        "the business without matching the actual search need.\n"
        "3. Assign each retained keyword exactly one category from the allowed categories.\n"
        "4. Assign one dominant search intent:\n"
        "   - Informational: learning or solving a problem\n"
        "   - Commercial: comparing options before a decision\n"
        "   - Transactional: buying, subscribing, booking, downloading, or requesting a "
        "quote\n"
        "   - Navigational: finding a specific brand, website, or page\n\n"
        "Judge only business relevance. Do not use estimated search volume, keyword "
        "difficulty, or traffic potential.\n\n"
        "## Requirements\n\n"
        "- Preserve every keyword exactly as provided.\n"
        "- Do not generate new keywords.\n"
        "- Include every input keyword exactly once.\n"
        "- Use only the allowed categories.\n"
        "- Return valid JSON only.\n\n"
        "## Output\n\n"
        "{\n"
        '  "kept": [\n'
        "    {\n"
        '      "keyword": "Exact original keyword",\n'
        '      "category": "Allowed category",\n'
        '      "intent": "Informational | Commercial | Transactional | Navigational"\n'
        "    }\n"
        "  ],\n"
        '  "removed": [\n'
        "    {\n"
        '      "keyword": "Exact original keyword"\n'
        "    }\n"
        "  ]\n"
        "}"
    )


def build_active_seed_selection_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [
            f"k{index:03d}",
            candidate.keyword,
            candidate.selection_details.get("category"),
            candidate.raw.intent,
            candidate.raw.search_volume,
        ]
        for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)
    business_model = str(profile_payload.get("model") or "mixed")
    model_guidance = business_model_seed_guidance(business_model)
    required_count = min(20, len(candidates))

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are an SEO seed keyword selector.\n\n"
        "Context:\n"
        "- These candidates already passed an initial unusable-keyword filter\n"
        "- They are seeds for keyword expansion, not final article keywords\n\n"
        f"Business-model rule: {model_guidance}\n\n"
        "Task:\n"
        f"Select exactly {required_count} active seed keywords that create distinct and "
        "useful keyword-expansion directions.\n\n"
        "Keep seeds that:\n"
        "- Are directly relevant to the website's actual business model and offerings\n"
        "- Represent an appropriate product, service, capability, customer problem, use case, "
        "solution, comparison, or purchase need\n"
        "- Are broad enough to expand into multiple useful long-tail keywords\n"
        "- Together cover different parts of the business\n\n"
        "Do not select:\n"
        "- Offline service-intent keywords unless the website explicitly provides that "
        "service\n"
        "- A service merely because the website sells products used for that service\n"
        "- Single-article queries that have little expansion potential\n"
        "- Two seeds likely to generate substantially the same keyword ideas\n\n"
        "Treat synonyms, close variants, and broad/narrow wording with the same expansion "
        "direction as overlap. Related products may remain separate when they lead to "
        "materially different keyword ideas.\n\n"
        "Priority:\n"
        "1. Business relevance\n"
        "2. Coverage of distinct offerings, problems, use cases, comparisons, and conversion "
        "needs\n"
        "3. Long-tail expansion potential\n"
        "4. Search volume when the above factors are comparable\n\n"
        "Final check:\n"
        "- Compare every pair in active\n"
        "- Replace any overlapping seed with the best distinct alternative\n"
        f"- active must contain exactly {required_count} unique candidate IDs\n\n"
        "Output JSON only:\n"
        '{"active":["k001","k002"]}\n\n'
        f"Website business model: {business_model}\n"
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate order follows the pre-AI rule stage\n"
        "Candidate schema: [id, keyword, category, intent, search_volume]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


def build_topic_active_selection_prompt(
    *,
    topics: list[dict[str, Any]],
    duplicate_pairs: list[TopicDuplicatePair],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    topic_by_id = {str(topic["representative_id"]): topic for topic in topics}
    pair_payload = [
        [
            pair.pair_id,
            pair.left_id,
            topic_by_id[pair.left_id]["representative_keyword"],
            pair.right_id,
            topic_by_id[pair.right_id]["representative_keyword"],
            list(pair.signals),
        ]
        for pair in duplicate_pairs
    ]
    profile_payload = compact_seed_profile(profile)
    business_model = str(profile_payload.get("model") or "mixed")

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are confirming possible duplicate SEO topics.\n\n"
        "Known facts:\n"
        "- Every supplied topic already passed business-relevance filtering; do not filter or "
        "reject topics in this step\n"
        "- The program generated possible duplicate pairs using wording and topic labels; a "
        "listed pair is only a candidate, not proof of duplication\n\n"
        "Do exactly one task:\n"
        "- Return the pair IDs that are certainly true wording duplicates.\n\n"
        "Permission boundary:\n"
        "- You may confirm duplication only for a supplied pair ID\n"
        "- Never create a new pair and never merge topics that are not paired\n"
        "- The program will choose the retained representative and remove duplicates after "
        "your response\n\n"
        "Strict duplicate procedure:\n"
        "- Treat the keyword text as the source of truth; object, need, and page_intent are "
        "helpful labels but may be inconsistent\n"
        "- Inspect the two keyword phrases shown directly in every pair; do not rely on IDs "
        "or labels alone\n"
        "- Internally compare the canonical subject, user need, meaningful offering or content "
        "form, explicit page purpose, and meaningful qualifiers\n"
        "- Two keywords are duplicates only when all of those elements are equivalent and the "
        "phrases are interchangeable as the same SEO target\n"
        "- Duplicate detection must be conservative: a false merge is worse than retaining two "
        "partly overlapping topics\n"
        "- Treat synonyms, singular/plural forms, word-order changes, and non-meaningful "
        "modifiers as duplicates\n"
        "- Shared industry, category, object, or content cluster alone never proves duplication\n"
        "- Keep a broad parent topic and a meaningful subtopic separate\n"
        "- Keep two topics separate when a meaningful qualifier changes the audience, location, "
        "condition, feature, task, problem, comparison, transaction, or expected page purpose\n"
        "- Different informational, commercial, transactional, navigational, product, service, "
        "or support purposes are not duplicates\n"
        "- If there is any reasonable doubt, do not return that pair ID\n\n"
        "Output integrity:\n"
        "- duplicate_pair_ids may contain only supplied pair IDs and must not repeat\n"
        "- Return pair IDs only; do not return keywords, scores, reasons, rankings, or "
        "explanations\n\n"
        "Output JSON only:\n"
        '{"duplicate_pair_ids":["p001"]}\n\n'
        f"Website business model: {business_model}\n"
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Possible duplicate pair schema: "
        "[pair_id, left_topic_id, left_keyword, right_topic_id, right_keyword, signals]\n"
        f"Possible duplicate pairs: {compact_json(pair_payload)}"
    )


def build_seed_clustering_prompt(
    *,
    candidates: list[SeedCandidate],
    profile: dict[str, Any],
    country: str,
    language: str,
) -> str:
    candidate_payload = [
        [f"k{index:03d}", candidate.keyword, candidate.raw.search_volume]
        for index, candidate in enumerate(candidates, start=1)
    ]
    profile_payload = compact_seed_profile(profile)
    business_model = str(profile_payload.get("model") or "mixed")
    model_guidance = business_model_seed_guidance(business_model)

    def compact_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        "You are an SEO keyword topic clustering expert.\n\n"
        "Your task is to transform raw search queries into accurate SEO topic clusters.\n\n"
        "Input:\n"
        "- Website business information\n"
        "- Website business model\n"
        "- Target country and language\n"
        "- Candidate keywords\n"
        "- Search volume\n\n"
        f"Canonical website model: {business_model}\n"
        f"Model-specific rule: {model_guidance}\n\n"
        "Goal:\n"
        "Create SEO topics that can be used for future content planning.\n\n"
        "Important definition:\n\n"
        "A topic cluster represents keywords that can be targeted by ONE SEO landing page "
        "or one content group.\n\n"
        "A topic is NOT:\n"
        "- A broad industry category.\n"
        "- A general business area.\n"
        "- A collection of all related keywords.\n\n"
        "Prefer multiple specific SEO topics over a few broad topics.\n\n"
        "Step 1: Remove invalid keywords\n\n"
        "Exclude keywords that:\n\n"
        "- Are irrelevant to the website business.\n"
        "- Are clearly written in the wrong target language, except valid brand names or "
        "industry terms used by the target audience.\n"
        "- Are mainly navigation queries.\n"
        "- Are unrelated brands.\n"
        "- Are mainly offline service intent, such as hiring, booking, local providers, "
        "repair, maintenance, or installation, unless the website provides that service.\n"
        "- Are too narrow to represent a meaningful SEO topic.\n\n"
        "Do NOT exclude valid topics only because they are specific.\n\n"
        "Product categories, solutions, customer problems, and common use cases can be valid "
        "SEO topics. Core services, software capabilities, and recurring content subject areas "
        "are equally valid when supported by the website business model.\n\n"
        "Step 2: Create topic clusters\n\n"
        "Assign keywords into the same cluster ONLY when they:\n\n"
        "- Have the same search intent.\n"
        "- Target the same SERP.\n"
        "- Would require the same SEO page.\n"
        "- Would answer the same user need.\n\n"
        "Do NOT merge keywords only because they:\n"
        "- Belong to the same industry.\n"
        "- Share a general word.\n"
        "- Are related products.\n"
        "- Are under the same broad category.\n\n"
        "Examples of different topics:\n"
        "- Different product categories.\n"
        "- Different customer problems.\n"
        "- Different use cases.\n"
        "- Different purchase intents.\n\n"
        "A broad category and its subtopics should usually remain separate.\n\n"
        "Step 3: Topic assignment rules\n\n"
        "- Each keyword can belong to only ONE topic cluster.\n"
        "- Each keyword must have exactly one final status:\n"
        "  1. Assigned to one topic cluster.\n"
        "  2. Excluded.\n\n"
        "Never:\n"
        "- Assign one keyword to multiple clusters.\n"
        "- Put the same keyword in both topics and excluded.\n\n"
        "Step 4: Choose representative keyword\n\n"
        "For each topic cluster, select one representative keyword.\n\n"
        "Prefer keywords with:\n\n"
        "1. Strong business relevance.\n"
        "2. Clear topic representation.\n"
        "3. Better SEO expansion potential.\n"
        "4. Higher search volume when intent is the same.\n\n"
        "Step 5: Final quality check\n\n"
        "Before output:\n\n"
        "Check that:\n"
        "- Topic clusters are specific enough to become independent SEO pages.\n"
        "- No cluster contains multiple unrelated intents.\n"
        "- No keyword appears twice.\n"
        "- No keyword appears in both topics and excluded.\n\n"
        "Output JSON only:\n\n"
        "{\n"
        '  "topics": [\n'
        "    {\n"
        '      "representative": "k001",\n'
        '      "members": ["k001","k002"]\n'
        "    }\n"
        "  ],\n"
        '  "excluded": [\n'
        '    "k003"\n'
        "  ]\n"
        "}\n\n"
        f"Website business model: {profile_payload.get('type') or business_model}\n"
        f"Target country and language: {country}/{language}\n"
        f"Website business information: {compact_json(profile_payload)}\n"
        "Candidate schema: [id, keyword, search_volume]\n"
        f"Candidate keywords: {compact_json(candidate_payload)}"
    )


class JsonHttpClient:
    def __init__(
        self,
        *,
        timeout_seconds: int,
        max_retries: int,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            headers={"User-Agent": "SEOPlatform/1.0"},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        form_body: dict[str, Any] | None = None,
        auth: httpx.Auth | None = None,
        max_retries: int | None = None,
        paid_request: bool = False,
    ) -> tuple[dict[str, Any] | list[Any], httpx.Response]:
        retries = self.max_retries if max_retries is None else max_retries
        for attempt in range(retries + 1):
            try:
                response = await self.client.request(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    json=json_body,
                    data=form_body,
                    auth=auth,
                )
            except (httpx.ConnectTimeout, httpx.ConnectError, httpx.PoolTimeout) as exc:
                if attempt >= retries:
                    raise ProviderError(
                        "network_error",
                        "外部服务连接失败",
                        transient=True,
                    ) from exc
                await asyncio.sleep(0.4 * (2**attempt))
                continue
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if paid_request or attempt >= retries:
                    raise ProviderError(
                        "network_error",
                        "外部服务已接收请求，但连接在返回结果前中断"
                        if paid_request
                        else "外部服务连接失败",
                        transient=not paid_request,
                        failure_status=UNCERTAIN_FAILURE if paid_request else RETRYABLE_FAILURE,
                    ) from exc
                await asyncio.sleep(0.4 * (2**attempt))
                continue
            if response.status_code == 429 or response.status_code >= 500:
                if attempt < retries:
                    retry_after = parse_retry_after(response.headers.get("retry-after"))
                    await asyncio.sleep(retry_after or 0.4 * (2**attempt))
                    continue
            try:
                payload = response.json()
            except ValueError as exc:
                raise ProviderError(
                    "invalid_json",
                    f"外部服务返回了无法解析的数据（HTTP {response.status_code}）",
                    transient=response.status_code >= 500,
                    failure_status=(
                        UNCERTAIN_FAILURE
                        if paid_request and response.status_code < 400
                        else RETRYABLE_FAILURE
                    ),
                ) from exc
            if not isinstance(payload, (dict, list)):
                raise ProviderError(
                    "invalid_payload",
                    "外部服务返回格式不正确",
                    failure_status=UNCERTAIN_FAILURE if paid_request else RETRYABLE_FAILURE,
                )
            return payload, response
        raise AssertionError("unreachable")


class GoogleSearchConsoleClient:
    TOKEN_URL = "https://oauth2.googleapis.com/token"
    API_BASE = "https://www.googleapis.com/webmasters/v3"

    def __init__(self, http: JsonHttpClient, config: GSCProviderConfig) -> None:
        self.http = http
        self.config = config

    async def query_performance(self, *, now: datetime | None = None) -> list[GSCQueryRow]:
        if not self.config.configured:
            raise ProviderError("gsc_not_connected", "Google Search Console 尚未连接")
        token_payload, token_response = await self.http.request(
            "POST",
            self.TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            form_body={
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "refresh_token": self.config.refresh_token,
                "grant_type": "refresh_token",
            },
            max_retries=0,
        )
        if token_response.status_code in {400, 401, 403}:
            raise ProviderError(
                "gsc_reconnect_required",
                "Search Console 授权已失效，请重新连接",
            )
        if token_response.status_code >= 400 or not isinstance(token_payload, dict):
            raise ProviderError(
                "gsc_token_error",
                f"Google OAuth 返回 HTTP {token_response.status_code}",
                transient=token_response.status_code >= 500,
            )
        access_token = str(token_payload.get("access_token") or "")
        if not access_token:
            raise ProviderError("gsc_reconnect_required", "Search Console 没有返回访问令牌")

        today = (now or datetime.now(UTC)).astimezone(UTC)
        end = today - timedelta(days=3)
        start = end - timedelta(days=28)
        payload, response = await self.http.request(
            "POST",
            f"{self.API_BASE}/sites/{quote(self.config.site_url, safe='')}/searchAnalytics/query",
            headers={"Authorization": f"Bearer {access_token}"},
            json_body={
                "startDate": start.date().isoformat(),
                "endDate": end.date().isoformat(),
                "dimensions": ["query"],
                "rowLimit": 1000,
                "type": "web",
                "dataState": "all",
            },
            max_retries=1,
        )
        if response.status_code in {401, 403}:
            raise ProviderError(
                "gsc_reconnect_required",
                "Search Console 无权读取所选 property，请重新连接",
            )
        if response.status_code >= 400 or not isinstance(payload, dict):
            raise ProviderError(
                "gsc_api_error",
                f"Google Search Console 返回 HTTP {response.status_code}",
                transient=response.status_code == 429 or response.status_code >= 500,
            )
        rows = payload.get("rows")
        return [
            parsed
            for raw in (rows if isinstance(rows, list) else [])
            if isinstance(raw, dict) and (parsed := parse_gsc_query_row(raw)) is not None
        ]


class OpenAICompatibleClient:
    def __init__(self, http: JsonHttpClient, config: AIProviderConfig) -> None:
        self.http = http
        self.config = config

    async def build_fallback_profile(
        self,
        *,
        domain: str,
        country: str,
        language: str,
        candidates: list[RawKeyword],
        page_hints: list[dict[str, Any]],
    ) -> AIResult:
        candidate_payload = [
            {
                "keyword": row.keyword,
                "search_volume": row.search_volume,
            }
            for row in candidates[:100]
        ]
        prompt = (
            "Infer the minimum usable business profile for a keyword-library task. "
            "Use only the supplied domain, market, candidate keywords and page hints. "
            "Do not claim facts without evidence. Return JSON with business_name, "
            "business_type, business_model, business_summary, products_services, target_audiences, "
            "use_cases, content_topics, exclusion_terms, confidence and evidence_summary. "
            "business_model must be exactly one of product, service, software, content, or "
            "mixed. "
            "Array fields must be arrays of short strings.\n\n"
            f"Domain: {domain}\nCountry: {country}\nLanguage: {language}\n"
            f"Candidate keywords: {json.dumps(candidate_payload, ensure_ascii=False)}\n"
            f"Page hints: {json.dumps(page_hints[:10], ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=5000,
            schema_name="keyword_business_profile",
            response_schema=fallback_profile_schema(),
        )

    async def rank_seeds(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_seed_ranking_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=4000)

    async def build_diverse_seed_pool(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_diverse_seed_pool_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=3000)

    async def cluster_seed_topics_naturally(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_natural_seed_clustering_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=10000)

    async def select_seed_topic_representatives(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_seed_topic_representatives_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(
            prompt,
            max_tokens=12000,
            schema_name="keyword_seed_topics",
            response_schema=seed_topic_representatives_schema(candidates),
        )

    async def filter_initial_library_candidates(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_initial_library_filter_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(
            prompt,
            max_tokens=8000,
            model=self.config.effective_initial_filter_model,
            schema_name="initial_keyword_library_filter",
            response_schema=initial_library_filter_schema(candidates),
        )

    async def select_grouped_active_seeds(
        self,
        *,
        groups: list[SeedPoolGroup],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_grouped_active_seed_prompt(
            groups=groups,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=1000)

    async def validate_seed_candidates(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_seed_filter_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=16000)

    async def cluster_seed_topics(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_seed_clustering_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=10000)

    async def select_active_seeds(
        self,
        *,
        candidates: list[SeedCandidate],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_active_seed_selection_prompt(
            candidates=candidates,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(prompt, max_tokens=1000)

    async def select_active_topic_representatives(
        self,
        *,
        topics: list[dict[str, Any]],
        duplicate_pairs: list[TopicDuplicatePair],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        prompt = build_topic_active_selection_prompt(
            topics=topics,
            duplicate_pairs=duplicate_pairs,
            profile=profile,
            country=country,
            language=language,
        )
        return await self._completion(
            prompt,
            max_tokens=TOPIC_DEDUP_MAX_COMPLETION_TOKENS,
            model=self.config.effective_topic_dedup_model,
            reasoning_effort=TOPIC_DEDUP_REASONING_EFFORT,
            schema_name="keyword_seed_selection",
            response_schema=topic_selection_schema(topics, duplicate_pairs),
        )

    async def classify_keywords(
        self,
        *,
        rows: list[RawKeyword],
        seeds: list[dict[str, Any]],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        keyword_payload = [
            {
                "id": f"q{index:03d}",
                "keyword": row.keyword,
                "intent": row.intent,
            }
            for index, row in enumerate(rows, start=1)
        ]
        seed_payload = [
            {
                "id": seed["id"],
                "keyword": seed["keyword"],
                "topic": seed.get("business_topic"),
            }
            for seed in seeds
        ]
        prompt = (
            "Classify each supplied keyword for this website. Evaluate every id exactly "
            "once and never add or rewrite a keyword. Return JSON with an items array. "
            "Each item requires id, relevant (boolean), business_topic, confidence from "
            "0 to 1, review_status (approved or needs_review), reason, primary_seed_id "
            "and related_seed_ids. Use only supplied seed ids. Filtering and topic "
            "classification are separate: mark clearly unrelated queries relevant=false; "
            "keep uncertain but plausible queries with review_status=needs_review.\n\n"
            f"Country: {country}\nLanguage: {language}\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"Seeds: {json.dumps(seed_payload, ensure_ascii=False)}\n"
            f"Keywords: {json.dumps(keyword_payload, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=12000,
            schema_name="keyword_classification",
            response_schema=keyword_classification_schema(len(rows), seeds),
        )

    async def validate_competitor(
        self,
        *,
        competitor_domain: str,
        rows: list[CompetitorGap],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        gap_payload = [
            {
                "id": f"g{index:03d}",
                "keyword": row.keyword,
                "search_volume": row.search_volume,
                "competitor_rank": row.competitor_rank,
            }
            for index, row in enumerate(rows[:100], start=1)
        ]
        prompt = (
            "Decide whether the supplied domain is a real organic-search competitor for "
            "the described website. Use the keyword gap evidence, not the domain name "
            "alone. Return JSON with status (confirmed, skipped_unrelated or "
            "skipped_uncertain), confidence from 0 to 1, reason, and relevant_ids. "
            "relevant_ids may only contain supplied ids.\n\n"
            f"Competitor: {competitor_domain}\nCountry: {country}\nLanguage: {language}\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"Gap evidence: {json.dumps(gap_payload, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=5000,
            schema_name="keyword_competitor_validation",
            response_schema=competitor_validation_schema(len(rows)),
        )

    async def select_competitive_market_queries(
        self,
        *,
        rows: list[GSCQueryRow],
        profile: dict[str, Any],
        country: str,
        language: str,
    ) -> AIResult:
        candidates = rows
        payload = [
            {
                "id": f"q{index:03d}",
                "query": row.query,
                "clicks": row.clicks,
                "impressions": row.impressions,
                "ctr": row.ctr,
                "position": row.position,
            }
            for index, row in enumerate(candidates, start=1)
        ]
        prompt = (
            "Follow the OpenSEO competitive-landscape workflow exactly. Select 5-10 "
            "representative market queries from the supplied first-party Search Console rows. "
            "Use only supplied ids. Cover informational, commercial, comparison, and "
            "transactional/tool terms when those intents exist in the evidence. Prefer queries "
            "that represent the site's actual products, services, audience and market, not brand "
            "navigation or accidental traffic. Mark directional=true when the available query set "
            "is too small or too concentrated for a firm market conclusion. When local_market is "
            "present in the business profile, include city, neighborhood or service-area queries "
            "that actually occur in the supplied GSC evidence.\n\n"
            f"Country: {country}\nLanguage: {language}\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"GSC query rows: {json.dumps(payload, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=5000,
            schema_name="competitive_market_queries",
            response_schema=competitive_query_selection_schema(len(candidates)),
        )

    async def classify_competitive_domains(
        self,
        *,
        competitors: list[DiscoveredCompetitor],
        serp_snapshots: list[dict[str, Any]],
        query_metrics: list[dict[str, Any]],
        profile: dict[str, Any],
        country: str,
        language: str,
        site_verifications: dict[str, dict[str, Any]],
    ) -> AIResult:
        payload = [
            {
                "id": f"d{index:03d}",
                "domain": row.domain,
                "keywords_count": row.keywords_count,
                "avg_position": row.avg_position,
                "etv": row.etv,
                "visibility": row.visibility,
                "site_verification": site_verifications.get(row.domain.casefold(), {}),
            }
            for index, row in enumerate(competitors, start=1)
        ]
        prompt = (
            "Follow the OpenSEO competitive-landscape domain grouping exactly. Classify every "
            "candidate into one of: direct product competitors, publishers/media, "
            "marketplaces/directories, communities/forums, or documentation/resources. "
            "Explicitly distinguish an SEO competitor from a business competitor. A publisher "
            "can be a relevant SEO competitor without being a product competitor. Use recurring "
            "live SERP evidence, query intent, the business profile and provider metrics; do not "
            "infer from a domain name alone. Return each supplied id exactly once.\n\n"
            "Website verification evidence is authoritative for reachability, redirects and "
            "page identity. Set site_relation=unrelated when the fetched site is a namesake or "
            "cross-domain redirect unrelated to the supplied business profile. Set uncertain "
            "when the site was blocked or temporarily unavailable. A direct product competitor "
            "must have is_business_competitor=true; never label an app store, social profile, "
            "login surface, parked domain or unrelated redirect as a direct competitor. When "
            "local_market is present, weigh Maps or Local Finder recurrence, categories, address, "
            "rating and review evidence separately from national organic visibility.\n\n"
            f"Country: {country}\nLanguage: {language}\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"Query metrics: {json.dumps(query_metrics, ensure_ascii=False)}\n"
            f"Candidates: {json.dumps(payload, ensure_ascii=False)}\n"
            f"Live SERP snapshots: {json.dumps(serp_snapshots, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=8000,
            schema_name="competitive_domain_classification",
            response_schema=competitive_domain_classification_schema(len(competitors)),
        )

    async def assess_backlink_validation_need(
        self,
        *,
        competitors: list[dict[str, Any]],
        profile: dict[str, Any],
    ) -> AIResult:
        payload = [
            {
                "id": f"d{index:03d}",
                "domain": row.get("domain"),
                "domain_type": row.get("domain_type"),
                "why_they_matter": row.get("why_they_matter"),
                "domain_overview": row.get("domain_overview"),
            }
            for index, row in enumerate(competitors, start=1)
        ]
        prompt = (
            "Apply the OpenSEO competitive-landscape backlink guardrail exactly. For every "
            "candidate, set needed=true only when backlink authority appears important to "
            "explaining why that domain wins. Do not request backlinks merely to enrich the "
            "record. Return every supplied id exactly once.\n\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"Candidates: {json.dumps(payload, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=4000,
            schema_name="competitive_backlink_validation",
            response_schema=backlink_validation_schema(len(competitors)),
        )

    async def synthesize_competitive_landscape(
        self,
        *,
        query_set: list[dict[str, Any]],
        competitors: list[dict[str, Any]],
        serp_snapshots: list[dict[str, Any]],
        directional: bool,
        profile: dict[str, Any],
    ) -> AIResult:
        prompt = (
            "Produce the OpenSEO competitive-landscape output exactly from the supplied evidence. "
            "Start with the market read: market leaders, most winnable opportunity, and biggest "
            "barrier to ranking. Then identify content formats, winning themes, keyword/theme "
            "gaps, backlink or authority observations, and recommended next workflows. Include "
            "exactly one competitor_findings row per supplied domain with domain, type, why they "
            "matter, organic footprint, winning themes, and weakness/gap. Keep SEO "
            "competitors distinct from business competitors. Do not overstate estimated traffic. "
            "For a local_market report, explicitly distinguish Maps/Local Finder winners from "
            "national organic-page winners and use only the supplied local evidence. "
            "If directional=true, explicitly say the small or concentrated query set makes the "
            "result directional. Do not invent evidence.\n\n"
            f"Directional: {directional}\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"Query set: {json.dumps(query_set, ensure_ascii=False)}\n"
            f"Live SERP snapshots: {json.dumps(serp_snapshots, ensure_ascii=False)}\n"
            f"Competitor evidence: {json.dumps(competitors, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=16000,
            schema_name="competitive_landscape_summary",
            response_schema=competitive_landscape_summary_schema(
                [str(row.get("domain") or "") for row in competitors]
            ),
        )

    async def repair_competitive_landscape_summary(
        self,
        *,
        query_set: list[dict[str, Any]],
        competitors: list[dict[str, Any]],
        serp_snapshots: list[dict[str, Any]],
        directional: bool,
        profile: dict[str, Any],
        invalid_summary: dict[str, Any],
        missing_domains: list[str],
        duplicate_domains: list[str],
    ) -> AIResult:
        prompt = (
            "Repair the supplied OpenSEO competitive-landscape output without changing its "
            "evidence basis. The competitor_findings array failed structural validation. Return "
            "the complete report with exactly one competitor_findings row for every supplied "
            "competitor domain, no omissions and no duplicates. Preserve valid conclusions where "
            "supported, and use only the supplied business profile, query, SERP and competitor "
            "evidence. Do not invent facts.\n\n"
            f"Missing domains: {json.dumps(missing_domains, ensure_ascii=False)}\n"
            f"Duplicate domains: {json.dumps(duplicate_domains, ensure_ascii=False)}\n"
            f"Directional: {directional}\n"
            f"Business profile: {json.dumps(profile, ensure_ascii=False)}\n"
            f"Query set: {json.dumps(query_set, ensure_ascii=False)}\n"
            f"Live SERP snapshots: {json.dumps(serp_snapshots, ensure_ascii=False)}\n"
            f"Competitor evidence: {json.dumps(competitors, ensure_ascii=False)}\n"
            f"Invalid report to repair: {json.dumps(invalid_summary, ensure_ascii=False)}"
        )
        return await self._completion(
            prompt,
            max_tokens=16000,
            schema_name="competitive_landscape_summary_repair",
            response_schema=competitive_landscape_summary_schema(
                [str(row.get("domain") or "") for row in competitors]
            ),
        )

    async def _completion(
        self,
        prompt: str,
        *,
        max_tokens: int,
        model: str | None = None,
        reasoning_effort: str | None = None,
        schema_name: str | None = None,
        response_schema: dict[str, Any] | None = None,
    ) -> AIResult:
        effective_model = (model or self.config.model).strip()
        if not self.config.base_url or not self.config.api_key or not effective_model:
            raise ProviderError("ai_not_configured", "服务器尚未配置 AI 模型")
        endpoint = (
            self.config.base_url
            if self.config.base_url.endswith("/chat/completions")
            else self.config.base_url.rstrip("/") + "/chat/completions"
        )
        token_parameter = completion_token_parameter(effective_model)
        response_format: dict[str, Any]
        if response_schema is not None:
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": schema_name or "keyword_response",
                    "strict": True,
                    "schema": response_schema,
                },
            }
        else:
            response_format = {"type": "json_object"}
        request_body: dict[str, Any] = {
            "model": effective_model,
            "messages": [
                {
                    "role": "system",
                    "content": "Return valid JSON only. Follow the schema exactly.",
                },
                {"role": "user", "content": prompt},
            ],
            "response_format": response_format,
            token_parameter: max_tokens,
        }
        if reasoning_effort is not None:
            request_body["reasoning_effort"] = reasoning_effort
        payload, response = await self.http.request(
            "POST",
            endpoint,
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            json_body=request_body,
            # Paid model calls are retried by the durable workflow only when the
            # request is known not to have produced a charge.
            max_retries=0,
            paid_request=True,
        )
        if response.status_code >= 400:
            if response.status_code in {401, 403}:
                raise ProviderError("ai_auth_failed", "AI API 密钥无效")
            raise ProviderError(
                "ai_http_error",
                f"AI 服务返回 HTTP {response.status_code}",
                transient=response.status_code >= 500 or response.status_code == 429,
            )
        if not isinstance(payload, dict):
            raise ProviderError(
                "invalid_ai_payload",
                "AI 服务返回格式不正确",
                failure_status=CHARGED_FAILURE,
            )
        usage = payload.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        response_cost_usd = max(
            number(usage.get("cost")) or number(payload.get("cost")) or 0.0,
            0.0,
        )
        cleaned = ""
        try:
            content = payload["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(
                    str(part.get("text") or "") for part in content if isinstance(part, dict)
                )
            if not isinstance(content, str):
                raise TypeError
            cleaned = re.sub(r"^```(?:json)?\s*", "", content.strip(), flags=re.I)
            cleaned = re.sub(r"\s*```$", "", cleaned)
            parsed = json.loads(cleaned)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise ProviderError(
                "invalid_ai_json",
                "AI 没有返回有效 JSON",
                failure_status=CHARGED_FAILURE,
                cost_usd=response_cost_usd,
                metadata={
                    "model": str(payload.get("model") or effective_model),
                    "usage": usage,
                    "raw_content": cleaned[:10_000],
                },
            ) from exc
        if not isinstance(parsed, dict):
            raise ProviderError(
                "invalid_ai_json",
                "AI 返回结果不是 JSON 对象",
                failure_status=CHARGED_FAILURE,
                cost_usd=response_cost_usd,
                metadata={
                    "model": str(payload.get("model") or effective_model),
                    "usage": usage,
                    "raw_content": cleaned[:10_000],
                },
            )
        completion_details = usage.get("completion_tokens_details")
        completion_details = completion_details if isinstance(completion_details, dict) else {}
        return AIResult(
            payload=parsed,
            usage={
                "prompt_tokens": integer(usage.get("prompt_tokens")) or 0,
                "completion_tokens": integer(usage.get("completion_tokens")) or 0,
                "reasoning_tokens": integer(completion_details.get("reasoning_tokens")) or 0,
                "total_tokens": integer(usage.get("total_tokens")) or 0,
            },
            model=str(payload.get("model") or effective_model),
            cost_usd=response_cost_usd,
        )


class DataForSEOClient:
    BASE_URL = "https://api.dataforseo.com/v3"
    LABS_SITE_PATH = "dataforseo_labs/google/keywords_for_site/live"
    ADS_SITE_PATH = "keywords_data/google_ads/keywords_for_site/live"
    KEYWORD_IDEAS_PATH = "dataforseo_labs/google/keyword_ideas/live"
    KEYWORD_OVERVIEW_PATH = "dataforseo_labs/google/keyword_overview/live"
    KEYWORD_IDEAS_BROAD_SOURCE = "keyword_ideas_broad"
    KEYWORD_IDEAS_CLOSE_SOURCE = "keyword_ideas_close"
    DOMAIN_INTERSECTION_PATH = "dataforseo_labs/google/domain_intersection/live"
    SERP_COMPETITORS_PATH = "dataforseo_labs/google/serp_competitors/live"
    DOMAIN_OVERVIEW_PATH = "dataforseo_labs/google/domain_rank_overview/live"
    RANKED_KEYWORDS_PATH = "dataforseo_labs/google/ranked_keywords/live"
    LIVE_SERP_PATH = "serp/google/organic/live/advanced"
    BUSINESS_LISTINGS_PATH = "business_data/business_listings/search/live"
    BUSINESS_QUESTIONS_PATH = "business_data/google/questions_and_answers/live"
    LOCAL_MAPS_PATH = "serp/google/maps/live/advanced"
    LOCAL_FINDER_PATH = "serp/google/local_finder/live/advanced"
    BACKLINKS_SUMMARY_PATH = "backlinks/summary/live"
    REFERRING_DOMAINS_PATH = "backlinks/referring_domains/live"

    def __init__(self, config: DataForSEOProviderConfig, http: JsonHttpClient) -> None:
        self.config = config
        self.http = http

    async def labs_keywords_for_site(
        self,
        *,
        domain: str,
        country: str,
        language: str,
        limit: int = 200,
    ) -> tuple[list[RawKeyword], DataForSEOBilling]:
        task, billing = await self._request(
            self.LABS_SITE_PATH,
            {
                "target": domain,
                "location_name": country_display_name(country),
                "language_code": provider_language_code(language),
                "limit": max(1, min(limit, 1000)),
                "include_subdomains": False,
                "include_clickstream_data": False,
                "include_serp_info": False,
            },
        )
        rows = [
            parse_labs_keyword(raw, source="labs_site", rank=index)
            for index, raw in enumerate(labs_items(task), start=1)
        ]
        return deduplicate_raw_keywords([row for row in rows if row is not None]), billing

    async def google_ads_keywords_for_site(
        self,
        *,
        domain: str,
        country: str,
        language: str,
    ) -> tuple[list[RawKeyword], DataForSEOBilling]:
        task, billing = await self._request(
            self.ADS_SITE_PATH,
            {
                "target": domain,
                "target_type": "site",
                "location_name": country_display_name(country),
                "language_code": provider_language_code(language),
                "search_partners": False,
                "include_adult_keywords": False,
                "sort_by": "relevance",
            },
        )
        results = task.get("result")
        items = results if isinstance(results, list) else []
        rows = [
            parse_google_ads_keyword(raw, rank=index) for index, raw in enumerate(items, start=1)
        ]
        return deduplicate_raw_keywords([row for row in rows if row is not None]), billing

    async def keyword_ideas(
        self,
        *,
        keywords: list[str],
        country: str,
        language: str,
        closely_variants: bool,
        limit: int = 500,
    ) -> tuple[list[RawKeyword], DataForSEOBilling]:
        if not keywords:
            return [], DataForSEOBilling(cost_usd=0, path=[])
        if len(keywords) > 200:
            raise ProviderError(
                "dataforseo_seed_batch_too_large",
                "DataForSEO Keyword Ideas 单批种子词不能超过 200 个",
            )
        task, billing = await self._request(
            self.KEYWORD_IDEAS_PATH,
            {
                "keywords": keywords,
                "location_name": country_display_name(country),
                "language_code": provider_language_code(language),
                "limit": max(1, min(limit, 1000)),
                "closely_variants": closely_variants,
                "include_clickstream_data": False,
            },
        )
        source = (
            self.KEYWORD_IDEAS_CLOSE_SOURCE if closely_variants else self.KEYWORD_IDEAS_BROAD_SOURCE
        )
        rows = [
            parse_labs_keyword(raw, source=source, rank=index)
            for index, raw in enumerate(labs_items(task), start=1)
        ]
        return deduplicate_raw_keywords([row for row in rows if row is not None]), billing

    async def keyword_overview(
        self,
        *,
        keywords: list[str],
        country: str,
        language: str,
    ) -> tuple[list[RawKeyword], DataForSEOBilling]:
        if not keywords:
            return [], DataForSEOBilling(cost_usd=0, path=[])
        if len(keywords) > 1000:
            raise ProviderError(
                "dataforseo_overview_batch_too_large",
                "DataForSEO Keyword Overview 单批关键词不能超过 1000 个",
            )
        task, billing = await self._request(
            self.KEYWORD_OVERVIEW_PATH,
            {
                "keywords": keywords,
                "location_name": country_display_name(country),
                "language_code": provider_language_code(language),
                "include_clickstream_data": False,
                "include_serp_info": False,
            },
        )
        rows = [
            parse_labs_keyword(raw, source="keyword_overview", rank=index)
            for index, raw in enumerate(labs_items(task), start=1)
        ]
        return deduplicate_raw_keywords([row for row in rows if row is not None]), billing

    async def domain_intersection(
        self,
        *,
        competitor_domain: str,
        domain: str,
        country: str,
        language: str,
        limit: int = 200,
        intersections: bool = False,
    ) -> tuple[list[CompetitorGap], DataForSEOBilling]:
        task, billing = await self._request(
            self.DOMAIN_INTERSECTION_PATH,
            {
                "target1": competitor_domain,
                "target2": domain,
                "intersections": intersections,
                "location_name": country_display_name(country),
                "language_code": provider_language_code(language),
                "limit": max(1, min(limit, 1000)),
                "item_types": ["organic"],
                "include_serp_info": False,
                "order_by": ["keyword_data.keyword_info.search_volume,desc"],
                "filters": [
                    ["first_domain_serp_element.type", "=", "organic"],
                    *(
                        [
                            "and",
                            ["second_domain_serp_element.type", "=", "organic"],
                        ]
                        if intersections
                        else []
                    ),
                ],
            },
        )
        rows = [
            parse_competitor_gap(raw, rank=index, require_second=intersections)
            for index, raw in enumerate(labs_items(task), start=1)
        ]
        return deduplicate_gaps([row for row in rows if row is not None]), billing

    async def serp_competitors(
        self,
        *,
        keywords: list[str],
        country: str,
        language: str,
        item_types: list[str] | None = None,
        include_subdomains: bool | None = None,
        limit: int = 50,
        offset: int | None = None,
    ) -> tuple[list[DiscoveredCompetitor], DataForSEOBilling]:
        cleaned_keywords = [value.strip() for value in keywords if value.strip()]
        if not 1 <= len(cleaned_keywords) <= 100:
            raise ProviderError(
                "dataforseo_serp_competitor_keywords_invalid",
                "SERP Competitors 需要 1-100 个关键词",
            )
        if any(len(value) > 120 for value in cleaned_keywords):
            raise ProviderError(
                "dataforseo_serp_competitor_keyword_too_long",
                "SERP Competitors 单个关键词不能超过 120 个字符",
            )
        allowed_types = {"organic", "paid", "featured_snippet", "local_pack"}
        if item_types is not None and (
            not item_types or any(value not in allowed_types for value in item_types)
        ):
            raise ProviderError(
                "dataforseo_serp_competitor_item_types_invalid",
                "SERP Competitors result types 无效",
            )
        request: dict[str, Any] = {
            "keywords": cleaned_keywords,
            "location_code": country_location_code(country),
            "language_code": provider_language_code(language),
            "limit": max(1, min(limit, 100)),
        }
        if item_types is not None:
            request["item_types"] = item_types
        if include_subdomains is not None:
            request["include_subdomains"] = include_subdomains
        if offset is not None:
            request["offset"] = max(0, min(offset, 1000))
        task, billing = await self._request(
            self.SERP_COMPETITORS_PATH,
            request,
        )
        rows = [
            parse_discovered_competitor(raw, rank=index)
            for index, raw in enumerate(labs_items(task), start=1)
        ]
        return [row for row in rows if row is not None], billing

    async def live_serp(
        self,
        *,
        keyword: str,
        country: str,
        language: str,
    ) -> tuple[list[dict[str, Any]], DataForSEOBilling]:
        task, billing = await self._request(
            self.LIVE_SERP_PATH,
            {
                "keyword": keyword,
                "location_code": country_location_code(country),
                "language_code": provider_language_code(language),
                "device": "desktop",
                "os": "windows",
                "depth": 100,
            },
        )
        return [
            {
                "type": str(item.get("type") or ""),
                "rank": integer(item.get("rank_absolute")) or integer(item.get("rank_group")),
                "title": clean_string(item.get("title")),
                "url": clean_string(item.get("url")),
                "domain": clean_string(item.get("domain")),
                "description": clean_string(item.get("description")),
            }
            for item in labs_items(task)[:20]
        ], billing

    async def local_businesses(
        self,
        *,
        latitude: float,
        longitude: float,
        radius_km: float,
        query: str | None,
        categories: list[str],
        limit: int = 20,
    ) -> tuple[list[dict[str, Any]], DataForSEOBilling]:
        request: dict[str, Any] = {
            "location_coordinate": (
                f"{coordinate_value(latitude)},{coordinate_value(longitude)},"
                f"{coordinate_value(radius_km)}"
            ),
            "limit": max(1, min(limit, 50)),
        }
        if query and query.strip():
            request["title"] = query.strip()
        if categories:
            request["categories"] = [value.strip() for value in categories[:10] if value.strip()]
        task, billing = await self._request(self.BUSINESS_LISTINGS_PATH, request)
        return labs_items(task), billing

    async def local_serp(
        self,
        *,
        keyword: str,
        latitude: float,
        longitude: float,
        zoom: int,
        language: str,
        search_type: str = "maps",
        device: str = "desktop",
        depth: int = 20,
    ) -> tuple[list[dict[str, Any]], DataForSEOBilling]:
        if search_type not in {"maps", "local_finder"}:
            raise ProviderError(
                "dataforseo_local_search_type_invalid",
                "本地 SERP 类型必须是 maps 或 local_finder",
            )
        if device not in {"desktop", "mobile"}:
            raise ProviderError(
                "dataforseo_local_device_invalid",
                "本地 SERP 设备必须是 desktop 或 mobile",
            )
        path = self.LOCAL_MAPS_PATH if search_type == "maps" else self.LOCAL_FINDER_PATH
        request = {
            "keyword": keyword.strip(),
            "location_coordinate": (
                f"{coordinate_value(latitude)},{coordinate_value(longitude)},"
                f"{max(4, min(int(zoom), 18))}z"
            ),
            "language_code": provider_language_code(language),
            "device": device,
            "os": "windows" if device == "desktop" else "android",
            "depth": max(1, min(int(depth), 100)),
        }
        if search_type == "maps":
            request["search_places"] = False
        task, billing = await self._request(path, request)
        return labs_items(task), billing

    async def business_questions(
        self,
        *,
        keyword: str,
        latitude: float,
        longitude: float,
        radius_km: float,
        language: str,
        depth: int = 20,
    ) -> tuple[list[dict[str, Any]], DataForSEOBilling]:
        radius_meters = max(200, min(round(float(radius_km) * 1000), 199999))
        task, billing = await self._request(
            self.BUSINESS_QUESTIONS_PATH,
            {
                "keyword": keyword.strip(),
                "location_coordinate": (
                    f"{coordinate_value(latitude)},{coordinate_value(longitude)},{radius_meters}"
                ),
                "language_code": provider_language_code(language),
                "depth": max(1, min(int(depth), 100)),
            },
        )
        results = task.get("result")
        questions: list[dict[str, Any]] = []
        for result in results if isinstance(results, list) else []:
            if not isinstance(result, dict):
                continue
            for key in ("items", "items_without_answers"):
                values = result.get(key)
                questions.extend(item for item in values or [] if isinstance(item, dict))
        return questions, billing

    async def domain_overview(
        self,
        *,
        domain: str,
        country: str,
        language: str,
    ) -> tuple[dict[str, Any], DataForSEOBilling]:
        task, billing = await self._request(
            self.DOMAIN_OVERVIEW_PATH,
            {
                "target": domain,
                "location_code": country_location_code(country),
                "language_code": provider_language_code(language),
                "limit": 1,
            },
        )
        item = labs_items(task)
        raw = item[0] if item else {}
        metrics = raw.get("metrics") if isinstance(raw, dict) else {}
        organic = metrics.get("organic") if isinstance(metrics, dict) else {}
        return {
            "domain": domain,
            "organic_traffic": number(organic.get("etv")) if isinstance(organic, dict) else None,
            "organic_keywords": integer(organic.get("count"))
            if isinstance(organic, dict)
            else None,
            "has_data": bool(
                isinstance(organic, dict) and (integer(organic.get("count")) or 0) > 0
            ),
            "raw": raw,
        }, billing

    async def ranked_keywords(
        self,
        *,
        domain: str,
        country: str,
        language: str,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], DataForSEOBilling]:
        task, billing = await self._request(
            self.RANKED_KEYWORDS_PATH,
            {
                "target": domain,
                "location_code": country_location_code(country),
                "language_code": provider_language_code(language),
                "limit": max(1, min(limit, 1000)),
                "order_by": ["keyword_data.keyword_info.search_volume,desc"],
                "item_types": ["organic"],
                "include_subdomains": True,
            },
        )
        return labs_items(task), billing

    async def backlinks_overview(
        self,
        *,
        domain: str,
    ) -> tuple[dict[str, Any], DataForSEOBilling]:
        summary_task, summary_billing = await self._request(
            self.BACKLINKS_SUMMARY_PATH,
            {
                "target": domain,
                "include_subdomains": True,
                "include_indirect_links": True,
                "exclude_internal_backlinks": True,
                "backlinks_status_type": "live",
                "rank_scale": "one_hundred",
            },
        )
        try:
            referring_task, referring_billing = await self._request(
                self.REFERRING_DOMAINS_PATH,
                {
                    "target": domain,
                    "include_subdomains": True,
                    "include_indirect_links": True,
                    "exclude_internal_backlinks": True,
                    "backlinks_status_type": "live",
                    "rank_scale": "one_hundred",
                    "limit": 100,
                    "order_by": ["backlinks,desc"],
                    "filters": [["backlinks_spam_score", "<=", 45]],
                },
            )
        except ProviderError as exc:
            confirmed_cost = summary_billing.cost_usd + exc.cost_usd
            raise ProviderError(
                exc.code,
                str(exc),
                transient=exc.transient and confirmed_cost <= 0,
                failure_status=(CHARGED_FAILURE if confirmed_cost > 0 else exc.failure_status),
                cost_usd=confirmed_cost,
                path=summary_billing.path + exc.path,
                metadata=exc.metadata,
            ) from exc
        summary_results = summary_task.get("result")
        summary = (
            summary_results[0]
            if isinstance(summary_results, list)
            and summary_results
            and isinstance(summary_results[0], dict)
            else {}
        )
        return {
            "summary": summary,
            "referring_domains": labs_items(referring_task),
        }, DataForSEOBilling(
            cost_usd=summary_billing.cost_usd + referring_billing.cost_usd,
            path=summary_billing.path + referring_billing.path,
        )

    async def _request(
        self,
        path: str,
        request: dict[str, Any],
    ) -> tuple[dict[str, Any], DataForSEOBilling]:
        if not self.config.configured:
            raise ProviderError(
                "dataforseo_not_configured",
                "服务器尚未配置 DataForSEO",
            )
        payload, response = await self.http.request(
            "POST",
            f"{self.BASE_URL}/{path}",
            auth=httpx.BasicAuth(self.config.login, self.config.password),
            json_body=[request],
            max_retries=0,
            paid_request=True,
        )
        if response.status_code >= 400:
            if response.status_code in {401, 403}:
                raise ProviderError("dataforseo_auth_failed", "DataForSEO 凭据无效")
            raise ProviderError(
                "dataforseo_http_error",
                f"DataForSEO 返回 HTTP {response.status_code}",
                transient=response.status_code >= 500 or response.status_code == 429,
            )
        if not isinstance(payload, dict):
            raise ProviderError(
                "invalid_dataforseo_payload",
                "DataForSEO 返回格式不正确",
                failure_status=UNCERTAIN_FAILURE,
            )
        tasks = payload.get("tasks")
        task = tasks[0] if isinstance(tasks, list) and tasks else None
        top_status = integer(payload.get("status_code"))
        if top_status != 20000:
            task_cost = number(task.get("cost")) if isinstance(task, dict) else None
            task_path = (
                [str(value) for value in task["path"]]
                if isinstance(task, dict) and isinstance(task.get("path"), list)
                else []
            )
            raise ProviderError(
                "dataforseo_request_failed",
                str(payload.get("status_message") or "DataForSEO request failed"),
                transient=top_status in {40601, 40602},
                failure_status=CHARGED_FAILURE if (task_cost or 0) > 0 else RETRYABLE_FAILURE,
                cost_usd=task_cost or 0,
                path=task_path,
            )
        if not isinstance(task, dict):
            raise ProviderError(
                "invalid_dataforseo_task",
                "DataForSEO 缺少任务结果",
                failure_status=UNCERTAIN_FAILURE,
            )
        billing = DataForSEOBilling(
            cost_usd=number(task.get("cost")) or 0.0,
            path=(
                [str(value) for value in task["path"]] if isinstance(task.get("path"), list) else []
            ),
        )
        if integer(task.get("status_code")) != 20000:
            message = str(task.get("status_message") or "DataForSEO task failed")
            if "no search results" in message.casefold():
                task = dict(task)
                task["result"] = []
                return task, billing
            transient = any(
                marker in message.casefold()
                for marker in ("temporarily", "timeout", "rate limit", "internal")
            )
            raise ProviderError(
                "dataforseo_task_failed",
                message,
                transient=transient and billing.cost_usd <= 0,
                failure_status=(CHARGED_FAILURE if billing.cost_usd > 0 else RETRYABLE_FAILURE),
                cost_usd=billing.cost_usd,
                path=billing.path,
            )
        return task, billing


def parse_labs_keyword(
    raw: Any,
    *,
    source: str,
    rank: int,
) -> RawKeyword | None:
    if not isinstance(raw, dict):
        return None
    keyword_data = raw.get("keyword_data")
    data = keyword_data if isinstance(keyword_data, dict) else raw
    keyword = data.get("keyword")
    if not isinstance(keyword, str) or not keyword.strip():
        return None
    info = data.get("keyword_info")
    info = info if isinstance(info, dict) else {}
    properties = data.get("keyword_properties")
    if not isinstance(properties, dict):
        properties = raw.get("keyword_properties")
    properties = properties if isinstance(properties, dict) else {}
    intent = data.get("search_intent_info")
    if not isinstance(intent, dict):
        intent = raw.get("search_intent_info")
    intent = intent if isinstance(intent, dict) else {}
    return RawKeyword(
        keyword=display_keyword(keyword),
        source=source,
        provider_rank=rank,
        search_volume=integer(info.get("search_volume")),
        cpc=number(info.get("cpc")),
        competition=normalized_competition(info),
        keyword_difficulty=integer(properties.get("keyword_difficulty")),
        intent=clean_string(intent.get("main_intent")),
        monthly_searches=monthly_searches(info.get("monthly_searches")),
        raw_payload=raw,
    )


def parse_google_ads_keyword(raw: Any, *, rank: int) -> RawKeyword | None:
    if not isinstance(raw, dict):
        return None
    keyword = raw.get("keyword")
    if not isinstance(keyword, str) or not keyword.strip():
        return None
    return RawKeyword(
        keyword=display_keyword(keyword),
        source="google_ads_site",
        provider_rank=rank,
        search_volume=integer(raw.get("search_volume")),
        cpc=number(raw.get("cpc")),
        competition=normalized_competition(raw),
        monthly_searches=monthly_searches(raw.get("monthly_searches")),
        raw_payload=raw,
    )


def parse_competitor_gap(
    raw: Any, *, rank: int, require_second: bool = False
) -> CompetitorGap | None:
    parsed = parse_labs_keyword(raw, source="competitor_gap", rank=rank)
    if parsed is None:
        return None
    first_domain = raw.get("first_domain_serp_element") if isinstance(raw, dict) else None
    if not isinstance(first_domain, dict):
        return None
    result_type = clean_string(first_domain.get("type"))
    if result_type and result_type.casefold() != "organic":
        return None
    competitor_rank = find_rank(first_domain)
    second_domain = raw.get("second_domain_serp_element") if isinstance(raw, dict) else None
    if require_second:
        if not isinstance(second_domain, dict):
            return None
        second_type = clean_string(second_domain.get("type"))
        if second_type and second_type.casefold() != "organic":
            return None
    keyword_data = raw.get("keyword_data") if isinstance(raw, dict) else None
    keyword_data = keyword_data if isinstance(keyword_data, dict) else raw
    keyword_info = keyword_data.get("keyword_info") if isinstance(keyword_data, dict) else None
    keyword_info = keyword_info if isinstance(keyword_info, dict) else {}
    return CompetitorGap(
        keyword=parsed.keyword,
        provider_rank=rank,
        competitor_rank=competitor_rank,
        own_rank=find_rank(second_domain),
        competitor_url=clean_string(first_domain.get("url")),
        own_url=(
            clean_string(second_domain.get("url")) if isinstance(second_domain, dict) else None
        ),
        search_volume=parsed.search_volume,
        cpc=parsed.cpc,
        competition=parsed.competition,
        competition_level=clean_string(keyword_info.get("competition_level")),
        keyword_difficulty=parsed.keyword_difficulty,
        intent=parsed.intent,
        monthly_searches=parsed.monthly_searches,
        raw_payload=raw,
    )


def parse_discovered_competitor(raw: Any, *, rank: int) -> DiscoveredCompetitor | None:
    if not isinstance(raw, dict):
        return None
    value = clean_string(raw.get("domain"))
    if value is None:
        return None
    domain = value.casefold().rstrip(".")
    if not domain or "." not in domain:
        return None
    positions = raw.get("keywords_positions")
    return DiscoveredCompetitor(
        domain=domain,
        provider_rank=rank,
        avg_position=number(raw.get("avg_position")),
        median_position=number(raw.get("median_position")),
        rating=number(raw.get("rating")),
        etv=number(raw.get("etv")),
        keywords_count=integer(raw.get("keywords_count")),
        visibility=number(raw.get("visibility")),
        relevant_serp_items=integer(raw.get("relevant_serp_items")),
        keywords_positions=dict(positions) if isinstance(positions, dict) else {},
        raw_payload=raw,
    )


def parse_gsc_query_row(raw: dict[str, Any]) -> GSCQueryRow | None:
    keys = raw.get("keys")
    query = str(keys[0] if isinstance(keys, list) and keys else "").strip()
    if not query or len(query) > 120:
        return None
    return GSCQueryRow(
        query=query,
        clicks=number(raw.get("clicks")) or 0.0,
        impressions=number(raw.get("impressions")) or 0.0,
        ctr=number(raw.get("ctr")) or 0.0,
        position=number(raw.get("position")) or 0.0,
        raw_payload=raw,
    )


def host_matches_domain(host: str, domain: str) -> bool:
    normalized_host = host.removeprefix("www.").casefold()
    normalized_domain = domain.removeprefix("www.").casefold()
    return normalized_host == normalized_domain or normalized_host.endswith(f".{normalized_domain}")


def is_same_domain(host: str, domain: str) -> bool:
    return host.removeprefix("www.").casefold() == domain.removeprefix("www.").casefold()


def sort_serp_competitors(
    rows: list[DiscoveredCompetitor], sort_by: str = "visibility"
) -> list[DiscoveredCompetitor]:
    field = {
        "avg_position": "avg_position",
        "keyword_count": "keywords_count",
        "traffic_estimate": "etv",
    }.get(sort_by, "visibility")
    reverse = sort_by != "avg_position"
    return sorted(
        rows,
        key=lambda row: float(getattr(row, field) or 0),
        reverse=reverse,
    )


def labs_items(task: dict[str, Any]) -> list[dict[str, Any]]:
    results = task.get("result")
    if not isinstance(results, list) or not results:
        return []
    first = results[0]
    if isinstance(first, dict):
        items = first.get("items")
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []
    return []


def coordinate_value(value: float) -> str:
    return f"{float(value):.7f}".rstrip("0").rstrip(".")


def find_rank(value: Any) -> int | None:
    if not isinstance(value, dict):
        return None
    for key in ("rank_absolute", "rank_group", "rank"):
        rank = integer(value.get(key))
        if rank is not None:
            return rank
    for key in ("ranked_serp_element", "serp_item"):
        nested = find_rank(value.get(key))
        if nested is not None:
            return nested
    return None


def normalized_competition(value: dict[str, Any]) -> float | None:
    direct = number(value.get("competition"))
    if direct is not None:
        if direct > 1:
            return min(max(direct / 100, 0), 1)
        return min(max(direct, 0), 1)
    index = number(value.get("competition_index"))
    return min(max(index / 100, 0), 1) if index is not None else None


def deduplicate_raw_keywords(rows: list[RawKeyword]) -> list[RawKeyword]:
    result: list[RawKeyword] = []
    seen: set[str] = set()
    for row in rows:
        normalized = row.keyword.casefold().strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(row)
    return result


def deduplicate_gaps(rows: list[CompetitorGap]) -> list[CompetitorGap]:
    result: list[CompetitorGap] = []
    seen: set[str] = set()
    for row in rows:
        normalized = row.keyword.casefold().strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(row)
    return result


def provider_language_code(language: str) -> str:
    normalized = language.strip().casefold()
    return LANGUAGE_ALIASES.get(normalized, normalized.split("-", 1)[0])


def completion_token_parameter(model: str) -> str:
    normalized = model.strip().casefold()
    if normalized.startswith(("gpt-5", "o1", "o3", "o4")):
        return "max_completion_tokens"
    return "max_tokens"


def country_display_name(country: str) -> str:
    value = pycountry.countries.get(alpha_2=country.strip().upper())
    if value is None:
        raise ProviderError("unsupported_country", f"不支持国家 {country}")
    return str(value.name)


def country_location_code(country: str) -> int:
    value = pycountry.countries.get(alpha_2=country.strip().upper())
    if value is None or not value.numeric:
        raise ProviderError("unsupported_country", f"不支持国家 {country}")
    return 2000 + int(value.numeric)


def assert_dataforseo_ok(payload: dict[str, Any]) -> None:
    if integer(payload.get("status_code")) != 20000:
        raise ProviderError(
            "dataforseo_request_failed",
            str(payload.get("status_message") or "DataForSEO request failed"),
        )


def monthly_searches(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    rows = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        rows.append(
            {
                "year": integer(raw.get("year")),
                "month": raw.get("month"),
                "search_volume": integer(raw.get("search_volume", raw.get("monthlySearches"))),
            }
        )
    return rows


def parse_retry_after(value: str | None) -> float | None:
    parsed = number(value)
    return max(parsed, 0) if parsed is not None else None


def integer(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def clean_string(value: Any) -> str | None:
    return str(value) if isinstance(value, str) and value.strip() else None
