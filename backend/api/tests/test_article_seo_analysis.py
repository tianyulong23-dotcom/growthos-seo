import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app.core.config import Settings
from app.modules.content.repository import article_metadata_snapshot
from app.modules.content.schemas import ArticleSeoAnalysisRequest
from app.modules.content.seo_analysis import (
    RULESET_VERSION,
    RULE_ORDER,
    _sentiment_score,
    _word_count,
    _words,
    analyze_seo,
    document_hash,
    metadata_hash,
)
from app.modules.content.service import ContentConflictError, ContentService


def paragraph(text: str = "", node_id: str = "paragraph-1", *, marks=None) -> dict:
    node = {"type": "paragraph", "attrs": {"node_id": node_id}}
    if text:
        child = {"type": "text", "text": text}
        if marks:
            child["marks"] = marks
        node["content"] = [child]
    return node


def heading(text: str, level: int = 2, node_id: str = "heading-1") -> dict:
    return {
        "type": "heading",
        "attrs": {"level": level, "node_id": node_id},
        "content": [{"type": "text", "text": text}],
    }


def document(*nodes: dict) -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": list(nodes) or [paragraph()],
    }


def metadata(**overrides) -> dict:
    result = {
        "title": "Target Guide",
        "slug": "target-guide",
        "focus_keyword": "target",
        "secondary_keywords": [],
        "meta_title": "Target Guide",
        "meta_description": "A practical target guide.",
        "canonical_url": None,
        "indexing": "index/follow",
        "field_states": {},
        "publication_status": "complete_draft",
    }
    result.update(overrides)
    return result


def context(**overrides) -> dict:
    result = {
        "locale": "en",
        "full_url": "https://example.com/target-guide",
        "site_host": "example.com",
        "keyword_is_new": True,
        "content_ai_used": False,
        "content_ai_run_id": None,
    }
    result.update(overrides)
    return result


def rules(result: dict) -> dict[str, dict]:
    return {
        item["rule_id"]: item
        for group in result["groups"]
        for item in group["results"]
    }


def analyze(body: str = "target guide content", **kwargs) -> dict:
    return analyze_seo(
        document(paragraph(body)),
        kwargs.pop("metadata", metadata()),
        context=kwargs.pop("context", context()),
        **kwargs,
    )


def image(index: int) -> dict:
    return {
        "type": "image",
        "attrs": {
            "node_id": f"image-{index}",
            "asset_id": f"asset-{index}",
            "alt": f"image {index}",
            "display": "regular",
        },
    }


def video(index: int) -> dict:
    return {
        "type": "video",
        "attrs": {"node_id": f"video-{index}", "asset_id": f"video-asset-{index}"},
    }


def gallery() -> dict:
    return {
        "type": "gallery",
        "attrs": {
            "node_id": "gallery-1",
            "display": "regular",
            "items": [
                {"item_id": f"item-{index}", "asset_id": f"gallery-{index}", "alt": "photo"}
                for index in range(2)
            ],
        },
    }


def test_rank_math_registration_order_groups_and_source_version() -> None:
    result = analyze()

    assert len(RULE_ORDER) == 22
    assert result["registration_order"] == list(RULE_ORDER)
    assert [group["id"] for group in result["groups"]] == [
        "basic_seo",
        "additional",
        "title_readability",
        "content_readability",
    ]
    assert [item["rule_id"] for item in rules(result).values()] != list(RULE_ORDER)
    assert set(rules(result)) == set(RULE_ORDER)


def test_locale_weights_denominators_and_true_null_results() -> None:
    english = analyze()
    german = analyze(context=context(locale="de"))
    unsupported = analyze(context=context(locale="pt"))

    assert english["raw_max_score"] == 105
    assert rules(english)["keywordInTitle"]["max_score"] == 36
    assert german["raw_max_score"] == 106
    assert rules(german)["keywordInTitle"]["max_score"] == 38
    assert rules(german)["titleSentiment"]["status"] == "not_applicable"
    assert rules(german)["titleSentiment"]["max_score"] == 0
    assert unsupported["raw_max_score"] == 105
    assert rules(unsupported)["titleHasPowerWords"]["status"] == "not_applicable"
    assert rules(unsupported)["titleHasPowerWords"]["max_score"] == 0

    missing_inputs = analyze(
        "",
        metadata=metadata(
            title="", meta_title="", focus_keyword="", meta_description="", slug=""
        ),
        context=context(full_url=""),
    )
    missing = rules(missing_inputs)
    assert missing["titleSentiment"]["max_score"] == 1
    assert missing["titleHasPowerWords"]["max_score"] == 1
    assert missing["keywordInTitle"]["max_score"] == 36


