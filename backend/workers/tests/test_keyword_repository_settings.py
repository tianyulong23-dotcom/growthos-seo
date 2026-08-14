import pytest

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.repository import (
    CompetitorAnalysisContext,
    KeywordRepository,
    create_pool,
)


class FakeConnection:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[str, ...]]] = []

    async def fetchrow(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        if "dataforseo_provider_settings" in query:
            return {
                "login": "stored-login",
                "password": "stored-password",
            }
        return None


class FakeContextConnection(FakeConnection):
    async def fetchrow(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        return {
            "organization_id": "organization-1",
            "project_id": "project-1",
            "run_id": "run-1",
            "kind": "initial",
            "round_number": 1,
            "profile_snapshot": {},
            "profile_source": "",
            "profile_version": "",
            "competitor_domain": None,
            "domain": "example.com",
            "country": "US",
            "language": "en",
        }


class FakePlaintextSettingsConnection(FakeConnection):
    async def fetchrow(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        return {
            "login": "stored-login",
            "password_encrypted": b"plaintext:v1:stored-password",
        }


class FakePlaintextAISettingsConnection(FakeConnection):
    async def fetchrow(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        return {
            "base_url": "https://stored-ai.example/v1",
            "api_protocol": "responses",
            "api_key_encrypted": b"plaintext:v1:stored-api-key",
            "model": "stored-model",
            "keyword_model": "stored-keyword-model",
            "business_model": "stored-business-model",
            "reasoning_effort": "medium",
            "keyword_reasoning_effort": "high",
            "business_reasoning_effort": "low",
            "request_timeout_seconds": 45,
            "max_retries": 2,
        }


class FakePlaintextGSCConnection(FakeConnection):
    async def fetchrow(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        if "gsc_oauth_provider_settings" in query:
            return {
                "client_id": "stored-client-id",
                "client_secret_encrypted": b"plaintext:v1:stored-client-secret",
            }
        return {
            "site_url": "sc-domain:example.com",
            "refresh_token_encrypted": b"plaintext:v1:stored-refresh-token",
            "requires_reconnect": False,
        }


class FakeEncryptedGSCConnection(FakeConnection):
    async def fetchrow(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        if "gsc_oauth_provider_settings" in query:
            return {
                "client_id": "stored-client-id",
                "client_secret_encrypted": b"encrypted-client-secret",
            }
        return {
            "site_url": "sc-domain:example.com",
            "refresh_token_encrypted": b"encrypted-refresh-token",
            "requires_reconnect": False,
        }

    async def fetchval(self, query: str, *arguments: str):
        self.calls.append((query, arguments))
        if "gsc_oauth_provider_settings" in query:
            return "decrypted-client-secret"
        return "decrypted-refresh-token"


class FakeAcquire:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    async def __aenter__(self) -> FakeConnection:
        return self.connection

    async def __aexit__(self, *_: object) -> None:
        return None


class FakePool:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    def acquire(self) -> FakeAcquire:
        return FakeAcquire(self.connection)


@pytest.mark.anyio
async def test_pool_uses_api_schema_search_path(monkeypatch: pytest.MonkeyPatch) -> None:
    pool = object()
    captured: dict[str, object] = {}

    async def fake_create_pool(**options: object) -> object:
        captured.update(options)
        return pool

    monkeypatch.setattr("seo_workers.keywords.repository.asyncpg.create_pool", fake_create_pool)

    result = await create_pool(KeywordWorkerSettings(database_url="postgresql://db/seo"))

    assert result is pool
    assert captured["server_settings"] == {
        "search_path": "public, platform, crawling, audit"
    }


@pytest.mark.anyio
async def test_build_run_context_uses_project_location_fields() -> None:
    connection = FakeContextConnection()
    repository = KeywordRepository(
        FakePool(connection), KeywordWorkerSettings()
    )  # type: ignore[arg-type]

    context = await repository.load_context(
        {
            "run_id": "run-1",
            "project_id": "project-1",
            "organization_id": "organization-1",
        }
    )

    query, _ = connection.calls[0]
    assert "project.domain" in query
    assert "project.country" in query
    assert "project.language" in query
    assert "run.target_domain" not in query
    assert context.domain == "example.com"


@pytest.mark.anyio
async def test_repository_prefers_encrypted_database_provider_settings() -> None:
    connection = FakeConnection()
    settings = KeywordWorkerSettings(
        ai_settings_encryption_key="encryption-key",
        dataforseo_login="environment-login",
        dataforseo_password="environment-password",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]

    dataforseo = await repository.load_dataforseo_config("organization-1")

    assert dataforseo.login == "stored-login"
    assert dataforseo.password == "stored-password"
    assert all(
        arguments == ("organization-1", "encryption-key") for _, arguments in connection.calls
    )


@pytest.mark.anyio
async def test_repository_reads_allowed_plaintext_database_provider_settings() -> None:
    connection = FakePlaintextSettingsConnection()
    settings = KeywordWorkerSettings(
        ai_settings_allow_plaintext=True,
        dataforseo_login="environment-login",
        dataforseo_password="environment-password",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]

    dataforseo = await repository.load_dataforseo_config("organization-1")

    assert dataforseo.login == "stored-login"
    assert dataforseo.password == "stored-password"
    assert connection.calls[0][1] == ("organization-1",)


@pytest.mark.anyio
async def test_repository_reads_allowed_plaintext_database_ai_settings() -> None:
    connection = FakePlaintextAISettingsConnection()
    settings = KeywordWorkerSettings(
        ai_settings_allow_plaintext=True,
        business_profile_ai_base_url="https://environment-ai.example/v1",
        business_profile_ai_api_key="environment-api-key",
        business_profile_ai_model="environment-model",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]

    ai = await repository.load_ai_config("organization-1")

    assert ai.base_url == "https://stored-ai.example/v1"
    assert ai.api_protocol == "responses"
    assert ai.api_key == "stored-api-key"
    assert ai.model == "stored-model"
    assert ai.effective_keyword_model == "stored-keyword-model"
    assert ai.effective_business_model == "stored-business-model"
    assert ai.effective_keyword_reasoning_effort == "high"
    assert ai.effective_business_reasoning_effort == "low"
    assert ai.timeout_seconds == 45
    assert ai.max_retries == 2
    assert connection.calls[0][1] == ("organization-1",)


@pytest.mark.anyio
async def test_repository_reads_allowed_plaintext_gsc_connection() -> None:
    connection = FakePlaintextGSCConnection()
    settings = KeywordWorkerSettings(
        ai_settings_allow_plaintext=True,
        google_gsc_client_id="client-id",
        google_gsc_client_secret="client-secret",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]
    context = CompetitorAnalysisContext(
        organization_id="organization-1",
        project_id="project-1",
        run_id="run-1",
        domain="example.com",
        country="US",
        language="en",
        competitor_limit=5,
        keyword_limit=100,
    )

    gsc = await repository.load_gsc_config(context)

    assert gsc.site_url == "sc-domain:example.com"
    assert gsc.refresh_token == "stored-refresh-token"
    assert gsc.client_id == "stored-client-id"
    assert gsc.client_secret == "stored-client-secret"
    assert connection.calls[0][1] == ("project-1", "organization-1")
    assert connection.calls[1][1] == ("organization-1",)


@pytest.mark.anyio
async def test_repository_decrypts_encrypted_gsc_connection() -> None:
    connection = FakeEncryptedGSCConnection()
    settings = KeywordWorkerSettings(
        ai_settings_encryption_key="encryption-key",
        google_gsc_client_id="client-id",
        google_gsc_client_secret="client-secret",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]
    context = CompetitorAnalysisContext(
        organization_id="organization-1",
        project_id="project-1",
        run_id="run-1",
        domain="example.com",
        country="US",
        language="en",
        competitor_limit=5,
        keyword_limit=100,
    )

    gsc = await repository.load_gsc_config(context)

    assert gsc.refresh_token == "decrypted-refresh-token"
    assert gsc.client_id == "stored-client-id"
    assert gsc.client_secret == "decrypted-client-secret"
    assert connection.calls[0][1] == ("project-1", "organization-1")
    assert connection.calls[1][1] == (
        "project-1",
        "encryption-key",
        "organization-1",
    )
    assert connection.calls[2][1] == ("organization-1",)
    assert connection.calls[3][1] == ("organization-1", "encryption-key")


@pytest.mark.anyio
async def test_repository_rejects_plaintext_gsc_connection_in_production() -> None:
    connection = FakePlaintextGSCConnection()
    settings = KeywordWorkerSettings(
        app_env="production",
        ai_settings_allow_plaintext=False,
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]
    context = CompetitorAnalysisContext(
        organization_id="organization-1",
        project_id="project-1",
        run_id="run-1",
        domain="example.com",
        country="US",
        language="en",
        competitor_limit=5,
        keyword_limit=100,
    )

    with pytest.raises(RuntimeError, match="服务器尚未配置设置加密密钥"):
        await repository.load_gsc_config(context)

    assert connection.calls[0][1] == ("project-1", "organization-1")


@pytest.mark.anyio
async def test_repository_uses_environment_when_database_settings_are_unavailable() -> None:
    connection = FakeConnection()
    settings = KeywordWorkerSettings(
        app_env="production",
        ai_settings_encryption_key="",
        dataforseo_login="environment-login",
        dataforseo_password="environment-password",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]

    dataforseo = await repository.load_dataforseo_config("organization-1")

    assert dataforseo.login == "environment-login"
    assert dataforseo.password == "environment-password"
    assert connection.calls == []
