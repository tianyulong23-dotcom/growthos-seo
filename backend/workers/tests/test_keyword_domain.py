import pytest

from seo_workers.keywords.domain import (
    InitialLibraryAssessment,
    MergedCandidate,
    RawKeyword,
    SeedCandidate,
    SeedPoolGroup,
    TopicDuplicateGroup,
    TopicDuplicatePair,
    build_equal_volume_variant_pairs,
    build_initial_library_topics,
    build_topic_duplicate_pairs,
    build_topic_seed_decisions,
    classify_candidate,
    infer_business_model,
    merge_and_limit_candidates,
    prepare_seed_candidates,
    repair_seed_topic_representatives,
    priority_score,
    resolve_bounded_topic_seed_selection,
    resolve_topic_seed_selection,
    validate_active_seed_selection,
    validate_diverse_seed_pool,
    validate_grouped_active_seed_selection,
    validate_initial_library_filter,
    validate_seed_decisions,
    validate_seed_topic_clusters,
    validate_seed_topic_representatives,
    validate_valid_seed_candidates,
)

PROFILE = {
    "business_type": "solar installer",
    "business_summary": "The company installs residential solar energy systems.",
    "products_services": ["solar panel installation", "home battery installation"],
    "target_audiences": ["homeowners"],
    "content_topics": ["solar energy", "electricity savings"],
}


def test_initial_library_filter_trusts_binary_usability_decisions() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="first candidate", source="labs_site"),
            RawKeyword(keyword="second candidate", source="labs_site"),
        ],
        PROFILE,
        "en",
    )

    assessments = validate_initial_library_filter(
        candidates,
        {"decisions": ["keep", "remove_incomplete"]},
        PROFILE,
        "en",
    )

    assert {identifier for identifier, item in assessments.items() if item.approved} == {"k001"}
    assert assessments["k001"].business_relevance == 0.8
    assert assessments["k002"].category == "remove_incomplete"


def test_initial_library_filter_rejects_incomplete_ai_decisions() -> None:
    candidates, _ = prepare_seed_candidates(
        [RawKeyword(keyword="solar panels", source="labs_site", search_volume=1_000)],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError, match="classify every candidate"):
        validate_initial_library_filter(
            candidates,
            {"decisions": []},
            PROFILE,
            "en",
        )


def test_initial_library_filter_does_not_second_guess_kept_ai_categories() -> None:
    profile = {
        "business_type": "Streaming service",
        "products_services": ["Streaming subscriptions", "Live sports streaming"],
        "content_topics": ["7-day free trial"],
    }
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword="free streaming service",
                source="keyword_ideas_close",
                search_volume=100,
            ),
            RawKeyword(
                keyword="free trial streaming service",
                source="keyword_ideas_close",
                search_volume=90,
            ),
        ],
        profile,
        "en",
    )

    assessments = validate_initial_library_filter(
        candidates,
        {"decisions": ["keep", "keep"]},
        profile,
        "en",
    )

    assert assessments["k001"].approved is True
    assert assessments["k001"].category == "keep"
    assert assessments["k002"].approved is True


def test_initial_library_filter_records_explicit_removal_reason() -> None:
    candidates, _ = prepare_seed_candidates(
        [RawKeyword(keyword="possible audience topic", source="labs_site")],
        PROFILE,
        "en",
    )

    assessments = validate_initial_library_filter(
        candidates,
        {"decisions": ["remove_incomplete"]},
        PROFILE,
        "en",
    )

    assert assessments["k001"].approved is False
    assert assessments["k001"].category == "remove_incomplete"
    assert assessments["k001"].business_relevance == 0.0


def test_initial_library_filter_rejects_legacy_non_usability_category() -> None:
    candidates, _ = prepare_seed_candidates(
        [RawKeyword(keyword="clear unrelated query", source="labs_site")],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError, match="invalid decision category"):
        validate_initial_library_filter(
            candidates,
            {"decisions": ["remove_irrelevant"]},
            PROFILE,
            "en",
        )


def test_initial_library_filter_does_not_override_unusable_removal() -> None:
    candidates, _ = prepare_seed_candidates(
        [RawKeyword(keyword="candidate phrase", source="labs_site")],
        PROFILE,
        "en",
    )

    assessments = validate_initial_library_filter(
        candidates,
        {"decisions": ["remove_incomplete"]},
        PROFILE,
        "en",
    )

    assert assessments["k001"].approved is False
    assert assessments["k001"].category == "remove_incomplete"


def test_equal_volume_variants_are_deduplicated_deterministically() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword="car headlight cleaner",
                source="google_ads_site",
                search_volume=1_000,
            ),
            RawKeyword(
                keyword="auto headlight cleaner",
                source="google_ads_site",
                search_volume=1_000,
            ),
            RawKeyword(
                keyword="automotive headlight cleaner",
                source="google_ads_site",
                search_volume=900,
            ),
            RawKeyword(
                keyword="headlight restoration",
                source="google_ads_site",
                search_volume=1_000,
            ),
        ],
        {"business_model": "product"},
        "en",
    )
    assessments = {
        f"k{index:03d}": InitialLibraryAssessment(
            candidate_id=f"k{index:03d}",
            approved=True,
            category="keep",
            business_relevance=0.8,
        )
        for index in range(1, len(candidates) + 1)
    }
    topics = build_initial_library_topics(
        candidates,
        assessments,
        {"business_model": "product"},
    )

    pairs = build_equal_volume_variant_pairs(topics, "en")

    topic_by_id = {str(topic["representative_id"]): topic for topic in topics}
    assert [
        (
            topic_by_id[pair.left_id]["representative_keyword"],
            topic_by_id[pair.right_id]["representative_keyword"],
        )
        for pair in pairs
    ] == [("car headlight cleaner", "auto headlight cleaner")]


@pytest.mark.parametrize(
    ("profile", "expected"),
    [
        ({"business_type": "Car care product brand"}, "product"),
        ({"business_type": "Residential solar installer"}, "service"),
        ({"business_type": "Analytics SaaS product"}, "software"),
        ({"business_type": "Recipe blog and educational resource"}, "content"),
        (
            {
                "business_type": "Solar equipment retailer and installer",
                "business_summary": "Sells panels and provides installation services.",
            },
            "mixed",
        ),
        (
            {
                "business_model": "service",
                "business_type": "Product photography studio",
            },
            "service",
        ),
        (
            {
                "business_model": "service",
                "business_type": "汽车维修服务",
            },
            "service",
        ),
    ],
)
def test_infer_business_model_uses_profile_evidence(
    profile: dict[str, object],
    expected: str,
) -> None:
    assert infer_business_model(profile) == expected


