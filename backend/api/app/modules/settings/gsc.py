from __future__ import annotations

import asyncio
import base64
import calendar
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.projects.models import Project
from app.modules.settings.models import GSCConnection
from app.modules.settings.schemas import (
    GSCConnectionResponse,
    GSCPerformanceDimensionRow,
    GSCPerformanceExportResponse,
    GSCPerformanceRange,
    GSCPerformanceReportResponse,
    GSCPerformanceTableResponse,
    GSCPerformanceTotals,
    GSCStrikingDistanceRow,
    GSCSiteListResponse,
    GSCSiteResponse,
)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GSC_API_BASE = "https://www.googleapis.com/webmasters/v3"
GSC_SCOPES = (
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/webmasters.readonly",
)
UNVERIFIED_PERMISSION = "siteUnverifiedUser"
GSC_DATE_RANGES = ("last_7_days", "last_28_days", "last_3_months")
GSC_DEVICES = ("DESKTOP", "MOBILE", "TABLET")
GSC_TABLE_DIMENSIONS = ("query", "page")
GSC_DATA_LAG_DAYS = 3
GSC_DAILY_ROW_LIMIT = 200
GSC_COUNTRY_ROW_LIMIT = 25
GSC_STRIKING_FETCH_LIMIT = 1000
GSC_STRIKING_ROW_LIMIT = 100
GSC_EXPORT_ROW_LIMIT = 1000

GSCDateRange = Literal["last_7_days", "last_28_days", "last_3_months"]
GSCDevice = Literal["DESKTOP", "MOBILE", "TABLET"]
GSCTableDimension = Literal["query", "page"]


class GSCError(Exception):
    pass


class GSCNotConfiguredError(GSCError):
    pass


class GSCNotConnectedError(GSCError):
    pass


class GSCReconnectRequiredError(GSCError):
    pass


class GSCValidationError(GSCError):
    pass


class GSCUpstreamError(GSCError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class GSCGrant:
    project_id: str
    organization_id: str
    site_url: str | None
    google_account_id: str
    connected_account_email: str | None
    refresh_token: str
    scopes: str
    requires_reconnect: bool


class GSCRepository:
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

    async def project_domain(self, organization_id: str, project_id: str) -> str | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(Project.domain).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            )

    async def get(self, project_id: str, encryption_key: str) -> GSCGrant | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        GSCConnection.project_id,
                        GSCConnection.organization_id,
                        GSCConnection.site_url,
                        GSCConnection.google_account_id,
                        GSCConnection.connected_account_email,
                        func.pgp_sym_decrypt(
                            GSCConnection.refresh_token_encrypted,
                            encryption_key,
                        ).label("refresh_token"),
                        GSCConnection.scopes,
                        GSCConnection.requires_reconnect,
                    ).where(GSCConnection.project_id == project_id)
                )
            ).one_or_none()
        if row is None:
            return None
        return GSCGrant(
            project_id=row.project_id,
            organization_id=row.organization_id,
            site_url=row.site_url,
            google_account_id=row.google_account_id,
            connected_account_email=row.connected_account_email,
            refresh_token=row.refresh_token,
            scopes=row.scopes,
            requires_reconnect=row.requires_reconnect,
        )

    async def upsert_grant(
        self,
        *,
        project_id: str,
        organization_id: str,
        google_account_id: str,
        connected_account_email: str | None,
        refresh_token: str | None,
        scopes: str,
        encryption_key: str,
    ) -> None:
        async with self.sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO gsc_connections (
                        project_id, organization_id, google_account_id,
                        connected_account_email, refresh_token_encrypted, scopes
                    )
                    VALUES (
                        :project_id, :organization_id, :google_account_id,
                        :connected_account_email,
                        pgp_sym_encrypt(:refresh_token, :encryption_key,
                            'cipher-algo=aes256, compress-algo=1'),
                        :scopes
                    )
                    ON CONFLICT (project_id) DO UPDATE SET
                        google_account_id = EXCLUDED.google_account_id,
                        connected_account_email = EXCLUDED.connected_account_email,
                        refresh_token_encrypted = CASE
                            WHEN :refresh_token_present THEN EXCLUDED.refresh_token_encrypted
                            ELSE gsc_connections.refresh_token_encrypted
                        END,
                        scopes = EXCLUDED.scopes,
                        site_url = CASE
                            WHEN gsc_connections.google_account_id = EXCLUDED.google_account_id
                            THEN gsc_connections.site_url ELSE NULL
                        END,
                        requires_reconnect = false,
                        updated_at = now()
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "google_account_id": google_account_id,
                    "connected_account_email": connected_account_email,
                    "refresh_token": refresh_token or "",
                    "refresh_token_present": bool(refresh_token),
                    "scopes": scopes,
                    "encryption_key": encryption_key,
                },
            )
            await session.commit()

    async def select_site(self, project_id: str, site_url: str) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(GSCConnection)
                .where(GSCConnection.project_id == project_id)
                .values(site_url=site_url, requires_reconnect=False, updated_at=func.now())
            )
            await session.commit()

    async def mark_reconnect(self, project_id: str) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(GSCConnection)
                .where(GSCConnection.project_id == project_id)
                .values(requires_reconnect=True, updated_at=func.now())
            )
            await session.commit()

    async def disconnect(self, project_id: str) -> None:
        async with self.sessions() as session:
            await session.execute(
                delete(GSCConnection).where(GSCConnection.project_id == project_id)
            )
            await session.commit()


