from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "SEO API"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = ["http://localhost:5173"]
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/seo"
    redis_url: str = "redis://localhost:6379/0"
    temporal_address: str = "localhost:7233"
    s3_endpoint_url: str | None = None
    backlinks_private_base_url: str = "http://127.0.0.1:7301"
    backlinks_request_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    platform_auth_issuer: str = "growthos-platform-auth"
    platform_auth_signing_key: SecretStr | None = None
    platform_auth_max_token_ttl_seconds: int = Field(default=900, ge=1, le=3600)
    platform_context_signing_key: SecretStr | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