def test_prepare_seed_candidates_reduces_one_thousand_to_three_hundred() -> None:
    ideas = [
        RawKeyword(
            keyword=f"solar installation option {index}",
            source="site_seed",
            provider_rank=index,
            search_volume=1000 - index,
            cpc=float(index),
            competition=0.5,
        )
        for index in range(1, 1001)
    ]

    candidates, excluded = prepare_seed_candidates(
        ideas,
        PROFILE,
        "en",
        limit=300,
    )

    assert len(candidates) == 300
    assert [candidate.rank for candidate in candidates] == list(range(1, 301))
    assert len(excluded) == 700
    assert all(reason == "volume_limit" for reason in excluded.values())
    assert candidates[0].raw.search_volume == 999
    assert candidates[-1].raw.search_volume == 700
    assert all("score" not in candidate.selection_details for candidate in candidates)


def test_prepare_seed_candidates_does_not_prioritize_internal_profile_seeds() -> None:
    ideas = [
        RawKeyword(
            keyword=f"unrelated high volume query {index}",
            source="labs_site",
            provider_rank=index,
            search_volume=10_000 - index,
        )
        for index in range(1, 501)
    ]
    ideas.extend(
        [
            RawKeyword(keyword="streaming subscriptions", source="profile_seed", provider_rank=1),
            RawKeyword(keyword="live sports streaming", source="profile_seed", provider_rank=2),
        ]
    )

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en", limit=500)

    assert len(candidates) == 500
    assert all(candidate.raw.source == "labs_site" for candidate in candidates)
    assert sum(reason == "volume_limit" for reason in excluded.values()) == 2


def test_prepare_seed_candidates_uses_search_volume_without_semantic_preselection() -> None:
    ideas = [
        RawKeyword(
            keyword=f"unrelated high volume query {index}",
            source="labs_site",
            provider_rank=index,
            search_volume=10_000 - index,
        )
        for index in range(1, 501)
    ]
    ideas.extend(
        [
            RawKeyword(
                keyword="solar panel installation cost",
                source="keyword_ideas_broad",
                provider_rank=1,
                search_volume=100,
            ),
            RawKeyword(
                keyword="home battery installation quote",
                source="google_ads_site",
                provider_rank=1,
                search_volume=50,
            ),
        ]
    )

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en", limit=500)

    selected = {candidate.normalized_keyword: candidate for candidate in candidates}
    assert "solar panel installation cost" not in selected
    assert "home battery installation quote" not in selected
    assert all(
        candidate.selection_details["selection_method"] == "search_volume"
        for candidate in candidates
    )
    assert sum(reason == "volume_limit" for reason in excluded.values()) == 2


def test_seed_candidates_remove_only_mechanical_junk_before_ai() -> None:
    long_value = "a" * 201
    ideas = [
        RawKeyword(keyword="car care", source="labs_site", search_volume=100),
        RawKeyword(keyword="https://example.co.uk/path", source="labs_site"),
        RawKeyword(keyword="www.example.com", source="labs_site"),
        RawKeyword(keyword="hello@example.com", source="labs_site"),
        RawKeyword(keyword="<div><br></div>", source="labs_site"),
        RawKeyword(keyword="123456", source="labs_site"),
        RawKeyword(keyword="---", source="labs_site"),
        RawKeyword(keyword="car\x00care", source="labs_site"),
        RawKeyword(keyword="broken\ufffdkeyword", source="labs_site"),
        RawKeyword(keyword=long_value, source="labs_site"),
    ]

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en")

    assert {candidate.keyword for candidate in candidates} == {
        "car care",
        "hello@example.com",
        "<div><br></div>",
        "123456",
        long_value,
    }
    assert excluded == {
        "https://example.co.uk/path": "url_only",
        "www.example.com": "url_only",
        "---": "no_words",
        "car\x00care": "invalid_text",
        "broken\ufffdkeyword": "invalid_text",
    }


def test_seed_candidates_do_not_mistake_domains_numbers_or_long_queries_for_junk() -> None:
    values = [
        "node.js",
        "schema.org",
        "socket.io",
        "example.com",
        "911",
        "2026",
        ("how to choose a product " + ("with detailed requirements " * 10)).strip(),
    ]

    candidates, excluded = prepare_seed_candidates(
        [RawKeyword(keyword=value, source="labs_site") for value in values],
        PROFILE,
        "en",
    )

    assert {candidate.keyword for candidate in candidates} == set(values)
    assert excluded == {}


def test_seed_candidates_merge_only_exact_normalized_duplicates() -> None:
    ideas = [
        RawKeyword(
            keyword=" Car   Care ",
            source="labs_site",
            provider_rank=1,
            search_volume=100,
            cpc=1.25,
            competition=0.4,
        ),
        RawKeyword(
            keyword="car care",
            source="google_ads_site",
            provider_rank=2,
            keyword_difficulty=20,
            intent="commercial",
            monthly_searches=[{"year": 2026, "month": 7, "search_volume": 100}],
        ),
        RawKeyword(
            keyword="car-care",
            source="labs_site",
            search_volume=100,
        ),
    ]

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en")

    assert [candidate.keyword for candidate in candidates] == ["Car Care", "car-care"]
    merged = candidates[0].raw
    assert merged.source == "labs_site"
    assert merged.search_volume == 100
    assert merged.cpc == 1.25
    assert merged.competition == 0.4
    assert merged.keyword_difficulty == 20
    assert merged.intent == "commercial"
    assert merged.monthly_searches == [{"year": 2026, "month": 7, "search_volume": 100}]
    assert excluded == {}


def test_seed_candidates_leave_close_variants_for_ai() -> None:
    ideas = [
        RawKeyword(
            keyword=keyword,
            source="google_ads_site",
            provider_rank=index,
            search_volume=100,
        )
        for index, keyword in enumerate(
            [
                "car wash",
                "and car wash",
                "car & wash",
                "car and wash",
                "car car washing",
                "car washing car washing",
            ],
            start=1,
        )
    ]
    ideas.append(
        RawKeyword(
            keyword="car wash products",
            source="google_ads_site",
            provider_rank=7,
            search_volume=90,
        )
    )

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en")

    assert [candidate.keyword for candidate in candidates] == [
        "car wash",
        "and car wash",
        "car & wash",
        "car and wash",
        "car car washing",
        "car washing car washing",
        "car wash products",
    ]
    assert excluded == {}


