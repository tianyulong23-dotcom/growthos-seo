import asyncio
from datetime import UTC, datetime
from typing import Any

from httpx import ASGITransport, AsyncClient

from app.api.routes.service_connections import get_service_connection_service
from app.core.config import Settings
from app.main import app
from app.modules.settings.schemas import (
    TestGSCConnectionRequest as GSCConnectionTestRequest,
    TestWordPressConnectionRequest as WordPressConnectionTestRequest,
    UpdateGSCConnectionRequest,
    UpdateWordPressConnectionRequest,
)
from app.modules.settings.service_connections import (
    GSCConnectionRecord,
    ProjectServiceConnectionService,
    WordPressConnectionRecord,
)


class FakeRepository:
    def __init__(self) -> None:
        self.projects = {"project-1"}
        self.gsc: GSCConnectionRecord | None = None
        self.wordpress: WordPressConnectionRecord | None = None
        self.encryption_keys: list[str] = []

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def get_gsc(
        self, project_id: str, encryption_key: str | None
    ) -> GSCConnectionRecord | None:
        return self.gsc

    async def upsert_gsc(
        self, project_id: str, record: GSCConnectionRecord, encryption_key: str
    ) -> GSCConnectionRecord:
        self.encryption_keys.append(encryption_key)
        self.gsc = record
        return record

    async def delete_gsc(self, project_id: str) -> None:
        self.gsc = None

    async def get_wordpress(
        self, project_id: str, encryption_key: str | None
    ) -> WordPressConnectionRecord | None:
        return self.wordpress

    async def upsert_wordpress(
        self, project_id: str, record: WordPressConnectionRecord, encryption_key: str
    ) -> WordPressConnectionRecord:
        self.encryption_keys.append(encryption_key)
        self.wordpress = record
        return record

    async def delete_wordpress(self, project_id: str) -> None:
        self.wordpress = None


class FakeGSCTester:
    def __init__(self) -> None:
        self.calls: list[GSCConnectionRecord] = []

    async def test(self, record: GSCConnectionRecord) -> None:
        self.calls.append(record)


class FakeWordPressTester:
    def __init__(self) -> None:
        self.calls: list[WordPressConnectionRecord] = []

    async def test(self, record: WordPressConnectionRecord) -> str:
        self.calls.append(record)
        return "Site Editor"


def build_service() -> tuple[
    ProjectServiceConnectionService,
    FakeRepository,
    FakeGSCTester,
    FakeWordPressTester,
]:
    repository = FakeRepository()
    gsc_tester = FakeGSCTester()
    wordpress_tester = FakeWordPressTester()
    service = ProjectServiceConnectionService(
        settings=Settings(
            app_env="test",
            default_organization_id="test-org",
            ai_settings_encryption_key="encryption-key",
        ),
        repository=repository,
        gsc_tester=gsc_tester,
        wordpress_tester=wordpress_tester,
    )
    return service, repository, gsc_tester, wordpress_tester


def test_empty_connections_are_disconnected() -> None:
    service, _, _, _ = build_service()

    gsc = asyncio.run(service.get_gsc("project-1"))
    wordpress = asyncio.run(service.get_wordpress("project-1"))

    assert gsc.status == "disconnected"
    assert gsc.private_key_configured is False
    assert wordpress.status == "disconnected"
    assert wordpress.application_password_configured is False


def test_save_tests_first_and_never_exposes_secrets() -> None:
    service, repository, gsc_tester, wordpress_tester = build_service()

    gsc = asyncio.run(
        service.update_gsc(
            "project-1",
            UpdateGSCConnectionRequest(
                property_url="sc-domain:example.com",
                service_account_email="seo@example.iam.gserviceaccount.com",
                private_key="gsc-private-key",
            ),
        )
    )
    wordpress = asyncio.run(
        service.update_wordpress(
            "project-1",
            UpdateWordPressConnectionRequest(
                site_url="https://example.com/",
                username="editor",
                application_password="wordpress-secret",
            ),
        )
    )

    assert len(gsc_tester.calls) == 1
    assert len(wordpress_tester.calls) == 1
    assert repository.encryption_keys == ["encryption-key", "encryption-key"]
    assert gsc.status == "connected"
    assert gsc.verified_at is not None
    assert wordpress.status == "connected"
    assert wordpress.verified_user == "Site Editor"
    payload = {**gsc.model_dump(mode="json"), **wordpress.model_dump(mode="json")}
    assert "private_key" not in payload
    assert "application_password" not in payload
    assert "gsc-private-key" not in repr(gsc_tester.calls[0])
    assert "wordpress-secret" not in repr(wordpress_tester.calls[0])


def test_blank_secrets_reuse_saved_values_for_test() -> None:
    service, repository, gsc_tester, wordpress_tester = build_service()
    repository.gsc = GSCConnectionRecord(
        property_url="sc-domain:old.example",
        service_account_email="old@example.iam.gserviceaccount.com",
        private_key="saved-gsc-key",
        verified_at=datetime(2026, 8, 5, tzinfo=UTC),
    )
    repository.wordpress = WordPressConnectionRecord(
        site_url="https://old.example",
        username="old-user",
        application_password="saved-wp-password",
        verified_user="Old User",
        verified_at=datetime(2026, 8, 5, tzinfo=UTC),
    )

    asyncio.run(
        service.test_gsc(
            "project-1",
            GSCConnectionTestRequest(
                property_url="https://new.example/",
                service_account_email="new@example.iam.gserviceaccount.com",
            ),
        )
    )
    asyncio.run(
        service.test_wordpress(
            "project-1",
            WordPressConnectionTestRequest(
                site_url="https://new.example/",
                username="new-user",
            ),
        )
    )

    assert gsc_tester.calls[0].private_key == "saved-gsc-key"
    assert gsc_tester.calls[0].property_url == "https://new.example"
    assert wordpress_tester.calls[0].application_password == "saved-wp-password"
    assert wordpress_tester.calls[0].site_url == "https://new.example"


def test_routes_save_load_and_disconnect() -> None:
    service, _, _, _ = build_service()
    app.dependency_overrides[get_service_connection_service] = lambda: service

    async def request() -> tuple[dict[str, Any], dict[str, Any], int, int]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            gsc = await client.put(
                "/api/v1/projects/project-1/service-connections/gsc",
                json={
                    "property_url": "sc-domain:example.com",
                    "service_account_email": "seo@example.iam.gserviceaccount.com",
                    "private_key": "gsc-private-key",
                },
            )
            wordpress = await client.put(
                "/api/v1/projects/project-1/service-connections/wordpress",
                json={
                    "site_url": "https://example.com",
                    "username": "editor",
                    "application_password": "wordpress-secret",
                },
            )
            gsc_disconnect = await client.delete(
                "/api/v1/projects/project-1/service-connections/gsc"
            )
            wp_disconnect = await client.delete(
                "/api/v1/projects/project-1/service-connections/wordpress"
            )
            return (
                gsc.json(),
                wordpress.json(),
                gsc_disconnect.status_code,
                wp_disconnect.status_code,
            )

    try:
        gsc, wordpress, gsc_status, wp_status = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert gsc["status"] == "connected"
    assert "private_key" not in gsc
    assert wordpress["status"] == "connected"
    assert "application_password" not in wordpress
    assert gsc_status == 204
    assert wp_status == 204


def test_unknown_project_returns_404() -> None:
    service, _, _, _ = build_service()
    app.dependency_overrides[get_service_connection_service] = lambda: service

    async def request() -> int:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                "/api/v1/projects/missing/service-connections/gsc"
            )
            return response.status_code

    try:
        status_code = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 404
