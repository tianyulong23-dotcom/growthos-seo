import json
from pathlib import Path

from app.core.authoritative_platform_context import LocalProductPlatformContextResolver
from app.core.backlinks_gateway import RejectingPlatformContextResolver
from app.core.config import Settings
from app.main import create_platform_context_resolver


def test_platform_access_token_schema_locks_membership_dimensions() -> None:
    schema_path = (
        Path(__file__).parents[2]
        / "contracts"
        / "json-schema"
        / "platform-access-token.v1.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))

    assert schema["properties"]["version"]["const"] == "PlatformAccessToken.v1"
    assert schema["additionalProperties"] is False
    membership = schema["properties"]["memberships"]["items"]
    assert set(membership["required"]) == {
        "organizationId",
        "workspaceId",
        "roles",
        "projectIds",
        "permissions",
    }


def test_default_configuration_keeps_platform_context_fail_closed() -> None:
    settings = Settings(
        _env_file=None,
        platform_auth_signing_key=None,
        platform_context_signing_key=None,
    )

    resolver = create_platform_context_resolver(settings)

    assert isinstance(resolver, RejectingPlatformContextResolver)


def test_local_product_configuration_uses_dynamic_platform_context() -> None:
    settings = Settings(
        _env_file=None,
        backlinks_runtime_mode="LOCAL_PRODUCT",
        local_product_organization_id="org-real",
        local_product_workspace_id="workspace-real",
        local_product_website_project_id="project-real-id",
        local_product_website_project_key="project-real",
        local_product_user_id="user-real",
        local_product_session_id="session-real",
    )

    resolver = create_platform_context_resolver(settings)

    assert isinstance(resolver, LocalProductPlatformContextResolver)
