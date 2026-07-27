from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "SEO API"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/seo"
    redis_url: str = "redis://localhost:6379/0"
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    crawler_task_queue: str = "crawler-go"
    crawler_worker_executable: str | None = None
    crawler_worker_idle_timeout_seconds: float = 120
    crawler_database_url: str | None = None
    crawler_browser_cache_dir: str | None = None
    crawler_proxy_url: str | None = None
    crawler_fallback_proxy_url: str | None = None
    site_understanding_request_timeout: str = "12s"
    site_understanding_max_retries: int = 2
    site_understanding_dispatch_interval_seconds: float = 5
    audit_control_timeout_seconds: float = 30
    audit_checkpoint_poll_interval_seconds: float = 0.1
    audit_reconcile_timeout_seconds: float = 10
    default_organization_id: str = "local"
    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str = "seo-crawler"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_use_path_style: bool = False
    s3_create_bucket: bool = False
    google_pagespeed_api_key: str | None = None
    business_profile_ai_base_url: str | None = None
    business_profile_ai_api_key: str | None = None
    business_profile_ai_model: str = "gpt-5.4-mini"
    business_profile_ai_timeout: str = "90s"
    business_profile_ai_max_retries: int = 1
    ai_settings_encryption_key: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
