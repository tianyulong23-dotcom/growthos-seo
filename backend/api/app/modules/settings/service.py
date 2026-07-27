from __future__ import annotations

import asyncio
import json
import re
import socket
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.projects.models import Project
from app.modules.settings.models import AIProviderSetting
from app.modules.settings.schemas import (
    AIProviderSettingsResponse,
    DEFAULT_AI_MAX_RETRIES,
    DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
    TestAIProviderSettingsRequest,
    TestAIProviderSettingsResponse,
    UpdateAIProviderSettingsRequest,
)


class AISettingsProjectNotFoundError(Exception):
    pass


class AISettingsEncryptionUnavailableError(Exception):
    pass


class AIProviderNotConfiguredError(Exception):
    pass


class AIProviderConnectionError(Exception):
    pass


@dataclass(frozen=True)
class AIProviderSettingsRecord:
    base_url: str
    api_key: str = field(repr=False)
    model: str = ""
    request_timeout_seconds: int = DEFAULT_AI_REQUEST_TIMEOUT_SECONDS
    max_retries: int = DEFAULT_AI_MAX_RETRIES
    updated_at: datetime | None = None


class AISettingsRepository(Protocol):
    async def project_exists(self, organization_id: str, project_id: str) -> bool: ...

    async def get(
        self,
        organization_id: str,
        encryption_key: str,
    ) -> AIProviderSettingsRecord | None: ...

    async def upsert(
        self,
        organization_id: str,
        record: AIProviderSettingsRecord,
        encryption_key: str,
    ) -> AIProviderSettingsRecord: ...


