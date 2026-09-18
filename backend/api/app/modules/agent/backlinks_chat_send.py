"""Explicit chat commands reuse Core approvals and the durable serial sender."""
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.modules.agent.backlinks_consent import ConsentError, consent_state, scope
from app.modules.agent.backlinks_continuation_store import ACTIVE, BacklinksContinuationStore
from app.modules.agent.backlinks_draft_review import (
    DraftApprovalItem, DraftReviewApproval, approve_reviewed_drafts,
)
from app.modules.agent.backlinks_send_batch import (
    BacklinksSendBatchStore, SendBatchConfirmation, SendBatchPreviewRequest,
)
from app.modules.agent.models import (
    AgentBacklinksConsent, AgentConversation, AgentMessage, AgentRun,
)
from app.modules.agent.backlinks_quality import BacklinksQuality
from app.modules.agent.backlinks_quality_repair import BacklinksQualityRepair
from app.modules.projects.models import Project
from app.modules.agent.delegation import resolve_delegation

CHAT_SEND_POLICY = "backlinks-chat-send.v1"


def explicit_chat_send(text: str) -> bool:
    text = re.sub(r"\s+", "", text).lower()
    # Pacing constraints are not a refusal to send.
    text = re.sub(
        r"(?:不要|不能|别)(?:同时|一次性|并发|一起|一口气)(?:发送|发出|发)"
        r"(?:多个|多封|所有|全部)?",
        "", text,
    )
    if re.search(
        r"(?:不要|不用|不允许|禁止|别|无需|先不|暂不|不能|do.?not|don't|never|notyet)"
        r".{0,24}(?:发送|发出|提交|发给|send|submit)"
        r"|(?:能不能|能否|是否|怎么|如何|吗|么|canyou|couldyou|howdo|howto|dry.?run|模拟|测试|预检|preflight)"
        r"|(?:如果|假如|假设|代码|coding|工具|功能|方案|他说|返回|回复|```|[“”\"<>])",
        text,
    ):
        return False
    return bool(re.search(
        r"(?:发送|发出|提交).{0,24}(?:外链|开发信|合作邮件|邮件|草稿)"
        r"|(?:邮件|草稿|开发信).{0,24}(?:发出去|发出|发送|发给)"
        r"|(?:开发信|邮件|草稿)[^。；;]{0,160}(?:串行|逐封|排队)(?:排队)?发送(?=[，。；,;.!]|$)"
        r"|(?:send|submit).{0,40}(?:email|outreach|draft)",
        text,
    ))


class ChatSendItem(DraftApprovalItem):
    contact_id: UUID
    contact_version: int = Field(strict=True, ge=1)


class ChatSendArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ChatSendItem] = Field(min_length=1, max_length=20)
    gmail_connection_id: UUID

    @field_validator("items")
    @classmethod
    def unique_drafts(cls, items):
        if len({item.draft_id for item in items}) != len(items):
            raise ValueError("duplicate draft IDs")
        return items


