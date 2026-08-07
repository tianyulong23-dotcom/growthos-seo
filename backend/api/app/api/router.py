from fastapi import APIRouter

from app.api.routes.agents import router as agents_router
from app.api.routes.audits import router as audits_router
from app.api.routes.backlinks import router as backlinks_router
from app.api.routes.content import router as content_router
from app.api.routes.data_sources import router as data_sources_router
from app.api.routes.health import router as health_router
from app.api.routes.keywords import router as keywords_router
from app.api.routes.projects import router as projects_router
from app.api.routes.settings import router as settings_router
from app.api.routes.service_connections import router as service_connections_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(projects_router)
api_router.include_router(audits_router)
api_router.include_router(settings_router)
api_router.include_router(service_connections_router)
api_router.include_router(agents_router)
api_router.include_router(data_sources_router)
api_router.include_router(keywords_router)
api_router.include_router(backlinks_router)
api_router.include_router(content_router)
