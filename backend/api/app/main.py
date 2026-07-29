from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.authoritative_platform_context import (
    AuthoritativePlatformContextResolver,
)
from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolver,
    RejectingPlatformContextResolver,
)
from app.core.config import Settings, get_settings
from app.core.platform_auth import HmacPlatformAuthenticationAuthority
from app.db.session import session_factory
from app.modules.projects.authority import SQLAlchemyWebsiteProjectAuthority


def create_platform_context_resolver(
    settings: Settings,
) -> PlatformContextResolver:
    if settings.platform_auth_signing_key is None or settings.platform_context_signing_key is None:
        return RejectingPlatformContextResolver()
    return AuthoritativePlatformContextResolver(
        authentication=HmacPlatformAuthenticationAuthority(
            issuer=settings.platform_auth_issuer,
            signing_key=settings.platform_auth_signing_key.get_secret_value(),
            max_token_ttl_seconds=settings.platform_auth_max_token_ttl_seconds,
        ),
        projects=SQLAlchemyWebsiteProjectAuthority(session_factory),
    )


def create_app(
    *,
    backlinks_gateway: BacklinksGateway | None = None,
    platform_context_resolver: PlatformContextResolver | None = None,
) -> FastAPI:
    settings = get_settings()
    application = FastAPI(title=settings.app_name)
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
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(api_router)
    if owns_gateway:
        application.router.add_event_handler("shutdown", gateway.aclose)
    return application


app = create_app()
