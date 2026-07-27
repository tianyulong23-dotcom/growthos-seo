import asyncio
import logging
from contextlib import suppress
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.modules.audit.service import build_audit_service
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    worker_launcher = get_crawler_worker_launcher()
    dispatch_task = asyncio.create_task(
        dispatch_site_understanding_workflows(
            build_project_service(),
            settings.site_understanding_dispatch_interval_seconds,
        )
    )
    try:
        service = build_audit_service()
        await asyncio.wait_for(
            service.reconcile_active_runs(),
            timeout=settings.audit_reconcile_timeout_seconds,
        )
    except Exception:
        logger.exception("Unable to reconcile active audit runs during startup")
    try:
        yield
    finally:
        dispatch_task.cancel()
        with suppress(asyncio.CancelledError):
            await dispatch_task
        await worker_launcher.stop()


def create_app() -> FastAPI:
    settings = get_settings()
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
