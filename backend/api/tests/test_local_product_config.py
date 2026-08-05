from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def local_product_settings(
    tmp_path: Path,
    **overrides: object,
) -> Settings:
    database_url_file = tmp_path / "database-url"
    auth_key_file = tmp_path / "platform-auth-key"
    context_key_file = tmp_path / "platform-context-key"
    database_url_file.write_text(
        "postgresql+psycopg://app:password@127.0.0.1:55432/growthos",
        encoding="utf-8",
    )
    auth_key_file.write_text("a" * 32, encoding="utf-8")
    context_key_file.write_text("c" * 32, encoding="utf-8")
    values: dict[str, object] = {
        "_env_file": None,
        "app_env": "production",
        "api_host": "127.0.0.1",
        "api_port": 7200,
        "cors_origins": ["http://localhost:5173"],
        "database_url_secret_ref": "secret://test/database",
        "database_url_file": database_url_file,
        "runtime_dependency_checks_enabled": True,
        "platform_auth_signing_key_secret_ref": "secret://test/auth",
        "platform_auth_signing_key_file": auth_key_file,
        "platform_context_signing_key_secret_ref": "secret://test/context",
        "platform_context_signing_key_file": context_key_file,
        "backlinks_runtime_mode": "LOCAL_PRODUCT_ACCEPTANCE",
        "backlinks_live_canary_stage": "LIVE-003",
        "local_product_frontend_origin": "http://localhost:5173",
        "local_product_organization_id": "org-1",
        "local_product_workspace_id": "workspace-1",
        "local_product_website_project_id": "project-1",
        "local_product_website_project_key": "live001-canary",
        "local_product_user_id": "local-user",
        "local_product_session_id": "local-session",
        "google_oauth_enabled": True,
        "platform_secret_store_enabled": True,
        "gmail_send_enabled": False,
        "gmail_sync_enabled": False,
        "dataforseo_enabled": False,
        "ai_provider_enabled": False,
        "browser_provider_enabled": False,
    }
    values.update(overrides)
    return Settings(**values)


def test_live_003_allows_only_google_oauth_and_secret_store(tmp_path: Path) -> None:
    settings = local_product_settings(tmp_path)

    assert settings.backlinks_live_canary_stage == "LIVE-003"
    assert settings.google_oauth_enabled is True
    assert settings.platform_secret_store_enabled is True
    assert settings.gmail_send_enabled is False
    assert settings.gmail_sync_enabled is False


@pytest.mark.parametrize(
    "overrides",
    [
        {"gmail_send_enabled": True},
        {"gmail_sync_enabled": True},
        {"dataforseo_enabled": True},
        {"ai_provider_enabled": True},
        {"browser_provider_enabled": True},
        {"api_host": "0.0.0.0"},
        {"local_product_website_project_id": ""},
        {"local_product_website_project_key": "another-project"},
    ],
)
def test_live_003_fails_closed_on_invalid_capability_or_boundary(
    tmp_path: Path,
    overrides: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        local_product_settings(tmp_path, **overrides)


def test_live_004_requires_both_gmail_capabilities(tmp_path: Path) -> None:
    settings = local_product_settings(
        tmp_path,
        backlinks_live_canary_stage="LIVE-004",
        gmail_send_enabled=True,
        gmail_sync_enabled=True,
    )
    assert settings.gmail_send_enabled is True
    assert settings.gmail_sync_enabled is True

    with pytest.raises(ValidationError):
        local_product_settings(
            tmp_path,
            backlinks_live_canary_stage="LIVE-004",
            gmail_send_enabled=True,
            gmail_sync_enabled=False,
        )


def test_local_product_uses_dynamic_project_and_independent_capabilities(
    tmp_path: Path,
) -> None:
    settings = local_product_settings(
        tmp_path,
        backlinks_runtime_mode="LOCAL_PRODUCT",
        backlinks_live_canary_stage=None,
        local_product_website_project_id="project-real",
        local_product_website_project_key="project-real",
        gmail_send_enabled=True,
        gmail_sync_enabled=False,
        ai_provider_enabled=True,
    )

    assert settings.backlinks_runtime_mode == "LOCAL_PRODUCT"
    assert settings.local_product_website_project_key == "project-real"
    assert settings.gmail_send_enabled is True
    assert settings.gmail_sync_enabled is False
    assert settings.ai_provider_enabled is True
    assert settings.dataforseo_enabled is False


@pytest.mark.parametrize(
    "overrides",
    [
        {"backlinks_live_canary_stage": "LIVE-004"},
        {"gmail_send_enabled": True, "google_oauth_enabled": False},
        {
            "ai_provider_enabled": True,
            "platform_secret_store_enabled": False,
        },
        {"api_host": "0.0.0.0"},
        {"local_product_website_project_key": ""},
    ],
)
def test_local_product_fails_closed_on_invalid_boundary_or_dependency(
    tmp_path: Path,
    overrides: dict[str, object],
) -> None:
    values: dict[str, object] = {
        "backlinks_runtime_mode": "LOCAL_PRODUCT",
        "backlinks_live_canary_stage": None,
        "local_product_website_project_id": "project-real",
        "local_product_website_project_key": "project-real",
    }
    values.update(overrides)
    with pytest.raises(ValidationError):
        local_product_settings(tmp_path, **values)
