from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from typing import Any, Literal, Sequence


SeedAction = Literal["keep", "drop"]
Relevance = Literal["same_topic", "unrelated"]
KeywordType = Literal["informational", "service", "product", "unknown"]
PrimaryFit = Literal["strong", "acceptable", "ineligible"]
CoverageStatus = Literal["covered", "uncovered", "unknown"]

ALLOWED_REASON_CODES = {
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
}


def normalize_keyword(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


@dataclass(frozen=True)
class SeedCandidate:
    candidate_id: str
    keyword: str
    source_rank: int


@dataclass(frozen=True)
class ResolvedSeedDecision:
    candidate_id: str
    action: SeedAction
    representative_candidate_id: str | None
    reason: str | None = None


def resolve_seed_decisions(
    candidates: Sequence[SeedCandidate],
    *,
    retained: Sequence[SeedCandidate],
    decisions: Sequence[dict[str, Any]],
) -> list[ResolvedSeedDecision]:
    candidate_ids = [item.candidate_id for item in candidates]
    retained_ids = {item.candidate_id for item in retained}
    decision_ids = [str(item.get("keyword_id", "")) for item in decisions]
    if len(set(decision_ids)) != len(decision_ids) or set(decision_ids) != set(candidate_ids):
        raise ValueError("seed_decision_contract_invalid: ids")

    all_candidates = {item.candidate_id: item for item in [*retained, *candidates]}
    parent = {candidate_id: candidate_id for candidate_id in all_candidates}

    def find(candidate_id: str) -> str:
        while parent[candidate_id] != candidate_id:
            parent[candidate_id] = parent[parent[candidate_id]]
            candidate_id = parent[candidate_id]
        return candidate_id

    def union(left: str, right: str) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    decisions_by_id: dict[str, dict[str, Any]] = {}
    for value in decisions:
        candidate_id = str(value.get("keyword_id", ""))
        action = value.get("action")
        reference = value.get("same_topic_as")
        if action not in ("keep", "drop"):
            raise ValueError("seed_decision_contract_invalid: action")
        if action == "keep" and reference is not None:
            raise ValueError("seed_decision_contract_invalid: kept reference")
        if action == "drop":
            if reference is None:
                decisions_by_id[candidate_id] = dict(value)
                continue
            if reference not in all_candidates or reference == candidate_id:
                raise ValueError("seed_decision_contract_invalid: reference")
            union(candidate_id, str(reference))
        decisions_by_id[candidate_id] = dict(value)

    members_by_root: dict[str, list[SeedCandidate]] = {}
    for candidate in all_candidates.values():
        members_by_root.setdefault(find(candidate.candidate_id), []).append(candidate)
    representative_by_id: dict[str, str] = {}
    for members in members_by_root.values():
        representative = min(members, key=lambda item: item.source_rank).candidate_id
        for member in members:
            representative_by_id[member.candidate_id] = representative

    resolved = []
    for candidate in candidates:
        value = decisions_by_id[candidate.candidate_id]
        if value["action"] == "drop" and value.get("same_topic_as") is None:
            resolved.append(
                ResolvedSeedDecision(
                    candidate_id=candidate.candidate_id,
                    action="drop",
                    representative_candidate_id=None,
                    reason=str(value.get("reason")) if value.get("reason") else None,
                )
            )
            continue
        representative = representative_by_id[candidate.candidate_id]
        keep = representative == candidate.candidate_id and representative not in retained_ids
        resolved.append(
            ResolvedSeedDecision(
                candidate_id=candidate.candidate_id,
                action="keep" if keep else "drop",
                representative_candidate_id=None if keep else representative,
                reason=str(value.get("reason")) if value.get("reason") else None,
            )
        )
    return resolved


@dataclass(frozen=True)
class CandidateClassification:
    candidate_id: str
    keyword: str
    source: Literal["seed", "related", "ai", "user"]
    search_volume: int | None = None
    provider_position: int | None = None
    keyword_difficulty: int | None = None
    provider_intent: str | None = None
    raw_item: dict[str, Any] = field(default_factory=dict)

    @property
    def normalized_keyword(self) -> str:
        return normalize_keyword(self.keyword)


@dataclass(frozen=True)
class ClassificationDecision:
    candidate_id: str
    relevance: Relevance
    keyword_type: KeywordType
    primary_fit: PrimaryFit
    secondary_candidate_ids: tuple[str, ...]
    reason_code: str


@dataclass(frozen=True)
class KeywordPackageResult:
    status: Literal["pack_ready", "invalid", "coverage_check_failed"]
    primary_candidate_id: str | None = None
    secondary_candidate_ids: tuple[str, ...] = ()
    exclusion_reasons: dict[str, str] = field(default_factory=dict)
    error_code: str | None = None


def deduplicate_keyword_candidates(
    candidates: Sequence[CandidateClassification],
) -> list[CandidateClassification]:
    seen: set[str] = set()
    result = []
    for candidate in candidates:
        normalized = candidate.normalized_keyword
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(candidate)
    return result


def validate_classification_decisions(
    candidates: Sequence[CandidateClassification],
    decisions: Sequence[ClassificationDecision],
) -> dict[str, ClassificationDecision]:
    candidate_ids = {item.candidate_id for item in candidates}
    decision_ids = [item.candidate_id for item in decisions]
    if len(set(decision_ids)) != len(decision_ids) or set(decision_ids) != candidate_ids:
        raise ValueError("classification_contract_invalid: ids")
    decisions_by_id = {item.candidate_id: item for item in decisions}
    for decision in decisions:
        if decision.relevance not in ("same_topic", "unrelated"):
            raise ValueError("classification_contract_invalid: relevance")
        if decision.keyword_type not in ("informational", "service", "product", "unknown"):
            raise ValueError("classification_contract_invalid: keyword_type")
        if decision.primary_fit not in ("strong", "acceptable", "ineligible"):
            raise ValueError("classification_contract_invalid: primary_fit")
        if decision.keyword_type != "informational" and decision.primary_fit != "ineligible":
            raise ValueError("classification_contract_invalid: non-informational primary")
        if decision.reason_code not in ALLOWED_REASON_CODES:
            raise ValueError("classification_contract_invalid: reason_code")
        secondary_ids = decision.secondary_candidate_ids
        if len(set(secondary_ids)) != len(secondary_ids):
            raise ValueError("classification_contract_invalid: duplicate secondary")
        if decision.candidate_id in secondary_ids or not set(secondary_ids) <= candidate_ids:
            raise ValueError("classification_contract_invalid: secondary reference")
    for decision in decisions:
        if any(
            decisions_by_id[candidate_id].relevance != "same_topic"
            for candidate_id in decision.secondary_candidate_ids
        ):
            raise ValueError("classification_contract_invalid: unrelated secondary")
    return decisions_by_id


def build_keyword_package(
    candidates: Sequence[CandidateClassification],
    decisions: Sequence[ClassificationDecision],
    *,
    coverage_by_candidate: dict[str, CoverageStatus],
    occupied_normalized_keywords: set[str],
) -> KeywordPackageResult:
    candidates = deduplicate_keyword_candidates(candidates)
    decisions_by_id = validate_classification_decisions(candidates, decisions)
    candidates_by_id = {item.candidate_id: item for item in candidates}

    def eligible_secondary_count(candidate_id: str) -> int:
        return sum(
            secondary_id in candidates_by_id
            and decisions_by_id[secondary_id].relevance == "same_topic"
            for secondary_id in decisions_by_id[candidate_id].secondary_candidate_ids
        )

    def primary_sort_key(candidate: CandidateClassification) -> tuple[Any, ...]:
        decision = decisions_by_id[candidate.candidate_id]
        return (
            0 if decision.primary_fit == "strong" else 1,
            -eligible_secondary_count(candidate.candidate_id),
            -(candidate.search_volume if candidate.search_volume is not None else -1),
            candidate.provider_position if candidate.provider_position is not None else 2**31,
            candidate.normalized_keyword,
        )

    primary_candidates = sorted(
        (
            candidate
            for candidate in candidates
            if decisions_by_id[candidate.candidate_id].relevance == "same_topic"
            and decisions_by_id[candidate.candidate_id].keyword_type == "informational"
            and decisions_by_id[candidate.candidate_id].primary_fit in ("strong", "acceptable")
        ),
        key=primary_sort_key,
    )
    saw_unknown = False
    primary: CandidateClassification | None = None
    for candidate in primary_candidates:
        if candidate.normalized_keyword in occupied_normalized_keywords:
            continue
        coverage = coverage_by_candidate.get(candidate.candidate_id, "unknown")
        if coverage == "uncovered":
            primary = candidate
            break
        if coverage == "unknown":
            saw_unknown = True
    if primary is None:
        if saw_unknown:
            return KeywordPackageResult(
                status="coverage_check_failed",
                error_code="coverage_check_failed",
            )
        return KeywordPackageResult(
            status="invalid",
            error_code="primary_keyword_unavailable",
        )

    primary_decision = decisions_by_id[primary.candidate_id]
    secondary_candidates = [
        candidates_by_id[candidate_id]
        for candidate_id in primary_decision.secondary_candidate_ids
        if candidate_id in candidates_by_id and candidate_id != primary.candidate_id
    ]
    secondary_candidates.sort(
        key=lambda candidate: (
            0
            if decisions_by_id[candidate.candidate_id].keyword_type == "informational"
            else 1,
            -(candidate.search_volume if candidate.search_volume is not None else -1),
            candidate.provider_position if candidate.provider_position is not None else 2**31,
            candidate.normalized_keyword,
        )
    )
    selected_secondaries = secondary_candidates[:5]
    selected_ids = {item.candidate_id for item in selected_secondaries}
    qualified_ids = {item.candidate_id for item in secondary_candidates}
    exclusion_reasons: dict[str, str] = {}
    for candidate in candidates:
        candidate_id = candidate.candidate_id
        if candidate_id == primary.candidate_id or candidate_id in selected_ids:
            continue
        exclusion_reasons[candidate_id] = (
            "qualified_not_selected"
            if candidate_id in qualified_ids
            else decisions_by_id[candidate_id].reason_code
        )
    return KeywordPackageResult(
        status="pack_ready",
        primary_candidate_id=primary.candidate_id,
        secondary_candidate_ids=tuple(item.candidate_id for item in selected_secondaries),
        exclusion_reasons=exclusion_reasons,
    )
