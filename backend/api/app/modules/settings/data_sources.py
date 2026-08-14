from __future__ import annotations

import asyncio
import base64
import json
import socket
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.agent.security import register_sensitive_values
from app.modules.projects.models import Project
from app.modules.settings.models import (
    DataForSEOProviderSetting,
    GoogleAdsProviderSetting,
)
from app.modules.settings.schemas import (
    DataForSEOSettingsResponse,
    GoogleAdsSettingsResponse,
    TestDataForSEOSettingsRequest,
    TestDataForSEOSettingsResponse,
    TestGoogleAdsSettingsRequest,
    TestGoogleAdsSettingsResponse,
    UpdateDataForSEOSettingsRequest,
    UpdateGoogleAdsSettingsRequest,
)

MAX_RESPONSE_BYTES = 1024 * 1024
CONNECTION_TEST_TIMEOUT_SECONDS = 20
PLAINTEXT_SECRET_PREFIX = b"plaintext:v1:"


class DataSourceProjectNotFoundError(Exception):
    pass


class DataSourceEncryptionUnavailableError(Exception):
    pass


class DataSourceNotConfiguredError(Exception):
    pass


class DataSourceConnectionError(Exception):
    pass


@dataclass(frozen=True)
class GoogleAdsSettingsRecord:
    developer_token: str = field(repr=False)
    client_id: str = ""
    client_secret: str = field(default="", repr=False)
    refresh_token: str = field(default="", repr=False)
    customer_id: str = ""
    login_customer_id: str | None = None
    updated_at: datetime | None = None

    @property
    def configured(self) -> bool:
        return all(
            (
                self.developer_token,
                self.client_id,
                self.client_secret,
                self.refresh_token,
                self.customer_id,
            )
        )


@dataclass(frozen=True)
class DataForSEOSettingsRecord:
    login: str
    password: str = field(repr=False)
    updated_at: datetime | None = None

    @property
    def configured(self) -> bool:
        return bool(self.login and self.password)


