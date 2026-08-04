from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import textstat

from app.modules.content.writing_gateway import (
    ArticlePlan,
    EvidenceClaim,
    OutlineSection,
    SectionDraft,
    SectionIssue,
)


LINK_PATTERN = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
LINK_OPEN_PATTERN = re.compile(r"\[([^\]\r\n]+)\]\(\s*(?=https?://)", re.IGNORECASE)
MALFORMED_URL_FRAGMENT_PATTERN = re.compile(
    r"(?:"
    r"https?://[^\s)\]]*\.[ \t]+[^\s)\]]+"
    r"|(?:https?://)?www\.[ \t]+[a-z0-9-]+(?:\.[ \t]*[a-z0-9-]+)*"
    r"(?:/[^\s)\]]*)?(?:\)+)?"
    r"|(?<![\w.-])[a-z][a-z0-9-]*\.[ \t]+"
    r"(?:com|org|net|gov|edu|mil|int|io|co|uk|de|fr|jp|cn|au|ca)"
    r"(?:/[^\s)\]]*)?(?:\)+)?"
    r"|(?<![\w.-])(?:com|org|net|gov|edu|mil|int|io)/[^\s)\]]*(?:\)+)?"
    r")",
    re.IGNORECASE,
)
NUMBER_PATTERN = re.compile(r"(?<![\w])\d+(?:[.,]\d+)?%?")
STRUCTURAL_NUMBER_PATTERN = re.compile(
    r"\b(?:section|step|topic|question|part|chapter)\s+\d+\b|"
    r"第\s*\d+\s*(?:节|步|部分|章|个问题)|"
    r"(?:章节|步骤|主题|问题|部分)\s*\d+",
    re.IGNORECASE,
)
STRONG_CLAIM_PATTERN = re.compile(
    r"\b(?:always|never|guaranteed|proven|the best|the only|completely eliminates?)\b|"
    r"(?:始终|绝不|保证|已证实|唯一|最好|彻底消除|百分之百)",
    re.IGNORECASE,
)
PLACEHOLDER_PATTERN = re.compile(
    r"\b(?:todo|tbd|lorem ipsum|insert (?:source|link|text)|coming soon)\b|"
    r"This section is intentionally concise because verified details were unavailable|"
    r"This section explains the key considerations and practical next steps supported by the verified information available|"
    r"(?:待补充|占位符|稍后补充|未完成|本节根据当前可验证资料说明关键考虑因素和可执行的下一步)",
    re.IGNORECASE,
)
ORDERED_ITEM_PATTERN = re.compile(r"^\s*\d+[.)、]\s+", re.MULTILINE)
LIST_ITEM_PATTERN = re.compile(r"^\s*(?:[-*+]|\d+[.)、])\s+", re.MULTILINE)
QUESTION_LINE_PATTERN = re.compile(
    r"^(?:#{2,6}\s+|(?:q|question|问题)\s*[:：]\s*)?.*[?？]\s*$",
    re.IGNORECASE | re.MULTILINE,
)


