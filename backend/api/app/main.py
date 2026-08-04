import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.core.secure_logging import configure_sensitive_logging
from app.modules.audit.service import AuditService, build_audit_service
from app.modules.agent.service import build_agent_service
from app.modules.keywords.service import KeywordService, build_keyword_service
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


@asynccontextmanager
async def lifespan(_: FastAPI):
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
        yield
    finally:
        dispatch_task.cancel()
        audit_dispatch_task.cancel()
        agent_dispatch_task.cancel()
        keyword_dispatch_task.cancel()
        keyword_reconcile_task.cancel()
        with suppress(asyncio.CancelledError):
            await dispatch_task
        with suppress(asyncio.CancelledError):
            await audit_dispatch_task
        with suppress(asyncio.CancelledError):
            await agent_dispatch_task
        with suppress(asyncio.CancelledError):
            await keyword_dispatch_task
        with suppress(asyncio.CancelledError):
            await keyword_reconcile_task
        await worker_launcher.stop()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_sensitive_logging(settings)
    application = FastAPI(title=settings.app_name, lifespan=lifespan)
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
