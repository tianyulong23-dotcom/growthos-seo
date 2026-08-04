import pytest

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.repository import KeywordRepository


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
async def test_repository_uses_environment_when_database_settings_are_unavailable() -> None:
    connection = FakeConnection()
    settings = KeywordWorkerSettings(
        ai_settings_encryption_key="",
        dataforseo_login="environment-login",
        dataforseo_password="environment-password",
    )
    repository = KeywordRepository(FakePool(connection), settings)  # type: ignore[arg-type]

    dataforseo = await repository.load_dataforseo_config("organization-1")

    assert dataforseo.login == "environment-login"
    assert dataforseo.password == "environment-password"
    assert connection.calls == []