class ContentScorer:
    WEIGHTS = {
        "humanity": 0.30,
        "specificity": 0.25,
        "structure_balance": 0.20,
        "seo": 0.15,
        "readability": 0.10,
    }
    PASS_THRESHOLD = 70
    AI_PHRASES = [
        r"\bin today's (?:digital|modern|fast-paced)\b",
        r"\bwhen it comes to\b",
        r"\bit's important to (?:note|remember|understand)\b",
        r"\bin the world of\b",
        r"\blet's dive (?:in|into)\b",
        r"\bfurthermore\b",
        r"\bmoreover\b",
        r"\badditionally\b",
        r"\bin order to\b",
        r"\bdue to the fact that\b",
        r"\bat the end of the day\b",
        r"\bgoing forward\b",
        r"\bleverage\b",
        r"\butilize\b",
        r"\bsynergy\b",
        r"\bholistic\b",
        r"\brobust\b",
        r"\bseamless(?:ly)?\b",
        r"\bgame.?changer\b",
        r"\bunlock(?:ing)? (?:the )?(?:power|potential)\b",
        r"\btake (?:your|it) to the next level\b",
        r"\bjourney\b(?! to\b)",
        r"\blandscape\b",
        r"\bparadigm\b",
        r"\boptimal\b",
        r"\bfacilitate\b",
    ]
    VAGUE_WORDS = [
        r"\bmany\b",
        r"\bsome\b",
        r"\bvarious\b",
        r"\bnumerous\b",
        r"\bseveral\b",
        r"\boften\b",
        r"\bsometimes\b",
        r"\busually\b",
        r"\bgenerally\b",
        r"\btypically\b",
        r"\bsignificant(?:ly)?\b",
        r"\bsubstantial(?:ly)?\b",
        r"\bconsiderable\b",
        r"\bgreat(?:ly)?\b",
        r"\bvery\b",
        r"\breally\b",
        r"\bquite\b",
        r"\brather\b",
        r"\brelatively\b",
        r"\brecently\b",
        r"\bcurrently\b",
        r"\beffective(?:ly)?\b",
        r"\bimportant\b",
        r"\bessential\b",
        r"\bcritical\b",
        r"\bkey\b",
        r"\bcrucial\b",
    ]
    SPECIFICITY_PATTERNS = [
        r"\b\d{1,3}%\b",
        r"\$[\d,]+(?:\.\d{2})?\b",
        r"\b\d{4}\b",
        r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}",
        r"\b\d+(?:,\d{3})*\s*(?:downloads?|listeners?|subscribers?|episodes?|users?|customers?)\b",
        r'(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:said|says|explained|noted|mentioned)',
        r'"[^"]{10,}"',
    ]
    CONVERSATIONAL_PATTERNS = [
        r"\([^)]{5,50}\)",
        r"\?(?:\s|$)",
        r"\bdon't\b",
        r"\bcan't\b",
        r"\bwon't\b",
        r"\byou're\b",
        r"\byou've\b",
        r"\bit's\b",
        r"\bthat's\b",
        r"\bhere's\b",
        r"\blet's\b",
        r"\bI've\b",
        r"\bI'm\b",
        r"\bwe've\b",
        r"\bwe're\b",
        r"(?:^|\.\s+)(?:Look|Here's the thing|The truth is|Sound familiar|Trust me)",
    ]

    def score(self, content: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        metadata = metadata or {}
        clean_content = self._clean_for_analysis(content)
        humanity = self._score_humanity(clean_content)
        specificity = self._score_specificity(clean_content)
        structure = self._score_structure_balance(content)
        seo = self._score_seo(content, metadata)
        readability = self._score_readability(clean_content)
        dimensions = {
            "humanity": humanity,
            "specificity": specificity,
            "structure_balance": structure,
            "seo": seo,
            "readability": readability,
        }
        language = str(metadata.get("language") or "en").casefold()
        english_language = language.startswith("en")
        advisory_dimensions = {"humanity", "structure_balance", "readability"}
        hard_dimensions = {"specificity", "seo"}
        hard_weight = sum(self.WEIGHTS[name] for name in hard_dimensions)
        composite = round(
            sum(
                dimensions[name]["score"] * self.WEIGHTS[name]
                for name in hard_dimensions
            )
            / hard_weight,
            1,
        )
        all_issues: list[dict[str, Any]] = []
        advisories: list[dict[str, Any]] = []
        for dimension, result in dimensions.items():
            for issue in result.get("issues", []):
                tagged = {
                    **issue,
                    "dimension": dimension,
                    "dimension_score": result["score"],
                    "impact": self.WEIGHTS[dimension] * (100 - result["score"]),
                }
                if dimension in advisory_dimensions:
                    advisories.append(tagged)
                else:
                    all_issues.append(tagged)
        priority_fixes = sorted(all_issues, key=lambda item: -item["impact"])[:5]
        return {
            "composite_score": composite,
            "passed": composite >= self.PASS_THRESHOLD,
            "threshold": self.PASS_THRESHOLD,
            "dimensions": {
                name: {
                    "score": result["score"],
                    "weight": self.WEIGHTS[name],
                    **(
                        {"prose_ratio": result.get("prose_ratio", 0)}
                        if name == "structure_balance"
                        else {}
                    ),
                    **({"flesch": result.get("flesch", 0)} if name == "readability" else {}),
                    "issues": result.get("issues", []),
                    "details": result.get("details", {}),
                }
                for name, result in dimensions.items()
            },
            "priority_fixes": priority_fixes,
            "advisories": sorted(advisories, key=lambda item: -item["impact"]),
            "language": language,
            "english_readability_applicable": english_language,
        }

    @staticmethod
    def _clean_for_analysis(content: str) -> str:
        text = re.sub(r"^\*\*[^*]+\*\*:\s*.+$", "", content, flags=re.MULTILINE)
        text = re.sub(r"^---+\s*$", "", text, flags=re.MULTILINE)
        text = re.sub(r"```[^`]*```", "", text)
        text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
        text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
        text = re.sub(r"\*([^*]+)\*", r"\1", text)
        text = re.sub(r"^#+\s+", "", text, flags=re.MULTILINE)
        return text.strip()

    def _score_humanity(self, content: str) -> dict[str, Any]:
        issues: list[dict[str, str]] = []
        content_lower = content.lower()
        word_count = len(content.split())
        found: list[str] = []
        phrase_count = 0
        for pattern in self.AI_PHRASES:
            matches = re.findall(pattern, content_lower)
            phrase_count += len(matches)
            if matches:
                found.extend(matches[:2])
        ai_density = phrase_count / max(word_count, 1) * 1000
        conversational_count = sum(
            len(re.findall(pattern, content, re.IGNORECASE))
            for pattern in self.CONVERSATIONAL_PATTERNS
        )
        conversational_density = conversational_count / max(word_count, 1) * 1000
        passive_count = len(
            re.findall(r"\b(?:is|are|was|were|been|being)\s+\w+ed\b", content_lower)
        )
        passive_ratio = passive_count / max(word_count / 100, 1)
        contractions = len(re.findall(r"'(?:t|s|re|ve|ll|d|m)\b", content))
        contraction_density = contractions / max(word_count, 1) * 100
        score = 100.0
        if ai_density > 5:
            score -= min(30, (ai_density - 5) * 3)
            issues.append(
                {
                    "issue": f"AI phrases detected ({phrase_count} instances)",
                    "fix": f"Remove or rephrase: {', '.join(found[:3])}",
                    "severity": "high" if ai_density > 10 else "medium",
                }
            )
        if passive_ratio > 2:
            score -= min(15, (passive_ratio - 2) * 5)
            issues.append(
                {
                    "issue": "High passive voice usage",
                    "fix": "Convert passive sentences to active voice",
                    "severity": "medium",
                }
            )
        if conversational_density > 3:
            score = min(100, score + min(15, (conversational_density - 3) * 2))
        if contraction_density < 1:
            score -= 10
            issues.append(
                {
                    "issue": "Lacks contractions (sounds formal)",
                    "fix": "Use contractions like don't, can't, you're, it's",
                    "severity": "low",
                }
            )
        return {
            "score": max(0, min(100, round(score))),
            "issues": issues,
            "details": {
                "ai_phrases_per_1000": round(ai_density, 1),
                "ai_phrases_found": found[:5],
                "conversational_per_1000": round(conversational_density, 1),
                "passive_voice_ratio": round(passive_ratio, 2),
                "contractions_per_100": round(contraction_density, 1),
            },
        }

    def _score_specificity(self, content: str) -> dict[str, Any]:
        issues: list[dict[str, str]] = []
        content_lower = content.lower()
        word_count = len(content.split())
        vague_count = 0
        found: list[str] = []
        for pattern in self.VAGUE_WORDS:
            matches = re.findall(pattern, content_lower)
            vague_count += len(matches)
            if matches and len(found) < 5:
                found.extend(matches[:2])
        vague_density = vague_count / max(word_count, 1) * 1000
        specific_count = sum(
            len(re.findall(pattern, content)) for pattern in self.SPECIFICITY_PATTERNS
        )
        specific_density = specific_count / max(word_count, 1) * 1000
        numbers = re.findall(r"\b\d+(?:,\d{3})*(?:\.\d+)?\b", content)
        number_density = len(numbers) / max(word_count, 1) * 1000
        score = 70.0
        if vague_density > 15:
            score -= min(25, (vague_density - 15) * 1.5)
            issues.append(
                {
                    "issue": f"Too many vague words ({vague_count} instances)",
                    "fix": f"Replace vague words with specifics: {', '.join(found[:3])}",
                    "severity": "high" if vague_density > 25 else "medium",
                }
            )
        if specific_density > 2:
            score += min(30, specific_density * 5)
        if number_density < 3:
            score -= min(15, (3 - number_density) * 5)
            issues.append(
                {
                    "issue": "Lacks specific numbers and data",
                    "fix": "Add percentages, dollar amounts, dates, or counts",
                    "severity": "medium",
                }
            )
        return {
            "score": max(0, min(100, round(score))),
            "issues": issues,
            "details": {
                "vague_words_per_1000": round(vague_density, 1),
                "vague_words_found": list(set(found))[:5],
                "specifics_per_1000": round(specific_density, 1),
                "numbers_per_1000": round(number_density, 1),
            },
        }

    @staticmethod
    def _score_structure_balance(content: str) -> dict[str, Any]:
        issues: list[dict[str, str]] = []
        content = re.sub(r"^\*\*[^*]+\*\*:\s*.+$", "", content, flags=re.MULTILINE)
        content = re.sub(r"^---+\s*$", "", content, flags=re.MULTILINE)
        list_chars = table_chars = header_chars = total_chars = 0
        for line in content.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            count = len(stripped)
            total_chars += count
            if re.match(r"^[-*+]\s", stripped) or re.match(r"^\d+\.\s", stripped):
                list_chars += count
            elif "|" in stripped:
                table_chars += count
            elif re.match(r"^#+\s", stripped):
                header_chars += count
        prose_chars = total_chars - list_chars - table_chars - header_chars
        prose_ratio = prose_chars / max(total_chars - header_chars, 1)
        if 0.50 <= prose_ratio <= 0.75:
            score = 100
        elif prose_ratio < 0.50:
            score = max(0, 100 - (0.50 - prose_ratio) * 150)
            issues.append(
                {
                    "issue": f"Too much structure ({round(prose_ratio * 100)}% prose, target 50-75%)",
                    "fix": "Convert some bullet lists or tables to prose paragraphs",
                    "severity": "high" if prose_ratio < 0.35 else "medium",
                }
            )
        else:
            score = max(0, 100 - (prose_ratio - 0.75) * 100)
            issues.append(
                {
                    "issue": f"Too much prose ({round(prose_ratio * 100)}% prose, target 50-75%)",
                    "fix": "Add tables for comparisons, lists for features, or visual breaks",
                    "severity": "medium" if prose_ratio < 0.90 else "high",
                }
            )
        return {
            "score": round(score),
            "prose_ratio": round(prose_ratio, 2),
            "issues": issues,
            "details": {
                "prose_ratio": round(prose_ratio, 2),
                "list_ratio": round(list_chars / max(total_chars, 1), 2),
                "table_ratio": round(table_chars / max(total_chars, 1), 2),
                "prose_chars": prose_chars,
                "list_chars": list_chars,
                "table_chars": table_chars,
            },
        }

    def _score_seo(self, content: str, metadata: dict[str, Any]) -> dict[str, Any]:
        issues: list[dict[str, str]] = []
        meta_title = str(metadata.get("meta_title") or "")
        meta_description = str(metadata.get("meta_description") or "")
        primary_keyword = str(metadata.get("primary_keyword") or "")
        if not meta_title:
            match = re.search(r"\*\*Meta Title\*\*:\s*(.+)", content)
            if match:
                meta_title = match.group(1).strip()
        if not meta_description:
            match = re.search(r"\*\*Meta Description\*\*:\s*(.+)", content)
            if match:
                meta_description = match.group(1).strip()
        if not primary_keyword:
            match = re.search(r"\*\*(?:Target|Primary) Keyword\*\*:\s*(.+)", content)
            if match:
                primary_keyword = match.group(1).strip()
        score = 100
        if not meta_title:
            score -= 15
            issues.append({"issue": "Missing meta title", "fix": "Add a meta title (50-60 characters)", "severity": "high"})
        elif len(meta_title) < 50:
            score -= 5
            issues.append({"issue": f"Meta title too short ({len(meta_title)} chars)", "fix": "Expand meta title to 50-60 characters", "severity": "low"})
        elif len(meta_title) > 60:
            score -= 5
            issues.append({"issue": f"Meta title too long ({len(meta_title)} chars)", "fix": "Shorten meta title to 50-60 characters", "severity": "low"})
        if not meta_description:
            score -= 15
            issues.append({"issue": "Missing meta description", "fix": "Add a meta description (150-160 characters)", "severity": "high"})
        elif len(meta_description) < 150 or len(meta_description) > 160:
            score -= 5
        h1 = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
        if h1:
            if primary_keyword and primary_keyword.lower() not in h1.group(1).lower():
                score -= 10
                issues.append({"issue": "Primary keyword not in H1", "fix": f'Include "{primary_keyword}" in the H1 headline', "severity": "medium"})
        else:
            score -= 10
            issues.append({"issue": "Missing H1 headline", "fix": "Add an H1 headline with primary keyword", "severity": "high"})
        clean = self._clean_for_analysis(content)
        if primary_keyword and primary_keyword.lower() not in " ".join(clean.split()[:100]).lower():
            score -= 10
            issues.append({"issue": "Primary keyword not in first 100 words", "fix": f'Include "{primary_keyword}" in the introduction', "severity": "medium"})
        word_count = len(clean.split())
        return {
            "score": max(0, min(100, round(score))),
            "issues": issues,
            "details": {
                "meta_title": meta_title,
                "meta_title_length": len(meta_title),
                "meta_description": meta_description[:100] + "..." if len(meta_description) > 100 else meta_description,
                "meta_description_length": len(meta_description),
                "primary_keyword": primary_keyword,
                "h1": h1.group(1) if h1 else "",
                "word_count": word_count,
            },
        }

    def _score_readability(self, content: str) -> dict[str, Any]:
        issues: list[dict[str, str]] = []
        try:
            flesch = round(textstat.flesch_reading_ease(content), 1)
            grade = round(textstat.flesch_kincaid_grade(content), 1)
        except Exception:
            flesch = 0
            grade = 0
        score = 100.0
        if flesch < 50:
            score -= min(30, (50 - flesch) * 1.5)
            issues.append({"issue": f"Content too difficult (Flesch: {flesch})", "fix": "Simplify sentences, use shorter words", "severity": "high" if flesch < 40 else "medium"})
        elif flesch < 60:
            score -= 10
            issues.append({"issue": f"Content slightly difficult (Flesch: {flesch})", "fix": "Simplify some complex sentences", "severity": "low"})
        elif flesch > 80:
            score -= 5
        if grade > 12:
            score -= 10
            issues.append({"issue": f"Reading level too high (Grade {grade})", "fix": "Target 8th-10th grade reading level", "severity": "medium"})
        paragraphs = self._check_paragraph_length(content)
        if paragraphs["count"] > 0:
            score -= min(15, paragraphs["count"] * 3)
            issues.append({"issue": f'{paragraphs["count"]} paragraphs exceed 4 sentences (longest: {paragraphs["longest"]})', "fix": "Break long paragraphs into smaller chunks (2-4 sentences max)", "severity": "medium" if paragraphs["count"] < 5 else "high"})
        rhythm = self._check_sentence_rhythm(content)
        if rhythm["rhythm_score"] < 60:
            score -= min(10, (60 - rhythm["rhythm_score"]) / 4)
            issues.append({"issue": f'Monotonous sentence rhythm ({rhythm["monotonous_count"]} uniform sections)', "fix": "Vary sentence length: mix short punchy (5-10 words) with longer flowing (15-25 words)", "severity": "medium" if rhythm["rhythm_score"] > 40 else "high"})
        return {
            "score": max(0, min(100, round(score))),
            "flesch": flesch,
            "issues": issues,
            "details": {
                "flesch_reading_ease": flesch,
                "grade_level": grade,
                "long_paragraphs": paragraphs["count"],
                "longest_paragraph_sentences": paragraphs["longest"],
                "rhythm_score": rhythm["rhythm_score"],
                "monotonous_sections": rhythm["monotonous_count"],
            },
        }

    @staticmethod
    def _check_paragraph_length(content: str) -> dict[str, int]:
        long_paragraphs = longest = 0
        for paragraph in re.split(r"\n\s*\n", content):
            paragraph = paragraph.strip()
            if not paragraph or paragraph.startswith(("#", "-", "*", "|", "**Meta")):
                continue
            sentences = [
                item.strip()
                for item in re.split(r"[.!?]+(?:\s|$)", paragraph)
                if item.strip() and len(item.strip()) > 10
            ]
            if len(sentences) > 4:
                long_paragraphs += 1
                longest = max(longest, len(sentences))
        return {"count": long_paragraphs, "longest": longest}

    @staticmethod
    def _check_sentence_rhythm(content: str) -> dict[str, int | float]:
        sentences = [
            item.strip()
            for item in re.split(r"[.!?]+(?:\s|$)", content)
            if item.strip() and len(item.strip()) > 5
        ]
        if len(sentences) < 10:
            return {"rhythm_score": 70, "monotonous_count": 0, "std_dev": 0}
        counts = [len(item.split()) for item in sentences]
        monotonous = 0
        for index in range(len(counts) - 4):
            window = counts[index : index + 5]
            average = sum(window) / len(window)
            if all(abs(count - average) <= 5 for count in window):
                monotonous += 1
        mean = sum(counts) / len(counts)
        std_dev = (sum((count - mean) ** 2 for count in counts) / len(counts)) ** 0.5
        if std_dev < 5:
            score = 40 + std_dev * 6
        elif std_dev <= 15:
            score = 100 - abs(10 - std_dev) * 2
        else:
            score = 80
        score = max(0, min(100, score - monotonous * 3))
        return {
            "rhythm_score": round(score),
            "monotonous_count": monotonous,
            "std_dev": round(std_dev, 1),
        }


@dataclass(frozen=True)
class QualityReport:
    passed: bool
    issues: list[SectionIssue]
    checks: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "issues": [item.model_dump(mode="json") for item in self.issues],
            "checks": self.checks,
        }


