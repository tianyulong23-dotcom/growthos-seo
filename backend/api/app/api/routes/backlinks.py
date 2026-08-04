from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolutionError,
    PlatformContextResolver,
    problem_response,
)

router = APIRouter(tags=["backlinks"])


async def _forward(request: Request, website_project_key: str) -> Response:
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    gateway: BacklinksGateway = request.app.state.backlinks_gateway
    try:
        resolved = await resolver.resolve(
            request=request,
            website_project_key=website_project_key,
        )
    except PlatformContextResolutionError as error:
        return problem_response(
            status=error.status,
            problem_type=f"urn:growthos:problem:platform:{error.code.lower().replace('_', '-')}",
            title=error.title,
            detail=error.detail,
            code=error.code,
            request_id=request.headers.get("x-request-id", "unresolved"),
            retryable=False,
        )
    return await gateway.forward(
        request,
        resolved=resolved,
        website_project_key=website_project_key,
    )


async def _forward_gmail_push(request: Request) -> Response:
    gateway: BacklinksGateway = request.app.state.backlinks_gateway
    return await gateway.forward_gmail_push(request)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/context",
    include_in_schema=False,
)
async def backlinks_context(request: Request, websiteProjectKey: str) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates",
    include_in_schema=False,
)
async def backlinks_contact_candidates(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates/{candidateId}/confirm",
    include_in_schema=False,
)
async def confirm_backlinks_contact_candidate(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/placement-candidates",
    include_in_schema=False,
)
async def create_backlinks_placement_candidate(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/placement-candidates/{candidateId}/confirm",
    include_in_schema=False,
)
async def confirm_backlinks_placement_candidate(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/placement-candidates/{candidateId}/reject",
    include_in_schema=False,
)
async def reject_backlinks_placement_candidate(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/links",
    include_in_schema=False,
)
async def backlinks_links(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/links/candidates/{candidateId}",
    include_in_schema=False,
)
async def backlinks_candidate_link(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/links/placements/{placementId}",
    include_in_schema=False,
)
async def backlinks_placement_link(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/links/placements/{placementId}/events",
    include_in_schema=False,
)
async def backlinks_placement_lifecycle_events(
    request: Request,
    websiteProjectKey: str,
    placementId: str,
) -> Response:
    del placementId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/links/evidence/{evidenceId}",
    include_in_schema=False,
)
async def backlinks_placement_evidence(
    request: Request,
    websiteProjectKey: str,
    evidenceId: str,
) -> Response:
    del evidenceId
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/links/placements/{placementId}/reverify",
    include_in_schema=False,
)
async def reverify_backlinks_placement(
    request: Request,
    websiteProjectKey: str,
    placementId: str,
) -> Response:
    del placementId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendations",
    include_in_schema=False,
)
async def backlinks_recommendations(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendations/{recommendationId}/reject",
    include_in_schema=False,
)
async def reject_backlinks_recommendation(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-refill-jobs",
    include_in_schema=False,
)
async def create_backlinks_recommendation_refill_job(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities",
    include_in_schema=False,
)
async def backlinks_opportunities(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}",
    include_in_schema=False,
)
async def backlinks_opportunity(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/assessments/{opportunityId}",
    include_in_schema=False,
)
async def backlinks_assessment(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}/draft-jobs",
    include_in_schema=False,
)
async def create_backlinks_draft_job(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/draft-jobs/{jobId}",
    include_in_schema=False,
)
async def backlinks_draft_job(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}",
    include_in_schema=False,
)
async def backlinks_draft(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/versions",
    include_in_schema=False,
)
async def save_backlinks_draft_version(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/approve",
    include_in_schema=False,
)
async def approve_backlinks_draft(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/send-intents",
    include_in_schema=False,
)
async def create_backlinks_send_intent(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}/transition",
    include_in_schema=False,
)
async def transition_backlinks_opportunity(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.patch(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}/management",
    include_in_schema=False,
)
async def patch_backlinks_opportunity_management(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/summary",
    include_in_schema=False,
)
async def backlinks_summary(request: Request, websiteProjectKey: str) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/connect",
    include_in_schema=False,
)
async def connect_backlinks_gmail(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/callback",
    include_in_schema=False,
)
async def complete_backlinks_gmail_connection(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/status",
    include_in_schema=False,
)
async def backlinks_gmail_connection_status(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/{connectionId}/disconnect",
    include_in_schema=False,
)
async def disconnect_backlinks_gmail(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/replies/{inboundMessageId}/match-candidates",
    include_in_schema=False,
)
async def backlinks_reply_match_candidates(
    request: Request,
    websiteProjectKey: str,
    inboundMessageId: str,
) -> Response:
    del inboundMessageId
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/replies/{inboundMessageId}/match-candidates/{candidateId}/confirm",
    include_in_schema=False,
)
async def confirm_backlinks_reply_match_candidate(
    request: Request,
    websiteProjectKey: str,
    inboundMessageId: str,
    candidateId: str,
) -> Response:
    del inboundMessageId, candidateId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/mail/messages",
    include_in_schema=False,
)
async def backlinks_mail_messages(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/mail/messages/{messageId}",
    include_in_schema=False,
)
async def backlinks_mail_message(
    request: Request,
    websiteProjectKey: str,
    messageId: str,
) -> Response:
    del messageId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/mail/threads/{threadId}",
    include_in_schema=False,
)
async def backlinks_mail_thread(
    request: Request,
    websiteProjectKey: str,
    threadId: str,
) -> Response:
    del threadId
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/backlinks/mail/gmail-push",
    include_in_schema=False,
)
async def backlinks_gmail_push(request: Request) -> Response:
    return await _forward_gmail_push(request)
