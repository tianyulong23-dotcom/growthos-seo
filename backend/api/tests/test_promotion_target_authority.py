import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.modules.projects.service import (
    PROMOTION_TARGET_REFERENCE_LIMIT,
    PromotionTargetReferenceError,
    SQLAlchemyProjectRepository,
    _promotion_target_keywords,
)


class _Rows:
    def __init__(self, rows: list[object]) -> None:
        self._rows = rows

    def all(self) -> list[object]:
        return self._rows


class _AuthoritySession:
    def __init__(self, project: object, keyword_ids: list[str]) -> None:
        self.project = project
        self.keyword_ids = keyword_ids
        self.scalar_queries = 0

    async def scalar(self, _statement: object) -> object:
        return self.project

    async def scalars(self, _statement: object) -> _Rows:
        self.scalar_queries += 1
        return _Rows(self.keyword_ids if self.scalar_queries == 1 else [])


class _ReferenceSession:
    def __init__(
        self,
        *,
        keyword_rows: list[object] | None = None,
        publication_rows: list[tuple[object, object]] | None = None,
    ) -> None:
        self.keyword_rows = keyword_rows or []
        self.publication_rows = publication_rows or []

    async def scalars(self, _statement: object) -> _Rows:
        return _Rows(self.keyword_rows)

    async def execute(self, _statement: object) -> _Rows:
        return _Rows(self.publication_rows)


def _project() -> SimpleNamespace:
    return SimpleNamespace(
        id="project-1",
        organization_id="org-1",
        workspace_id="workspace-1",
        country="US",
        language="en",
        context_version=4,
        current_profile_version_id="profile-v4",
    )


def _keyword(
    identifier: str,
    *,
    priority_score: float | None,
    created_at: datetime,
    project_id: str = "project-1",
    status: str = "active",
    review_status: str = "approved",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=identifier,
        organization_id="org-1",
        project_id=project_id,
        country="US",
        language="en",
        keyword=f"topic {identifier}",
        business_topic=None,
        priority_score=priority_score,
        created_at=created_at,
        status=status,
        review_status=review_status,
    )


def _publication(
    identifier: str,
    *,
    published_at: datetime,
    project_id: str = "project-1",
    status: str = "published",
    remote_url: str | None = None,
) -> tuple[SimpleNamespace, SimpleNamespace]:
    publication = SimpleNamespace(
        id=identifier,
        organization_id="org-1",
        project_id=project_id,
        status=status,
        remote_url=remote_url or f"https://example.com/{identifier}",
        published_at=published_at,
        created_at=published_at - timedelta(hours=1),
    )
    article = SimpleNamespace(
        organization_id="org-1",
        project_id=project_id,
        primary_keyword=f"published keyword {identifier}",
        title=f"Published title {identifier}",
    )
    return publication, article


def test_authority_refresh_bounds_more_than_100_approved_keywords() -> None:
    project = _project()
    keyword_ids = [f"keyword-{index:03d}" for index in range(150)]
    session = _AuthoritySession(project, keyword_ids)
    repository = SQLAlchemyProjectRepository(lambda: None)  # type: ignore[arg-type]
    captured_requests = []

    async def capture_publish(
        _session: object,
        _project_row: object,
        request: object,
        *,
        created_by: str,
    ) -> None:
        captured_requests.append((request, created_by))

    repository._publish_promotion_target_in_session = capture_publish  # type: ignore[method-assign]

    asyncio.run(
        repository.refresh_promotion_target_from_authority(
            session,  # type: ignore[arg-type]
            organization_id="org-1",
            project_id="project-1",
            created_by="keywords-service",
        )
    )

    request, created_by = captured_requests[0]
    assert len(request.approved_keyword_ids) == PROMOTION_TARGET_REFERENCE_LIMIT
    assert request.approved_keyword_ids == keyword_ids[:PROMOTION_TARGET_REFERENCE_LIMIT]
    assert created_by == "keywords-service"


def test_promotion_topics_prioritize_published_content_and_keyword_score() -> None:
    now = datetime(2026, 8, 19, 8, tzinfo=UTC)
    keywords = [
        _keyword(
            f"keyword-{index}",
            priority_score=float(index),
            created_at=now + timedelta(minutes=index),
        )
        for index in range(10)
    ]
    publications = [
        _publication("older", published_at=now - timedelta(days=1)),
        _publication("newer", published_at=now),
    ]

    topics = _promotion_target_keywords(
        list(reversed(keywords)),
        list(reversed(publications)),
    )

    assert topics[:8] == [
        "published keyword newer",
        "Published title newer",
        "published keyword older",
        "Published title older",
        "topic keyword-9",
        "topic keyword-8",
        "topic keyword-7",
        "topic keyword-6",
    ]
    assert topics == _promotion_target_keywords(keywords, publications)


def test_approved_keyword_order_is_stable_when_query_order_changes() -> None:
    now = datetime(2026, 8, 19, 8, tzinfo=UTC)
    rows = [
        _keyword("low", priority_score=10, created_at=now),
        _keyword("high", priority_score=90, created_at=now + timedelta(minutes=1)),
    ]

    first = asyncio.run(
        SQLAlchemyProjectRepository._approved_keyword_references(
            _ReferenceSession(keyword_rows=rows),  # type: ignore[arg-type]
            _project(),  # type: ignore[arg-type]
            ["low", "high"],
        )
    )
    second = asyncio.run(
        SQLAlchemyProjectRepository._approved_keyword_references(
            _ReferenceSession(keyword_rows=list(reversed(rows))),  # type: ignore[arg-type]
            _project(),  # type: ignore[arg-type]
            ["high", "low"],
        )
    )

    assert [row.id for row in first] == ["high", "low"]
    assert [row.id for row in second] == ["high", "low"]


@pytest.mark.parametrize(
    ("keyword", "message"),
    [
        (
            _keyword(
                "cross-project",
                priority_score=80,
                created_at=datetime(2026, 8, 19, tzinfo=UTC),
                project_id="project-2",
            ),
            "不属于当前项目",
        ),
        (
            _keyword(
                "unapproved",
                priority_score=80,
                created_at=datetime(2026, 8, 19, tzinfo=UTC),
                review_status="needs_review",
            ),
            "尚未批准",
        ),
    ],
)
def test_keyword_references_reject_non_authoritative_rows(
    keyword: SimpleNamespace,
    message: str,
) -> None:
    with pytest.raises(PromotionTargetReferenceError, match=message):
        asyncio.run(
            SQLAlchemyProjectRepository._approved_keyword_references(
                _ReferenceSession(keyword_rows=[keyword]),  # type: ignore[arg-type]
                _project(),  # type: ignore[arg-type]
                [keyword.id],
            )
        )


@pytest.mark.parametrize(
    ("publication", "message"),
    [
        (
            _publication(
                "cross-project",
                published_at=datetime(2026, 8, 19, tzinfo=UTC),
                project_id="project-2",
            ),
            "不属于当前项目",
        ),
        (
            _publication(
                "unpublished",
                published_at=datetime(2026, 8, 19, tzinfo=UTC),
                status="queued",
            ),
            "尚未发布",
        ),
    ],
)
def test_publication_references_reject_non_authoritative_rows(
    publication: tuple[SimpleNamespace, SimpleNamespace],
    message: str,
) -> None:
    publication_row, _article = publication
    with pytest.raises(PromotionTargetReferenceError, match=message):
        asyncio.run(
            SQLAlchemyProjectRepository._published_target_references(
                _ReferenceSession(publication_rows=[publication]),  # type: ignore[arg-type]
                _project(),  # type: ignore[arg-type]
                [publication_row.id],
            )
        )