def deterministic_quality_check(
    plan: ArticlePlan,
    sections: list[SectionDraft],
    *,
    allowed_source_urls: set[str],
    allowed_internal_urls: set[str],
    competitor_passages: list[str] | None = None,
) -> QualityReport:
    issues: list[SectionIssue] = []
    article_section_id = plan.sections[0].section_id
    if not plan.title.strip():
        issues.append(_issue(article_section_id, "title_missing", "文章标题缺失"))
    if not plan.meta_title.strip():
        issues.append(_issue(article_section_id, "meta_title_missing", "Meta title 缺失"))
    if not plan.meta_description.strip():
        issues.append(
            _issue(article_section_id, "meta_description_missing", "Meta description 缺失")
        )
    if not plan.slug.strip():
        issues.append(_issue(article_section_id, "slug_missing", "slug 缺失"))
    contract_sections = {
        item.section_id: item for item in plan.contract.sections
    } if plan.contract is not None else {}
    expected = set(contract_sections) or {item.section_id for item in plan.sections}
    actual = {item.section_id for item in sections if item.markdown.strip()}
    for section_id in sorted(expected - actual):
        issues.append(_issue(section_id, "section_missing", "必要章节缺失或为空"))

    known_claims = {
        item.claim_id: item
        for item in plan.claims
        if item.supported
        and item.section_id is not None
        and item.source_url in allowed_source_urls
    }
    seen_markdown: set[str] = set()
    duplicate_sections = 0
    unsupported_numbers = 0
    unsupported_strong_claims = 0
    invalid_links = 0
    placeholders = 0
    invalid_heading_sections = 0
    copied_competitor_sections = 0
    short_sections = 0
    invalid_section_structures = 0
    planned_sections = {item.section_id: item for item in plan.sections}
    seen_internal_urls: set[str] = set()
    internal_link_count = 0
    for section in sections:
        normalized = re.sub(r"\s+", " ", section.markdown).strip().casefold()
        if normalized in seen_markdown:
            duplicate_sections += 1
            issues.append(
                _issue(section.section_id, "duplicate_section", "章节与其他章节明显重复")
            )
        seen_markdown.add(normalized)
        heading_levels = [
            len(match.group(1))
            for match in re.finditer(r"^(#{1,6})\s+", section.markdown, re.MULTILINE)
        ]
        if (
            not heading_levels
            or heading_levels[0] != 2
            or 1 in heading_levels
            or any(current > previous + 1 for previous, current in zip(heading_levels, heading_levels[1:]))
        ):
            invalid_heading_sections += 1
            issues.append(
                _issue(section.section_id, "invalid_heading_hierarchy", "Markdown 标题层级不正确")
            )
        if PLACEHOLDER_PATTERN.search(section.markdown):
            placeholders += 1
            issues.append(
                _issue(section.section_id, "placeholder", "章节包含占位符或未完成标记")
            )
        if section.summary.startswith("degraded_fallback:"):
            placeholders += 1
            issues.append(
                _issue(
                    section.section_id,
                    "fallback_section",
                    "章节使用了确定性降级稿，需要自动重写并重新检查",
                )
            )
        if any(
            _has_long_exact_overlap(section.markdown, passage)
            for passage in competitor_passages or []
        ):
            copied_competitor_sections += 1
            issues.append(
                _issue(
                    section.section_id,
                    "competitor_copy",
                    "章节包含与竞争文章相同的长段文本",
                )
            )

        planned = planned_sections.get(section.section_id)
        if planned is not None:
            word_count = _content_word_count(section.markdown)
            minimum_words = max(70, round(planned.word_target * 0.7))
            if word_count < minimum_words:
                short_sections += 1
                issues.append(
                    _issue(
                        section.section_id,
                        "section_too_short",
                        f"章节约 {word_count} 词，低于 {planned.word_target} 词目标的合理下限",
                    )
                )
            structure_issue = _section_structure_issue(planned, section.markdown)
            if structure_issue is not None:
                invalid_section_structures += 1
                issues.append(_issue(section.section_id, *structure_issue))

        planned_claim_ids = set(planned.claim_ids) if planned is not None else set()
        section_claims = {
            claim_id: claim
            for claim_id, claim in known_claims.items()
            if claim.section_id == section.section_id and claim_id in planned_claim_ids
        }
        section_source_urls = {
            claim.source_url for claim in section_claims.values()
        }
        used_claims = {
            claim_id: section_claims[claim_id]
            for claim_id in section.used_claim_ids
            if claim_id in section_claims
        }
        for paragraph in _paragraphs(section.markdown):
            if re.match(r"^#{1,6}\s+", paragraph):
                continue
            has_number = _has_verifiable_number(paragraph)
            has_strong_claim = _has_strong_claim(paragraph)
            if not has_number and not has_strong_claim:
                continue
            if not _paragraph_supported_by_claim(paragraph, used_claims.values()):
                code = "unsupported_number" if has_number else "unsupported_strong_claim"
                message = (
                    "具体数字与附近 claim_id 绑定的来源证据不一致"
                    if has_number
                    else "强结论与附近 claim_id 绑定的来源证据不一致"
                )
                unsupported_numbers += int(has_number)
                unsupported_strong_claims += int(has_strong_claim and not has_number)
                issues.append(
                    _issue(section.section_id, code, message)
                )
                break

        malformed_links = malformed_link_count(section.markdown)
        if malformed_links:
            invalid_links += malformed_links
            issues.append(
                _issue(
                    section.section_id,
                    "malformed_link",
                    "正文包含残缺或带空格的 Markdown 链接",
                )
            )

        section_internal_urls = (
            set(planned.internal_urls).intersection(allowed_internal_urls)
            if planned is not None
            else set()
        )
        section_internal_count = 0
        for _, url in LINK_PATTERN.findall(section.markdown):
            if url in allowed_source_urls and url not in section_source_urls:
                invalid_links += 1
                issues.append(
                    _issue(
                        section.section_id,
                        "source_not_assigned_to_section",
                        "正文引用的来源没有分配给当前章节",
                    )
                )
                break
            if url in allowed_internal_urls:
                section_internal_count += 1
                internal_link_count += 1
                if url not in section_internal_urls:
                    invalid_links += 1
                    issues.append(
                        _issue(
                            section.section_id,
                            "internal_link_not_assigned_to_section",
                            "站内链接没有分配给当前章节",
                        )
                    )
                elif url in seen_internal_urls:
                    invalid_links += 1
                    issues.append(
                        _issue(
                            section.section_id,
                            "duplicate_internal_link",
                            "同一个站内链接在全文重复使用",
                        )
                    )
                seen_internal_urls.add(url)
                if section_internal_count > 1:
                    invalid_links += 1
                    issues.append(
                        _issue(
                            section.section_id,
                            "too_many_internal_links_in_section",
                            "每个章节最多插入一个站内链接",
                        )
                    )
                if internal_link_count > 5:
                    invalid_links += 1
                    issues.append(
                        _issue(
                            section.section_id,
                            "too_many_internal_links",
                            "全文最多插入五个站内链接",
                        )
                    )
            elif url not in section_source_urls:
                invalid_links += 1
                issues.append(
                    _issue(section.section_id, "invalid_link", "正文包含本次资料之外的链接")
                )
                break

    return QualityReport(
        passed=not issues,
        issues=_unique_issues(issues),
        checks={
            "expected_sections": len(expected),
            "present_sections": len(actual),
            "unsupported_numbers": unsupported_numbers,
            "unsupported_strong_claims": unsupported_strong_claims,
            "invalid_links": invalid_links,
            "placeholders": placeholders,
            "duplicate_sections": duplicate_sections,
            "invalid_heading_sections": invalid_heading_sections,
            "copied_competitor_sections": copied_competitor_sections,
            "short_sections": short_sections,
            "invalid_section_structures": invalid_section_structures,
            "meta_complete": bool(
                plan.title.strip()
                and plan.meta_title.strip()
                and plan.meta_description.strip()
                and plan.slug.strip()
            ),
        },
    )


