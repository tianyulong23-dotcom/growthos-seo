from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import socket
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.agent.security import register_sensitive_values
from app.modules.projects.models import Project
from app.modules.settings.models import GSCProjectConnection, WordPressProjectConnection
from app.modules.settings.schemas import (
    GSCServiceAccountConnectionResponse,
    TestGSCServiceAccountConnectionRequest,
    TestGSCServiceAccountConnectionResponse,
    TestWordPressConnectionRequest,
    TestWordPressConnectionResponse,
    UpdateGSCServiceAccountConnectionRequest,
    UpdateWordPressConnectionRequest,
    WordPressConnectionResponse,
)

MAX_RESPONSE_BYTES = 1024 * 1024
CONNECTION_TIMEOUT_SECONDS = 20
PLAINTEXT_SECRET_PREFIX = b"plaintext:v1:"


class ServiceConnectionProjectNotFoundError(Exception):
    pass


class ServiceConnectionEncryptionUnavailableError(Exception):
    pass


class ServiceConnectionNotConfiguredError(Exception):
    pass


class ServiceConnectionError(Exception):
    pass


@dataclass(frozen=True)
class GSCConnectionRecord:
    property_url: str
    service_account_email: str
    private_key: str = field(repr=False)
    verified_at: datetime | None = None


@dataclass(frozen=True)
class WordPressConnectionRecord:
    site_url: str
    username: str
    application_password: str = field(repr=False)
    verified_user: str | None = None
    verified_at: datetime | None = None
    capabilities: dict[str, bool] = field(default_factory=dict)


@dataclass(frozen=True)
class WordPressVerificationResult:
    verified_user: str
    capabilities: dict[str, bool]


