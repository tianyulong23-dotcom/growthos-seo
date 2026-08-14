# ruff: noqa: E402
from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy.engine import make_url


EXPECTED_DATABASE_NAME = "seo_content_stage2_test"
FRONTEND_ORIGIN = os.environ.get(
    "ARTICLE_ACCEPTANCE_FRONTEND_ORIGIN", "http://127.0.0.1:8084"
).rstrip("/")


def _require_isolated_database() -> str:
    database_url = os.environ.get("DATABASE_URL", "").strip()
    test_database_url = os.environ.get("CONTENT_WORKFLOW_TEST_DATABASE_URL", "").strip()
    if not database_url or database_url != test_database_url:
        raise RuntimeError(
            "Browser acceptance requires DATABASE_URL to exactly match "
            "CONTENT_WORKFLOW_TEST_DATABASE_URL"
        )
    if make_url(database_url).database != EXPECTED_DATABASE_NAME:
        raise RuntimeError(
            f"Browser acceptance is restricted to {EXPECTED_DATABASE_NAME}"
        )
    return database_url


DATABASE_URL = _require_isolated_database()
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import delete

from app.api.routes.ai_edits import (
    get_ai_edit_service,
    router as ai_edits_router,
)
from app.api.routes.assets import get_asset_service, router as assets_router
from app.api.routes.content import (
    content_governance_router,
    get_content_service,
    router as content_router,
)
from app.api.routes.projects import get_project_service, router as projects_router
from app.api.routes.publications import (
    get_publication_service,
    preview_router as publication_preview_router,
    router as publications_router,
)
from app.core.config import Settings
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.db.session import session_factory
from app.modules.content.models import Article, ArticleRun, ArticleSource
from app.modules.content.ai_edit_repository import AIEditRepository
from app.modules.content.ai_edit_service import AIEditService
from app.modules.content.asset_repository import AssetRepository
from app.modules.content.asset_security import (
    AssetProcessor,
    AssetSecurityError,
    RemoteBytes,
    RemoteProbe,
)
from app.modules.content.asset_service import AssetProcessingDispatcher, AssetService
from app.modules.content.document import document_content_hash
from app.modules.content.object_storage import S3AssetObjectStore
from app.modules.content.publication import WordPressMediaResult, WordPressPublishResult
from app.modules.content.publication_orchestrator import PublicationOrchestrator
from app.modules.content.publication_repository import PublicationRepository
from app.modules.content.publication_service import PublicationService
from app.modules.content.repository import ContentRepository, article_metadata_snapshot
from app.modules.content.schemas import CreateArticleRequest
from app.modules.content.service import ContentService, ContentWorkflowState
from app.modules.crawling.models import CrawlRun
from app.modules.projects.models import Project, SiteProfile
from app.modules.projects.service import (
    SQLAlchemyProjectRepository,
    build_project_response,
)
from app.modules.settings.service import AIProviderSettingsRecord
from app.modules.settings.service_connections import WordPressConnectionRecord
from PIL import Image


PROJECT_ID = os.environ.get("ARTICLE_ACCEPTANCE_PROJECT_ID", "elephtv").strip()
PROJECT_DOMAIN = os.environ.get("ARTICLE_ACCEPTANCE_PROJECT_DOMAIN", "elephtv.com").strip()
ORGANIZATION_ID = "local"
PROFILE_RUN_ID = f"acceptance-site-profile:{PROJECT_ID}"
NOW = datetime.now(UTC)


class AcceptanceAISettings:
    async def effective_record(self) -> AIProviderSettingsRecord:
        return self._record()

    async def effective_record_for_organization(
        self, organization_id: str
    ) -> AIProviderSettingsRecord:
        assert organization_id == ORGANIZATION_ID
        return self._record()

    @staticmethod
    def _record() -> AIProviderSettingsRecord:
        return AIProviderSettingsRecord(
            base_url="https://models.invalid/v1",
            api_key="acceptance-only",
            model="acceptance-model",
            request_timeout_seconds=30,
            max_retries=1,
            updated_at=NOW,
        )


