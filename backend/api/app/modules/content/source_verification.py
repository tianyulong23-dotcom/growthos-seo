from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlsplit


_NUMBER_PATTERN = re.compile(
    r"(?<!\w)(?:[$€£¥]\s*)?\d[\d,.]*(?:\s*%|\s*(?:percent|million|billion|trillion|"
    r"thousand|hours?|days?|weeks?|months?|years?|usd|eur|gbp|cny|x))?",
    re.IGNORECASE,
)
_WORD_PATTERN = re.compile(r"[a-z0-9][a-z0-9'-]*|[\u3400-\u9fff]+", re.IGNORECASE)
_STOPWORDS = {
    "about",
    "after",
    "also",
    "and",
    "are",
    "been",
    "before",
    "but",
    "can",
    "for",
    "from",
    "has",
    "have",
    "into",
    "its",
    "more",
    "not",
    "that",
    "the",
    "their",
    "than",
    "they",
    "this",
    "through",
    "was",
    "were",
    "which",
    "with",
    "will",
}
_TIER_1_HOSTS = {
    "w3.org",
    "who.int",
    "oecd.org",
    "worldbank.org",
    "iso.org",
    "iec.ch",
}
_TIER_2_HOSTS = {
    "arxiv.org",
    "doi.org",
    "nature.com",
    "pubmed.ncbi.nlm.nih.gov",
    "sciencedirect.com",
    "science.org",
    "springer.com",
}
_REJECTED_HOSTS = {
    "medium.com",
    "quora.com",
    "reddit.com",
    "pinterest.com",
}
_UPSTREAM_LINK_PATTERN = re.compile(
    r"\b(?:dataset|documentation|methodology|original|paper|publication|report|"
    r"research|source|study|survey|white[ -]?paper)\b",
    re.IGNORECASE,
)
_AFFILIATE_DISCLOSURE_PATTERN = re.compile(
    r"\b(?:affiliate links?|affiliate commission|as an amazon associate|"
    r"we may (?:earn|receive) (?:a )?commission|sponsored links?)\b",
    re.IGNORECASE,
)
_RESEARCH_IDENTITY_PATTERN = re.compile(
    r"\b(?:analysis|dataset|poll|report|research|study|survey)\b",
    re.IGNORECASE,
)
_METHODOLOGY_DISCLOSURE_PATTERN = re.compile(
    r"\b(?:confidence interval|data (?:collection|were collected|was collected)|"
    r"fieldwork|margin of error|methodology|methods?|participants?|questionnaire|"
    r"respondents?|sample size)\b",
    re.IGNORECASE,
)
_NEGATION_PATTERN = re.compile(
    r"\b(?:cannot|can't|didn't|doesn't|don't|isn't|never|no|not|prohibited|"
    r"shouldn't|wasn't|weren't|without|won't)\b|不(?:会|可|能|是|应|允许|支持)|"
    r"没有|禁止|未(?:能|获|被|有)",
    re.IGNORECASE,
)
_DIRECTION_PATTERNS = {
    "increase": re.compile(
        r"\b(?:higher|increase[ds]?|increasing|more|raise[ds]?|rising|up)\b|"
        r"上升|上涨|增加|提高|更多",
        re.IGNORECASE,
    ),
    "decrease": re.compile(
        r"\b(?:decrease[ds]?|decreasing|down|drop(?:ped|s)?|fall(?:en|ing|s)?|"
        r"fewer|lower|reduce[ds]?|reducing)\b|下降|下跌|减少|降低|更少",
        re.IGNORECASE,
    ),
}
_CONTEXT_PATTERNS: dict[str, dict[str, tuple[str, ...]]] = {
    "geography": {
        "us": (r"\b(?:u\.?s\.?a?|united states|american)\b",),
        "uk": (r"\b(?:u\.?k\.?|united kingdom|britain|british)\b",),
        "canada": (r"\b(?:canada|canadian)\b",),
        "australia": (r"\b(?:australia|australian)\b",),
        "china": (r"\b(?:china|chinese)\b", r"中国"),
        "india": (r"\b(?:india|indian)\b",),
        "europe": (r"\b(?:europe|european|eu)\b",),
        "global": (r"\b(?:global|worldwide|international)\b",),
    },
    "population": {
        "households": (r"\bhouseholds?\b", r"家庭"),
        "businesses": (r"\b(?:businesses|companies|firms|organizations)\b", r"企业"),
        "consumers": (r"\bconsumers?\b", r"消费者"),
        "users": (r"\busers?\b", r"用户"),
        "adults": (r"\badults?\b", r"成年人"),
        "children": (r"\b(?:children|kids|minors)\b", r"儿童"),
        "students": (r"\bstudents?\b", r"学生"),
        "patients": (r"\bpatients?\b", r"患者"),
        "marketers": (r"\bmarketers?\b", r"营销人员"),
        "respondents": (r"\b(?:respondents|participants)\b", r"受访者"),
    },
    "methodology": {
        "survey": (r"\b(?:survey|questionnaire)\b", r"调查|问卷"),
        "poll": (r"\bpoll(?:ed|ing)?\b", r"民调"),
        "panel": (r"\bpanel\b", r"样本组|面板"),
        "census": (r"\bcensus\b", r"人口普查"),
        "experiment": (r"\b(?:experiment|experimental)\b", r"实验"),
        "randomized": (r"\b(?:randomized|randomised|rct)\b", r"随机(?:对照)?"),
        "cohort": (r"\bcohort\b", r"队列研究"),
        "meta_analysis": (r"\bmeta[- ]analysis\b", r"荟萃分析"),
        "observational": (r"\bobservational\b", r"观察性"),
        "administrative_data": (
            r"\b(?:administrative|registry|transaction) data\b",
            r"行政数据|登记数据|交易数据",
        ),
    },
    "period": {
        "daily": (r"\b(?:daily|per day)\b", r"每天|每日"),
        "weekly": (r"\b(?:weekly|per week)\b", r"每周"),
        "monthly": (r"\b(?:monthly|per month)\b", r"每月"),
        "annual": (r"\b(?:annual|annually|yearly|per year)\b", r"每年|年度"),
    },
}


