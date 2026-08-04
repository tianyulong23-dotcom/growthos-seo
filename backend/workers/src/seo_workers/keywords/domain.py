from __future__ import annotations

import math
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Iterable

SEED_RULE_VERSION = "seed-v5-provider-brand-gate"
PRIORITY_RULE_VERSION = "priority-v1"
ROUND_KEYWORD_LIMIT = 500
ACTIVE_SEED_LIMIT = 20
SEED_POOL_LIMIT = 100
SEED_POOL_MIN_GROUPS = 25
SEED_POOL_MAX_GROUPS = 25
SEED_POOL_MAX_GROUP_SIZE = 4
BUSINESS_MODELS = {"product", "service", "software", "content", "mixed"}
SEED_PAGE_INTENTS = {"product", "informational", "commercial", "service"}

INITIAL_LIBRARY_APPROVAL_SCORES = {
    "keep": 0.8,
}
INITIAL_LIBRARY_REJECTION_REASONS = (
    "remove_irrelevant",
    "remove_entity",
    "remove_navigation",
    "remove_unusable",
)

ENGLISH_VARIANT_FILLERS = {
    "a",
    "about",
    "all",
    "an",
    "and",
    "at",
    "for",
    "in",
    "of",
    "on",
    "the",
    "to",
    "with",
}

ENGLISH_VARIANT_ALIASES = {
    "automobile": "car",
    "automobiles": "car",
    "auto": "car",
    "automotive": "car",
    "cars": "car",
    "vehicle": "car",
    "vehicles": "car",
    "detailed": "detail",
    "detailing": "detail",
    "details": "detail",
    "kits": "kit",
    "products": "product",
    "supplies": "supply",
    "washed": "wash",
    "washes": "wash",
    "washing": "wash",
}

LATIN_LANGUAGE_PREFIXES = {
    "af",
    "az",
    "bs",
    "ca",
    "cs",
    "cy",
    "da",
    "de",
    "en",
    "es",
    "et",
    "eu",
    "fi",
    "fil",
    "fr",
    "ga",
    "gl",
    "hr",
    "hu",
    "id",
    "is",
    "it",
    "lt",
    "lv",
    "ms",
    "nl",
    "no",
    "pl",
    "pt",
    "ro",
    "sk",
    "sl",
    "sq",
    "sv",
    "sw",
    "tr",
    "vi",
    "xh",
    "zu",
}


@dataclass(frozen=True)
class RawKeyword:
    keyword: str
    source: str
    provider_rank: int = 0
    source_seed_id: str | None = None
    source_seed_rank: int | None = None
    search_volume: int | None = None
    cpc: float | None = None
    competition: float | None = None
    keyword_difficulty: int | None = None
    intent: str | None = None
    monthly_searches: list[dict[str, Any]] = field(default_factory=list)
    raw_payload: dict[str, Any] = field(default_factory=dict)
    ai_relevance: float | None = None


@dataclass(frozen=True)
class SeedCandidate:
    keyword: str
    normalized_keyword: str
    rank: int
    selection_details: dict[str, Any]
    raw: RawKeyword


@dataclass(frozen=True)
class SeedDecision:
    candidate: SeedCandidate
    selected: bool
    ai_rank: int | None
    business_topic: str | None
    reason_code: str | None
    reason: str
    business_relevance: float | None = None
    relevance_tier: str | None = None


@dataclass(frozen=True)
class InitialLibraryAssessment:
    candidate_id: str
    approved: bool
    category: str
    business_relevance: float


@dataclass(frozen=True)
class SeedTopicCluster:
    representative_id: str
    representative: SeedCandidate
    member_ids: tuple[str, ...]
    members: tuple[SeedCandidate, ...]


@dataclass(frozen=True)
class SeedPoolGroup:
    topic: str
    member_ids: tuple[str, ...]
    members: tuple[SeedCandidate, ...]


@dataclass(frozen=True)
class ActiveSeedChoice:
    candidate_id: str
    candidate: SeedCandidate


@dataclass(frozen=True)
class TopicDuplicateGroup:
    keep_id: str
    drop_ids: tuple[str, ...]


@dataclass(frozen=True)
class TopicDuplicatePair:
    pair_id: str
    left_id: str
    right_id: str
    signals: tuple[str, ...]


@dataclass(frozen=True)
class TopicSelectionResolution:
    ranked_ids: tuple[str, ...]
    active_ids: tuple[str, ...]
    reserve_ids: tuple[str, ...]
    duplicate_groups: tuple[TopicDuplicateGroup, ...]
    unresolved_ids: tuple[str, ...]
    repeated_ranked_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class ValidSeedChoice:
    candidate_id: str
    candidate: SeedCandidate
    category: str | None = None
    intent: str | None = None


@dataclass
class MergedCandidate:
    keyword: str
    normalized_keyword: str
    rows: list[RawKeyword]
    relevance: float
    included: bool = False
    exclusion_reason: str | None = None

    @property
    def sources(self) -> list[str]:
        return sorted({row.source for row in self.rows})

    @property
    def best_source_rank(self) -> int:
        ranks = [row.provider_rank for row in self.rows if row.provider_rank > 0]
        return min(ranks, default=10**9)

    @property
    def best_seed_rank(self) -> int:
        ranks = [row.source_seed_rank for row in self.rows if row.source_seed_rank is not None]
        return min(ranks, default=10**9)


@dataclass(frozen=True)
class KeywordClassification:
    candidate: MergedCandidate
    relevant: bool
    business_topic: str | None
    confidence: float
    review_status: str
    reason: str
    primary_seed_id: str | None
    related_seed_ids: list[str]


def normalize_keyword(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = " ".join(normalized.strip().split())
    return normalized.casefold()


def display_keyword(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().split())


def tokenize(value: str, language: str) -> list[str]:
    normalized = normalize_keyword(value)
    language_prefix = language.split("-", 1)[0].lower()
    if language_prefix in {"zh", "ja", "ko"}:
        compact = re.sub(r"[\W_]+", "", normalized, flags=re.UNICODE)
        if len(compact) <= 2:
            return [compact] if compact else []
        return [compact[index : index + 2] for index in range(len(compact) - 1)]
    return re.findall(r"[\w'-]+", normalized, flags=re.UNICODE)


def is_obviously_wrong_language(value: str, language: str) -> bool:
    letters = [char for char in value if char.isalpha()]
    if not letters:
        return False
    prefix = language.split("-", 1)[0].lower()
    counts = {
        "cjk": sum("\u3400" <= char <= "\u9fff" for char in letters),
        "arabic": sum("\u0600" <= char <= "\u06ff" for char in letters),
        "cyrillic": sum("\u0400" <= char <= "\u04ff" for char in letters),
        "latin": sum(
            ("a" <= char.casefold() <= "z") or ("\u00c0" <= char <= "\u024f") for char in letters
        ),
    }
    dominant, count = max(counts.items(), key=lambda item: item[1])
    if count / len(letters) < 0.75:
        return False
    if prefix in {"zh", "ja"}:
        return dominant not in {"cjk", "latin"}
    if prefix == "ko":
        hangul = sum("\uac00" <= char <= "\ud7af" for char in letters)
        return hangul / len(letters) < 0.5 and dominant not in {"latin"}
    if prefix in {"ar", "fa", "ur"}:
        return dominant not in {"arabic", "latin"}
    if prefix in {"ru", "uk", "bg", "mk", "sr"}:
        return dominant not in {"cyrillic", "latin"}
    if prefix in LATIN_LANGUAGE_PREFIXES:
        return dominant not in {"latin"}
    return False


def hard_exclusion_reason(
    value: str,
    language: str,
    exclusion_terms: Iterable[str] = (),
) -> str | None:
    display = display_keyword(value)
    normalized = normalize_keyword(display)
    if not normalized:
        return "empty"
    if len(display) > 120:
        return "too_long"
    if re.fullmatch(r"https?://\S+|www\.\S+|\S+\.(com|net|org|io)(/\S*)?", display, re.I):
        return "url_only"
    if re.fullmatch(r"[\d\W_]+", display, re.UNICODE):
        return "no_words"
    if "\ufffd" in display:
        return "invalid_text"
    for term in exclusion_terms:
        normalized_term = normalize_keyword(term)
        if normalized_term and normalized_term in normalized:
            return "excluded_term"
    if is_obviously_wrong_language(display, language):
        return "wrong_language"
    return None


def seed_mechanical_exclusion_reason(value: str) -> str | None:
    normalized_text = unicodedata.normalize("NFKC", value)
    display = display_keyword(value)
    if not normalize_keyword(value):
        return "empty"
    if "\ufffd" in normalized_text or any(
        unicodedata.category(character) in {"Cc", "Cs"} and not character.isspace()
        for character in normalized_text
    ):
        return "invalid_text"
    if re.fullmatch(r"(?:https?://|www\.)\S+", display, re.I):
        return "url_only"
    if re.fullmatch(r"[\W_]+", display, re.UNICODE):
        return "no_words"
    return None


def keyword_annotation_concepts(idea: RawKeyword) -> list[dict[str, Any]]:
    annotations = idea.raw_payload.get("keyword_annotations")
    if not isinstance(annotations, dict):
        return []
    concepts = annotations.get("concepts")
    return (
        [concept for concept in concepts if isinstance(concept, dict)]
        if isinstance(
            concepts,
            list,
        )
        else []
    )


def keyword_annotation_topic_names(idea: RawKeyword) -> tuple[str, ...]:
    names: set[str] = set()
    for concept in keyword_annotation_concepts(idea):
        group = concept.get("concept_group")
        group = group if isinstance(group, dict) else {}
        if str(group.get("type") or "").upper() in {"BRAND", "OTHER_BRANDS"}:
            continue
        name = normalize_keyword(str(concept.get("name") or ""))
        if name:
            names.add(name)
    return tuple(sorted(names))


def profile_brand_names(profile: dict[str, Any], domain: str | None) -> set[str]:
    values: list[str] = []
    for key in ("business_name", "brand_name"):
        value = profile.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value)
    for key in ("brand_names", "brands", "own_brands", "allowed_brands"):
        value = profile.get(key)
        if isinstance(value, list):
            values.extend(str(item) for item in value if isinstance(item, str) and item.strip())
    if domain:
        host = re.sub(r"^https?://", "", domain.strip(), flags=re.I).split("/", 1)[0]
        host = host.split(":", 1)[0].removeprefix("www.")
        label = host.split(".", 1)[0]
        if label:
            values.append(label)
    return {normalize_keyword(value) for value in values if normalize_keyword(value)}


