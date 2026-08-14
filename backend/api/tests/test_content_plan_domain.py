import pytest

from app.modules.content_plan.domain import (
    CandidateClassification,
    ClassificationDecision,
    SeedCandidate,
    build_keyword_package,
    deduplicate_keyword_candidates,
    normalize_keyword,
    resolve_seed_decisions,
    validate_classification_decisions,
)


def test_normalize_keyword_uses_the_documented_nfkc_whitespace_and_casefold_rules() -> None:
    assert normalize_keyword("  Ｃar\tDETAILING  Cost!  ") == "car detailing cost!"


def test_seed_decisions_are_complete_and_keep_the_highest_priority_member() -> None:
    candidates = [
        SeedCandidate("c-1", "car detailing cost", 1),
        SeedCandidate("c-2", "average detailing price", 2),
        SeedCandidate("c-3", "car detailing vs wash", 3),
    ]

    resolved = resolve_seed_decisions(
        candidates,
        retained=[],
        decisions=[
            {"keyword_id": "c-3", "action": "keep", "same_topic_as": None},
            {"keyword_id": "c-2", "action": "drop", "same_topic_as": "c-1"},
            {"keyword_id": "c-1", "action": "keep", "same_topic_as": None},
        ],
    )

    assert [item.candidate_id for item in resolved] == ["c-1", "c-2", "c-3"]
    assert [item.action for item in resolved] == ["keep", "drop", "keep"]
    assert resolved[1].representative_candidate_id == "c-1"


def test_seed_decisions_cannot_delete_or_reorder_retained_seeds() -> None:
    retained = [SeedCandidate("kept-1", "car detailing cost", 1)]
    candidates = [SeedCandidate("new-1", "detailing price", 51)]

    resolved = resolve_seed_decisions(
        candidates,
        retained=retained,
        decisions=[
            {"keyword_id": "new-1", "action": "drop", "same_topic_as": "kept-1"}
        ],
    )

    assert resolved[0].representative_candidate_id == "kept-1"


def test_seed_decisions_allow_direct_drop_without_a_representative() -> None:
    candidates = [
        SeedCandidate("c-1", "movie apps", 1),
        SeedCandidate("c-2", "unrelated brand navigation", 2),
    ]

    resolved = resolve_seed_decisions(
        candidates,
        retained=[],
        decisions=[
            {"keyword_id": "c-1", "action": "keep", "same_topic_as": None},
            {"keyword_id": "c-2", "action": "drop", "same_topic_as": None},
        ],
    )

    assert resolved[0].action == "keep"
    assert resolved[1].action == "drop"
    assert resolved[1].representative_candidate_id is None


@pytest.mark.parametrize(
    "decisions",
    [
        [{"keyword_id": "c-1", "action": "keep", "same_topic_as": None}],
        [
            {"keyword_id": "c-1", "action": "keep", "same_topic_as": None},
            {"keyword_id": "invented", "action": "keep", "same_topic_as": None},
        ],
        [
            {"keyword_id": "c-1", "action": "keep", "same_topic_as": None},
            {"keyword_id": "c-2", "action": "drop", "same_topic_as": "missing"},
        ],
    ],
)
def test_seed_decisions_reject_missing_added_or_invalid_references(decisions) -> None:
    candidates = [
        SeedCandidate("c-1", "one", 1),
        SeedCandidate("c-2", "two", 2),
    ]

    with pytest.raises(ValueError, match="seed_decision_contract_invalid"):
        resolve_seed_decisions(candidates, retained=[], decisions=decisions)


def _candidate(
    candidate_id: str,
    keyword: str,
    *,
    search_volume: int | None = None,
    provider_position: int | None = None,
) -> CandidateClassification:
    return CandidateClassification(
        candidate_id=candidate_id,
        keyword=keyword,
        source="related",
        search_volume=search_volume,
        provider_position=provider_position,
    )


def _decision(
    candidate_id: str,
    *,
    keyword_type: str = "informational",
    primary_fit: str = "strong",
    secondary_ids: tuple[str, ...] = (),
) -> ClassificationDecision:
    return ClassificationDecision(
        candidate_id=candidate_id,
        relevance="same_topic",
        keyword_type=keyword_type,
        primary_fit=primary_fit,
        secondary_candidate_ids=secondary_ids,
        reason_code="answers_cost_question",
    )


