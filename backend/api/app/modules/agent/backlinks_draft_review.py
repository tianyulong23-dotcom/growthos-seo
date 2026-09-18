"""Human review adapter; approvals reuse Core optimistic locking and idempotency."""
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.agent.backlinks_consent import ConsentError
from app.modules.agent.backlinks_pipeline import child_operation
from app.modules.agent.backlinks_quality import BacklinksQuality


class DraftApprovalItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_id: UUID
    version_id: UUID
    expected_version: int = Field(strict=True, ge=1)


class DraftReviewApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    confirmed: bool = Field(strict=True)
    items: list[DraftApprovalItem] = Field(min_length=1, max_length=20)


async def review_drafts(store, context, consent_id):
    async with store.sessions() as session:
        consent = await store.consent(session, context, consent_id)
        candidates = await store.candidates(session, consent)
        if len(candidates) > 20:
            raise ConsentError("BACKLINKS_DRAFT_REVIEW_LIMIT", 409)

    async def authority(project, organization, *, write):
        if project != consent.project_id or organization != consent.organization_id:
            raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
        return context

    drafts = store.drafts(authority)
    quality = await BacklinksQuality(store).reports(context, consent_id)
    items = []
    for draft_id in candidates:
        draft = (await drafts._request(
            consent.project_id, consent.organization_id, None, f"drafts/{UUID(draft_id)}",
        ))["draft"]
        version = draft.get("currentVersion") or {}
        fresh = draft.get("freshness") or {}
        if draft.get("id") != draft_id:
            raise ConsentError("BACKLINKS_DRAFT_REVIEW_MISMATCH", 409)
        items.append({
            "draft_id": draft_id, "version_id": version.get("id"),
            "expected_version": draft.get("draftVersion"),
            "quality": quality.get(draft_id),
            "subject": version.get("subjectText"), "body": version.get("bodyText"),
            "approved": draft.get("approvedVersionId") == version.get("id") and bool(version.get("id")),
            "reviewable": bool(version.get("id") and version.get("subjectText") and version.get("bodyText")
                               and fresh.get("state") == "FRESH"
                               and fresh.get("regenerateRequired") is False),
        })
        report = items[-1]["quality"]
        if report and (report["version_id"] != version.get("id") or not items[-1]["reviewable"]):
            items[-1]["quality"] = {**report, "state": "STALE"}
    return {"items": items, "sent": False}


async def approve_reviewed_drafts(store, context, consent_id, request):
    if not request.confirmed:
        raise ConsentError("BACKLINKS_DRAFT_REVIEW_CONFIRMATION_REQUIRED", 422)
    if len({item.draft_id for item in request.items}) != len(request.items):
        raise ConsentError("BACKLINKS_DRAFT_REVIEW_DUPLICATE", 422)
    reviewed = {item["draft_id"]: item for item in (await review_drafts(store, context, consent_id))["items"]}
    for item in request.items:
        saved = reviewed.get(str(item.draft_id))
        if (not saved or not saved["reviewable"] or saved["version_id"] != str(item.version_id)
            or (not saved["approved"] and saved["expected_version"] != item.expected_version)):
            raise ConsentError("BACKLINKS_DRAFT_REVIEW_CHANGED", 409)
        if saved.get("quality"):
            await BacklinksQuality(store).require_pass(context, consent_id, str(item.draft_id))
    results = []
    for item in request.items:
        async with store.sessions() as session, session.begin():
            consent = await store.consent(session, context, consent_id, write=True, active=True)

        async def authority(project, organization, *, write):
            if project != consent.project_id or organization != consent.organization_id:
                raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
            return context

        if not reviewed[str(item.draft_id)]["approved"]:
            receipt = await store.drafts(authority)._request(
                consent.project_id, consent.organization_id, None, f"drafts/{item.draft_id}/approve",
                body={"expectedVersion": item.expected_version},
                operation_id=child_operation(str(request.request_id), f"approve:{item.draft_id}"),
            )
            if receipt.get("versionId") != str(item.version_id):
                raise ConsentError("BACKLINKS_DRAFT_APPROVAL_UNVERIFIED", 409)
        results.append(str(item.draft_id))
    return {"approved_draft_ids": results, "sent": False}


async def review_and_approve(store, context, consent_id, request_id, *, retry=False):
    from app.modules.agent.backlinks_quality_repair import BacklinksQualityRepair
    saved = await review_drafts(store, context, consent_id)
    ids = [item["draft_id"] for item in saved["items"]]
    if not ids:
        return {"items": [], "approved_draft_ids": [], "sent": False}
    quality = BacklinksQuality(store)
    review = await BacklinksQualityRepair(store, quality=quality).evaluate(
        context, consent_id, ids, retry=retry,
    )
    saved = await review_drafts(store, context, consent_id)
    passed = {item["draft_id"] for item in review["items"] if item["state"] == "PASSED"}
    selected = [item for item in saved["items"] if item["draft_id"] in passed]
    for item in selected:
        await quality.require_pass(context, consent_id, item["draft_id"])
    approved = await approve_reviewed_drafts(store, context, consent_id, DraftReviewApproval(
        request_id=request_id, confirmed=True,
        items=[DraftApprovalItem(**{k: item[k] for k in ("draft_id", "version_id", "expected_version")})
               for item in selected],
    )) if selected else {"approved_draft_ids": [], "sent": False}
    return {**review, **approved}
