from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class KeywordWorkerSettings(BaseSettings):
    database_url: str = "postgresql://postgres:postgres@localhost:5432/seo"
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    keyword_task_queue: str = "keywords-python"

    dataforseo_login: str = ""
    dataforseo_password: str = ""

    business_profile_ai_base_url: str = ""
    business_profile_ai_api_key: str = ""
    business_profile_ai_model: str = "gpt-5.4-mini"
    business_profile_ai_timeout: str = "90s"
    business_profile_ai_max_retries: int = 1
    keyword_initial_filter_ai_model: str = "gpt-5.6-luna"
    keyword_topic_dedup_ai_model: str = "gpt-5.6-terra"
    ai_settings_encryption_key: str = ""
    google_gsc_client_id: str = ""
    google_gsc_client_secret: str = ""

    keyword_profile_wait_seconds: int = 30
    keyword_profile_poll_seconds: int = 5
    keyword_http_timeout_seconds: int = 60
    keyword_http_max_retries: int = 2
    keyword_metrics_cache_days: int = 30
    keyword_external_prepare_lease_seconds: int = 120
    keyword_external_submitted_lease_seconds: int = 600
    keyword_worker_heartbeat_seconds: int = 10
    keyword_max_concurrent_activities: int = 8
    keyword_worker_health_host: str = "0.0.0.0"
    keyword_worker_health_port: int = 8090
    keyword_crawler_probe_url: str = "http://localhost:8091"
    keyword_crawler_probe_timeout_seconds: int = 300

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def asyncpg_database_url(self) -> str:
        return self.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)

    @property
    def dataforseo_configured(self) -> bool:
        return bool(self.dataforseo_login and self.dataforseo_password)
