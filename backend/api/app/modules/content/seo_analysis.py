from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from app.modules.content.document import canonical_document_json, normalize_document


RULESET_VERSION = "rank-math-content-analysis-1.0.275-v2"
GROUP_LABELS = {
    "basic_seo": "基础 SEO",
    "additional": "附加 SEO",
    "title_readability": "标题可读性",
    "content_readability": "内容可读性",
}
GROUP_RULES = {
    "basic_seo": (
        "keywordInTitle",
        "keywordInMetaDescription",
        "keywordInPermalink",
        "keywordIn10Percent",
        "keywordInContent",
        "lengthContent",
    ),
    "additional": (
        "keywordInSubheadings",
        "keywordInImageAlt",
        "keywordDensity",
        "lengthPermalink",
        "linksHasExternals",
        "linksNotAllExternals",
        "linksHasInternal",
        "keywordNotUsed",
        "hasContentAI",
    ),
    "title_readability": (
        "titleStartWithKeyword",
        "titleSentiment",
        "titleHasPowerWords",
        "titleHasNumber",
    ),
    "content_readability": (
        "contentHasTOC",
        "contentHasShortParagraphs",
        "contentHasAssets",
    ),
}
RULE_ORDER = (
    "contentHasAssets",
    "contentHasShortParagraphs",
    "contentHasTOC",
    "keywordDensity",
    "keywordIn10Percent",
    "keywordInContent",
    "keywordInImageAlt",
    "keywordInMetaDescription",
    "keywordInPermalink",
    "keywordInSubheadings",
    "keywordInTitle",
    "keywordNotUsed",
    "lengthContent",
    "lengthPermalink",
    "linksHasExternals",
    "linksHasInternal",
    "linksNotAllExternals",
    "titleHasNumber",
    "titleHasPowerWords",
    "titleSentiment",
    "titleStartWithKeyword",
    "hasContentAI",
)
RULE_WEIGHTS = {
    "contentHasAssets": 6,
    "contentHasShortParagraphs": 3,
    "contentHasTOC": 2,
    "keywordDensity": 6,
    "keywordIn10Percent": 3,
    "keywordInContent": 3,
    "keywordInImageAlt": 2,
    "keywordInMetaDescription": 2,
    "keywordInPermalink": 5,
    "keywordInSubheadings": 3,
    "keywordNotUsed": 0,
    "lengthContent": 8,
    "lengthPermalink": 4,
    "linksHasExternals": 4,
    "linksHasInternal": 5,
    "linksNotAllExternals": 2,
    "titleHasNumber": 1,
    "titleHasPowerWords": 1,
    "titleSentiment": 1,
    "titleStartWithKeyword": 3,
    "hasContentAI": 5,
}
RULE_DEPENDENCIES = {
    "contentHasAssets": {"document"},
    "contentHasShortParagraphs": {"document"},
    "contentHasTOC": {"document"},
    "keywordDensity": {"document", "focus_keyword", "secondary_keywords"},
    "keywordIn10Percent": {"document", "focus_keyword"},
    "keywordInContent": {"document", "focus_keyword"},
    "keywordInImageAlt": {"document", "focus_keyword"},
    "keywordInMetaDescription": {"focus_keyword", "meta_description"},
    "keywordInPermalink": {"focus_keyword", "slug", "full_url"},
    "keywordInSubheadings": {"document", "focus_keyword"},
    "keywordInTitle": {"focus_keyword", "meta_title", "title", "locale"},
    "keywordNotUsed": {"focus_keyword", "keyword_is_new"},
    "lengthContent": {"document"},
    "lengthPermalink": {"full_url"},
    "linksHasExternals": {"document", "site_host"},
    "linksHasInternal": {"document", "site_host"},
    "linksNotAllExternals": {"document", "site_host"},
    "titleHasNumber": {"meta_title", "title"},
    "titleHasPowerWords": {"meta_title", "title", "locale"},
    "titleSentiment": {"meta_title", "title", "locale"},
    "titleStartWithKeyword": {"focus_keyword", "meta_title", "title"},
    "hasContentAI": {"content_ai_used"},
}
RULE_MESSAGES = {
    "contentHasAssets": ("正文包含图片或视频。", "正文没有使用图片或视频。"),
    "contentHasShortParagraphs": ("正文使用了简短段落。", "至少一个段落超过 120 个词，建议拆分。"),
    "contentHasTOC": ("正文使用了目录。", "正文未使用目录。"),
    "keywordDensity": ("关键词密度符合 Rank Math 建议。", "关键词密度不符合 Rank Math 建议。"),
    "keywordIn10Percent": ("主关键词出现在正文前 10%。", "主关键词没有出现在正文开头。"),
    "keywordInContent": ("正文包含主关键词。", "正文没有包含主关键词。"),
    "keywordInImageAlt": ("图片 ALT 包含主关键词。", "图片 ALT 没有包含主关键词。"),
    "keywordInMetaDescription": ("Meta 描述包含主关键词。", "Meta 描述没有包含主关键词。"),
    "keywordInPermalink": ("URL 包含主关键词。", "URL 没有包含主关键词。"),
    "keywordInSubheadings": ("分节标题包含主关键词。", "H2-H6 分节标题没有包含主关键词。"),
    "keywordInTitle": ("SEO 标题包含主关键词。", "SEO 标题没有包含主关键词。"),
    "keywordNotUsed": ("该主关键词未在其他文章中使用。", "该主关键词已在其他文章中使用。"),
    "lengthContent": ("正文长度达到 Rank Math 建议。", "正文少于 600 个词。"),
    "lengthPermalink": ("URL 长度不超过 75 个字符。", "URL 超过 75 个字符，建议缩短。"),
    "linksHasExternals": ("正文包含外部链接。", "正文没有外部链接。"),
    "linksHasInternal": ("正文包含站内链接。", "正文没有站内链接。"),
    "linksNotAllExternals": ("至少一个外部链接为 DoFollow。", "外部链接全部为 nofollow，或没有外部链接。"),
    "titleHasNumber": ("SEO 标题包含数字。", "SEO 标题没有包含数字。"),
    "titleHasPowerWords": ("SEO 标题包含强力词。", "SEO 标题没有包含强力词。"),
    "titleSentiment": ("SEO 标题包含正面或负面情绪词。", "SEO 标题没有明显情绪词。"),
    "titleStartWithKeyword": ("主关键词位于 SEO 标题前半部分。", "主关键词没有位于 SEO 标题前半部分。"),
    "hasContentAI": ("文章使用了 Content AI。", "文章没有使用 Content AI。"),
}
DATA_PATH = Path(__file__).with_name("rank_math_content_analysis_data.json")
_HTML_TAG_RE = re.compile(r"</?[a-z][^>]*?>", re.IGNORECASE)
_HTML_COMMENT_RE = re.compile(r"<!--[\s\S]*?-->")
_HTML_ENTITY_RE = re.compile(r"&\S+?;")
_SHORTCODE_START_RE = re.compile(r"\[[^<>&/\[\]\x00-\x20=]+?(?: [^\]]+?)?\]")
_SHORTCODE_END_RE = re.compile(r"\[/[^<>&/\[\]\x00-\x20=]+?\]")
_WORD_COUNT_REMOVABLE_RE = re.compile(
    r"[!-\x40\[-`{-~\u0080-\u00bf\u00d7\u00f7\u2000-\u2bff\u2e00-\u2e7f]"
)
_WORD_REMOVABLE_RE = re.compile(
    r"[\u0080-\u00bf\u00d7\u00f7\u2000-\u2bff\u2e00-\u2e7f]"
)
_WORD_EDGE_PUNCTUATION = "\\–\\-\\(\\)_\\[\\]’“”\"'.?!:;,¿¡«»‹›—×+&<>"
_WORD_EDGE_START_RE = re.compile(f"^[{_WORD_EDGE_PUNCTUATION}]+")
_WORD_EDGE_END_RE = re.compile(f"[{_WORD_EDGE_PUNCTUATION}]+$")