def test_seed_candidates_do_not_merge_variants_with_different_search_volumes() -> None:
    ideas = [
        RawKeyword(
            keyword="car care",
            source="google_ads_site",
            provider_rank=2,
            search_volume=9_900,
        ),
        RawKeyword(
            keyword="auto care",
            source="google_ads_site",
            provider_rank=11,
            search_volume=14_800,
        ),
        RawKeyword(
            keyword="auto cleaning",
            source="google_ads_site",
            provider_rank=84,
            search_volume=2_400,
        ),
        RawKeyword(
            keyword="cleaning auto",
            source="google_ads_site",
            provider_rank=345,
            search_volume=5_400,
        ),
    ]

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en")

    assert [candidate.keyword for candidate in candidates] == [
        "auto care",
        "car care",
        "cleaning auto",
        "auto cleaning",
    ]
    assert excluded == {}


def test_seed_candidates_leave_same_volume_variants_for_ai() -> None:
    ideas = [
        RawKeyword(
            keyword="car care",
            source="google_ads_site",
            provider_rank=2,
            search_volume=9_900,
        ),
        RawKeyword(
            keyword="auto care",
            source="google_ads_site",
            provider_rank=11,
            search_volume=9_900,
        ),
    ]

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en")

    assert [candidate.keyword for candidate in candidates] == ["car care", "auto care"]
    assert excluded == {}


def test_seed_candidates_do_not_merge_variants_when_search_volume_is_missing() -> None:
    ideas = [
        RawKeyword(
            keyword="car care",
            source="google_ads_site",
            provider_rank=2,
            search_volume=None,
        ),
        RawKeyword(
            keyword="auto care",
            source="google_ads_site",
            provider_rank=11,
            search_volume=None,
        ),
    ]

    candidates, excluded = prepare_seed_candidates(ideas, PROFILE, "en")

    assert [candidate.keyword for candidate in candidates] == [
        "car care",
        "auto care",
    ]
    assert excluded == {}


def test_seed_candidates_leave_semantic_phrase_quality_for_ai() -> None:
    candidates, excluded = prepare_seed_candidates(
        [
            RawKeyword(
                keyword="and solar",
                source="google_ads_site",
                provider_rank=1,
                search_volume=1000,
            )
        ],
        PROFILE,
        "en",
    )

    assert [candidate.keyword for candidate in candidates] == ["and solar"]
    assert excluded == {}


def test_seed_candidates_do_not_drop_valid_prepositional_phrases() -> None:
    candidates, excluded = prepare_seed_candidates(
        [
            RawKeyword(
                keyword="at home car care",
                source="google_ads_site",
                provider_rank=1,
                search_volume=1_000,
            ),
            RawKeyword(
                keyword="to remove car scratches",
                source="google_ads_site",
                provider_rank=2,
                search_volume=900,
            ),
        ],
        PROFILE,
        "en",
    )

    assert [candidate.keyword for candidate in candidates] == [
        "at home car care",
        "to remove car scratches",
    ]
    assert excluded == {}


def test_seed_candidates_filter_provider_brands_but_keep_the_own_brand() -> None:
    def brand_payload(name: str) -> dict:
        return {
            "keyword_annotations": {
                "concepts": [
                    {
                        "name": name,
                        "concept_group": {
                            "name": "Repair Shop",
                            "type": "BRAND",
                        },
                    }
                ]
            }
        }

    ideas = [
        RawKeyword(
            keyword="Biki Car Care",
            source="google_ads_site",
            provider_rank=1,
            search_volume=100,
            raw_payload=brand_payload("Biki Car Care"),
        ),
        RawKeyword(
            keyword="Formula Auto Care",
            source="google_ads_site",
            provider_rank=2,
            search_volume=1000,
            raw_payload=brand_payload("Formula Auto Care"),
        ),
    ]

    candidates, excluded = prepare_seed_candidates(
        ideas,
        {**PROFILE, "business_name": "Biki Car Care"},
        "en",
        domain="bikicarcare.com",
    )

    assert [candidate.keyword for candidate in candidates] == ["Biki Car Care"]
    assert excluded == {"formula auto care": "provider_unrelated_brand"}


def test_seed_candidates_keep_explicitly_allowed_provider_brands() -> None:
    idea = RawKeyword(
        keyword="Acme integration",
        source="google_ads_site",
        search_volume=1_000,
        raw_payload={
            "keyword_annotations": {
                "concepts": [
                    {
                        "name": "Acme",
                        "concept_group": {"type": "BRAND"},
                    }
                ]
            }
        },
    )

    candidates, excluded = prepare_seed_candidates(
        [idea],
        {**PROFILE, "allowed_brands": ["Acme"]},
        "en",
        domain="example.com",
    )

    assert [candidate.keyword for candidate in candidates] == ["Acme integration"]
    assert excluded == {}


def test_seed_candidates_do_not_allow_a_second_brand_beside_the_own_brand() -> None:
    idea = RawKeyword(
        keyword="Biki Car Care vs Formula Auto Care",
        source="google_ads_site",
        search_volume=1_000,
        raw_payload={
            "keyword_annotations": {
                "concepts": [
                    {
                        "name": "Biki Car Care",
                        "concept_group": {"type": "BRAND"},
                    },
                    {
                        "name": "Formula Auto Care",
                        "concept_group": {"type": "BRAND"},
                    },
                ]
            }
        },
    )

    candidates, excluded = prepare_seed_candidates(
        [idea],
        {**PROFILE, "business_name": "Biki Car Care"},
        "en",
        domain="bikicarcare.com",
    )

    assert candidates == []
    assert excluded == {
        "biki car care vs formula auto care": "provider_unrelated_brand"
    }


def test_exact_duplicate_merge_preserves_provider_brand_annotations() -> None:
    ideas = [
        RawKeyword(
            keyword="Acme streaming",
            source="labs_site",
            search_volume=1_000,
            cpc=1.0,
            competition=0.4,
            keyword_difficulty=30,
            intent="commercial",
            monthly_searches=[{"year": 2026, "month": 7, "search_volume": 1_000}],
            raw_payload={"source": "labs"},
        ),
        RawKeyword(
            keyword="Acme Streaming",
            source="google_ads_site",
            search_volume=1_000,
            raw_payload={
                "keyword_annotations": {
                    "concepts": [
                        {
                            "name": "Acme",
                            "concept_group": {"type": "BRAND"},
                        }
                    ]
                }
            },
        ),
    ]

    candidates, excluded = prepare_seed_candidates(
        ideas,
        {**PROFILE, "business_name": "Example"},
        "en",
        domain="example.com",
    )

    assert candidates == []
    assert excluded == {"acme streaming": "provider_unrelated_brand"}


