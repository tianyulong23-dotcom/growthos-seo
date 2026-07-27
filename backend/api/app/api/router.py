from fastapi import APIRouter

from app.api.routes.audits import router as audits_router
from app.api.routes.health import router as health_router
from app.api.routes.projects import router as projects_router
from app.api.routes.settings import router as settings_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(projects_router)
api_router.include_router(audits_router)
api_router.include_router(settings_router)
