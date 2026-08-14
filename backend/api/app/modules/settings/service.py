from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Literal, Protocol

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.agent.security import register_sensitive_values
from app.modules.projects.models import Project
from app.modules.settings.models import AIProviderSetting
from app.modules.agent.providers import ProviderConfig, ProviderError, build_provider
from app.modules.settings.provider_privacy import data_retention_mode
from app.modules.settings.schemas import (
    AIAPIProtocol,
    AIReasoningEffort,
    AIProviderSettingsResponse,
    DEFAULT_AI_MAX_RETRIES,
    DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
    AIProviderName,
    TestAIProviderSettingsRequest,
    TestAIProviderSettingsResponse,
    UpdateAIProviderSettingsRequest,
)


class AISettingsProjectNotFoundError(Exception):
    pass


class AISettingsEncryptionUnavailableError(Exception):
    pass


class AISettingsPlaintextMigrationRequiredError(Exception):
    pass


class AIProviderNotConfiguredError(Exception):
    pass


class AIProviderConnectionError(Exception):
    pass


@dataclass(frozen=True)
class AIProviderSettingsRecord:
    base_url: str
    api_key: str = field(repr=False)
    provider: AIProviderName = "openai"
    api_protocol: AIAPIProtocol = "chat_completions"
    model: str = ""
    business_model: str | None = None
    keyword_model: str | None = None
    content_model: str | None = None
    agent_model: str | None = None
    reasoning_effort: AIReasoningEffort = "medium"
    business_reasoning_effort: AIReasoningEffort | None = None
    keyword_reasoning_effort: AIReasoningEffort | None = None
    content_reasoning_effort: AIReasoningEffort | None = None
    agent_reasoning_effort: AIReasoningEffort | None = None
    request_timeout_seconds: int = DEFAULT_AI_REQUEST_TIMEOUT_SECONDS
    max_retries: int = DEFAULT_AI_MAX_RETRIES
    updated_at: datetime | None = None

    def for_task(
        self, task: Literal["business", "keyword", "content", "agent"]
    ) -> AIProviderSettingsRecord:
        model_override = {
            "business": self.business_model,
            "keyword": self.keyword_model,
            "content": self.content_model,
            "agent": self.agent_model,
        }[task]
        effort_override = {
            "business": self.business_reasoning_effort,
            "keyword": self.keyword_reasoning_effort,
            "content": self.content_reasoning_effort,
            "agent": self.agent_reasoning_effort,
        }[task]
        return replace(
            self,
            model=model_override or self.model,
            reasoning_effort=effort_override or self.reasoning_effort,
        )