def test_seed_candidates_do_not_treat_a_repair_shop_category_as_a_brand() -> None:
    idea = RawKeyword(
        keyword="car repair shop",
        source="google_ads_site",
        provider_rank=1,
        search_volume=10_000,
        raw_payload={
            "keyword_annotations": {
                "concepts": [
                    {
                        "name": "Repair Shop",
                        "concept_group": {
                            "name": "Repair Shop",
                            "type": "CATEGORY",
                        },
                    }
                ]
            }
        },
    )

    candidates, excluded = prepare_seed_candidates(
        [idea],
        {"business_type": "Auto repair shop"},
        "en",
        domain="example.com",
    )

    assert [candidate.keyword for candidate in candidates] == ["car repair shop"]
    assert excluded == {}


def test_seed_candidate_volume_ties_keep_provider_relevance_order() -> None:
    ideas = [
        RawKeyword(
            keyword="second by provider",
            source="google_ads_site",
            provider_rank=2,
            search_volume=1000,
        ),
        RawKeyword(
            keyword="first by provider",
            source="google_ads_site",
            provider_rank=1,
            search_volume=1000,
        ),
        RawKeyword(
            keyword="lower volume",
            source="google_ads_site",
            provider_rank=3,
            search_volume=900,
        ),
    ]

    candidates, _ = prepare_seed_candidates(ideas, PROFILE, "en")

    assert [candidate.keyword for candidate in candidates] == [
        "first by provider",
        "second by provider",
        "lower volume",
    ]


def test_ai_keeps_all_usable_seeds_and_ranks_them_without_a_twenty_word_cap() -> None:
    ideas = [
        RawKeyword(
            keyword=f"solar service {index}",
            source="site_seed",
            provider_rank=index,
        )
        for index in range(1, 31)
    ]
    candidates, _ = prepare_seed_candidates(ideas, PROFILE, "en", limit=300)
    payload = {
        "selected": [f"k{index:03d}" for index in range(1, 31)],
    }

    decisions = validate_seed_decisions(candidates, payload)

    assert len(decisions) == 30
    assert sum(decision.selected for decision in decisions) == 30
    assert decisions[19].ai_rank == 20
    assert decisions[20].ai_rank == 21


def test_ai_keeps_active_and_reserve_seed_groups_separate() -> None:
    ideas = [
        RawKeyword(
            keyword=f"solar topic {index}",
            source="site_seed",
            provider_rank=index,
        )
        for index in range(1, 26)
    ]
    candidates, _ = prepare_seed_candidates(ideas, PROFILE, "en", limit=300)
    payload = {
        "active": [f"k{index:03d}" for index in range(1, 21)],
        "reserve": [f"k{index:03d}" for index in range(21, 26)],
    }

    decisions = validate_seed_decisions(candidates, payload)
    selected = [decision for decision in decisions if decision.selected]

    assert [decision.ai_rank for decision in selected[:20]] == list(range(1, 21))
    assert [decision.ai_rank for decision in selected[20:]] == list(range(21, 26))


def test_ai_topic_validation_maps_unique_clusters_and_omits_rejected_keywords() -> None:
    ideas = [
        RawKeyword(
            keyword=keyword,
            source="site_seed",
            provider_rank=index,
            search_volume=500 - index,
        )
        for index, keyword in enumerate(
            ["solar panels", "solar panel", "home battery", "unrelated"],
            start=1,
        )
    ]
    candidates, _ = prepare_seed_candidates(ideas, PROFILE, "en", limit=300)

    clusters = validate_seed_topic_clusters(
        candidates,
        {
            "topics": [
                {"representative": "k001", "members": ["k001", "k002"]},
                {"representative": "k003", "members": ["k003"]},
            ]
        },
    )

    assert [cluster.representative.keyword for cluster in clusters] == [
        "solar panels",
        "home battery",
    ]
    assert clusters[0].member_ids == ("k001", "k002")
    assert [member.keyword for member in clusters[0].members] == [
        "solar panels",
        "solar panel",
    ]
    assert sum(len(cluster.members) for cluster in clusters) == 3


def test_ai_topic_validation_accepts_complete_cluster_and_excluded_partition() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar panels", source="site_seed", search_volume=100),
            RawKeyword(keyword="unrelated", source="site_seed", search_volume=90),
        ],
        PROFILE,
        "en",
    )

    clusters = validate_seed_topic_clusters(
        candidates,
        {
            "topics": [{"representative": "k001", "members": ["k001"]}],
            "excluded": ["k002"],
        },
        require_excluded=True,
    )

    assert len(clusters) == 1
    assert clusters[0].representative.keyword == "solar panels"


def test_active_seed_selection_requires_exactly_twenty_unique_known_ids() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=f"solar topic {index}",
                source="site_seed",
                search_volume=1_000 - index,
            )
            for index in range(1, 26)
        ],
        PROFILE,
        "en",
    )

    choices = validate_active_seed_selection(
        candidates,
        {"active": [f"k{index:03d}" for index in range(1, 21)]},
    )

    assert len(choices) == 20
    assert choices[0].candidate_id == "k001"
    assert choices[-1].candidate_id == "k020"


def test_diverse_seed_pool_requires_one_hundred_ids_across_topics() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=f"solar topic {index}",
                source="site_seed",
                search_volume=10_000 - index,
            )
            for index in range(1, 101)
        ],
        PROFILE,
        "en",
    )
    payload = {
        "groups": [
            {
                "topic": f"group {group_index}",
                "ids": [
                    f"k{candidate_index:03d}"
                    for candidate_index in range(
                        (group_index - 1) * 4 + 1,
                        group_index * 4 + 1,
                    )
                ],
            }
            for group_index in range(1, 26)
        ]
    }

    groups = validate_diverse_seed_pool(candidates, payload)

    assert len(groups) == 25
    assert sum(len(group.member_ids) for group in groups) == 100
    assert groups[0].member_ids == ("k001", "k002", "k003", "k004")


def test_diverse_seed_pool_rejects_repeated_ids() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=f"solar topic {index}",
                source="site_seed",
                search_volume=10_000 - index,
            )
            for index in range(1, 101)
        ],
        PROFILE,
        "en",
    )
    groups = [
        {
            "topic": f"group {group_index}",
            "ids": [
                f"k{candidate_index:03d}"
                for candidate_index in range(
                    (group_index - 1) * 4 + 1,
                    group_index * 4 + 1,
                )
            ],
        }
        for group_index in range(1, 26)
    ]
    groups[-1]["ids"][-1] = "k001"

    with pytest.raises(ValueError):
        validate_diverse_seed_pool(candidates, {"groups": groups})