def sanitize_sections(
    sections: list[SectionDraft],
    plan: ArticlePlan,
    *,
    allowed_source_urls: set[str],
    allowed_internal_urls: set[str],
) -> list[SectionDraft]:
    known_claims = {
        item.claim_id: item
        for item in plan.claims
        if item.supported
        and item.section_id is not None
        and item.source_url in allowed_source_urls
    }
    planned_sections = {item.section_id: item for item in plan.sections}
    sanitized: list[SectionDraft] = []
    seen_internal_urls: set[str] = set()
    for section in sections:
        planned = planned_sections.get(section.section_id)
        planned_claim_ids = set(planned.claim_ids) if planned is not None else set()
        section_claims = {
            claim_id: claim
            for claim_id, claim in known_claims.items()
            if claim.section_id == section.section_id and claim_id in planned_claim_ids
        }
        section_source_urls = {
            claim.source_url for claim in section_claims.values()
        }
        used_claim_ids = [
            item for item in section.used_claim_ids if item in section_claims
        ]
        used_claims = [section_claims[item] for item in used_claim_ids]
        section_internal_urls = (
            set(planned.internal_urls).intersection(allowed_internal_urls)
            if planned is not None
            else set()
        )
        markdown = sanitize_allowed_links(
            section.markdown, section_source_urls | section_internal_urls
        )
        markdown, used_internal_urls, _ = sanitize_internal_links(
            markdown,
            section_internal_urls,
            seen_internal_urls,
            remaining=max(0, 5 - len(seen_internal_urls)),
        )
        markdown, _ = restore_link_only_claims(markdown, used_claims)
        kept: list[str] = []
        for paragraph in _paragraphs(markdown):
            if PLACEHOLDER_PATTERN.search(paragraph):
                continue
            is_heading = bool(re.match(r"^#{1,6}\s+", paragraph))
            if not is_heading and (
                _has_verifiable_number(paragraph) or _has_strong_claim(paragraph)
            ):
                if not _paragraph_supported_by_claim(paragraph, used_claims):
                    paragraph = _remove_unsupported_sentences(paragraph, used_claims)
            if paragraph.strip():
                kept.append(paragraph.strip())
        cleaned = "\n\n".join(kept).strip()
        fallback_summary = section.summary
        if not cleaned:
            heading = planned.heading if planned is not None else "Article section"
            objective = planned.objective if planned is not None else "Explain the topic"
            cleaned = (
                f"## {heading}\n\n{objective.rstrip('.')}。"
                "当前资料不足以支持具体数字或强结论，因此这里只保留可执行的判断方向："
                "先核对自身条件，再依据已验证资料作出选择。"
            )
            fallback_summary = f"degraded_fallback:{objective}"
        sanitized.append(
            section.model_copy(
                update={
                    "markdown": cleaned,
                    "summary": fallback_summary,
                    "used_claim_ids": used_claim_ids,
                    "used_source_urls": [
                        url for url in section.used_source_urls if url in section_source_urls
                    ],
                    "used_internal_urls": [
                        url for url in sorted(used_internal_urls)
                    ],
                }
            )
        )
    return sanitized