class DataSourceSettingsRepository(Protocol):
    async def project_exists(self, organization_id: str, project_id: str) -> bool: ...

    async def get_google_ads(
        self,
        organization_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GoogleAdsSettingsRecord | None: ...

    async def upsert_google_ads(
        self,
        organization_id: str,
        record: GoogleAdsSettingsRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GoogleAdsSettingsRecord: ...

    async def get_dataforseo(
        self,
        organization_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> DataForSEOSettingsRecord | None: ...

    async def upsert_dataforseo(
        self,
        organization_id: str,
        record: DataForSEOSettingsRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> DataForSEOSettingsRecord: ...


class SQLAlchemyDataSourceSettingsRepository:
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

    async def get_google_ads(
        self,
        organization_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GoogleAdsSettingsRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        GoogleAdsProviderSetting.developer_token_encrypted,
                        GoogleAdsProviderSetting.client_id,
                        GoogleAdsProviderSetting.client_secret_encrypted,
                        GoogleAdsProviderSetting.refresh_token_encrypted,
                        GoogleAdsProviderSetting.customer_id,
                        GoogleAdsProviderSetting.login_customer_id,
                        GoogleAdsProviderSetting.updated_at,
                    ).where(
                        GoogleAdsProviderSetting.organization_id == organization_id
                    )
                )
            ).one_or_none()
            if row is None:
                return None
            developer_token = await self._read_secret(
                session,
                GoogleAdsProviderSetting.developer_token_encrypted,
                GoogleAdsProviderSetting.organization_id == organization_id,
                row.developer_token_encrypted,
                encryption_key,
                allow_plaintext,
            )
            client_secret = await self._read_secret(
                session,
                GoogleAdsProviderSetting.client_secret_encrypted,
                GoogleAdsProviderSetting.organization_id == organization_id,
                row.client_secret_encrypted,
                encryption_key,
                allow_plaintext,
            )
            refresh_token = await self._read_secret(
                session,
                GoogleAdsProviderSetting.refresh_token_encrypted,
                GoogleAdsProviderSetting.organization_id == organization_id,
                row.refresh_token_encrypted,
                encryption_key,
                allow_plaintext,
            )
            return GoogleAdsSettingsRecord(
                developer_token=developer_token,
                client_id=row.client_id,
                client_secret=client_secret,
                refresh_token=refresh_token,
                customer_id=row.customer_id,
                login_customer_id=row.login_customer_id,
                updated_at=row.updated_at,
            )

    async def upsert_google_ads(
        self,
        organization_id: str,
        record: GoogleAdsSettingsRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GoogleAdsSettingsRecord:
        if not encryption_key and not allow_plaintext:
            raise DataSourceEncryptionUnavailableError
        secret_expression = self._secret_expression(encryption_key)
        async with self.sessions() as session:
            await session.execute(
                text(
                    f"""
                    INSERT INTO google_ads_provider_settings (
                        organization_id,
                        developer_token_encrypted,
                        client_id,
                        client_secret_encrypted,
                        refresh_token_encrypted,
                        customer_id,
                        login_customer_id
                    )
                    VALUES (
                        :organization_id,
                        {secret_expression.format(value='developer_token')},
                        :client_id,
                        {secret_expression.format(value='client_secret')},
                        {secret_expression.format(value='refresh_token')},
                        :customer_id,
                        :login_customer_id
                    )
                    ON CONFLICT (organization_id) DO UPDATE SET
                        developer_token_encrypted = EXCLUDED.developer_token_encrypted,
                        client_id = EXCLUDED.client_id,
                        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
                        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                        customer_id = EXCLUDED.customer_id,
                        login_customer_id = EXCLUDED.login_customer_id,
                        updated_at = now()
                    """
                ),
                {
                    "organization_id": organization_id,
                    "developer_token": record.developer_token,
                    "developer_token_plaintext": PLAINTEXT_SECRET_PREFIX
                    + record.developer_token.encode("utf-8"),
                    "client_id": record.client_id,
                    "client_secret": record.client_secret,
                    "client_secret_plaintext": PLAINTEXT_SECRET_PREFIX
                    + record.client_secret.encode("utf-8"),
                    "refresh_token": record.refresh_token,
                    "refresh_token_plaintext": PLAINTEXT_SECRET_PREFIX
                    + record.refresh_token.encode("utf-8"),
                    "customer_id": record.customer_id,
                    "login_customer_id": record.login_customer_id,
                    "encryption_key": encryption_key,
                },
            )
            await session.commit()
        saved = await self.get_google_ads(
            organization_id, encryption_key, allow_plaintext
        )
        if saved is None:
            raise RuntimeError("Google Ads settings were not saved")
        return saved

    async def get_dataforseo(
        self,
        organization_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> DataForSEOSettingsRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        DataForSEOProviderSetting.login,
                        DataForSEOProviderSetting.password_encrypted,
                        DataForSEOProviderSetting.updated_at,
                    ).where(
                        DataForSEOProviderSetting.organization_id == organization_id
                    )
                )
            ).one_or_none()
            if row is None:
                return None
            password = await self._read_secret(
                session,
                DataForSEOProviderSetting.password_encrypted,
                DataForSEOProviderSetting.organization_id == organization_id,
                row.password_encrypted,
                encryption_key,
                allow_plaintext,
            )
            return DataForSEOSettingsRecord(
                login=row.login,
                password=password,
                updated_at=row.updated_at,
            )

    async def upsert_dataforseo(
        self,
        organization_id: str,
        record: DataForSEOSettingsRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> DataForSEOSettingsRecord:
        if not encryption_key and not allow_plaintext:
            raise DataSourceEncryptionUnavailableError
        secret_expression = self._secret_expression(encryption_key).format(
            value="password"
        )
        async with self.sessions() as session:
            await session.execute(
                text(
                    f"""
                    INSERT INTO dataforseo_provider_settings (
                        organization_id,
                        login,
                        password_encrypted
                    )
                    VALUES (
                        :organization_id,
                        :login,
                        {secret_expression}
                    )
                    ON CONFLICT (organization_id) DO UPDATE SET
                        login = EXCLUDED.login,
                        password_encrypted = EXCLUDED.password_encrypted,
                        updated_at = now()
                    """
                ),
                {
                    "organization_id": organization_id,
                    "login": record.login,
                    "password": record.password,
                    "password_plaintext": PLAINTEXT_SECRET_PREFIX
                    + record.password.encode("utf-8"),
                    "encryption_key": encryption_key,
                },
            )
            await session.commit()
        saved = await self.get_dataforseo(
            organization_id, encryption_key, allow_plaintext
        )
        if saved is None:
            raise RuntimeError("DataForSEO settings were not saved")
        return saved

    @staticmethod
    def _secret_expression(encryption_key: str | None) -> str:
        if encryption_key:
            return (
                "pgp_sym_encrypt(:{value}, :encryption_key, "
                "'cipher-algo=aes256, compress-algo=1')"
            )
        return ":{value}_plaintext"

    @staticmethod
    async def _read_secret(
        session: AsyncSession,
        column: Any,
        predicate: Any,
        stored_value: bytes,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> str:
        value = bytes(stored_value)
        if value.startswith(PLAINTEXT_SECRET_PREFIX):
            if not allow_plaintext:
                raise DataSourceEncryptionUnavailableError
            return value.removeprefix(PLAINTEXT_SECRET_PREFIX).decode("utf-8")
        if not encryption_key:
            raise DataSourceEncryptionUnavailableError
        decrypted = await session.scalar(
            select(func.pgp_sym_decrypt(column, encryption_key)).where(predicate)
        )
        return str(decrypted or "")


class GoogleAdsConnectionTester(Protocol):
    async def test(self, record: GoogleAdsSettingsRecord, api_version: str) -> None: ...


class DataForSEOConnectionTester(Protocol):
    async def test(self, record: DataForSEOSettingsRecord) -> float | None: ...


class LiveGoogleAdsConnectionTester:
    async def test(self, record: GoogleAdsSettingsRecord, api_version: str) -> None:
        await asyncio.to_thread(self._test_sync, record, api_version)

    def _test_sync(self, record: GoogleAdsSettingsRecord, api_version: str) -> None:
        token_request = Request(
            "https://oauth2.googleapis.com/token",
            data=urlencode(
                {
                    "grant_type": "refresh_token",
                    "client_id": record.client_id,
                    "client_secret": record.client_secret,
                    "refresh_token": record.refresh_token,
                }
            ).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        token_payload = self._request_json(token_request, oauth=True)
        access_token = token_payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise DataSourceConnectionError("Google OAuth 没有返回访问令牌")

        headers = {
            "Authorization": f"Bearer {access_token}",
            "developer-token": record.developer_token,
        }
        if record.login_customer_id:
            headers["login-customer-id"] = record.login_customer_id
        customer_request = Request(
            "https://googleads.googleapis.com/"
            f"{api_version}/customers/{record.customer_id}",
            headers=headers,
            method="GET",
        )
        self._request_json(customer_request, oauth=False)

    def _request_json(self, request: Request, *, oauth: bool) -> dict[str, Any]:
        try:
            with urlopen(
                request,
                timeout=CONNECTION_TEST_TIMEOUT_SECONDS,
            ) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if oauth:
                if exc.code in {400, 401, 403}:
                    raise DataSourceConnectionError(
                        "OAuth Client 或 Refresh Token 无效"
                    ) from exc
                raise DataSourceConnectionError(
                    f"Google OAuth 返回 HTTP {exc.code}"
                ) from exc
            if exc.code == 401:
                raise DataSourceConnectionError("Google Ads OAuth 授权无效") from exc
            if exc.code == 403:
                raise DataSourceConnectionError(
                    "Developer Token 或客户账号没有访问权限"
                ) from exc
            if exc.code == 404:
                raise DataSourceConnectionError(
                    "Google Ads 客户 ID 不存在或 API 版本不可用"
                ) from exc
            if exc.code == 429:
                raise DataSourceConnectionError("Google Ads 请求过多，请稍后再试") from exc
            raise DataSourceConnectionError(
                f"Google Ads 返回 HTTP {exc.code}"
            ) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise DataSourceConnectionError("连接 Google Ads 超时") from exc
        except (URLError, OSError) as exc:
            raise DataSourceConnectionError("无法连接 Google Ads") from exc

        if len(body) > MAX_RESPONSE_BYTES:
            raise DataSourceConnectionError("Google Ads 响应过大")
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DataSourceConnectionError("Google Ads 返回格式不正确") from exc
        if not isinstance(payload, dict):
            raise DataSourceConnectionError("Google Ads 返回格式不正确")
        return payload


class LiveDataForSEOConnectionTester:
    ENDPOINT = "https://api.dataforseo.com/v3/appendix/user_data"

    async def test(self, record: DataForSEOSettingsRecord) -> float | None:
        return await asyncio.to_thread(self._test_sync, record)

    def _test_sync(self, record: DataForSEOSettingsRecord) -> float | None:
        credentials = base64.b64encode(
            f"{record.login}:{record.password}".encode()
        ).decode()
        request = Request(
            self.ENDPOINT,
            headers={"Authorization": f"Basic {credentials}"},
            method="GET",
        )
        try:
            with urlopen(
                request,
                timeout=CONNECTION_TEST_TIMEOUT_SECONDS,
            ) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if exc.code in {401, 403}:
                raise DataSourceConnectionError("DataForSEO 账号或密码无效") from exc
            if exc.code == 429:
                raise DataSourceConnectionError("DataForSEO 请求过多，请稍后再试") from exc
            raise DataSourceConnectionError(
                f"DataForSEO 返回 HTTP {exc.code}"
            ) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise DataSourceConnectionError("连接 DataForSEO 超时") from exc
        except (URLError, OSError) as exc:
            raise DataSourceConnectionError("无法连接 DataForSEO") from exc

        if len(body) > MAX_RESPONSE_BYTES:
            raise DataSourceConnectionError("DataForSEO 响应过大")
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DataSourceConnectionError("DataForSEO 返回格式不正确") from exc
        if not isinstance(payload, dict):
            raise DataSourceConnectionError("DataForSEO 返回格式不正确")
        status_code = payload.get("status_code")
        if isinstance(status_code, int) and status_code >= 40000:
            raise DataSourceConnectionError("DataForSEO 账号或密码无效")
        tasks = payload.get("tasks")
        task = tasks[0] if isinstance(tasks, list) and tasks else None
        task_status = task.get("status_code") if isinstance(task, dict) else None
        if isinstance(task_status, int) and task_status >= 40000:
            raise DataSourceConnectionError("DataForSEO 账号不可用")
        return dataforseo_balance(payload)


class GoogleAdsSettingsService:
    def __init__(
        self,
        settings: Settings,
        repository: DataSourceSettingsRepository,
        connection_tester: GoogleAdsConnectionTester,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.connection_tester = connection_tester

    async def get(self, project_id: str) -> GoogleAdsSettingsResponse:
        await self._ensure_project(project_id)
        record, source = await self._effective_record()
        return google_ads_response(record, source)

    async def update(
        self,
        project_id: str,
        request: UpdateGoogleAdsSettingsRequest,
    ) -> GoogleAdsSettingsResponse:
        await self._ensure_project(project_id)
        encryption_key = self._encryption_key()
        allow_plaintext = self._allow_plaintext_storage()
        if not encryption_key and not allow_plaintext:
            raise DataSourceEncryptionUnavailableError
        record = await self._merged_record(request)
        saved = await self.repository.upsert_google_ads(
            self.settings.default_organization_id,
            record,
            encryption_key,
            allow_plaintext,
        )
        return google_ads_response(saved, "database")

    async def test_connection(
        self,
        project_id: str,
        request: TestGoogleAdsSettingsRequest,
    ) -> TestGoogleAdsSettingsResponse:
        await self._ensure_project(project_id)
        record = await self._merged_record(request)
        await self.connection_tester.test(record, self.settings.google_ads_api_version)
        return TestGoogleAdsSettingsResponse(
            success=True,
            customer_id=record.customer_id,
            message="连接成功，Google Ads 凭据和客户账号均可用",
        )

    async def _merged_record(
        self,
        request: UpdateGoogleAdsSettingsRequest,
    ) -> GoogleAdsSettingsRecord:
        current, _ = await self._effective_record()
        record = GoogleAdsSettingsRecord(
            developer_token=request.developer_token
            or (current.developer_token if current else ""),
            client_id=request.client_id,
            client_secret=request.client_secret
            or (current.client_secret if current else ""),
            refresh_token=request.refresh_token
            or (current.refresh_token if current else ""),
            customer_id=request.customer_id,
            login_customer_id=request.login_customer_id,
        )
        if not record.configured:
            raise DataSourceNotConfiguredError("请填写完整的 Google Ads 配置")
        return record

    async def _effective_record(
        self,
    ) -> tuple[GoogleAdsSettingsRecord | None, str]:
        stored = await self.repository.get_google_ads(
            self.settings.default_organization_id,
            self._encryption_key(),
            self._allow_plaintext_storage(),
        )
        if stored is not None:
            return stored, "database"
        environment = GoogleAdsSettingsRecord(
            developer_token=(self.settings.google_ads_developer_token or "").strip(),
            client_id=(self.settings.google_ads_client_id or "").strip(),
            client_secret=(self.settings.google_ads_client_secret or "").strip(),
            refresh_token=(self.settings.google_ads_refresh_token or "").strip(),
            customer_id=(self.settings.google_ads_customer_id or "").strip(),
            login_customer_id=(
                (self.settings.google_ads_login_customer_id or "").strip() or None
            ),
        )
        if any(
            (
                environment.developer_token,
                environment.client_id,
                environment.client_secret,
                environment.refresh_token,
                environment.customer_id,
                environment.login_customer_id,
            )
        ):
            return environment, "environment"
        return None, "none"

    async def _ensure_project(self, project_id: str) -> None:
        if not await self.repository.project_exists(
            self.settings.default_organization_id,
            project_id,
        ):
            raise DataSourceProjectNotFoundError

    def _encryption_key(self) -> str | None:
        value = (self.settings.ai_settings_encryption_key or "").strip()
        return value or None

    def _allow_plaintext_storage(self) -> bool:
        return (
            self.settings.ai_settings_allow_plaintext
            or self.settings.app_env != "production"
        )


class DataForSEOSettingsService:
    def __init__(
        self,
        settings: Settings,
        repository: DataSourceSettingsRepository,
        connection_tester: DataForSEOConnectionTester,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.connection_tester = connection_tester

    async def get(self, project_id: str) -> DataForSEOSettingsResponse:
        await self._ensure_project(project_id)
        return await self.get_platform()

    async def get_platform(self) -> DataForSEOSettingsResponse:
        record, source = await self._effective_record()
        return dataforseo_response(record, source)

    async def effective_record(self) -> DataForSEOSettingsRecord:
        record, _ = await self._effective_record()
        if record is None or not record.configured:
            raise DataSourceNotConfiguredError("请先在平台设置中配置 DataForSEO")
        register_sensitive_values((record.password,))
        return record

    async def effective_record_for_organization(
        self, organization_id: str
    ) -> DataForSEOSettingsRecord:
        record, _ = await self._effective_record_for_organization(organization_id)
        if record is None or not record.configured:
            raise DataSourceNotConfiguredError("请先配置 DataForSEO")
        register_sensitive_values((record.password,))
        return record

    async def update(
        self,
        project_id: str,
        request: UpdateDataForSEOSettingsRequest,
    ) -> DataForSEOSettingsResponse:
        await self._ensure_project(project_id)
        return await self.update_platform(request)

    async def update_platform(
        self,
        request: UpdateDataForSEOSettingsRequest,
    ) -> DataForSEOSettingsResponse:
        encryption_key = self._encryption_key()
        allow_plaintext = self._allow_plaintext_storage()
        if not encryption_key and not allow_plaintext:
            raise DataSourceEncryptionUnavailableError
        record = await self._merged_record(request)
        saved = await self.repository.upsert_dataforseo(
            self.settings.default_organization_id,
            record,
            encryption_key,
            allow_plaintext,
        )
        return dataforseo_response(saved, "database")

    async def test_connection(
        self,
        project_id: str,
        request: TestDataForSEOSettingsRequest,
    ) -> TestDataForSEOSettingsResponse:
        await self._ensure_project(project_id)
        return await self.test_platform_connection(request)

    async def test_platform_connection(
        self,
        request: TestDataForSEOSettingsRequest,
    ) -> TestDataForSEOSettingsResponse:
        record = await self._merged_record(request)
        balance = await self.connection_tester.test(record)
        message = "连接成功，DataForSEO 账号可用"
        if balance is not None:
            message = f"连接成功，账户余额 ${balance:,.2f}"
        return TestDataForSEOSettingsResponse(
            success=True,
            message=message,
            balance=balance,
        )

    async def _merged_record(
        self,
        request: UpdateDataForSEOSettingsRequest,
    ) -> DataForSEOSettingsRecord:
        current, _ = await self._effective_record()
        record = DataForSEOSettingsRecord(
            login=request.login,
            password=request.password or (current.password if current else ""),
        )
        if not record.configured:
            raise DataSourceNotConfiguredError("请填写完整的 DataForSEO 配置")
        return record

    async def _effective_record(
        self,
    ) -> tuple[DataForSEOSettingsRecord | None, str]:
        return await self._effective_record_for_organization(
            self.settings.default_organization_id
        )

    async def _effective_record_for_organization(
        self, organization_id: str
    ) -> tuple[DataForSEOSettingsRecord | None, str]:
        stored = await self.repository.get_dataforseo(
            organization_id,
            self._encryption_key(),
            self._allow_plaintext_storage(),
        )
        if stored is not None:
            return stored, "database"
        environment = DataForSEOSettingsRecord(
            login=(self.settings.dataforseo_login or "").strip(),
            password=(self.settings.dataforseo_password or "").strip(),
        )
        if environment.login or environment.password:
            return environment, "environment"
        return None, "none"

    async def _ensure_project(self, project_id: str) -> None:
        if not await self.repository.project_exists(
            self.settings.default_organization_id,
            project_id,
        ):
            raise DataSourceProjectNotFoundError

    def _encryption_key(self) -> str | None:
        value = (self.settings.ai_settings_encryption_key or "").strip()
        return value or None

    def _allow_plaintext_storage(self) -> bool:
        return (
            self.settings.ai_settings_allow_plaintext
            or self.settings.app_env != "production"
        )


def google_ads_response(
    record: GoogleAdsSettingsRecord | None,
    source: str,
) -> GoogleAdsSettingsResponse:
    if record is None:
        return GoogleAdsSettingsResponse(
            client_id="",
            customer_id="",
            login_customer_id=None,
            configured=False,
            developer_token_configured=False,
            client_secret_configured=False,
            refresh_token_configured=False,
            source="none",
        )
    return GoogleAdsSettingsResponse(
        client_id=record.client_id,
        customer_id=record.customer_id,
        login_customer_id=record.login_customer_id,
        configured=record.configured,
        developer_token_configured=bool(record.developer_token),
        client_secret_configured=bool(record.client_secret),
        refresh_token_configured=bool(record.refresh_token),
        source=source,
        updated_at=record.updated_at,
    )


def dataforseo_response(
    record: DataForSEOSettingsRecord | None,
    source: str,
) -> DataForSEOSettingsResponse:
    if record is None:
        return DataForSEOSettingsResponse(
            login="",
            configured=False,
            password_configured=False,
            source="none",
        )
    return DataForSEOSettingsResponse(
        login=record.login,
        configured=record.configured,
        password_configured=bool(record.password),
        source=source,
        updated_at=record.updated_at,
    )


def dataforseo_balance(payload: dict[str, Any]) -> float | None:
    tasks = payload.get("tasks")
    task = tasks[0] if isinstance(tasks, list) and tasks else None
    if not isinstance(task, dict):
        return None
    results = task.get("result")
    result = results[0] if isinstance(results, list) and results else None
    if not isinstance(result, dict):
        return None
    money = result.get("money")
    balance: Any
    if isinstance(money, dict):
        balance = money.get("balance")
    else:
        balance = result.get("balance")
    if isinstance(balance, (int, float)) and not isinstance(balance, bool):
        return float(balance)
    return None


def build_google_ads_settings_service() -> GoogleAdsSettingsService:
    settings = get_settings()
    return GoogleAdsSettingsService(
        settings=settings,
        repository=SQLAlchemyDataSourceSettingsRepository(session_factory),
        connection_tester=LiveGoogleAdsConnectionTester(),
    )


def build_dataforseo_settings_service() -> DataForSEOSettingsService:
    settings = get_settings()
    return DataForSEOSettingsService(
        settings=settings,
        repository=SQLAlchemyDataSourceSettingsRepository(session_factory),
        connection_tester=LiveDataForSEOConnectionTester(),
    )
