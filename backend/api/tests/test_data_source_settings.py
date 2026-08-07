import asyncio
from datetime import UTC, datetime
from typing import Any

from httpx import ASGITransport, AsyncClient

from app.api.routes.data_sources import (
    get_dataforseo_settings_service,
    get_google_ads_settings_service,
)
from app.core.config import Settings
from app.main import app
from app.modules.settings.data_sources import (
    DataForSEOSettingsRecord,
    DataForSEOSettingsService,
    GoogleAdsSettingsRecord,
    GoogleAdsSettingsService,
    dataforseo_balance,
)
from app.modules.settings.schemas import (
    TestDataForSEOSettingsRequest as DataForSEOSettingsTestRequest,
    TestGoogleAdsSettingsRequest as GoogleAdsSettingsTestRequest,
    UpdateDataForSEOSettingsRequest,
    UpdateGoogleAdsSettingsRequest,
)


class FakeDataSourceSettingsRepository:
    def __init__(self) -> None:
        self.projects = {"project-1"}
        self.google_ads_record: GoogleAdsSettingsRecord | None = None
        self.dataforseo_record: DataForSEOSettingsRecord | None = None
        self.encryption_keys: list[str] = []

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def get_google_ads(
        self,
        organization_id: str,
        encryption_key: str,
    ) -> GoogleAdsSettingsRecord | None:
        assert organization_id == "test-org"
        self.encryption_keys.append(encryption_key)
        return self.google_ads_record

    async def upsert_google_ads(
        self,
        organization_id: str,
        record: GoogleAdsSettingsRecord,
        encryption_key: str,
    ) -> GoogleAdsSettingsRecord:
        assert organization_id == "test-org"
        self.encryption_keys.append(encryption_key)
        self.google_ads_record = GoogleAdsSettingsRecord(
            developer_token=record.developer_token,
            client_id=record.client_id,
            client_secret=record.client_secret,
            refresh_token=record.refresh_token,
            customer_id=record.customer_id,
            login_customer_id=record.login_customer_id,
            updated_at=datetime(2026, 7, 27, 12, 0, tzinfo=UTC),
        )
        return self.google_ads_record

    async def get_dataforseo(
        self,
        organization_id: str,
        encryption_key: str,
    ) -> DataForSEOSettingsRecord | None:
        assert organization_id == "test-org"
        self.encryption_keys.append(encryption_key)
        return self.dataforseo_record

    async def upsert_dataforseo(
        self,
        organization_id: str,
        record: DataForSEOSettingsRecord,
        encryption_key: str,
    ) -> DataForSEOSettingsRecord:
        assert organization_id == "test-org"
        self.encryption_keys.append(encryption_key)
        self.dataforseo_record = DataForSEOSettingsRecord(
            login=record.login,
            password=record.password,
            updated_at=datetime(2026, 7, 27, 12, 0, tzinfo=UTC),
        )
        return self.dataforseo_record


class FakeGoogleAdsConnectionTester:
    def __init__(self) -> None:
        self.calls: list[tuple[GoogleAdsSettingsRecord, str]] = []

    async def test(self, record: GoogleAdsSettingsRecord, api_version: str) -> None:
        self.calls.append((record, api_version))


class FakeDataForSEOConnectionTester:
    def __init__(self) -> None:
        self.calls: list[DataForSEOSettingsRecord] = []

    async def test(self, record: DataForSEOSettingsRecord) -> float | None:
        self.calls.append(record)
        return 42.5


def build_services() -> tuple[
    GoogleAdsSettingsService,
    DataForSEOSettingsService,
    FakeDataSourceSettingsRepository,
    FakeGoogleAdsConnectionTester,
    FakeDataForSEOConnectionTester,
]:
    repository = FakeDataSourceSettingsRepository()
    google_tester = FakeGoogleAdsConnectionTester()
    dataforseo_tester = FakeDataForSEOConnectionTester()
    settings = Settings(
        app_env="test",
        default_organization_id="test-org",
        ai_settings_encryption_key="encryption-key",
        google_ads_developer_token="environment-developer-token",
        google_ads_client_id="environment-client-id",
        google_ads_client_secret="environment-client-secret",
        google_ads_refresh_token="environment-refresh-token",
        google_ads_customer_id="1234567890",
        google_ads_login_customer_id="0987654321",
        google_ads_api_version="v23",
        dataforseo_login="environment-login",
        dataforseo_password="environment-password",
    )
    google_service = GoogleAdsSettingsService(
        settings=settings,
        repository=repository,
        connection_tester=google_tester,
    )
    dataforseo_service = DataForSEOSettingsService(
        settings=settings,
        repository=repository,
        connection_tester=dataforseo_tester,
    )
    return (
        google_service,
        dataforseo_service,
        repository,
        google_tester,
        dataforseo_tester,
    )


def test_get_uses_environment_without_exposing_secrets() -> None:
    google_service, dataforseo_service, _, _, _ = build_services()

    google = asyncio.run(google_service.get("project-1"))
    dataforseo = asyncio.run(dataforseo_service.get("project-1"))
    google_payload = google.model_dump(mode="json")
    dataforseo_payload = dataforseo.model_dump(mode="json")

    assert google.source == "environment"
    assert google.configured is True
    assert google.client_id == "environment-client-id"
    assert google.customer_id == "1234567890"
    assert google.developer_token_configured is True
    assert "developer_token" not in google_payload
    assert "client_secret" not in google_payload
    assert "refresh_token" not in google_payload

    assert dataforseo.source == "environment"
    assert dataforseo.configured is True
    assert dataforseo.login == "environment-login"
    assert "password" not in dataforseo_payload