def article_markdown(title: str, sections: list[SectionDraft]) -> str:
    body = "\n\n".join(item.markdown.strip() for item in sections if item.markdown.strip())
    return f"# {title.strip()}\n\n{body}\n"


def markdown_to_html(markdown: str) -> str:
    output: list[str] = []
    paragraph: list[str] = []
    list_items: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            output.append(f"<p>{_inline_html(' '.join(paragraph))}</p>")
            paragraph.clear()

    def flush_list() -> None:
        if list_items:
            output.append("<ul>" + "".join(f"<li>{item}</li>" for item in list_items) + "</ul>")
            list_items.clear()

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line:
            flush_paragraph()
            flush_list()
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1))
            output.append(f"<h{level}>{_inline_html(heading.group(2))}</h{level}>")
            continue
        item = re.match(r"^[-*]\s+(.+)$", line)
        if item:
            flush_paragraph()
            list_items.append(_inline_html(item.group(1)))
            continue
        flush_list()
        paragraph.append(line)
    flush_paragraph()
    flush_list()
    return "\n".join(output)


def project_domain_matches(url: str, project_domain: str) -> bool:
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    expected = project_domain.lower().removeprefix("www.")
    return bool(host and expected and host == expected)


def _paragraphs(markdown: str) -> list[str]:
    return [item.strip() for item in re.split(r"\n\s*\n", markdown) if item.strip()]