def compact_phrase(value: str) -> str:
    return re.sub(r"[\W_]+", "", normalize_keyword(value), flags=re.UNICODE)


def infer_business_model(profile: dict[str, Any]) -> str:
    explicit = normalize_keyword(str(profile.get("business_model") or ""))
    aliases = {
        "ecommerce": "product",
        "e commerce": "product",
        "products": "product",
        "services": "service",
        "saas": "software",
        "software as a service": "software",
        "publisher": "content",
        "media": "content",
    }
    explicit = aliases.get(explicit, explicit)
    if explicit in BUSINESS_MODELS:
        return explicit

    type_text = normalize_keyword(str(profile.get("business_type") or ""))
    values = [
        type_text,
        normalize_keyword(str(profile.get("business_summary") or "")),
    ]
    offerings = profile.get("products_services")
    if isinstance(offerings, list):
        values.extend(normalize_keyword(str(item)) for item in offerings)
    text = " ".join(value for value in values if value)

    signal_terms = {
        "software": (
            "saas",
            "software",
            "mobile app",
            "web app",
            "platform",
            "api provider",
            "plugin",
        ),
        "content": (
            "publisher",
            "media company",
            "news site",
            "magazine",
            "blog",
            "content site",
            "educational resource",
            "forum",
            "community site",
        ),
        "product": (
            "ecommerce",
            "e commerce",
            "online store",
            "retailer",
            "manufacturer",
            "product",
            "brand",
            "product brand",
            "consumer brand",
            "wholesaler",
            "distributor",
            "marketplace",
        ),
        "service": (
            "agency",
            "consultancy",
            "consultant",
            "law firm",
            "accounting firm",
            "contractor",
            "installer",
            "clinic",
            "dentist",
            "attorney",
            "repair shop",
            "cleaning company",
            "plumber",
            "plumbing",
            "hvac",
            "salon",
            "professional services",
            "service provider",
        ),
    }

    matched = {
        model for model, terms in signal_terms.items() if any(term in type_text for term in terms)
    }
    if not matched:
        matched = {
            model for model, terms in signal_terms.items() if any(term in text for term in terms)
        }
    if matched == {"software", "product"}:
        return "software"
    if len(matched) == 1:
        return next(iter(matched))
    if len(matched) > 1:
        return "mixed"
    return "mixed"


def excluded_brand_name(idea: RawKeyword, allowed_brands: set[str]) -> str | None:
    allowed_compact = {compact_phrase(value) for value in allowed_brands}
    for concept in keyword_annotation_concepts(idea):
        group = concept.get("concept_group")
        group = group if isinstance(group, dict) else {}
        group_type = str(group.get("type") or "").upper()
        if group_type not in {"BRAND", "OTHER_BRANDS"}:
            continue
        name = display_keyword(str(concept.get("name") or ""))
        normalized_name = normalize_keyword(name)
        compact_name = compact_phrase(name)
        if normalized_name in allowed_brands:
            continue
        if compact_name and compact_name in allowed_compact:
            continue
        return name or "unknown"
    return None


def english_variant_token(token: str) -> str:
    return ENGLISH_VARIANT_ALIASES.get(token, token)


def seed_variant_key(value: str, language: str) -> str:
    prefix = language.split("-", 1)[0].lower()
    tokens = tokenize(value, language)
    if prefix == "en":
        tokens = [
            english_variant_token(token) for token in tokens if token not in ENGLISH_VARIANT_FILLERS
        ]
    if prefix in LATIN_LANGUAGE_PREFIXES:
        unique_tokens = sorted(set(tokens))
        return " ".join(unique_tokens) or normalize_keyword(value)
    compact = re.sub(r"[\W_]+", "", normalize_keyword(value), flags=re.UNICODE)
    return compact or normalize_keyword(value)


def obvious_seed_phrase_issue(value: str, language: str) -> str | None:
    prefix = language.split("-", 1)[0].lower()
    if prefix not in LATIN_LANGUAGE_PREFIXES:
        return None
    tokens = tokenize(value, language)
    if not tokens:
        return "empty"
    if prefix == "en" and tokens[0] in {"and", "or"}:
        return "dangling_connector"
    if prefix == "en" and tokens[-1] in {"and", "or"}:
        return "dangling_connector"
    canonical = [english_variant_token(token) if prefix == "en" else token for token in tokens]
    if any(left == right for left, right in zip(canonical, canonical[1:], strict=False)):
        return "repeated_word"
    if len(canonical) >= 4 and len(canonical) % 2 == 0:
        midpoint = len(canonical) // 2
        if canonical[:midpoint] == canonical[midpoint:]:
            return "repeated_phrase"
    return None


def seed_representative_sort_key(idea: RawKeyword, language: str) -> tuple[Any, ...]:
    prefix = language.split("-", 1)[0].lower()
    tokens = tokenize(idea.keyword, language)
    filler_count = (
        sum(token in ENGLISH_VARIANT_FILLERS for token in tokens) if prefix == "en" else 0
    )
    symbol_count = len(re.findall(r"[^\w\s'-]", idea.keyword, flags=re.UNICODE))
    return (
        int(obvious_seed_phrase_issue(idea.keyword, language) is not None),
        filler_count,
        symbol_count,
        idea.provider_rank if idea.provider_rank > 0 else 10**9,
        idea.search_volume is None,
        -(idea.search_volume or 0),
        len(tokens),
        len(idea.keyword),
        normalize_keyword(idea.keyword),
    )


def prepare_seed_candidates(
    ideas: list[RawKeyword],
    profile: dict[str, Any],
    language: str,
    *,
    limit: int = 500,
    domain: str | None = None,
) -> tuple[list[SeedCandidate], dict[str, str]]:
    unique: dict[str, RawKeyword] = {}
    excluded: dict[str, str] = {}
    for idea in ideas:
        normalized = normalize_keyword(idea.keyword)
        reason = seed_mechanical_exclusion_reason(idea.keyword)
        if reason is not None:
            if normalized:
                excluded[normalized] = reason
            continue
        previous = unique.get(normalized)
        unique[normalized] = (
            idea if previous is None else merge_exact_duplicate_keywords(previous, idea)
        )

    allowed_brands = profile_brand_names(profile, domain)
    brand_filtered: list[RawKeyword] = []
    for idea in unique.values():
        normalized = normalize_keyword(idea.keyword)
        if excluded_brand_name(idea, allowed_brands) is not None:
            excluded[normalized] = "provider_unrelated_brand"
            continue
        brand_filtered.append(idea)

    eligible = sorted(
        brand_filtered,
        key=lambda idea: (
            idea.search_volume is None,
            -(idea.search_volume or 0),
            idea.provider_rank if idea.provider_rank > 0 else 10**9,
            normalize_keyword(idea.keyword),
        ),
    )
    selected_eligible = list(eligible[:limit])
    candidates = [
        SeedCandidate(
            keyword=display_keyword(idea.keyword),
            normalized_keyword=normalize_keyword(idea.keyword),
            rank=rank,
            selection_details={
                "rule_version": SEED_RULE_VERSION,
                "selection_method": "search_volume",
                "search_volume": idea.search_volume,
                "provider_rank": idea.provider_rank,
                "variant_key": seed_variant_key(idea.keyword, language),
                "merged_variant_count": 1,
            },
            raw=idea,
        )
        for rank, idea in enumerate(
            selected_eligible,
            start=1,
        )
    ]
    selected_normalized = {candidate.normalized_keyword for candidate in candidates}
    for idea in eligible:
        normalized = normalize_keyword(idea.keyword)
        if normalized not in selected_normalized:
            excluded[normalized] = "volume_limit"
    return candidates, excluded


