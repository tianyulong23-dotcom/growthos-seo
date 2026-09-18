"""Durable consent records, not session credentials or send confirmations."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.modules.agent.models import AgentBacklinksConsent, AgentBacklinksContinuation, AgentRun

CONSENT_TOOLS = (
    "start_backlink_recommendations",
    "join_backlink_recommendations",
    "create_backlink_drafts",
)


class ConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: UUID
    policy_version: Literal["backlinks-drafts-only.v1"]
    confirmed: Literal[True]
    expires_at: AwareDatetime
    max_opportunities: int = Field(ge=1, le=100, strict=True)
    max_drafts: int = Field(ge=1, le=100, strict=True)
    max_model_cost_usd: Decimal = Field(gt=0, le=100, max_digits=6, decimal_places=2)
    max_paid_tool_cost_usd: Decimal = Field(ge=0, le=100, max_digits=6, decimal_places=2)

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("explicit boolean confirmation required")
        return value

    @model_validator(mode="after")
    def bounded_drafts(self):
        if self.max_drafts > self.max_opportunities:
            raise ValueError("max_drafts exceeds max_opportunities")
        return self

    def policy(self) -> dict:
        policy = self.model_dump(mode="json", exclude={"request_id", "expires_at", "confirmed"})
        for field in ("max_model_cost_usd", "max_paid_tool_cost_usd"):
            policy[field] = format(getattr(self, field).normalize(), "f")
        return policy


class ConsentError(ValueError):
    def __init__(self, code: str, status: int = 403):
        super().__init__(code)
        self.code, self.status = code, status


def scope(context):
    return (
        AgentBacklinksConsent.organization_id == context.tenant.organization_id,
        AgentBacklinksConsent.workspace_id == context.tenant.workspace_id,
        AgentBacklinksConsent.project_id == context.project.website_project_id,
        AgentBacklinksConsent.user_id == context.actor.user_id,
    )


def consent_state(record, now: datetime) -> str:
    if record.revoked_at is not None:
        return "revoked"
    if not record.created_at <= now < record.expires_at:
        return "expired"
    return "active"


def view(record, now: datetime) -> dict:
    chat_send = record.policy_json.get("policy_version") == "backlinks-chat-send.v1"
    return {
        "id": record.id,
        "state": consent_state(record, now),
        "policy": record.policy_json,
        "allowed_tools": [] if chat_send else list(CONSENT_TOOLS),
        "created_at": record.created_at,
        "expires_at": record.expires_at,
        "revoked_at": record.revoked_at,
        "automation_enabled": False,
        "sending_allowed": (
            record.policy_json.get("policy_version") == "backlinks-chat-campaign.v1"
            and record.policy_json.get("send_authorized") is True
            and consent_state(record, now) == "active"
        ),
    }


class BacklinksConsentStore:
    def __init__(self, sessions):
        self.sessions = sessions

    async def list(self, context, *, now=None) -> dict:
        if "backlinks:read" not in context.permissions:
            raise ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
        now = now or datetime.now(UTC)
        async with self.sessions() as session:
            records = (await session.scalars(
                select(AgentBacklinksConsent).where(*scope(context)).order_by(
                    AgentBacklinksConsent.created_at.desc(), AgentBacklinksConsent.id.desc(),
                ).limit(20)
            )).all()
            return {"items": [await self._view(session, record, now) for record in records]}

    async def _view(self, session, record, now):
        result = view(record, now)
        if result["state"] == "active":
            result["automation_enabled"] = (await session.scalar(
                select(AgentRun.id).join(
                    AgentBacklinksContinuation, AgentBacklinksContinuation.run_id == AgentRun.id,
                ).where(
                    AgentBacklinksContinuation.consent_id == record.id,
                    AgentRun.status.in_({"queued", "running", "executing", "verifying"}),
                )
            )) is not None
        return result

    async def create(self, context, request: ConsentRequest, *, now=None) -> dict:
        now = now or datetime.now(UTC)
        if "backlinks:write" not in context.permissions:
            raise ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
        async with self.sessions() as session, session.begin():
            identity = (*scope(context), AgentBacklinksConsent.request_id == str(request.request_id))
            record = await session.scalar(select(AgentBacklinksConsent).where(*identity))
            if record is None:
                if not now < request.expires_at <= now + timedelta(days=7):
                    raise ConsentError("BACKLINKS_CONSENT_EXPIRY_INVALID", 422)
                await session.execute(
                    pg_insert(AgentBacklinksConsent).values(
                        id=str(uuid4()),
                        organization_id=context.tenant.organization_id,
                        workspace_id=context.tenant.workspace_id,
                        project_id=context.project.website_project_id,
                        user_id=context.actor.user_id,
                        request_id=str(request.request_id),
                        policy_json=request.policy(),
                        created_at=now,
                        expires_at=request.expires_at,
                    ).on_conflict_do_nothing(constraint="uq_agent_backlinks_consents_request")
                )
                record = await session.scalar(select(AgentBacklinksConsent).where(*identity))
            if record.policy_json != request.policy() or record.expires_at != request.expires_at:
                raise ConsentError("BACKLINKS_CONSENT_REQUEST_CONFLICT", 409)
            # Retrying an old request never extends or reactivates its authority.
            return await self._view(session, record, now)

    async def get(self, context, consent_id: str, *, now=None) -> dict:
        if "backlinks:read" not in context.permissions:
            raise ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
        async with self.sessions() as session:
            record = await session.scalar(
                select(AgentBacklinksConsent).where(
                    *scope(context), AgentBacklinksConsent.id == consent_id,
                )
            )
            if record is None:
                raise ConsentError("BACKLINKS_CONSENT_NOT_FOUND", 404)
            return await self._view(session, record, now or datetime.now(UTC))

    async def revoke(self, context, consent_id: str, *, now=None) -> dict:
        now = now or datetime.now(UTC)
        if "backlinks:write" not in context.permissions:
            raise ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
        async with self.sessions() as session, session.begin():
            identity = (*scope(context), AgentBacklinksConsent.id == consent_id)
            await session.execute(
                update(AgentBacklinksConsent).where(
                    *identity, AgentBacklinksConsent.revoked_at.is_(None),
                ).values(revoked_at=now)
            )
            record = await session.scalar(select(AgentBacklinksConsent).where(*identity))
            if record is None:
                raise ConsentError("BACKLINKS_CONSENT_NOT_FOUND", 404)
            return await self._view(session, record, now)