def _remove_unsupported_sentences(paragraph: str, claims: list[Any]) -> str:
    parts = re.split(r"(?<=[.!?。！？])\s*", paragraph)
    return " ".join(
        item
        for item in parts
        if item
        and (
            not _has_verifiable_number(item)
            and not _has_strong_claim(item)
            or _paragraph_supported_by_claim(item, claims)
        )
    ).strip()


def _paragraph_supported_by_claim(paragraph: str, claims: Any) -> bool:
    cited_urls = {url for _, url in LINK_PATTERN.findall(paragraph)}
    matching_claims = [claim for claim in claims if claim.source_url in cited_urls]
    if not matching_claims:
        return False
    visible_paragraph = _visible_markdown_text(paragraph)
    evidence = " ".join(
        f"{claim.claim} {claim.quote}" for claim in matching_claims
    ).casefold()
    paragraph_numbers = {
        _normalize_number(match.group(0))
        for match in NUMBER_PATTERN.finditer(visible_paragraph)
    }
    evidence_numbers = {
        _normalize_number(match.group(0)) for match in NUMBER_PATTERN.finditer(evidence)
    }
    if not paragraph_numbers.issubset(evidence_numbers):
        return False
    strong_terms = {
        match.group(0).casefold()
        for match in STRONG_CLAIM_PATTERN.finditer(visible_paragraph)
    }
    return all(term in evidence for term in strong_terms)


