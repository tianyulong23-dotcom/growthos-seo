import json
from collections.abc import Sequence
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse, Response

from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolutionError,
    PlatformContextResolver,
    problem_response,
)

router = APIRouter(tags=["backlinks"])

_GOOGLE_OAUTH_CALLBACK_QUERY_KEYS = frozenset(
    {"code", "state", "iss", "scope", "authuser", "prompt"}
)
_GOOGLE_OAUTH_ISSUER = "https://accounts.google.com"


async def _forward(
    request: Request,
    website_project_key: str,
    *,
    query_params: Sequence[tuple[str, str]] | None = None,
) -> Response:
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
        query_params=query_params,
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


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}/contacts",
    include_in_schema=False,
)
async def backlinks_opportunity_contacts(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/"
    "{opportunityId}/contacts/candidates",
    include_in_schema=False,
)
async def create_backlinks_manual_contact_candidate(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendations/"
    "{recommendationId}/contact-enrichment-jobs",
    include_in_schema=False,
)
async def start_backlinks_contact_enrichment(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/contact-enrichment-jobs/{jobId}",
    include_in_schema=False,
)
async def backlinks_contact_enrichment_job(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/contact-enrichment-jobs/{jobId}/retry",
    include_in_schema=False,
)
async def retry_backlinks_contact_enrichment(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendations/"
    "{recommendationId}/contacts/candidates",
    include_in_schema=False,
)
async def add_backlinks_public_contact_candidate(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.patch(
    "/api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates/{candidateId}",
    include_in_schema=False,
)
async def correct_backlinks_contact_candidate(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/metrics/dashboard",
    include_in_schema=False,
)
async def backlinks_metric_dashboard(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/reports",
    include_in_schema=False,
)
async def backlinks_published_reports(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/reports/{reportKey}/revisions/"
    "{reportRevisionId}/exports",
    include_in_schema=False,
)
async def request_backlinks_report_export(
    request: Request,
    websiteProjectKey: str,
    reportKey: str,
    reportRevisionId: str,
) -> Response:
    del reportKey, reportRevisionId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/report-exports/{exportId}",
    include_in_schema=False,
)
async def backlinks_report_export(
    request: Request,
    websiteProjectKey: str,
    exportId: str,
) -> Response:
    del exportId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/report-exports/{exportId}/download",
    include_in_schema=False,
)
async def authorize_backlinks_report_export_download(
    request: Request,
    websiteProjectKey: str,
    exportId: str,
) -> Response:
    del exportId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/settings",
    include_in_schema=False,
)
async def backlinks_settings(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.put(
    "/api/v1/projects/{websiteProjectKey}/backlinks/settings",
    include_in_schema=False,
)
async def update_backlinks_settings(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.put(
    "/api/v1/projects/{websiteProjectKey}/backlinks/settings/kill-switches/{capability}",
    include_in_schema=False,
)
async def update_backlinks_kill_switch(
    request: Request,
    websiteProjectKey: str,
    capability: str,
) -> Response:
    del capability
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


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities",
    include_in_schema=False,
)
async def create_backlinks_opportunity(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/"
    "{opportunityId}/draft-jobs/latest",
    include_in_schema=False,
)
async def latest_backlinks_draft_job(
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


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/send-intents/{sendIntentId}",
    include_in_schema=False,
)
async def get_backlinks_send_intent(
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
    callback_query = _google_oauth_callback_query(request)
    if isinstance(callback_query, Response):
        return callback_query
    response = await _forward(
        request,
        websiteProjectKey,
        query_params=callback_query,
    )
    frontend_origin = request.app.state.oauth_callback_frontend_origin
    if frontend_origin is None:
        return response
    try:
        payload = json.loads(response.body)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return response
    if not 200 <= response.status_code < 300:
        if (
            response.status_code == 400
            and payload.get("code") == "BACKLINK_INVALID_REQUEST"
        ):
            project_key = quote(websiteProjectKey, safe="")
            return RedirectResponse(
                url=(
                    f"{frontend_origin}/projects/{project_key}/backlinks/email"
                    "?gmailOAuth=invalid_or_expired"
                ),
                status_code=303,
            )
        return response
    return_path = payload.get("returnPath")
    if not isinstance(return_path, str):
        return_path = "/"
    if not return_path.startswith("/") or return_path.startswith("//"):
        return problem_response(
            status=502,
            problem_type="urn:growthos:problem:platform:oauth-return-path-invalid",
            title="OAuth return path invalid",
            detail="The OAuth callback returned an invalid application path.",
            code="OAUTH_RETURN_PATH_INVALID",
            request_id=request.headers.get("x-request-id", "oauth-callback"),
            retryable=False,
        )
    return RedirectResponse(
        url=f"{frontend_origin}{return_path}",
        status_code=303,
    )


def _google_oauth_callback_query(
    request: Request,
) -> list[tuple[str, str]] | Response:
    query_items = list(request.query_params.multi_items())
    request_id = request.headers.get("x-request-id", "oauth-callback")
    unsupported = sorted(
        {name for name, _ in query_items} - _GOOGLE_OAUTH_CALLBACK_QUERY_KEYS
    )
    if unsupported:
        return problem_response(
            status=400,
            problem_type="urn:growthos:problem:platform:oauth-callback-invalid",
            title="OAuth callback invalid",
            detail="The OAuth callback contains unsupported parameters.",
            code="OAUTH_CALLBACK_INVALID",
            request_id=request_id,
            retryable=False,
        )

    values: dict[str, list[str]] = {}
    for name, value in query_items:
        values.setdefault(name, []).append(value)
    if any(len(items) != 1 for items in values.values()):
        return problem_response(
            status=400,
            problem_type="urn:growthos:problem:platform:oauth-callback-invalid",
            title="OAuth callback invalid",
            detail="The OAuth callback contains repeated parameters.",
            code="OAUTH_CALLBACK_INVALID",
            request_id=request_id,
            retryable=False,
        )

    issuer = values.get("iss")
    if issuer is not None and issuer[0] != _GOOGLE_OAUTH_ISSUER:
        return problem_response(
            status=400,
            problem_type="urn:growthos:problem:platform:oauth-callback-invalid",
            title="OAuth callback invalid",
            detail="The OAuth callback issuer is not allowed.",
            code="OAUTH_CALLBACK_INVALID",
            request_id=request_id,
            retryable=False,
        )

    bounded_fields = {"scope": 8_192, "authuser": 32, "prompt": 128}
    if any(
        len(values[name][0]) > maximum
        for name, maximum in bounded_fields.items()
        if name in values
    ):
        return problem_response(
            status=400,
            problem_type="urn:growthos:problem:platform:oauth-callback-invalid",
            title="OAuth callback invalid",
            detail="The OAuth callback contains an oversized parameter.",
            code="OAUTH_CALLBACK_INVALID",
            request_id=request_id,
            retryable=False,
        )

    return [
        (name, values[name][0])
        for name in ("code", "state")
        if name in values
    ]


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


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/{connectionId}/sync",
    include_in_schema=False,
)
async def sync_backlinks_gmail(
    request: Request,
    websiteProjectKey: str,
    connectionId: str,
) -> Response:
    del connectionId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/{connectionId}/sync-status",
    include_in_schema=False,
)
async def backlinks_gmail_sync_status(
    request: Request,
    websiteProjectKey: str,
    connectionId: str,
) -> Response:
    del connectionId
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


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/replies/{inboundMessageId}/match/unbind",
    include_in_schema=False,
)
async def unbind_backlinks_reply_match(
    request: Request,
    websiteProjectKey: str,
    inboundMessageId: str,
) -> Response:
    del inboundMessageId
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
