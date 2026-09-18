import base64
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field, ValidationError


PLATFORM_ACCESS_TOKEN_VERSION = "PlatformAccessToken.v1"
PLATFORM_ACCESS_TOKEN_AUDIENCE = "growthos-platform-gateway"
PERMISSION_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$")


class _AccessTokenActor(BaseModel):
    model_config = ConfigDict(alias_generator=None, extra="forbid")

    user_id: str = Field(alias="userId", min_length=1, max_length=200)
    session_id: str = Field(alias="sessionId", min_length=1, max_length=200)


class _AccessTokenMembership(BaseModel):
    model_config = ConfigDict(alias_generator=None, extra="forbid")

    organization_id: str = Field(alias="organizationId", min_length=1, max_length=200)
    workspace_id: str = Field(alias="workspaceId", min_length=1, max_length=200)
    roles: list[str] = Field(min_length=1, max_length=32)
    project_ids: list[str] = Field(alias="projectIds", min_length=1, max_length=256)
    permissions: list[str] = Field(min_length=1, max_length=128)


class _AccessTokenPayload(BaseModel):
    model_config = ConfigDict(alias_generator=None, extra="forbid")

    version: str
    issuer: str
    audience: str
    issued_at: datetime = Field(alias="issuedAt")
    expires_at: datetime = Field(alias="expiresAt")
    actor: _AccessTokenActor
    memberships: list[_AccessTokenMembership] = Field(min_length=1, max_length=128)


@dataclass(frozen=True)
class AuthenticatedPlatformMembership:
    organization_id: str
    workspace_id: str
    roles: tuple[str, ...]
    project_ids: tuple[str, ...]
    permissions: tuple[str, ...]


@dataclass(frozen=True)
class AuthenticatedPlatformActor:
    user_id: str
    session_id: str
    memberships: tuple[AuthenticatedPlatformMembership, ...]
    expires_at: datetime | None = None


