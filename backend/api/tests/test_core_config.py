from app.core.config import Settings


def test_default_cors_origins_cover_local_frontend_entrypoints() -> None:
    settings = Settings(_env_file=None)

    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]


def test_gmail_oauth_callback_uses_google_redirect_uri_as_shared_fallback(
    monkeypatch,
) -> None:
    monkeypatch.delenv("BACKLINKS_OAUTH_CALLBACK_URL", raising=False)
    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI",
        "https://app.example.com/api/v1/backlinks/gmail-connections/callback",
    )

    settings = Settings(_env_file=None)

    assert settings.backlinks_oauth_callback_url == (
        "https://app.example.com/api/v1/backlinks/gmail-connections/callback"
    )


def test_gmail_oauth_callback_prefers_platform_public_callback(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "BACKLINKS_OAUTH_CALLBACK_URL",
        "https://platform.example.com/api/v1/backlinks/gmail-connections/callback",
    )
    monkeypatch.setenv(
        "GOOGLE_OAUTH_REDIRECT_URI",
        "https://legacy.example.com/api/v1/backlinks/gmail-connections/callback",
    )

    settings = Settings(_env_file=None)

    assert settings.backlinks_oauth_callback_url == (
        "https://platform.example.com/api/v1/backlinks/gmail-connections/callback"
    )


def test_gmail_oauth_callback_allows_explicit_test_configuration() -> None:
    settings = Settings(
        _env_file=None,
        backlinks_oauth_callback_url=(
            "https://test.example.com/api/v1/backlinks/gmail-connections/callback"
        ),
    )

    assert settings.backlinks_oauth_callback_url == (
        "https://test.example.com/api/v1/backlinks/gmail-connections/callback"
    )