class SQLAlchemyAISettingsRepository:
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
        encryption_key: str,
    ) -> AIProviderSettingsRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        AIProviderSetting.base_url,
                        func.pgp_sym_decrypt(
                            AIProviderSetting.api_key_encrypted,
                            encryption_key,
                        ).label("api_key"),
                        AIProviderSetting.model,
                        AIProviderSetting.request_timeout_seconds,
                        AIProviderSetting.max_retries,
                        AIProviderSetting.updated_at,
                    ).where(AIProviderSetting.organization_id == organization_id)
                )
            ).one_or_none()
            if row is None:
                return None
            return AIProviderSettingsRecord(
                base_url=row.base_url,
                api_key=row.api_key,
                model=row.model,
                request_timeout_seconds=row.request_timeout_seconds,
                max_retries=row.max_retries,
                updated_at=row.updated_at,
            )

    async def upsert(
        self,
        organization_id: str,
        record: AIProviderSettingsRecord,
        encryption_key: str,
    ) -> AIProviderSettingsRecord:
        async with self.sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO ai_provider_settings (
                        organization_id,
                        base_url,
                        api_key_encrypted,
                        model,
                        request_timeout_seconds,
                        max_retries
                    )
                    VALUES (
                        :organization_id,
                        :base_url,
                        pgp_sym_encrypt(
                            :api_key,
                            :encryption_key,
                            'cipher-algo=aes256, compress-algo=1'
                        ),
                        :model,
                        :request_timeout_seconds,
                        :max_retries
                    )
                    ON CONFLICT (organization_id) DO UPDATE SET
                        base_url = EXCLUDED.base_url,
                        api_key_encrypted = EXCLUDED.api_key_encrypted,
                        model = EXCLUDED.model,
                        request_timeout_seconds = EXCLUDED.request_timeout_seconds,
                        max_retries = EXCLUDED.max_retries,
                        updated_at = now()
                    """
                ),
                {
                    "organization_id": organization_id,
                    "base_url": record.base_url,
                    "api_key": record.api_key,
                    "encryption_key": encryption_key,
                    "model": record.model,
                    "request_timeout_seconds": record.request_timeout_seconds,
                    "max_retries": record.max_retries,
                },
            )
            await session.commit()
        saved = await self.get(organization_id, encryption_key)
        if saved is None:
            raise RuntimeError("AI provider settings were not saved")
        return saved


class AIConnectionTester(Protocol):
    async def test(
        self,
        base_url: str,
        api_key: str,
        model: str,
        request_timeout_seconds: int,
    ) -> None: ...


class OpenAICompatibleConnectionTester:
    async def test(
        self,
        base_url: str,
        api_key: str,
        model: str,
        request_timeout_seconds: int,
    ) -> None:
        await asyncio.to_thread(
            self._test_sync,
            base_url,
            api_key,
            model,
            request_timeout_seconds,
        )

    def _test_sync(
        self,
        base_url: str,
        api_key: str,
        model: str,
        request_timeout_seconds: int,
    ) -> None:
        endpoint = (
            base_url if base_url.endswith("/chat/completions") else base_url + "/chat/completions"
        )
        body = json.dumps(
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": "Return only JSON."},
                    {"role": "user", "content": 'Return {"ok":true}.'},
                ],
                "response_format": {"type": "json_object"},
            }
        ).encode()
        request = Request(
            endpoint,
            data=body,
            headers={
                "Authorization": "Bearer " + api_key,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=request_timeout_seconds) as response:
                response_body = response.read(1024 * 1024 + 1)
        except HTTPError as exc:
            if exc.code in {401, 403}:
                raise AIProviderConnectionError("API 密钥无效或无权使用该模型") from exc
            if exc.code == 404:
                raise AIProviderConnectionError("接口地址不支持 /chat/completions") from exc
            if exc.code == 429:
                raise AIProviderConnectionError("模型服务请求过多，请稍后再试") from exc
            raise AIProviderConnectionError(f"模型服务返回 HTTP {exc.code}") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise AIProviderConnectionError("连接模型服务超时") from exc
        except (URLError, OSError) as exc:
            raise AIProviderConnectionError("无法连接模型服务") from exc

        if len(response_body) > 1024 * 1024:
            raise AIProviderConnectionError("模型服务响应过大")
        try:
            completion = json.loads(response_body)
            content = completion["choices"][0]["message"]["content"].strip()
            content = content.removeprefix("```json").removeprefix("```")
            content = content.removesuffix("```").strip()
            if json.loads(content).get("ok") is not True:
                raise ValueError("unexpected test response")
        except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise AIProviderConnectionError("模型响应格式与当前项目不兼容") from exc


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
        record, source = await self._effective_record()
        return settings_response(record, source)

    async def update(
        self,
        project_id: str,
        request: UpdateAIProviderSettingsRequest,
    ) -> AIProviderSettingsResponse:
        await self._ensure_project(project_id)
        current, _ = await self._effective_record()
        api_key = request.api_key or (current.api_key if current is not None else "")
        if not api_key:
            raise AIProviderNotConfiguredError("请填写 API 密钥")
        encryption_key = self._encryption_key()
        saved = await self.repository.upsert(
            self.settings.default_organization_id,
            AIProviderSettingsRecord(
                base_url=request.base_url,
                api_key=api_key,
                model=request.model,
                request_timeout_seconds=request.request_timeout_seconds,
                max_retries=request.max_retries,
            ),
            encryption_key,
        )
        return settings_response(saved, "database")

    async def test_connection(
        self,
        project_id: str,
        request: TestAIProviderSettingsRequest,
    ) -> TestAIProviderSettingsResponse:
        await self._ensure_project(project_id)
        current, _ = await self._effective_record()
        api_key = request.api_key or (current.api_key if current is not None else "")
        if not api_key:
            raise AIProviderNotConfiguredError("请填写 API 密钥")
        await self.connection_tester.test(
            request.base_url,
            api_key,
            request.model,
            request.request_timeout_seconds,
        )
        return TestAIProviderSettingsResponse(
            success=True,
            model=request.model,
            message="连接成功，模型响应格式正常",
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
        encryption_key = self.settings.ai_settings_encryption_key
        if encryption_key:
            stored = await self.repository.get(
                self.settings.default_organization_id,
                encryption_key,
            )
            if stored is not None:
                return stored, "database"
        environment = AIProviderSettingsRecord(
            base_url=(self.settings.business_profile_ai_base_url or "").strip().rstrip("/"),
            api_key=(self.settings.business_profile_ai_api_key or "").strip(),
            model=self.settings.business_profile_ai_model.strip(),
            request_timeout_seconds=parse_ai_timeout_seconds(
                self.settings.business_profile_ai_timeout
            ),
            max_retries=min(
                max(self.settings.business_profile_ai_max_retries, 0),
                2,
            ),
        )
        if environment.base_url or environment.api_key or environment.model:
            return environment, "environment"
        return None, "none"

    def _encryption_key(self) -> str:
        encryption_key = (self.settings.ai_settings_encryption_key or "").strip()
        if not encryption_key:
            raise AISettingsEncryptionUnavailableError
        return encryption_key


def settings_response(
    record: AIProviderSettingsRecord | None,
    source: str,
) -> AIProviderSettingsResponse:
    if record is None:
        return AIProviderSettingsResponse(
            base_url="",
            model="",
            request_timeout_seconds=DEFAULT_AI_REQUEST_TIMEOUT_SECONDS,
            max_retries=DEFAULT_AI_MAX_RETRIES,
            configured=False,
            api_key_configured=False,
            source="none",
        )
    return AIProviderSettingsResponse(
        base_url=record.base_url,
        model=record.model,
        request_timeout_seconds=record.request_timeout_seconds,
        max_retries=record.max_retries,
        configured=bool(record.base_url and record.api_key and record.model),
        api_key_configured=bool(record.api_key),
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
        connection_tester=OpenAICompatibleConnectionTester(),
    )
