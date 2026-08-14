import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app.modules.content.asset_security import AssetSecurityError, RemoteProbe
from app.modules.content.document import ArticleDocumentError, normalize_document
from app.modules.content.link_analysis import analyze_links, extract_links
from app.modules.content.service import article_link_analysis_response, find_target_section


def link_document() -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 2, "node_id": "heading-links"},
                "content": [{"type": "text", "text": "链接治理"}],
            },
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-links"},
                "content": [
                    {
                        "type": "text",
                        "text": "站内页面",
                        "marks": [{"type": "link", "attrs": {"href": "/guide"}}],
                    },
                    {"type": "text", "text": "和"},
                    {
                        "type": "text",
                        "text": "外部来源",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {
                                    "href": "https://source.example/report",
                                    "target": "_blank",
                                    "rel": "nofollow",
                                },
                            }
                        ],
                    },
                    {"type": "text", "text": "与"},
                    {
                        "type": "text",
                        "text": "重复来源",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {"href": "https://source.example/report"},
                            }
                        ],
                    },
                ],
            },
            {
                "type": "button",
                "attrs": {
                    "node_id": "button-1",
                    "label": "竞品",
                    "href": "https://news.competitor.example/page",
                    "style": "primary",
                },
            },
        ],
    }


class ProbeImporter:
    def __init__(self, responses: dict[str, RemoteProbe | Exception]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    async def probe(self, url: str) -> RemoteProbe:
        self.calls.append(url)
        result = self.responses[url]
        if isinstance(result, Exception):
            raise result
        return result


def issues(item: dict) -> set[str]:
    return {issue["rule_id"] for issue in item["evidence"]}


def test_extract_links_has_stable_ids_and_precise_node_ranges() -> None:
    first = extract_links(link_document())
    second = extract_links(link_document())
    assert [item.link_id for item in first] == [item.link_id for item in second]
    assert len(set(item.link_id for item in first)) == len(first)
    assert (first[1].node_id, first[1].start, first[1].end) == (
        "paragraph-links",
        5,
        9,
    )


def test_link_rules_cover_security_duplicates_competitors_and_probe_outcomes() -> None:
    async def scenario() -> dict:
        importer = ProbeImporter(
            {
                "https://source.example/report": RemoteProbe(
                    "https://source.example/final", 404, ("https://source.example/report",)
                ),
                "https://news.competitor.example/page": RemoteProbe(
                    "https://news.competitor.example/page", 503, ()
                ),
            }
        )
        result = await analyze_links(
            link_document(),
            project_domain="project.example",
            competitor_domain="competitor.example",
            importer=importer,
        )
        return {"result": result, "calls": importer.calls}

    outcome = asyncio.run(scenario())
    result = outcome["result"]
    external = result["links"][1]
    duplicate = result["links"][2]
    competitor = result["links"][3]

    assert issues(external) == {"duplicate_target", "broken_link"}
    assert set(external["rel"].split()) == {"nofollow", "noopener", "noreferrer"}
    assert external["http_status"] == "broken"
    assert external["redirect_chain"] == ["https://source.example/report"]
    assert issues(duplicate) == {"duplicate_target", "broken_link"}
    assert issues(competitor) == {"competitor_domain", "temporary_server_error"}
    assert outcome["calls"].count("https://source.example/report") == 1
    assert result["summary"] == {
        "total": 4,
        "internal": 1,
        "external": 3,
        "errors": 2,
        "warnings": 1,
    }


def test_timeout_or_security_probe_failure_is_unknown_and_does_not_remove_link() -> None:
    async def scenario() -> dict:
        importer = ProbeImporter(
            {
                "https://source.example/report": AssetSecurityError(
                    "asset_import_timeout", "timeout", retryable=True
                ),
                "https://news.competitor.example/page": RemoteProbe(
                    "https://news.competitor.example/page", 200, ()
                ),
            }
        )
        return await analyze_links(
            link_document(),
            project_domain="project.example",
            competitor_domain=None,
            importer=importer,
        )

    result = asyncio.run(scenario())
    external = result["links"][1]
    assert external["href"] == "https://source.example/report"
    assert external["http_status"] == "unknown"
    assert external["check_error_code"] == "asset_import_timeout"
    assert "check_unknown" in issues(external)


def test_empty_href_and_anchor_are_rejected_at_the_document_boundary() -> None:
    empty_anchor = link_document()
    empty_anchor["content"][1]["content"] = [
        {
            "type": "text",
            "text": "",
            "marks": [{"type": "link", "attrs": {"href": "/guide"}}],
        }
    ]
    with pytest.raises(ArticleDocumentError, match="article_document_text_invalid"):
        normalize_document(empty_anchor)

    empty_href = link_document()
    empty_href["content"][1]["content"] = [
        {
            "type": "text",
            "text": "链接文本",
            "marks": [{"type": "link", "attrs": {"href": ""}}],
        }
    ]
    with pytest.raises(ArticleDocumentError, match="article_document_link_invalid"):
        normalize_document(empty_href)


def test_latest_pending_or_failed_job_keeps_previous_success_payload() -> None:
    now = datetime.now(UTC)
    completed = SimpleNamespace(
        id="lia-completed",
        version_number=2,
        document_hash="old-hash",
        ruleset_version="article-links-v1",
        status="completed",
        error_code=None,
        error_detail=None,
        created_at=now,
        completed_at=now,
        results={
            "checked_at": now.isoformat(),
            "summary": {"total": 1, "internal": 1},
            "links": [
                {
                    "link_id": "lnk-1",
                    "node_id": "paragraph-links",
                    "node_type": "text",
                    "start": 0,
                    "end": 4,
                    "anchor_text": "站内页面",
                    "href": "/guide",
                    "final_url": "/guide",
                    "link_kind": "internal",
                    "target": None,
                    "rel": None,
                    "title": None,
                    "status": "passed",
                    "http_status": "not_checked",
                    "status_code": None,
                    "redirect_chain": [],
                    "check_error_code": None,
                    "evidence": [],
                    "checked_at": now.isoformat(),
                }
            ],
        },
    )
    pending = article_link_analysis_response(
        completed,
        current_document_hash="new-hash",
        status="running",
        pending_analysis_id="lia-running",
    )
    failed = article_link_analysis_response(
        completed,
        current_document_hash="new-hash",
        status="failed",
        pending_analysis_id="lia-failed",
        error_code="link_analysis_failed",
        error_detail="timeout",
    )
    assert pending.links[0].link_id == "lnk-1"
    assert pending.pending_analysis_id == "lia-running"
    assert pending.is_stale is True
    assert failed.links == pending.links
    assert failed.error_code == "link_analysis_failed"


def test_target_section_only_returns_a_real_heading_node_id() -> None:
    assert find_target_section(link_document(), "链接治理") == "heading-links"
    assert find_target_section(link_document(), "完全不匹配的主题") is None
