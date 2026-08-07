import os

from fastapi.routing import APIRoute

from app.core.backlinks_gateway import BacklinksGateway, PlatformContextResolver
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.main import create_app


class RuntimePlatformContextResolver(PlatformContextResolver):
    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request, required_permission
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="user-runtime",
                session_id="session-runtime",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="org-gateway",
                workspace_id="workspace-gateway",
            ),
            project=PlatformProject(
                website_project_id="project-gateway",
                website_project_key=website_project_key,
            ),
            permissions=("backlinks:read", "backlinks:write"),
            correlation_id="correlation-runtime",
        )


gateway = BacklinksGateway(
    base_url=os.environ.get(
        "BACKLINKS_PRIVATE_BASE_URL",
        "http://backlinks-runtime:7301",
    ),
    signing_key=os.environ.get(
        "PLATFORM_CONTEXT_SIGNING_KEY",
        "test-only-platform-context-key-32-bytes",
    ),
)
app = create_app(
    backlinks_gateway=gateway,
    platform_context_resolver=RuntimePlatformContextResolver(),
)
app.router.add_event_handler("shutdown", gateway.aclose)


@app.get("/api/v1/audit/probe", include_in_schema=False)
async def audit_probe() -> dict[str, str]:
    return {"module": "audit", "status": "ok"}


def runtime_api_routes(router: object) -> list[APIRoute]:
    routes: list[APIRoute] = []
    for route in getattr(router, "routes", []):
        if isinstance(route, APIRoute):
            routes.append(route)
            continue
        included = getattr(route, "original_router", None)
        if included is not None:
            routes.extend(runtime_api_routes(included))
    return routes


if __name__ == "__main__":
    count = sum(1 for route in runtime_api_routes(app) if "/backlinks/" in route.path)
    print(count)
