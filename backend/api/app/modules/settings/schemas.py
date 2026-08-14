from datetime import date, datetime
import re
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator


DEFAULT_AI_REQUEST_TIMEOUT_SECONDS = 90
DEFAULT_AI_MAX_RETRIES = 4
AIProviderName = Literal["openai", "anthropic", "openrouter"]
AIReasoningEffort = Literal["low", "medium", "high"]
AIAPIProtocol = Literal["chat_completions", "responses"]


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


def clean_optional_model(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return clean_model(value)


class AIProviderSettingsResponse(BaseModel):
    provider: AIProviderName
    api_protocol: AIAPIProtocol = "chat_completions"
    base_url: str
    model: str
    business_model: str | None = None
    keyword_model: str | None = None
    content_model: str | None = None
    agent_model: str | None = None
    reasoning_effort: AIReasoningEffort = "medium"
    business_reasoning_effort: AIReasoningEffort | None = None
    keyword_reasoning_effort: AIReasoningEffort | None = None
    content_reasoning_effort: AIReasoningEffort | None = None
    agent_reasoning_effort: AIReasoningEffort | None = None
    request_timeout_seconds: int
    max_retries: int
    configured: bool
    api_key_configured: bool
    data_retention: Literal["zero_data_retention", "provider_policy"]
    source: Literal["database", "environment", "none"]
    updated_at: datetime | None = None


class UpdateAIProviderSettingsRequest(BaseModel):
    provider: AIProviderName = "openai"
    api_protocol: AIAPIProtocol = "chat_completions"
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    business_model: str | None = Field(default=None, max_length=200)
    keyword_model: str | None = Field(default=None, max_length=200)
    content_model: str | None = Field(default=None, max_length=200)
    agent_model: str | None = Field(default=None, max_length=200)
    reasoning_effort: AIReasoningEffort = "medium"
    business_reasoning_effort: AIReasoningEffort | None = None
    keyword_reasoning_effort: AIReasoningEffort | None = None
    content_reasoning_effort: AIReasoningEffort | None = None
    agent_reasoning_effort: AIReasoningEffort | None = None
    api_key: str | None = Field(default=None, max_length=4096)
    request_timeout_seconds: int = Field(
        default=DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
        ge=10,
        le=180,
    )
    max_retries: int = Field(default=DEFAULT_AI_MAX_RETRIES, ge=0, le=4)

    _clean_base_url = field_validator("base_url")(clean_base_url)
    _clean_model = field_validator("model")(clean_model)
    _clean_task_models = field_validator(
        "business_model",
        "keyword_model",
        "content_model",
        "agent_model",
    )(clean_optional_model)

    @model_validator(mode="before")
    @classmethod
    def infer_known_provider(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        base_url = value.get("base_url")
        if not isinstance(base_url, str):
            return value
        inferred = infer_provider(base_url)
        if not value.get("provider") or inferred != "openai":
            return {**value, "provider": inferred}
        return value

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
ConnectionStatus = Literal["connected", "disconnected"]


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


class GSCOAuthSettingsResponse(BaseModel):
    client_id: str
    configured: bool
    client_secret_configured: bool
    oauth_redirect_uri: str
    source: SettingsSource
    updated_at: datetime | None = None


class UpdateGSCOAuthSettingsRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=1024)
    client_secret: str | None = Field(default=None, max_length=4096)

    _clean_client_id = field_validator("client_id")(clean_required_text)
    _clean_client_secret = field_validator("client_secret")(clean_optional_secret)


class GSCConnectionResponse(BaseModel):
    oauth_configured: bool
    oauth_redirect_uri: str
    grant_connected: bool
    property_connected: bool
    site_url: str | None = None
    connected_account_email: str | None = None
    requires_reconnect: bool = False


class GSCOAuthStartRequest(BaseModel):
    callback_url: str = Field(min_length=1, max_length=2048)


class GSCOAuthStartResponse(BaseModel):
    authorization_url: str


class GSCSiteResponse(BaseModel):
    site_url: str
    permission_level: str


class GSCSiteListResponse(BaseModel):
    items: list[GSCSiteResponse] = Field(default_factory=list)


class GSCSelectSiteRequest(BaseModel):
    site_url: str = Field(min_length=1, max_length=2048)


class GSCPerformanceTotals(BaseModel):
    clicks: float = 0
    impressions: float = 0
    ctr: float = 0
    position: float = 0


class GSCPerformanceRange(BaseModel):
    start_date: date
    end_date: date
    previous_start_date: date
    previous_end_date: date


class GSCPerformanceDimensionRow(GSCPerformanceTotals):
    key: str


class GSCStrikingDistanceRow(BaseModel):
    query: str
    page: str
    clicks: float = 0
    impressions: float = 0
    position: float = 0


class GSCPerformanceReportResponse(BaseModel):
    site_url: str
    range: GSCPerformanceRange
    totals: GSCPerformanceTotals
    previous_totals: GSCPerformanceTotals
    striking_distance: list[GSCStrikingDistanceRow] = Field(default_factory=list)
    countries: list[GSCPerformanceDimensionRow] = Field(default_factory=list)


class GSCPerformanceTableResponse(BaseModel):
    dimension: Literal["query", "page"]
    page: int = Field(ge=1)
    page_size: Literal[25, 50, 100]
    has_next_page: bool
    rows: list[GSCPerformanceDimensionRow] = Field(default_factory=list)


class GSCPerformanceExportResponse(BaseModel):
    dimension: Literal["query", "page"]
    rows: list[GSCPerformanceDimensionRow] = Field(default_factory=list)


def clean_service_url(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("地址必须是有效的 HTTP 或 HTTPS 地址")
    if parsed.username or parsed.password:
        raise ValueError("地址不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise ValueError("地址不能包含查询参数或片段")
    return value


def clean_gsc_property(value: str) -> str:
    value = value.strip().rstrip("/")
    if value.startswith("sc-domain:") and len(value) > len("sc-domain:"):
        return value
    return clean_service_url(value)


class GSCServiceAccountConnectionResponse(BaseModel):
    property_url: str
    service_account_email: str
    private_key_configured: bool
    status: ConnectionStatus
    verified_at: datetime | None = None


class UpdateGSCServiceAccountConnectionRequest(BaseModel):
    property_url: str = Field(min_length=1, max_length=2048)
    service_account_email: str = Field(min_length=3, max_length=320)
    private_key: str | None = Field(default=None, max_length=16384)

    _clean_property_url = field_validator("property_url")(clean_gsc_property)
    _clean_email = field_validator("service_account_email")(clean_required_text)
    _clean_private_key = field_validator("private_key")(clean_optional_secret)


class TestGSCServiceAccountConnectionRequest(UpdateGSCServiceAccountConnectionRequest):
    pass


class TestGSCServiceAccountConnectionResponse(BaseModel):
    success: bool
    property_url: str
    message: str


class WordPressConnectionResponse(BaseModel):
    site_url: str
    username: str
    application_password_configured: bool
    verified_user: str | None = None
    status: ConnectionStatus
    verified_at: datetime | None = None


class UpdateWordPressConnectionRequest(BaseModel):
    site_url: str = Field(min_length=1, max_length=2048)
    username: str = Field(min_length=1, max_length=320)
    application_password: str | None = Field(default=None, max_length=4096)

    _clean_site_url = field_validator("site_url")(clean_service_url)
    _clean_username = field_validator("username")(clean_required_text)
    _clean_password = field_validator("application_password")(clean_optional_secret)


class TestWordPressConnectionRequest(UpdateWordPressConnectionRequest):
    pass


class TestWordPressConnectionResponse(BaseModel):
    success: bool
    site_url: str
    verified_user: str
    message: str
