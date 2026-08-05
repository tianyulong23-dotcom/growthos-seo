from __future__ import annotations

import re
from collections import Counter
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any


MIN_SECTION_WORDS = 150
UNSUPPORTED_PATTERNS = (
    r"\bmany\s+(?:podcasters?|people|users|customers|creators|businesses|companies)\b",
    r"\bmost\s+(?:podcasters?|people|users|customers|experts|creators|businesses|companies)\b",
    r"\bstudies\s+show\b(?!\s*[\[(])",
    r"\bresearch\s+(?:indicates?|shows?|suggests?)\b(?!\s*[\[(])",
    r"\bsignificant(?:ly)?\s+(?:increase|improvement|growth|impact)\b",
    r"\bsubstantial\s+(?:results?|benefits?|returns?|improvement)\b",
    r"\bexperts?\s+(?:say|agree|recommend)\b(?!\s*[\[(])",
    r"\baccording\s+to\s+(?:experts?|studies)\b(?!\s*[\[(])",
    r"(?:许多|很多|大多数)(?:人|用户|客户|企业|专家)",
    r"(?:研究|数据显示|专家)(?:表明|显示|认为|建议)(?![^。！？\n]{0,40}(?:https?://|\[[^]]+\]))",
)


def analyze_competitor(
    text: str,
    *,
    content_type: str = "General Article",
    heading_structure: list[dict[str, Any]] | None = None,
    main_html: str | None = None,
) -> dict[str, Any]:
    sections = _extract_html_sections(main_html or "") or _extract_sections(
        text, heading_structure or []
    )
    sentences = _sentences(text)
    gaps: list[dict[str, Any]] = []
    strengths: list[str] = []
    outdated_items: list[dict[str, Any]] = []

    for section in sections:
        content = str(section["content"])
        heading = str(section["heading"])
        word_count = _word_count(content)
        section["word_count"] = word_count
        if section["level"] == 2 and word_count < MIN_SECTION_WORDS:
            gaps.append(
                {
                    "type": "thin_section",
                    "location": heading,
                    "priority": "high" if word_count < 75 else "medium",
                    "description": f"Section '{heading}' has about {word_count} words",
                    "opportunity": (
                        f"Cover '{heading}' in about 250-400 words with specific examples "
                        "and actionable steps"
                    ),
                }
            )
        unsupported = _unsupported_claim(content)
        if unsupported:
            gaps.append(
                {
                    "type": "unsupported_claim",
                    "location": heading,
                    "priority": "medium",
                    "description": f"Potential unsupported claim in '{heading}'",
                    "quote": unsupported,
                    "opportunity": "Use a named source or remove the unsupported claim",
                }
            )
        outdated_items.extend(_outdated_items(content, heading))
        if word_count > 400:
            strengths.append(f"Comprehensive coverage of '{heading}'")
        if re.search(r"(?:\d+(?:\.\d+)?%|[$€£¥]\s?\d|\b20\d{2}\b)", content):
            strengths.append(f"Uses specific data in '{heading}'")
        if re.search(r"https?://|\[[^]]+\]\(https?://", content):
            strengths.append(f"Cites sources in '{heading}'")

    h2_headings = [
        _normalize_heading(str(item["heading"])) for item in sections if item["level"] == 2
    ]
    if not any(_is_faq_heading(item) for item in h2_headings):
        gaps.append(
            _structural_gap(
                "FAQ",
                "Add 4-6 real user questions targeting featured snippets",
                priority="high",
            )
        )
    if not any(_is_conclusion_heading(item) for item in h2_headings):
        gaps.append(_structural_gap("Conclusion", "Add a clear conclusion or next steps"))

    return {
        "content_type": content_type,
        "word_count": _word_count(text),
        "structure": [
            {
                "heading": item["heading"],
                "level": item["level"],
                "word_count": item["word_count"],
            }
            for item in sections
            if item["level"] in {2, 3}
        ][:20],
        "strengths": list(dict.fromkeys(strengths))[:5],
        "gaps": gaps[:20],
        "outdated_items": _unique_dicts(outdated_items, "quote")[:10],
        "opening": " ".join(sentences[:2])[:400],
        "key_points": [item[:240] for item in sentences[2:10]],
        "closing": " ".join(sentences[-2:])[:400] if len(sentences) > 2 else "",
        "named_entities": _extract_named_entities(text, sections),
        "price_evidence": _extract_price_evidence(text),
        "comparison_dimensions": _extract_comparison_dimensions(text, sections),
    }