class AcceptanceWorkflowController:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.cancelled: list[str] = []

    async def start(self, run_id: str) -> None:
        if run_id not in self.started:
            self.started.append(run_id)

    async def cancel(self, workflow_id: str) -> None:
        self.cancelled.append(workflow_id)

    async def status(self, workflow_id: str) -> ContentWorkflowState:
        del workflow_id
        return ContentWorkflowState.RUNNING


class AcceptanceServiceConnections:
    async def get_wordpress(
        self, project_id: str, encryption_key: str | None
    ) -> WordPressConnectionRecord:
        assert project_id == PROJECT_ID
        assert encryption_key == "acceptance-encryption-key"
        return WordPressConnectionRecord(
            site_url="https://wordpress.invalid",
            username="acceptance-publisher",
            application_password="never-sent",
            verified_user="Acceptance Publisher",
            verified_at=NOW,
            capabilities={
                "media_upload": True,
                "media_lookup": True,
                "post_create": True,
                "post_update_by_remote_id": True,
                "post_reconcile": True,
                "theme_preview": False,
            },
        )


class AcceptanceWordPressTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.posts: dict[int, WordPressPublishResult] = {}
        self.post_slugs: dict[str, int] = {}
        self.media: dict[int, WordPressMediaResult] = {}
        self.media_slugs: dict[str, int] = {}

    async def publish(
        self,
        connection: WordPressConnectionRecord,
        payload: dict[str, object],
        *,
        post_id: int | None,
    ) -> WordPressPublishResult:
        assert connection.site_url == "https://wordpress.invalid"
        remote_id = post_id or 91001
        self.calls.append({"payload": payload, "post_id": post_id})
        marker = str(payload.get("content") or "").split("-->", 1)[0]
        payload_hash = marker.rsplit(":", 1)[-1].strip() if marker else None
        result = WordPressPublishResult(
            post_id=remote_id,
            url=f"https://wordpress.invalid/?p={remote_id}",
            status="publish",
            payload_hash=payload_hash,
        )
        self.posts[remote_id] = result
        slug = payload.get("slug")
        if isinstance(slug, str) and slug:
            self.post_slugs[slug] = remote_id
        return result

    async def get_post(
        self, connection: WordPressConnectionRecord, post_id: int
    ) -> WordPressPublishResult | None:
        assert connection.site_url == "https://wordpress.invalid"
        return self.posts.get(post_id)

    async def find_post_by_slug(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressPublishResult | None:
        assert connection.site_url == "https://wordpress.invalid"
        post_id = self.post_slugs.get(slug)
        return self.posts.get(post_id) if post_id is not None else None

    async def upload_media(
        self,
        connection: WordPressConnectionRecord,
        *,
        body: bytes,
        filename: str,
        mime_type: str,
        slug: str,
        title: str,
        alt_text: str,
        caption: str,
    ) -> WordPressMediaResult:
        assert connection.site_url == "https://wordpress.invalid"
        media_id = 92000 + len(self.media) + 1
        result = WordPressMediaResult(
            media_id=media_id,
            source_url=f"https://wordpress.invalid/media/{media_id}/{filename}",
            slug=slug,
        )
        self.calls.append(
            {
                "media_id": media_id,
                "byte_size": len(body),
                "filename": filename,
                "mime_type": mime_type,
                "slug": slug,
                "title": title,
                "alt_text": alt_text,
                "caption": caption,
            }
        )
        self.media[media_id] = result
        self.media_slugs[slug] = media_id
        return result

    async def get_media(
        self, connection: WordPressConnectionRecord, media_id: int
    ) -> WordPressMediaResult | None:
        assert connection.site_url == "https://wordpress.invalid"
        return self.media.get(media_id)

    async def find_media_by_slug(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressMediaResult | None:
        assert connection.site_url == "https://wordpress.invalid"
        media_id = self.media_slugs.get(slug)
        return self.media.get(media_id) if media_id is not None else None


class AcceptanceUrlImporter:
    async def download(
        self, url: str, destination: str, maximum_bytes: int
    ) -> tuple[str, str]:
        if url != "https://source.example/solar-cover.jpg":
            raise AssetSecurityError(
                "asset_import_ssrf_blocked", "acceptance blocked address"
            )
        image = Image.new("RGB", (640, 360), color=(35, 110, 154))
        image.save(destination, format="JPEG", quality=88)
        if Path(destination).stat().st_size > maximum_bytes:
            raise AssetSecurityError("asset_too_large", "acceptance image is too large")
        return url, "image/jpeg"

    async def fetch_bytes(self, url: str, maximum_bytes: int) -> RemoteBytes:
        assert maximum_bytes == 2 * 1024 * 1024
        if url == "https://source.example/solar-payback":
            return RemoteBytes(
                final_url=url,
                content_type="text/html",
                content=(
                    b"<html><head>"
                    b'<meta property="og:title" content="Solar payback research">'
                    b'<meta property="og:description" content="Independent payback methodology and source data.">'
                    b'<meta property="og:site_name" content="Source Research">'
                    b'<meta property="og:image" content="/solar-cover.jpg">'
                    b'<link rel="icon" href="/favicon.ico">'
                    b"</head></html>"
                ),
            )
        if url == "https://slow.example/source":
            raise AssetSecurityError(
                "asset_import_timeout", "acceptance timeout", retryable=True
            )
        raise AssetSecurityError(
            "asset_import_ssrf_blocked", "acceptance blocked address"
        )

    async def probe(self, url: str) -> RemoteProbe:
        if url == "https://source.example/solar-payback":
            return RemoteProbe(final_url=url, status_code=200, redirect_chain=())
        if url == "https://slow.example/source":
            raise AssetSecurityError(
                "asset_import_timeout", "acceptance timeout", retryable=True
            )
        raise AssetSecurityError(
            "asset_import_ssrf_blocked", "acceptance blocked address"
        )


class AcceptancePlatformContextResolver:
    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del required_permission
        user_id = request.headers.get("x-acceptance-user", "acceptance-reviewer")
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id=user_id,
                session_id="acceptance-session",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id=ORGANIZATION_ID,
                workspace_id="acceptance-workspace",
            ),
            project=PlatformProject(
                website_project_id=website_project_key,
                website_project_key=website_project_key,
            ),
            permissions=(
                "content:read",
                "content:write",
                "content:edit",
                "content:submit_review",
                "content:review",
                "content:publish",
                "content:manage_locks",
                "content:manage_seo_advanced",
                "content:manage_assets",
                "content:ai_edit",
            ),
            correlation_id="acceptance-request",
        )


