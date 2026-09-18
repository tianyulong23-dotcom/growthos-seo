from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.agent.backlinks_drafts import BacklinksDrafts
from app.modules.agent.backlinks_read import BacklinksReadError


class PreflightArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draftId: UUID
    approvedDraftVersionId: UUID
    contactId: UUID
    contactVersion: int = Field(ge=1, strict=True)
    gmailConnectionId: UUID
    messagePurpose: Literal["INITIAL_OUTREACH", "FOLLOW_UP", "NEGOTIATION_REPLY"]
    followUpIndex: int = Field(ge=0, le=2, strict=True)

    @model_validator(mode="after")
    def purpose_matches_index(self):
        if (self.messagePurpose == "FOLLOW_UP") != (self.followUpIndex > 0):
            raise ValueError("BACKLINKS_PREFLIGHT_PURPOSE_INDEX_MISMATCH")
        return self


async def preflight(drafts: BacklinksDrafts, project_id, organization_id, delegation, arguments):
    values = PreflightArgs.model_validate({
        k: v for k, v in arguments.items() if k != "operation_id"
    }).model_dump(mode="json")
    draft_id = values.pop("draftId")
    evidence = await drafts.read(
        project_id, organization_id, delegation, "get_backlink_draft", {"draftId": draft_id},
    )
    draft = evidence["data"]["draft"]
    if (
        draft.get("approvedVersionId") != values["approvedDraftVersionId"]
        or (draft.get("currentVersion") or {}).get("id") != values["approvedDraftVersionId"]
        or draft.get("contactId") != values["contactId"]
        or draft.get("contactVersion") != values["contactVersion"]
        or not evidence["checks"]["fresh"]
        or not evidence["checks"]["hasText"]
        or not evidence["checks"]["contactMatchesSnapshot"]
    ):
        raise BacklinksReadError("BACKLINKS_PREFLIGHT_REQUIRES_CURRENT_APPROVED_DRAFT")
    data = await drafts._request(
        project_id, organization_id, delegation,
        f"drafts/{draft_id}/send-preflight", body=values,
    )
    if (
        data.get("allowed") is not True or data.get("deliveryState") != "NOT_SENT"
        or not isinstance(data.get("readinessSnapshot"), dict)
        or not isinstance(data.get("gmail"), dict)
        or data["gmail"].get("connectionId") != values["gmailConnectionId"]
    ):
        raise BacklinksReadError("BACKLINKS_PREFLIGHT_INVALID_RESPONSE")
    return {
        "verified": True, "verification": "preflight_only",
        "operation_id": arguments["operation_id"],
        "draftId": draft_id, "approvedDraftVersionId": values["approvedDraftVersionId"],
        "allowed": True, "deliveryState": "NOT_SENT", "checkedAt": data.get("checkedAt"),
        "next": "Human confirmation on the existing draft page is required. No email was sent.",
    }