def test_content_ai_false_and_empty_body_keep_rank_math_denominators() -> None:
    empty = analyze("")
    result = rules(empty)

    assert result["hasContentAI"]["status"] == "failed"
    assert (result["hasContentAI"]["score"], result["hasContentAI"]["max_score"]) == (0, 5)
    assert result["contentHasShortParagraphs"]["status"] == "failed"
    assert (result["contentHasShortParagraphs"]["score"], result["contentHasShortParagraphs"]["max_score"]) == (0, 3)


def test_wordpress_word_count_and_rank_math_get_words_are_distinct() -> None:
    source = '<p>Hello, world!</p><!-- hidden --> [box] ignored [/box] one--two &copy;'

    assert _word_count(source) == 7
    assert _word_count(source, shortcodes=("box",)) == 5
    assert _words(source) == ["Hello", "world", "ignored", "one", "two"]


@pytest.mark.parametrize(("count", "score"), [(120, 3), (121, 0)])
def test_short_paragraph_boundary(count: int, score: int) -> None:
    result = analyze(" ".join(["word"] * count))
    assert rules(result)["contentHasShortParagraphs"]["score"] == score


@pytest.mark.parametrize(
    ("images", "videos", "score"),
    [(0, 0, 0), (1, 0, 1), (2, 0, 2), (3, 0, 4), (4, 0, 6), (0, 1, 1), (0, 2, 2), (3, 2, 6)],
)
def test_asset_scoring_and_cap(images: int, videos: int, score: int) -> None:
    nodes = [paragraph("target content")]
    nodes.extend(image(index) for index in range(images))
    nodes.extend(video(index) for index in range(videos))
    result = analyze_seo(document(*nodes), metadata(), context=context())
    assert rules(result)["contentHasAssets"]["score"] == score


def test_gallery_counts_as_one_image_and_passes_image_alt() -> None:
    result = analyze_seo(
        document(paragraph("target content"), gallery()), metadata(), context=context()
    )
    result_rules = rules(result)
    assert result_rules["contentHasAssets"]["score"] == 1
    assert result_rules["keywordInImageAlt"]["score"] == 2


def test_gallery_does_not_pass_image_alt_without_focus_keyword() -> None:
    result = analyze_seo(
        document(paragraph("content"), gallery()),
        metadata(focus_keyword=""),
        context=context(),
    )

    assert rules(result)["keywordInImageAlt"]["score"] == 0


@pytest.mark.parametrize(
    ("word_count", "occurrences", "score"),
    [(200, 0, 0), (200, 1, 2), (400, 3, 6), (2500, 19, 3), (100, 1, 6), (200, 5, 6), (200, 6, 0)],
)
def test_keyword_density_boundaries(word_count: int, occurrences: int, score: int) -> None:
    body = " ".join(["target"] * occurrences + ["filler"] * (word_count - occurrences))
    assert rules(analyze(body))["keywordDensity"]["score"] == score


def test_keyword_density_counts_secondary_keywords_and_declares_dependency() -> None:
    body = " ".join(["secondary"] + ["filler"] * 199)
    result = rules(analyze(body, metadata=metadata(secondary_keywords=["secondary"])))

    assert result["keywordDensity"]["score"] == 2
    assert "secondary_keywords" in result["keywordDensity"]["dependencies"]
    assert "出现 1 次" in result["keywordDensity"]["message"]


@pytest.mark.parametrize(
    ("count", "score"),
    [(599, 0), (600, 2), (999, 2), (1000, 3), (1499, 3), (1500, 4), (1999, 4), (2000, 5), (2499, 5), (2500, 8)],
)
def test_content_length_boundaries(count: int, score: int) -> None:
    assert rules(analyze(" ".join(["word"] * count)))["lengthContent"]["score"] == score