class AcceptanceProjectService:
    def __init__(self) -> None:
        self.repository = SQLAlchemyProjectRepository(session_factory)

    async def list(self):
        projects = await self.repository.list(ORGANIZATION_ID)
        return [build_project_response(project) for project in projects]

    async def get(self, project_id: str):
        project = await self.repository.get(ORGANIZATION_ID, project_id)
        return build_project_response(project) if project is not None else None


workflow_controller = AcceptanceWorkflowController()
wordpress_transport = AcceptanceWordPressTransport()
project_service = AcceptanceProjectService()
settings = Settings(
    app_env="test",
    database_url=DATABASE_URL,
    default_organization_id=ORGANIZATION_ID,
    ai_settings_encryption_key="acceptance-encryption-key",
    asset_management_enabled=True,
)
content_repository = ContentRepository(session_factory)
ai_edit_service = AIEditService(
    settings,
    AIEditRepository(session_factory),
)
service_connections = AcceptanceServiceConnections()
content_service = ContentService(
    settings,
    content_repository,
    ai_settings=AcceptanceAISettings(),
    controller=workflow_controller,
    service_connections=service_connections,  # type: ignore[arg-type]
    wordpress_transport=wordpress_transport,
    url_importer=AcceptanceUrlImporter(),  # type: ignore[arg-type]
)
publication_repository = PublicationRepository(session_factory)
asset_repository = AssetRepository(session_factory)
publication_store = S3AssetObjectStore(settings)
asset_service = AssetService(
    repository=asset_repository,
    store=publication_store,
    settings=settings,
)
asset_processor = AssetProcessor(settings, publication_store)
asset_processor.importer = AcceptanceUrlImporter()  # type: ignore[assignment]
asset_dispatcher = AssetProcessingDispatcher(
    repository=asset_repository,
    processor=asset_processor,
    settings=settings,
    worker_id="acceptance-asset-worker",
)
publication_service = PublicationService(
    settings,
    publication_repository,
    content_repository,
    service_connections,  # type: ignore[arg-type]
    publication_store,
    wordpress_transport,
)
publication_orchestrator = PublicationOrchestrator(
    settings,
    publication_repository,
    service_connections,  # type: ignore[arg-type]
    wordpress_transport,
    publication_store,
    worker_id="acceptance-publication-worker",
    lease_seconds=30,
)
seeded_article_ids: dict[str, str] = {}