class PlatformAuthenticationError(RuntimeError):
    def __init__(self, *, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class HmacPlatformAuthenticationAuthority:
    def __init__(
        self,
        *,
        issuer: str,
        signing_key: bytes | str,
        max_token_ttl_seconds: int,
    ) -> None:
        self._issuer = issuer
        self._signing_key = (
            signing_key.encode("utf-8") if isinstance(signing_key, str) else signing_key
        )
        self._max_token_ttl_seconds = max_token_ttl_seconds
        if len(self._signing_key) < 32:
            raise ValueError("platform auth signing key must contain at least 32 bytes")
        if max_token_ttl_seconds < 1:
            raise ValueError("platform auth maximum token TTL must be positive")

    def authenticate(
        self,
        authorization: str | None,
        *,
        now: datetime,
    ) -> AuthenticatedPlatformActor:
        token = self._bearer_token(authorization)
        encoded_payload, encoded_signature = self._split_token(token)
        expected_signature = hmac.new(
            self._signing_key,
            f"{PLATFORM_ACCESS_TOKEN_VERSION}.{encoded_payload}".encode("ascii"),
            hashlib.sha256,
        ).digest()
        try:
            supplied_signature = self._decode_base64url(encoded_signature)
        except ValueError as error:
            raise self._invalid_token() from error
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise self._invalid_token()

        try:
            payload = _AccessTokenPayload.model_validate_json(
                self._decode_base64url(encoded_payload)
            )
        except (ValidationError, ValueError, json.JSONDecodeError) as error:
            raise self._invalid_token() from error

        normalized_now = self._aware_utc(now, field="now")
        issued_at = self._aware_utc(payload.issued_at, field="issuedAt")
        expires_at = self._aware_utc(payload.expires_at, field="expiresAt")
        if payload.version != PLATFORM_ACCESS_TOKEN_VERSION:
            raise self._invalid_token()
        if payload.issuer != self._issuer or payload.audience != PLATFORM_ACCESS_TOKEN_AUDIENCE:
            raise self._invalid_token()
        if issued_at > normalized_now:
            raise self._invalid_token()
        if expires_at <= normalized_now:
            raise PlatformAuthenticationError(
                code="PLATFORM_ACCESS_TOKEN_EXPIRED",
                detail="The platform access token has expired.",
            )
        lifetime_seconds = (expires_at - issued_at).total_seconds()
        if lifetime_seconds <= 0 or lifetime_seconds > self._max_token_ttl_seconds:
            raise self._invalid_token()

        memberships = tuple(self._membership(claim) for claim in payload.memberships)
        if len(set(memberships)) != len(memberships):
            raise self._invalid_token()
        return AuthenticatedPlatformActor(
            user_id=self._identifier("actor.userId", payload.actor.user_id),
            session_id=self._identifier("actor.sessionId", payload.actor.session_id),
            memberships=memberships,
            expires_at=expires_at,
        )

    def _membership(
        self,
        claim: _AccessTokenMembership,
    ) -> AuthenticatedPlatformMembership:
        permissions = self._unique_values("permissions", claim.permissions)
        if any(not PERMISSION_PATTERN.fullmatch(value) for value in permissions):
            raise self._invalid_token()
        return AuthenticatedPlatformMembership(
            organization_id=self._identifier(
                "membership.organizationId",
                claim.organization_id,
            ),
            workspace_id=self._identifier(
                "membership.workspaceId",
                claim.workspace_id,
            ),
            roles=self._unique_values("roles", claim.roles),
            project_ids=self._unique_values("projectIds", claim.project_ids),
            permissions=permissions,
        )

    @staticmethod
    def _bearer_token(authorization: str | None) -> str:
        if authorization is None:
            raise PlatformAuthenticationError(
                code="PLATFORM_AUTHENTICATION_REQUIRED",
                detail="A platform bearer token is required.",
            )
        scheme, separator, token = authorization.partition(" ")
        if separator != " " or scheme.lower() != "bearer" or not token.strip():
            raise PlatformAuthenticationError(
                code="PLATFORM_AUTHENTICATION_REQUIRED",
                detail="A valid platform bearer token is required.",
            )
        if token != token.strip():
            raise HmacPlatformAuthenticationAuthority._invalid_token()
        return token

    @staticmethod
    def _split_token(token: str) -> tuple[str, str]:
        parts = token.split(".")
        if len(parts) != 2 or not all(parts):
            raise HmacPlatformAuthenticationAuthority._invalid_token()
        return parts[0], parts[1]

    @staticmethod
    def _decode_base64url(value: str) -> bytes:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("invalid base64url")
        return base64.b64decode(
            value + "=" * (-len(value) % 4),
            altchars=b"-_",
            validate=True,
        )

    @staticmethod
    def _aware_utc(value: datetime, *, field: str) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise PlatformAuthenticationError(
                code="PLATFORM_ACCESS_TOKEN_INVALID",
                detail=f"The platform access token {field} must include a timezone.",
            )
        return value.astimezone(UTC)

    @staticmethod
    def _identifier(field: str, value: str) -> str:
        if value != value.strip():
            raise HmacPlatformAuthenticationAuthority._invalid_token()
        if not value or len(value) > 200:
            raise HmacPlatformAuthenticationAuthority._invalid_token()
        return value

    @staticmethod
    def _unique_values(field: str, values: list[str]) -> tuple[str, ...]:
        normalized = tuple(
            HmacPlatformAuthenticationAuthority._identifier(field, value) for value in values
        )
        if len(set(normalized)) != len(normalized):
            raise HmacPlatformAuthenticationAuthority._invalid_token()
        return normalized

    @staticmethod
    def _invalid_token() -> PlatformAuthenticationError:
        return PlatformAuthenticationError(
            code="PLATFORM_ACCESS_TOKEN_INVALID",
            detail="The platform access token is invalid.",
        )