@dataclass(frozen=True)
class TextRegion:
    text: str
    node_id: str | None
    node_type: str
    level: int | None = None


@dataclass(frozen=True)
class SeoInput:
    document: dict[str, Any]
    metadata: dict[str, Any]
    context: dict[str, Any]
    regions: tuple[TextRegion, ...]
    headings: tuple[TextRegion, ...]
    paragraphs: tuple[TextRegion, ...]
    links: tuple[dict[str, Any], ...]
    images: tuple[dict[str, Any], ...]
    galleries: int
    videos: int
    has_toc: bool

    @property
    def body_text(self) -> str:
        return "\n".join(region.text for region in self.regions)

    @property
    def title(self) -> str:
        return str(self.metadata.get("meta_title") or self.metadata.get("title") or "")

    @property
    def keyword(self) -> str:
        return _normalize_text(str(self.metadata.get("focus_keyword") or "")).strip()


def metadata_hash(metadata: dict[str, Any]) -> str:
    payload = json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def document_hash(document: dict[str, Any]) -> str:
    normalized = normalize_document(document)
    return hashlib.sha256(canonical_document_json(normalized).encode("utf-8")).hexdigest()


def keyword_spans(text: str, keyword: str) -> list[tuple[int, int]]:
    normalized_keyword = _normalize_text(keyword).strip().casefold()
    if not normalized_keyword:
        return []
    return [
        (match.start(), match.end())
        for match in re.finditer(re.escape(normalized_keyword), _normalize_text(text).casefold())
    ]