def _normalize_number(value: str) -> str:
    return value.replace(",", "").casefold()


def _has_verifiable_number(value: str) -> bool:
    without_structure_labels = STRUCTURAL_NUMBER_PATTERN.sub(
        "", _visible_markdown_text(value)
    )
    without_list_markers = ORDERED_ITEM_PATTERN.sub("", without_structure_labels)
    return bool(NUMBER_PATTERN.search(without_list_markers))


def _has_strong_claim(value: str) -> bool:
    return bool(STRONG_CLAIM_PATTERN.search(_visible_markdown_text(value)))


def _visible_markdown_text(value: str) -> str:
    return LINK_PATTERN.sub(r"\1", value)


def _content_word_count(markdown: str) -> int:
    text = LINK_PATTERN.sub(r"\1", markdown)
    text = re.sub(r"(?m)^#{1,6}\s+", "", text)
    latin_words = re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text)
    han_characters = re.findall(r"[\u4e00-\u9fff]", text)
    return len(latin_words) + len(han_characters)


def _section_structure_issue(
    planned: OutlineSection, markdown: str
) -> tuple[str, str] | None:
    section_type = planned.section_type
    if section_type == "body_how_to" and len(ORDERED_ITEM_PATTERN.findall(markdown)) < 2:
        return "how_to_steps_missing", "How-To 章节缺少至少两个按顺序编号的可执行步骤"
    if section_type == "body_list" and len(LIST_ITEM_PATTERN.findall(markdown)) < 2:
        return "list_structure_missing", "列表章节缺少至少两个格式一致的列表项"
    if section_type == "faq":
        expected_questions = len(planned.required_questions)
        if len(QUESTION_LINE_PATTERN.findall(markdown)) < expected_questions:
            return (
                "faq_qa_structure_missing",
                f"FAQ 章节缺少计划中的 {expected_questions} 组真实问题和回答结构",
            )
    if section_type == "conclusion" and len(LIST_ITEM_PATTERN.findall(markdown)) < 3:
        return "conclusion_actions_missing", "结论章节缺少三到五个具体行动项"
    return None


def _has_long_exact_overlap(value: str, reference: str) -> bool:
    value_words = re.findall(r"[a-z0-9]+", value.casefold())
    reference_words = re.findall(r"[a-z0-9]+", reference.casefold())
    if len(value_words) >= 16 and len(reference_words) >= 16:
        value_text = " ".join(value_words)
        for index in range(len(reference_words) - 15):
            if " ".join(reference_words[index : index + 16]) in value_text:
                return True

    value_cjk = "".join(re.findall(r"[\u4e00-\u9fff]", value))
    reference_cjk = "".join(re.findall(r"[\u4e00-\u9fff]", reference))
    if len(value_cjk) >= 60 and len(reference_cjk) >= 60:
        return any(
            reference_cjk[index : index + 60] in value_cjk
            for index in range(len(reference_cjk) - 59)
        )
    return False


def _sanitize_links(markdown: str, allowed_urls: set[str]) -> str:
    markdown, _ = sanitize_markdown_links(markdown, allowed_urls)

    def replace(match: re.Match[str]) -> str:
        label, url = match.groups()
        return match.group(0) if url in allowed_urls else label

    return LINK_PATTERN.sub(replace, markdown)


def sanitize_allowed_links(markdown: str, allowed_urls: set[str]) -> str:
    return _sanitize_links(markdown, allowed_urls)


def sanitize_internal_links(
    markdown: str,
    allowed_internal_urls: set[str],
    seen_internal_urls: set[str],
    *,
    remaining: int,
) -> tuple[str, set[str], int]:
    used: set[str] = set()
    removed = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal removed
        label, url = match.groups()
        if url not in allowed_internal_urls:
            return match.group(0)
        if url in seen_internal_urls or used or len(used) >= remaining:
            removed += 1
            return label
        used.add(url)
        return match.group(0)

    cleaned = LINK_PATTERN.sub(replace, markdown)
    seen_internal_urls.update(used)
    return cleaned, used, removed