class ServiceConnectionRepository(Protocol):
    async def project_exists(self, organization_id: str, project_id: str) -> bool: ...

    async def get_gsc(
        self, project_id: str, encryption_key: str | None, allow_plaintext: bool
    ) -> GSCConnectionRecord | None: ...

    async def upsert_gsc(
        self,
        project_id: str,
        record: GSCConnectionRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GSCConnectionRecord: ...

    async def delete_gsc(self, project_id: str) -> None: ...

    async def get_wordpress(
        self, project_id: str, encryption_key: str | None, allow_plaintext: bool
    ) -> WordPressConnectionRecord | None: ...

    async def upsert_wordpress(
        self,
        project_id: str,
        record: WordPressConnectionRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> WordPressConnectionRecord: ...

    async def delete_wordpress(self, project_id: str) -> None: ...


class SQLAlchemyServiceConnectionRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        async with self.sessions() as session:
            return (
                await session.scalar(
                    select(Project.id).where(
                        Project.id == project_id,
                        Project.organization_id == organization_id,
                    )
                )
                is not None
            )

    async def get_gsc(
        self,
        project_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GSCConnectionRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        GSCProjectConnection.property_url,
                        GSCProjectConnection.service_account_email,
                        GSCProjectConnection.private_key_encrypted,
                        GSCProjectConnection.verified_at,
                    ).where(GSCProjectConnection.project_id == project_id)
                )
            ).one_or_none()
            if row is None:
                return None
            private_key = await self._read_secret(
                session,
                GSCProjectConnection.private_key_encrypted,
                GSCProjectConnection.project_id == project_id,
                row.private_key_encrypted,
                encryption_key,
                allow_plaintext,
            )
        return GSCConnectionRecord(
            property_url=row.property_url,
            service_account_email=row.service_account_email,
            private_key=private_key,
            verified_at=row.verified_at,
        )

    async def upsert_gsc(
        self,
        project_id: str,
        record: GSCConnectionRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> GSCConnectionRecord:
        if not encryption_key and not allow_plaintext:
            raise ServiceConnectionEncryptionUnavailableError
        secret_expression = self._secret_expression(encryption_key).format(
            value="private_key"
        )
        async with self.sessions() as session:
            await session.execute(
                text(
                    f"""
                    INSERT INTO gsc_project_connections (
                        project_id, property_url, service_account_email,
                        private_key_encrypted, verified_at
                    ) VALUES (
                        :project_id, :property_url, :service_account_email,
                        {secret_expression}, :verified_at
                    )
                    ON CONFLICT (project_id) DO UPDATE SET
                        property_url = EXCLUDED.property_url,
                        service_account_email = EXCLUDED.service_account_email,
                        private_key_encrypted = EXCLUDED.private_key_encrypted,
                        verified_at = EXCLUDED.verified_at,
                        updated_at = now()
                    """
                ),
                {
                    "project_id": project_id,
                    "property_url": record.property_url,
                    "service_account_email": record.service_account_email,
                    "private_key": record.private_key,
                    "private_key_plaintext": PLAINTEXT_SECRET_PREFIX
                    + record.private_key.encode("utf-8"),
                    "encryption_key": encryption_key,
                    "verified_at": record.verified_at,
                },
            )
            await session.commit()
        saved = await self.get_gsc(project_id, encryption_key, allow_plaintext)
        if saved is None:
            raise RuntimeError("GSC connection was not saved")
        return saved

    async def delete_gsc(self, project_id: str) -> None:
        async with self.sessions() as session:
            await session.execute(
                delete(GSCProjectConnection).where(
                    GSCProjectConnection.project_id == project_id
                )
            )
            await session.commit()

    async def get_wordpress(
        self,
        project_id: str,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> WordPressConnectionRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        WordPressProjectConnection.site_url,
                        WordPressProjectConnection.username,
                        WordPressProjectConnection.application_password_encrypted,
                        WordPressProjectConnection.verified_user,
                        WordPressProjectConnection.verified_at,
                        WordPressProjectConnection.capabilities_json,
                    ).where(WordPressProjectConnection.project_id == project_id)
                )
            ).one_or_none()
            if row is None:
                return None
            password = await self._read_secret(
                session,
                WordPressProjectConnection.application_password_encrypted,
                WordPressProjectConnection.project_id == project_id,
                row.application_password_encrypted,
                encryption_key,
                allow_plaintext,
            )
        return WordPressConnectionRecord(
            site_url=row.site_url,
            username=row.username,
            application_password=password,
            verified_user=row.verified_user,
            verified_at=row.verified_at,
            capabilities=dict(row.capabilities_json or {}),
        )

    async def upsert_wordpress(
        self,
        project_id: str,
        record: WordPressConnectionRecord,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> WordPressConnectionRecord:
        if not encryption_key and not allow_plaintext:
            raise ServiceConnectionEncryptionUnavailableError
        secret_expression = self._secret_expression(encryption_key).format(
            value="application_password"
        )
        async with self.sessions() as session:
            await session.execute(
                text(
                    f"""
                    INSERT INTO wordpress_project_connections (
                        project_id, site_url, username,
                        application_password_encrypted, verified_user, verified_at,
                        capabilities_json
                    ) VALUES (
                        :project_id, :site_url, :username,
                        {secret_expression}, :verified_user, :verified_at,
                        CAST(:capabilities_json AS jsonb)
                    )
                    ON CONFLICT (project_id) DO UPDATE SET
                        site_url = EXCLUDED.site_url,
                        username = EXCLUDED.username,
                        application_password_encrypted = EXCLUDED.application_password_encrypted,
                        verified_user = EXCLUDED.verified_user,
                        verified_at = EXCLUDED.verified_at,
                        capabilities_json = EXCLUDED.capabilities_json,
                        updated_at = now()
                    """
                ),
                {
                    "project_id": project_id,
                    "site_url": record.site_url,
                    "username": record.username,
                    "application_password": record.application_password,
                    "application_password_plaintext": PLAINTEXT_SECRET_PREFIX
                    + record.application_password.encode("utf-8"),
                    "encryption_key": encryption_key,
                    "verified_user": record.verified_user,
                    "verified_at": record.verified_at,
                    "capabilities_json": json.dumps(record.capabilities),
                },
            )
            await session.commit()
        saved = await self.get_wordpress(
            project_id, encryption_key, allow_plaintext
        )
        if saved is None:
            raise RuntimeError("WordPress connection was not saved")
        return saved

    async def delete_wordpress(self, project_id: str) -> None:
        async with self.sessions() as session:
            await session.execute(
                delete(WordPressProjectConnection).where(
                    WordPressProjectConnection.project_id == project_id
                )
            )
            await session.commit()

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
        column: object,
        predicate: object,
        stored_value: bytes,
        encryption_key: str | None,
        allow_plaintext: bool,
    ) -> str:
        value = bytes(stored_value)
        if value.startswith(PLAINTEXT_SECRET_PREFIX):
            if not allow_plaintext:
                raise ServiceConnectionEncryptionUnavailableError
            return value.removeprefix(PLAINTEXT_SECRET_PREFIX).decode("utf-8")
        if not encryption_key:
            raise ServiceConnectionEncryptionUnavailableError
        decrypted = await session.scalar(
            select(func.pgp_sym_decrypt(column, encryption_key)).where(predicate)
        )
        return str(decrypted or "")


