import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.authoritative_platform_context import (
    AuthoritativePlatformContextResolver,
    LocalDevelopmentPlatformContextResolver,
)
from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolver,
    RejectingPlatformContextResolver,
)
from app.core.config import Settings, get_settings
from app.core.platform_auth import HmacPlatformAuthenticationAuthority
from app.core.secure_logging import configure_sensitive_logging
from app.db.session import session_factory
from app.modules.audit.service import AuditService, build_audit_service
from app.modules.agent.service import build_agent_service
from app.modules.content.service import build_content_service
from app.modules.content.asset_service import build_asset_dispatcher
from app.modules.content.publication_orchestrator import build_publication_orchestrator
from app.modules.content_plan.d6_service import build_content_plan_d6_service
from app.modules.content_plan.batch_service import build_content_plan_batch_service
from app.modules.keywords.service import KeywordService, build_keyword_service
from app.modules.onboarding.service import OnboardingService, build_onboarding_service
from app.modules.performance.service import PerformanceService, build_performance_service
from app.modules.projects.authority import SQLAlchemyWebsiteProjectAuthority
from app.modules.projects.service import ProjectService, build_project_service
from app.workflows.worker import get_crawler_worker_launcher

logger = logging.getLogger(__name__)


async def dispatch_site_understanding_workflows(
    service: ProjectService,
    interval_seconds: float,
) -> None:
    while True:
        try:
            await service.dispatch_pending_workflows()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to dispatch pending site understanding workflows")
        await asyncio.sleep(max(interval_seconds, 0.1))


async def reconcile_onboarding_runs(
    service: OnboardingService,
    interval_seconds: float,
) -> None:
    while True:
        try:
            await service.reconcile_all()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to reconcile onboarding runs")
        await asyncio.sleep(max(interval_seconds, 1))


async def dispatch_audit_workflows(
    service: AuditService,
    interval_seconds: float,
) -> None:
    while True:
        try:
            await service.dispatch_pending_workflows()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to dispatch pending technical audit workflows")
        await asyncio.sleep(max(interval_seconds, 0.1))


async def dispatch_keyword_workflows(
    service: KeywordService,
    interval_seconds: float,
) -> None:
    while True:
        try:
            await service.dispatch_pending_workflows()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to dispatch pending keyword workflows")
        await asyncio.sleep(max(interval_seconds, 0.1))


