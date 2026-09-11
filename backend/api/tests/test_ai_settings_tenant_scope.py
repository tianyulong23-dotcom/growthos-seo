import asyncio
from unittest.mock import AsyncMock

import pytest
from starlette.requests import Request

from app.api.routes import settings as routes
from app.core.config import Settings
from app.modules.settings.schemas import UpdateAIProviderSettingsRequest
from app.modules.settings.service import AISettingsService


@pytest.mark.parametrize("project_id", [None, "project-1"])
@pytest.mark.parametrize("method,permission", [
    ("GET", "projects:read"),
    ("PUT", "projects:write"),
    ("POST", "projects:write"),
])
def test_ai_settings_follow_authenticated_project_organization(
    monkeypatch, project_id, method, permission
) -> None:
    settings = Settings(default_organization_id="legacy-default")
    repository = AsyncMock()
    repository.get.return_value = None
    repository.upsert.side_effect = lambda org, record, *args: record
    service = AISettingsService(settings, repository, AsyncMock())
    monkeypatch.setattr(routes, "build_ai_settings_service", lambda: service)
    resolver = AsyncMock(return_value=("project-organization", "workspace"))
    monkeypatch.setattr(routes, "resolve_collection_organization", resolver)
    monkeypatch.setattr(routes, "resolve_project_organization", resolver)
    request = Request({
        "type": "http",
        "method": method,
        "path": "/api/v1/platform/settings/ai",
        "headers": [],
        "path_params": {"project_id": project_id} if project_id else {},
    })

    scoped = asyncio.run(routes.get_ai_settings_service(request))
    asyncio.run(scoped.get_platform())
    asyncio.run(scoped.update_platform(UpdateAIProviderSettingsRequest(
        base_url="https://provider.example/v1",
        model="test-model",
        api_key="test-key",
    )))

    assert scoped.settings.default_organization_id == "project-organization"
    assert settings.default_organization_id == "legacy-default"
    assert repository.get.call_args.args[0] == "project-organization"
    assert repository.upsert.call_args.args[0] == "project-organization"
    assert resolver.call_args.kwargs["required_permission"] == permission
    if project_id:
        assert resolver.call_args.args[1] == project_id


def test_ai_settings_authority_failure_does_not_build_service(monkeypatch) -> None:
    from fastapi import HTTPException
    from unittest.mock import Mock

    build = Mock()
    monkeypatch.setattr(routes, "build_ai_settings_service", build)
    monkeypatch.setattr(
        routes,
        "resolve_collection_organization",
        AsyncMock(side_effect=HTTPException(status_code=403)),
    )
    request = Request({
        "type": "http", "method": "PUT", "path": "/", "headers": [],
    })
    with pytest.raises(HTTPException):
        asyncio.run(routes.get_ai_settings_service(request))
    build.assert_not_called()
