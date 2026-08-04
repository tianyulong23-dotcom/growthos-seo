from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator


DEFAULT_AI_REQUEST_TIMEOUT_SECONDS = 90
DEFAULT_AI_MAX_RETRIES = 4
AIProviderName = Literal["openai", "anthropic", "openrouter"]


def infer_provider(base_url: str) -> AIProviderName:
    hostname = (urlsplit(base_url).hostname or "").lower()
    if hostname == "openrouter.ai" or hostname.endswith(".openrouter.ai"):
        return "openrouter"
    if hostname == "anthropic.com" or hostname.endswith(".anthropic.com"):
        return "anthropic"
    return "openai"


def clean_base_url(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("接口地址必须是有效的 HTTP 或 HTTPS 地址")
    if parsed.username or parsed.password:
        raise ValueError("接口地址不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise ValueError("接口地址不能包含查询参数或片段")
    return value


def clean_model(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("模型名称不能为空")
    if any(character.isspace() for character in value):
        raise ValueError("模型名称不能包含空格")
    return value


class AIProviderSettingsResponse(BaseModel):
    provider: AIProviderName
    base_url: str
    model: str
    request_timeout_seconds: int
    max_retries: int
    configured: bool
    api_key_configured: bool
    data_retention: Literal["zero_data_retention", "provider_policy"]
    source: Literal["database", "environment", "none"]
    updated_at: datetime | None = None


class UpdateAIProviderSettingsRequest(BaseModel):
    provider: AIProviderName = "openai"
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=4096)
    request_timeout_seconds: int = Field(
        default=DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
        ge=10,
        le=180,
    )
    max_retries: int = Field(default=DEFAULT_AI_MAX_RETRIES, ge=0, le=4)

    _clean_base_url = field_validator("base_url")(clean_base_url)
    _clean_model = field_validator("model")(clean_model)

    @field_validator("api_key")
    @classmethod
    def clean_api_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class TestAIProviderSettingsRequest(UpdateAIProviderSettingsRequest):
    pass


class TestAIProviderSettingsResponse(BaseModel):
    success: bool
    model: str
    message: str