async def _seed_acceptance_data() -> None:
    async with session_factory() as session:
        await session.execute(delete(Project).where(Project.id == PROJECT_ID))
        await session.execute(delete(CrawlRun).where(CrawlRun.run_id == PROFILE_RUN_ID))
        session.add(
            Project(
                id=PROJECT_ID,
                organization_id=ORGANIZATION_ID,
                name="ElephTV",
                domain=PROJECT_DOMAIN,
                country="US",
                language="en",
                health=84,
            )
        )
        session.add(
            CrawlRun(
                run_id=PROFILE_RUN_ID,
                organization_id=ORGANIZATION_ID,
                project_id=PROJECT_ID,
                task_type="site_understanding",
                status="completed",
                config_snapshot={},
                summary={},
                finished_at=NOW,
            )
        )
        session.add(
            SiteProfile(
                project_id=PROJECT_ID,
                source_run_id=PROFILE_RUN_ID,
                profile_json={
                    "business_name": "ElephTV Solar",
                    "business_type": "solar education",
                    "business_summary": "Independent solar planning resources.",
                    "target_audiences": ["homeowners comparing solar systems"],
                    "products_services": ["solar planning guides"],
                    "value_propositions": ["evidence-led payback guidance"],
                    "key_pages": [
                        {
                            "title": "Solar battery installation guide",
                            "url": "https://elephtv.com/solar-battery-installation",
                            "description": "Installation steps, system sizing, and payback inputs.",
                        }
                    ],
                },
                user_overrides={},
                confidence=0.95,
            )
        )
        await session.commit()

    failed = await content_service.create_article(
        PROJECT_ID,
        CreateArticleRequest(primary_keyword="failed article acceptance"),
        "acceptance-seed-failed",
        organization_id=ORGANIZATION_ID,
    )
    completed = await content_service.create_article(
        PROJECT_ID,
        CreateArticleRequest(primary_keyword="solar battery payback"),
        "acceptance-seed-completed",
        organization_id=ORGANIZATION_ID,
    )
    read_only = await content_service.create_article(
        PROJECT_ID,
        CreateArticleRequest(primary_keyword="read only card acceptance"),
        "acceptance-seed-read-only",
        organization_id=ORGANIZATION_ID,
    )
    seeded_article_ids.update(
        failed=failed.id,
        completed=completed.id,
        read_only=read_only.id,
    )

    document = {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "heading",
                "attrs": {"node_id": "heading-intro", "level": 2},
                "content": [{"type": "text", "text": "Solar battery payback guide"}],
            },
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-summary"},
                "content": [
                    {
                        "type": "text",
                        "text": "Compare installation cost, incentives, and annual savings.",
                    }
                ],
            },
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-link"},
                "content": [
                    {"type": "text", "text": "Review the "},
                    {
                        "type": "text",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {
                                    "href": "https://elephtv.com/solar-financing",
                                    "target": "_blank",
                                    "rel": "noopener noreferrer",
                                },
                            }
                        ],
                        "text": "solar financing options",
                    },
                    {"type": "text", "text": " before choosing a system."},
                ],
            },
            {
                "type": "bookmark",
                "attrs": {
                    "node_id": "bookmark-source",
                    "url": "https://source.example/solar-payback",
                    "title": "Solar payback research",
                    "description": "Independent payback methodology and source data.",
                    "publisher": "Source Research",
                    "icon_url": "https://source.example/favicon.ico",
                    "image_url": "https://source.example/solar-cover.jpg",
                    "fetched_at": "2026-08-09T00:00:00Z",
                },
            },
            {
                "type": "button",
                "attrs": {
                    "node_id": "button-calculator",
                    "label": "Open the payback calculator",
                    "href": "https://elephtv.com/solar-calculator",
                    "style": "primary",
                    "target": "_blank",
                    "rel": "noopener noreferrer",
                },
            },
            {
                "type": "embed",
                "attrs": {
                    "node_id": "embed-youtube",
                    "provider": "youtube",
                    "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "embed_id": "dQw4w9WgXcQ",
                    "caption": "Solar battery installation walkthrough",
                },
            },
        ],
    }
    async with session_factory() as session:
        failed_article = await session.get(Article, failed.id)
        failed_run = await session.get(ArticleRun, failed.run.id if failed.run else "")
        completed_article = await session.get(Article, completed.id)
        completed_run = await session.get(
            ArticleRun, completed.run.id if completed.run else ""
        )
        read_only_article = await session.get(Article, read_only.id)
        read_only_run = await session.get(
            ArticleRun, read_only.run.id if read_only.run else ""
        )
        assert (
            failed_article
            and failed_run
            and completed_article
            and completed_run
            and read_only_article
            and read_only_run
        )

        failed_article.status = "failed"
        failed_run.status = "failed"
        failed_run.stage = "research"
        failed_run.progress = 28
        failed_run.error_code = "research_provider_unavailable"
        failed_run.error_detail = "Research provider failed after bounded retries."
        failed_run.failed_stage = "research"
        failed_run.retryable = True
        failed_run.finished_at = NOW

        completed_article.title = "Solar battery payback guide"
        completed_article.slug = "solar-battery-payback-guide"
        completed_article.meta_title = "Solar Battery Payback Guide"
        completed_article.meta_description = (
            "Calculate solar battery payback using costs, incentives, and savings."
        )
        completed_article.document_json = document
        completed_article.markdown = (
            "# Solar battery payback guide\n\n"
            "Compare installation cost, incentives, and annual savings.\n\n"
            "Review the [solar financing options]"
            "(https://elephtv.com/solar-financing) before choosing a system.\n"
        )
        completed_article.html = (
            "<h1>Solar battery payback guide</h1>"
            "<p>Compare installation cost, incentives, and annual savings.</p>"
            "<p>Review the <a href=\"https://elephtv.com/solar-financing\" "
            "rel=\"noopener noreferrer\">solar financing options</a> before "
            "choosing a system.</p>"
        )
        completed_article.status = "completed"
        completed_article.publication_status = "publish_ready"
        completed_article.review_status = "pending_review"
        completed_article.review_version = 1
        completed_article.publication_blocked_reason = "awaiting_review"
        completed_article.current_content_hash = document_content_hash(
            document, article_metadata_snapshot(completed_article)
        )
        completed_run.status = "completed"
        completed_run.stage = "completed"
        completed_run.progress = 100
        completed_run.retryable = None
        completed_run.finished_at = NOW
        read_only_article.title = "Read-only enhanced card preview"
        read_only_article.slug = "read-only-enhanced-card-preview"
        read_only_article.meta_title = "Read-only enhanced card preview"
        read_only_article.meta_description = (
            "Verify enhanced cards remain visible when a future schema is read-only."
        )
        read_only_article.document_json = {**document, "schema_version": 3}
        read_only_article.document_schema_version = 3
        read_only_article.status = "completed"
        read_only_article.publication_status = "publish_ready"
        read_only_article.review_status = "pending_review"
        read_only_article.review_version = 1
        read_only_article.publication_blocked_reason = "awaiting_review"
        read_only_run.status = "completed"
        read_only_run.stage = "completed"
        read_only_run.progress = 100
        read_only_run.retryable = None
        read_only_run.finished_at = NOW
        session.add_all(
            [
                ArticleSource(
                id=str(uuid4()),
                run_id=completed_run.id,
                source_type="internal",
                url="https://elephtv.com/solar-financing",
                normalized_url="https://elephtv.com/solar-financing",
                title="Solar financing options",
                domain="elephtv.com",
                retrieved_at=NOW,
                status="available",
                ),
                ArticleSource(
                    id=str(uuid4()),
                    run_id=completed_run.id,
                    source_type="research",
                    url="https://source.example/solar-payback",
                    normalized_url="https://source.example/solar-payback",
                    title="Solar payback methodology",
                    domain="source.example",
                    retrieved_at=NOW,
                    status="available",
                    claims_json=[
                        {
                            "claim_id": "claim-payback-inputs",
                            "text": "Payback estimates depend on installation cost, incentives, and annual savings.",
                        }
                    ],
                    section_ids_json=["heading-intro", "paragraph-summary"],
                ),
            ]
        )
        await session.commit()


