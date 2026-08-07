import asyncio
from datetime import UTC, datetime
import json
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from urllib.request import Request

from httpx import ASGITransport, AsyncClient
import pytest

from app.api.routes.data_sources import (
    get_dataforseo_settings_service,
    get_gsc_service,
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
from app.modules.settings.gsc import (
    GSCGrant,
    GSCReconnectRequiredError,
    GSCService,
    GSCUpstreamError,
    GSCValidationError,
    _google_json,
    gsc_site_matches_domain,
)
from app.modules.settings.schemas import (
    GSCPerformanceTableResponse,
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

    async def project_domain(self, organization_id: str, project_id: str) -> str | None:
        return "example.com" if await self.project_exists(organization_id, project_id) else None

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


class FakeGSCRepository:
    def __init__(self) -> None:
        self.projects = {"project-1"}
        self.grant: GSCGrant | None = None
        self.marked_reconnect: list[str] = []

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def project_domain(self, organization_id: str, project_id: str) -> str | None:
        return "example.com" if await self.project_exists(organization_id, project_id) else None

    async def get(self, project_id: str, encryption_key: str) -> GSCGrant | None:
        assert encryption_key == "encryption-key"
        return self.grant if self.grant and self.grant.project_id == project_id else None

    async def upsert_grant(self, **kwargs) -> None:
        previous = self.grant
        refresh_token = kwargs["refresh_token"] or (
            previous.refresh_token if previous is not None else ""
        )
        site_url = (
            previous.site_url
            if previous is not None and previous.google_account_id == kwargs["google_account_id"]
            else None
        )
        self.grant = GSCGrant(
            project_id=kwargs["project_id"],
            organization_id=kwargs["organization_id"],
            site_url=site_url,
            google_account_id=kwargs["google_account_id"],
            connected_account_email=kwargs["connected_account_email"],
            refresh_token=refresh_token,
            scopes=kwargs["scopes"],
            requires_reconnect=False,
        )

    async def select_site(self, project_id: str, site_url: str) -> None:
        assert self.grant is not None
        self.grant = GSCGrant(**{**self.grant.__dict__, "site_url": site_url})

    async def mark_reconnect(self, project_id: str) -> None:
        self.marked_reconnect.append(project_id)
        assert self.grant is not None
        self.grant = GSCGrant(**{**self.grant.__dict__, "requires_reconnect": True})

    async def disconnect(self, project_id: str) -> None:
        self.grant = None


def build_gsc_service() -> tuple[GSCService, FakeGSCRepository]:
    repository = FakeGSCRepository()
    settings = Settings(
        app_env="test",
        default_organization_id="test-org",
        ai_settings_encryption_key="encryption-key",
        google_gsc_client_id="gsc-client-id",
        google_gsc_client_secret="gsc-client-secret",
        gsc_public_api_origin="https://api.example",
        gsc_frontend_origin="https://app.example",
    )
    return GSCService(settings, repository), repository


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


def test_gsc_oauth_state_is_scoped_signed_and_rejects_foreign_callbacks() -> None:
    service, _ = build_gsc_service()

    authorization_url = asyncio.run(
        service.authorization_url(
            "project-1",
            "https://app.example/projects/project-1/settings/data-sources?tab=gsc",
        )
    )
    parsed = urlparse(authorization_url)
    query = parse_qs(parsed.query)
    state = query["state"][0]
    payload = service._verify_state(state)

    assert parsed.netloc == "accounts.google.com"
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["select_account consent"]
    assert payload["project_id"] == "project-1"
    assert payload["organization_id"] == "test-org"
    assert payload["callback_path"].endswith("?tab=gsc")
    with pytest.raises(GSCValidationError):
        asyncio.run(
            service.authorization_url("project-1", "https://attacker.example/oauth/callback")
        )
    with pytest.raises(GSCValidationError):
        service._verify_state(f"{state[:-1]}x")


@pytest.mark.parametrize(
    ("site_url", "domain", "expected"),
    [
        ("sc-domain:example.com", "example.com", True),
        ("sc-domain:example.com", "www.example.com", True),
        ("https://www.example.com/", "example.com", True),
        ("https://shop.example.com/", "example.com", False),
        ("sc-domain:unrelated.example", "example.com", False),
    ],
)
def test_gsc_property_domain_matching(site_url: str, domain: str, expected: bool) -> None:
    assert gsc_site_matches_domain(site_url, domain) is expected


def test_gsc_callback_uses_verified_userinfo_identity_and_preserves_refresh_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository = build_gsc_service()
    authorization_url = asyncio.run(service.authorization_url("project-1", "/settings"))
    state = parse_qs(urlparse(authorization_url).query)["state"][0]
    token_results = [
        {
            "access_token": "access-1",
            "refresh_token": "refresh-1",
            "scope": "openid email webmasters.readonly",
        },
        {
            "access_token": "access-2",
            "scope": "openid email webmasters.readonly",
        },
    ]
    monkeypatch.setattr(service, "_exchange_code", lambda code: token_results.pop(0))
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda token: ("google-account-1", "owner@example.com"),
    )

    callback = asyncio.run(service.handle_callback(code="code-1", state=state))
    assert callback == "/settings?gsc_oauth=authorized"
    assert repository.grant is not None
    assert repository.grant.google_account_id == "google-account-1"
    assert repository.grant.refresh_token == "refresh-1"
    assert repository.grant.site_url is None

    repository.grant = GSCGrant(
        **{**repository.grant.__dict__, "site_url": "sc-domain:example.com"}
    )
    asyncio.run(service.handle_callback(code="code-2", state=state))
    assert repository.grant is not None
    assert repository.grant.refresh_token == "refresh-1"
    assert repository.grant.site_url == "sc-domain:example.com"


def test_gsc_callback_reports_cancelled_and_failed_without_losing_query() -> None:
    service, _ = build_gsc_service()
    authorization_url = asyncio.run(
        service.authorization_url(
            "project-1", "/settings?returnTo=%2Fkeywords&gsc_oauth=authorized"
        )
    )
    state = parse_qs(urlparse(authorization_url).query)["state"][0]

    cancelled = asyncio.run(service.handle_callback(code=None, state=state, error="access_denied"))
    failed = asyncio.run(service.handle_callback(code=None, state=state, error="server_error"))

    assert cancelled == "/settings?returnTo=%2Fkeywords&gsc_oauth=cancelled"
    assert failed == "/settings?returnTo=%2Fkeywords&gsc_oauth=failed"
    assert service.failed_callback_path(state) == (
        "/settings?returnTo=%2Fkeywords&gsc_oauth=failed"
    )


def test_gsc_property_selection_requires_verified_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository = build_gsc_service()
    repository.grant = GSCGrant(
        project_id="project-1",
        organization_id="test-org",
        site_url=None,
        google_account_id="google-account-1",
        connected_account_email="owner@example.com",
        refresh_token="refresh-1",
        scopes="webmasters.readonly",
        requires_reconnect=False,
    )
    monkeypatch.setattr(service, "_access_token", AsyncMock(return_value="access-token"))
    monkeypatch.setattr(
        "app.modules.settings.gsc._google_json",
        lambda request: {
            "siteEntry": [
                {
                    "siteUrl": "sc-domain:example.com",
                    "permissionLevel": "siteOwner",
                },
                {
                    "siteUrl": "https://unverified.example/",
                    "permissionLevel": "siteUnverifiedUser",
                },
                {
                    "siteUrl": "https://unrelated.example/",
                    "permissionLevel": "siteOwner",
                },
            ]
        },
    )

    with pytest.raises(GSCValidationError):
        asyncio.run(service.select_site("project-1", "https://unverified.example/"))
    with pytest.raises(GSCValidationError, match="项目域名不匹配"):
        asyncio.run(service.select_site("project-1", "https://unrelated.example/"))
    connection = asyncio.run(service.select_site("project-1", "sc-domain:example.com"))

    assert connection.property_connected is True
    assert connection.site_url == "sc-domain:example.com"


def test_gsc_status_does_not_mark_a_mismatched_property_ready() -> None:
    service, repository = build_gsc_service()
    repository.grant = GSCGrant(
        project_id="project-1",
        organization_id="test-org",
        site_url="sc-domain:unrelated.example",
        google_account_id="google-account-1",
        connected_account_email="owner@example.com",
        refresh_token="refresh-1",
        scopes="webmasters.readonly",
        requires_reconnect=False,
    )

    connection = asyncio.run(service.status("project-1"))

    assert connection.grant_connected is True
    assert connection.property_connected is False
    assert connection.site_url == "sc-domain:unrelated.example"


def test_gsc_performance_report_matches_openseo_granularity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository = build_gsc_service()
    repository.grant = GSCGrant(
        project_id="project-1",
        organization_id="test-org",
        site_url="sc-domain:example.com",
        google_account_id="account-1",
        connected_account_email="owner@example.com",
        refresh_token="refresh-token",
        scopes="scope",
        requires_reconnect=False,
    )
    monkeypatch.setattr(service, "_access_token", AsyncMock(return_value="access-token"))

    requests: list[dict[str, Any]] = []

    def google_json(request) -> dict[str, Any]:
        body = json.loads(request.data)
        requests.append(body)
        if body.get("dimensions") == ["query", "page"]:
            return {
                "rows": [
                    {
                        "keys": ["solar panels", "https://example.com/solar"],
                        "clicks": 12,
                        "impressions": 240,
                        "ctr": 0.05,
                        "position": 6.4,
                    },
                    {
                        "keys": ["brand", "https://example.com/"],
                        "clicks": 50,
                        "impressions": 500,
                        "ctr": 0.1,
                        "position": 2,
                    },
                ]
            }
        if body.get("dimensions") == ["country"]:
            return {
                "rows": [
                    {
                        "keys": ["usa"],
                        "clicks": 80,
                        "impressions": 1600,
                        "ctr": 0.05,
                        "position": 8.2,
                    }
                ]
            }
        current = body["startDate"] == "2026-07-05"
        return {
            "rows": [
                {
                    "keys": [body["startDate"]],
                    "clicks": 80 if current else 60,
                    "impressions": 1600 if current else 1200,
                    "ctr": 0.05,
                    "position": 8.2 if current else 9.1,
                }
            ]
        }

    monkeypatch.setattr("app.modules.settings.gsc._google_json", google_json)
    performance = asyncio.run(
        service.performance_report(
            "project-1",
            date_range="last_28_days",
            device="MOBILE",
            country="USA",
            today=datetime(2026, 8, 5, tzinfo=UTC).date(),
        )
    )

    assert performance.range.start_date.isoformat() == "2026-07-05"
    assert performance.range.end_date.isoformat() == "2026-08-02"
    assert performance.range.previous_start_date.isoformat() == "2026-06-06"
    assert performance.range.previous_end_date.isoformat() == "2026-07-04"
    assert performance.totals.clicks == 80
    assert performance.previous_totals.clicks == 60
    assert [row.query for row in performance.striking_distance] == ["solar panels"]
    assert performance.countries[0].key == "usa"
    assert len(requests) == 4
    assert all(request["dataState"] == "all" for request in requests)
    query_page_request = next(
        request for request in requests if request["dimensions"] == ["query", "page"]
    )
    assert query_page_request["rowLimit"] == 1000
    assert query_page_request["dimensionFilterGroups"][0]["filters"] == [
        {"dimension": "device", "operator": "equals", "expression": "MOBILE"},
        {"dimension": "country", "operator": "equals", "expression": "usa"},
    ]
    country_request = next(request for request in requests if request["dimensions"] == ["country"])
    assert country_request["dimensionFilterGroups"][0]["filters"] == [
        {"dimension": "device", "operator": "equals", "expression": "MOBILE"}
    ]


def test_gsc_performance_table_uses_start_row_and_extra_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository = build_gsc_service()
    repository.grant = GSCGrant(
        project_id="project-1",
        organization_id="test-org",
        site_url="sc-domain:example.com",
        google_account_id="account-1",
        connected_account_email="owner@example.com",
        refresh_token="refresh-token",
        scopes="scope",
        requires_reconnect=False,
    )
    monkeypatch.setattr(service, "_access_token", AsyncMock(return_value="access-token"))
    captured: dict[str, Any] = {}

    def google_json(request) -> dict[str, Any]:
        captured.update(json.loads(request.data))
        return {
            "rows": [
                {
                    "keys": [f"query-{index}"],
                    "clicks": index,
                    "impressions": index * 10,
                    "ctr": 0.1,
                    "position": 8,
                }
                for index in range(26)
            ]
        }

    monkeypatch.setattr("app.modules.settings.gsc._google_json", google_json)
    result = asyncio.run(
        service.performance_table(
            "project-1",
            dimension="query",
            page=2,
            page_size=25,
            today=datetime(2026, 8, 5, tzinfo=UTC).date(),
        )
    )

    assert captured["rowLimit"] == 26
    assert captured["startRow"] == 25
    assert result.has_next_page is True
    assert len(result.rows) == 25


def test_google_json_reads_valid_responses_larger_than_two_megabytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    long_key = "x" * 2_100_000
    encoded = json.dumps({"rows": [{"keys": [long_key]}]}).encode()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def read(self) -> bytes:
            return encoded

    monkeypatch.setattr("app.modules.settings.gsc.urlopen", lambda *_args, **_kwargs: Response())

    payload = _google_json(Request("https://www.googleapis.com/test"))

    assert payload["rows"][0]["keys"][0] == long_key


def test_gsc_performance_table_route_parses_supported_page_sizes() -> None:
    service, _ = build_gsc_service()
    service.performance_table = AsyncMock(
        return_value=GSCPerformanceTableResponse(
            dimension="query",
            page=1,
            page_size=25,
            has_next_page=False,
            rows=[],
        )
    )
    app.dependency_overrides[get_gsc_service] = lambda: service

    async def request() -> tuple[int, int]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            valid = await client.get(
                "/api/v1/projects/project-1/gsc/performance/table",
                params={"dimension": "query", "page": 1, "page_size": 25},
            )
            invalid = await client.get(
                "/api/v1/projects/project-1/gsc/performance/table",
                params={"dimension": "query", "page": 1, "page_size": 30},
            )
        return valid.status_code, invalid.status_code

    try:
        valid_status, invalid_status = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert valid_status == 200
    assert invalid_status == 422
    service.performance_table.assert_awaited_once_with(
        "project-1",
        dimension="query",
        page=1,
        page_size=25,
        date_range="last_28_days",
        device=None,
        country=None,
    )


def test_gsc_refresh_failure_marks_connection_for_reconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository = build_gsc_service()
    repository.grant = GSCGrant(
        project_id="project-1",
        organization_id="test-org",
        site_url="sc-domain:example.com",
        google_account_id="google-account-1",
        connected_account_email="owner@example.com",
        refresh_token="refresh-1",
        scopes="webmasters.readonly",
        requires_reconnect=False,
    )

    def fail_refresh(refresh_token: str) -> str:
        raise GSCReconnectRequiredError("revoked")

    monkeypatch.setattr(service, "_refresh_access_token", fail_refresh)

    with pytest.raises(GSCReconnectRequiredError):
        asyncio.run(service.list_sites("project-1"))
    assert repository.marked_reconnect == ["project-1"]
    assert repository.grant.requires_reconnect is True


def test_gsc_temporary_refresh_failure_does_not_require_reconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository = build_gsc_service()
    repository.grant = GSCGrant(
        project_id="project-1",
        organization_id="test-org",
        site_url="sc-domain:example.com",
        google_account_id="google-account-1",
        connected_account_email="owner@example.com",
        refresh_token="refresh-1",
        scopes="webmasters.readonly",
        requires_reconnect=False,
    )

    def fail_refresh(refresh_token: str) -> str:
        raise GSCUpstreamError("Google API 返回 HTTP 503", status_code=503)

    monkeypatch.setattr(service, "_refresh_access_token", fail_refresh)

    with pytest.raises(GSCUpstreamError):
        asyncio.run(service.list_sites("project-1"))
    assert repository.marked_reconnect == []
    assert repository.grant.requires_reconnect is False


def test_gsc_routes_expose_connection_and_oauth_start() -> None:
    service, _ = build_gsc_service()
    app.dependency_overrides[get_gsc_service] = lambda: service

    async def request() -> tuple[dict[str, Any], dict[str, Any]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            status_response = await client.get("/api/v1/projects/project-1/gsc/connection")
            oauth_response = await client.post(
                "/api/v1/projects/project-1/gsc/oauth/start",
                json={"callback_url": "https://app.example/settings"},
            )
        assert status_response.status_code == 200
        assert oauth_response.status_code == 200
        return status_response.json(), oauth_response.json()

    try:
        status_payload, oauth_payload = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_payload["oauth_configured"] is True
    assert status_payload["oauth_redirect_uri"] == ("https://api.example/api/v1/gsc/oauth/callback")
    assert status_payload["property_connected"] is False
    assert oauth_payload["authorization_url"].startswith(
        "https://accounts.google.com/o/oauth2/v2/auth?"
    )


def test_gsc_route_redirects_callback_failures_to_frontend() -> None:
    service, _ = build_gsc_service()
    authorization_url = asyncio.run(service.authorization_url("project-1", "/settings?tab=gsc"))
    state = parse_qs(urlparse(authorization_url).query)["state"][0]
    service.handle_callback = AsyncMock(side_effect=GSCUpstreamError("token exchange failed"))
    app.dependency_overrides[get_gsc_service] = lambda: service

    async def request() -> tuple[int, str]:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test", follow_redirects=False
        ) as client:
            response = await client.get(
                "/api/v1/gsc/oauth/callback",
                params={"state": state, "code": "code-1"},
            )
        return response.status_code, response.headers["location"]

    try:
        status_code, location = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 303
    assert location == "https://app.example/settings?tab=gsc&gsc_oauth=failed"