class BacklinksChatSend:
    def __init__(self, reader, sessions, limits):
        self.reader, self.sessions, self.limits = reader, sessions, limits
        self.store = BacklinksSendBatchStore(sessions, reader.settings, gateway=reader.gateway)

    async def authorize(self, project_id, organization_id, delegation, run_id, *,
                        command_check=explicit_chat_send):
        context = await self.reader.resolve_write_context(
            project_id, organization_id, delegation, write=True,
        )
        read_context = await self.reader.resolve_write_context(
            project_id, organization_id, delegation, write=False,
        )
        context = replace(context, permissions=tuple(set(context.permissions) | set(read_context.permissions)))
        async with self.sessions() as session:
            run = await session.get(AgentRun, run_id) if run_id else None
            conversation = await session.get(AgentConversation, run.conversation_id) if run else None
            message = await session.get(AgentMessage, run.user_message_id) if run else None
            active = (
                await session.get(AgentMessage, conversation.active_message_id)
                if conversation and conversation.active_message_id else None
            )
            if (
                not run or run.status not in ACTIVE or not conversation or not message
                or conversation.organization_id != organization_id
                or conversation.project_id != project_id
                or message.conversation_id != conversation.id or message.role != "user"
                or not active or active.conversation_id != conversation.id
                or not (active.id == message.id or (active.role == "assistant" and active.run_id == run.id))
                or (message.metadata_json or {}).get("trigger")
                or not command_check(message.content)
            ):
                raise ConsentError("BACKLINKS_CHAT_SEND_EXPLICIT_USER_COMMAND_REQUIRED")
            if conversation.created_by != context.actor.user_id:
                if conversation.created_by != "system":
                    raise ConsentError("BACKLINKS_CHAT_SEND_EXPLICIT_USER_COMMAND_REQUIRED")
                # Legacy conversations lack a human owner. Require the original
                # server-signed user authority, not a model-supplied ownership claim.
                try:
                    original = await resolve_delegation(
                        self.reader.settings, self.reader.projects,
                        (run.limits_json or {}).get("backlinks_delegation"),
                        project_id, organization_id, write=True, now=message.created_at,
                    )
                except ValueError as exc:
                    raise ConsentError("BACKLINKS_CHAT_SEND_EXPLICIT_USER_COMMAND_REQUIRED") from exc
                if (original.actor != context.actor or original.tenant != context.tenant
                        or original.project != context.project):
                    raise ConsentError("BACKLINKS_CHAT_SEND_EXPLICIT_USER_COMMAND_REQUIRED")
            return context, message.id

    async def submit(self, project_id, organization_id, delegation, run_id, arguments):
        values = ChatSendArgs.model_validate(arguments)
        context, message_id = await self.authorize(
            project_id, organization_id, delegation, run_id,
        )
        request_id = str(uuid5(NAMESPACE_URL, f"backlinks-chat-send:{message_id}"))
        policy = {
            "policy_version": CHAT_SEND_POLICY, "source_run_id": run_id,
            "source_message_id": message_id, "targets": values.model_dump(mode="json"),
        }
        async with self.sessions() as session, session.begin():
            record = await session.scalar(select(AgentBacklinksConsent).where(
                *scope(context), AgentBacklinksConsent.request_id == request_id,
            ))
            if record is None:
                now = datetime.now(UTC)
                await session.execute(pg_insert(AgentBacklinksConsent).values(
                    id=request_id, organization_id=organization_id,
                    workspace_id=context.tenant.workspace_id, project_id=project_id,
                    user_id=context.actor.user_id, request_id=request_id, policy_json=policy,
                    created_at=now, expires_at=now + timedelta(hours=24),
                ).on_conflict_do_nothing(constraint="uq_agent_backlinks_consents_request"))
                record = await session.scalar(select(AgentBacklinksConsent).where(
                    *scope(context), AgentBacklinksConsent.request_id == request_id,
                ))
            if record.policy_json != policy:
                raise ConsentError("BACKLINKS_CHAT_SEND_REQUEST_CHANGED", 409)
            if consent_state(record, datetime.now(UTC)) != "active":
                raise ConsentError("BACKLINKS_CONSENT_INACTIVE")
            BacklinksContinuationStore.check_project(await session.get(Project, project_id), record)

        batches = (await self.store.list(context, request_id))["items"]
        existing = next((batch for batch in batches if batch["run_id"]), None)
        if existing:
            return self.receipt(request_id, existing)
        quality = BacklinksQuality(self.store)
        repair = BacklinksQualityRepair(self.store, quality=quality)
        await repair.resume(context, request_id, [str(item.draft_id) for item in values.items])
        # Check the original selection before spending on review or changing text.
        for item in values.items:
            pin = await repair.resolve_pin(context, request_id, item.model_dump(mode="json"))
            evidence, _, _ = await quality.evidence(context, request_id, str(item.draft_id))
            if (evidence["version_id"] != pin["version_id"]
                or (evidence.get("contact") or {}).get("id") != pin["contact_id"]
                or (evidence.get("contact") or {}).get("version") != pin["contact_version"]):
                raise ConsentError("BACKLINKS_CHAT_SEND_TARGET_CHANGED", 409)
        review = await repair.evaluate(context, request_id, [str(item.draft_id) for item in values.items])
        passed = {item["draft_id"] for item in review["items"] if item["state"] == "PASSED"}
        selected = [ChatSendItem.model_validate(await repair.resolve_pin(
            context, request_id, item.model_dump(mode="json"),
        )) for item in values.items if str(item.draft_id) in passed]
        if not selected:
            return {"verified": True, "verification": "quality_review_only", "consent_id": request_id,
                    "quality_review": review, "batch": None, "sent": False,
                    "next": "No drafts passed AI review. Show the saved reasons; nothing was queued."}
        for item in selected:
            await quality.require_pass(context, request_id, str(item.draft_id))
        await self.authorize(project_id, organization_id, delegation, run_id)
        # Repaired versions must descend from the exact authorized selection.
        await approve_reviewed_drafts(self.store, context, request_id, DraftReviewApproval(
            request_id=request_id, confirmed=True,
            items=[DraftApprovalItem(**item.model_dump(
                exclude={"contact_id", "contact_version"},
            )) for item in selected],
        ))
        await self.authorize(project_id, organization_id, delegation, run_id)
        batch = await self.store.preview(context, request_id, SendBatchPreviewRequest(
            request_id=request_id, draft_ids=[item.draft_id for item in selected],
            gmail_connection_id=values.gmail_connection_id,
        ))
        await self.authorize(project_id, organization_id, delegation, run_id)
        batch = await self.store.confirm(
            context, request_id, batch["id"],
            SendBatchConfirmation(confirmed=True, manifest_hash=batch["manifest_hash"]),
            self.limits,
        )
        return {**self.receipt(request_id, batch), "quality_review": review}

    @staticmethod
    def receipt(consent_id, batch):
        return {
            "verified": True, "verification": "persisted_serial_send_batch_only",
            "consent_id": consent_id,
            "batch": {
                key: batch[key] for key in ("id", "run_id", "state", "reason")
            } | {"expires_at": batch["expires_at"].isoformat(), "items": [
                {"target": item["target"], "state": item["state"],
                 "preview": {"recipient": item["preview"]["recipient"]}}
                for item in batch["items"]
            ]},
            "next": "The exact chat-requested drafts are queued for serial sending. "
            "Queued is not sent or delivered. Use get_backlink_campaign with consent_id "
            "for progress and existing mail/sync tools for replies. Do not submit these "
            "drafts again. Cancel via the existing automation send-batch controls.",
        }
