from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.backlinks_gateway import PlatformContextResolutionError
from app.core.config import get_settings
from app.core.platform_request_context import ResolvedPlatformRequestContext
from app.db.session import session_factory
from app.modules.agent.backlinks_consent import (
    BacklinksConsentStore,
    ConsentError,
    ConsentRequest,
)
from app.modules.agent.backlinks_continuation_store import BacklinksContinuationStore
from app.modules.agent.backlinks_drafts import DraftRequest
from app.modules.agent.backlinks_draft_review import (
    DraftReviewApproval, approve_reviewed_drafts, review_drafts, review_and_approve,
)
from app.modules.agent.backlinks_read import BacklinksReadError
from app.modules.agent.backlinks_send_batch import (
    BacklinksSendBatchStore,
    SendBatchConfirmation,
    SendBatchPreviewRequest,
)
from app.modules.agent.service import build_agent_service

router = APIRouter(prefix="/automation/consents")


async def consent_context(request: Request, project_id: str) -> ResolvedPlatformRequestContext:
    try:
        return await request.app.state.platform_context_resolver.resolve(
            request=request,
            website_project_key=project_id,
            required_permission="backlinks:read" if request.method == "GET" else "backlinks:write",
        )
    except PlatformContextResolutionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


def consent_store() -> BacklinksConsentStore:
    return BacklinksConsentStore(session_factory)


Context = Annotated[ResolvedPlatformRequestContext, Depends(consent_context)]
Store = Annotated[BacklinksConsentStore, Depends(consent_store)]


class StartContinuationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: bool = Field(strict=True)
    request: DraftRequest
    recommendation_mode: Literal["current", "next_batch"] = "current"


def continuation_store():
    return BacklinksContinuationStore(session_factory)


ContinuationStore = Annotated[BacklinksContinuationStore, Depends(continuation_store)]


def send_batch_store():
    return BacklinksSendBatchStore(session_factory, get_settings())


SendBatchStore = Annotated[BacklinksSendBatchStore, Depends(send_batch_store)]


class AIReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    retry: bool = False


@router.post("/{consent_id}/draft-review/ai")
async def ai_review_drafts(
    consent_id: UUID, body: AIReviewRequest, context: Context, store: SendBatchStore,
):
    try:
        return await review_and_approve(
            store, context, str(consent_id), body.request_id, retry=body.retry,
        )
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except BacklinksReadError as exc:
        raise HTTPException(status_code=409, detail=exc.code) from exc


@router.get("/{consent_id}/draft-review")
async def get_draft_review(consent_id: UUID, context: Context, store: SendBatchStore):
    try:
        return await review_drafts(store, context, str(consent_id))
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except BacklinksReadError as exc:
        raise HTTPException(status_code=409, detail=exc.code) from exc


@router.post("/{consent_id}/draft-review/approve")
async def approve_draft_review(
    consent_id: UUID, body: DraftReviewApproval, context: Context, store: SendBatchStore,
):
    try:
        return await approve_reviewed_drafts(store, context, str(consent_id), body)
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except BacklinksReadError as exc:
        raise HTTPException(status_code=409, detail=exc.code) from exc


@router.get("/{consent_id}/send-batches")
async def list_send_batches(consent_id: UUID, context: Context, store: SendBatchStore):
    try:
        return await store.list(context, str(consent_id))
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.get("/{consent_id}/mail-monitoring")
async def mail_monitoring(consent_id: UUID, context: Context, store: SendBatchStore):
    from app.modules.agent.backlinks_mail_monitoring import monitor_batches
    try:
        async with store.sessions() as session:
            consent = await store.consent(session, context, str(consent_id))
        async def authority(project, organization, *, write):
            if project != consent.project_id or organization != consent.organization_id or write:
                raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
            return context
        reader = store.drafts(authority).reader
        async def read(name, args):
            return await reader.read(consent.project_id, consent.organization_id, name, args)
        return await monitor_batches(await store.list(context, str(consent_id)), read)
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.post("/{consent_id}/send-batches/preview")
async def preview_send_batch(
    consent_id: UUID, body: SendBatchPreviewRequest, context: Context, store: SendBatchStore,
):
    try:
        return await store.preview(context, str(consent_id), body)
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except (BacklinksReadError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(
            status_code=409, detail=exc.code if isinstance(exc, BacklinksReadError)
            else "BACKLINKS_SEND_PREFLIGHT_INVALID",
        ) from exc


@router.post("/{consent_id}/send-batches/{batch_id}/confirm", status_code=202)
async def confirm_send_batch(
    consent_id: UUID, batch_id: UUID, body: SendBatchConfirmation, context: Context, store: SendBatchStore,
):
    try:
        return await store.confirm(
            context, str(consent_id), str(batch_id), body, build_agent_service().limits,
        )
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.post("/{consent_id}/send-batches/{batch_id}/revoke")
async def revoke_send_batch(consent_id: UUID, batch_id: UUID, context: Context, store: SendBatchStore):
    try:
        return await store.revoke(context, str(consent_id), str(batch_id))
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.get("")
async def list_consents(context: Context, store: Store):
    try:
        return await store.list(context)
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.post("/{consent_id}/start", status_code=202)
async def start_continuation(
    consent_id: UUID, body: StartContinuationRequest, context: Context, store: ContinuationStore,
):
    if body.confirmed is not True:
        raise HTTPException(status_code=422, detail="BACKLINKS_AUTOMATION_CONFIRMATION_REQUIRED")
    try:
        return await store.start(
            context, str(consent_id), body.request.model_dump(mode="json"),
            build_agent_service().limits,
            recommendation_mode=body.recommendation_mode,
        )
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.get("/{consent_id}/execution")
async def get_continuation(consent_id: UUID, context: Context, store: ContinuationStore):
    try:
        return await store.get(context, str(consent_id))
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.post("")
async def create_consent(body: ConsentRequest, context: Context, store: Store):
    try:
        return await store.create(context, body)
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.get("/{consent_id}")
async def get_consent(consent_id: UUID, context: Context, store: Store):
    try:
        return await store.get(context, str(consent_id))
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc


@router.post("/{consent_id}/revoke")
async def revoke_consent(consent_id: UUID, context: Context, store: Store):
    try:
        return await store.revoke(context, str(consent_id))
    except ConsentError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