@pytest.mark.parametrize(("length", "score"), [(75, 4), (76, 0)])
def test_permalink_length_boundary(length: int, score: int) -> None:
    full_url = "https://example.com/" + "a" * (length - len("https://example.com/"))
    assert rules(analyze(context=context(full_url=full_url)))["lengthPermalink"]["score"] == score


def test_permalink_keyword_matching_preserves_non_latin_characters() -> None:
    keyword_metadata = metadata(focus_keyword="検索エンジン")
    matched = rules(
        analyze(
            metadata=keyword_metadata,
            context=context(full_url="https://example.com/検索エンジン"),
        )
    )["keywordInPermalink"]
    unrelated = rules(
        analyze(
            metadata=keyword_metadata,
            context=context(full_url="https://example.com/unrelated"),
        )
    )["keywordInPermalink"]

    assert (matched["status"], matched["score"]) == ("passed", 5)
    assert (unrelated["status"], unrelated["score"]) == ("failed", 0)


def test_first_ten_percent_uses_all_400_words_then_floor_for_longer_content() -> None:
    at_400 = " ".join(["filler"] * 399 + ["target"])
    at_401_outside = " ".join(["filler"] * 40 + ["target"] + ["filler"] * 360)
    at_401_inside = " ".join(["filler"] * 39 + ["target"] + ["filler"] * 361)

    assert rules(analyze(at_400))["keywordIn10Percent"]["score"] == 3
    assert rules(analyze(at_401_outside))["keywordIn10Percent"]["score"] == 0
    assert rules(analyze(at_401_inside))["keywordIn10Percent"]["score"] == 3


def test_only_subheadings_match_and_title_half_boundary_is_strict() -> None:
    body_only = analyze_seo(
        document(heading("Overview", 2), paragraph("target content")),
        metadata(),
        context=context(),
    )
    subheading = analyze_seo(
        document(heading("Target section", 6), paragraph("content")),
        metadata(),
        context=context(),
    )
    assert rules(body_only)["keywordInSubheadings"]["score"] == 0
    assert rules(subheading)["keywordInSubheadings"]["score"] == 3

    before_half = analyze(metadata=metadata(focus_keyword="k", meta_title="aaaak12345"))
    at_half = analyze(metadata=metadata(focus_keyword="k", meta_title="aaaaak1234"))
    assert rules(before_half)["titleStartWithKeyword"]["score"] == 3
    assert rules(at_half)["titleStartWithKeyword"]["score"] == 0


def test_title_number_power_word_sentiment_negator_and_extras() -> None:
    result = rules(analyze(metadata=metadata(meta_title="Absolute 7 good target guide")))
    assert result["titleHasNumber"]["score"] == 1
    assert result["titleHasPowerWords"]["score"] == 1
    assert result["titleSentiment"]["score"] == 1
    assert _sentiment_score("good") == 5
    assert _sentiment_score("not good") == -5
    assert _sentiment_score("a+") == 5


def linked_paragraph(
    href: str, *, node_id: str = "linked-paragraph", rel: str | None = None
) -> dict:
    attrs = {"href": href}
    if rel:
        attrs["rel"] = rel
    return paragraph(
        "linked text", node_id=node_id, marks=[{"type": "link", "attrs": attrs}]
    )


def test_internal_external_and_dofollow_link_rules() -> None:
    nodes = [
        linked_paragraph("/inside", node_id="internal-link"),
        linked_paragraph(
            "https://outside.test/no-follow",
            node_id="nofollow-link",
            rel="nofollow",
        ),
        linked_paragraph("https://outside.test/follow", node_id="dofollow-link"),
    ]
    result = rules(analyze_seo(document(*nodes), metadata(), context=context()))
    assert result["linksHasInternal"]["score"] == 5
    assert result["linksHasExternals"]["score"] == 4
    assert result["linksNotAllExternals"]["score"] == 2

    nofollow = rules(
        analyze_seo(
            document(linked_paragraph("https://outside.test", rel="nofollow")),
            metadata(),
            context=context(),
        )
    )
    assert nofollow["linksHasExternals"]["score"] == 4
    assert nofollow["linksNotAllExternals"]["score"] == 0


