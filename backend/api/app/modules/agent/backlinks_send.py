"""Submit existing send intents; authority never comes from model arguments."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import UUID

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.core.platform_request_context import ResolvedPlatformRequestContext
from app.modules.agent.backlinks_drafts import BacklinksDrafts
from app.modules.agent.backlinks_preflight import PreflightArgs
from app.modules.agent.backlinks_read import BacklinksReadError


class SendArgs(PreflightArgs):
    """Only target IDs and versions are exposed in the model tool schema."""


class ConfirmedSendCommand(BaseModel):
    """Server-held command, not a tool argument or an authorization issuer."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    organization_id: str
    workspace_id: str
    project_id: str
    user_id: str
    operation_id: str = Field(min_length=1, max_length=200)
    expires_at: AwareDatetime
    target: SendArgs
    readiness_snapshot: dict
    human_confirmation: dict


class SendConfirmationSource(Protocol):
    async def load(
        self, context: ResolvedPlatformRequestContext, operation_id: str,
    ) -> ConfirmedSendCommand | None:
        """Load a still-valid, non-revoked confirmation from trusted server storage."""
        ...


class SendReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sendIntentId: UUID
    sendSnapshotId: UUID
    draftId: UUID
    approvedDraftVersionId: UUID
    contactId: UUID
    contactVersion: int = Field(ge=1, strict=True)
    status: Literal["READY"]
    version: Literal[1]
    requestedSendAt: AwareDatetime
    meta: dict


def confirmation_fingerprint(command: ConfirmedSendCommand) -> str:
    payload = json.dumps(command.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


class BacklinksSender:
    def __init__(
        self, drafts: BacklinksDrafts, confirmations: SendConfirmationSource | None = None,
    ) -> None:
        self.drafts = drafts
        self.confirmations = confirmations

    async def authorized_command(
        self, project_id: str, organization_id: str, delegation: dict | None,
        arguments: dict, operation_id: str,
    ) -> ConfirmedSendCommand:
        target = SendArgs.model_validate(arguments)
        reader = self.drafts.reader
        context = await reader.resolve_write_context(
            project_id, organization_id, delegation, write=True,
        )
        command = (
            await self.confirmations.load(context, operation_id)
            if self.confirmations is not None else None
        )
        if command is None:
            raise BacklinksReadError(
                "BACKLINKS_SEND_AUTHORIZATION_REQUIRED: No send request was made. "
                "A server-held send confirmation is required; chat instructions are not authority."
            )
        command = command.model_copy(deep=True)
        if (
            command.organization_id != organization_id
            or command.workspace_id != context.tenant.workspace_id
            or command.project_id != project_id
            or command.user_id != context.actor.user_id
            or command.operation_id != operation_id
            or command.target != target
        ):
            raise BacklinksReadError("BACKLINKS_SEND_AUTHORIZATION_SCOPE_MISMATCH")
        if command.expires_at <= datetime.now(UTC):
            raise BacklinksReadError("BACKLINKS_SEND_AUTHORIZATION_EXPIRED")
        confirmation = command.human_confirmation
        if (
            confirmation.get("confirmed") is not True
            or not command.readiness_snapshot.get("snapshotVersion")
            or confirmation.get("readinessSnapshotVersion")
            != command.readiness_snapshot["snapshotVersion"]
        ):
            raise BacklinksReadError("BACKLINKS_SEND_CONFIRMATION_INVALID")
        return command

    async def submit(
        self, project_id: str, organization_id: str, delegation: dict | None, arguments: dict,
        confirmation_hash: str,
    ) -> dict:
        operation_id = arguments["operation_id"]
        target = {k: v for k, v in arguments.items() if k != "operation_id"}
        # Reload at execution, not only preparation: revoked grants must fail closed.
        command = await self.authorized_command(
            project_id, organization_id, delegation, target, operation_id,
        )
        if confirmation_fingerprint(command) != confirmation_hash:
            raise BacklinksReadError("BACKLINKS_SEND_CONFIRMATION_CHANGED")
        body = command.target.model_dump(mode="json", exclude={"draftId"})
        body.update({
            "readinessSnapshot": command.readiness_snapshot,
            "humanConfirmation": command.human_confirmation,
        })
        try:
            data = await self.drafts._request(
                project_id, organization_id, delegation,
                f"drafts/{command.target.draftId}/send-intents",
                body=body, operation_id=operation_id, success_statuses=(201,),
            )
            receipt = SendReceipt.model_validate(data)
            if any(
                getattr(receipt, key) != getattr(command.target, key)
                for key in ("draftId", "approvedDraftVersionId", "contactId", "contactVersion")
            ):
                raise BacklinksReadError("BACKLINKS_SEND_RECEIPT_TARGET_MISMATCH")
        except (BacklinksReadError, httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
            # The command may have committed even when its response was lost or invalid.
            # Core owns retry/reconciliation; never generate a replacement operation ID here.
            raise BacklinksReadError(
                "BACKLINKS_SEND_SUBMISSION_UNVERIFIED: Inspect saved send intents for this draft "
                "before retrying; preserve the operation ID and original confirmed payload. "
                "Do not claim sent or automatically resubmit.",
                retryable=False,
            ) from exc
        return {
            "verified": True, "verification": "persisted_send_intent_acceptance_only",
            "operation_id": operation_id,
            **receipt.model_dump(mode="json", exclude={"meta"}),
            "next": "Read get_backlink_send_intent. READY is queued, not proof of sending "
            "or delivery. Existing workers own pacing, retries and reconciliation.",
        }