@dataclass(frozen=True)
class ClaimVerification:
    claim: str
    status: str
    evidence: str = ""
    numeric_tokens: tuple[str, ...] = ()
    lexical_overlap: float = 0.0
    context_tokens: tuple[str, ...] = ()
    context_mismatches: tuple[str, ...] = ()


@dataclass(frozen=True)
class SourceVerification:
    status: str
    method: str
    evidence: str
    claims: tuple[ClaimVerification, ...]


def classify_source_tier(url: str) -> str:
    host = (urlsplit(url).hostname or "").casefold().removeprefix("www.")
    if host in _REJECTED_HOSTS or any(host.endswith(f".{item}") for item in _REJECTED_HOSTS):
        return "tier_4_user_generated_or_generic"
    if (
        host.endswith((".gov", ".gov.uk", ".gov.cn", ".edu", ".edu.cn", ".ac.uk", ".mil"))
        or host in _TIER_1_HOSTS
        or any(host.endswith(f".{item}") for item in _TIER_1_HOSTS)
    ):
        return "tier_1_official_public_or_standards"
    if host in _TIER_2_HOSTS or any(host.endswith(f".{item}") for item in _TIER_2_HOSTS):
        return "tier_2_original_or_named_research"
    return "tier_3_or_unclassified_requires_exact_page_evidence"


def select_upstream_source_links(
    cited_url: str, links: list[dict[str, object]], limit: int = 2
) -> list[str]:
    cited_host = (urlsplit(cited_url).hostname or "").casefold().removeprefix("www.")
    ranked: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for index, link in enumerate(links):
        url = str(link.get("url") or "").strip()
        parsed = urlsplit(url)
        host = (parsed.hostname or "").casefold().removeprefix("www.")
        if (
            parsed.scheme not in {"http", "https"}
            or not host
            or host == cited_host
            or bool(link.get("is_internal"))
            or str(link.get("placement") or "body") != "body"
            or url in seen
        ):
            continue
        tier = classify_source_tier(url)
        if tier.startswith("tier_4"):
            continue
        signal_text = " ".join(
            [str(link.get("text") or ""), parsed.path, parsed.query]
        )
        if tier.startswith("tier_1"):
            priority = 0
        elif tier.startswith("tier_2"):
            priority = 1
        elif _UPSTREAM_LINK_PATTERN.search(signal_text):
            priority = 2
        else:
            continue
        seen.add(url)
        ranked.append((priority, index, url))
    ranked.sort()
    return [url for _, _, url in ranked[:limit]]