def build_competitor_blueprint(competitors: list[dict[str, Any]]) -> dict[str, Any]:
    analysis_pairs = [
        (item, dict(item.get("analysis") or item.get("summary") or {}))
        for item in competitors
    ]
    analysis_pairs = [item for item in analysis_pairs if item[1]]
    analyses = [analysis for _competitor, analysis in analysis_pairs]
    content_types = Counter(str(item.get("content_type") or "General Article") for item in analyses)
    heading_counts: Counter[str] = Counter()
    heading_labels: dict[str, str] = {}
    heading_word_counts: dict[str, list[int]] = {}
    gap_groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    word_counts: list[int] = []
    named_entities: list[dict[str, Any]] = []
    price_evidence: list[dict[str, Any]] = []
    comparison_dimensions: Counter[str] = Counter()

    for competitor, analysis in analysis_pairs:
        source_url = str(competitor.get("url") or "")
        word_count = int(analysis.get("word_count") or 0)
        if word_count:
            word_counts.append(word_count)
        seen_headings: set[str] = set()
        for section in analysis.get("structure") or []:
            if int(section.get("level") or 0) != 2:
                continue
            heading = str(section.get("heading") or "").strip()
            normalized = _normalize_heading(heading)
            if not normalized or normalized in seen_headings:
                continue
            seen_headings.add(normalized)
            heading_counts[normalized] += 1
            heading_labels.setdefault(normalized, heading)
            word_count = int(section.get("word_count") or 0)
            if word_count:
                heading_word_counts.setdefault(normalized, []).append(word_count)
        for gap in analysis.get("gaps") or []:
            key = (
                str(gap.get("type") or "unknown"),
                _normalize_heading(str(gap.get("location") or "article")),
            )
            gap_groups.setdefault(key, []).append(dict(gap))
        for entity in analysis.get("named_entities") or []:
            value = dict(entity)
            value["source_url"] = source_url
            named_entities.append(value)
        for price in analysis.get("price_evidence") or []:
            value = dict(price)
            value["source_url"] = source_url
            price_evidence.append(value)
        comparison_dimensions.update(
            str(item) for item in analysis.get("comparison_dimensions") or [] if item
        )

    common_structure = [
        {
            "heading": heading_labels[key],
            "competitor_count": count,
            "average_word_count": (
                round(sum(heading_word_counts[key]) / len(heading_word_counts[key]))
                if heading_word_counts.get(key)
                else 0
            ),
        }
        for key, count in heading_counts.most_common()
        if count >= 3
    ][:7]
    must_fill = []
    for matches in gap_groups.values():
        if len(matches) < 3:
            continue
        gap = dict(matches[0])
        gap["competitor_count"] = len(matches)
        must_fill.append(gap)
    must_fill.sort(key=lambda item: (-int(item["competitor_count"]), str(item["type"])))

    outdated = _unique_dicts(
        [dict(item) for analysis in analyses for item in analysis.get("outdated_items") or []],
        "quote",
    )[:10]
    data_needed = [
        {
            "topic": item.get("location") or "Article",
            "reason": item.get("description") or "Competitors use an unsupported claim",
        }
        for item in must_fill
        if item.get("type") == "unsupported_claim"
    ][:5]
    shared_gap_opportunities = [
        str(item.get("opportunity"))
        for item in must_fill
        if item.get("opportunity")
    ][:7]

    return {
        "analyzed_count": len(analyses),
        "content_type_distribution": dict(content_types),
        "word_count": {
            "min": min(word_counts) if word_counts else 0,
            "max": max(word_counts) if word_counts else 0,
            "average": round(sum(word_counts) / len(word_counts)) if word_counts else 0,
        },
        "structure_to_match": common_structure,
        "must_fill_gaps": must_fill[:10],
        "shared_gap_opportunities": list(dict.fromkeys(shared_gap_opportunities)),
        "differentiation_opportunities": [],
        "data_needed": data_needed,
        "outdated_to_update": outdated,
        "named_entities": _unique_dicts(named_entities, "normalized_name")[:30],
        "price_evidence": _unique_dicts(price_evidence, "quote")[:20],
        "comparison_dimensions": [
            item for item, _count in comparison_dimensions.most_common(12)
        ],
    }


