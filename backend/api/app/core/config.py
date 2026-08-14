from functools import lru_cache
from ipaddress import ip_address
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "SEO API"
    api_prefix: str = "/api/v1"
    api_host: str = "127.0.0.1"
    api_port: int = Field(default=7200, ge=1, le=65_535)
    api_workers: int = Field(default=1, ge=1, le=16)
    api_log_level: Literal["critical", "error", "warning", "info", "debug"] = "info"
    cors_origins: list[str] = ["http://localhost:5173"]
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/seo"
    database_url_secret_ref: str | None = None
    database_url_file: Path | None = None
    redis_url: str = "redis://localhost:6379/0"
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    backlinks_task_queue: str = "growthos.backlinks.v1"
    backlinks_business_consumers_expected: bool = True
    s3_endpoint_url: str | None = None
    backlinks_private_base_url: str = "http://127.0.0.1:7301"
    backlinks_request_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    runtime_dependency_checks_enabled: bool = False
    runtime_dependency_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    platform_auth_issuer: str = "growthos-platform-auth"
    platform_auth_signing_key: SecretStr | None = None
    platform_auth_signing_key_secret_ref: str | None = None
    platform_auth_signing_key_file: Path | None = None
    platform_auth_max_token_ttl_seconds: int = Field(default=900, ge=1, le=3600)
    platform_context_signing_key: SecretStr | None = None
    platform_context_signing_key_secret_ref: str | None = None
    platform_context_signing_key_file: Path | None = None
    backlinks_runtime_mode: Literal[
        "DISABLED",
        "LOCAL_PRODUCT_ACCEPTANCE",
        "LOCAL_PRODUCT",
    ] = "DISABLED"
    backlinks_live_canary_stage: Literal["LIVE-003", "LIVE-004"] | None = None
    local_product_frontend_origin: str = "http://localhost:5173"
    local_product_organization_id: str | None = None
    local_product_workspace_id: str | None = None
    local_product_website_project_id: str | None = None
    local_product_website_project_key: str | None = None
    local_product_user_id: str | None = None
    local_product_session_id: str | None = None
    google_oauth_enabled: bool = False
    platform_secret_store_enabled: bool = False
    gmail_send_enabled: bool = False
    gmail_sync_enabled: bool = False
    dataforseo_enabled: bool = False
    ai_provider_enabled: bool = False
    browser_provider_enabled: bool = False

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @staticmethod
    def _read_secret(reference: str | None, path: Path | None, name: str) -> str:
        if reference is None or not reference.strip():
            raise ValueError(f"{name}_SECRET_REF is required in production")
        if path is None:
            raise ValueError(f"{name}_FILE is required in production")
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ValueError(f"{name}_FILE is unreadable") from error
        if not value:
            raise ValueError(f"{name}_FILE is empty")
        return value

    @staticmethod
    def _is_private_core_url(value: str) -> bool:
        parsed = urlparse(value)
        if (
            parsed.scheme != "http"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            return False
        hostname = parsed.hostname.lower()
        if hostname in {"localhost", "::1"}:
            return True
        try:
            address = ip_address(hostname)
            return (
                not address.is_unspecified
                and not address.is_multicast
                and (address.is_private or address.is_loopback)
            )
        except ValueError:
            return "." not in hostname or hostname.endswith((".internal", ".local", ".svc"))

    @staticmethod
    def _require_text(value: str | None, name: str) -> str:
        if value is None or not value.strip():
            raise ValueError(f"{name} is required for the local product runtime")
        return value

    def _validate_provider_capabilities(self) -> None:
        if self.backlinks_runtime_mode == "DISABLED":
            if any(
                (
                    self.google_oauth_enabled,
                    self.platform_secret_store_enabled,
                    self.gmail_send_enabled,
                    self.gmail_sync_enabled,
                    self.dataforseo_enabled,
                    self.ai_provider_enabled,
                    self.browser_provider_enabled,
                )
            ):
                raise ValueError(
                    "External provider capabilities must remain disabled unless "
                    "BACKLINKS_RUNTIME_MODE is a local product mode"
                )
            return

        if self.api_host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Local product FastAPI must bind to loopback")
        if self.api_port != 7200:
            raise ValueError("Local product FastAPI must use port 7200")
        if self.backlinks_private_base_url != "http://127.0.0.1:7301":
            raise ValueError(
                "Local product Backlinks Core must use http://127.0.0.1:7301"
            )
        if self.local_product_frontend_origin != "http://localhost:5173":
            raise ValueError(
                "Local product frontend must use http://localhost:5173"
            )
        if self.cors_origins != [self.local_product_frontend_origin]:
            raise ValueError(
                "Local product CORS must allow only the local frontend"
            )
        self._require_text(
            self.local_product_organization_id,
            "LOCAL_PRODUCT_ORGANIZATION_ID",
        )
        self._require_text(
            self.local_product_workspace_id,
            "LOCAL_PRODUCT_WORKSPACE_ID",
        )
        self._require_text(
            self.local_product_website_project_id,
            "LOCAL_PRODUCT_WEBSITE_PROJECT_ID",
        )
        project_key = self._require_text(
            self.local_product_website_project_key,
            "LOCAL_PRODUCT_WEBSITE_PROJECT_KEY",
        )
        self._require_text(self.local_product_user_id, "LOCAL_PRODUCT_USER_ID")
        self._require_text(self.local_product_session_id, "LOCAL_PRODUCT_SESSION_ID")

        if self.backlinks_runtime_mode == "LOCAL_PRODUCT":
            if self.backlinks_live_canary_stage is not None:
                raise ValueError(
                    "BACKLINKS_LIVE_CANARY_STAGE must be unset for LOCAL_PRODUCT"
                )
            gmail_enabled = self.gmail_send_enabled or self.gmail_sync_enabled
            secret_store_required = (
                self.google_oauth_enabled
                or gmail_enabled
                or self.dataforseo_enabled
                or self.ai_provider_enabled
            )
            if gmail_enabled and not self.google_oauth_enabled:
                raise ValueError(
                    "Gmail capabilities require Google OAuth in LOCAL_PRODUCT"
                )
            if secret_store_required and not self.platform_secret_store_enabled:
                raise ValueError(
                    "Enabled credential-backed capabilities require Platform "
                    "Secret Store in LOCAL_PRODUCT"
                )
            return

        if self.backlinks_live_canary_stage is None:
            raise ValueError(
                "BACKLINKS_LIVE_CANARY_STAGE is required for "
                "LOCAL_PRODUCT_ACCEPTANCE"
            )
        if project_key != "live001-canary":
            raise ValueError(
                "LOCAL_PRODUCT_WEBSITE_PROJECT_KEY must equal live001-canary"
            )
        if not self.google_oauth_enabled or not self.platform_secret_store_enabled:
            raise ValueError(
                "Google OAuth and Platform Secret Store must be enabled for "
                "LOCAL_PRODUCT_ACCEPTANCE"
            )
        expected_gmail_enabled = self.backlinks_live_canary_stage == "LIVE-004"
        if (
            self.gmail_send_enabled != expected_gmail_enabled
            or self.gmail_sync_enabled != expected_gmail_enabled
            or self.dataforseo_enabled
            or self.ai_provider_enabled
            or self.browser_provider_enabled
        ):
            raise ValueError(
                "Provider capability matrix does not match "
                f"{self.backlinks_live_canary_stage}"
            )

    @model_validator(mode="after")
    def validate_runtime_configuration(self) -> "Settings":
        if self.database_url_file is not None:
            self.database_url = self._read_secret(
                self.database_url_secret_ref,
                self.database_url_file,
                "DATABASE_URL",
            )
        if self.platform_auth_signing_key_file is not None:
            self.platform_auth_signing_key = SecretStr(
                self._read_secret(
                    self.platform_auth_signing_key_secret_ref,
                    self.platform_auth_signing_key_file,
                    "PLATFORM_AUTH_SIGNING_KEY",
                )
            )
        if self.platform_context_signing_key_file is not None:
            self.platform_context_signing_key = SecretStr(
                self._read_secret(
                    self.platform_context_signing_key_secret_ref,
                    self.platform_context_signing_key_file,
                    "PLATFORM_CONTEXT_SIGNING_KEY",
                )
            )

        if self.app_env != "production":
            return self

        self.database_url = self._read_secret(
            self.database_url_secret_ref,
            self.database_url_file,
            "DATABASE_URL",
        )
        self.platform_auth_signing_key = SecretStr(
            self._read_secret(
                self.platform_auth_signing_key_secret_ref,
                self.platform_auth_signing_key_file,
                "PLATFORM_AUTH_SIGNING_KEY",
            )
        )
        self.platform_context_signing_key = SecretStr(
            self._read_secret(
                self.platform_context_signing_key_secret_ref,
                self.platform_context_signing_key_file,
                "PLATFORM_CONTEXT_SIGNING_KEY",
            )
        )
        if len(self.platform_auth_signing_key.get_secret_value().encode()) < 32:
            raise ValueError("PLATFORM_AUTH_SIGNING_KEY must contain at least 32 bytes")
        if len(self.platform_context_signing_key.get_secret_value().encode()) < 32:
            raise ValueError("PLATFORM_CONTEXT_SIGNING_KEY must contain at least 32 bytes")
        if not self.runtime_dependency_checks_enabled:
            raise ValueError("RUNTIME_DEPENDENCY_CHECKS_ENABLED must be true in production")
        if not self._is_private_core_url(self.backlinks_private_base_url):
            raise ValueError("BACKLINKS_PRIVATE_BASE_URL must resolve to a private HTTP endpoint")
        if "*" in self.cors_origins:
            raise ValueError("CORS_ORIGINS must not contain a wildcard in production")
        self._validate_provider_capabilities()
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