def test_grouped_active_selection_uses_different_topics() -> None:
    groups = [
        SeedPoolGroup(
            topic=f"group {index}",
            member_ids=(f"k{index:03d}", f"k{index + 20:03d}"),
            members=(
                SeedCandidate(
                    keyword=f"solar topic {index}",
                    normalized_keyword=f"solar topic {index}",
                    rank=index,
                    selection_details={},
                    raw=RawKeyword(keyword=f"solar topic {index}", source="site_seed"),
                ),
                SeedCandidate(
                    keyword=f"solar alternative {index}",
                    normalized_keyword=f"solar alternative {index}",
                    rank=index + 20,
                    selection_details={},
                    raw=RawKeyword(
                        keyword=f"solar alternative {index}",
                        source="site_seed",
                    ),
                ),
            ),
        )
        for index in range(1, 21)
    ]

    choices = validate_grouped_active_seed_selection(
        groups,
        {"active": [f"k{index:03d}" for index in range(1, 21)]},
    )

    assert len(choices) == 20
    with pytest.raises(ValueError):
        validate_grouped_active_seed_selection(
            groups,
            {
                "active": [
                    "k001",
                    "k021",
                    *[f"k{index:03d}" for index in range(2, 20)],
                ]
            },
        )


def test_active_seed_selection_keeps_all_when_fewer_than_twenty_exist() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=f"solar topic {index}",
                source="site_seed",
                search_volume=100 - index,
            )
            for index in range(1, 4)
        ],
        PROFILE,
        "en",
    )

    choices = validate_active_seed_selection(
        candidates,
        {"active": ["k001", "k002", "k003"]},
    )

    assert len(choices) == 3


def test_topic_resolution_derives_active_reserve_and_auditable_statuses() -> None:
    resolution = resolve_topic_seed_selection(
        [f"k{index:03d}" for index in range(1, 27)],
        {
            "duplicate_groups": [
                {"keep": "k001", "drop": ["k002", "k003"]},
                {"keep": "k004", "drop": ["k005"]},
            ],
            "ranked": [
                "k001",
                "k004",
                *[f"k{index:03d}" for index in range(6, 27)],
            ],
        },
    )

    assert resolution.active_ids == (
        "k001",
        "k004",
        *[f"k{index:03d}" for index in range(6, 24)],
    )
    assert resolution.reserve_ids == ("k024", "k025", "k026")
    assert resolution.duplicate_groups[0].keep_id == "k001"
    assert resolution.duplicate_groups[0].drop_ids == ("k002", "k003")
    assert resolution.unresolved_ids == ()


def test_topic_resolution_does_not_fill_active_from_unresolved_topics() -> None:
    resolution = resolve_topic_seed_selection(
        ["k001", "k002", "k003", "k004"],
        {
            "duplicate_groups": [{"keep": "k001", "drop": ["k002"]}],
            "ranked": ["k001", "k003"],
        },
    )

    assert resolution.active_ids == ("k001", "k003")
    assert resolution.reserve_ids == ()
    assert resolution.unresolved_ids == ("k004",)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {
            "duplicate_groups": [{"keep": "k001", "drop": ["k002"]}],
            "ranked": ["k001", "k002"],
        },
        {
            "duplicate_groups": [{"keep": "k001", "drop": ["k002"]}],
            "ranked": ["k003"],
        },
        {
            "duplicate_groups": [
                {"keep": "k001", "drop": ["k002"]},
                {"keep": "k003", "drop": ["k002"]},
            ],
            "ranked": ["k001", "k003"],
        },
        {
            "duplicate_groups": [],
            "ranked": ["k999"],
        },
    ],
)
def test_topic_resolution_rejects_conflicting_or_unknown_assignments(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        resolve_topic_seed_selection(["k001", "k002", "k003"], payload)


def test_topic_representatives_become_ranked_seeds_without_forcing_twenty() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=keyword,
                source="google_ads_site",
                provider_rank=index,
                search_volume=10_000 - index,
            )
            for index, keyword in enumerate(
                [
                    "solar panel installation",
                    "install solar panels",
                    "solar installation cost",
                    "unrelated navigation login",
                ],
                start=1,
            )
        ],
        PROFILE,
        "en",
    )
    topics = validate_seed_topic_representatives(
        candidates,
        {
            "topics": [
                {
                    "object": "solar panel",
                    "need": "installation service",
                    "page_intent": "service",
                    "representative": "k001",
                    "members": ["k001"],
                },
                {
                    "object": "solar panel",
                    "need": "installation service",
                    "page_intent": "commercial",
                    "representative": "k002",
                    "members": ["k002"],
                },
                {
                    "object": "solar installation",
                    "need": "cost",
                    "page_intent": "commercial",
                    "representative": "k003",
                    "members": ["k003"],
                },
            ],
            "excluded": ["k004"],
        },
    )
    pairs = [
        TopicDuplicatePair(
            pair_id="p001",
            left_id="k001",
            right_id="k002",
            signals=("similar_wording",),
        )
    ]
    resolution = resolve_bounded_topic_seed_selection(
        ["k001", "k002", "k003"],
        pairs,
        {
            "duplicate_pair_ids": ["p001"],
            "ranked": ["k002", "k001", "k003"],
        },
    )

    decisions = build_topic_seed_decisions(candidates, topics, resolution)

    assert [
        (decision.candidate.keyword, decision.selected, decision.ai_rank) for decision in decisions
    ] == [
        ("solar panel installation", False, None),
        ("install solar panels", True, 1),
        ("solar installation cost", True, 2),
        ("unrelated navigation login", False, None),
    ]
    assert decisions[0].reason_code == "duplicate_seed_topic"
    assert decisions[3].reason_code == "ai_excluded"
    assert decisions[1].business_topic == ("solar panel | installation service | commercial")


@pytest.mark.parametrize(
    "payload",
    [
        {"topics": []},
        {
            "topics": [
                {
                    "object": "solar panel",
                    "need": "installation",
                    "page_intent": "unknown",
                    "representative": "k001",
                }
            ]
        },
        {
            "topics": [
                {
                    "object": "solar panel",
                    "need": "installation",
                    "page_intent": "service",
                    "representative": "k999",
                }
            ]
        },
    ],
)
def test_topic_representative_validation_rejects_invalid_output(
    payload: dict[str, object],
) -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword="solar panel installation",
                source="google_ads_site",
                search_volume=1_000,
            )
        ],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_seed_topic_representatives(candidates, payload)


