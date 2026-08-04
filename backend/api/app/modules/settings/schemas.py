from datetime import datetime
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator


DEFAULT_AI_REQUEST_TIMEOUT_SECONDS = 90
DEFAULT_AI_MAX_RETRIES = 1


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
    base_url: str
    model: str
    request_timeout_seconds: int
    max_retries: int
    configured: bool
    api_key_configured: bool
    source: Literal["database", "environment", "none"]
    updated_at: datetime | None = None


class UpdateAIProviderSettingsRequest(BaseModel):
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=4096)
    request_timeout_seconds: int = Field(
        default=DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
        ge=10,
        le=180,
    )
    max_retries: int = Field(default=DEFAULT_AI_MAX_RETRIES, ge=0, le=2)

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


SettingsSource = Literal["database", "environment", "none"]


def clean_required_text(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("不能为空")
    return value


def clean_optional_secret(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def clean_customer_id(value: str) -> str:
    normalized = re.sub(r"[\s-]", "", value)
    if not normalized.isdigit() or len(normalized) != 10:
        raise ValueError("客户 ID 必须是 10 位数字")
    return normalized


def clean_optional_customer_id(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return clean_customer_id(value)


class GoogleAdsSettingsResponse(BaseModel):
    client_id: str
    customer_id: str
    login_customer_id: str | None
    configured: bool
    developer_token_configured: bool
    client_secret_configured: bool
    refresh_token_configured: bool
    source: SettingsSource
    updated_at: datetime | None = None


class UpdateGoogleAdsSettingsRequest(BaseModel):
    developer_token: str | None = Field(default=None, max_length=4096)
    client_id: str = Field(min_length=1, max_length=1024)
    client_secret: str | None = Field(default=None, max_length=4096)
    refresh_token: str | None = Field(default=None, max_length=8192)
    customer_id: str = Field(min_length=1, max_length=64)
    login_customer_id: str | None = Field(default=None, max_length=64)

    _clean_client_id = field_validator("client_id")(clean_required_text)
    _clean_customer_id = field_validator("customer_id")(clean_customer_id)
    _clean_login_customer_id = field_validator("login_customer_id")(
        clean_optional_customer_id
    )
    _clean_secrets = field_validator(
        "developer_token",
        "client_secret",
        "refresh_token",
    )(clean_optional_secret)


class TestGoogleAdsSettingsRequest(UpdateGoogleAdsSettingsRequest):
    pass


class TestGoogleAdsSettingsResponse(BaseModel):
    success: bool
    customer_id: str
    message: str


class DataForSEOSettingsResponse(BaseModel):
    login: str
    configured: bool
    password_configured: bool
    source: SettingsSource
    updated_at: datetime | None = None


class UpdateDataForSEOSettingsRequest(BaseModel):
    login: str = Field(min_length=1, max_length=320)
    password: str | None = Field(default=None, max_length=4096)

    _clean_login = field_validator("login")(clean_required_text)
    _clean_password = field_validator("password")(clean_optional_secret)


class TestDataForSEOSettingsRequest(UpdateDataForSEOSettingsRequest):
    pass


class TestDataForSEOSettingsResponse(BaseModel):
    success: bool
    message: str
    balance: float | None = None
