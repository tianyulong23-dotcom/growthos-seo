from __future__ import annotations

import os
from uuid import uuid4

import pytest
from sqlalchemy import delete
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.models import Article
from app.modules.keywords.coverage import SQLAlchemyKeywordCoverageQuery
from app.modules.keywords.schemas import KeywordCoverageBatchRequest, KeywordCoverageInput
from app.modules.projects.models import Project


pytestmark = pytest.mark.anyio


def _database_url() -> str:
    value = os.getenv("KEYWORD_COVERAGE_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("KEYWORD_COVERAGE_TEST_DATABASE_URL is required for PostgreSQL tests")
    database = make_url(value).database or ""
    if not database.startswith("seo_keyword_coverage_test"):
        pytest.fail(
            "Coverage integration tests require a dedicated seo_keyword_coverage_test database"
        )
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


async def test_postgres_coverage_marks_only_active_article_keywords_as_covered() -> None:
    engine = create_async_engine(
        _database_url(),
        pool_pre_ping=True,
        connect_args={"server_settings": {"search_path": "platform, public"}},
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    token = uuid4().hex
    project_id = f"coverage-project-{token}"
    article_id = f"coverage-article-{token}"
    cancelled_article_id = f"coverage-cancelled-{token}"
    try:
        async with sessions() as session:
            session.add(
                Project(
                    id=project_id,
                    organization_id="coverage-test-org",
                    name="Coverage contract test",
                    domain=f"{token}.example.test",
                    country="US",
                    language="en",
                )
            )
            await session.flush()
            session.add_all(
                [
                    Article(
                        id=article_id,
                        organization_id="coverage-test-org",
                        project_id=project_id,
                        primary_keyword="  Car   Detailing Cost ",
                        status="queued",
                    ),
                    Article(
                        id=cancelled_article_id,
                        organization_id="coverage-test-org",
                        project_id=project_id,
                        primary_keyword="cancelled topic",
                        status="cancelled",
                    ),
                ]
            )
            await session.commit()

        response = await SQLAlchemyKeywordCoverageQuery(sessions).query(
            KeywordCoverageBatchRequest(
                project_id=project_id,
                keywords=[
                    KeywordCoverageInput(
                        request_id="rk-covered",
                        keyword="car detailing cost",
                    ),
                    KeywordCoverageInput(
                        request_id="rk-cancelled",
                        keyword="cancelled topic",
                    ),
                    KeywordCoverageInput(
                        request_id="rk-no-evidence",
                        keyword="unmapped site topic",
                    ),
                ],
            )
        )

        assert [item.status for item in response.results] == [
            "covered",
            "uncovered",
            "uncovered",
        ]
        assert response.results[0].relation_id == article_id
        assert response.results[1].relation_id is None
        assert response.results[2].relation_id is None
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == project_id))
            await session.commit()
        await engine.dispose()