def malformed_link_count(markdown: str) -> int:
    openings = _malformed_link_openings(markdown)
    fragments = [
        match
        for match in MALFORMED_URL_FRAGMENT_PATTERN.finditer(markdown)
        if not any(
            opening.end() <= match.start() < _line_end(markdown, opening.end())
            for opening in openings
        )
    ]
    return len(openings) + len(fragments)


def _malformed_link_openings(markdown: str) -> list[re.Match[str]]:
    return [
        match
        for match in LINK_OPEN_PATTERN.finditer(markdown)
        if LINK_PATTERN.match(markdown, match.start()) is None
    ]


def sanitize_markdown_links(markdown: str, allowed_urls: set[str]) -> tuple[str, int]:
    malformed = _malformed_link_openings(markdown)
    for match in reversed(malformed):
        line_end = markdown.find("\n", match.end())
        if line_end < 0:
            line_end = len(markdown)
        remainder = markdown[match.end():line_end]
        recovered = _recover_allowed_url(remainder, allowed_urls)
        if recovered is not None:
            recovered_url, consumed = recovered
            destination_end = match.end() + consumed
        else:
            recovered_url = None
            destination_end = _malformed_destination_end(
                markdown, match.end(), line_end
            )
        replacement = (
            f"[{match.group(1)}]({recovered_url})"
            if recovered_url is not None
            else match.group(1)
        )
        markdown = markdown[: match.start()] + replacement + markdown[destination_end:]
    markdown, fragment_count = MALFORMED_URL_FRAGMENT_PATTERN.subn("", markdown)
    markdown = re.sub(r"(?m)^[ \t]*[).,;:!?]+[ \t]*$", "", markdown)
    return markdown, len(malformed) + fragment_count


def restore_link_only_claims(
    markdown: str, claims: list[EvidenceClaim]
) -> tuple[str, int]:
    claims_by_url: dict[str, list[EvidenceClaim]] = {}
    for claim in claims:
        if claim.supported:
            claims_by_url.setdefault(claim.source_url, []).append(claim)

    restored = 0
    parts = re.split(r"(\n\s*\n)", markdown)
    for index in range(0, len(parts), 2):
        paragraph = parts[index].strip()
        link_only = re.fullmatch(
            r"\(?\s*(\[[^\]]+\]\((https?://[^\s)]+)\))\s*\)?[.!]?",
            paragraph,
        )
        if link_only is None:
            continue
        matching_claims = claims_by_url.get(link_only.group(2), [])
        if len(matching_claims) != 1:
            continue
        claim_text = matching_claims[0].claim.strip().rstrip(".!?。！？")
        parts[index] = f"{claim_text}. ({link_only.group(1)})."
        restored += 1
    return "".join(parts), restored


def _recover_allowed_url(
    remainder: str, allowed_urls: set[str]
) -> tuple[str, int] | None:
    recovered: list[tuple[str, int]] = []
    for url in sorted(allowed_urls):
        spaced_url = r"[ \t]*".join(re.escape(character) for character in url)
        match = re.match(rf"[ \t]*{spaced_url}", remainder, re.IGNORECASE)
        if match is None:
            continue
        tail = remainder[match.end():]
        boundary = re.match(r"[ \t]*(?:\)|[.,;!?]|$)", tail)
        if boundary is None:
            continue
        consumed = match.end()
        closing = re.match(r"[ \t]*\)", tail)
        if closing is not None:
            consumed += closing.end()
        recovered.append((url, consumed))
    if not recovered:
        candidate, consumed = _malformed_destination_candidate(remainder)
        compact_candidate = re.sub(r"[ \t]+", "", candidate).casefold()
        prefix_matches = [
            url
            for url in allowed_urls
            if compact_candidate and url.casefold().startswith(compact_candidate)
        ]
        if len(prefix_matches) == 1:
            recovered.append((prefix_matches[0], consumed))
    return recovered[0] if len(recovered) == 1 else None


def _malformed_destination_end(markdown: str, start: int, line_end: int) -> int:
    remainder = markdown[start:line_end]
    closing = remainder.find(")")
    if closing >= 0:
        return start + closing + 1
    _, consumed = _malformed_destination_candidate(remainder)
    if not consumed:
        return start
    return start + consumed


def _malformed_destination_candidate(remainder: str) -> tuple[str, int]:
    destination = re.match(r"[ \t]*https?://[^\s)]+", remainder, re.IGNORECASE)
    if destination is None:
        return "", 0
    consumed = destination.end()
    candidate = destination.group(0)
    compact = re.sub(r"[ \t]+", "", candidate)
    while compact.endswith("."):
        continuation = re.match(r"[ \t]+([^\s)]+)", remainder[consumed:])
        if continuation is None:
            break
        candidate += continuation.group(0)
        compact += continuation.group(1)
        consumed += continuation.end()
    return candidate, consumed


def _line_end(markdown: str, start: int) -> int:
    line_end = markdown.find("\n", start)
    return len(markdown) if line_end < 0 else line_end


def _inline_html(value: str) -> str:
    escaped = html.escape(value, quote=True)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)

    def link(match: re.Match[str]) -> str:
        label, url = match.groups()
        safe_url = html.escape(url, quote=True)
        return f'<a href="{safe_url}" rel="noopener noreferrer">{label}</a>'

    return LINK_PATTERN.sub(link, escaped)


def _issue(section_id: str, code: str, message: str) -> SectionIssue:
    return SectionIssue(section_id=section_id, code=code, message=message)


def _unique_issues(issues: list[SectionIssue]) -> list[SectionIssue]:
    return list({(item.section_id, item.code): item for item in issues}.values())