async def reconcile_keyword_workflows(
    service: KeywordService,
    interval_seconds: float,
    timeout_seconds: float,
) -> None:
    while True:
        try:
            await asyncio.wait_for(
                service.reconcile_active_runs(),
                timeout=max(timeout_seconds, 0.1),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to reconcile active keyword workflows")
        await asyncio.sleep(max(interval_seconds, 1))


async def dispatch_agent_workflows() -> None:
    service = build_agent_service()
    last_alert_signature: tuple | None = None
    while True:
        try:
            await service.dispatch_queued()
            summary = await service.operation_summary()
            alert_signature = (
                tuple(sorted(str(item.get("run_id")) for item in summary.stuck_runs)),
                tuple(sorted(summary.recent_failure_codes.items())),
            )
            if summary.stuck_runs:
                if alert_signature != last_alert_signature:
                    logger.error(
                        "Agent stuck-run alert: count=%s runs=%s",
                        len(summary.stuck_runs),
                        [item.get("run_id") for item in summary.stuck_runs],
                    )
            elif summary.recent_failed and alert_signature != last_alert_signature:
                logger.warning(
                    "Agent recent failures: count=%s codes=%s",
                    summary.recent_failed,
                    summary.recent_failure_codes,
                )
            last_alert_signature = alert_signature
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to dispatch queued Agent workflows")
        await asyncio.sleep(5)


async def dispatch_content_workflows() -> None:
    service = build_content_service()
    while True:
        try:
            await service.dispatch_queued()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to dispatch queued article workflows")
        await asyncio.sleep(5)


async def reconcile_content_workflows(
    interval_seconds: float,
    timeout_seconds: float,
) -> None:
    service = build_content_service()
    while True:
        try:
            await asyncio.wait_for(
                service.reconcile_active_runs(),
                timeout=max(timeout_seconds, 0.1),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to reconcile active article workflows")
        await asyncio.sleep(max(interval_seconds, 1))


async def sync_performance_data(
    service: PerformanceService,
    interval_seconds: float,
) -> None:
    while True:
        try:
            await service.sync_due_projects()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to synchronize due performance projects")
        await asyncio.sleep(max(interval_seconds, 60))


async def dispatch_content_plan_preparations() -> None:
    preparation_service = build_content_plan_d6_service()
    batch_service = build_content_plan_batch_service()
    if preparation_service.dispatcher is None and batch_service.dispatcher is None:
        return
    while True:
        try:
            if batch_service.dispatcher is not None:
                batches = (
                    await batch_service.repository.list_recoverable_automatic_batches()
                )
                for batch in batches:
                    await batch_service.dispatcher.dispatch_batch(batch.batch_id)
            if preparation_service.dispatcher is not None:
                targets = (
                    await preparation_service.repository.list_recoverable_preparations()
                )
                for target in targets:
                    await preparation_service.dispatcher.dispatch(
                        target.preparation_id
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unable to dispatch recoverable content-plan work")
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(application: FastAPI):
    settings = get_settings()
    configure_sensitive_logging(settings)
    worker_launcher = get_crawler_worker_launcher()
    audit_service = build_audit_service()
    dispatch_task = asyncio.create_task(
        dispatch_site_understanding_workflows(
            build_project_service(),
            settings.site_understanding_dispatch_interval_seconds,
        )
    )
    audit_dispatch_task = asyncio.create_task(
        dispatch_audit_workflows(
            audit_service,
            settings.site_understanding_dispatch_interval_seconds,
        )
    )
    agent_dispatch_task = asyncio.create_task(dispatch_agent_workflows())
    content_dispatch_task = asyncio.create_task(dispatch_content_workflows())
    content_reconcile_task = asyncio.create_task(
        reconcile_content_workflows(
            settings.content_reconcile_interval_seconds,
            settings.content_reconcile_timeout_seconds,
        )
    )
    onboarding_service = build_onboarding_service()
    onboarding_reconcile_task = asyncio.create_task(
        reconcile_onboarding_runs(
            onboarding_service,
            settings.site_understanding_dispatch_interval_seconds,
        )
    )
    content_plan_dispatch_task = asyncio.create_task(
        dispatch_content_plan_preparations()
    )
    asset_processing_task = asyncio.create_task(build_asset_dispatcher().run_forever())
    publication_dispatch_task = asyncio.create_task(
        build_publication_orchestrator().run_forever(
            settings.publication_dispatch_poll_seconds
        )
    )
    keyword_service = build_keyword_service()
    keyword_dispatch_task = asyncio.create_task(
        dispatch_keyword_workflows(
            keyword_service,
            settings.keyword_dispatch_interval_seconds,
        )
    )
    keyword_reconcile_task = asyncio.create_task(
        reconcile_keyword_workflows(
            keyword_service,
            settings.keyword_reconcile_interval_seconds,
            settings.keyword_reconcile_timeout_seconds,
        )
    )
    performance_sync_task = asyncio.create_task(
        sync_performance_data(
            build_performance_service(),
            settings.performance_sync_interval_seconds,
        )
    )
    try:
        await asyncio.wait_for(
            audit_service.reconcile_active_runs(),
            timeout=settings.audit_reconcile_timeout_seconds,
        )
    except Exception:
        logger.exception("Unable to reconcile active audit runs during startup")
    try:
        await build_agent_service().reconcile_active_runs()
    except Exception:
        logger.exception("Unable to reconcile active Agent runs during startup")
    try:
        await onboarding_service.reconcile_all(limit=500)
    except Exception:
        logger.exception("Unable to reconcile onboarding runs during startup")
    try:
        await asyncio.wait_for(
            build_content_service().reconcile_active_runs(),
            timeout=settings.content_reconcile_timeout_seconds,
        )
    except Exception:
        logger.exception("Unable to reconcile active article runs during startup")
    try:
        yield
    finally:
        dispatch_task.cancel()
        onboarding_reconcile_task.cancel()
        audit_dispatch_task.cancel()
        agent_dispatch_task.cancel()
        content_dispatch_task.cancel()
        content_reconcile_task.cancel()
        content_plan_dispatch_task.cancel()
        asset_processing_task.cancel()
        publication_dispatch_task.cancel()
        keyword_dispatch_task.cancel()
        keyword_reconcile_task.cancel()
        performance_sync_task.cancel()
        with suppress(asyncio.CancelledError):
            await dispatch_task
        with suppress(asyncio.CancelledError):
            await onboarding_reconcile_task
        with suppress(asyncio.CancelledError):
            await audit_dispatch_task
        with suppress(asyncio.CancelledError):
            await agent_dispatch_task
        with suppress(asyncio.CancelledError):
            await content_dispatch_task
        with suppress(asyncio.CancelledError):
            await content_reconcile_task
        with suppress(asyncio.CancelledError):
            await content_plan_dispatch_task
        with suppress(asyncio.CancelledError):
            await asset_processing_task
        with suppress(asyncio.CancelledError):
            await publication_dispatch_task
        with suppress(asyncio.CancelledError):
            await keyword_dispatch_task
        with suppress(asyncio.CancelledError):
            await keyword_reconcile_task
        with suppress(asyncio.CancelledError):
            await performance_sync_task
        await worker_launcher.stop()
        owned_gateway = getattr(application.state, "owned_backlinks_gateway", None)
        if owned_gateway is not None:
            await owned_gateway.aclose()


def create_platform_context_resolver(
    settings: Settings,
) -> PlatformContextResolver:
    projects = SQLAlchemyWebsiteProjectAuthority(session_factory)
    if (
        settings.app_env != "production"
        and settings.platform_local_development_auth_enabled
    ):
        return LocalDevelopmentPlatformContextResolver(projects=projects)
    if (
        settings.platform_auth_signing_key is None
        or settings.platform_context_signing_key is None
    ):
        return RejectingPlatformContextResolver()
    return AuthoritativePlatformContextResolver(
        authentication=HmacPlatformAuthenticationAuthority(
            issuer=settings.platform_auth_issuer,
            signing_key=settings.platform_auth_signing_key.get_secret_value(),
            max_token_ttl_seconds=settings.platform_auth_max_token_ttl_seconds,
        ),
        projects=projects,
    )


def create_app(
    *,
    backlinks_gateway: BacklinksGateway | None = None,
    platform_context_resolver: PlatformContextResolver | None = None,
) -> FastAPI:
    settings = get_settings()
    configure_sensitive_logging(settings)
    application = FastAPI(title=settings.app_name, lifespan=lifespan)
    owns_gateway = backlinks_gateway is None
    gateway = backlinks_gateway or BacklinksGateway(
        base_url=settings.backlinks_private_base_url,
        signing_key=(
            settings.platform_context_signing_key.get_secret_value()
            if settings.platform_context_signing_key is not None
            else None
        ),
        timeout_seconds=settings.backlinks_request_timeout_seconds,
    )
    application.state.backlinks_gateway = gateway
    application.state.platform_context_resolver = (
        platform_context_resolver or create_platform_context_resolver(settings)
    )
    application.state.owned_backlinks_gateway = gateway if owns_gateway else None
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(api_router)
    return application


app = create_app()