def assess_source_page(
    url: str,
    page_text: str,
    outbound_links: list[dict[str, object]],
    claim_text: str,
) -> tuple[str, str]:
    tier = classify_source_tier(url)
    if tier.startswith("tier_4"):
        return tier, "blocked_host"
    if tier.startswith(("tier_1", "tier_2")):
        return tier, ""
    if _AFFILIATE_DISCLOSURE_PATTERN.search(page_text):
        return "tier_4_affiliate_or_sponsored", "affiliate_disclosure"
    if select_upstream_source_links(url, outbound_links):
        return "tier_3_reporting_with_upstream_source", ""
    if _RESEARCH_IDENTITY_PATTERN.search(page_text) and _METHODOLOGY_DISCLOSURE_PATTERN.search(
        page_text
    ):
        return "tier_2_original_research_with_methodology", ""
    if _numeric_tokens(claim_text):
        return "tier_4_unsourced_numeric_explainer", "missing_source_trail"
    return tier, ""


def verify_source_claims(claim_text: str, page_text: str) -> SourceVerification:
    claims = _claim_units(claim_text)
    if not claims or not page_text.strip():
        return SourceVerification("not_found", "page_text_match_v1", "", ())

    chunks = _evidence_chunks(page_text)
    outcomes = tuple(_verify_claim(claim, chunks) for claim in claims)
    accepted = [item for item in outcomes if item.status in {"verified", "paraphrase"}]
    if any(item.status == "verified" for item in accepted):
        status = "verified"
    elif accepted:
        status = "paraphrase"
    else:
        status = "not_found"
    evidence = "\n".join(dict.fromkeys(item.evidence for item in accepted if item.evidence))
    return SourceVerification(status, "page_text_match_v1", evidence[:6000], outcomes)


def verify_source_claim_with_quote(
    claim_text: str, exact_quote: str, page_text: str
) -> SourceVerification:
    normalized_quote = _normalize(exact_quote)
    if normalized_quote and normalized_quote in _normalize(page_text):
        quote = exact_quote[:6000]
        return SourceVerification(
            "verified",
            "page_exact_quote_match_v1",
            quote,
            (
                ClaimVerification(
                    quote,
                    "verified",
                    quote[:2000],
                    tuple(_numeric_tokens(quote)),
                    1.0,
                    tuple(_flatten_context(_context_tokens(quote))),
                    (),
                ),
            ),
        )
    return verify_source_claims(claim_text, page_text)


def evidence_fingerprint(value: str) -> set[str]:
    return set(_lexical_tokens(value))