def normalize_locale(value: object) -> str:
    locale = str(value or "en").strip().replace("_", "-").lower()
    aliases = {"english": "en", "eng": "en"}
    return aliases.get(locale, locale.split("-", 1)[0] or "en")


def build_seo_input(
    document: dict[str, Any], metadata: dict[str, Any], context: dict[str, Any] | None = None
) -> SeoInput:
    normalized = normalize_document(document)
    regions: list[TextRegion] = []
    headings: list[TextRegion] = []
    paragraphs: list[TextRegion] = []
    links: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    galleries = 0
    videos = 0
    has_toc = False

    def inline_text(node: dict[str, Any], node_id: str | None) -> str:
        parts: list[str] = []
        offset = 0
        for child in node.get("content", []):
            child_type = child.get("type")
            if child_type == "text":
                text = str(child.get("text") or "")
                for mark in child.get("marks", []):
                    if mark.get("type") == "link":
                        links.append({
                            "node_id": node_id,
                            "text": text,
                            "start": offset,
                            "end": offset + len(text),
                            **dict(mark.get("attrs") or {}),
                        })
                parts.append(text)
                offset += len(text)
            elif child_type == "hardBreak":
                parts.append("\n")
                offset += 1
        return "".join(parts)

    def visit(node: dict[str, Any]) -> None:
        nonlocal galleries, videos, has_toc
        node_type = str(node.get("type") or "")
        attrs = dict(node.get("attrs") or {})
        node_id = attrs.get("node_id")
        if node_type in {"paragraph", "heading", "codeBlock"}:
            text = inline_text(node, node_id)
            if text.strip():
                region = TextRegion(text, node_id, node_type, attrs.get("level"))
                regions.append(region)
                if node_type == "heading":
                    headings.append(region)
                if node_type == "paragraph":
                    paragraphs.append(region)
                if "wp-block-rank-math-toc-block" in text.casefold():
                    has_toc = True
        if node_type in {"bookmark", "button"}:
            text = str(attrs.get("title") or attrs.get("label") or "")
            links.append({
                "node_id": node_id,
                "text": text,
                "start": 0,
                "end": len(text),
                "href": attrs.get("url") or attrs.get("href"),
                "target": attrs.get("target"),
                "rel": attrs.get("rel"),
            })
        if node_type == "image":
            images.append({"node_id": node_id, **attrs})
        elif node_type == "gallery":
            galleries += 1
            images.extend({"node_id": node_id, "gallery": True, **item} for item in attrs.get("items", []))
        elif node_type == "video":
            videos += 1
        elif node_type == "embed" and attrs.get("provider") in {"youtube", "vimeo"}:
            videos += 1
        elif node_type in {"tableOfContents", "toc"}:
            has_toc = True
        for child in node.get("content", []):
            if child.get("type") != "text":
                visit(child)

    for block in normalized.get("content", []):
        visit(block)
    return SeoInput(
        normalized,
        metadata,
        dict(context or {}),
        tuple(regions),
        tuple(headings),
        tuple(paragraphs),
        tuple(links),
        tuple(images),
        galleries,
        videos,
        has_toc,
    )


