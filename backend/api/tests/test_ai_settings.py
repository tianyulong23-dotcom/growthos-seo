import asyncio
from datetime import UTC, datetime
from typing import Any

from httpx import ASGITransport, AsyncClient

from app.api.routes.settings import get_ai_settings_service
from app.core.config import Settings
from app.main import app
from app.modules.settings.schemas import (
    TestAIProviderSettingsRequest as AIProviderSettingsTestRequest,
    UpdateAIProviderSettingsRequest,
)
from app.modules.settings.service import (
    AIProviderSettingsRecord,
    AISettingsService,
)


class FakeAISettingsRepository:
    def __init__(self) -> None:
        self.projects = {"project-1"}
        self.record: AIProviderSettingsRecord | None = None
        self.encryption_keys: list[str] = []

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def get(
        self,
        organization_id: str,
        encryption_key: str,
    ) -> AIProviderSettingsRecord | None:
        assert organization_id == "test-org"
        self.encryption_keys.append(encryption_key)
        return self.record

    async def upsert(
        self,
        organization_id: str,
        record: AIProviderSettingsRecord,
        encryption_key: str,
    ) -> AIProviderSettingsRecord:
        assert organization_id == "test-org"
        self.encryption_keys.append(encryption_key)
        self.record = AIProviderSettingsRecord(
            base_url=record.base_url,
            api_key=record.api_key,
            model=record.model,
            request_timeout_seconds=record.request_timeout_seconds,
            max_retries=record.max_retries,
            updated_at=datetime(2026, 7, 23, 10, 0, tzinfo=UTC),
        )
        return self.record


class FakeConnectionTester:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, int]] = []

    async def test(
        self,
        base_url: str,
        api_key: str,
        model: str,
        request_timeout_seconds: int,
    ) -> None:
        self.calls.append((base_url, api_key, model, request_timeout_seconds))


def build_service() -> tuple[
    AISettingsService,
    FakeAISettingsRepository,
    FakeConnectionTester,
]:
    repository = FakeAISettingsRepository()
    tester = FakeConnectionTester()
    service = AISettingsService(
        settings=Settings(
            app_env="test",
            default_organization_id="test-org",
            business_profile_ai_base_url="https://environment.example/v1",
            business_profile_ai_api_key="environment-key",
            business_profile_ai_model="environment-model",
            business_profile_ai_timeout="45s",
            business_profile_ai_max_retries=2,
            ai_settings_encryption_key="encryption-key",
        ),
        repository=repository,
        connection_tester=tester,
    )
    return service, repository, tester


def test_get_uses_environment_fallback_without_returning_api_key() -> None:
    service, _, _ = build_service()

    response = asyncio.run(service.get("project-1"))
    payload = response.model_dump(mode="json")

    assert response.source == "environment"
    assert response.configured is True
    assert response.api_key_configured is True
    assert response.request_timeout_seconds == 45
    assert response.max_retries == 2
    assert "api_key" not in payload


def test_update_reuses_current_key_when_request_leaves_it_blank() -> None:
    service, repository, _ = build_service()

    response = asyncio.run(
        service.update(
            "project-1",
            UpdateAIProviderSettingsRequest(
                base_url="https://models.example/v1/",
                model="new-model",
                request_timeout_seconds=120,
                max_retries=1,
            ),
        )
    )

    assert repository.record is not None
    assert repository.record.api_key == "environment-key"
    assert repository.record.base_url == "https://models.example/v1"
    assert repository.record.request_timeout_seconds == 120
    assert repository.record.max_retries == 1
    assert response.source == "database"
    assert response.updated_at is not None


def test_connection_uses_unsaved_api_key_and_form_values() -> None:
    service, _, tester = build_service()

    response = asyncio.run(
        service.test_connection(
            "project-1",
            AIProviderSettingsTestRequest(
                base_url="https://models.example/v1",
                model="test-model",
                api_key="new-key",
                request_timeout_seconds=75,
            ),
        )
    )

    assert response.success is True
    assert tester.calls == [("https://models.example/v1", "new-key", "test-model", 75)]


def test_routes_save_and_load_settings_without_exposing_key() -> None:
    service, _, _ = build_service()
    app.dependency_overrides[get_ai_settings_service] = lambda: service

    async def request() -> tuple[int, dict[str, Any], dict[str, Any]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            saved = await client.put(
                "/api/v1/projects/project-1/ai-settings",
                json={
                    "base_url": "https://models.example/v1",
                    "api_key": "saved-key",
                    "model": "saved-model",
                    "request_timeout_seconds": 90,
                    "max_retries": 1,
                },
            )
            loaded = await client.get("/api/v1/projects/project-1/ai-settings")
            return saved.status_code, saved.json(), loaded.json()

    try:
        status_code, saved, loaded = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 200
    assert saved["source"] == "database"
    assert loaded["base_url"] == "https://models.example/v1"
    assert loaded["request_timeout_seconds"] == 90
    assert loaded["max_retries"] == 1
    assert "api_key" not in saved
    assert "api_key" not in loaded


def test_routes_reject_request_policy_outside_supported_range() -> None:
    service, _, _ = build_service()
    app.dependency_overrides[get_ai_settings_service] = lambda: service

    async def request() -> int:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                "/api/v1/projects/project-1/ai-settings",
                json={
                    "base_url": "https://models.example/v1",
                    "model": "saved-model",
                    "request_timeout_seconds": 181,
                    "max_retries": 3,
                },
            )
            return response.status_code

    try:
        status_code = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 422