def test_topic_representative_repair_keeps_valid_work_after_cross_topic_duplicate() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar panels", source="google_ads_site", search_volume=1_000),
            RawKeyword(keyword="solar panel", source="google_ads_site", search_volume=900),
            RawKeyword(keyword="solar panel cost", source="google_ads_site", search_volume=800),
        ],
        PROFILE,
        "en",
    )
    payload = {
        "topics": [
            {
                "object": "solar panel",
                "need": "product",
                "page_intent": "product",
                "representative": "k001",
                "members": ["k001", "k002"],
            },
            {
                "object": "solar panel",
                "need": "cost",
                "page_intent": "commercial",
                "representative": "k002",
                "members": ["k002", "k003"],
            },
        ],
        "excluded": [],
    }

    topics, diagnostics = repair_seed_topic_representatives(candidates, payload)

    assert [topic["representative_id"] for topic in topics] == ["k001", "k003"]
    assert topics[0]["member_ids"] == ("k001", "k002")
    assert topics[1]["member_ids"] == ("k003",)
    assert diagnostics == {
        "repeated_member_count": 1,
        "representative_replacement_count": 1,
        "merged_signature_count": 0,
        "skipped_invalid_topic_count": 0,
        "excluded_conflict_count": 0,
        "repeated_excluded_count": 0,
        "invalid_excluded_count": 0,
        "missing_candidate_count": 0,
    }


def test_topic_duplicate_pairs_find_wording_overlap_without_pairing_distinct_needs() -> None:
    pairs = build_topic_duplicate_pairs(
        [
            {
                "representative_id": "k001",
                "representative_keyword": "car scratch remover",
                "object": "car paint",
                "need": "scratch removal",
                "page_intent": "product",
            },
            {
                "representative_id": "k002",
                "representative_keyword": "scratch remover",
                "object": "car scratch",
                "need": "removal",
                "page_intent": "product",
            },
            {
                "representative_id": "k003",
                "representative_keyword": "tire cleaner",
                "object": "tire",
                "need": "cleaning",
                "page_intent": "product",
            },
            {
                "representative_id": "k004",
                "representative_keyword": "tire shine",
                "object": "tire",
                "need": "shine",
                "page_intent": "product",
            },
        ],
        "en",
    )

    assert [(pair.left_id, pair.right_id) for pair in pairs] == [("k001", "k002")]


def test_topic_duplicate_pairs_use_minimum_relationships_without_fixed_pair_cap() -> None:
    topics = [
        {
            "representative_id": f"k{index:03d}",
            "representative_keyword": f"streaming app wording {index}",
            "object": f"object {index}",
            "need": f"need {index}",
            "page_intent": "informational",
            "annotation_concepts": ("streaming", "television"),
        }
        for index in range(1, 103)
    ]

    pairs = build_topic_duplicate_pairs(topics, "en")

    assert len(pairs) == 101
    assert pairs[-1].pair_id == "p101"
    assert all("same_annotation_concepts" in pair.signals for pair in pairs)


def test_provider_concepts_do_not_pair_unrelated_wording_by_themselves() -> None:
    pairs = build_topic_duplicate_pairs(
        [
            {
                "representative_id": "k001",
                "representative_keyword": "watch television online",
                "object": "watch television online",
                "need": "entertainment",
                "page_intent": "informational",
                "annotation_concepts": ("streaming", "television"),
            },
            {
                "representative_id": "k002",
                "representative_keyword": "digital broadcasting technology",
                "object": "digital broadcasting technology",
                "need": "technical education",
                "page_intent": "informational",
                "annotation_concepts": ("streaming", "television"),
            },
        ],
        "en",
    )

    assert pairs == []


def test_bounded_topic_resolution_ranks_everything_then_filters_confirmed_pairs() -> None:
    pairs = [
        TopicDuplicatePair(
            pair_id="p001",
            left_id="k001",
            right_id="k002",
            signals=("token_containment",),
        ),
        TopicDuplicatePair(
            pair_id="p002",
            left_id="k003",
            right_id="k004",
            signals=("similar_wording",),
        ),
    ]

    resolution = resolve_bounded_topic_seed_selection(
        ["k001", "k002", "k003", "k004", "k005"],
        pairs,
        {
            "duplicate_pair_ids": ["p001"],
            "ranked": ["k002", "k001", "k003", "k004", "k005"],
        },
        active_limit=3,
    )

    assert resolution.ranked_ids == ("k002", "k003", "k004", "k005")
    assert resolution.active_ids == ("k002", "k003", "k004")
    assert resolution.reserve_ids == ("k005",)
    assert len(resolution.duplicate_groups) == 1
    assert resolution.duplicate_groups[0].keep_id == "k002"
    assert resolution.duplicate_groups[0].drop_ids == ("k001",)
    assert resolution.unresolved_ids == ()


def test_bounded_topic_resolution_does_not_chain_through_a_dropped_keyword() -> None:
    pairs = [
        TopicDuplicatePair(
            pair_id="p001",
            left_id="k001",
            right_id="k002",
            signals=("similar_wording",),
        ),
        TopicDuplicatePair(
            pair_id="p002",
            left_id="k002",
            right_id="k003",
            signals=("similar_wording",),
        ),
    ]

    resolution = resolve_bounded_topic_seed_selection(
        ["k001", "k002", "k003"],
        pairs,
        {
            "duplicate_pair_ids": ["p001", "p002"],
            "ranked": ["k001", "k002", "k003"],
        },
        active_limit=3,
    )

    assert resolution.ranked_ids == ("k001", "k003")
    assert resolution.duplicate_groups == (
        TopicDuplicateGroup(keep_id="k001", drop_ids=("k002",)),
    )


@pytest.mark.parametrize(
    "ranked",
    [
        ["k002", "k001"],
        ["k002", "k001", "k002", "k003"],
    ],
)
def test_bounded_topic_resolution_requires_every_id_exactly_once(
    ranked: list[str],
) -> None:
    with pytest.raises(ValueError):
        resolve_bounded_topic_seed_selection(
            ["k001", "k002", "k003"],
            [],
            {
                "duplicate_pair_ids": [],
                "ranked": ranked,
            },
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"active": ["k001"]},
        {"active": ["k001"] * 20},
        {"active": [*[f"k{index:03d}" for index in range(1, 20)], "k999"]},
    ],
)
def test_active_seed_selection_rejects_invalid_output(payload: dict[str, object]) -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=f"solar topic {index}",
                source="site_seed",
                search_volume=1_000 - index,
            )
            for index in range(1, 26)
        ],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_active_seed_selection(candidates, payload)