ENTITY_LEADING_PATTERN = re.compile(
    r"^(?:#{1,6}\s+)?(?:\d{1,2}[.)、:-]\s*|[-*+]\s+)?",
    re.IGNORECASE,
)
ENTITY_TRAILING_PATTERN = re.compile(
    r"\s+(?:[-–—|:]\s*)?(?:best|top|ideal|recommended)\s+(?:for|overall\b).*$",
    re.IGNORECASE,
)
GENERIC_ENTITY_PREFIXES = (
    "best ", "top ", "how ", "what ", "why ", "when ", "where ", "which ",
    "our ", "the ", "a guide", "introduction", "conclusion", "summary", "faq",
    "pricing", "price", "cost", "features", "comparison", "reviews", "review",
)
COMPARISON_DIMENSIONS = {
    "price": ("price", "pricing", "cost", "value", "budget"),
    "surface compatibility": ("surface", "material", "leather", "plastic", "fabric"),
    "cleaning performance": ("performance", "cleaning power", "stain", "dirt", "grease"),
    "ease of use": ("ease of use", "application", "spray", "wipe", "setup"),
    "safety": ("safe", "safety", "toxic", "chemical", "ingredient"),
    "scent": ("scent", "smell", "fragrance", "odor"),
    "durability": ("durability", "lasting", "longevity", "protection"),
    "size and capacity": ("size", "capacity", "volume", "weight"),
}


def _extract_named_entities(
    text: str, sections: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    candidates = [str(item.get("heading") or "") for item in sections]
    candidates.extend(
        match.group(1).strip()
        for match in re.finditer(
            r"(?m)^\s*(?:#{2,4}\s*)?(?:\d{1,2}[.)、:-]|[-*+])\s+([^\n]{3,120})$",
            text,
        )
    )
    output: list[dict[str, Any]] = []
    for candidate in candidates:
        name = ENTITY_LEADING_PATTERN.sub("", candidate).strip()
        name = ENTITY_TRAILING_PATTERN.sub("", name).strip(" -–—|:.")
        name = re.sub(r"\s*\([^)]*(?:best|top|price|review)[^)]*\)\s*$", "", name, flags=re.I)
        normalized = re.sub(r"[^a-z0-9]+", " ", name.casefold()).strip()
        words = re.findall(r"[A-Za-z0-9][A-Za-z0-9&'®™.+-]*", name)
        if not (2 <= len(words) <= 12) or len(name) > 100:
            continue
        if normalized.startswith(GENERIC_ENTITY_PREFIXES):
            continue
        brand_signal = any(
            any(char.isupper() for char in word[1:])
            or any(char.isdigit() for char in word)
            or word[:1].isupper()
            for word in words
        )
        if not brand_signal:
            continue
        output.append(
            {
                "name": name,
                "normalized_name": normalized,
                "entity_type": "product_or_brand",
            }
        )
    return _unique_dicts(output, "normalized_name")[:20]


def _extract_price_evidence(text: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    pattern = re.compile(
        r"(?:[$€£¥]\s?\d+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP|CNY))",
        re.IGNORECASE,
    )
    for match in pattern.finditer(text):
        start = max(0, match.start() - 80)
        end = min(len(text), match.end() + 100)
        output.append(
            {
                "value": match.group(0),
                "quote": re.sub(r"\s+", " ", text[start:end]).strip()[:240],
            }
        )
    return _unique_dicts(output, "quote")[:20]


def _extract_comparison_dimensions(
    text: str, sections: list[dict[str, Any]]
) -> list[str]:
    searchable = " ".join(
        [str(item.get("heading") or "") for item in sections]
        + [str(item.get("content") or "") for item in sections]
        + re.findall(r"(?m)^\s*\|([^\n]+)\|\s*$", text)[:10]
    ).casefold()
    return [
        label
        for label, aliases in COMPARISON_DIMENSIONS.items()
        if any(
            re.search(
                rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])",
                searchable,
            )
            for alias in aliases
        )
    ]


def _extract_sections(text: str, heading_structure: list[dict[str, Any]]) -> list[dict[str, Any]]:
    markdown_matches = list(re.finditer(r"(?m)^(#{2,3})\s+(.+?)\s*$", text))
    markers = [
        (match.start(), match.end(), len(match.group(1)), match.group(2).strip())
        for match in markdown_matches
    ]
    if not markers:
        markers = _locate_supplied_headings(text, heading_structure)
    if not markers:
        return [{"heading": "Article", "level": 1, "content": text, "word_count": 0}]

    sections: list[dict[str, Any]] = []
    introduction = text[: markers[0][0]].strip()
    if introduction:
        sections.append(
            {"heading": "Introduction", "level": 1, "content": introduction, "word_count": 0}
        )
    for index, (start, end, level, heading) in enumerate(markers):
        next_start = markers[index + 1][0] if index + 1 < len(markers) else len(text)
        sections.append(
            {
                "heading": heading,
                "level": level,
                "content": text[end:next_start].strip(),
                "word_count": 0,
            }
        )
    return sections