class AISettingsRepository(Protocol):
    async def project_exists(self, organization_id: str, project_id: str) -> bool: ...

    async def get(
        self,
        organization_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> AIProviderSettingsRecord | None: ...

    async def upsert(
        self,
        organization_id: str,
        record: AIProviderSettingsRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> AIProviderSettingsRecord: ...


class SQLAlchemyAISettingsRepository:
    _PLAINTEXT_PREFIX = b"plaintext:v1:"

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project.id).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            )
            return project is not None

    async def get(
        self,
        organization_id: str,
        encryption_key: str | None,
        allow_plaintext: bool = True,
    ) -> AIProviderSettingsRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        AIProviderSetting.base_url,
                        AIProviderSetting.provider,
                        AIProviderSetting.api_protocol,
                        AIProviderSetting.api_key_encrypted,
                        AIProviderSetting.model,
                        AIProviderSetting.business_model,
                        AIProviderSetting.keyword_model,
                        AIProviderSetting.content_model,
                        AIProviderSetting.agent_model,
                        AIProviderSetting.reasoning_effort,
                        AIProviderSetting.business_reasoning_effort,
                        AIProviderSetting.keyword_reasoning_effort,
                        AIProviderSetting.content_reasoning_effort,
                        AIProviderSetting.agent_reasoning_effort,
                        AIProviderSetting.request_timeout_seconds,
                        AIProviderSetting.max_retries,
                        AIProviderSetting.updated_at,
                    ).where(AIProviderSetting.organization_id == organization_id)
                )
            ).one_or_none()
            if row is None:
                return None
            api_key_bytes = bytes(row.api_key_encrypted)
            if api_key_bytes.startswith(self._PLAINTEXT_PREFIX):
                if not allow_plaintext:
                    raise AISettingsPlaintextMigrationRequiredError
                api_key = api_key_bytes.removeprefix(self._PLAINTEXT_PREFIX).decode("utf-8")
            elif encryption_key:
                api_key = await session.scalar(
                    select(
                        func.pgp_sym_decrypt(
                            AIProviderSetting.api_key_encrypted,
                            encryption_key,
                        )
                    ).where(AIProviderSetting.organization_id == organization_id)
                )
            else:
                raise AISettingsEncryptionUnavailableError
            return AIProviderSettingsRecord(
                provider=row.provider,
                api_protocol=row.api_protocol,
                base_url=row.base_url,
                api_key=api_key,
                model=row.model,
                business_model=row.business_model,
                keyword_model=row.keyword_model,
                content_model=row.content_model,
                agent_model=row.agent_model,
                reasoning_effort=row.reasoning_effort,
                business_reasoning_effort=row.business_reasoning_effort,
                keyword_reasoning_effort=row.keyword_reasoning_effort,
                content_reasoning_effort=row.content_reasoning_effort,
                agent_reasoning_effort=row.agent_reasoning_effort,
                request_timeout_seconds=row.request_timeout_seconds,
                max_retries=row.max_retries,
                updated_at=row.updated_at,
            )

    async def upsert(
        self,
        organization_id: str,
        record: AIProviderSettingsRecord,
        encryption_key: str | None,
        allow_plaintext: bool = True,
    ) -> AIProviderSettingsRecord:
        if not encryption_key and not allow_plaintext:
            raise AISettingsEncryptionUnavailableError
        async with self.sessions() as session:
            api_key_expression = (
                "pgp_sym_encrypt(:api_key, :encryption_key, "
                "'cipher-algo=aes256, compress-algo=1')"
                if encryption_key
                else ":api_key_plaintext"
            )
            await session.execute(
                text(
                    f"""
                    INSERT INTO ai_provider_settings (
                        organization_id,
                        provider,
                        api_protocol,
                        base_url,
                        api_key_encrypted,
                        model,
                        business_model,
                        keyword_model,
                        content_model,
                        agent_model,
                        reasoning_effort,
                        business_reasoning_effort,
                        keyword_reasoning_effort,
                        content_reasoning_effort,
                        agent_reasoning_effort,
                        request_timeout_seconds,
                        max_retries
                    )
                    VALUES (
                        :organization_id,
                        :provider,
                        :api_protocol,
                        :base_url,
                        {api_key_expression},
                        :model,
                        :business_model,
                        :keyword_model,
                        :content_model,
                        :agent_model,
                        :reasoning_effort,
                        :business_reasoning_effort,
                        :keyword_reasoning_effort,
                        :content_reasoning_effort,
                        :agent_reasoning_effort,
                        :request_timeout_seconds,
                        :max_retries
                    )
                    ON CONFLICT (organization_id) DO UPDATE SET
                        base_url = EXCLUDED.base_url,
                        provider = EXCLUDED.provider,
                        api_protocol = EXCLUDED.api_protocol,
                        api_key_encrypted = EXCLUDED.api_key_encrypted,
                        model = EXCLUDED.model,
                        business_model = EXCLUDED.business_model,
                        keyword_model = EXCLUDED.keyword_model,
                        content_model = EXCLUDED.content_model,
                        agent_model = EXCLUDED.agent_model,
                        reasoning_effort = EXCLUDED.reasoning_effort,
                        business_reasoning_effort = EXCLUDED.business_reasoning_effort,
                        keyword_reasoning_effort = EXCLUDED.keyword_reasoning_effort,
                        content_reasoning_effort = EXCLUDED.content_reasoning_effort,
                        agent_reasoning_effort = EXCLUDED.agent_reasoning_effort,
                        request_timeout_seconds = EXCLUDED.request_timeout_seconds,
                        max_retries = EXCLUDED.max_retries,
                        updated_at = now()
                    """
                ),
                {
                    "organization_id": organization_id,
                    "provider": record.provider,
                    "api_protocol": record.api_protocol,
                    "base_url": record.base_url,
                    "api_key": record.api_key,
                    "encryption_key": encryption_key,
                    "api_key_plaintext": self._PLAINTEXT_PREFIX + record.api_key.encode("utf-8"),
                    "model": record.model,
                    "business_model": record.business_model,
                    "keyword_model": record.keyword_model,
                    "content_model": record.content_model,
                    "agent_model": record.agent_model,
                    "reasoning_effort": record.reasoning_effort,
                    "business_reasoning_effort": record.business_reasoning_effort,
                    "keyword_reasoning_effort": record.keyword_reasoning_effort,
                    "content_reasoning_effort": record.content_reasoning_effort,
                    "agent_reasoning_effort": record.agent_reasoning_effort,
                    "request_timeout_seconds": record.request_timeout_seconds,
                    "max_retries": record.max_retries,
                },
            )
            await session.commit()
        saved = await self.get(organization_id, encryption_key, allow_plaintext)
        if saved is None:
            raise RuntimeError("AI provider settings were not saved")
        return saved