def test_valid_seed_validation_preserves_candidate_order() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar panels", source="site_seed", search_volume=100),
            RawKeyword(keyword="home battery", source="site_seed", search_volume=90),
            RawKeyword(keyword="solar service", source="site_seed", search_volume=80),
        ],
        PROFILE,
        "en",
    )

    choices = validate_valid_seed_candidates(
        candidates,
        {
            "kept": [
                {
                    "keyword": "home battery",
                    "category": "home energy",
                    "intent": "Commercial",
                },
                {
                    "keyword": "solar panels",
                    "category": "solar energy",
                    "intent": "Informational",
                },
            ],
            "removed": [{"keyword": "solar service"}],
        },
        ["solar energy", "home energy"],
    )

    assert [choice.candidate_id for choice in choices] == ["k001", "k002"]
    assert [choice.candidate.keyword for choice in choices] == [
        "solar panels",
        "home battery",
    ]
    assert [choice.category for choice in choices] == ["solar energy", "home energy"]
    assert [choice.intent for choice in choices] == ["Informational", "Commercial"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"kept": [], "removed": [{"keyword": "solar panels"}]},
        {
            "kept": [
                {
                    "keyword": "rewritten solar panels",
                    "category": "solar energy",
                    "intent": "Commercial",
                }
            ],
            "removed": [
                {"keyword": "home battery"},
                {"keyword": "solar service"},
            ],
        },
        {
            "kept": [
                {
                    "keyword": "solar panels",
                    "category": "not allowed",
                    "intent": "Commercial",
                }
            ],
            "removed": [
                {"keyword": "home battery"},
                {"keyword": "solar service"},
            ],
        },
        {
            "kept": [
                {
                    "keyword": "solar panels",
                    "category": "solar energy",
                    "intent": "Research",
                }
            ],
            "removed": [
                {"keyword": "home battery"},
                {"keyword": "solar service"},
            ],
        },
        {
            "kept": [
                {
                    "keyword": "solar panels",
                    "category": "solar energy",
                    "intent": "Commercial",
                }
            ],
            "removed": [
                {"keyword": "solar panels"},
                {"keyword": "home battery"},
                {"keyword": "solar service"},
            ],
        },
        {
            "kept": [],
            "removed": [
                {"keyword": "solar panels"},
                {"keyword": "home battery"},
                {"keyword": "home battery"},
                {"keyword": "solar service"},
            ],
        },
    ],
)
def test_valid_seed_validation_rejects_invalid_output(
    payload: dict[str, object],
) -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar panels", source="site_seed", search_volume=100),
            RawKeyword(keyword="home battery", source="site_seed", search_volume=90),
            RawKeyword(keyword="solar service", source="site_seed", search_volume=80),
        ],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_valid_seed_candidates(candidates, payload, ["solar energy"])


@pytest.mark.parametrize(
    "payload",
    [
        {"topics": [{"representative": "k001", "members": ["k001"]}]},
        {
            "topics": [{"representative": "k001", "members": ["k001"]}],
            "excluded": [],
        },
        {
            "topics": [{"representative": "k001", "members": ["k001"]}],
            "excluded": ["k001", "k002"],
        },
        {
            "topics": [{"representative": "k001", "members": ["k001"]}],
            "excluded": ["k002", "k002"],
        },
        {
            "topics": [{"representative": "k001", "members": ["k001"]}],
            "excluded": ["k999"],
        },
    ],
)
def test_ai_topic_validation_rejects_invalid_explicit_exclusions(
    payload: dict[str, object],
) -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar panels", source="site_seed", search_volume=100),
            RawKeyword(keyword="unrelated", source="site_seed", search_volume=90),
        ],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_seed_topic_clusters(
            candidates,
            payload,
            require_excluded=True,
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"topics": []},
        {"topics": [{"representative": "k999", "members": ["k001"]}]},
        {"topics": [{"representative": "k001", "members": ["k002"]}]},
        {"topics": [{"representative": "k001", "members": ["k001", "k001"]}]},
        {
            "topics": [
                {"representative": "k001", "members": ["k001", "k002"]},
                {"representative": "k002", "members": ["k002"]},
            ]
        },
    ],
)
def test_ai_topic_validation_rejects_invalid_clusters(payload: dict[str, object]) -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar panels", source="site_seed", search_volume=100),
            RawKeyword(keyword="solar panel", source="site_seed", search_volume=90),
        ],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_seed_topic_clusters(candidates, payload)


def test_ai_seed_validation_derives_rejected_candidates_from_unselected_ids() -> None:
    ideas = [
        RawKeyword(
            keyword=f"solar service {index}",
            source="site_seed",
            provider_rank=index,
        )
        for index in range(1, 4)
    ]
    candidates, _ = prepare_seed_candidates(ideas, PROFILE, "en", limit=300)

    decisions = validate_seed_decisions(candidates, {"selected": ["k002"]})

    assert [(decision.candidate.keyword, decision.selected) for decision in decisions] == [
        ("solar service 2", True),
        ("solar service 1", False),
        ("solar service 3", False),
    ]
    assert decisions[0].ai_rank == 1
    assert all(
        decision.reason_code == "ai_not_selected" for decision in decisions if not decision.selected
    )


@pytest.mark.parametrize(
    "selected",
    [
        ["k999"],
        [{"id": "k001"}],
    ],
)
def test_ai_seed_validation_rejects_invalid_minimal_output(selected: list[object]) -> None:
    candidates, _ = prepare_seed_candidates(
        [RawKeyword(keyword="solar installation", source="site_seed")],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_seed_decisions(candidates, {"selected": selected})


@pytest.mark.parametrize(
    "payload",
    [
        {"active": ["k001"] * 21, "reserve": []},
        {"active": ["k999"], "reserve": []},
        {"active": ["k001"]},
    ],
)
def test_ai_seed_validation_rejects_invalid_active_reserve_output(
    payload: dict[str, object],
) -> None:
    candidates, _ = prepare_seed_candidates(
        [RawKeyword(keyword="solar installation", source="site_seed")],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError):
        validate_seed_decisions(candidates, payload)


def test_ai_seed_validation_deduplicates_repeated_ids_without_rejecting_result() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(keyword="solar installation", source="site_seed"),
            RawKeyword(keyword="solar panels", source="site_seed"),
        ],
        PROFILE,
        "en",
    )

    decisions = validate_seed_decisions(
        candidates,
        {
            "active": ["k001"],
            "reserve": ["k001", "k002", "k002"],
        },
    )

    selected = [decision for decision in decisions if decision.selected]
    assert [(decision.candidate.keyword, decision.ai_rank) for decision in selected] == [
        ("solar installation", 1),
        ("solar panels", 22),
    ]