def validate_initial_library_filter(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
    profile: dict[str, Any],
    language: str,
) -> dict[str, InitialLibraryAssessment]:
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, start=1)}
    allowed_categories = {
        *INITIAL_LIBRARY_APPROVAL_SCORES,
        *INITIAL_LIBRARY_REJECTION_REASONS,
    }
    if set(payload) != {"decisions"}:
        raise ValueError("AI initial-library filter must contain only the decisions array")
    raw_decisions = payload.get("decisions")
    if not isinstance(raw_decisions, list) or len(raw_decisions) != len(candidates):
        raise ValueError("AI initial-library filter must classify every candidate exactly once")

    allowed_brands = profile_brand_names(profile, None)
    assessments: dict[str, InitialLibraryAssessment] = {}
    for (candidate_id, candidate), category in zip(
        expected.items(),
        raw_decisions,
        strict=True,
    ):
        if not isinstance(category, str) or category not in allowed_categories:
            raise ValueError("AI initial-library filter contains an invalid decision category")
        if category == "remove_entity" and excluded_brand_name(
            candidate.raw,
            allowed_brands,
        ) is None:
            category = "keep"
        elif category == "remove_irrelevant" and strong_seed_business_evidence(
            candidate,
            profile,
            language,
        ):
            category = "keep"
        approved = category in INITIAL_LIBRARY_APPROVAL_SCORES
        assessments[candidate_id] = InitialLibraryAssessment(
            candidate_id=candidate_id,
            approved=approved,
            category=category,
            business_relevance=(INITIAL_LIBRARY_APPROVAL_SCORES[category] if approved else 0.0),
        )

    return assessments


def build_equal_volume_variant_pairs(
    topics: list[dict[str, Any]],
    language: str,
) -> list[TopicDuplicatePair]:
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for topic in topics:
        keyword = topic.get("representative_keyword")
        volume = topic.get("search_volume")
        if (
            isinstance(keyword, str)
            and keyword.strip()
            and isinstance(volume, int)
            and not isinstance(volume, bool)
        ):
            grouped[(seed_variant_key(keyword, language), volume)].append(topic)

    def representative_key(topic: dict[str, Any]) -> tuple[Any, ...]:
        keyword = str(topic["representative_keyword"])
        tokens = tokenize(keyword, language)
        prefix = language.split("-", 1)[0].lower()
        filler_count = (
            sum(token in ENGLISH_VARIANT_FILLERS for token in tokens) if prefix == "en" else 0
        )
        return (
            int(obvious_seed_phrase_issue(keyword, language) is not None),
            filler_count,
            len(tokens),
            len(keyword),
            int(topic.get("topic_rank") or 10**9),
        )

    pairs: list[TopicDuplicatePair] = []
    for members in grouped.values():
        if len(members) < 2:
            continue
        ordered = sorted(members, key=representative_key)
        keep_id = str(ordered[0]["representative_id"])
        for duplicate in ordered[1:]:
            pairs.append(
                TopicDuplicatePair(
                    pair_id=f"d{len(pairs) + 1:03d}",
                    left_id=keep_id,
                    right_id=str(duplicate["representative_id"]),
                    signals=("same_variant_key_and_volume",),
                )
            )
    return pairs


def build_initial_library_topics(
    candidates: list[SeedCandidate],
    assessments: dict[str, InitialLibraryAssessment],
    profile: dict[str, Any],
) -> list[dict[str, Any]]:
    business_model = infer_business_model(profile)
    default_intent = {
        "product": "product",
        "service": "service",
        "software": "product",
        "content": "informational",
        "mixed": "commercial",
    }[business_model]
    topics: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates, start=1):
        candidate_id = f"k{index:03d}"
        assessment = assessments.get(candidate_id)
        if assessment is None or not assessment.approved:
            continue
        provider_intent = normalize_keyword(str(candidate.raw.intent or ""))
        page_intent = (
            provider_intent
            if provider_intent in {"informational", "commercial"}
            else default_intent
        )
        annotation_concepts = keyword_annotation_topic_names(candidate.raw)
        topics.append(
            {
                "topic_rank": len(topics) + 1,
                "representative_id": candidate_id,
                "representative_keyword": candidate.keyword,
                "object": display_keyword(candidate.keyword)[:120],
                "need": "keyword library candidate",
                "page_intent": page_intent,
                "search_volume": candidate.raw.search_volume,
                "member_ids": (candidate_id,),
                "business_relevance": assessment.business_relevance,
                "relevance_tier": assessment.category,
                "annotation_concepts": annotation_concepts,
            }
        )
    return topics


def validate_seed_topic_clusters(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
    *,
    require_excluded: bool = False,
) -> list[SeedTopicCluster]:
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    topics = payload.get("topics")
    if not isinstance(topics, list) or not topics:
        raise ValueError("AI topic response must contain a non-empty topics array")

    seen_members: set[str] = set()
    clusters: list[SeedTopicCluster] = []
    for topic in topics:
        if not isinstance(topic, dict):
            raise ValueError("AI topic must be an object")
        representative_id = topic.get("representative")
        member_ids = topic.get("members")
        if not isinstance(representative_id, str) or representative_id not in expected:
            raise ValueError("AI topic response contains an invalid representative id")
        if not isinstance(member_ids, list) or not member_ids:
            raise ValueError("AI topic members must be a non-empty array")

        local_members: set[str] = set()
        member_candidates: list[SeedCandidate] = []
        for member_id in member_ids:
            if not isinstance(member_id, str) or member_id not in expected:
                raise ValueError("AI topic response contains an invalid member id")
            if member_id in local_members:
                raise ValueError("AI topic response repeats a member within a topic")
            if member_id in seen_members:
                raise ValueError("AI topic response assigns a keyword to multiple topics")
            local_members.add(member_id)
            seen_members.add(member_id)
            member_candidates.append(expected[member_id])

        if representative_id not in local_members:
            raise ValueError("AI topic representative must also be a member")
        clusters.append(
            SeedTopicCluster(
                representative_id=representative_id,
                representative=expected[representative_id],
                member_ids=tuple(member_ids),
                members=tuple(member_candidates),
            )
        )

    excluded = payload.get("excluded")
    if require_excluded and not isinstance(excluded, list):
        raise ValueError("AI topic response must contain an excluded array")
    if isinstance(excluded, list):
        seen_excluded: set[str] = set()
        for excluded_id in excluded:
            if not isinstance(excluded_id, str) or excluded_id not in expected:
                raise ValueError("AI topic response contains an invalid excluded id")
            if excluded_id in seen_excluded:
                raise ValueError("AI topic response repeats an excluded id")
            if excluded_id in seen_members:
                raise ValueError("AI topic response both clusters and excludes a keyword")
            seen_excluded.add(excluded_id)
        missing_ids = set(expected) - seen_members - seen_excluded
        if missing_ids:
            raise ValueError("AI topic response does not account for every candidate")
    return clusters


def validate_seed_topic_representatives(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
    *,
    topic_limit: int | None = None,
) -> list[dict[str, Any]]:
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    topics = payload.get("topics")
    if not isinstance(topics, list) or not topics:
        raise ValueError("AI topic response must contain a non-empty topics array")
    effective_limit = len(candidates) if topic_limit is None else min(topic_limit, len(candidates))
    if len(topics) > effective_limit:
        raise ValueError("AI topic response exceeds the topic limit")

    seen_representatives: set[str] = set()
    accounted_ids: set[str] = set()
    seen_signatures: set[tuple[str, str, str]] = set()
    validated: list[dict[str, Any]] = []
    for rank, topic in enumerate(topics, start=1):
        if not isinstance(topic, dict):
            raise ValueError("AI topic must be an object")
        representative_id = topic.get("representative")
        if not isinstance(representative_id, str) or representative_id not in expected:
            raise ValueError("AI topic response contains an invalid representative id")
        if representative_id in seen_representatives:
            raise ValueError("AI topic response repeats a representative id")
        member_ids = topic.get("members")
        if not isinstance(member_ids, list) or not member_ids:
            raise ValueError("AI topic response contains an invalid members array")
        local_members: set[str] = set()
        for member_id in member_ids:
            if not isinstance(member_id, str) or member_id not in expected:
                raise ValueError("AI topic response contains an invalid member id")
            if member_id in local_members:
                raise ValueError("AI topic response repeats a member within one topic")
            if member_id in accounted_ids:
                raise ValueError("AI topic response assigns a candidate more than once")
            local_members.add(member_id)
            accounted_ids.add(member_id)
        if representative_id not in local_members:
            raise ValueError("AI topic representative must be one of its members")

        object_name = display_keyword(str(topic.get("object") or ""))
        need = display_keyword(str(topic.get("need") or ""))
        page_intent = normalize_keyword(str(topic.get("page_intent") or ""))
        if not object_name or len(object_name) > 120:
            raise ValueError("AI topic response contains an invalid object")
        if not need or len(need) > 120:
            raise ValueError("AI topic response contains an invalid need")
        if page_intent not in SEED_PAGE_INTENTS:
            raise ValueError("AI topic response contains an invalid page intent")

        signature = (
            normalize_keyword(object_name),
            normalize_keyword(need),
            page_intent,
        )
        if signature in seen_signatures:
            raise ValueError("AI topic response repeats a canonical topic signature")

        candidate = expected[representative_id]
        seen_representatives.add(representative_id)
        seen_signatures.add(signature)
        validated.append(
            {
                "topic_rank": rank,
                "representative_id": representative_id,
                "representative_keyword": candidate.keyword,
                "object": object_name,
                "need": need,
                "page_intent": page_intent,
                "search_volume": candidate.raw.search_volume,
                "member_ids": tuple(member_ids),
            }
        )

    excluded = payload.get("excluded")
    if not isinstance(excluded, list):
        raise ValueError("AI topic response must contain an excluded array")
    for excluded_id in excluded:
        if not isinstance(excluded_id, str) or excluded_id not in expected:
            raise ValueError("AI topic response contains an invalid excluded id")
        if excluded_id in accounted_ids:
            raise ValueError("AI topic response assigns a candidate more than once")
        accounted_ids.add(excluded_id)
    if accounted_ids != set(expected):
        raise ValueError("AI topic response does not account for every candidate")
    return validated