class _ArticleSectionParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[dict[str, Any]] = []
        self._current: dict[str, Any] = {
            "heading": "Introduction",
            "level": 1,
            "parts": [],
        }
        self._heading_level = 0
        self._heading_parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        normalized = tag.casefold()
        if normalized in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
        elif normalized in {"h2", "h3"} and not self._ignored_depth:
            self._heading_level = int(normalized[1])
            self._heading_parts = []

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "noscript", "svg"}:
            self._ignored_depth = max(0, self._ignored_depth - 1)
            return
        if normalized not in {"h2", "h3"} or not self._heading_level:
            return
        heading = _clean_html_text(" ".join(self._heading_parts))
        self._save_current()
        self._current = {"heading": heading, "level": self._heading_level, "parts": []}
        self._heading_level = 0
        self._heading_parts = []

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        if self._heading_level:
            self._heading_parts.append(data)
        else:
            self._current["parts"].append(data)

    def finish(self) -> list[dict[str, Any]]:
        self._save_current()
        return self.sections

    def _save_current(self) -> None:
        heading = str(self._current["heading"]).strip()
        content = _clean_html_text(" ".join(self._current["parts"]))
        if heading and content:
            self.sections.append(
                {
                    "heading": heading,
                    "level": int(self._current["level"]),
                    "content": content,
                    "word_count": 0,
                }
            )


def _extract_html_sections(main_html: str) -> list[dict[str, Any]]:
    if not main_html.strip():
        return []
    parser = _ArticleSectionParser()
    try:
        parser.feed(main_html)
        parser.close()
    except Exception:
        return []
    sections = parser.finish()
    return sections if any(item["level"] in {2, 3} for item in sections) else []


def _clean_html_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _locate_supplied_headings(
    text: str, heading_structure: list[dict[str, Any]]
) -> list[tuple[int, int, int, str]]:
    markers: list[tuple[int, int, int, str]] = []
    cursor = 0
    for item in heading_structure:
        heading = str(item.get("heading") or item.get("text") or "").strip()
        level = int(item.get("level") or 0)
        if not heading or level not in {2, 3}:
            continue
        match = re.search(re.escape(heading), text[cursor:], flags=re.IGNORECASE)
        if not match:
            continue
        start = cursor + match.start()
        end = cursor + match.end()
        markers.append((start, end, level, heading))
        cursor = end
    return markers


def _sentences(text: str) -> list[str]:
    cleaned = re.sub(r"\s+", " ", re.sub(r"(?m)^#{1,6}\s+", "", text)).strip()
    return [
        item.strip()
        for item in re.split(r"(?<=[.!?。！？])\s+", cleaned)
        if item.strip()
    ]


def _word_count(text: str) -> int:
    latin_words = re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text)
    han_characters = re.findall(r"[\u4e00-\u9fff]", text)
    return len(latin_words) + len(han_characters)


def _normalize_heading(value: str) -> str:
    without_markdown = re.sub(r"^#{1,6}\s+", "", value).casefold()
    return re.sub(r"[^\w\u4e00-\u9fff]+", " ", without_markdown).strip()


def _unsupported_claim(content: str) -> str | None:
    for pattern in UNSUPPORTED_PATTERNS:
        match = re.search(pattern, content, flags=re.IGNORECASE)
        if match:
            start = max(0, match.start() - 60)
            end = min(len(content), match.end() + 100)
            return content[start:end].strip()[:240]
    return None


def _outdated_items(content: str, heading: str) -> list[dict[str, Any]]:
    current_year = datetime.now(UTC).year
    output: list[dict[str, Any]] = []
    for match in re.finditer(r"\b(?:19|20)\d{2}\b", content):
        year = int(match.group())
        if year < 2010 or year >= current_year - 1:
            continue
        start = max(0, match.start() - 60)
        end = min(len(content), match.end() + 100)
        output.append(
            {
                "year": year,
                "location": heading,
                "quote": content[start:end].strip()[:240],
            }
        )
    return output


def _structural_gap(
    location: str, opportunity: str, *, priority: str = "medium"
) -> dict[str, Any]:
    return {
        "type": "structural_gap",
        "location": location,
        "priority": priority,
        "description": f"No clear {location.lower()} section",
        "opportunity": opportunity,
    }


def _is_faq_heading(value: str) -> bool:
    return any(item in value for item in ("faq", "frequently asked", "questions", "常见问题", "问答"))


def _is_conclusion_heading(value: str) -> bool:
    return any(
        item in value
        for item in (
            "conclusion",
            "summary",
            "final",
            "next step",
            "结论",
            "总结",
            "下一步",
        )
    )


def _unique_dicts(items: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        value = str(item.get(key) or "")
        if not value or value in seen:
            continue
        seen.add(value)
        output.append(item)
    return output
