import json
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import get_settings
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.modules.agent.mail_reply import (
    ReplyAssistInput, assist_reply, issue_one_reply_token, reply_fingerprint,
    verify_one_reply_token,
)

router = APIRouter(tags=["mail-reply"])
PREFIX = "/api/v1/projects/{websiteProjectKey}/backlinks/mail/messages/{messageId}"


class ReplySendBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    expectedVersion: int = Field(gt=0)
    gmailConnectionId: UUID
    recipient: str = Field(min_length=3, max_length=320)
    subject: str = Field(min_length=1, max_length=255, pattern=r"^[^\r\n\x00]+$")
    body: str = Field(min_length=1, max_length=20_000)
    confirmed: Literal[True]
    confirmationMode: Literal["MANUAL", "ONE_REPLY"] = "MANUAL"
    generationToken: str | None = Field(default=None, max_length=100)


async def resolve(request, project, *, write=False):
    try:
        context = await request.app.state.platform_context_resolver.resolve(
            request=request, website_project_key=project,
        )
    except PlatformContextResolutionError as error:
        raise HTTPException(error.status, error.detail) from error
    if write and not set(context.actor.roles).intersection({"owner", "admin", "member"}):
        raise HTTPException(403, "MAIL_REPLY_PERMISSION_REQUIRED")
    return context


async def core(request, context, message_id, operation, body=None):
    upstream = (
        f"/api/v1/projects/{quote(context.project.website_project_key, safe='')}"
        f"/backlinks/mail/messages/{message_id}/{operation}"
    )
    forwarded = Request({
        "type": "http", "method": "GET" if body is None else "POST", "path": "/",
        "query_string": b"", "headers": [(b"content-type", b"application/json")],
    })
    forwarded._body = b"" if body is None else json.dumps(body).encode()
    response = await request.app.state.backlinks_gateway.forward(
        forwarded, resolved=context, website_project_key=context.project.website_project_key,
        upstream_path=upstream,
    )
    return response


def signing_key():
    key = get_settings().platform_context_signing_key
    if key is None:
        raise HTTPException(503, "MAIL_REPLY_SIGNING_UNAVAILABLE")
    return key.get_secret_value()


@router.get(PREFIX + "/reply-context")
async def reply_context(request: Request, websiteProjectKey: str, messageId: UUID):
    context = await resolve(request, websiteProjectKey)
    return await core(request, context, messageId, "reply-context")


@router.post(PREFIX + "/reply-assistant")
async def reply_assistant(request: Request, websiteProjectKey: str, messageId: UUID, body: ReplyAssistInput):
    context = await resolve(request, websiteProjectKey, write=True)
    response = await core(request, context, messageId, "reply-context")
    if response.status_code != 200:
        return response
    data = json.loads(response.body)
    if data["message"]["id"] != str(messageId):
        raise HTTPException(409, "MAIL_REPLY_CONTEXT_CHANGED")
    try:
        output = await assist_reply(data, body, context.tenant.organization_id)
    except ValueError as error:
        raise HTTPException(422, "MAIL_REPLY_GENERATION_INVALID") from error
    except Exception as error:
        raise HTTPException(503, "MAIL_REPLY_MODEL_UNAVAILABLE") from error
    payload = {
        "expectedVersion": data["message"]["version"],
        "gmailConnectionId": data["gmailConnectionId"],
        "recipient": data["recipient"], "subject": data["subject"], "body": output.body.strip(),
    }
    token = None
    if (body.authorize_one_reply and body.action == "draft" and not output.warnings
        and data["message"].get("matchedOpportunityId") and not data.get("existingReply")):
        token = issue_one_reply_token(
            signing_key(), reply_fingerprint(context, str(messageId), payload),
        )
    return {**output.model_dump(), **payload, "model": "gpt-5.5", "generationToken": token}


@router.post(PREFIX + "/reply-send")
async def reply_send(request: Request, websiteProjectKey: str, messageId: UUID, body: ReplySendBody):
    context = await resolve(request, websiteProjectKey, write=True)
    payload = body.model_dump(mode="json", exclude={"generationToken", "confirmed", "confirmationMode"})
    if body.confirmationMode == "ONE_REPLY":
        if not verify_one_reply_token(signing_key(), reply_fingerprint(context, str(messageId), payload),
                                      body.generationToken):
            raise HTTPException(409, "MAIL_REPLY_CONSENT_EXPIRED_OR_CHANGED")
    return await core(request, context, messageId, "reply-send", {
        **payload, "confirmed": True, "confirmationMode": body.confirmationMode,
    })
