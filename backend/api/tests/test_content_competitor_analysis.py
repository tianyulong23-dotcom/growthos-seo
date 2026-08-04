from app.modules.content.competitor_analysis import (
    analyze_competitor,
    build_competitor_blueprint,
)


def test_competitor_analysis_captures_structure_depth_claims_and_freshness() -> None:
    text = (
        "Direct introduction. "
        "Installation steps "
        + " ".join(["Detailed installation guidance"] * 170)
        + " Cost factors Many users save money according to experts. The estimate came from 2020. "
        + "Frequently asked questions Short answer. Conclusion Clear next step."
    )
    analysis = analyze_competitor(
        text,
        content_type="How-To Guide",
        heading_structure=[
            {"level": 2, "heading": "Installation steps"},
            {"level": 2, "heading": "Cost factors"},
            {"level": 2, "heading": "Frequently asked questions"},
            {"level": 2, "heading": "Conclusion"},
        ],
    )

    assert analysis["content_type"] == "How-To Guide"
    assert [item["heading"] for item in analysis["structure"]] == [
        "Installation steps",
        "Cost factors",
        "Frequently asked questions",
        "Conclusion",
    ]
    assert analysis["structure"][0]["word_count"] >= 150
    assert "Comprehensive coverage of 'Installation steps'" in analysis["strengths"]
    assert any(item["type"] == "unsupported_claim" for item in analysis["gaps"])
    assert any(item["year"] == 2020 for item in analysis["outdated_items"])
    assert not any(
        item["type"] == "structural_gap" and item["location"] in {"FAQ", "Conclusion"}
        for item in analysis["gaps"]
    )


def test_competitor_analysis_uses_html_heading_boundaries_when_available() -> None:
    analysis = analyze_competitor(
        "Plain text without reliable heading boundaries.",
        content_type="Comparison",
        heading_structure=[{"level": 2, "heading": "Wrong fallback heading"}],
        main_html=(
            "<article><p>Opening</p><h2>Pricing <em>details</em></h2>"
            "<p>First section words only.</p><script>ignored text</script>"
            "<h3>Annual plans</h3><p>Nested plan details.</p>"
            "<h2>Use cases</h2><p>Second section body.</p></article>"
        ),
    )

    assert [item["heading"] for item in analysis["structure"]] == [
        "Pricing details",
        "Annual plans",
        "Use cases",
    ]
    assert analysis["structure"][0]["word_count"] == 4
    assert analysis["structure"][1]["word_count"] == 3
    assert analysis["structure"][2]["word_count"] == 3


def test_competitor_blueprint_requires_patterns_from_three_articles() -> None:
    competitors = []
    for index in range(3):
        competitors.append(
            {
                "analysis": {
                    "content_type": "Comparison",
                    "word_count": 1200 + index * 100,
                    "structure": [
                        {"level": 2, "heading": "Pricing", "word_count": 220},
                        {"level": 2, "heading": "Best use cases", "word_count": 180},
                    ],
                    "gaps": [
                        {
                            "type": "thin_section",
                            "location": "Best use cases",
                            "description": "The use-case section is thin",
                            "opportunity": "Add concrete use cases and decision criteria",
                        }
                    ],
                    "outdated_items": [],
                }
            }
        )

    blueprint = build_competitor_blueprint(competitors)

    assert blueprint["analyzed_count"] == 3
    assert blueprint["word_count"] == {"min": 1200, "max": 1400, "average": 1300}
    assert blueprint["structure_to_match"] == [
        {"heading": "Pricing", "competitor_count": 3, "average_word_count": 220},
        {
            "heading": "Best use cases",
            "competitor_count": 3,
            "average_word_count": 180,
        },
    ]
    assert blueprint["must_fill_gaps"][0]["competitor_count"] == 3
    assert blueprint["shared_gap_opportunities"] == [
        "Add concrete use cases and decision criteria"
    ]
    assert blueprint["differentiation_opportunities"] == []


def test_competitor_blueprint_does_not_promote_one_off_patterns() -> None:
    blueprint = build_competitor_blueprint(
        [
            {
                "analysis": {
                    "content_type": "Review",
                    "word_count": 900,
                    "structure": [{"level": 2, "heading": "Unique section", "word_count": 300}],
                    "gaps": [],
                    "outdated_items": [],
                }
            }
        ]
    )

    assert blueprint["structure_to_match"] == []
    assert blueprint["must_fill_gaps"] == []


def test_competitor_blueprint_preserves_entities_prices_and_dimensions_with_provenance() -> None:
    analysis = analyze_competitor(
        (
            "## Chemical Guys Total Interior Cleaner\n"
            "Chemical Guys Total Interior Cleaner costs $12.99.\n"
            "## Meguiar's Quik Interior Detailer\n"
            "Compare price, surface compatibility, scent, and ease of use."
        ),
        content_type="Listicle",
    )
    blueprint = build_competitor_blueprint(
        [{"url": "https://example.com/cleaners", "analysis": analysis}]
    )

    assert {item["name"] for item in blueprint["named_entities"]} == {
        "Chemical Guys Total Interior Cleaner",
        "Meguiar's Quik Interior Detailer",
    }
    assert all(
        item["source_url"] == "https://example.com/cleaners"
        for item in blueprint["named_entities"]
    )
    assert blueprint["price_evidence"][0]["value"] == "$12.99"
    assert blueprint["price_evidence"][0]["source_url"] == "https://example.com/cleaners"
    assert {"price", "surface compatibility", "scent", "ease of use"} <= set(
        blueprint["comparison_dimensions"]
    )