def test_effective_dataforseo_record_prefers_database_and_falls_back_to_environment() -> None:
    _, dataforseo_service, repository, _, _ = build_services()

    environment = asyncio.run(dataforseo_service.effective_record())
    repository.dataforseo_record = DataForSEOSettingsRecord(
        login="stored-login",
        password="stored-password",
    )
    stored = asyncio.run(dataforseo_service.effective_record())

    assert environment.login == "environment-login"
    assert environment.password == "environment-password"
    assert stored.login == "stored-login"
    assert stored.password == "stored-password"


def test_updates_reuse_existing_secrets_when_the_fields_are_blank() -> None:
    google_service, dataforseo_service, repository, _, _ = build_services()

    google = asyncio.run(
        google_service.update(
            "project-1",
            UpdateGoogleAdsSettingsRequest(
                client_id="new-client-id",
                customer_id="222-333-4444",
                login_customer_id="",
            ),
        )
    )
    dataforseo = asyncio.run(
        dataforseo_service.update(
            "project-1",
            UpdateDataForSEOSettingsRequest(login="new-login"),
        )
    )

    assert repository.google_ads_record is not None
    assert repository.google_ads_record.developer_token == "environment-developer-token"
    assert repository.google_ads_record.client_secret == "environment-client-secret"
    assert repository.google_ads_record.refresh_token == "environment-refresh-token"
    assert repository.google_ads_record.customer_id == "2223334444"
    assert repository.google_ads_record.login_customer_id is None
    assert google.source == "database"

    assert repository.dataforseo_record is not None
    assert repository.dataforseo_record.password == "environment-password"
    assert dataforseo.source == "database"


def test_connection_tests_use_unsaved_form_values() -> None:
    (
        google_service,
        dataforseo_service,
        _,
        google_tester,
        dataforseo_tester,
    ) = build_services()

    google = asyncio.run(
        google_service.test_connection(
            "project-1",
            GoogleAdsSettingsTestRequest(
                developer_token="new-developer-token",
                client_id="new-client-id",
                client_secret="new-client-secret",
                refresh_token="new-refresh-token",
                customer_id="5556667777",
            ),
        )
    )
    dataforseo = asyncio.run(
        dataforseo_service.test_connection(
            "project-1",
            DataForSEOSettingsTestRequest(
                login="new-login",
                password="new-password",
            ),
        )
    )

    assert google.success is True
    assert google_tester.calls[0][0].developer_token == "new-developer-token"
    assert google_tester.calls[0][0].customer_id == "5556667777"
    assert google_tester.calls[0][1] == "v23"
    assert dataforseo.balance == 42.5
    assert dataforseo_tester.calls[0].password == "new-password"


def test_routes_save_and_load_without_exposing_provider_secrets() -> None:
    google_service, dataforseo_service, _, _, _ = build_services()
    app.dependency_overrides[get_google_ads_settings_service] = lambda: google_service
    app.dependency_overrides[get_dataforseo_settings_service] = lambda: dataforseo_service

    async def request() -> tuple[dict[str, Any], dict[str, Any]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            google = await client.put(
                "/api/v1/projects/project-1/google-ads-settings",
                json={
                    "developer_token": "saved-developer-token",
                    "client_id": "saved-client-id",
                    "client_secret": "saved-client-secret",
                    "refresh_token": "saved-refresh-token",
                    "customer_id": "123-456-7890",
                    "login_customer_id": None,
                },
            )
            dataforseo = await client.put(
                "/api/v1/projects/project-1/dataforseo-settings",
                json={
                    "login": "saved-login",
                    "password": "saved-password",
                },
            )
            assert google.status_code == 200
            assert dataforseo.status_code == 200
            return google.json(), dataforseo.json()

    try:
        google, dataforseo = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert google["customer_id"] == "1234567890"
    assert google["developer_token_configured"] is True
    assert "developer_token" not in google
    assert "client_secret" not in google
    assert "refresh_token" not in google
    assert dataforseo["login"] == "saved-login"
    assert dataforseo["password_configured"] is True
    assert "password" not in dataforseo


def test_platform_dataforseo_route_does_not_require_a_project_id() -> None:
    _, service, _, _, _ = build_services()
    app.dependency_overrides[get_dataforseo_settings_service] = lambda: service

    async def request() -> tuple[int, dict[str, Any]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.put(
                "/api/v1/platform/settings/dataforseo",
                json={"login": "platform-login", "password": "platform-password"},
            )
            return response.status_code, response.json()

    try:
        status_code, payload = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 200
    assert payload["login"] == "platform-login"
    assert "password" not in payload


def test_dataforseo_balance_reads_the_user_data_response() -> None:
    payload = {
        "tasks": [
            {
                "result": [
                    {
                        "money": {
                            "balance": 18.75,
                        }
                    }
                ]
            }
        ]
    }

    assert dataforseo_balance(payload) == 18.75


def test_secret_values_are_omitted_from_record_representations() -> None:
    google = GoogleAdsSettingsRecord(
        developer_token="developer-secret",
        client_id="client-id",
        client_secret="client-secret",
        refresh_token="refresh-secret",
        customer_id="1234567890",
    )
    dataforseo = DataForSEOSettingsRecord(
        login="login",
        password="password-secret",
    )

    representation = repr((google, dataforseo))

    assert "developer-secret" not in representation
    assert "client-secret" not in representation
    assert "refresh-secret" not in representation
    assert "password-secret" not in representation
