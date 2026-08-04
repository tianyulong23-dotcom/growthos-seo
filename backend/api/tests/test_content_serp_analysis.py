from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest

from app.modules.content.serp_analysis import (
    analyze_serp,
    detect_content_type,
    select_dominant_type_results,
)


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("10 Best Solar Battery Tools", "Listicle"),
        ("How to Size a Solar Battery", "How-To Guide"),
        ("Guide to Solar Battery Storage", "How-To Guide"),
        ("Solar Battery Tutorial", "How-To Guide"),
        ("What Is Solar Battery Payback?", "Definition"),
        ("Meaning of Solar Battery Payback", "Definition"),
        ("Battery A vs. Battery B", "Comparison"),
        ("Battery A Versus Battery B", "Comparison"),
        ("Difference Between AC and DC Batteries", "Comparison"),
        ("Solar Battery Review", "Review"),
        ("Solar Battery Reviewed by Installers", "Review"),
        ("Best Car Interior Cleaners for 2026, Tested", "Listicle"),
        ("Top Car Interior Cleaners", "Listicle"),
        ("Car Interior Cleaners Tested by Our Editors", "Review"),
        ("Hands-on Car Interior Cleaner Evaluation", "Review"),
        ("Free Solar Battery Calculator", "Tool/Resource"),
        ("Solar Battery Payback Explained", "General Article"),
    ],
)
def test_detect_content_type_matches_seomachine_rules(
    title: str, expected: str
) -> None:
    assert detect_content_type(title) == expected


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("10 Best How To Guides", "Listicle"),
        ("How To Review a Free Tool", "How-To Guide"),
        ("What Is a Comparison Tool?", "Definition"),
        ("Battery A vs Battery B Review", "Comparison"),
        ("Free Battery Tool Review", "Review"),
    ],
)
def test_detect_content_type_preserves_seomachine_rule_order(
    title: str, expected: str
) -> None:
    assert detect_content_type(title) == expected


def result(position: int, title: str, url: str | None = None) -> dict[str, Any]:
    return {
        "position": position,
        "title": title,
        "url": url or f"https://site-{position}.example/article",
    }


def test_analyze_serp_uses_top_ten_and_first_type_to_break_a_tie() -> None:
    results = [
        *[result(index, f"How to solve problem {index}") for index in range(1, 6)],
        *[result(index, f"{index} Best Tools") for index in range(6, 11)],
        result(11, "What Is the Topic?"),
        result(12, "Topic Review"),
    ]

    analysis = analyze_serp("topic", results, current_year=2026)

    assert analysis["analyzed_result_count"] == 10
    assert analysis["content_type_distribution"] == {
        "How-To Guide": 5,
        "Listicle": 5,
    }
    assert analysis["dominant_content_type"] == "How-To Guide"
    assert [item["position"] for item in analysis["top_results"]] == list(
        range(1, 11)
    )
    assert [item["organic_position"] for item in analysis["top_results"]] == list(
        range(1, 11)
    )


def test_analysis_keeps_absolute_rank_and_uses_organic_order_for_freshness() -> None:
    results = [
        result(3, "Solar battery guide 2026", "https://one.example/guide"),
        result(5, "Solar battery archive", "https://two.example/guide"),
        result(7, "Latest solar battery advice", "https://three.example/guide"),
    ]

    analysis = analyze_serp("solar battery", results, current_year=2026)

    assert [item["position"] for item in analysis["top_results"]] == [3, 5, 7]
    assert [item["organic_position"] for item in analysis["top_results"]] == [
        1,
        2,
        3,
    ]
    assert analysis["freshness_signals"] == [1, 3]


@pytest.mark.parametrize(("fresh_count", "expected"), [(6, True), (5, False)])
def test_analyze_serp_uses_seomachine_sixty_percent_freshness_threshold(
    fresh_count: int, expected: bool
) -> None:
    results = [
        result(
            index,
            f"Solar battery guide {'2026' if index <= fresh_count else 'archive'} {index}",
        )
        for index in range(1, 11)
    ]

    analysis = analyze_serp("solar battery", results, current_year=2026)

    assert analysis["freshness_important"] is expected
    assert analysis["freshness_ratio"] == fresh_count / 10


