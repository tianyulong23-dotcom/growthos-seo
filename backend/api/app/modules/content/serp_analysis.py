from __future__ import annotations

import re
from collections import Counter
from datetime import datetime
from typing import Any, Iterable
from urllib.parse import urlsplit


SERP_ANALYSIS_VERSION = 3


CONTENT_TYPE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "Listicle",
        (
            r"\d+\s+(best|top|ways|tips|tools|ideas|examples|reasons)",
            r"\b(best|top)\b",
        ),
    ),
    ("How-To Guide", (r"how to", r"guide to", r"tutorial")),
    ("Definition", (r"what is", r"what are", r"meaning of", r"definition")),
    (
        "Comparison",
        (r"vs\.?", r"versus", r"compared", r"comparison", r"difference between"),
    ),
    ("Review", (r"review", r"reviewed", r"\btested\b", r"hands-on")),
    ("Tool/Resource", (r"calculator", r"tool", r"generator", r"template", r"free")),
)


EDITORIAL_CONTENT_TYPES = {
    "Listicle",
    "How-To Guide",
    "Definition",
    "Comparison",
    "Review",
    "General Article",
}


VIDEO_DOMAINS = {"youtube.com", "youtu.be", "vimeo.com", "dailymotion.com"}
COMMUNITY_DOMAINS = {"reddit.com", "quora.com"}
MARKETPLACE_DOMAINS = {
    "amazon.com",
    "ebay.com",
    "etsy.com",
    "walmart.com",
    "aliexpress.com",
    "target.com",
}


def detect_content_type(title: str) -> str:
    title_lower = title.lower()
    for content_type, patterns in CONTENT_TYPE_PATTERNS:
        if any(re.search(pattern, title_lower) for pattern in patterns):
            return content_type
    return "General Article"


def has_freshness_signal(title: str, *, current_year: int | None = None) -> bool:
    year = current_year or datetime.now().year
    title_lower = title.lower()
    return any(
        signal in title_lower
        for signal in (str(year), str(year - 1), "updated", "latest", "new")
    )


def analyze_serp(
    keyword: str,
    organic_results: Iterable[dict[str, Any]],
    *,
    serp_features: Iterable[str] = (),
    current_year: int | None = None,
) -> dict[str, Any]:
    top_results: list[dict[str, Any]] = []
    content_types: list[str] = []
    freshness_positions: list[int] = []
    domains: list[str] = []

    for index, raw_result in enumerate(organic_results):
        if index >= 10:
            break
        result = dict(raw_result)
        title = str(result.get("title") or "")
        url = str(result.get("url") or "")
        content_type = detect_content_type(title)
        result_shape = detect_result_shape(title, url, content_type=content_type)
        freshness_signal = has_freshness_signal(title, current_year=current_year)
        position = _position(result, index)
        organic_position = index + 1
        domain = str(result.get("domain") or _domain(url))
        result.update(
            {
                "position": position,
                "organic_position": organic_position,
                "domain": domain,
                "content_type": content_type,
                "result_shape": result_shape,
                "freshness_signal": freshness_signal,
            }
        )
        top_results.append(result)
        if result_shape == "editorial":
            content_types.append(content_type)
        domains.append(domain)
        if freshness_signal:
            freshness_positions.append(organic_position)

    counts = Counter(content_types)
    distribution = dict(counts)
    dominant_type = counts.most_common(1)[0][0] if counts else "General Article"
    freshness_ratio = len(freshness_positions) / len(top_results) if top_results else 0.0
    features = list(dict.fromkeys(str(item) for item in serp_features if item))
    freshness_important = freshness_ratio >= 0.6

    return {
        "analysis_version": SERP_ANALYSIS_VERSION,
        "keyword": keyword,
        "analyzed_result_count": len(top_results),
        "top_results": top_results,
        "content_types": content_types,
        "content_type_distribution": distribution,
        "dominant_content_type": dominant_type,
        "domains": domains,
        "freshness_signals": freshness_positions,
        "freshness_ratio": freshness_ratio,
        "freshness_important": freshness_important,
        "serp_features": features,
        "content_brief": generate_content_brief(
            keyword,
            dominant_type,
            features,
            freshness_important=freshness_important,
        ),
    }


def serp_analysis_needs_refresh(
    analysis: dict[str, Any], organic_results: Iterable[dict[str, Any]]
) -> bool:
    return bool(organic_results) and analysis.get("analysis_version") != SERP_ANALYSIS_VERSION