def test_classification_contract_requires_each_id_once_and_valid_relations() -> None:
    candidates = [_candidate("q-1", "cost"), _candidate("q-2", "price")]

    with pytest.raises(ValueError, match="classification_contract_invalid"):
        validate_classification_decisions(candidates, [_decision("q-1")])

    with pytest.raises(ValueError, match="classification_contract_invalid"):
        validate_classification_decisions(
            candidates,
            [
                _decision("q-1", secondary_ids=("q-2", "q-2")),
                _decision("q-2"),
            ],
        )


def test_non_informational_candidate_must_be_ineligible_for_primary() -> None:
    candidates = [_candidate("q-1", "buy polish")]
    decision = ClassificationDecision(
        candidate_id="q-1",
        relevance="same_topic",
        keyword_type="product",
        primary_fit="strong",
        secondary_candidate_ids=(),
        reason_code="product_transactional",
    )

    with pytest.raises(ValueError, match="classification_contract_invalid"):
        validate_classification_decisions(candidates, [decision])


def test_exact_normalized_duplicates_keep_the_first_provider_row() -> None:
    candidates = [
        _candidate("q-1", "  Car  Cost ", search_volume=10, provider_position=3),
        _candidate("q-2", "car cost", search_volume=100, provider_position=1),
    ]

    assert [item.candidate_id for item in deduplicate_keyword_candidates(candidates)] == [
        "q-1"
    ]


def test_primary_and_secondary_selection_are_deterministic_and_bounded() -> None:
    candidates = [
        _candidate("p-low", "zeta cost", search_volume=900, provider_position=1),
        _candidate("p-best", "alpha cost", search_volume=200, provider_position=4),
        *[
            _candidate(
                f"s-{index}",
                f"detail {index}",
                search_volume=1000 - index,
                provider_position=index,
            )
            for index in range(1, 8)
        ],
    ]
    decisions = [
        _decision("p-low", secondary_ids=("s-1",)),
        _decision("p-best", secondary_ids=tuple(f"s-{index}" for index in range(1, 8))),
        *[_decision(f"s-{index}", primary_fit="ineligible") for index in range(1, 8)],
    ]

    result = build_keyword_package(
        candidates,
        decisions,
        coverage_by_candidate={item.candidate_id: "uncovered" for item in candidates},
        occupied_normalized_keywords=set(),
    )

    assert result.status == "pack_ready"
    assert result.primary_candidate_id == "p-best"
    assert result.secondary_candidate_ids == ("s-1", "s-2", "s-3", "s-4", "s-5")
    assert result.exclusion_reasons["s-6"] == "qualified_not_selected"
    assert result.exclusion_reasons["s-7"] == "qualified_not_selected"


def test_covered_primary_falls_through_but_unknown_never_means_uncovered() -> None:
    candidates = [
        _candidate("p-1", "first", search_volume=100),
        _candidate("p-2", "second", search_volume=90),
    ]
    decisions = [_decision("p-1"), _decision("p-2")]

    selected = build_keyword_package(
        candidates,
        decisions,
        coverage_by_candidate={"p-1": "covered", "p-2": "uncovered"},
        occupied_normalized_keywords=set(),
    )
    blocked = build_keyword_package(
        candidates,
        decisions,
        coverage_by_candidate={"p-1": "covered", "p-2": "unknown"},
        occupied_normalized_keywords=set(),
    )

    assert selected.primary_candidate_id == "p-2"
    assert blocked.status == "coverage_check_failed"
    assert blocked.primary_candidate_id is None


def test_all_explicitly_covered_or_occupied_candidates_make_the_group_invalid() -> None:
    candidates = [_candidate("p-1", "first"), _candidate("p-2", "second")]

    result = build_keyword_package(
        candidates,
        [_decision("p-1"), _decision("p-2")],
        coverage_by_candidate={"p-1": "covered", "p-2": "uncovered"},
        occupied_normalized_keywords={"second"},
    )

    assert result.status == "invalid"
    assert result.error_code == "primary_keyword_unavailable"