def _normalize_text(value: str) -> str:
    return "".join(
        character for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    ).replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')


def _word_count(value: str, shortcodes: tuple[str, ...] = ()) -> int:
    if not value:
        return 0
    clean = _HTML_TAG_RE.sub("\n", value)
    clean = _HTML_COMMENT_RE.sub("", clean)
    if shortcodes:
        shortcode_names = "|".join(re.escape(item) for item in shortcodes)
        clean = re.sub(rf"\[/?(?:{shortcode_names})[^\]]*?\]", "\n", clean)
    clean = re.sub(r"&nbsp;|&#160;", " ", clean, flags=re.IGNORECASE)
    clean = _HTML_ENTITY_RE.sub("", clean)
    clean = re.sub(r"--|\u2014", " ", clean)
    clean = _WORD_COUNT_REMOVABLE_RE.sub("", clean)
    return len(re.findall(r"\S\s+", f"{clean}\n"))


def _words(value: str) -> list[str]:
    clean = _HTML_TAG_RE.sub("", value)
    clean = _HTML_COMMENT_RE.sub("", clean)
    clean = _SHORTCODE_START_RE.sub("", clean)
    clean = _SHORTCODE_END_RE.sub("", clean)
    clean = re.sub(r"&nbsp;|&#160;", " ", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\s{2,}", " ", clean)
    clean = re.sub(r"\s\.", ".", clean).strip()
    clean = _HTML_ENTITY_RE.sub("", clean)
    clean = re.sub(r"--|\u2014", " ", clean)
    clean = _WORD_REMOVABLE_RE.sub("", clean)
    words = re.split(r"\s", clean) if clean else []
    return [
        word
        for item in words
        if (word := _WORD_EDGE_END_RE.sub("", _WORD_EDGE_START_RE.sub("", item))).strip()
    ]


def _evidence(region: TextRegion, spans: list[tuple[int, int]] | None = None) -> list[dict[str, Any]]:
    matches = [(0, len(region.text))] if spans is None else spans
    return [
        {"field": "document", "node_id": region.node_id, "start": start, "end": end}
        for start, end in matches[:5]
    ]


def _keyword_evidence(value: SeoInput, regions: tuple[TextRegion, ...]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for region in regions:
        evidence.extend(_evidence(region, keyword_spans(region.text, value.keyword)))
    return evidence[:5]


def _keyword_evidence_within_word_limit(
    value: SeoInput, word_limit: int
) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    words_seen = 0
    for region in value.regions:
        if words_seen >= word_limit:
            break
        region_words = list(
            re.finditer(r"[^\W_]+(?:['-][^\W_]+)*", region.text, re.UNICODE)
        )
        remaining = word_limit - words_seen
        prefix_end = (
            len(region.text)
            if len(region_words) <= remaining
            else region_words[remaining - 1].end()
        )
        spans = [
            span
            for span in keyword_spans(region.text, value.keyword)
            if span[1] <= prefix_end
        ]
        evidence.extend(_evidence(region, spans) if spans else [])
        words_seen += len(region_words)
    return evidence[:5]


def _url_parts(value: SeoInput) -> tuple[str, str]:
    full_url = str(value.context.get("full_url") or value.metadata.get("canonical_url") or value.metadata.get("slug") or "")
    return full_url, str(value.metadata.get("slug") or "")


def _slugify(value: str) -> str:
    normalized = _normalize_text(value).casefold().replace("'", "")
    return re.sub(r"-+", "-", re.sub(r"[^\w]+", "-", normalized).replace("_", "-")).strip("-")


def _link_stats(value: SeoInput) -> dict[str, int]:
    stats = {"total": 0, "internal": 0, "external": 0, "external_dofollow": 0}
    site_host = str(value.context.get("site_host") or "").casefold().removeprefix("www.").rstrip(".")
    for link in value.links:
        href = str(link.get("href") or "").strip()
        parsed = urlsplit(href)
        if parsed.scheme and parsed.scheme.casefold() not in {"http", "https"} or href.startswith("#"):
            continue
        stats["total"] += 1
        host = (parsed.hostname or "").casefold().removeprefix("www.").rstrip(".")
        internal = not host or bool(site_host and (host == site_host or host.endswith(f".{site_host}")))
        if internal:
            stats["internal"] += 1
            continue
        stats["external"] += 1
        rel = {item.casefold() for item in str(link.get("rel") or "").split()}
        if "nofollow" not in rel:
            stats["external_dofollow"] += 1
    return stats


@lru_cache(maxsize=1)
def _rank_math_data() -> dict[str, Any]:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def _sentiment_score(title: str) -> int:
    source = _rank_math_data()["sentiment"]
    labels = {**source["labels"], **source["emoji"], **source["extras"]}
    tokens = re.sub(r'[.,/#!?$%^&*;:{}=_`"~()]', " ", title.casefold().replace("\n", " "))
    tokens = re.sub(r"\s+", " ", tokens).strip().split(" ")
    score = 0
    for index, token in enumerate(tokens):
        token_score = int(labels.get(token, 0))
        if index > 0 and tokens[index - 1] in source["negators"]:
            token_score *= -1
        score += token_score
    return score


def _js_round(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _group_for(rule_id: str) -> str:
    return next(group for group, rules in GROUP_RULES.items() if rule_id in rules)


def _evaluate(rule_id: str, value: SeoInput) -> tuple[bool, int, int, list[dict[str, Any]], str]:
    max_score = 36 if rule_id == "keywordInTitle" and normalize_locale(value.context.get("locale")) == "en" else RULE_WEIGHTS.get(rule_id, 38 if rule_id == "keywordInTitle" else 0)
    keyword = value.keyword.casefold()
    body = _normalize_text(value.body_text).casefold()
    title = _normalize_text(value.title).casefold()
    evidence: list[dict[str, Any]] = []
    detail = ""

    if rule_id == "contentHasAssets":
        image_count = (
            sum(1 for image in value.images if not image.get("gallery"))
            + value.galleries
        )
        image_score = {0: 0, 1: 1, 2: 2, 3: 4}.get(image_count, 6)
        video_score = {0: 0, 1: 1}.get(value.videos, 2)
        score = min(max_score, image_score + video_score)
        detail = f"图片 {image_count}，视频 {value.videos}"
        return score > 0, score, max_score, [], detail
    if rule_id == "contentHasShortParagraphs":
        if not body.strip():
            return False, 0, max_score, [], "正文为空"
        long_paragraphs = [
            region for region in value.paragraphs if _word_count(region.text) > 120
        ]
        evidence = [item for region in long_paragraphs[:5] for item in _evidence(region)]
        longest = max((_word_count(item.text) for item in value.paragraphs), default=0)
        return not long_paragraphs, max_score if not long_paragraphs else 0, max_score, evidence, f"最长段落 {longest} 词"
    if rule_id == "contentHasTOC":
        return value.has_toc, max_score if value.has_toc else 0, max_score, [], ""
    if rule_id == "keywordDensity":
        word_count = _word_count(value.body_text)
        keywords = [
            normalized
            for item in [
                value.metadata.get("focus_keyword"),
                *(value.metadata.get("secondary_keywords") or []),
            ]
            if (normalized := _normalize_text(str(item or "")).strip().casefold())
        ]
        pattern = re.compile("|".join(re.escape(item) for item in keywords), re.IGNORECASE) if keywords else None
        count = len(pattern.findall(body)) if pattern else 0
        density = float(f"{(count / word_count * 100) if word_count else 0:.2f}")
        score = 0 if density < 0.5 or density > 2.5 else 2 if 0.5 <= density < 0.75 else 3 if 0.76 <= density < 1.0 else 6
        return score > 0, score, max_score, _keyword_evidence(value, value.regions), f"密度 {density:.2f}%，出现 {count} 次"
    if rule_id == "keywordIn10Percent":
        words = _words(body)
        checked = words if len(words) <= 400 else words[: math.floor(len(words) * 0.1)]
        passed = bool(keyword and " ".join(checked).find(" ".join(_words(keyword))) >= 0)
        evidence = (
            _keyword_evidence_within_word_limit(value, len(checked)) if passed else []
        )
        return passed, max_score if passed else 0, max_score, evidence, f"检查前 {len(checked)} 词"
    if rule_id == "keywordInContent":
        passed = bool(keyword and keyword in body)
        return passed, max_score if passed else 0, max_score, _keyword_evidence(value, value.regions), ""
    if rule_id == "keywordInImageAlt":
        keyword_words = list(dict.fromkeys(keyword.split(" ")))
        pattern = re.compile(".*".join(re.escape(word) for word in keyword_words), re.IGNORECASE) if keyword_words else None
        matches = [image for image in value.images if pattern and pattern.search(_normalize_text(str(image.get("alt") or "")).casefold())]
        passed = bool(keyword and (matches or value.galleries))
        evidence = [{"field": "alt", "node_id": item.get("node_id")} for item in matches[:5]]
        return passed, max_score if passed else 0, max_score, evidence, "检测到图库时按 Rank Math 假定通过" if value.galleries else ""
    if rule_id == "keywordInMetaDescription":
        description = _normalize_text(str(value.metadata.get("meta_description") or "")).casefold()
        passed = bool(keyword and keyword in description)
        return passed, max_score if passed else 0, max_score, [{"field": "meta_description"}], ""
    if rule_id == "keywordInPermalink":
        full_url, slug = _url_parts(value)
        permalink = _normalize_text(full_url or slug).casefold().replace("_", "-")
        keyword_slug = _slugify(keyword)
        passed = bool(keyword_slug and keyword_slug in permalink)
        return passed, max_score if passed else 0, max_score, [{"field": "slug"}], ""
    if rule_id == "keywordInSubheadings":
        headings = tuple(item for item in value.headings if item.level and 2 <= item.level <= 6)
        evidence = _keyword_evidence(value, headings)
        return bool(evidence), max_score if evidence else 0, max_score, evidence, ""
    if rule_id == "keywordInTitle":
        passed = bool(keyword and keyword in title)
        return passed, max_score if passed else 0, max_score, [{"field": "meta_title"}], ""
    if rule_id == "keywordNotUsed":
        passed = bool(keyword and value.context.get("keyword_is_new", True))
        return passed, 0, 0, [{"field": "focus_keyword"}], ""
    if rule_id == "lengthContent":
        count = _word_count(value.body_text)
        score = 8 if count >= 2500 else 5 if count >= 2000 else 4 if count >= 1500 else 3 if count >= 1000 else 2 if count >= 600 else 0
        return score > 0, score, max_score, [], f"正文 {count} 词"
    if rule_id == "lengthPermalink":
        full_url, _slug = _url_parts(value)
        passed = bool(full_url) and len(full_url) <= 75
        return passed, max_score if passed else 0, max_score, [{"field": "canonical_url"}], f"URL {len(full_url)} 字符"
    if rule_id in {"linksHasExternals", "linksHasInternal", "linksNotAllExternals"}:
        stats = _link_stats(value)
        key = {"linksHasExternals": "external", "linksHasInternal": "internal", "linksNotAllExternals": "external_dofollow"}[rule_id]
        passed = stats[key] > 0
        return passed, max_score if passed else 0, max_score, list(value.links[:5]), f"站内 {stats['internal']}，站外 {stats['external']}，DoFollow {stats['external_dofollow']}"
    if rule_id == "titleHasNumber":
        passed = bool(re.search(r"\d+", value.title))
        return passed, max_score if passed else 0, max_score, [{"field": "meta_title"}], ""
    if rule_id == "titleHasPowerWords":
        locale = normalize_locale(value.context.get("locale"))
        words = _rank_math_data()["power_words"].get(locale)
        if not words:
            return False, 0, 0, [], "该语言没有 Rank Math 强力词词典"
        title_words = title.split(" ")
        matches = [word for word in words if _normalize_text(word).casefold() in title_words]
        return bool(matches), max_score if matches else 0, max_score, [{"field": "meta_title", "word": word} for word in matches[:5]], f"命中 {len(matches)} 个"
    if rule_id == "titleSentiment":
        if normalize_locale(value.context.get("locale")) != "en":
            return False, 0, 0, [], "仅适用于英文"
        score = _sentiment_score(title)
        return score != 0, max_score if score != 0 else 0, max_score, [{"field": "meta_title"}], f"情绪分 {score}"
    if rule_id == "titleStartWithKeyword":
        position = title.find(keyword) if keyword else -1
        passed = 0 <= position < math.floor(len(title) / 2)
        return passed, max_score if passed else 0, max_score, [{"field": "meta_title", "start": max(position, 0), "end": max(position, 0) + len(keyword)}], ""
    if rule_id == "hasContentAI":
        passed = bool(value.context.get("content_ai_used"))
        return passed, max_score if passed else 0, max_score, [], ""
    raise KeyError(rule_id)


def analyze_seo(
    document: dict[str, Any],
    metadata: dict[str, Any],
    *,
    context: dict[str, Any] | None = None,
    changed_fields: set[str] | None = None,
    previous_results: dict[str, Any] | None = None,
) -> dict[str, Any]:
    seo_input = build_seo_input(document, metadata, context)
    reusable = {
        result["rule_id"]: result
        for group in (previous_results or {}).get("groups", [])
        for result in group.get("results", [])
        if isinstance(result, dict) and result.get("rule_id")
    }
    results: dict[str, dict[str, Any]] = {}
    for rule_id in RULE_ORDER:
        dependencies = RULE_DEPENDENCIES[rule_id]
        can_reuse = (
            changed_fields is not None
            and rule_id in reusable
            and dependencies.isdisjoint(changed_fields)
            and reusable[rule_id].get("rule_version") == "1"
        )
        if can_reuse:
            result = dict(reusable[rule_id])
            result["reused"] = True
        else:
            passed, score, max_score, evidence, detail = _evaluate(rule_id, seo_input)
            applicable = max_score > 0 or rule_id == "keywordNotUsed"
            message = RULE_MESSAGES[rule_id][0 if passed else 1]
            if detail:
                message = f"{message} {detail}"
            result = {
                "rule_id": rule_id,
                "rule_version": "1",
                "group": _group_for(rule_id),
                "dependencies": sorted(dependencies),
                "applicable": applicable,
                "status": "passed" if passed else "failed" if applicable else "not_applicable",
                "severity": "suggestion",
                "score": score,
                "max_score": max_score,
                "message": message,
                "evidence": evidence,
                "action": "focus_evidence" if evidence and evidence[0].get("node_id") else "focus_field",
                "reused": False,
            }
        results[rule_id] = result

    raw_score = sum(int(result["score"]) for result in results.values())
    raw_max_score = sum(int(result["max_score"]) for result in results.values())
    score = _js_round(raw_score / raw_max_score * 100) if raw_max_score else 0
    return {
        "score": score,
        "max_score": 100,
        "raw_score": raw_score,
        "raw_max_score": raw_max_score,
        "registration_order": list(RULE_ORDER),
        "groups": [
            {
                "id": group,
                "label": label,
                "results": [results[rule_id] for rule_id in GROUP_RULES[group]],
            }
            for group, label in GROUP_LABELS.items()
        ],
    }