class AIConnectionTester(Protocol):
    async def test(
        self,
        provider: AIProviderName,
        api_protocol: AIAPIProtocol,
        base_url: str,
        api_key: str,
        model: str,
        reasoning_effort: AIReasoningEffort,
        request_timeout_seconds: int,
    ) -> None: ...


class ProviderConnectionTester:
    async def test(
        self,
        provider: AIProviderName,
        api_protocol: AIAPIProtocol,
        base_url: str,
        api_key: str,
        model: str,
        reasoning_effort: AIReasoningEffort,
        request_timeout_seconds: int,
    ) -> None:
        try:
            await build_provider(ProviderConfig(
                provider=provider,
                api_protocol=api_protocol,
                base_url=base_url,
                api_key=api_key,
                model=model,
                timeout_seconds=request_timeout_seconds,
                max_retries=0,
                reasoning_effort=reasoning_effort,
            )).test_connection()
        except ProviderError as exc:
            raise AIProviderConnectionError(str(exc)) from exc


class AISettingsService:
    def __init__(
        self,
        settings: Settings,
        repository: AISettingsRepository,
        connection_tester: AIConnectionTester,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.connection_tester = connection_tester

    async def get(self, project_id: str) -> AIProviderSettingsResponse:
        await self._ensure_project(project_id)
        return await self.get_platform()

    async def get_platform(self) -> AIProviderSettingsResponse:
        record, source = await self._effective_record()
        return settings_response(record, source)

    async def effective_record(self) -> AIProviderSettingsRecord:
        return await self.effective_record_for_organization(
            self.settings.default_organization_id
        )

    async def effective_record_for_organization(
        self, organization_id: str
    ) -> AIProviderSettingsRecord:
        record, _ = await self._effective_record_for_organization(organization_id)
        if record is None or not (record.base_url and record.api_key and record.model):
            raise AIProviderNotConfiguredError("请先在设置中配置可用的 AI 模型")
        return record

    async def update(
        self,
        project_id: str,
        request: UpdateAIProviderSettingsRequest,
    ) -> AIProviderSettingsResponse:
        await self._ensure_project(project_id)
        return await self.update_platform(request)

    async def update_platform(
        self,
        request: UpdateAIProviderSettingsRequest,
    ) -> AIProviderSettingsResponse:
        encryption_key = self._encryption_key()
        allow_plaintext = self._allow_plaintext_storage()
        if not encryption_key and not allow_plaintext:
            raise AISettingsEncryptionUnavailableError
        current = None
        if request.api_key is None:
            current, _ = await self._effective_record()
        api_key = request.api_key or (current.api_key if current is not None else "")
        if not api_key:
            raise AIProviderNotConfiguredError("请填写 API 密钥")
        register_sensitive_values((api_key,))
        saved = await self.repository.upsert(
            self.settings.default_organization_id,
            AIProviderSettingsRecord(
                provider=request.provider,
                api_protocol=request.api_protocol,
                base_url=request.base_url,
                api_key=api_key,
                model=request.model,
                business_model=request.business_model,
                keyword_model=request.keyword_model,
                content_model=request.content_model,
                agent_model=request.agent_model,
                reasoning_effort=request.reasoning_effort,
                business_reasoning_effort=request.business_reasoning_effort,
                keyword_reasoning_effort=request.keyword_reasoning_effort,
                content_reasoning_effort=request.content_reasoning_effort,
                agent_reasoning_effort=request.agent_reasoning_effort,
                request_timeout_seconds=request.request_timeout_seconds,
                max_retries=request.max_retries,
            ),
            encryption_key,
            allow_plaintext,
        )
        return settings_response(saved, "database")

    async def test_connection(
        self,
        project_id: str,
        request: TestAIProviderSettingsRequest,
    ) -> TestAIProviderSettingsResponse:
        await self._ensure_project(project_id)
        return await self.test_platform_connection(request)

    async def test_platform_connection(
        self,
        request: TestAIProviderSettingsRequest,
    ) -> TestAIProviderSettingsResponse:
        current = None
        if request.api_key is None:
            current, _ = await self._effective_record()
        api_key = request.api_key or (current.api_key if current is not None else "")
        if not api_key:
            raise AIProviderNotConfiguredError("请填写 API 密钥")
        register_sensitive_values((api_key,))
        model_efforts = dict.fromkeys((
            (request.model, request.reasoning_effort),
            (
                request.business_model,
                request.business_reasoning_effort or request.reasoning_effort,
            ),
            (
                request.keyword_model,
                request.keyword_reasoning_effort or request.reasoning_effort,
            ),
            (
                request.content_model,
                request.content_reasoning_effort or request.reasoning_effort,
            ),
            (
                request.agent_model,
                request.agent_reasoning_effort or request.reasoning_effort,
            ),
        ))
        configured_model_efforts = [
            (model, effort)
            for model, effort in model_efforts
            if model is not None
        ]
        for model, effort in configured_model_efforts:
            await self.connection_tester.test(
                request.provider,
                request.api_protocol,
                request.base_url,
                api_key,
                model,
                effort,
                request.request_timeout_seconds,
            )
        return TestAIProviderSettingsResponse(
            success=True,
            model=request.model,
            message=f"连接成功，已验证 {len(configured_model_efforts)} 个模型配置",
        )

    async def _ensure_project(self, project_id: str) -> None:
        if not await self.repository.project_exists(
            self.settings.default_organization_id,
            project_id,
        ):
            raise AISettingsProjectNotFoundError

    async def _effective_record(
        self,
    ) -> tuple[AIProviderSettingsRecord | None, str]:
        return await self._effective_record_for_organization(
            self.settings.default_organization_id
        )

    async def _effective_record_for_organization(
        self, organization_id: str
    ) -> tuple[AIProviderSettingsRecord | None, str]:
        encryption_key = self._encryption_key()
        stored = await self.repository.get(
            organization_id,
            encryption_key,
            self._allow_plaintext_storage(),
        )
        if stored is not None:
            register_sensitive_values((stored.api_key,))
            return stored, "database"
        environment = AIProviderSettingsRecord(
            provider=self.settings.business_profile_ai_provider,
            api_protocol=self.settings.business_profile_ai_api_protocol,
            base_url=(self.settings.business_profile_ai_base_url or "").strip().rstrip("/"),
            api_key=(self.settings.business_profile_ai_api_key or "").strip(),
            model=self.settings.business_profile_ai_model.strip(),
            request_timeout_seconds=parse_ai_timeout_seconds(
                self.settings.business_profile_ai_timeout
            ),
            max_retries=min(
                max(self.settings.business_profile_ai_max_retries, 0),
                4,
            ),
        )
        if environment.base_url or environment.api_key or environment.model:
            register_sensitive_values((environment.api_key,))
            return environment, "environment"
        return None, "none"

    def _encryption_key(self) -> str | None:
        encryption_key = (self.settings.ai_settings_encryption_key or "").strip()
        return encryption_key or None

    def _allow_plaintext_storage(self) -> bool:
        return (
            self.settings.ai_settings_allow_plaintext
            or self.settings.app_env != "production"
        )


def settings_response(
    record: AIProviderSettingsRecord | None,
    source: str,
) -> AIProviderSettingsResponse:
    if record is None:
        return AIProviderSettingsResponse(
            provider="openai",
            api_protocol="chat_completions",
            base_url="",
            model="",
            business_model=None,
            keyword_model=None,
            content_model=None,
            agent_model=None,
            reasoning_effort="medium",
            business_reasoning_effort=None,
            keyword_reasoning_effort=None,
            content_reasoning_effort=None,
            agent_reasoning_effort=None,
            request_timeout_seconds=DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
            max_retries=DEFAULT_AI_MAX_RETRIES,
            configured=False,
            api_key_configured=False,
            data_retention="provider_policy",
            source="none",
        )
    return AIProviderSettingsResponse(
        provider=record.provider,
        api_protocol=record.api_protocol,
        base_url=record.base_url,
        model=record.model,
        business_model=record.business_model,
        keyword_model=record.keyword_model,
        content_model=record.content_model,
        agent_model=record.agent_model,
        reasoning_effort=record.reasoning_effort,
        business_reasoning_effort=record.business_reasoning_effort,
        keyword_reasoning_effort=record.keyword_reasoning_effort,
        content_reasoning_effort=record.content_reasoning_effort,
        agent_reasoning_effort=record.agent_reasoning_effort,
        request_timeout_seconds=record.request_timeout_seconds,
        max_retries=record.max_retries,
        configured=bool(record.base_url and record.api_key and record.model),
        api_key_configured=bool(record.api_key),
        data_retention=data_retention_mode(record.base_url),
        source=source,
        updated_at=record.updated_at,
    )


_AI_TIMEOUT_PATTERN = re.compile(r"^(\d+)(ms|s|m)?$")


def parse_ai_timeout_seconds(value: str) -> int:
    match = _AI_TIMEOUT_PATTERN.fullmatch(value.strip().lower())
    if match is None:
        return DEFAULT_AI_REQUEST_TIMEOUT_SECONDS

    amount = int(match.group(1))
    unit = match.group(2) or "s"
    if unit == "ms":
        seconds = (amount + 999) // 1000
    elif unit == "m":
        seconds = amount * 60
    else:
        seconds = amount
    return min(max(seconds, 10), 180)


def build_ai_settings_service() -> AISettingsService:
    settings = get_settings()
    return AISettingsService(
        settings=settings,
        repository=SQLAlchemyAISettingsRepository(session_factory),
        connection_tester=ProviderConnectionTester(),
    )