def test_content_brief_matches_seomachine_type_and_serp_feature_requirements() -> None:
    analysis = analyze_serp(
        "solar tools",
        [result(index, f"{index + 10} Best Solar Tools") for index in range(1, 11)],
        serp_features=["featured_snippet", "people_also_ask", "video", "images"],
        current_year=datetime.now().year,
    )

    brief = analysis["content_brief"]
    assert brief["content_type"] == "Listicle"
    assert brief["must_have_elements"] == [
        "Numbered list format",
        "Comparison table",
        "Pros and cons for each item",
        "Clear introduction explaining criteria",
        "Summary/conclusion with top recommendation",
    ]
    assert brief["structure_recommendations"] == [
        "Introduction (what, why, how to choose)",
        "Item 1-10 (each with description, pros/cons)",
        "Comparison table",
        "FAQs",
        "Conclusion with top pick",
    ]
    assert brief["serp_features_to_target"] == [
        "Featured Snippet - Add concise definition/answer in first 100 words",
        "People Also Ask - Add FAQ section answering related questions",
        "Video - Consider embedding relevant video or creating one",
        "Images - Include high-quality images with alt text",
    ]


def test_select_dominant_results_excludes_other_types_site_and_duplicate_urls() -> None:
    results = [
        result(1, "How to Choose", "https://one.example/how-to"),
        result(2, "How to Install", "https://project.example/how-to"),
        result(3, "What Is Storage?", "https://definition.example/article"),
        result(4, "Battery Tutorial", "https://two.example/tutorial"),
        result(5, "Guide to Storage", "https://one.example/how-to"),
        result(6, "Solar Battery Review", "https://review.example/article"),
        result(7, "How to Maintain", "https://three.example/maintain"),
        result(8, "General Battery Advice", "https://general.example/article"),
        result(9, "Storage Tutorial", "https://four.example/tutorial"),
        result(10, "How to Save Energy", "https://five.example/save"),
    ]
    analysis = analyze_serp("solar battery", results, current_year=2026)

    selected = select_dominant_type_results(
        analysis, project_domain="www.project.example", limit=8
    )

    assert analysis["dominant_content_type"] == "How-To Guide"
    assert [item["url"] for item in selected] == [
        "https://one.example/how-to",
        "https://two.example/tutorial",
        "https://three.example/maintain",
        "https://four.example/tutorial",
        "https://five.example/save",
    ]
    assert [item["position"] for item in selected] == [1, 4, 7, 9, 10]


def test_select_dominant_results_excludes_project_subdomains() -> None:
    analysis = analyze_serp(
        "solar battery",
        [
            result(1, "How to Choose", "https://blog.project.example/how-to"),
            result(2, "Solar Battery Tutorial", "https://competitor.example/tutorial"),
        ],
        current_year=2026,
    )

    selected = select_dominant_type_results(
        analysis, project_domain="project.example", limit=8
    )

    assert [item["url"] for item in selected] == [
        "https://competitor.example/tutorial"
    ]


def test_select_dominant_results_accepts_project_domain_as_a_url() -> None:
    analysis = analyze_serp(
        "solar battery",
        [
            result(1, "How to Choose", "https://www.project.example/how-to"),
            result(2, "Storage Tutorial", "https://blog.project.example/tutorial"),
            result(3, "Guide to Storage", "https://competitor.example/guide"),
        ],
        current_year=2026,
    )

    selected = select_dominant_type_results(
        analysis, project_domain="https://www.Project.Example/", limit=8
    )

    assert [item["url"] for item in selected] == [
        "https://competitor.example/guide"
    ]


def test_select_dominant_results_uses_same_type_editorial_pages_only() -> None:
    analysis = analyze_serp(
        "car interior cleaner",
        [
            result(
                1,
                "Best Car Interior Cleaners for 2026, Tested",
                "https://magazine.example/cars/best-interior-cleaners",
            ),
            result(
                2,
                "Amazon.com: Car Interior Cleaner",
                "https://www.amazon.com/s?k=car+interior+cleaner",
            ),
            result(
                3,
                "Car Interior Cleaners",
                "https://shop.example/collections/car-interior-cleaners",
            ),
            result(
                4,
                "10 Best Car Interior Cleaner Products",
                "https://reviews.example/best-car-interior-cleaners",
            ),
            result(
                5,
                "Best Interior Cleaner Test Video",
                "https://www.youtube.com/watch?v=example",
            ),
            result(
                6,
                "What is the best interior car cleaning solution?",
                "https://www.reddit.com/r/Detailing/comments/example/question/",
            ),
            result(
                7,
                "Car Interior Cleaner | Best Wipes & Auto Cleaners",
                "https://www.target.com/s/car+interior+cleaning",
            ),
        ],
        current_year=2026,
    )

    selected = select_dominant_type_results(analysis)

    assert analysis["dominant_content_type"] == "Listicle"
    assert [item["url"] for item in selected] == [
        "https://magazine.example/cars/best-interior-cleaners",
        "https://reviews.example/best-car-interior-cleaners",
    ]
    assert [item["result_shape"] for item in analysis["top_results"]] == [
        "editorial",
        "marketplace",
        "commerce",
        "editorial",
        "video",
        "community",
        "marketplace",
    ]
