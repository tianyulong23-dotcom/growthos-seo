from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
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
    agent_task_queue: str = "agent-ai"
    content_task_queue: str = "content-ai"
    content_target_seconds: int = Field(default=600, gt=0)
    content_hard_timeout_seconds: int = Field(default=1200, gt=0)
    content_execution_lease_seconds: int = Field(default=360, gt=0)
    article_source_text_max_bytes: int = Field(default=2_000_000, gt=0)
    dataforseo_login: str | None = None
    dataforseo_password: str | None = None
    dataforseo_base_url: str = "https://api.dataforseo.com"
    dataforseo_cache_ttl_seconds: int = Field(default=86400, gt=0)
    dataforseo_timeout_seconds: int = Field(default=45, gt=0)
    article_research_provider: str = ""
    article_research_base_url: str = ""
    article_research_api_key: str = ""
    article_research_model: str = ""
    article_research_fallback_provider: str = ""
    article_research_fallback_base_url: str = ""
    article_research_fallback_api_key: str = ""
    article_research_fallback_model: str = ""
    article_research_timeout_seconds: int = Field(default=90, gt=0)
    article_research_cache_ttl_seconds: int = Field(default=86_400, gt=0)
    article_research_max_concurrency: int = Field(default=2, ge=1, le=8)
    article_research_max_retries: int = Field(default=2, ge=0, le=5)
    article_research_timeout_max_retries: int = Field(default=1, ge=0, le=2)
    article_research_circuit_failure_threshold: int = Field(default=2, ge=1, le=10)
    article_research_retry_initial_seconds: float = Field(default=0.5, ge=0, le=30)
    article_research_retry_max_seconds: float = Field(default=5, ge=0, le=60)
    article_writing_max_concurrency: int = Field(default=3, ge=1, le=6)
    article_model_input_cost_per_million: float = Field(default=0.0, ge=0)
    article_model_output_cost_per_million: float = Field(default=0.0, ge=0)
    agent_actor_id: str = "local-user"
    agent_max_model_rounds: int = Field(default=48, gt=0)
    agent_max_consecutive_failures: int = Field(default=3, gt=0)
    agent_tool_arguments_bytes: int = Field(default=256_000, ge=1_024)
    agent_tool_result_bytes: int = Field(default=102_400, ge=1_024)
    agent_tool_round_tokens: int = Field(default=8_000, ge=1_024)
    agent_tool_context_tokens: int = Field(default=6_000, ge=1_024)
    agent_tool_summary_tokens: int = Field(default=2_000, ge=256)
    agent_final_answer_chars: int = Field(default=8_000, gt=0)
    agent_model_timeout_seconds: int = Field(default=120, gt=0)
    agent_read_tool_timeout_seconds: int = Field(default=60, gt=0)
    agent_write_tool_timeout_seconds: int = Field(default=180, gt=0)
    agent_run_timeout_seconds: int = Field(default=1_800, gt=0)
    agent_execution_lease_seconds: int = Field(default=15, gt=0)
    agent_context_window_tokens: int = Field(default=32_000, ge=8_192)
    agent_context_trigger_tokens: int = Field(default=20_000, ge=4_096)
    agent_context_input_tokens: int = Field(default=24_000, ge=4_096)
    agent_context_recent_tokens: int = Field(default=5_000, ge=1_024)
    agent_context_compaction_batch_tokens: int = Field(default=12_000, ge=1_024)
    agent_context_summary_tokens: int = Field(default=2_000, ge=256)
    agent_stuck_run_seconds: int = Field(default=300, gt=0)
    keyword_task_queue: str = "keywords-python"
    keyword_dispatch_interval_seconds: float = 2
    keyword_reconcile_interval_seconds: float = 30
    keyword_reconcile_timeout_seconds: float = 10
    keyword_workflow_state_concurrency: int = 10
    keyword_workflow_state_timeout_seconds: float = 3
    keyword_workflow_orphan_recovery_limit: int = 3
    keyword_worker_stale_seconds: int = 45
    keyword_operational_cleanup_interval_seconds: int = 3600
    keyword_operational_retention_days: int = 90
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
    business_profile_ai_provider: Literal["openai", "anthropic", "openrouter"] = "openai"
    business_profile_ai_model: str = "gpt-5.4-mini"
    business_profile_ai_timeout: str = "90s"
    business_profile_ai_max_retries: int = 4
    ai_settings_encryption_key: str | None = None
    google_ads_developer_token: str | None = None
    google_ads_client_id: str | None = None
    google_ads_client_secret: str | None = None
    google_ads_refresh_token: str | None = None
    google_ads_customer_id: str | None = None
    google_ads_login_customer_id: str | None = None
    google_ads_api_version: str = "v23"
    backlinks_private_base_url: str = "http://127.0.0.1:7301"
    backlinks_request_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    platform_auth_issuer: str = "growthos-platform-auth"
    platform_auth_signing_key: SecretStr | None = None
    platform_auth_max_token_ttl_seconds: int = Field(default=900, ge=1, le=3600)
    platform_context_signing_key: SecretStr | None = None
    google_gsc_client_id: str | None = None
    google_gsc_client_secret: str | None = None
    gsc_public_api_origin: str = "http://localhost:8000"
    gsc_frontend_origin: str = "http://localhost:8080"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
