import hashlib
import json
from collections.abc import Sequence
from urllib.parse import parse_qs, quote, urlparse

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse, Response

from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolutionError,
    PlatformContextResolver,
    problem_response,
)
from app.core.platform_request_context import ResolvedPlatformRequestContext

router = APIRouter(tags=["backlinks"])

_GOOGLE_OAUTH_CALLBACK_QUERY_KEYS = frozenset(
    {
        "authuser",
        "code",
        "error",
        "error_description",
        "error_uri",
        "iss",
        "prompt",
        "scope",
        "state",
    }
)
_GOOGLE_OAUTH_ISSUER = "https://accounts.google.com"
_GMAIL_OAUTH_COOKIE_PREFIX = "backlinks_gmail_oauth_"
_GMAIL_OAUTH_COOKIE_PATH = "/api/v1"
_GMAIL_OAUTH_COOKIE_MAX_AGE = 10 * 60


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


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "contact-enrichment-batches/current/run",
    include_in_schema=False,
)
async def run_current_pool_backlinks_contact_enrichment(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "contact-enrichment-batches/current/retry-unpublished",
    include_in_schema=False,
)
async def retry_unpublished_backlinks_contacts(
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


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-inventory",
    include_in_schema=False,
)
async def backlinks_recommendation_inventory(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/resource-library",
    include_in_schema=False,
)
async def backlinks_resource_library(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/profile",
    include_in_schema=False,
)
async def backlinks_profile(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/inventory",
    include_in_schema=False,
)
async def backlinks_inventory(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/inventory-items",
    include_in_schema=False,
)
async def import_backlinks_inventory_item(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.patch(
    "/api/v1/projects/{websiteProjectKey}/backlinks/inventory-items/{inventoryItemId}/monitoring-policy",
    include_in_schema=False,
)
async def update_backlinks_inventory_monitoring_policy(
    request: Request,
    websiteProjectKey: str,
    inventoryItemId: str,
) -> Response:
    del inventoryItemId
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/inventory-items/{inventoryItemId}/checks",
    include_in_schema=False,
)
async def request_backlinks_inventory_check(
    request: Request,
    websiteProjectKey: str,
    inventoryItemId: str,
) -> Response:
    del inventoryItemId
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/inventory-items/{inventoryItemId}/direct-observations",
    include_in_schema=False,
)
async def backlinks_inventory_direct_observations(
    request: Request,
    websiteProjectKey: str,
    inventoryItemId: str,
) -> Response:
    del inventoryItemId
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/profile-sync-jobs",
    include_in_schema=False,
)
async def request_backlinks_profile_sync(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/profile-sync-jobs/{jobId}",
    include_in_schema=False,
)
async def backlinks_profile_sync_job(
    request: Request,
    websiteProjectKey: str,
    jobId: str,
) -> Response:
    del jobId
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


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-feed",
    include_in_schema=False,
)
async def backlinks_recommendation_feed(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-feed/observations",
    include_in_schema=False,
)
async def observe_backlinks_recommendation_feed(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-feed/export",
    include_in_schema=False,
)
async def export_backlinks_recommendation_feed(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "recommendation-user-release/publish-initial",
    include_in_schema=False,
)
async def publish_initial_backlinks_recommendations(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "recommendation-user-release/status",
    include_in_schema=False,
)
async def backlinks_recommendation_release_status(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "recommendation-user-release/get-more",
    include_in_schema=False,
)
async def get_more_backlinks_recommendations(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "recommendation-user-release/items/{itemId}/archive",
    include_in_schema=False,
)
async def archive_backlinks_recommendation_feed_item(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/"
    "recommendation-user-release/items/{itemId}/unarchive",
    include_in_schema=False,
)
async def unarchive_backlinks_recommendation_feed_item(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-seeds/generate",
    include_in_schema=False,
)
async def generate_backlinks_recommendation_seeds(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-seeds/launch",
    include_in_schema=False,
)
async def launch_backlinks_recommendation_pool(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    return await _forward(request, websiteProjectKey)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-seeds/validate",
    include_in_schema=False,
)
async def validate_backlinks_recommendation_seeds(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/drafts/{draftId}/send-preflight",
    include_in_schema=False,
)
async def preflight_backlinks_send_intent(
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
    "/api/v1/projects/{websiteProjectKey}/backlinks/send-intents",
    include_in_schema=False,
)
async def list_backlinks_send_intents(
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
    origin_problem = _gmail_oauth_origin_problem(request)
    if origin_problem is not None:
        return origin_problem
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    gateway: BacklinksGateway = request.app.state.backlinks_gateway
    try:
        resolved = await resolver.resolve(
            request=request,
            website_project_key=websiteProjectKey,
            required_permission="backlinks:write",
        )
    except PlatformContextResolutionError as error:
        return _platform_context_problem(request, error)

    response = await gateway.forward(
        request,
        resolved=resolved,
        website_project_key=websiteProjectKey,
    )
    if not 200 <= response.status_code < 300:
        return response
    state = _authorization_url_state(request, response)
    if isinstance(state, Response):
        return state
    try:
        ticket = gateway.issue_gmail_oauth_callback_ticket(resolved, state=state)
    except ValueError:
        return problem_response(
            status=503,
            problem_type="urn:growthos:problem:platform:backlinks-gateway-misconfigured",
            title="Backlinks gateway unavailable",
            detail="The Backlinks gateway signing configuration is unavailable.",
            code="BACKLINKS_GATEWAY_MISCONFIGURED",
            request_id=request.headers.get("x-request-id", "unresolved"),
            retryable=False,
        )
    response.set_cookie(
        key=_gmail_oauth_cookie_name(state),
        value=ticket,
        max_age=_GMAIL_OAUTH_COOKIE_MAX_AGE,
        path=_GMAIL_OAUTH_COOKIE_PATH,
        secure=request.app.state.oauth_callback_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return response


@router.get(
    "/api/v1/backlinks/gmail-connections/callback",
    include_in_schema=False,
)
async def complete_backlinks_gmail_connection_stable(
    request: Request,
) -> Response:
    callback_query = _google_oauth_callback_query(request)
    if isinstance(callback_query, Response):
        return callback_query
    resolved = _gmail_oauth_callback_context(
        request,
        state=callback_query["state"],
    )
    if isinstance(resolved, Response):
        return resolved
    if callback_query.get("error") == "access_denied":
        response = _gmail_oauth_denied_response(request, resolved)
        delete_ticket = True
    else:
        gateway: BacklinksGateway = request.app.state.backlinks_gateway
        upstream = await gateway.forward(
            request,
            resolved=resolved,
            website_project_key=resolved.project.website_project_key,
            query_params=[
                ("code", callback_query["code"]),
                ("state", callback_query["state"]),
            ],
        )
        response = _gmail_oauth_callback_response(
            request,
            upstream,
            resolved,
        )
        delete_ticket = True
    if delete_ticket:
        _delete_gmail_oauth_callback_ticket(response, callback_query["state"])
    return response


@router.get(
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/callback",
    include_in_schema=False,
)
async def complete_backlinks_gmail_connection_legacy(
    request: Request,
    websiteProjectKey: str,
) -> Response:
    callback_query = _google_oauth_callback_query(request)
    if isinstance(callback_query, Response):
        return callback_query
    resolved = _gmail_oauth_callback_context(
        request,
        state=callback_query["state"],
    )
    if isinstance(resolved, Response):
        return resolved
    if resolved.project.website_project_key != websiteProjectKey:
        response = problem_response(
            status=403,
            problem_type="urn:growthos:problem:platform:project-binding-failed",
            title="Platform project binding failed",
            detail="The OAuth callback ticket does not match the requested project.",
            code="PLATFORM_PROJECT_BINDING_FAILED",
            request_id=resolved.correlation_id,
            retryable=False,
        )
        delete_ticket = True
    elif callback_query.get("error") == "access_denied":
        response = _gmail_oauth_denied_response(request, resolved)
        delete_ticket = True
    else:
        gateway: BacklinksGateway = request.app.state.backlinks_gateway
        upstream = await gateway.forward(
            request,
            resolved=resolved,
            website_project_key=websiteProjectKey,
            query_params=[
                ("code", callback_query["code"]),
                ("state", callback_query["state"]),
            ],
        )
        response = _gmail_oauth_callback_response(
            request,
            upstream,
            resolved,
        )
        delete_ticket = True
    if delete_ticket:
        _delete_gmail_oauth_callback_ticket(response, callback_query["state"])
    return response


def _authorization_url_state(request: Request, response: Response) -> str | Response:
    parsed = urlparse("")
    try:
        payload = json.loads(response.body)
        authorization_url = payload["authorizationUrl"]
        parsed = urlparse(authorization_url)
        states = parse_qs(parsed.query, keep_blank_values=True).get("state", [])
    except (KeyError, TypeError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        states = []
    if (
        len(states) != 1
        or not _valid_oauth_state(states[0])
        or parsed.scheme not in {"http", "https"}
        or not parsed.netloc
    ):
        return problem_response(
            status=502,
            problem_type="urn:growthos:problem:platform:oauth-authorization-url-invalid",
            title="OAuth authorization URL invalid",
            detail="The Gmail authorization response did not contain a valid OAuth state.",
            code="OAUTH_AUTHORIZATION_URL_INVALID",
            request_id=request.headers.get("x-request-id", "unresolved"),
            retryable=False,
        )
    return states[0]


def _gmail_oauth_callback_context(
    request: Request,
    *,
    state: str,
) -> ResolvedPlatformRequestContext | Response:
    cookie_name = _gmail_oauth_cookie_name(state)
    ticket = request.cookies.get(cookie_name)
    if ticket is None:
        return _oauth_callback_problem(
            request,
            detail="The OAuth callback ticket is missing or expired.",
        )
    gateway: BacklinksGateway = request.app.state.backlinks_gateway
    try:
        resolved = gateway.resolve_gmail_oauth_callback_ticket(
            ticket,
            state=state,
            correlation_id=request.headers.get("x-request-id", "oauth-callback"),
        )
    except ValueError:
        response = _oauth_callback_problem(
            request,
            detail="The OAuth callback ticket is invalid or expired.",
        )
        _delete_gmail_oauth_callback_ticket(response, state)
        return response
    if "backlinks:write" not in resolved.permissions:
        response = problem_response(
            status=403,
            problem_type="urn:growthos:problem:platform:permission-denied",
            title="Platform permission denied",
            detail="The OAuth callback ticket does not grant backlinks:write.",
            code="PLATFORM_PERMISSION_DENIED",
            request_id=resolved.correlation_id,
            retryable=False,
        )
        _delete_gmail_oauth_callback_ticket(response, state)
        return response
    return resolved


def _gmail_oauth_cookie_name(state: str) -> str:
    state_hash = hashlib.sha256(state.encode("ascii")).hexdigest()
    return f"{_GMAIL_OAUTH_COOKIE_PREFIX}{state_hash}"


def _delete_gmail_oauth_callback_ticket(response: Response, state: str) -> None:
    response.delete_cookie(
        key=_gmail_oauth_cookie_name(state),
        path=_GMAIL_OAUTH_COOKIE_PATH,
        httponly=True,
        samesite="lax",
    )


def _gmail_oauth_denied_response(
    request: Request,
    resolved: ResolvedPlatformRequestContext,
) -> Response:
    return_path = (
        f"/projects/{quote(resolved.project.website_project_key, safe='')}"
        "/backlinks/email?gmailOAuth=access_denied"
    )
    frontend_origin = request.app.state.oauth_callback_frontend_origin
    url = return_path if frontend_origin is None else f"{frontend_origin.rstrip('/')}{return_path}"
    return RedirectResponse(url=url, status_code=303)


def _gmail_oauth_callback_response(
    request: Request,
    response: Response,
    resolved: ResolvedPlatformRequestContext,
) -> Response:
    frontend_origin = request.app.state.oauth_callback_frontend_origin
    if frontend_origin is None:
        return response
    try:
        payload = json.loads(response.body)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return response
    if not 200 <= response.status_code < 300:
        callback_status = (
            "provider_unavailable"
            if payload.get("code") == "GMAIL_OAUTH_PROVIDER_UNAVAILABLE"
            else "failed"
        )
        return_path = (
            f"/projects/{quote(resolved.project.website_project_key, safe='')}"
            f"/backlinks/email?gmailOAuth={callback_status}"
        )
        return RedirectResponse(
            url=f"{frontend_origin.rstrip('/')}{return_path}",
            status_code=303,
        )
    return_path = payload.get("returnPath")
    meta = payload.get("meta")
    segments = return_path.split("/") if isinstance(return_path, str) else []
    if (
        len(segments) != 5
        or segments[0] != ""
        or segments[1] != "projects"
        or segments[2] != resolved.project.website_project_key
        or segments[3:] != ["backlinks", "email"]
        or "?" in return_path
        or "#" in return_path
        or not isinstance(meta, dict)
        or meta.get("websiteProjectId") != resolved.project.website_project_id
    ):
        return problem_response(
            status=502,
            problem_type="urn:growthos:problem:platform:oauth-project-context-mismatch",
            title="OAuth project context mismatch",
            detail="The OAuth callback did not match the project that started authorization.",
            code="OAUTH_PROJECT_CONTEXT_MISMATCH",
            request_id=request.headers.get("x-request-id", "oauth-callback"),
            retryable=False,
        )
    return RedirectResponse(
        url=f"{frontend_origin.rstrip('/')}{return_path}",
        status_code=303,
    )


def _google_oauth_callback_query(
    request: Request,
) -> dict[str, str] | Response:
    query_items = list(request.query_params.multi_items())
    unsupported = sorted({name for name, _ in query_items} - _GOOGLE_OAUTH_CALLBACK_QUERY_KEYS)
    if unsupported:
        return _oauth_callback_problem(
            request,
            detail="The OAuth callback contains unsupported parameters.",
        )

    values: dict[str, list[str]] = {}
    for name, value in query_items:
        values.setdefault(name, []).append(value)
    if any(len(items) != 1 for items in values.values()):
        return _oauth_callback_problem(
            request,
            detail="The OAuth callback contains repeated parameters.",
        )

    issuer = values.get("iss")
    if issuer is not None and issuer[0] != _GOOGLE_OAUTH_ISSUER:
        return _oauth_callback_problem(
            request,
            detail="The OAuth callback issuer is not allowed.",
        )

    bounded_fields = {
        "authuser": 32,
        "code": 8_192,
        "error": 128,
        "error_description": 2_048,
        "error_uri": 2_048,
        "prompt": 128,
        "scope": 8_192,
        "state": 128,
    }
    if any(
        len(values[name][0]) > maximum for name, maximum in bounded_fields.items() if name in values
    ):
        return _oauth_callback_problem(
            request,
            detail="The OAuth callback contains an oversized parameter.",
        )

    callback = {name: items[0] for name, items in values.items()}
    has_code = bool(callback.get("code"))
    has_error = bool(callback.get("error"))
    if (
        not _valid_oauth_state(callback.get("state", ""))
        or has_code == has_error
        or (has_error and callback["error"] != "access_denied")
    ):
        return _oauth_callback_problem(
            request,
            detail="The OAuth callback did not contain a supported result.",
        )
    return callback


def _valid_oauth_state(value: str) -> bool:
    return (
        32 <= len(value) <= 128
        and value.isascii()
        and all(character.isalnum() or character in "-_" for character in value)
    )


def _oauth_callback_problem(request: Request, *, detail: str) -> Response:
    frontend_origin = request.app.state.oauth_callback_frontend_origin
    if frontend_origin is not None:
        return RedirectResponse(
            url=f"{frontend_origin.rstrip('/')}/?gmailOAuth=invalid_or_expired",
            status_code=303,
        )
    return problem_response(
        status=400,
        problem_type="urn:growthos:problem:platform:oauth-callback-invalid",
        title="OAuth callback invalid",
        detail=detail,
        code="OAUTH_CALLBACK_INVALID",
        request_id=request.headers.get("x-request-id", "oauth-callback"),
        retryable=False,
    )


def _oauth_origin_key(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if (
        scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    return (
        scheme,
        parsed.hostname.lower(),
        port or (443 if scheme == "https" else 80),
    )


def _gmail_oauth_origin_problem(request: Request) -> Response | None:
    callback_url = request.app.state.oauth_callback_url
    frontend_origin = request.app.state.oauth_callback_frontend_origin
    frontend_origin_key = (
        _oauth_origin_key(frontend_origin) if frontend_origin is not None else None
    )
    callback_host = (
        urlparse(callback_url).hostname.lower() if callback_url is not None else None
    )
    if frontend_origin_key is None or callback_host is None:
        return problem_response(
            status=503,
            problem_type=(
                "urn:growthos:problem:platform:oauth-configuration-invalid"
            ),
            title="OAuth configuration invalid",
            detail=(
                "Gmail authorization is unavailable because its public callback "
                "configuration is incomplete."
            ),
            code="OAUTH_CONFIGURATION_INVALID",
            request_id=request.headers.get("x-request-id", "unresolved"),
            retryable=False,
        )
    frontend_host = frontend_origin_key[1]
    browser_origin = request.headers.get("origin")
    browser_origin_matches = (
        _oauth_origin_key(browser_origin) == frontend_origin_key
        if browser_origin is not None
        else False
    )
    request_host = request.url.hostname
    request_host_matches = (
        request_host is not None and request_host.lower() == frontend_host
    )
    if (
        callback_host == frontend_host
        and (
            browser_origin_matches
            if browser_origin is not None
            else request_host_matches
        )
    ):
        return None
    return problem_response(
        status=409,
        problem_type="urn:growthos:problem:platform:oauth-origin-mismatch",
        title="OAuth origin mismatch",
        detail="Gmail authorization must start from the configured public hostname.",
        code="OAUTH_ORIGIN_MISMATCH",
        request_id=request.headers.get("x-request-id", "unresolved"),
        retryable=True,
        extensions={"canonicalFrontendOrigin": frontend_origin.rstrip("/")},
    )


def _platform_context_problem(
    request: Request,
    error: PlatformContextResolutionError,
) -> Response:
    return problem_response(
        status=error.status,
        problem_type=f"urn:growthos:problem:platform:{error.code.lower().replace('_', '-')}",
        title=error.title,
        detail=error.detail,
        code=error.code,
        request_id=request.headers.get("x-request-id", "unresolved"),
        retryable=False,
    )


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
    "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/select",
    include_in_schema=False,
)
async def select_backlinks_gmail_connection(
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
