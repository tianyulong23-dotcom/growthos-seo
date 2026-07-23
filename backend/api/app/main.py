import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.modules.audit.service import build_audit_service
from app.workflows.worker import get_crawler_worker_launcher

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    worker_launcher = get_crawler_worker_launcher()
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