class GSCConnectionTester(Protocol):
    async def test(self, record: GSCConnectionRecord) -> None: ...


class WordPressConnectionTester(Protocol):
    async def test(
        self, record: WordPressConnectionRecord
    ) -> WordPressVerificationResult: ...


class LiveGSCConnectionTester:
    _SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"

    async def test(self, record: GSCConnectionRecord) -> None:
        await asyncio.to_thread(self._test_sync, record)

    def _test_sync(self, record: GSCConnectionRecord) -> None:
        try:
            credentials = service_account.Credentials.from_service_account_info(
                {
                    "type": "service_account",
                    "client_email": record.service_account_email,
                    "private_key": record.private_key,
                    "token_uri": "https://oauth2.googleapis.com/token",
                },
                scopes=[self._SCOPE],
            )
            credentials.refresh(GoogleAuthRequest())
            request = Request(
                "https://www.googleapis.com/webmasters/v3/sites/"
                f"{quote(record.property_url, safe='')}",
                headers={"Authorization": f"Bearer {credentials.token}"},
                method="GET",
            )
            with build_opener(_NoRedirectHandler()).open(
                request, timeout=CONNECTION_TIMEOUT_SECONDS
            ) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except (ValueError, GoogleAuthError) as exc:
            raise ServiceConnectionError("GSC 服务账号凭据无效") from exc
        except HTTPError as exc:
            if exc.code in {401, 403}:
                raise ServiceConnectionError("该服务账号没有此 GSC 资产的访问权限") from exc
            if exc.code == 404:
                raise ServiceConnectionError("GSC 资产不存在或地址不匹配") from exc
            raise ServiceConnectionError(f"Google Search Console 返回 HTTP {exc.code}") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise ServiceConnectionError("连接 Google Search Console 超时") from exc
        except (URLError, OSError) as exc:
            raise ServiceConnectionError("无法连接 Google Search Console") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise ServiceConnectionError("Google Search Console 响应过大")


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


class LiveWordPressConnectionTester:
    async def test(
        self, record: WordPressConnectionRecord
    ) -> WordPressVerificationResult:
        return await asyncio.to_thread(self._test_sync, record)

    def _test_sync(
        self, record: WordPressConnectionRecord
    ) -> WordPressVerificationResult:
        self._ensure_public_host(record.site_url)
        credentials = base64.b64encode(
            f"{record.username}:{record.application_password}".encode()
        ).decode()
        headers = {
            "Authorization": f"Basic {credentials}",
            "Accept": "application/json",
        }
        payload = self._request_json(
            f"{record.site_url}/wp-json/wp/v2/users/me?context=edit",
            headers,
        )
        if not isinstance(payload, dict):
            raise ServiceConnectionError("WordPress 返回格式不正确")
        verified_user = payload.get("name") or payload.get("slug")
        if not isinstance(verified_user, str) or not verified_user.strip():
            raise ServiceConnectionError("WordPress 未返回可验证的用户身份")
        raw_capabilities = payload.get("capabilities")
        user_capabilities = (
            raw_capabilities if isinstance(raw_capabilities, dict) else {}
        )
        posts_readable = self._probe_read_route(
            f"{record.site_url}/wp-json/wp/v2/posts?context=edit&per_page=1&_fields=id,slug",
            headers,
        )
        media_readable = self._probe_read_route(
            f"{record.site_url}/wp-json/wp/v2/media?context=edit&per_page=1&_fields=id,slug",
            headers,
        )
        can_publish_posts = user_capabilities.get("publish_posts") is True
        can_edit_posts = user_capabilities.get("edit_posts") is True
        can_edit_published_posts = (
            user_capabilities.get("edit_published_posts") is True
        )
        can_upload_files = user_capabilities.get("upload_files") is True
        return WordPressVerificationResult(
            verified_user=verified_user.strip(),
            capabilities={
                "media_upload": can_upload_files and media_readable,
                "media_lookup": media_readable,
                "post_create": can_edit_posts and can_publish_posts and posts_readable,
                "post_update_by_remote_id": (
                    can_edit_published_posts and posts_readable
                ),
                "post_reconcile": posts_readable,
                "theme_preview": False,
            },
        )

    def _request_json(
        self,
        endpoint: str,
        headers: dict[str, str],
        *,
        permission_denied_ok: bool = False,
    ) -> object | None:
        request = Request(endpoint, headers=headers, method="GET")
        try:
            with build_opener(_NoRedirectHandler()).open(
                request, timeout=CONNECTION_TIMEOUT_SECONDS
            ) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if permission_denied_ok and exc.code in {401, 403, 404}:
                return None
            if exc.code in {301, 302, 303, 307, 308}:
                raise ServiceConnectionError("WordPress 地址发生重定向，请填写最终站点地址") from exc
            if exc.code in {401, 403}:
                raise ServiceConnectionError("WordPress 用户名或应用密码无效") from exc
            if exc.code == 404:
                raise ServiceConnectionError("该站点未开放 WordPress REST API") from exc
            raise ServiceConnectionError(f"WordPress 返回 HTTP {exc.code}") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise ServiceConnectionError("连接 WordPress 超时") from exc
        except (URLError, OSError) as exc:
            raise ServiceConnectionError("无法连接 WordPress") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise ServiceConnectionError("WordPress 响应过大")
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ServiceConnectionError("WordPress 返回格式不正确") from exc

    def _probe_read_route(self, endpoint: str, headers: dict[str, str]) -> bool:
        payload = self._request_json(
            endpoint, headers, permission_denied_ok=True
        )
        return isinstance(payload, list)

    def _ensure_public_host(self, site_url: str) -> None:
        hostname = urlsplit(site_url).hostname
        if not hostname:
            raise ServiceConnectionError("WordPress 地址无效")
        try:
            addresses = socket.getaddrinfo(hostname, None)
        except socket.gaierror as exc:
            raise ServiceConnectionError("无法解析 WordPress 站点地址") from exc
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            if not ip.is_global:
                raise ServiceConnectionError("WordPress 地址不能指向内网或本机")


