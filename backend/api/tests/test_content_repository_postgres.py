import asyncio
import os
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.content import get_content_service
from app.core.config import Settings
from app.main import app
from app.modules.content.models import Article, ArticleIdempotencyKey, ArticleRun
from app.modules.content.repository import ContentRepository
from app.modules.content.service import ContentService
from app.modules.projects.models import Project
from app.modules.settings.service import AIProviderSettingsRecord


class FakeAISettings:
    async def effective_record(self) -> AIProviderSettingsRecord:
        return AIProviderSettingsRecord(
            base_url="https://models.example/v1",
            api_key="test-key",
            model="test-model",
        )


class FakeWorkflowController:
    async def start(self, _run_id: str) -> None:
        return None

    async def cancel(self, _workflow_id: str) -> None:
        return None


def content_test_database_url() -> str:
    value = os.getenv("CONTENT_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_TEST_DATABASE_URL is not configured")
    if not make_url(value).database.startswith("seo_content_stage1_test"):
        pytest.fail("Content integration tests require a dedicated seo_content_stage1_test database")
    return value


def test_content_api_persists_one_queued_task_per_idempotent_request() -> None:
    async def scenario() -> None:
        engine = create_async_engine(content_test_database_url(), pool_pre_ping=True)
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        service = ContentService(
            Settings(default_organization_id="test-org"),
            ContentRepository(sessions),
            ai_settings=FakeAISettings(),
            controller=FakeWorkflowController(),
        )
        project_a, project_b = str(uuid4()), str(uuid4())
        app.dependency_overrides[get_content_service] = lambda: service
        try:
            async with sessions() as session:
                session.add_all(
                    [
                        Project(
                            id=project_a,
                            organization_id="test-org",
                            name="Content project A",
                            domain=f"{project_a}.example.com",
                            country="US",
                            language="en",
                        ),
                        Project(
                            id=project_b,
                            organization_id="test-org",
                            name="Content project B",
                            domain=f"{project_b}.example.com",
                            country="US",
                            language="en",
                        ),
                    ]
                )
                await session.commit()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                first, repeated = await asyncio.gather(
                    client.post(
                        f"/api/v1/projects/{project_a}/articles",
                        headers={"Idempotency-Key": "postgres-request-1"},
                        json={"primary_keyword": "solar battery payback"},
                    ),
                    client.post(
                        f"/api/v1/projects/{project_a}/articles",
                        headers={"Idempotency-Key": "postgres-request-1"},
                        json={"primary_keyword": "solar battery payback"},
                    ),
                )
                article_id = first.json()["id"]
                listed = await client.get(f"/api/v1/projects/{project_a}/articles")
                detailed = await client.get(
                    f"/api/v1/projects/{project_a}/articles/{article_id}"
                )
                cross_project = await client.get(
                    f"/api/v1/projects/{project_b}/articles/{article_id}"
                )
                cancelled = await client.post(
                    f"/api/v1/projects/{project_a}/articles/{article_id}/cancel"
                )

            assert first.status_code == 202
            assert repeated.status_code == 202
            assert first.json() == repeated.json()
            assert listed.json()["total"] == 1
            assert detailed.json()["status"] == "queued"
            assert cross_project.status_code == 404
            assert cancelled.json()["status"] == "cancelled"
            assert cancelled.json()["run"]["status"] == "cancelled"

            async with sessions() as session:
                assert await session.scalar(select(func.count()).select_from(Article)) == 1
                assert await session.scalar(select(func.count()).select_from(ArticleRun)) == 1
                assert await session.scalar(
                    select(func.count()).select_from(ArticleIdempotencyKey)
                ) == 1
        finally:
            app.dependency_overrides.clear()
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id.in_([project_a, project_b])))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())