class GSCService:
    def __init__(self, settings: Settings, repository: GSCRepository) -> None:
        self.settings = settings
        self.repository = repository

    async def status(self, project_id: str) -> GSCConnectionResponse:
        await self._ensure_project(project_id)
        oauth_configured = self._oauth_configured
        if not oauth_configured or not self._encryption_configured:
            return GSCConnectionResponse(
                oauth_configured=False,
                oauth_redirect_uri=self._redirect_uri,
                grant_connected=False,
                property_connected=False,
            )
        grant = await self.repository.get(project_id, self._encryption_key)
        project_domain = await self.repository.project_domain(
            self.settings.default_organization_id, project_id
        )
        property_connected = bool(
            grant
            and grant.site_url
            and not grant.requires_reconnect
            and project_domain
            and gsc_site_matches_domain(grant.site_url, project_domain)
        )
        return GSCConnectionResponse(
            oauth_configured=True,
            oauth_redirect_uri=self._redirect_uri,
            grant_connected=grant is not None,
            property_connected=property_connected,
            site_url=grant.site_url if grant else None,
            connected_account_email=grant.connected_account_email if grant else None,
            requires_reconnect=bool(grant and grant.requires_reconnect),
        )

    async def authorization_url(self, project_id: str, callback_url: str) -> str:
        await self._ensure_project(project_id)
        self._require_configuration()
        callback_path = self._safe_callback_path(callback_url)
        state = self._sign_state(
            {
                "project_id": project_id,
                "organization_id": self.settings.default_organization_id,
                "callback_path": callback_path,
                "exp": int(time.time()) + 600,
            }
        )
        query = urlencode(
            {
                "client_id": self.settings.google_gsc_client_id,
                "redirect_uri": self._redirect_uri,
                "response_type": "code",
                "scope": " ".join(GSC_SCOPES),
                "access_type": "offline",
                "prompt": "select_account consent",
                "state": state,
            }
        )
        return f"{GOOGLE_AUTH_URL}?{query}"

    async def handle_callback(
        self, *, code: str | None, state: str, error: str | None = None
    ) -> str:
        self._require_configuration()
        payload = self._verify_state(state)
        if error:
            result = "cancelled" if error == "access_denied" else "failed"
            return self._callback_path_with_result(str(payload["callback_path"]), result)
        if not code:
            raise GSCValidationError("Google 没有返回 Search Console authorization code")
        project_id = str(payload["project_id"])
        organization_id = str(payload["organization_id"])
        if not await self.repository.project_exists(organization_id, project_id):
            raise GSCValidationError("Search Console OAuth 项目不存在")
        token = await asyncio.to_thread(self._exchange_code, code)
        access_token = str(token.get("access_token") or "")
        account_id, email = await asyncio.to_thread(self._userinfo, access_token)
        current = await self.repository.get(project_id, self._encryption_key)
        refresh_token = str(token.get("refresh_token") or "") or None
        if refresh_token is None and current is None:
            raise GSCValidationError("Google 没有返回 Search Console refresh token，请重新授权")
        await self.repository.upsert_grant(
            project_id=project_id,
            organization_id=organization_id,
            google_account_id=account_id,
            connected_account_email=email,
            refresh_token=refresh_token,
            scopes=str(token.get("scope") or " ".join(GSC_SCOPES)),
            encryption_key=self._encryption_key,
        )
        return self._callback_path_with_result(str(payload["callback_path"]), "authorized")

    def failed_callback_path(self, state: str) -> str:
        payload = self._verify_state(state)
        return self._callback_path_with_result(str(payload["callback_path"]), "failed")

    async def list_sites(self, project_id: str) -> GSCSiteListResponse:
        grant = await self._required_grant(project_id)
        access_token = await self._access_token(grant)
        payload = await asyncio.to_thread(
            _google_json,
            Request(
                f"{GSC_API_BASE}/sites",
                headers={"Authorization": f"Bearer {access_token}"},
            ),
        )
        entries = payload.get("siteEntry")
        rows = entries if isinstance(entries, list) else []
        return GSCSiteListResponse(
            items=[
                GSCSiteResponse(
                    site_url=str(row.get("siteUrl") or ""),
                    permission_level=str(row.get("permissionLevel") or ""),
                )
                for row in rows
                if isinstance(row, dict) and str(row.get("siteUrl") or "")
            ]
        )

    async def select_site(self, project_id: str, site_url: str) -> GSCConnectionResponse:
        sites = await self.list_sites(project_id)
        match = next((item for item in sites.items if item.site_url == site_url), None)
        if match is None:
            raise GSCValidationError("该 Search Console property 不在当前 Google 账号中")
        if match.permission_level == UNVERIFIED_PERMISSION:
            raise GSCValidationError("当前 Google 账号没有该 property 的已验证权限")
        project_domain = await self.repository.project_domain(
            self.settings.default_organization_id, project_id
        )
        if not project_domain or not gsc_site_matches_domain(site_url, project_domain):
            raise GSCValidationError("所选 Search Console property 与当前项目域名不匹配")
        await self.repository.select_site(project_id, site_url)
        return await self.status(project_id)

    async def disconnect(self, project_id: str) -> None:
        await self._ensure_project(project_id)
        await self.repository.disconnect(project_id)

    async def performance_report(
        self,
        project_id: str,
        *,
        date_range: GSCDateRange = "last_28_days",
        device: GSCDevice | None = None,
        country: str | None = None,
        today: date | None = None,
    ) -> GSCPerformanceReportResponse:
        grant, access_token, endpoint = await self._performance_context(project_id)
        start_date, end_date = resolve_gsc_date_range(date_range, today=today)
        previous_start, previous_end = previous_gsc_period(start_date, end_date)
        device_filters = gsc_dimension_filters(device=device)
        filters = gsc_dimension_filters(device=device, country=country)

        current, previous, query_pages, countries = await self._fetch_performance(
            project_id,
            endpoint,
            access_token,
            [
                gsc_search_payload(
                    start_date,
                    end_date,
                    dimensions=["date"],
                    filters=filters,
                    row_limit=GSC_DAILY_ROW_LIMIT,
                ),
                gsc_search_payload(
                    previous_start,
                    previous_end,
                    dimensions=["date"],
                    filters=filters,
                    row_limit=GSC_DAILY_ROW_LIMIT,
                ),
                gsc_search_payload(
                    start_date,
                    end_date,
                    dimensions=["query", "page"],
                    filters=filters,
                    row_limit=GSC_STRIKING_FETCH_LIMIT,
                ),
                gsc_search_payload(
                    start_date,
                    end_date,
                    dimensions=["country"],
                    filters=device_filters,
                    row_limit=GSC_COUNTRY_ROW_LIMIT,
                ),
            ],
        )
        return GSCPerformanceReportResponse(
            site_url=str(grant.site_url),
            range=GSCPerformanceRange(
                start_date=start_date,
                end_date=end_date,
                previous_start_date=previous_start,
                previous_end_date=previous_end,
            ),
            totals=sum_gsc_totals(gsc_rows(current)),
            previous_totals=sum_gsc_totals(gsc_rows(previous)),
            striking_distance=build_gsc_striking_distance(gsc_rows(query_pages)),
            countries=gsc_dimension_rows(gsc_rows(countries)),
        )

    async def performance_table(
        self,
        project_id: str,
        *,
        dimension: GSCTableDimension,
        page: int,
        page_size: Literal[25, 50, 100],
        date_range: GSCDateRange = "last_28_days",
        device: GSCDevice | None = None,
        country: str | None = None,
        today: date | None = None,
    ) -> GSCPerformanceTableResponse:
        _, access_token, endpoint = await self._performance_context(project_id)
        start_date, end_date = resolve_gsc_date_range(date_range, today=today)
        offset = (page - 1) * page_size
        [payload] = await self._fetch_performance(
            project_id,
            endpoint,
            access_token,
            [
                gsc_search_payload(
                    start_date,
                    end_date,
                    dimensions=[dimension],
                    filters=gsc_dimension_filters(device=device, country=country),
                    row_limit=page_size + 1,
                    start_row=offset,
                )
            ],
        )
        rows = gsc_dimension_rows(gsc_rows(payload))
        has_next_page = len(rows) > page_size
        return GSCPerformanceTableResponse(
            dimension=dimension,
            page=page,
            page_size=page_size,
            has_next_page=has_next_page,
            rows=rows[:page_size],
        )

    async def performance_export(
        self,
        project_id: str,
        *,
        dimension: GSCTableDimension,
        date_range: GSCDateRange = "last_28_days",
        device: GSCDevice | None = None,
        country: str | None = None,
        today: date | None = None,
    ) -> GSCPerformanceExportResponse:
        _, access_token, endpoint = await self._performance_context(project_id)
        start_date, end_date = resolve_gsc_date_range(date_range, today=today)
        [payload] = await self._fetch_performance(
            project_id,
            endpoint,
            access_token,
            [
                gsc_search_payload(
                    start_date,
                    end_date,
                    dimensions=[dimension],
                    filters=gsc_dimension_filters(device=device, country=country),
                    row_limit=GSC_EXPORT_ROW_LIMIT,
                )
            ],
        )
        return GSCPerformanceExportResponse(
            dimension=dimension,
            rows=gsc_dimension_rows(gsc_rows(payload)),
        )

    async def _performance_context(self, project_id: str) -> tuple[GSCGrant, str, str]:
        grant = await self._required_grant(project_id)
        project_domain = await self.repository.project_domain(
            self.settings.default_organization_id, project_id
        )
        if (
            not grant.site_url
            or not project_domain
            or not gsc_site_matches_domain(grant.site_url, project_domain)
        ):
            raise GSCNotConnectedError("请先选择与当前项目域名匹配的 Search Console property")
        access_token = await self._access_token(grant)
        endpoint = f"{GSC_API_BASE}/sites/{quote(grant.site_url, safe='')}/searchAnalytics/query"
        return grant, access_token, endpoint

    async def _fetch_performance(
        self,
        project_id: str,
        endpoint: str,
        access_token: str,
        payloads: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        def fetch(payload: dict[str, Any]) -> dict[str, Any]:
            return _google_json(
                Request(
                    endpoint,
                    data=json.dumps(payload).encode(),
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
            )

        try:
            return list(
                await asyncio.gather(*(asyncio.to_thread(fetch, payload) for payload in payloads))
            )
        except GSCUpstreamError as exc:
            if exc.status_code in {401, 403}:
                await self.repository.mark_reconnect(project_id)
                raise GSCReconnectRequiredError(
                    "Search Console 授权已失效或无权访问当前 property，请重新连接"
                ) from exc
            raise

    async def _required_grant(self, project_id: str) -> GSCGrant:
        await self._ensure_project(project_id)
        self._require_configuration()
        grant = await self.repository.get(project_id, self._encryption_key)
        if grant is None:
            raise GSCNotConnectedError("Search Console 尚未连接")
        if grant.requires_reconnect:
            raise GSCReconnectRequiredError("Search Console 授权已失效，请重新连接")
        return grant

    async def _access_token(self, grant: GSCGrant) -> str:
        try:
            token = await asyncio.to_thread(self._refresh_access_token, grant.refresh_token)
        except GSCReconnectRequiredError:
            await self.repository.mark_reconnect(grant.project_id)
            raise
        return token

    def _refresh_access_token(self, refresh_token: str) -> str:
        body = urlencode(
            {
                "client_id": self.settings.google_gsc_client_id,
                "client_secret": self.settings.google_gsc_client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            }
        ).encode()
        try:
            payload = _google_json(
                Request(
                    GOOGLE_TOKEN_URL,
                    data=body,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
            )
        except GSCUpstreamError as exc:
            if exc.status_code in {400, 401, 403}:
                raise GSCReconnectRequiredError("Search Console 授权已失效，请重新连接") from exc
            raise
        token = str(payload.get("access_token") or "")
        if not token:
            raise GSCReconnectRequiredError("Search Console 没有返回访问令牌")
        return token

    def _exchange_code(self, code: str) -> dict[str, Any]:
        return _google_json(
            Request(
                GOOGLE_TOKEN_URL,
                data=urlencode(
                    {
                        "code": code,
                        "client_id": self.settings.google_gsc_client_id,
                        "client_secret": self.settings.google_gsc_client_secret,
                        "redirect_uri": self._redirect_uri,
                        "grant_type": "authorization_code",
                    }
                ).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        )

    @staticmethod
    def _userinfo(access_token: str) -> tuple[str, str | None]:
        if not access_token:
            raise GSCValidationError("Google 没有返回访问令牌")
        payload = _google_json(
            Request(
                GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
        )
        subject = str(payload.get("sub") or "")
        if not subject:
            raise GSCValidationError("Google 没有返回账号标识")
        email = payload.get("email")
        return subject, str(email) if isinstance(email, str) else None

    def _safe_callback_path(self, callback_url: str) -> str:
        base = urlparse(self.settings.gsc_frontend_origin)
        candidate = urlparse(callback_url)
        if candidate.scheme and candidate.netloc:
            if (candidate.scheme, candidate.netloc) != (base.scheme, base.netloc):
                raise GSCValidationError("Search Console 回调地址必须属于当前前端")
            return candidate.path + (f"?{candidate.query}" if candidate.query else "")
        path = callback_url if callback_url.startswith("/") else f"/{callback_url}"
        return path

    @staticmethod
    def _callback_path_with_result(callback_path: str, result: str) -> str:
        parsed = urlsplit(callback_path)
        query = [
            (key, value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if key != "gsc_oauth"
        ]
        query.append(("gsc_oauth", result))
        return urlunsplit(("", "", parsed.path, urlencode(query), ""))

    def _sign_state(self, payload: dict[str, Any]) -> str:
        encoded = _base64url(json.dumps(payload, separators=(",", ":")).encode())
        signature = hmac.new(
            str(self.settings.google_gsc_client_secret).encode(),
            encoded.encode(),
            hashlib.sha256,
        ).digest()
        return f"{encoded}.{_base64url(signature)}"

    def _verify_state(self, state: str) -> dict[str, Any]:
        try:
            encoded, signature = state.split(".", 1)
            expected = hmac.new(
                str(self.settings.google_gsc_client_secret).encode(),
                encoded.encode(),
                hashlib.sha256,
            ).digest()
            if not hmac.compare_digest(_base64url(expected), signature):
                raise ValueError
            payload = json.loads(_base64url_decode(encoded))
            if not isinstance(payload, dict) or int(payload.get("exp") or 0) < int(time.time()):
                raise ValueError
            if not all(
                payload.get(key) for key in ("project_id", "organization_id", "callback_path")
            ):
                raise ValueError
            return payload
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            raise GSCValidationError("Search Console OAuth state 无效或已过期") from exc

    async def _ensure_project(self, project_id: str) -> None:
        if not await self.repository.project_exists(
            self.settings.default_organization_id, project_id
        ):
            raise GSCValidationError("项目不存在")

    def _require_configuration(self) -> None:
        if not self._oauth_configured:
            raise GSCNotConfiguredError("服务器尚未配置 Google Search Console OAuth")
        if not self._encryption_configured:
            raise GSCNotConfiguredError("服务器尚未配置设置加密密钥")

    @property
    def _oauth_configured(self) -> bool:
        return bool(self.settings.google_gsc_client_id and self.settings.google_gsc_client_secret)

    @property
    def _encryption_configured(self) -> bool:
        return bool((self.settings.ai_settings_encryption_key or "").strip())

    @property
    def _encryption_key(self) -> str:
        return str(self.settings.ai_settings_encryption_key or "").strip()

    @property
    def _redirect_uri(self) -> str:
        return self.settings.gsc_public_api_origin.rstrip("/") + "/api/v1/gsc/oauth/callback"


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def resolve_gsc_date_range(
    date_range: GSCDateRange,
    *,
    today: date | None = None,
) -> tuple[date, date]:
    end_date = (today or datetime.now(UTC).date()) - timedelta(days=GSC_DATA_LAG_DAYS)
    if date_range == "last_7_days":
        return end_date - timedelta(days=7), end_date
    if date_range == "last_28_days":
        return end_date - timedelta(days=28), end_date
    target_month = end_date.month - 3
    target_year = end_date.year
    while target_month <= 0:
        target_month += 12
        target_year -= 1
    target_day = min(
        end_date.day,
        calendar.monthrange(target_year, target_month)[1],
    )
    return date(target_year, target_month, target_day), end_date


def previous_gsc_period(start_date: date, end_date: date) -> tuple[date, date]:
    length = max((end_date - start_date).days, 0)
    previous_end = start_date - timedelta(days=1)
    return previous_end - timedelta(days=length), previous_end


def gsc_dimension_filters(
    *,
    device: GSCDevice | None = None,
    country: str | None = None,
) -> list[dict[str, str]]:
    filters: list[dict[str, str]] = []
    if device:
        filters.append({"dimension": "device", "operator": "equals", "expression": device})
    if country:
        filters.append(
            {
                "dimension": "country",
                "operator": "equals",
                "expression": country.casefold(),
            }
        )
    return filters


def gsc_search_payload(
    start_date: date,
    end_date: date,
    *,
    dimensions: list[str],
    filters: list[dict[str, str]],
    row_limit: int,
    start_row: int = 0,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "dimensions": dimensions,
        "rowLimit": row_limit,
        "type": "web",
        "dataState": "all",
    }
    if start_row > 0:
        payload["startRow"] = start_row
    if filters:
        payload["dimensionFilterGroups"] = [{"groupType": "and", "filters": filters}]
    return payload


def gsc_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("rows")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def gsc_performance_totals(value: dict[str, Any]) -> GSCPerformanceTotals:
    def number(key: str) -> float:
        raw = value.get(key)
        return float(raw) if isinstance(raw, (int, float)) else 0

    return GSCPerformanceTotals(
        clicks=number("clicks"),
        impressions=number("impressions"),
        ctr=number("ctr"),
        position=number("position"),
    )


def sum_gsc_totals(rows: list[dict[str, Any]]) -> GSCPerformanceTotals:
    clicks = 0.0
    impressions = 0.0
    weighted_position = 0.0
    for row in rows:
        metrics = gsc_performance_totals(row)
        clicks += metrics.clicks
        impressions += metrics.impressions
        weighted_position += metrics.position * metrics.impressions
    return GSCPerformanceTotals(
        clicks=clicks,
        impressions=impressions,
        ctr=clicks / impressions if impressions > 0 else 0,
        position=weighted_position / impressions if impressions > 0 else 0,
    )


def gsc_dimension_rows(
    rows: list[dict[str, Any]],
) -> list[GSCPerformanceDimensionRow]:
    output: list[GSCPerformanceDimensionRow] = []
    for row in rows:
        keys = row.get("keys")
        key = str(keys[0]).strip() if isinstance(keys, list) and keys else ""
        if not key:
            continue
        output.append(
            GSCPerformanceDimensionRow(
                key=key,
                **gsc_performance_totals(row).model_dump(),
            )
        )
    return output


def build_gsc_striking_distance(
    rows: list[dict[str, Any]],
    *,
    limit: int = GSC_STRIKING_ROW_LIMIT,
) -> list[GSCStrikingDistanceRow]:
    best_by_query: dict[str, GSCStrikingDistanceRow] = {}
    for row in rows:
        keys = row.get("keys")
        if not isinstance(keys, list) or len(keys) < 2:
            continue
        query = str(keys[0]).strip()
        page = str(keys[1]).strip()
        if not query or not page:
            continue
        metrics = gsc_performance_totals(row)
        candidate = GSCStrikingDistanceRow(
            query=query,
            page=page,
            clicks=metrics.clicks,
            impressions=metrics.impressions,
            position=metrics.position,
        )
        current = best_by_query.get(query)
        if (
            current is None
            or candidate.position < current.position
            or (
                candidate.position == current.position
                and candidate.impressions > current.impressions
            )
        ):
            best_by_query[query] = candidate
    return sorted(
        (row for row in best_by_query.values() if 5 <= row.position <= 20),
        key=lambda row: row.impressions,
        reverse=True,
    )[:limit]


def gsc_site_matches_domain(site_url: str, domain: str) -> bool:
    project_host = _normalized_host(domain)
    if not project_host:
        return False
    value = site_url.strip()
    if value.casefold().startswith("sc-domain:"):
        property_host = _normalized_host(value.split(":", 1)[1])
        return bool(
            property_host
            and (project_host == property_host or project_host.endswith(f".{property_host}"))
        )
    property_host = _normalized_host(value)
    return bool(property_host and _without_www(project_host) == _without_www(property_host))


def _normalized_host(value: str) -> str:
    parsed = urlparse(value if "://" in value else f"https://{value}")
    return str(parsed.hostname or "").casefold().rstrip(".")


def _without_www(value: str) -> str:
    return value[4:] if value.startswith("www.") else value


def _base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def _google_json(request: Request) -> dict[str, Any]:
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(response.read())
    except HTTPError as exc:
        detail = exc.read(1000).decode(errors="replace")
        raise GSCUpstreamError(
            f"Google API 返回 HTTP {exc.code}: {detail}", status_code=exc.code
        ) from exc
    except (URLError, TimeoutError) as exc:
        raise GSCUpstreamError("无法连接 Google Search Console") from exc
    except json.JSONDecodeError as exc:
        raise GSCUpstreamError("Google Search Console 返回格式不正确") from exc
    if not isinstance(payload, dict):
        raise GSCUpstreamError("Google Search Console 返回格式不正确")
    return payload


def build_gsc_service() -> GSCService:
    return GSCService(get_settings(), GSCRepository(session_factory))