def evidence_similarity(left: str, right: str) -> float:
    left_tokens = evidence_fingerprint(left)
    right_tokens = evidence_fingerprint(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _verify_claim(claim: str, chunks: list[str]) -> ClaimVerification:
    normalized_claim = _normalize(claim)
    numeric_tokens = tuple(_numeric_tokens(claim))
    claim_context = _context_tokens(claim)
    claim_tokens = set(_lexical_tokens(claim))
    best_chunk = ""
    best_overlap = 0.0
    best_numbers_match = False
    best_context_mismatches: tuple[str, ...] = ()
    for chunk in chunks:
        normalized_chunk = _normalize(chunk)
        chunk_numbers = set(_numeric_tokens(chunk))
        numbers_match = all(item in chunk_numbers for item in numeric_tokens)
        context_mismatches = (
            *_context_mismatches(claim_context, _context_tokens(chunk)),
            *_semantic_mismatches(claim, chunk),
        )
        context_matches = not context_mismatches
        chunk_tokens = set(_lexical_tokens(chunk))
        overlap = (
            len(claim_tokens & chunk_tokens) / len(claim_tokens)
            if claim_tokens
            else 0.0
        )
        exact = bool(normalized_claim and normalized_claim in normalized_chunk)
        score = (
            overlap
            + (1.0 if numbers_match and numeric_tokens else 0.0)
            + (1.0 if context_matches and claim_context else 0.0)
            + (2.0 if exact else 0.0)
        )
        best_score = best_overlap + (1.0 if best_numbers_match and numeric_tokens else 0.0)
        if exact or score > best_score:
            best_chunk = chunk
            best_overlap = overlap
            best_numbers_match = numbers_match
            best_context_mismatches = context_mismatches
        if exact and context_matches:
            return ClaimVerification(
                claim,
                "verified",
                chunk[:2000],
                numeric_tokens,
                max(overlap, 1.0),
                tuple(_flatten_context(claim_context)),
                (),
            )

    if best_context_mismatches:
        return ClaimVerification(
            claim,
            "not_found",
            "",
            numeric_tokens,
            best_overlap,
            tuple(_flatten_context(claim_context)),
            best_context_mismatches,
        )
    if numeric_tokens and best_numbers_match and best_overlap >= 0.35:
        return ClaimVerification(
            claim,
            "verified",
            best_chunk[:2000],
            numeric_tokens,
            best_overlap,
            tuple(_flatten_context(claim_context)),
            (),
        )
    if numeric_tokens and best_numbers_match and best_overlap >= 0.2:
        return ClaimVerification(
            claim,
            "paraphrase",
            best_chunk[:2000],
            numeric_tokens,
            best_overlap,
            tuple(_flatten_context(claim_context)),
            (),
        )
    if not numeric_tokens and best_overlap >= 0.55:
        return ClaimVerification(
            claim,
            "paraphrase",
            best_chunk[:2000],
            numeric_tokens,
            best_overlap,
            tuple(_flatten_context(claim_context)),
            (),
        )
    return ClaimVerification(
        claim,
        "not_found",
        "",
        numeric_tokens,
        best_overlap,
        tuple(_flatten_context(claim_context)),
        (),
    )


def _semantic_mismatches(claim: str, evidence: str) -> tuple[str, ...]:
    mismatches: list[str] = []
    if bool(_NEGATION_PATTERN.search(claim)) != bool(_NEGATION_PATTERN.search(evidence)):
        mismatches.append("polarity:negation")
    claim_directions = {
        name for name, pattern in _DIRECTION_PATTERNS.items() if pattern.search(claim)
    }
    evidence_directions = {
        name for name, pattern in _DIRECTION_PATTERNS.items() if pattern.search(evidence)
    }
    if claim_directions and evidence_directions and claim_directions.isdisjoint(
        evidence_directions
    ):
        mismatches.append(f"direction:{','.join(sorted(claim_directions))}")
    return tuple(mismatches)


def _context_tokens(value: str) -> dict[str, set[str]]:
    normalized = _normalize(value)
    return {
        dimension: {
            token
            for token, patterns in tokens.items()
            if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in patterns)
        }
        for dimension, tokens in _CONTEXT_PATTERNS.items()
    }


def _context_mismatches(
    claim: dict[str, set[str]], evidence: dict[str, set[str]]
) -> tuple[str, ...]:
    mismatches: list[str] = []
    for dimension, required in claim.items():
        if not required:
            continue
        observed = evidence.get(dimension) or set()
        if not required.issubset(observed):
            missing = ",".join(sorted(required - observed))
            mismatches.append(f"{dimension}:{missing}")
    return tuple(mismatches)


def _flatten_context(value: dict[str, set[str]]) -> list[str]:
    return [
        f"{dimension}:{token}"
        for dimension, tokens in value.items()
        for token in sorted(tokens)
    ]


def _claim_units(value: str) -> list[str]:
    units = [
        " ".join(item.split())
        for item in re.split(r"(?:\r?\n)+|(?<=[.!?。！？])\s+", value)
        if len(" ".join(item.split())) >= 12
    ]
    return list(dict.fromkeys(units))[:12]


def _evidence_chunks(value: str) -> list[str]:
    compact = value.replace("\r", "\n")
    chunks = [
        " ".join(item.split())
        for item in re.split(r"(?:\n\s*)+|(?<=[.!?。！？])\s+", compact)
        if len(" ".join(item.split())) >= 12
    ]
    return chunks[:5000]


def _numeric_tokens(value: str) -> list[str]:
    return list(dict.fromkeys(_normalize_number(item.group(0)) for item in _NUMBER_PATTERN.finditer(value)))


def _normalize_number(value: str) -> str:
    return re.sub(r"[\s,]", "", unicodedata.normalize("NFKC", value).casefold())


def _lexical_tokens(value: str) -> list[str]:
    output: list[str] = []
    for match in _WORD_PATTERN.finditer(_normalize(value)):
        token = match.group(0)
        if token.isdigit() or token in _STOPWORDS:
            continue
        if re.fullmatch(r"[\u3400-\u9fff]+", token):
            output.extend(token[index : index + 2] for index in range(max(1, len(token) - 1)))
        elif len(token) >= 3:
            output.append(token)
    return list(dict.fromkeys(output))


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"\s+", " ", normalized).strip()