def generate_content_brief(
    keyword: str,
    content_type: str,
    serp_features: Iterable[str],
    *,
    freshness_important: bool,
) -> dict[str, Any]:
    must_have_elements: list[str]
    structure_recommendations: list[str]
    if "Listicle" in content_type:
        must_have_elements = [
            "Numbered list format",
            "Comparison table",
            "Pros and cons for each item",
            "Clear introduction explaining criteria",
            "Summary/conclusion with top recommendation",
        ]
        structure_recommendations = [
            "Introduction (what, why, how to choose)",
            "Item 1-10 (each with description, pros/cons)",
            "Comparison table",
            "FAQs",
            "Conclusion with top pick",
        ]
    elif "How-To" in content_type:
        must_have_elements = [
            "Step-by-step instructions",
            "Visual aids (screenshots, diagrams)",
            "Prerequisites section",
            "Time estimate",
            "Troubleshooting tips",
        ]
        structure_recommendations = [
            "Introduction (what you'll learn)",
            "Prerequisites/Requirements",
            "Step-by-step instructions",
            "Common mistakes to avoid",
            "FAQs",
            "Conclusion/Next steps",
        ]
    elif "Definition" in content_type:
        must_have_elements = [
            "Clear, concise definition upfront",
            "Examples",
            "History/etymology if relevant",
            "Related concepts",
            "Practical applications",
        ]
        structure_recommendations = [
            "Quick definition (target featured snippet)",
            "Detailed explanation",
            "Examples",
            "Related terms/concepts",
            "Practical applications",
            "FAQs",
        ]
    else:
        must_have_elements = [
            "Comprehensive coverage",
            "Expert insights",
            "Real examples",
            "Data and statistics",
        ]
        structure_recommendations = [
            "Introduction",
            "Main sections (3-5)",
            "Examples and case studies",
            "FAQs",
            "Conclusion",
        ]

    feature_targets: list[str] = []
    normalized_features = " ".join(serp_features).lower()
    if "featured_snippet" in normalized_features:
        feature_targets.append(
            "Featured Snippet - Add concise definition/answer in first 100 words"
        )
    if "people_also_ask" in normalized_features:
        feature_targets.append("People Also Ask - Add FAQ section answering related questions")
    if "video" in normalized_features:
        feature_targets.append("Video - Consider embedding relevant video or creating one")
    if "images" in normalized_features:
        feature_targets.append("Images - Include high-quality images with alt text")
    if freshness_important:
        year = datetime.now().year
        must_have_elements.extend(
            [f"Current year ({year}) in title and content", "Latest statistics and examples"]
        )

    return {
        "target_keyword": keyword,
        "content_type": content_type,
        "must_have_elements": must_have_elements,
        "serp_features_to_target": feature_targets,
        "structure_recommendations": structure_recommendations,
    }


def select_dominant_type_results(
    analysis: dict[str, Any], *, project_domain: str = "", limit: int = 8
) -> list[dict[str, Any]]:
    dominant_type = str(analysis.get("dominant_content_type") or "General Article")
    selected: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for item in analysis.get("top_results") or []:
        url = str(item.get("url") or "")
        if (
            not url
            or url in seen_urls
            or str(item.get("content_type") or "") != dominant_type
            or str(item.get("result_shape") or "editorial") != "editorial"
            or _same_domain(url, project_domain)
        ):
            continue
        seen_urls.add(url)
        selected.append(dict(item))
        if len(selected) >= limit:
            break
    return selected


def detect_result_shape(title: str, url: str, *, content_type: str) -> str:
    parsed = urlsplit(url)
    domain = (parsed.hostname or "").lower().removeprefix("www.")
    path = parsed.path.lower().rstrip("/")
    title_lower = title.lower()

    if any(domain == item or domain.endswith(f".{item}") for item in VIDEO_DOMAINS):
        return "video"
    if any(domain == item or domain.endswith(f".{item}") for item in COMMUNITY_DOMAINS):
        return "community"
    if any(domain == item or domain.endswith(f".{item}") for item in MARKETPLACE_DOMAINS):
        return "marketplace"
    commerce_segments = ("/collections/", "/collection/", "/products/", "/product-category/")
    if any(segment in f"{path}/" for segment in commerce_segments):
        return "commerce"
    if re.search(r"\b(shop|store)\b", title_lower) and content_type == "General Article":
        return "commerce"
    if content_type not in EDITORIAL_CONTENT_TYPES:
        return "tool"
    return "editorial"


def _position(result: dict[str, Any], index: int) -> int:
    value = result.get("position")
    return value if isinstance(value, int) and value > 0 else index + 1


def _domain(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


def _same_domain(url: str, project_domain: str) -> bool:
    if not project_domain:
        return False
    normalized_project = project_domain.strip()
    parsed_project = urlsplit(
        normalized_project if "://" in normalized_project else f"//{normalized_project}"
    )
    project_host = (parsed_project.hostname or "").lower().rstrip(".").removeprefix("www.")
    result_host = _domain(url).rstrip(".")
    if not project_host:
        return False
    return result_host == project_host or result_host.endswith(f".{project_host}")