def test_keyword_not_used_has_state_but_zero_weight() -> None:
    new = rules(analyze(context=context(keyword_is_new=True)))["keywordNotUsed"]
    reused = rules(analyze(context=context(keyword_is_new=False)))["keywordNotUsed"]
    assert (new["status"], new["score"], new["max_score"]) == ("passed", 0, 0)
    assert (reused["status"], reused["score"], reused["max_score"]) == ("failed", 0, 0)


def test_selective_reuse_tracks_title_and_secondary_keyword_dependencies() -> None:
    previous = analyze()
    title_change = analyze(
        metadata=metadata(meta_title="Different title"),
        changed_fields={"meta_title"},
        previous_results=previous,
    )
    assert rules(title_change)["keywordInTitle"]["reused"] is False
    assert rules(title_change)["keywordInContent"]["reused"] is True

    secondary_change = analyze(
        metadata=metadata(secondary_keywords=["filler"]),
        changed_fields={"secondary_keywords"},
        previous_results=previous,
    )
    assert rules(secondary_change)["keywordDensity"]["reused"] is False
    assert rules(secondary_change)["keywordInContent"]["reused"] is True


def test_hashes_are_canonical_and_match_frontend_utf8_fixture() -> None:
    fixture_document = {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": "block-1"},
                "content": [{"type": "text", "text": "中文 body", "marks": [{"type": "bold"}]}],
            }
        ],
    }
    fixture_metadata = {
        "title": "中文标题",
        "slug": "zhong-wen",
        "meta_title": "中文 SEO 标题",
        "meta_description": "中文描述",
        "focus_keyword": "中文关键词",
        "secondary_keywords": ["次关键词", "SEO"],
        "canonical_url": "https://example.com/zhong-wen",
        "indexing": "index/follow",
        "field_states": {"title": "confirmed", "meta_title": "modified"},
        "publication_status": "complete_draft",
    }
    assert document_hash(fixture_document) == "92f4a86349462421548d15854240c89e4cbcdf963b3d2673d5bff4f9fb865373"
    assert metadata_hash(fixture_metadata) == "d84c26b10a8bf15f1d0f7bc1e85a7d700ffd4c966766d3a1dc03a37ab1dcd56b"
    assert document_hash(fixture_document) == document_hash(deepcopy(fixture_document))
    assert metadata_hash(fixture_metadata) == metadata_hash(dict(reversed(list(fixture_metadata.items()))))


class SeoRepository:
    def __init__(self) -> None:
        now = datetime.now(UTC)
        self.project = SimpleNamespace(language="en", domain="example.com")
        self.keyword_is_new = True
        self.article = SimpleNamespace(
            id="article-1",
            project_id="project-1",
            primary_keyword="target",
            title="Target Guide",
            slug="target-guide",
            meta_title="Target Guide",
            meta_description="A practical target guide.",
            focus_keyword="target",
            secondary_keywords_json=[],
            canonical_url=None,
            indexing="index/follow",
            seo_field_states_json={},
            publication_status="complete_draft",
            document_json=document(paragraph("target guide content")),
            current_version_number=3,
            current_run_id=None,
            created_at=now,
            updated_at=now,
        )
        self.rows: list[SimpleNamespace] = []
        self.save_calls = 0

    async def get_article(self, organization_id: str, project_id: str, article_id: str):
        if (organization_id, project_id, article_id) != ("org-1", "project-1", "article-1"):
            return None
        return self.article, None

    async def get_project_link_context(self, organization_id, project_id, article_id):
        return {"article": self.article, "project": self.project}

    async def is_article_focus_keyword_new(self, *args):
        return self.keyword_is_new

    async def get_cached_seo_analysis(self, article_id, doc_hash, meta_hash, ruleset):
        return next(
            (
                row
                for row in reversed(self.rows)
                if row.article_id == article_id
                and row.document_hash == doc_hash
                and row.metadata_hash == meta_hash
                and row.ruleset_version == ruleset
                and row.status == "completed"
            ),
            None,
        )

    async def latest_seo_analysis(self, article_id, *, ruleset_version=None, completed_only=False):
        return next(
            (
                row
                for row in reversed(self.rows)
                if row.article_id == article_id
                and (ruleset_version is None or row.ruleset_version == ruleset_version)
                and (not completed_only or row.status == "completed")
            ),
            None,
        )

    async def save_seo_analysis(self, **values):
        self.save_calls += 1
        values.setdefault("error_code", None)
        values.setdefault("error_detail", None)
        existing = next(
            (
                row
                for row in self.rows
                if (row.article_id, row.document_hash, row.metadata_hash, row.ruleset_version)
                == (values["article_id"], values["document_hash"], values["metadata_hash"], values["ruleset_version"])
            ),
            None,
        )
        row = SimpleNamespace(
            **values,
            id=existing.id if existing else f"sea-{len(self.rows) + 1}",
            created_at=datetime.now(UTC),
        )
        if existing:
            self.rows[self.rows.index(existing)] = row
        else:
            self.rows.append(row)
        return row


