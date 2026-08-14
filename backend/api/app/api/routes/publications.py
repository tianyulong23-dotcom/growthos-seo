import html
import json
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, JSONResponse

from app.api.routes.content import (
    content_audit_context,
    content_problem,
    resolve_content_context,
)
from app.modules.content.publication_service import (
    PublicationService,
    build_publication_service,
)
from app.modules.content.schemas import (
    ArticlePreviewResponse,
    ArticlePreviewSessionRequest,
    ArticlePublicationCollection,
    ArticlePublicationResponse,
    ArticlePublicationSnapshotResponse,
    CancelArticlePublicationRequest,
    CreateArticlePreviewRequest,
    CreateArticlePublicationRequest,
    PublicationTargetCollection,
    RetryArticlePublicationRequest,
)


router = APIRouter(prefix="/api/v1/projects/{project_id}", tags=["content"])
preview_router = APIRouter(prefix="/api/v1/article-previews", tags=["content"])


def get_publication_service() -> PublicationService:
    return build_publication_service()


def publication_error(request: Request, exc: Exception) -> JSONResponse:
    code = str(exc).strip("'") or "publication_failed"
    if isinstance(exc, LookupError):
        return content_problem(request, status_code=404, code=code)
    conflicts = {
        "idempotency_key_conflict",
        "article_publication_active",
        "article_publication_retry_not_allowed",
        "publication_cancel_too_late",
        "publication_reconcile_not_allowed",
        "approved_version_mismatch",
    }
    stable_code = code.split(":", 1)[0]
    return content_problem(
        request,
        status_code=409 if stable_code in conflicts else 422,
        code=stable_code,
    )