def test_ai_seed_validation_requires_twenty_active_when_reserves_are_available() -> None:
    candidates, _ = prepare_seed_candidates(
        [
            RawKeyword(
                keyword=f"solar topic {index}",
                source="site_seed",
                provider_rank=index,
            )
            for index in range(1, 26)
        ],
        PROFILE,
        "en",
    )

    with pytest.raises(ValueError, match="left active seed slots empty"):
        validate_seed_decisions(
            candidates,
            {
                "active": [f"k{index:03d}" for index in range(1, 11)],
                "reserve": [f"k{index:03d}" for index in range(11, 26)],
            },
        )


def test_keyword_ideas_never_exceed_the_initial_five_hundred_limit() -> None:
    rows = [
        RawKeyword(
            keyword=f"solar keyword idea {index}",
            source="keyword_ideas",
            provider_rank=index,
        )
        for index in range(1, 551)
    ]

    selected, rejected = merge_and_limit_candidates(rows, PROFILE, "en")

    assert len(selected) == 500
    assert all(candidate.sources == ["keyword_ideas"] for candidate in selected)
    assert sum(candidate.exclusion_reason == "round_limit" for candidate in rejected) == 50


def test_seed_keywords_are_excluded_without_consuming_formal_library_slots() -> None:
    rows = [
        RawKeyword(
            keyword="solar panels",
            source="keyword_ideas",
            provider_rank=1,
        ),
        *[
            RawKeyword(
                keyword=f"solar installation option {index}",
                source="keyword_ideas",
                provider_rank=index + 1,
            )
            for index in range(1, 6)
        ],
    ]

    selected, rejected = merge_and_limit_candidates(
        rows,
        PROFILE,
        "en",
        limit=5,
        excluded_normalized={"solar panels": "seed_keyword"},
    )

    assert len(selected) == 5
    assert all(candidate.normalized_keyword != "solar panels" for candidate in selected)
    assert sum(candidate.exclusion_reason == "seed_keyword" for candidate in rejected) == 1


def test_existing_library_keywords_do_not_consume_round_slots() -> None:
    rows = [
        RawKeyword(
            keyword=f"solar keyword {index}",
            source="keyword_ideas",
            provider_rank=index,
        )
        for index in range(1, 101)
    ]
    existing = {f"solar keyword {index}" for index in range(1, 51)}

    selected, rejected = merge_and_limit_candidates(
        rows,
        PROFILE,
        "en",
        limit=50,
        existing_normalized=existing,
    )

    assert len(selected) == 50
    assert all(candidate.normalized_keyword not in existing for candidate in selected)
    assert sum(candidate.exclusion_reason == "already_in_library" for candidate in rejected) == 50


def test_existing_project_total_does_not_reduce_the_current_batch_limit() -> None:
    rows = [
        RawKeyword(
            keyword=f"new solar keyword {index}",
            source="keyword_ideas",
            provider_rank=index,
        )
        for index in range(1, 801)
    ]
    existing = {f"existing solar keyword {index}" for index in range(1, 1401)}

    selected, rejected = merge_and_limit_candidates(
        rows,
        PROFILE,
        "en",
        existing_normalized=existing,
    )

    assert len(selected) == 500
    assert sum(candidate.exclusion_reason == "round_limit" for candidate in rejected) == 300


def test_multi_source_duplicate_consumes_one_slot_and_keeps_all_sources() -> None:
    rows = [
        RawKeyword(
            keyword="Solar Panel Cost",
            source="keyword_ideas",
            provider_rank=1,
        ),
        RawKeyword(
            keyword="solar panel cost",
            source="keyword_ideas",
            provider_rank=1,
            source_seed_id="seed-1",
            source_seed_rank=1,
        ),
    ]

    selected, rejected = merge_and_limit_candidates(rows, PROFILE, "en")

    assert rejected == []
    assert len(selected) == 1
    assert selected[0].sources == ["keyword_ideas"]
    assert len(selected[0].rows) == 2


def test_classification_does_not_filter_uncertain_keywords() -> None:
    candidate = MergedCandidate(
        keyword="solar financing calculator",
        normalized_keyword="solar financing calculator",
        rows=[
            RawKeyword(
                keyword="solar financing calculator",
                source="keyword_ideas",
                source_seed_id="seed-financing",
            )
        ],
        relevance=0.6,
        included=True,
    )
    seeds = [
        {"id": "seed-panels", "keyword": "solar panels", "ai_rank": 1},
        {"id": "seed-financing", "keyword": "solar financing", "ai_rank": 2},
    ]

    primary, relations = classify_candidate(candidate, seeds, "en")

    assert primary == "seed-financing"
    assert relations[0] == ("seed-financing", 1.0, "source")
    assert candidate.included is True


def test_priority_scores_missing_metrics_as_zero_without_reweighting() -> None:
    candidate = MergedCandidate(
        keyword="solar panel installation",
        normalized_keyword="solar panel installation",
        rows=[],
        relevance=0.8,
        included=True,
    )

    score, confidence, details = priority_score(
        candidate,
        metric={},
        profile=PROFILE,
        language="en",
        volume_percentile=75,
    )

    assert score == 38.0
    assert confidence == 0.5
    assert details["values"]["search_volume"] == 75
    assert details["values"]["difficulty"] is None
    assert details["values"]["intent"] is None


def test_priority_v2_uses_demand_difficulty_relevance_and_intent_weights() -> None:
    candidate = MergedCandidate(
        keyword="solar panel installation",
        normalized_keyword="solar panel installation",
        rows=[],
        relevance=0.8,
        included=True,
    )

    score, confidence, details = priority_score(
        candidate,
        metric={"keyword_difficulty": 20, "intent": "transactional"},
        profile=PROFILE,
        language="en",
        volume_percentile=90,
    )

    assert score == 87.0
    assert confidence == 1.0
    assert details == {
        "rule_version": "priority-v3",
        "values": {
            "business_relevance": 80.0,
            "search_volume": 90,
            "difficulty": 80.0,
            "intent": 100.0,
        },
        "available_weight": 100.0,
    }