@asynccontextmanager
async def lifespan(application: FastAPI):
    del application
    await _seed_acceptance_data()

    async def dispatch_queued() -> None:
        while True:
            await content_service.dispatch_queued()
            await asyncio.sleep(0.1)

    dispatcher = asyncio.create_task(dispatch_queued())
    publication_dispatcher = asyncio.create_task(
        publication_orchestrator.run_forever(poll_seconds=0.1)
    )
    asset_processing_dispatcher = asyncio.create_task(asset_dispatcher.run_forever())
    try:
        yield
    finally:
        dispatcher.cancel()
        publication_dispatcher.cancel()
        asset_processing_dispatcher.cancel()
        with suppress(asyncio.CancelledError):
            await dispatcher
        with suppress(asyncio.CancelledError):
            await publication_dispatcher
        with suppress(asyncio.CancelledError):
            await asset_processing_dispatcher


app = FastAPI(title="Article browser acceptance", lifespan=lifespan)
app.state.platform_context_resolver = AcceptancePlatformContextResolver()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(projects_router)
app.include_router(content_router)
app.include_router(content_governance_router)
app.include_router(ai_edits_router)
app.include_router(assets_router)
app.include_router(publications_router)
app.include_router(publication_preview_router)
app.dependency_overrides[get_project_service] = lambda: project_service
app.dependency_overrides[get_content_service] = lambda: content_service
app.dependency_overrides[get_ai_edit_service] = lambda: ai_edit_service
app.dependency_overrides[get_asset_service] = lambda: asset_service
app.dependency_overrides[get_publication_service] = lambda: publication_service


@app.get("/acceptance/evidence")
async def acceptance_evidence() -> dict[str, object]:
    return {
        "database": make_url(DATABASE_URL).database,
        "external_ai_calls": 0,
        "external_wordpress_calls": 0,
        "fake_wordpress_calls": len(wordpress_transport.calls),
        "fake_wordpress_payloads": wordpress_transport.calls,
        "started_run_ids": workflow_controller.started,
        "seeded_article_ids": seeded_article_ids,
    }