def repair_seed_topic_representatives(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Salvage valid topic assignments from a structurally valid AI response.

    Structured-output schemas cannot enforce uniqueness across nested arrays. Keep the
    earliest topic assignment and repair only those cross-array conflicts instead of
    discarding the entire paid response.
    """
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    raw_topics = payload.get("topics")
    if not isinstance(raw_topics, list) or not raw_topics:
        raise ValueError("AI topic response must contain a non-empty topics array")

    accounted_ids: set[str] = set()
    signature_indexes: dict[tuple[str, str, str], int] = {}
    repaired: list[dict[str, Any]] = []
    diagnostics = {
        "repeated_member_count": 0,
        "representative_replacement_count": 0,
        "merged_signature_count": 0,
        "skipped_invalid_topic_count": 0,
        "excluded_conflict_count": 0,
        "repeated_excluded_count": 0,
        "invalid_excluded_count": 0,
        "missing_candidate_count": 0,
    }

    for topic in raw_topics:
        if not isinstance(topic, dict):
            diagnostics["skipped_invalid_topic_count"] += 1
            continue
        object_name = display_keyword(str(topic.get("object") or ""))
        need = display_keyword(str(topic.get("need") or ""))
        page_intent = normalize_keyword(str(topic.get("page_intent") or ""))
        member_ids = topic.get("members")
        if (
            not object_name
            or len(object_name) > 120
            or not need
            or len(need) > 120
            or page_intent not in SEED_PAGE_INTENTS
            or not isinstance(member_ids, list)
        ):
            diagnostics["skipped_invalid_topic_count"] += 1
            continue

        available_members: list[str] = []
        local_members: set[str] = set()
        for member_id in member_ids:
            if not isinstance(member_id, str) or member_id not in expected:
                continue
            if member_id in local_members or member_id in accounted_ids:
                diagnostics["repeated_member_count"] += 1
                continue
            local_members.add(member_id)
            available_members.append(member_id)
        if not available_members:
            diagnostics["skipped_invalid_topic_count"] += 1
            continue

        signature = (
            normalize_keyword(object_name),
            normalize_keyword(need),
            page_intent,
        )
        existing_index = signature_indexes.get(signature)
        if existing_index is not None:
            existing = repaired[existing_index]
            existing["member_ids"] = (*existing["member_ids"], *available_members)
            accounted_ids.update(available_members)
            diagnostics["merged_signature_count"] += 1
            continue

        representative_id = topic.get("representative")
        if representative_id not in available_members:
            representative_id = available_members[0]
            diagnostics["representative_replacement_count"] += 1
        candidate = expected[representative_id]
        accounted_ids.update(available_members)
        signature_indexes[signature] = len(repaired)
        repaired.append(
            {
                "topic_rank": len(repaired) + 1,
                "representative_id": representative_id,
                "representative_keyword": candidate.keyword,
                "object": object_name,
                "need": need,
                "page_intent": page_intent,
                "search_volume": candidate.raw.search_volume,
                "member_ids": tuple(available_members),
            }
        )

    if not repaired:
        raise ValueError("AI topic response contains no repairable topics")
    excluded_ids: set[str] = set()
    raw_excluded = payload.get("excluded")
    if isinstance(raw_excluded, list):
        for excluded_id in raw_excluded:
            if not isinstance(excluded_id, str) or excluded_id not in expected:
                diagnostics["invalid_excluded_count"] += 1
            elif excluded_id in excluded_ids:
                diagnostics["repeated_excluded_count"] += 1
            elif excluded_id in accounted_ids:
                diagnostics["excluded_conflict_count"] += 1
            else:
                excluded_ids.add(excluded_id)
    diagnostics["missing_candidate_count"] = len(set(expected) - accounted_ids - excluded_ids)
    return repaired, diagnostics


def build_topic_seed_decisions(
    candidates: list[SeedCandidate],
    topics: list[dict[str, Any]],
    resolution: TopicSelectionResolution,
    assessments: dict[str, InitialLibraryAssessment] | None = None,
) -> list[SeedDecision]:
    candidate_by_id = {
        f"k{index:03d}": candidate for index, candidate in enumerate(candidates, start=1)
    }
    topic_by_id = {
        str(topic["representative_id"]): topic
        for topic in topics
        if str(topic.get("representative_id") or "") in candidate_by_id
    }
    if len(topic_by_id) != len(topics):
        raise ValueError("Validated topics contain an invalid or repeated representative id")

    ranked_ids = set(resolution.ranked_ids)
    active_ids = set(resolution.active_ids)
    dropped_ids = {
        candidate_id for group in resolution.duplicate_groups for candidate_id in group.drop_ids
    }
    if ranked_ids & dropped_ids:
        raise ValueError("Topic resolution both ranks and drops a representative")
    if ranked_ids | dropped_ids != set(topic_by_id):
        raise ValueError("Topic resolution does not account for every topic representative")

    rank_by_id = {
        candidate_id: rank for rank, candidate_id in enumerate(resolution.ranked_ids, start=1)
    }
    member_topic_by_id: dict[str, dict[str, Any]] = {}
    for topic in topics:
        for member_id in topic.get("member_ids") or ():
            member_topic_by_id[str(member_id)] = topic

    def topic_label(topic: dict[str, Any]) -> str:
        return " | ".join(
            (
                str(topic["object"]),
                str(topic["need"]),
                str(topic["page_intent"]),
            )
        )

    decisions: list[SeedDecision] = []
    for candidate_id, candidate in candidate_by_id.items():
        assessment = (assessments or {}).get(candidate_id)
        topic = topic_by_id.get(candidate_id)
        if candidate_id in active_ids and topic is not None:
            decisions.append(
                SeedDecision(
                    candidate=candidate,
                    selected=True,
                    ai_rank=rank_by_id[candidate_id],
                    business_topic=topic_label(topic),
                    reason_code=None,
                    reason="",
                    business_relevance=float(topic.get("business_relevance") or 0.0),
                    relevance_tier=str(topic.get("relevance_tier") or "") or None,
                )
            )
            continue

        member_topic = member_topic_by_id.get(candidate_id)
        if member_topic is not None and candidate_id not in topic_by_id:
            decisions.append(
                SeedDecision(
                    candidate=candidate,
                    selected=False,
                    ai_rank=None,
                    business_topic=topic_label(member_topic),
                    reason_code="topic_member",
                    reason=(f"represented_by:{member_topic['representative_id']}"),
                    business_relevance=(
                        assessment.business_relevance if assessment is not None else None
                    ),
                    relevance_tier=assessment.category if assessment is not None else None,
                )
            )
            continue

        decisions.append(
            SeedDecision(
                candidate=candidate,
                selected=False,
                ai_rank=None,
                business_topic=topic_label(topic) if topic is not None else None,
                reason_code=(
                    "duplicate_seed_topic"
                    if candidate_id in dropped_ids
                    else "reserve_seed_topic"
                    if candidate_id in ranked_ids
                    else assessment.category
                    if assessment is not None
                    else "ai_excluded"
                ),
                reason="",
                business_relevance=(
                    assessment.business_relevance if assessment is not None else 0.0
                ),
                relevance_tier=assessment.category if assessment is not None else None,
            )
        )

    if not any(decision.selected for decision in decisions):
        raise ValueError("AI did not select any usable seed topic")
    return decisions


def validate_active_seed_selection(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
) -> list[ActiveSeedChoice]:
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    active = payload.get("active")
    if not isinstance(active, list):
        raise ValueError("AI active seed response must contain an active array")
    required_count = min(ACTIVE_SEED_LIMIT, len(candidates))
    if len(active) != required_count:
        raise ValueError(f"AI active seed response must contain exactly {required_count} ids")

    seen: set[str] = set()
    choices: list[ActiveSeedChoice] = []
    for candidate_id in active:
        if not isinstance(candidate_id, str) or candidate_id not in expected:
            raise ValueError("AI active seed response contains an invalid id")
        if candidate_id in seen:
            raise ValueError("AI active seed response contains a repeated id")
        seen.add(candidate_id)
        choices.append(
            ActiveSeedChoice(
                candidate_id=candidate_id,
                candidate=expected[candidate_id],
            )
        )
    return choices


def resolve_topic_seed_selection(
    candidate_ids: Iterable[str],
    payload: dict[str, Any],
    *,
    active_limit: int = ACTIVE_SEED_LIMIT,
) -> TopicSelectionResolution:
    expected_ids = tuple(candidate_ids)
    if (
        not expected_ids
        or any(
            not isinstance(candidate_id, str) or not candidate_id for candidate_id in expected_ids
        )
        or len(set(expected_ids)) != len(expected_ids)
    ):
        raise ValueError("Topic candidate IDs must be non-empty, unique strings")
    if active_limit < 1:
        raise ValueError("Topic active limit must be positive")
    expected = set(expected_ids)

    def validate_id_list(field: str) -> tuple[str, ...]:
        value = payload.get(field)
        if not isinstance(value, list):
            raise ValueError(f"AI topic resolution must contain a {field} array")
        seen: set[str] = set()
        validated: list[str] = []
        for candidate_id in value:
            if not isinstance(candidate_id, str) or candidate_id not in expected:
                raise ValueError(f"AI topic resolution contains an invalid {field} ID")
            if candidate_id in seen:
                raise ValueError(f"AI topic resolution repeats a {field} ID")
            seen.add(candidate_id)
            validated.append(candidate_id)
        return tuple(validated)

    ranked_ids = validate_id_list("ranked")
    raw_groups = payload.get("duplicate_groups")
    if not isinstance(raw_groups, list):
        raise ValueError("AI topic resolution must contain a duplicate_groups array")

    keep_ids: set[str] = set()
    dropped_ids: set[str] = set()
    duplicate_groups: list[TopicDuplicateGroup] = []
    for raw_group in raw_groups:
        if not isinstance(raw_group, dict):
            raise ValueError("AI topic duplicate group must be an object")
        keep_id = raw_group.get("keep")
        raw_drop_ids = raw_group.get("drop")
        if not isinstance(keep_id, str) or keep_id not in expected:
            raise ValueError("AI topic duplicate group contains an invalid keep ID")
        if keep_id in keep_ids:
            raise ValueError("AI topic resolution repeats a duplicate keep ID")
        if not isinstance(raw_drop_ids, list) or not raw_drop_ids:
            raise ValueError("AI topic duplicate group must contain at least one drop ID")

        local_drops: set[str] = set()
        drop_ids: list[str] = []
        for drop_id in raw_drop_ids:
            if not isinstance(drop_id, str) or drop_id not in expected:
                raise ValueError("AI topic duplicate group contains an invalid drop ID")
            if drop_id == keep_id:
                raise ValueError("AI topic duplicate group cannot drop its keep ID")
            if drop_id in local_drops or drop_id in dropped_ids:
                raise ValueError("AI topic resolution repeats a duplicate drop ID")
            local_drops.add(drop_id)
            dropped_ids.add(drop_id)
            drop_ids.append(drop_id)

        keep_ids.add(keep_id)
        duplicate_groups.append(TopicDuplicateGroup(keep_id=keep_id, drop_ids=tuple(drop_ids)))

    ranked = set(ranked_ids)
    if ranked & dropped_ids:
        raise ValueError("AI topic resolution both ranks and drops an ID")
    if keep_ids - ranked:
        raise ValueError("Every duplicate keep ID must appear in ranked")
    if keep_ids & dropped_ids:
        raise ValueError("A duplicate keep ID cannot also be dropped")

    resolved_ids = ranked | dropped_ids
    unresolved_ids = tuple(
        candidate_id for candidate_id in expected_ids if candidate_id not in resolved_ids
    )
    active_ids = ranked_ids[:active_limit]
    reserve_ids = ranked_ids[active_limit:]
    return TopicSelectionResolution(
        ranked_ids=ranked_ids,
        active_ids=active_ids,
        reserve_ids=reserve_ids,
        duplicate_groups=tuple(duplicate_groups),
        unresolved_ids=unresolved_ids,
    )


def build_topic_duplicate_pairs(
    topics: list[dict[str, Any]],
    language: str,
) -> list[TopicDuplicatePair]:
    pair_token_aliases = {
        "cleaners": "cleaner",
        "coatings": "coating",
        "removers": "remover",
        "shampoos": "shampoo",
        "solutions": "solution",
        "sprays": "spray",
        "tv": "television",
        "windshield": "glass",
        "window": "glass",
    }

    def canonical_tokens(keyword: str) -> set[str]:
        return {
            pair_token_aliases.get(
                english_variant_token(token),
                english_variant_token(token),
            )
            for token in tokenize(keyword, language)
            if token not in ENGLISH_VARIANT_FILLERS
        }

    records: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for topic in topics:
        candidate_id = topic.get("representative_id")
        keyword = topic.get("representative_keyword")
        if (
            not isinstance(candidate_id, str)
            or not candidate_id
            or candidate_id in seen_ids
            or not isinstance(keyword, str)
            or not keyword.strip()
        ):
            raise ValueError("Topic duplicate-pair input contains an invalid topic")
        seen_ids.add(candidate_id)
        keyword_tokens = canonical_tokens(keyword)
        records.append(
            {
                "id": candidate_id,
                "keyword": normalize_keyword(keyword),
                "tokens": keyword_tokens,
                "variant_key": seed_variant_key(keyword, language),
                "object": normalize_keyword(str(topic.get("object") or "")),
                "need": normalize_keyword(str(topic.get("need") or "")),
                "page_intent": normalize_keyword(str(topic.get("page_intent") or "")),
                "annotation_concepts": {
                    normalize_keyword(str(value))
                    for value in topic.get("annotation_concepts", ())
                    if normalize_keyword(str(value))
                },
            }
        )

    pair_rows: list[tuple[float, int, int, tuple[str, ...]]] = []
    for left_index, left in enumerate(records):
        for right_index in range(left_index + 1, len(records)):
            right = records[right_index]
            signals: list[str] = []
            score = 0.0

            if left["variant_key"] == right["variant_key"]:
                signals.append("same_variant_key")
                score = max(score, 1.15)

            if left["tokens"] == right["tokens"]:
                signals.append("same_canonical_tokens")
                score = max(score, 1.2)

            sequence_ratio = SequenceMatcher(
                None,
                str(left["keyword"]),
                str(right["keyword"]),
            ).ratio()
            if sequence_ratio >= 0.76:
                signals.append("similar_wording")
                score = max(score, sequence_ratio)

            left_tokens = left["tokens"]
            right_tokens = right["tokens"]
            if left_tokens and right_tokens:
                shared_count = len(left_tokens & right_tokens)
                containment = shared_count / min(len(left_tokens), len(right_tokens))
                if shared_count >= 2 and containment >= 0.75:
                    signals.append("token_containment")
                    extra_count = len(left_tokens | right_tokens) - shared_count
                    score = max(score, containment + (0.05 if extra_count <= 1 else 0.0))

            # Provider concepts strengthen a wording-based candidate but never create one alone.
            # Broad concepts such as "television" otherwise produce quadratic all-to-all pairs.
            if signals:
                left_concepts = left["annotation_concepts"]
                right_concepts = right["annotation_concepts"]
                shared_concepts = left_concepts & right_concepts
                if left_concepts and left_concepts == right_concepts:
                    signals.append("same_annotation_concepts")
                    score = max(score, 1.1)
                elif len(shared_concepts) >= 2:
                    concept_containment = len(shared_concepts) / min(
                        len(left_concepts),
                        len(right_concepts),
                    )
                    if concept_containment >= 0.75:
                        signals.append("annotation_concept_overlap")
                        score = max(score, 0.8 + concept_containment * 0.2)

            same_signature = (
                bool(left["object"])
                and left["object"] == right["object"]
                and bool(left["need"])
                and left["need"] == right["need"]
                and bool(left["page_intent"])
                and left["page_intent"] == right["page_intent"]
            )
            if same_signature:
                signals.append("same_topic_signature")
                score = max(score, 1.25)

            if signals:
                pair_rows.append(
                    (
                        score,
                        left_index,
                        right_index,
                        tuple(signals),
                    )
                )

    pair_rows.sort(key=lambda row: (-row[0], row[1], row[2]))
    parent = list(range(len(records)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    selected_rows: list[tuple[float, int, int, tuple[str, ...]]] = []
    for row in pair_rows:
        left_root = find(row[1])
        right_root = find(row[2])
        if left_root == right_root:
            continue
        parent[right_root] = left_root
        selected_rows.append(row)

    return [
        TopicDuplicatePair(
            pair_id=f"p{index:03d}",
            left_id=str(records[left_index]["id"]),
            right_id=str(records[right_index]["id"]),
            signals=signals,
        )
        for index, (_, left_index, right_index, signals) in enumerate(
            selected_rows,
            start=1,
        )
    ]


def resolve_bounded_topic_seed_selection(
    candidate_ids: Iterable[str],
    duplicate_pairs: list[TopicDuplicatePair],
    payload: dict[str, Any],
    *,
    active_limit: int = ACTIVE_SEED_LIMIT,
) -> TopicSelectionResolution:
    expected_ids = tuple(candidate_ids)
    if (
        not expected_ids
        or any(
            not isinstance(candidate_id, str) or not candidate_id for candidate_id in expected_ids
        )
        or len(set(expected_ids)) != len(expected_ids)
    ):
        raise ValueError("Topic candidate IDs must be non-empty, unique strings")
    if active_limit < 1:
        raise ValueError("Topic active limit must be positive")
    expected = set(expected_ids)

    pair_by_id: dict[str, TopicDuplicatePair] = {}
    for pair in duplicate_pairs:
        if (
            not pair.pair_id
            or pair.pair_id in pair_by_id
            or pair.left_id not in expected
            or pair.right_id not in expected
            or pair.left_id == pair.right_id
        ):
            raise ValueError("Topic duplicate-pair list is invalid")
        pair_by_id[pair.pair_id] = pair

    raw_ranked = payload.get("ranked")
    if not isinstance(raw_ranked, list):
        raise ValueError("AI topic resolution must contain a ranked array")
    ranked_seen: set[str] = set()
    ranked_unique: list[str] = []
    repeated_ranked: list[str] = []
    for candidate_id in raw_ranked:
        if not isinstance(candidate_id, str) or candidate_id not in expected:
            raise ValueError("AI topic resolution contains an invalid ranked ID")
        if candidate_id in ranked_seen:
            if candidate_id not in repeated_ranked:
                repeated_ranked.append(candidate_id)
            continue
        ranked_seen.add(candidate_id)
        ranked_unique.append(candidate_id)
    missing_ids = tuple(
        candidate_id for candidate_id in expected_ids if candidate_id not in ranked_seen
    )
    if repeated_ranked:
        raise ValueError("AI topic resolution contains repeated ranked IDs")
    if missing_ids:
        raise ValueError("AI topic resolution omitted one or more ranked IDs")
    complete_ranked = tuple(ranked_unique)

    raw_confirmed_pairs = payload.get("duplicate_pair_ids")
    if not isinstance(raw_confirmed_pairs, list):
        raise ValueError("AI topic resolution must contain a duplicate_pair_ids array")
    confirmed_pair_ids: list[str] = []
    confirmed_seen: set[str] = set()
    for pair_id in raw_confirmed_pairs:
        if not isinstance(pair_id, str) or pair_id not in pair_by_id:
            raise ValueError("AI topic resolution contains an invalid duplicate pair ID")
        if pair_id not in confirmed_seen:
            confirmed_seen.add(pair_id)
            confirmed_pair_ids.append(pair_id)

    confirmed_neighbors: dict[str, set[str]] = defaultdict(set)
    for pair_id in confirmed_pair_ids:
        pair = pair_by_id[pair_id]
        confirmed_neighbors[pair.left_id].add(pair.right_id)
        confirmed_neighbors[pair.right_id].add(pair.left_id)

    rank_position = {
        candidate_id: position for position, candidate_id in enumerate(complete_ranked)
    }
    dropped_ids: set[str] = set()
    direct_drops: dict[str, list[str]] = defaultdict(list)
    for keep_id in complete_ranked:
        if keep_id in dropped_ids:
            continue
        for neighbor_id in sorted(
            confirmed_neighbors.get(keep_id, ()),
            key=rank_position.__getitem__,
        ):
            if neighbor_id in dropped_ids or rank_position[neighbor_id] < rank_position[keep_id]:
                continue
            dropped_ids.add(neighbor_id)
            direct_drops[keep_id].append(neighbor_id)

    duplicate_groups = tuple(
        TopicDuplicateGroup(keep_id=keep_id, drop_ids=tuple(direct_drops[keep_id]))
        for keep_id in complete_ranked
        if direct_drops.get(keep_id)
    )

    ranked_ids = tuple(
        candidate_id for candidate_id in complete_ranked if candidate_id not in dropped_ids
    )
    return TopicSelectionResolution(
        ranked_ids=ranked_ids,
        active_ids=ranked_ids[:active_limit],
        reserve_ids=ranked_ids[active_limit:],
        duplicate_groups=duplicate_groups,
        unresolved_ids=missing_ids,
        repeated_ranked_ids=tuple(repeated_ranked),
    )


def validate_diverse_seed_pool(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
    *,
    expected_count: int | None = None,
) -> list[SeedPoolGroup]:
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    groups = payload.get("groups")
    if not isinstance(groups, list):
        raise ValueError("AI seed pool response must contain a groups array")

    required_count = (
        min(SEED_POOL_LIMIT, len(candidates)) if expected_count is None else expected_count
    )
    if not 1 <= required_count <= min(SEED_POOL_LIMIT, len(candidates)):
        raise ValueError("AI seed pool expected count is invalid")
    minimum_groups = min(SEED_POOL_MIN_GROUPS, required_count)
    maximum_groups = min(SEED_POOL_MAX_GROUPS, required_count)
    if not minimum_groups <= len(groups) <= maximum_groups:
        raise ValueError(
            f"AI seed pool response must contain {minimum_groups} to {maximum_groups} groups"
        )

    seen_topics: set[str] = set()
    seen_ids: set[str] = set()
    validated: list[SeedPoolGroup] = []
    for group in groups:
        if not isinstance(group, dict):
            raise ValueError("AI seed pool group must be an object")
        topic = group.get("topic")
        member_ids = group.get("ids")
        if not isinstance(topic, str) or not topic.strip() or len(topic.strip()) > 120:
            raise ValueError("AI seed pool group contains an invalid topic")
        normalized_topic = normalize_keyword(topic)
        if normalized_topic in seen_topics:
            raise ValueError("AI seed pool response contains a repeated topic")
        seen_topics.add(normalized_topic)
        if (
            not isinstance(member_ids, list)
            or not member_ids
            or len(member_ids) > SEED_POOL_MAX_GROUP_SIZE
        ):
            raise ValueError(f"AI seed pool group must contain 1 to {SEED_POOL_MAX_GROUP_SIZE} ids")

        local_ids: set[str] = set()
        members: list[SeedCandidate] = []
        for candidate_id in member_ids:
            if not isinstance(candidate_id, str) or candidate_id not in expected:
                raise ValueError("AI seed pool response contains an invalid id")
            if candidate_id in local_ids or candidate_id in seen_ids:
                raise ValueError("AI seed pool response contains a repeated id")
            local_ids.add(candidate_id)
            seen_ids.add(candidate_id)
            members.append(expected[candidate_id])
        validated.append(
            SeedPoolGroup(
                topic=topic.strip(),
                member_ids=tuple(member_ids),
                members=tuple(members),
            )
        )

    if len(seen_ids) != required_count:
        raise ValueError(f"AI seed pool response must contain exactly {required_count} unique ids")
    return validated


def validate_grouped_active_seed_selection(
    groups: list[SeedPoolGroup],
    payload: dict[str, Any],
) -> list[ActiveSeedChoice]:
    expected: dict[str, tuple[int, SeedCandidate]] = {}
    for group_index, group in enumerate(groups):
        for candidate_id, candidate in zip(group.member_ids, group.members, strict=True):
            expected[candidate_id] = (group_index, candidate)

    active = payload.get("active")
    if not isinstance(active, list):
        raise ValueError("AI grouped active response must contain an active array")
    required_count = min(ACTIVE_SEED_LIMIT, len(groups))
    if len(active) != required_count:
        raise ValueError(f"AI grouped active response must contain exactly {required_count} ids")

    seen_ids: set[str] = set()
    seen_groups: set[int] = set()
    choices: list[ActiveSeedChoice] = []
    for candidate_id in active:
        if not isinstance(candidate_id, str) or candidate_id not in expected:
            raise ValueError("AI grouped active response contains an invalid id")
        if candidate_id in seen_ids:
            raise ValueError("AI grouped active response contains a repeated id")
        group_index, candidate = expected[candidate_id]
        if group_index in seen_groups:
            raise ValueError("AI grouped active response selects multiple ids from one topic")
        seen_ids.add(candidate_id)
        seen_groups.add(group_index)
        choices.append(ActiveSeedChoice(candidate_id=candidate_id, candidate=candidate))
    return choices


def validate_valid_seed_candidates(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
    allowed_categories: list[str],
) -> list[ValidSeedChoice]:
    expected = {
        candidate.keyword: (f"k{index:03d}", candidate)
        for index, candidate in enumerate(candidates, start=1)
    }
    if len(expected) != len(candidates):
        raise ValueError("AI seed classification requires unique candidate keywords")

    kept = payload.get("kept")
    removed = payload.get("removed")
    if not isinstance(kept, list) or not isinstance(removed, list):
        raise ValueError("AI seed classification must contain kept and removed arrays")

    category_set = set(allowed_categories)
    if not category_set:
        raise ValueError("AI seed classification requires at least one allowed category")
    allowed_intents = {"Informational", "Commercial", "Transactional", "Navigational"}
    seen: set[str] = set()
    choices_by_keyword: dict[str, ValidSeedChoice] = {}

    for item in kept:
        if not isinstance(item, dict):
            raise ValueError("AI kept keyword entry must be an object")
        keyword = item.get("keyword")
        category = item.get("category")
        intent = item.get("intent")
        if not isinstance(keyword, str) or keyword not in expected:
            raise ValueError("AI kept keyword entry does not preserve an input keyword")
        if keyword in seen:
            raise ValueError("AI seed classification contains a repeated keyword")
        if not isinstance(category, str) or category not in category_set:
            raise ValueError("AI kept keyword entry contains an invalid category")
        if not isinstance(intent, str) or intent not in allowed_intents:
            raise ValueError("AI kept keyword entry contains an invalid intent")
        seen.add(keyword)
        candidate_id, candidate = expected[keyword]
        choices_by_keyword[keyword] = ValidSeedChoice(
            candidate_id=candidate_id,
            candidate=candidate,
            category=category,
            intent=intent,
        )

    for item in removed:
        if not isinstance(item, dict):
            raise ValueError("AI removed keyword entry must be an object")
        keyword = item.get("keyword")
        if not isinstance(keyword, str) or keyword not in expected:
            raise ValueError("AI removed keyword entry does not preserve an input keyword")
        if keyword in seen:
            raise ValueError("AI seed classification contains a repeated keyword")
        seen.add(keyword)

    if seen != set(expected):
        raise ValueError("AI seed classification omitted one or more input keywords")

    return [
        choices_by_keyword[candidate.keyword]
        for candidate in candidates
        if candidate.keyword in choices_by_keyword
    ]


def validate_seed_decisions(
    candidates: list[SeedCandidate],
    payload: dict[str, Any],
) -> list[SeedDecision]:
    expected = {f"k{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    active = payload.get("active")
    reserve = payload.get("reserve")
    if active is not None or reserve is not None:
        if not isinstance(active, list) or not isinstance(reserve, list):
            raise ValueError("AI seed response must contain active and reserve arrays")
        if len(active) > ACTIVE_SEED_LIMIT:
            raise ValueError("AI active seed response exceeds the twenty-seed limit")
        ranked_ids = [
            *[(identifier, rank) for rank, identifier in enumerate(active, start=1)],
            *[
                (identifier, rank)
                for rank, identifier in enumerate(reserve, start=ACTIVE_SEED_LIMIT + 1)
            ],
        ]
    else:
        selected = payload.get("selected")
        if not isinstance(selected, list):
            raise ValueError("AI seed response must contain active and reserve arrays")
        ranked_ids = [(identifier, rank) for rank, identifier in enumerate(selected, start=1)]

    seen: set[str] = set()
    decisions: list[SeedDecision] = []
    for identifier, expected_rank in ranked_ids:
        if not isinstance(identifier, str):
            raise ValueError("seed id must be a string")
        if identifier not in expected:
            raise ValueError("AI seed response contains an invalid id")
        if identifier in seen:
            continue
        seen.add(identifier)
        decisions.append(
            SeedDecision(
                candidate=expected[identifier],
                selected=True,
                ai_rank=expected_rank,
                business_topic=None,
                reason_code=None,
                reason="",
            )
        )

    for identifier, candidate in expected.items():
        if identifier in seen:
            continue
        decisions.append(
            SeedDecision(
                candidate=candidate,
                selected=False,
                ai_rank=None,
                business_topic=None,
                reason_code="ai_not_selected",
                reason="",
            )
        )
    active_count = sum(
        decision.selected and decision.ai_rank is not None and decision.ai_rank <= ACTIVE_SEED_LIMIT
        for decision in decisions
    )
    selected_count = sum(decision.selected for decision in decisions)
    if selected_count >= ACTIVE_SEED_LIMIT and active_count < ACTIVE_SEED_LIMIT:
        raise ValueError("AI left active seed slots empty despite having enough reserve seeds")
    if not any(decision.selected for decision in decisions):
        raise ValueError("AI did not select any usable seed")
    return decisions


def merge_and_limit_candidates(
    rows: list[RawKeyword],
    profile: dict[str, Any],
    language: str,
    *,
    limit: int = ROUND_KEYWORD_LIMIT,
    existing_normalized: set[str] | None = None,
    excluded_normalized: dict[str, str] | None = None,
) -> tuple[list[MergedCandidate], list[MergedCandidate]]:
    limit = max(0, min(limit, ROUND_KEYWORD_LIMIT))
    existing = existing_normalized or set()
    excluded_by_keyword = excluded_normalized or {}
    grouped: dict[str, list[RawKeyword]] = defaultdict(list)
    display_by_normalized: dict[str, str] = {}
    exclusion_terms = profile.get("exclusion_terms") or []
    for row in rows:
        normalized = normalize_keyword(row.keyword)
        if not normalized:
            continue
        grouped[normalized].append(row)
        current_display = display_by_normalized.get(normalized)
        candidate_display = display_keyword(row.keyword)
        if current_display is None or len(candidate_display) < len(current_display):
            display_by_normalized[normalized] = candidate_display

    dictionaries = business_dictionaries(profile)
    candidates: list[MergedCandidate] = []
    rejected: list[MergedCandidate] = []
    for normalized, grouped_rows in grouped.items():
        display = display_by_normalized[normalized]
        reason = hard_exclusion_reason(display, language, exclusion_terms)
        lexical_relevance = (
            business_match_score(
                display,
                dictionaries,
                language,
            )
            / 40.0
        )
        inherited_relevance = max(
            (row.ai_relevance for row in grouped_rows if row.ai_relevance is not None),
            default=0.0,
        )
        source_relevance = 0.75 if any(row.source == "seed" for row in grouped_rows) else 0
        relation_relevance = 0.55 if any(row.source_seed_id for row in grouped_rows) else 0
        relevance = min(
            1.0,
            max(
                lexical_relevance,
                inherited_relevance,
                source_relevance,
                relation_relevance,
            ),
        )
        candidate = MergedCandidate(
            keyword=display,
            normalized_keyword=normalized,
            rows=grouped_rows,
            relevance=relevance,
            exclusion_reason=reason,
        )
        if normalized in existing:
            candidate.exclusion_reason = "already_in_library"
            rejected.append(candidate)
        elif normalized in excluded_by_keyword:
            candidate.exclusion_reason = excluded_by_keyword[normalized]
            rejected.append(candidate)
        elif reason:
            rejected.append(candidate)
        else:
            candidates.append(candidate)

    selected = sorted(candidates, key=candidate_sort_key)[:limit]
    for candidate in selected:
        candidate.included = True
    for candidate in sorted(candidates, key=candidate_sort_key)[limit:]:
        candidate.exclusion_reason = "round_limit"
        rejected.append(candidate)
    return selected, rejected


def validate_keyword_classifications(
    candidates: list[MergedCandidate],
    payload: dict[str, Any],
    seeds: list[dict[str, Any]],
) -> list[KeywordClassification]:
    values = payload.get("items")
    if not isinstance(values, list):
        raise ValueError("AI classification response must contain an items array")
    expected = {f"q{index:03d}": candidate for index, candidate in enumerate(candidates, 1)}
    valid_seed_ids = {str(seed["id"]) for seed in seeds}
    seen: set[str] = set()
    result: list[KeywordClassification] = []
    for raw in values:
        if not isinstance(raw, dict):
            raise ValueError("AI classification entry must be an object")
        identifier = raw.get("id")
        if identifier not in expected or identifier in seen:
            raise ValueError("AI classification contains an invalid or duplicate id")
        relevant = raw.get("relevant")
        if not isinstance(relevant, bool):
            raise ValueError("AI classification relevant must be a boolean")
        confidence = clamp_relevance(raw.get("confidence"))
        if confidence is None:
            raise ValueError("AI classification confidence must be between zero and one")
        review_status = str(raw.get("review_status") or "")
        if review_status not in {"approved", "needs_review"}:
            raise ValueError("AI classification review_status is invalid")
        primary_seed_id = clean_optional_text(raw.get("primary_seed_id"))
        if primary_seed_id not in valid_seed_ids:
            primary_seed_id = None
        related_raw = raw.get("related_seed_ids")
        related_seed_ids = (
            [
                str(value)
                for value in related_raw
                if str(value) in valid_seed_ids and str(value) != primary_seed_id
            ][:4]
            if isinstance(related_raw, list)
            else []
        )
        seen.add(str(identifier))
        result.append(
            KeywordClassification(
                candidate=expected[str(identifier)],
                relevant=relevant,
                business_topic=clean_optional_text(raw.get("business_topic")),
                confidence=confidence,
                review_status=review_status,
                reason=clean_optional_text(raw.get("reason")) or "",
                primary_seed_id=primary_seed_id,
                related_seed_ids=list(dict.fromkeys(related_seed_ids)),
            )
        )
    if seen != set(expected):
        raise ValueError("AI classification omitted one or more keyword ids")
    return result


def classify_candidate(
    candidate: MergedCandidate,
    seeds: list[dict[str, Any]],
    language: str,
) -> tuple[str | None, list[tuple[str, float, str]]]:
    if not seeds:
        return None, []
    direct_ids = {row.source_seed_id for row in candidate.rows if row.source_seed_id is not None}
    scores: list[tuple[str, float, str]] = []
    candidate_tokens = set(tokenize(candidate.keyword, language))
    for seed in seeds:
        seed_id = str(seed["id"])
        if seed_id in direct_ids:
            score = 1.0
            basis = "source"
        else:
            seed_tokens = set(tokenize(str(seed["keyword"]), language))
            overlap = (
                len(candidate_tokens & seed_tokens) / len(candidate_tokens | seed_tokens)
                if candidate_tokens and seed_tokens
                else 0.0
            )
            sequence = SequenceMatcher(
                None,
                candidate.normalized_keyword,
                normalize_keyword(str(seed["keyword"])),
            ).ratio()
            score = max(overlap, sequence * 0.8)
            basis = "semantic"
        scores.append((seed_id, round(score, 4), basis))
    scores.sort(
        key=lambda item: (
            -item[1],
            next(
                (int(seed.get("ai_rank") or 10**9) for seed in seeds if str(seed["id"]) == item[0]),
                10**9,
            ),
            item[0],
        )
    )
    primary = scores[0][0] if scores[0][1] >= 0.2 else None
    related = [
        item for item in scores if item[0] != primary and item[1] >= max(0.35, scores[0][1] * 0.75)
    ][:4]
    if primary is not None:
        related.insert(0, scores[0])
    return primary, related


def priority_score(
    candidate: MergedCandidate,
    metric: dict[str, Any] | None,
    profile: dict[str, Any],
    language: str,
    volume_percentile: float | None,
) -> tuple[float, float, dict[str, Any]]:
    values: dict[str, float | None] = {
        "business_relevance": candidate.relevance * 100,
        "search_volume": volume_percentile,
        "difficulty": (
            100 - float(metric["keyword_difficulty"])
            if metric and metric.get("keyword_difficulty") is not None
            else None
        ),
        "intent": intent_score(metric.get("intent") if metric else None),
        "content_gap": content_gap_score(candidate.keyword, profile, language),
    }
    weights = {
        "business_relevance": 35.0,
        "search_volume": 25.0,
        "difficulty": 20.0,
        "intent": 10.0,
        "content_gap": 10.0,
    }
    available_weight = sum(weights[key] for key, value in values.items() if value is not None)
    if available_weight <= 0:
        return (
            0.0,
            0.0,
            {
                "rule_version": PRIORITY_RULE_VERSION,
                "values": values,
            },
        )
    score = (
        sum(float(value) * weights[key] for key, value in values.items() if value is not None)
        / available_weight
    )
    confidence = available_weight / 100.0
    return (
        round(score, 2),
        round(confidence, 2),
        {
            "rule_version": PRIORITY_RULE_VERSION,
            "values": values,
            "available_weight": available_weight,
        },
    )


def volume_percentiles(metrics: dict[str, dict[str, Any]]) -> dict[str, float | None]:
    values = sorted(
        {
            int(metric["search_volume"])
            for metric in metrics.values()
            if metric.get("search_volume") is not None
        }
    )
    if not values:
        return {key: None for key in metrics}
    return {
        key: (
            percentile_rank(int(metric["search_volume"]), values) * 100
            if metric.get("search_volume") is not None
            else None
        )
        for key, metric in metrics.items()
    }


def business_dictionaries(profile: dict[str, Any]) -> list[tuple[float, list[str]]]:
    key_pages = profile.get("key_pages") or []
    key_page_phrases: list[str] = []
    for page in key_pages:
        if isinstance(page, dict):
            key_page_phrases.extend(str(page.get(key) or "") for key in ("title", "description"))
    return [
        (16.0, string_list(profile.get("products_services"))),
        (
            8.0,
            string_list([profile.get("business_type"), profile.get("business_summary")]),
        ),
        (
            8.0,
            string_list(profile.get("use_cases"))
            + string_list(profile.get("content_topics"))
            + string_list(key_page_phrases),
        ),
        (
            8.0,
            string_list(profile.get("target_audiences"))
            + string_list(profile.get("value_propositions"))
            + string_list(profile.get("conversion_actions")),
        ),
    ]


def business_match_score(
    keyword: str,
    dictionaries: list[tuple[float, list[str]]],
    language: str,
) -> float:
    normalized_keyword = normalize_keyword(keyword)
    keyword_tokens = set(tokenize(keyword, language))
    total = 0.0
    for weight, phrases in dictionaries:
        best = 0.0
        for phrase in phrases:
            normalized_phrase = normalize_keyword(phrase)
            if not normalized_phrase:
                continue
            if normalized_keyword == normalized_phrase:
                best = max(best, 1.0)
                continue
            if normalized_phrase in normalized_keyword or normalized_keyword in normalized_phrase:
                best = max(best, 0.8)
                continue
            phrase_tokens = set(tokenize(phrase, language))
            if keyword_tokens and phrase_tokens:
                overlap = len(keyword_tokens & phrase_tokens) / min(
                    len(keyword_tokens),
                    len(phrase_tokens),
                )
                if overlap >= 0.6:
                    best = max(best, 0.6)
        total += weight * best
    return min(total, 40.0)


def strong_seed_business_evidence(
    candidate: SeedCandidate,
    profile: dict[str, Any],
    language: str,
) -> bool:
    """Conservative fallback used only when the semantic admission response is unusable."""
    allowed_brands = profile_brand_names(profile, None)
    if excluded_brand_name(candidate.raw, allowed_brands):
        return False

    normalized_keyword = candidate.normalized_keyword
    if any(brand and brand in normalized_keyword for brand in allowed_brands):
        return True
    if normalize_keyword(str(candidate.raw.intent or "")) == "navigational":
        return False

    keyword_tokens = {
        token
        for token in tokenize(candidate.keyword, language)
        if token not in ENGLISH_VARIANT_FILLERS
    }
    if "free" in keyword_tokens and "trial" not in keyword_tokens:
        explicit_offerings = string_list(profile.get("products_services")) + string_list(
            profile.get("value_propositions")
        )
        if not any("free" in set(tokenize(phrase, language)) for phrase in explicit_offerings):
            return False

    evidence_phrases = (
        string_list(profile.get("products_services"))
        + string_list(profile.get("value_propositions"))
        + string_list(profile.get("target_audiences"))
        + string_list(profile.get("use_cases"))
        + string_list(profile.get("content_topics"))
        + string_list([profile.get("business_type"), profile.get("business_summary")])
    )
    raw_evidence = profile.get("evidence")
    if isinstance(raw_evidence, list):
        for item in raw_evidence:
            if not isinstance(item, dict):
                continue
            evidence_phrases.extend(string_list([item.get("value"), item.get("quote")]))

    all_evidence_tokens: set[str] = set()
    for phrase in evidence_phrases:
        normalized_phrase = normalize_keyword(phrase)
        phrase_tokens = {
            token for token in tokenize(phrase, language) if token not in ENGLISH_VARIANT_FILLERS
        }
        if not normalized_phrase or not phrase_tokens:
            continue
        all_evidence_tokens.update(phrase_tokens)
        if normalized_keyword == normalized_phrase:
            return True
        if len(keyword_tokens) >= 2 and normalized_keyword in normalized_phrase:
            return True
        if len(phrase_tokens) >= 2 and normalized_phrase in normalized_keyword:
            return True
        shared = keyword_tokens & phrase_tokens
        if (
            len(shared) >= 2
            and len(shared) / len(keyword_tokens) >= 2 / 3
            and len(shared) / len(phrase_tokens) >= 0.5
        ):
            return True
    if len(keyword_tokens) >= 2 and len(keyword_tokens & all_evidence_tokens) == len(
        keyword_tokens
    ):
        return True
    return False


def percentile_rank(value: float, sorted_values: list[float | int]) -> float:
    if len(sorted_values) <= 1:
        return 1.0
    less_or_equal = sum(float(item) <= value for item in sorted_values)
    return (less_or_equal - 1) / (len(sorted_values) - 1)


def raw_completeness(idea: RawKeyword) -> tuple[int, int]:
    known = sum(
        value is not None
        for value in (
            idea.search_volume,
            idea.cpc,
            idea.competition,
            idea.keyword_difficulty,
            idea.intent,
        )
    ) + int(bool(idea.monthly_searches))
    rank = -(idea.provider_rank if idea.provider_rank > 0 else 10**9)
    return known, rank


def merge_exact_duplicate_keywords(left: RawKeyword, right: RawKeyword) -> RawKeyword:
    preferred, fallback = (
        (right, left) if raw_completeness(right) > raw_completeness(left) else (left, right)
    )

    def present(primary: Any, secondary: Any) -> Any:
        return primary if primary is not None else secondary

    raw_payload = {**fallback.raw_payload, **preferred.raw_payload}
    concepts: list[dict[str, Any]] = []
    seen_concepts: set[tuple[str, str, str]] = set()
    for idea in (preferred, fallback):
        for concept in keyword_annotation_concepts(idea):
            group = concept.get("concept_group")
            group = group if isinstance(group, dict) else {}
            concept_key = (
                normalize_keyword(str(concept.get("name") or "")),
                normalize_keyword(str(group.get("name") or "")),
                normalize_keyword(str(group.get("type") or "")),
            )
            if concept_key in seen_concepts:
                continue
            seen_concepts.add(concept_key)
            concepts.append(concept)
    if concepts:
        annotations: dict[str, Any] = {}
        for idea in (fallback, preferred):
            value = idea.raw_payload.get("keyword_annotations")
            if isinstance(value, dict):
                annotations.update(value)
        annotations["concepts"] = concepts
        raw_payload["keyword_annotations"] = annotations

    return RawKeyword(
        keyword=preferred.keyword,
        source=preferred.source,
        provider_rank=preferred.provider_rank,
        source_seed_id=preferred.source_seed_id,
        source_seed_rank=preferred.source_seed_rank,
        search_volume=present(preferred.search_volume, fallback.search_volume),
        cpc=present(preferred.cpc, fallback.cpc),
        competition=present(preferred.competition, fallback.competition),
        keyword_difficulty=present(
            preferred.keyword_difficulty,
            fallback.keyword_difficulty,
        ),
        intent=present(preferred.intent, fallback.intent),
        monthly_searches=preferred.monthly_searches or fallback.monthly_searches,
        raw_payload=raw_payload,
        ai_relevance=present(preferred.ai_relevance, fallback.ai_relevance),
    )


def candidate_sort_key(candidate: MergedCandidate) -> tuple[Any, ...]:
    return (
        -int(len(candidate.sources) > 1),
        -candidate.relevance,
        candidate.best_seed_rank,
        candidate.best_source_rank,
        candidate.normalized_keyword,
    )


def intent_score(intent: str | None) -> float | None:
    if intent is None:
        return None
    normalized = normalize_keyword(intent)
    mapping = {
        "transactional": 100.0,
        "transaction": 100.0,
        "commercial": 85.0,
        "informational": 60.0,
        "information": 60.0,
        "navigational": 40.0,
        "navigation": 40.0,
    }
    return mapping.get(normalized)


def content_gap_score(
    keyword: str,
    profile: dict[str, Any],
    language: str,
) -> float | None:
    pages = profile.get("key_pages")
    if not isinstance(pages, list) or not pages:
        return None
    keyword_tokens = set(tokenize(keyword, language))
    if not keyword_tokens:
        return None
    best = 0.0
    for page in pages:
        if not isinstance(page, dict):
            continue
        text = " ".join(str(page.get(field) or "") for field in ("title", "description"))
        page_tokens = set(tokenize(text, language))
        if not page_tokens:
            continue
        overlap = len(keyword_tokens & page_tokens) / len(keyword_tokens)
        best = max(best, overlap)
    return round((1 - min(best, 1.0)) * 100, 2)


def string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return []


def clean_optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.strip().split())
    return cleaned[:1000] if cleaned else None


def clamp_relevance(value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if math.isnan(float(value)) or math.isinf(float(value)):
        return None
    return min(max(float(value), 0.0), 1.0)