class ProjectServiceConnectionService:
    def __init__(
        self,
        settings: Settings,
        repository: ServiceConnectionRepository,
        gsc_tester: GSCConnectionTester,
        wordpress_tester: WordPressConnectionTester,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.gsc_tester = gsc_tester
        self.wordpress_tester = wordpress_tester

    async def get_gsc(self, project_id: str) -> GSCServiceAccountConnectionResponse:
        await self._ensure_project(project_id)
        record = await self.repository.get_gsc(
            project_id,
            self._optional_encryption_key(),
            self._allow_plaintext_storage(),
        )
        return gsc_response(record)

    async def update_gsc(
        self, project_id: str, request: UpdateGSCServiceAccountConnectionRequest
    ) -> GSCServiceAccountConnectionResponse:
        await self._ensure_project(project_id)
        self._require_storage_configuration()
        record = await self._merged_gsc(project_id, request)
        await self.gsc_tester.test(record)
        verified = GSCConnectionRecord(
            property_url=record.property_url,
            service_account_email=record.service_account_email,
            private_key=record.private_key,
            verified_at=datetime.now(UTC),
        )
        saved = await self.repository.upsert_gsc(
            project_id,
            verified,
            self._optional_encryption_key(),
            self._allow_plaintext_storage(),
        )
        return gsc_response(saved)

    async def test_gsc(
        self, project_id: str, request: TestGSCServiceAccountConnectionRequest
    ) -> TestGSCServiceAccountConnectionResponse:
        await self._ensure_project(project_id)
        record = await self._merged_gsc(project_id, request)
        await self.gsc_tester.test(record)
        return TestGSCServiceAccountConnectionResponse(
            success=True,
            property_url=record.property_url,
            message="连接成功，服务账号可以访问该 GSC 资产",
        )

    async def disconnect_gsc(self, project_id: str) -> None:
        await self._ensure_project(project_id)
        await self.repository.delete_gsc(project_id)

    async def get_wordpress(self, project_id: str) -> WordPressConnectionResponse:
        await self._ensure_project(project_id)
        record = await self.repository.get_wordpress(
            project_id,
            self._optional_encryption_key(),
            self._allow_plaintext_storage(),
        )
        return wordpress_response(record)

    async def update_wordpress(
        self, project_id: str, request: UpdateWordPressConnectionRequest
    ) -> WordPressConnectionResponse:
        await self._ensure_project(project_id)
        self._require_storage_configuration()
        record = await self._merged_wordpress(project_id, request)
        verification = await self.wordpress_tester.test(record)
        verified = WordPressConnectionRecord(
            site_url=record.site_url,
            username=record.username,
            application_password=record.application_password,
            verified_user=verification.verified_user,
            verified_at=datetime.now(UTC),
            capabilities=verification.capabilities,
        )
        saved = await self.repository.upsert_wordpress(
            project_id,
            verified,
            self._optional_encryption_key(),
            self._allow_plaintext_storage(),
        )
        return wordpress_response(saved)

    async def test_wordpress(
        self, project_id: str, request: TestWordPressConnectionRequest
    ) -> TestWordPressConnectionResponse:
        await self._ensure_project(project_id)
        record = await self._merged_wordpress(project_id, request)
        verification = await self.wordpress_tester.test(record)
        return TestWordPressConnectionResponse(
            success=True,
            site_url=record.site_url,
            verified_user=verification.verified_user,
            message="连接成功，WordPress REST API 可以正常访问",
        )

    async def disconnect_wordpress(self, project_id: str) -> None:
        await self._ensure_project(project_id)
        await self.repository.delete_wordpress(project_id)

    async def _merged_gsc(
        self, project_id: str, request: UpdateGSCServiceAccountConnectionRequest
    ) -> GSCConnectionRecord:
        current = None
        if request.private_key is None:
            current = await self.repository.get_gsc(
                project_id,
                self._optional_encryption_key(),
                self._allow_plaintext_storage(),
            )
        private_key = request.private_key or (current.private_key if current else "")
        if not private_key:
            raise ServiceConnectionNotConfiguredError("请填写 GSC 服务账号私钥")
        register_sensitive_values((private_key,))
        return GSCConnectionRecord(
            property_url=request.property_url,
            service_account_email=request.service_account_email,
            private_key=private_key,
        )

    async def _merged_wordpress(
        self, project_id: str, request: UpdateWordPressConnectionRequest
    ) -> WordPressConnectionRecord:
        current = None
        if request.application_password is None:
            current = await self.repository.get_wordpress(
                project_id,
                self._optional_encryption_key(),
                self._allow_plaintext_storage(),
            )
        password = request.application_password or (
            current.application_password if current else ""
        )
        if not password:
            raise ServiceConnectionNotConfiguredError("请填写 WordPress 应用密码")
        register_sensitive_values((password,))
        return WordPressConnectionRecord(
            site_url=request.site_url,
            username=request.username,
            application_password=password,
        )

    async def _ensure_project(self, project_id: str) -> None:
        if not await self.repository.project_exists(
            self.settings.default_organization_id, project_id
        ):
            raise ServiceConnectionProjectNotFoundError

    def _optional_encryption_key(self) -> str | None:
        return (self.settings.ai_settings_encryption_key or "").strip() or None

    def _allow_plaintext_storage(self) -> bool:
        return (
            self.settings.ai_settings_allow_plaintext
            or self.settings.app_env != "production"
        )

    def _require_storage_configuration(self) -> None:
        if not self._optional_encryption_key() and not self._allow_plaintext_storage():
            raise ServiceConnectionEncryptionUnavailableError


def gsc_response(
    record: GSCConnectionRecord | None,
) -> GSCServiceAccountConnectionResponse:
    if record is None:
        return GSCServiceAccountConnectionResponse(
            property_url="",
            service_account_email="",
            private_key_configured=False,
            status="disconnected",
        )
    return GSCServiceAccountConnectionResponse(
        property_url=record.property_url,
        service_account_email=record.service_account_email,
        private_key_configured=bool(record.private_key),
        status="connected",
        verified_at=record.verified_at,
    )


def wordpress_response(
    record: WordPressConnectionRecord | None,
) -> WordPressConnectionResponse:
    if record is None:
        return WordPressConnectionResponse(
            site_url="",
            username="",
            application_password_configured=False,
            status="disconnected",
        )
    return WordPressConnectionResponse(
        site_url=record.site_url,
        username=record.username,
        application_password_configured=bool(record.application_password),
        verified_user=record.verified_user,
        status="connected",
        verified_at=record.verified_at,
    )


def build_project_service_connection_service() -> ProjectServiceConnectionService:
    return ProjectServiceConnectionService(
        settings=get_settings(),
        repository=SQLAlchemyServiceConnectionRepository(session_factory),
        gsc_tester=LiveGSCConnectionTester(),
        wordpress_tester=LiveWordPressConnectionTester(),
    )