@router.get("/publication-targets", response_model=PublicationTargetCollection)
async def list_publication_targets(
    project_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> PublicationTargetCollection:
    context = await resolve_content_context(request, project_id, permission="content:publish")
    if isinstance(context, JSONResponse):
        return context
    return await service.list_targets(
        context.tenant.organization_id, context.project.website_project_id
    )


@router.post(
    "/articles/{article_id}/previews",
    response_model=ArticlePreviewResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_article_preview(
    project_id: str,
    article_id: str,
    preview: CreateArticlePreviewRequest,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePreviewResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.create_preview(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            preview,
            created_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.delete(
    "/articles/{article_id}/previews/{preview_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_article_preview(
    project_id: str,
    article_id: str,
    preview_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> Response:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        await service.revoke_preview(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            preview_id,
            revoked_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
        return Response(status_code=204)
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


def preview_security_headers(*, nonce: str | None = None) -> dict[str, str]:
    script = f"; script-src 'nonce-{nonce}'" if nonce else ""
    return {
        "Cache-Control": "no-store, private, max-age=0",
        "Pragma": "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Content-Security-Policy": (
            "default-src 'none'; img-src https: http: data:; media-src https: http:; "
            f"style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'{script}"
        ),
    }


def preview_bootstrap(preview_id: str, nonce: str) -> str:
    endpoint = json.dumps(f"/api/v1/article-previews/{preview_id}/session")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>正在打开文章预览</title></head><body><p id="status">正在验证预览链接...</p>
<script nonce="{html.escape(nonce, quote=True)}">(async()=>{{const token=new URLSearchParams(location.hash.slice(1)).get('token');
if(!token){{document.getElementById('status').textContent='预览链接无效';return;}}
history.replaceState(null,'',location.pathname);const response=await fetch({endpoint},{{method:'POST',credentials:'same-origin',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{token}})}});
if(!response.ok){{document.getElementById('status').textContent=response.status===410?'预览已过期或撤销':'预览链接无效';return;}}location.replace(location.pathname);}})();</script></body></html>"""


@preview_router.post("/{preview_id}/session", status_code=status.HTTP_204_NO_CONTENT)
async def create_article_preview_session(
    preview_id: str,
    session_request: ArticlePreviewSessionRequest,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> Response:
    try:
        await service.verify_preview(preview_id, session_request.token)
    except LookupError:
        raise HTTPException(status_code=404, detail="article_preview_not_found")
    except ValueError as exc:
        if str(exc) == "article_preview_expired":
            raise HTTPException(status_code=410, detail=str(exc))
        raise HTTPException(status_code=404, detail="article_preview_not_found")
    response = Response(status_code=204, headers=preview_security_headers())
    response.set_cookie(
        f"article_preview_{preview_id}",
        session_request.token,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        max_age=3600,
        path=f"/api/v1/article-previews/{preview_id}",
    )
    return response


@preview_router.get("/{preview_id}", response_class=HTMLResponse)
async def render_article_preview(
    preview_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> HTMLResponse:
    token = request.cookies.get(f"article_preview_{preview_id}")
    if not token:
        nonce = secrets.token_urlsafe(18)
        return HTMLResponse(
            preview_bootstrap(preview_id, nonce),
            headers=preview_security_headers(nonce=nonce),
        )
    try:
        body = await service.render_preview(preview_id, token)
    except LookupError:
        raise HTTPException(status_code=404, detail="article_preview_not_found")
    except ValueError as exc:
        if str(exc) == "article_preview_expired":
            raise HTTPException(status_code=410, detail=str(exc))
        raise HTTPException(status_code=404, detail="article_preview_not_found")
    return HTMLResponse(
        body,
        headers=preview_security_headers(),
    )


@router.post(
    "/articles/{article_id}/publications",
    response_model=ArticlePublicationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_article_publication(
    project_id: str,
    article_id: str,
    publication: CreateArticlePublicationRequest,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:publish")
        if isinstance(context, JSONResponse):
            return context
        return await service.create_publication(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            publication,
            idempotency_key,
            created_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.get(
    "/articles/{article_id}/publications",
    response_model=ArticlePublicationCollection,
)
async def list_article_publications(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationCollection:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.list_publications(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.get(
    "/publications/{publication_id}", response_model=ArticlePublicationResponse
)
async def get_article_publication(
    project_id: str,
    publication_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.get_publication(
            context.tenant.organization_id,
            context.project.website_project_id,
            publication_id,
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.get(
    "/publications/{publication_id}/snapshot",
    response_model=ArticlePublicationSnapshotResponse,
)
async def get_article_publication_snapshot(
    project_id: str,
    publication_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationSnapshotResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.publication_snapshot(
            context.tenant.organization_id,
            context.project.website_project_id,
            publication_id,
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.post(
    "/publications/{publication_id}/cancel", response_model=ArticlePublicationResponse
)
async def cancel_article_publication(
    project_id: str,
    publication_id: str,
    cancellation: CancelArticlePublicationRequest,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:publish")
        if isinstance(context, JSONResponse):
            return context
        return await service.cancel_publication(
            context.tenant.organization_id,
            context.project.website_project_id,
            publication_id,
            cancelled_by=context.actor.user_id,
            reason=cancellation.reason,
            audit=content_audit_context(request, context),
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.post(
    "/publications/{publication_id}/retry", response_model=ArticlePublicationResponse
)
async def retry_article_publication(
    project_id: str,
    publication_id: str,
    retry: RetryArticlePublicationRequest,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationResponse:
    del retry
    try:
        context = await resolve_content_context(request, project_id, permission="content:publish")
        if isinstance(context, JSONResponse):
            return context
        return await service.retry_publication(
            context.tenant.organization_id,
            context.project.website_project_id,
            publication_id,
            idempotency_key,
            created_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)


@router.post(
    "/publications/{publication_id}/reconcile", response_model=ArticlePublicationResponse
)
async def reconcile_article_publication(
    project_id: str,
    publication_id: str,
    request: Request,
    service: Annotated[PublicationService, Depends(get_publication_service)],
) -> ArticlePublicationResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:publish")
        if isinstance(context, JSONResponse):
            return context
        return await service.reconcile_publication(
            context.tenant.organization_id,
            context.project.website_project_id,
            publication_id,
            audit=content_audit_context(request, context),
        )
    except (LookupError, ValueError) as exc:
        return publication_error(request, exc)
