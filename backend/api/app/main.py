from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.authoritative_platform_context import (
    AuthoritativePlatformContextResolver,
    LocalProductPlatformContextResolver,
)
from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolver,
    RejectingPlatformContextResolver,
)
from app.core.config import Settings, get_settings
from app.core.platform_auth import HmacPlatformAuthenticationAuthority
from app.core.runtime import RuntimeDependencies
from app.db.session import session_factory
from app.modules.projects.authority import (
    SQLAlchemyWebsiteProjectAuthority,
    WebsiteProjectAuthority,
    WebsiteProjectReader,
)
from app.modules.projects.service import WebsiteProjectService


def create_platform_context_resolver(
    settings: Settings,
    projects: WebsiteProjectAuthority | None = None,
) -> PlatformContextResolver:
    projects = projects or SQLAlchemyWebsiteProjectAuthority(session_factory)
    if settings.backlinks_runtime_mode in {
        "LOCAL_PRODUCT_ACCEPTANCE",
        "LOCAL_PRODUCT",
    }:
        return LocalProductPlatformContextResolver(
            projects=projects,
            organization_id=settings.local_product_organization_id or "",
            workspace_id=settings.local_product_workspace_id or "",
            website_project_id=settings.local_product_website_project_id or "",
            website_project_key=settings.local_product_website_project_key or "",
            user_id=settings.local_product_user_id or "",
            session_id=settings.local_product_session_id or "",
            frontend_origin=settings.local_product_frontend_origin,
        )
    if settings.platform_auth_signing_key is None or settings.platform_context_signing_key is None:
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
    website_project_reader: WebsiteProjectReader | None = None,
    website_project_service: WebsiteProjectService | None = None,
) -> FastAPI:
    settings = get_settings()
    project_authority = SQLAlchemyWebsiteProjectAuthority(session_factory)
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
    runtime = RuntimeDependencies(settings=settings)

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        try:
            await runtime.start()
            yield
        finally:
            if owns_gateway:
                await gateway.aclose()
            await runtime.close()

    application = FastAPI(title=settings.app_name, lifespan=lifespan)
    application.state.settings = settings
    application.state.backlinks_gateway = gateway
    application.state.runtime_dependencies = runtime
    application.state.website_project_reader = (
        website_project_reader or project_authority
    )
    application.state.website_project_service = (
        website_project_service or WebsiteProjectService(session_factory)
    )
    application.state.platform_context_resolver = (
        platform_context_resolver
        or create_platform_context_resolver(settings, project_authority)
    )
    application.state.oauth_callback_frontend_origin = (
        settings.local_product_frontend_origin
        if settings.backlinks_runtime_mode in {
            "LOCAL_PRODUCT_ACCEPTANCE",
            "LOCAL_PRODUCT",
        }
        else None
    )
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