def service_for(repository: SeoRepository) -> ContentService:
    return ContentService(
        Settings(default_organization_id="org-1"),
        repository,
        ai_settings=SimpleNamespace(),
        controller=SimpleNamespace(),
        service_connections=SimpleNamespace(),
    )


def analysis_request(repository: SeoRepository) -> ArticleSeoAnalysisRequest:
    return ArticleSeoAnalysisRequest(
        document_hash=document_hash(repository.article.document_json),
        metadata_hash=metadata_hash(article_metadata_snapshot(repository.article)),
    )


def test_service_cache_context_invalidation_and_latest_staleness() -> None:
    async def scenario() -> None:
        repository = SeoRepository()
        service = service_for(repository)
        request = analysis_request(repository)
        first = await service.analyze_article_seo("project-1", "article-1", request)
        repeated = await service.analyze_article_seo("project-1", "article-1", request)
        assert repeated.analysis_id == first.analysis_id
        assert repository.save_calls == 1

        for update in (
            lambda: setattr(repository.project, "language", "de"),
            lambda: setattr(repository.project, "domain", "changed.example"),
            lambda: setattr(repository, "keyword_is_new", False),
        ):
            update()
            await service.analyze_article_seo("project-1", "article-1", request)
        assert repository.save_calls == 4

        repository.article.current_run_id = "ordinary-generation-run"
        generated = await service.analyze_article_seo("project-1", "article-1", request)
        assert generated.analysis_id == first.analysis_id
        assert repository.save_calls == 4
        saved_context = repository.rows[0].input_snapshot["context"]
        assert saved_context["content_ai_used"] is False
        assert "content_ai_run_id" not in saved_context
        assert rules(repository.rows[0].results)["hasContentAI"]["score"] == 0

        current = await service.latest_article_seo_analysis("project-1", "article-1")
        assert current.is_stale is False
        repository.project.language = "fr"
        stale = await service.latest_article_seo_analysis("project-1", "article-1")
        assert stale.is_stale is True

    asyncio.run(scenario())


def test_service_rejects_stale_input_and_preserves_success_on_failure(monkeypatch) -> None:
    async def scenario() -> None:
        repository = SeoRepository()
        service = service_for(repository)
        request = analysis_request(repository)
        first = await service.analyze_article_seo("project-1", "article-1", request)

        with pytest.raises(ContentConflictError, match="seo_analysis_input_stale"):
            await service.analyze_article_seo(
                "project-1",
                "article-1",
                ArticleSeoAnalysisRequest(
                    document_hash="0" * 64, metadata_hash=request.metadata_hash
                ),
            )

        repository.article.meta_title = "Changed before failed analysis"
        updated = analysis_request(repository)

        def fail_analysis(*args, **kwargs):
            raise RuntimeError("ruleset unavailable")

        monkeypatch.setattr("app.modules.content.service.analyze_seo", fail_analysis)
        failed = await service.analyze_article_seo(
            "project-1",
            "article-1",
            ArticleSeoAnalysisRequest(
                document_hash=updated.document_hash,
                metadata_hash=updated.metadata_hash,
                changed_fields=["meta_title"],
                ruleset_version=RULESET_VERSION,
            ),
        )
        assert failed.analysis_id == first.analysis_id
        assert failed.status == "failed"
        assert failed.is_stale is True
        assert failed.groups == first.groups
        assert failed.error_code == "seo_analysis_failed"

    asyncio.run(scenario())
