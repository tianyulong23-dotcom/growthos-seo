"""Human-confirmed manifests on the existing Agent workflow and Core send queue."""

import hashlib
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.agent.backlinks_consent import ConsentError, consent_state, scope
from app.modules.agent.backlinks_continuation_store import ACTIVE, BacklinksContinuationStore
from app.modules.agent.backlinks_drafts import BacklinksDrafts
from app.modules.agent.backlinks_pipeline import child_operation
from app.modules.agent.backlinks_read import BacklinksReader, BacklinksReadError
from app.modules.agent.backlinks_send import (
    BacklinksSender,
    ConfirmedSendCommand,
    SendArgs,
    confirmation_fingerprint,
)
from app.modules.agent.models import (
    AgentBacklinksConsent,
    AgentBacklinksContinuation,
    AgentBacklinksSendBatch,
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentWorkflowDispatch,
)
from app.modules.agent.repository import AgentRepository
from app.modules.projects.authority import SQLAlchemyWebsiteProjectAuthority
from app.modules.projects.models import Project

FINAL_INTENTS = {"PROVIDER_ACCEPTED", "FAILED_FINAL", "CANCELLED", "REJECTED"}
INTENT_STATES = FINAL_INTENTS | {"READY", "DISPATCHING", "DELIVERY_UNKNOWN", "FAILED_RETRYABLE"}


class SendBatchPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    draft_ids: list[UUID] = Field(min_length=1, max_length=20)
    gmail_connection_id: UUID

    @field_validator("draft_ids")
    @classmethod
    def unique_drafts(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("duplicate draft IDs")
        return values


class SendBatchConfirmation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: bool = Field(strict=True)
    manifest_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


def manifest_hash(batch):
    manifest = {
        "id": batch.id, "request": batch.request_json,
        "expires_at": batch.expires_at.isoformat(),
        "items": [{k: item[k] for k in ("target", "snapshot", "preview", "operation_id")}
                  for item in batch.items_json],
    }
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def view(batch):
    return {
        "id": batch.id, "run_id": batch.run_id, "state": batch.state, "reason": batch.reason,
        "expires_at": batch.expires_at, "confirmed_at": batch.confirmed_at,
        "confirmation_expires_at": min(batch.expires_at, batch.created_at + timedelta(minutes=5)),
        "revoked_at": batch.revoked_at, "manifest_hash": manifest_hash(batch),
        "items": [{k: v for k, v in item.items() if k not in {"snapshot", "operation_id"}}
                  for item in batch.items_json],
    }


class BacklinksSendBatchStore:
    def __init__(self, sessions, settings, *, gateway=None):
        self.sessions, self.settings, self.gateway = sessions, settings, gateway

    def drafts(self, authority):
        return BacklinksDrafts(BacklinksReader(
            self.settings, SQLAlchemyWebsiteProjectAuthority(self.sessions),
            self.gateway, authority=authority,
        ))

    async def candidates(self, session, consent):
        if consent.policy_json.get("policy_version") == "backlinks-chat-send.v1":
            return [item["draft_id"] for item in consent.policy_json["targets"]["items"]]
        continuation = await session.scalar(select(AgentBacklinksContinuation).where(
            AgentBacklinksContinuation.consent_id == consent.id,
        ))
        return [
            item["draftId"] for item in continuation.checkpoint_json["results"]
            if item["state"] == "VERIFIED_DRAFT"
        ] if continuation else []

    async def consent(self, session, context, consent_id, *, write=False, active=False):
        permission = "backlinks:write" if write else "backlinks:read"
        if permission not in context.permissions:
            raise ConsentError("BACKLINKS_SEND_PERMISSION_DENIED")
        record = await session.scalar(select(AgentBacklinksConsent).where(
            *scope(context), AgentBacklinksConsent.id == consent_id,
        ).with_for_update() if write else select(AgentBacklinksConsent).where(
            *scope(context), AgentBacklinksConsent.id == consent_id,
        ))
        if record is None:
            raise ConsentError("BACKLINKS_CONSENT_NOT_FOUND", 404)
        if active and consent_state(record, datetime.now(UTC)) != "active":
            raise ConsentError("BACKLINKS_CONSENT_INACTIVE")
        if write:
            BacklinksContinuationStore.check_project(await session.get(Project, record.project_id), record)
        return record

    async def list(self, context, consent_id):
        async with self.sessions() as session:
            await self.consent(session, context, consent_id)
            records = (await session.scalars(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.consent_id == consent_id,
            ).order_by(AgentBacklinksSendBatch.created_at.desc(), AgentBacklinksSendBatch.id.desc()).limit(20))).all()
            items = []
            for record in records:
                item = view(record)
                run = await session.get(AgentRun, record.run_id) if record.run_id else None
                if run and run.status == "cancelled":
                    item["state"] = "cancelled"
                items.append(item)
            return {"items": items}

    async def preview(self, context, consent_id, request):
        values = request.model_dump(mode="json")
        async with self.sessions() as session, session.begin():
            consent = await self.consent(session, context, consent_id, write=True, active=True)
            existing = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.consent_id == consent_id,
                AgentBacklinksSendBatch.request_id == str(request.request_id),
            ))
            if existing:
                if existing.request_json != values:
                    raise ConsentError("BACKLINKS_SEND_REQUEST_CONFLICT", 409)
                return view(existing)
            candidates = set(await self.candidates(session, consent))
            if not set(values["draft_ids"]) <= candidates:
                raise ConsentError("BACKLINKS_SEND_DRAFTS_OUTSIDE_BATCH", 409)
            chat_targets = None
            if consent.policy_json.get("policy_version") == "backlinks-chat-send.v1":
                chat_targets = consent.policy_json["targets"]
                if (
                    values["request_id"] != consent.request_id
                    or not set(values["draft_ids"]) <= {item["draft_id"] for item in chat_targets["items"]}
                    or values["gmail_connection_id"] != chat_targets["gmail_connection_id"]
                ):
                    raise ConsentError("BACKLINKS_CHAT_SEND_REQUEST_CHANGED", 409)

            async def authority(project, organization, *, write):
                if project != consent.project_id or organization != consent.organization_id:
                    raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
                return context

            drafts = self.drafts(authority)
            batch_id, now = str(uuid4()), datetime.now(UTC)
            expiry = min(consent.expires_at, now + timedelta(hours=24))
            items, recipients = [], set()
            from app.modules.agent.backlinks_quality import BacklinksQuality
            quality = BacklinksQuality(self)
            reports = await quality.reports(context, consent_id)
            for draft_id in values["draft_ids"]:
                if chat_targets or draft_id in reports:
                    await quality.require_pass(context, consent_id, draft_id)
                data = await drafts._request(consent.project_id, consent.organization_id, None, f"drafts/{draft_id}")
                draft = data["draft"]
                version, snapshot, freshness = (
                    draft.get("currentVersion") or {}, draft.get("inputSnapshot") or {},
                    draft.get("freshness") or {},
                )
                if (
                    draft.get("id") != draft_id or not draft.get("approvedVersionId")
                    or draft["approvedVersionId"] != version.get("id")
                    or freshness.get("state") != "FRESH" or freshness.get("regenerateRequired") is not False
                    or not version.get("subjectText") or not version.get("bodyText")
                    or draft.get("contactId") != snapshot.get("contactId")
                    or draft.get("contactVersion") != snapshot.get("contactVersion")
                ):
                    raise ConsentError("BACKLINKS_SEND_REQUIRES_APPROVED_CURRENT_DRAFT", 409)
                if chat_targets:
                    pin = next(item for item in chat_targets["items"] if item["draft_id"] == draft_id)
                    from app.modules.agent.backlinks_quality_repair import BacklinksQualityRepair
                    pin = await BacklinksQualityRepair(self).resolve_pin(context, consent_id, pin)
                    if (
                        version.get("id") != pin["version_id"]
                        or draft.get("contactId") != pin["contact_id"]
                        or draft.get("contactVersion") != pin["contact_version"]
                    ):
                        raise ConsentError("BACKLINKS_CHAT_SEND_TARGET_CHANGED", 409)
                target = SendArgs(
                    draftId=draft_id, approvedDraftVersionId=draft["approvedVersionId"],
                    contactId=draft["contactId"], contactVersion=draft["contactVersion"],
                    gmailConnectionId=values["gmail_connection_id"],
                    messagePurpose="INITIAL_OUTREACH", followUpIndex=0,
                ).model_dump(mode="json")
                contacts = await drafts._request(
                    consent.project_id, consent.organization_id, None,
                    f"opportunities/{UUID(draft['opportunityId'])}/contacts",
                )
                contact = next((c for c in contacts["items"] if c["id"] == target["contactId"]), None)
                if (
                    not contact or contact.get("status") != "active" or not contact.get("confirmedAt")
                    or contact.get("version") != target["contactVersion"]
                    or contact.get("guessed") is not False or not contact.get("normalizedEmail")
                ):
                    raise ConsentError("BACKLINKS_SEND_CONTACT_UNCONFIRMED", 409)
                recipient = contact["normalizedEmail"].strip().lower()
                if recipient in recipients:
                    raise ConsentError("BACKLINKS_SEND_DUPLICATE_RECIPIENT", 409)
                recipients.add(recipient)
                items.append({
                    "target": target, "operation_id": child_operation(batch_id, draft_id),
                    "preview": {"recipient": recipient, "subject": version["subjectText"],
                                "body": version["bodyText"]},
                    "state": "PENDING",
                })
            batch_preflight = await drafts._request(
                consent.project_id, consent.organization_id, None, "send-batch-preflight",
                body={"items": [item["target"] for item in items]},
            )
            if len(batch_preflight["items"]) != len(items):
                raise ConsentError("BACKLINKS_SEND_PREFLIGHT_INVALID", 409)
            for item, preflight in zip(items, batch_preflight["items"], strict=True):
                readiness = preflight.get("readinessSnapshot") or {}
                if (
                    preflight.get("draftId") != item["target"]["draftId"]
                    or
                    preflight.get("allowed") is not True or preflight.get("deliveryState") != "NOT_SENT"
                    or (preflight.get("gmail") or {}).get("connectionId") != values["gmail_connection_id"]
                    or not readiness.get("snapshotVersion")
                ):
                    raise ConsentError("BACKLINKS_SEND_PREFLIGHT_INVALID", 409)
                expiry = min(expiry, datetime.fromisoformat(readiness["expiresAt"]))
                item["snapshot"] = readiness
                item["preview"]["sender"] = preflight["gmail"]["primaryEmail"]
            if expiry <= datetime.now(UTC):
                raise ConsentError("BACKLINKS_SEND_PREVIEW_EXPIRED", 409)
            batch = AgentBacklinksSendBatch(
                id=batch_id, consent_id=consent_id, request_id=str(request.request_id),
                roles_json=list(context.actor.roles), request_json=values, items_json=items,
                state="preview", created_at=now, expires_at=expiry,
            )
            session.add(batch)
            return view(batch)

    async def confirm(self, context, consent_id, batch_id, body, limits):
        if body.confirmed is not True:
            raise ConsentError("BACKLINKS_SEND_CONFIRMATION_REQUIRED", 422)
        async with self.sessions() as session, session.begin():
            consent = await self.consent(session, context, consent_id, write=True, active=True)
            batch = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.id == batch_id, AgentBacklinksSendBatch.consent_id == consent_id,
            ).with_for_update())
            if batch is None:
                raise ConsentError("BACKLINKS_SEND_BATCH_NOT_FOUND", 404)
            if manifest_hash(batch) != body.manifest_hash:
                raise ConsentError("BACKLINKS_SEND_MANIFEST_CHANGED", 409)
            if batch.run_id:
                return view(batch)
            now = datetime.now(UTC)
            if batch.revoked_at or min(batch.expires_at, batch.created_at + timedelta(minutes=5)) <= now:
                raise ConsentError("BACKLINKS_SEND_PREVIEW_EXPIRED", 409)
            conversation_id, message_id, run_id = (str(uuid4()) for _ in range(3))
            conversation = AgentConversation(
                id=conversation_id, organization_id=consent.organization_id, project_id=consent.project_id,
                created_by=consent.user_id, title="Confirmed Backlinks batch send",
            )
            session.add(conversation)
            await session.flush()
            session.add(AgentMessage(
                id=message_id, conversation_id=conversation_id, run_id=run_id, role="user",
                content="Submit only the exact user-authorized batch; do not approve or add targets.",
                metadata_json={
                    "send_batch_id": batch.id,
                    **({"source_message_id": consent.policy_json["source_message_id"]}
                       if consent.policy_json.get("policy_version") == "backlinks-chat-send.v1" else {}),
                },
            ))
            await session.flush()
            conversation.active_message_id = message_id
            bounded = {**limits, "backlinks_send_batch": True, "run_timeout_seconds": 86400}
            bounded.pop("backlinks_delegation", None)
            bounded.pop("backlinks_continuation", None)
            run = AgentRun(id=run_id, conversation_id=conversation_id, user_message_id=message_id,
                           workflow_id=f"agent:{run_id}", status="queued", limits_json=bounded)
            session.add(run)
            await session.flush()
            batch.run_id, batch.confirmed_at, batch.state = run_id, now, "queued"
            batch.roles_json = list(context.actor.roles)
            session.add(AgentWorkflowDispatch(
                run_id=run_id, workflow_id=run.workflow_id, task_payload={"run_id": run_id, "limits": bounded},
            ))
            return view(batch)

    async def revoke(self, context, consent_id, batch_id):
        async with self.sessions() as session, session.begin():
            await self.consent(session, context, consent_id, write=True)
            batch = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.id == batch_id, AgentBacklinksSendBatch.consent_id == consent_id,
            ).with_for_update())
            if batch is None:
                raise ConsentError("BACKLINKS_SEND_BATCH_NOT_FOUND", 404)
            batch.revoked_at = batch.revoked_at or datetime.now(UTC)
            if batch.state == "preview":
                batch.state = "revoked"
            return view(batch)

    async def authority(self, run_id, lease_id, project_id, organization_id, *, write):
        now = datetime.now(UTC)
        async with self.sessions() as session:
            batch = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.run_id == run_id,
            ))
            run = await session.get(AgentRun, run_id)
            if (
                not batch or not run or run.status not in ACTIVE or batch.lease_id != lease_id
                or not batch.lease_expires_at or batch.lease_expires_at <= now
            ):
                raise ConsentError("BACKLINKS_SEND_BATCH_STOPPED")
            consent = await session.get(AgentBacklinksConsent, batch.consent_id)
            project = await session.get(Project, consent.project_id)
            BacklinksContinuationStore.check_project(project, consent)
            if project_id != consent.project_id or organization_id != consent.organization_id:
                raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
            if write and (
                not batch.confirmed_at or batch.revoked_at or batch.expires_at <= now
                or consent_state(consent, now) != "active"
            ):
                raise ConsentError("BACKLINKS_SEND_AUTHORIZATION_INACTIVE")
            return ResolvedPlatformRequestContext(
                actor=PlatformActor(consent.user_id, f"agent-send-batch:{batch.id}", tuple(batch.roles_json)),
                tenant=PlatformTenant(consent.organization_id, consent.workspace_id),
                project=PlatformProject(project.id, project.project_key),
                permissions=("backlinks:write",) if write else ("backlinks:read",),
                correlation_id=f"agent-send-{uuid4()}",
            )

    async def tick(self, run_id):
        now, lease_id = datetime.now(UTC), str(uuid4())
        async with self.sessions() as session, session.begin():
            batch = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.run_id == run_id,
            ).with_for_update())
            run = await session.get(AgentRun, run_id)
            if not batch or not run or run.status not in ACTIVE:
                return {"done": True}
            if batch.state in {"completed", "paused", "needs_review"}:
                accepted = sum(item["state"] == "PROVIDER_ACCEPTED" for item in batch.items_json)
                await AgentRepository(self.sessions).finalize_run(
                    run_id, f"Provider-accepted messages: {accepted}/{len(batch.items_json)}. Not proof of delivery or reply.",
                    {"send_batch_id": batch.id, "provider_accepted": accepted, "state": batch.state},
                    "completed" if batch.state == "completed" else "failed", error_code=batch.reason,
                )
                return {"done": True}
            if batch.lease_expires_at and batch.lease_expires_at > now:
                return {"done": False, "wait_seconds": 30}
            batch.lease_id, batch.lease_expires_at = lease_id, now + timedelta(seconds=360)
            consent = await session.get(AgentBacklinksConsent, batch.consent_id)
            project_id, organization_id = consent.project_id, consent.organization_id
            items, state, reason = deepcopy(batch.items_json), "running", None
            run.status, run.started_at = "running", run.started_at or now

        async def authority(project, organization, *, write):
            return await self.authority(run_id, lease_id, project, organization, write=write)

        drafts = self.drafts(authority)
        try:
            await authority(project_id, organization_id, write=False)
            if any(item["state"] in {"PENDING", "SUBMITTING"} for item in items):
                await authority(project_id, organization_id, write=True)
            # Read back outstanding work before submitting another message.
            # A retry or ambiguous result must not let the batch run ahead.
            for item in items:
                if item["state"] in {"PENDING", "SUBMITTING", "PROVIDER_ACCEPTED"}:
                    continue
                if item["state"] in FINAL_INTENTS:
                    raise ConsentError("BACKLINKS_SEND_PREVIOUS_MESSAGE_FAILED", 409)
                result = await drafts._request(
                    project_id, organization_id, None, f"send-intents/{UUID(item['sendIntentId'])}",
                )
                intent = result["sendIntent"]
                if (
                    intent.get("sendIntentId") != item["sendIntentId"]
                    or intent.get("draftId") != item["target"]["draftId"]
                    or intent.get("approvedDraftVersionId") != item["target"]["approvedDraftVersionId"]
                    or intent.get("status") not in INTENT_STATES
                ):
                    raise ConsentError("BACKLINKS_SEND_READBACK_MISMATCH", 409)
                item["state"] = intent["status"]
                if item["state"] == "DELIVERY_UNKNOWN":
                    raise ConsentError("BACKLINKS_SEND_RECONCILIATION_REQUIRED", 409)
                if item["state"] in FINAL_INTENTS - {"PROVIDER_ACCEPTED"}:
                    raise ConsentError("BACKLINKS_SEND_PREVIOUS_MESSAGE_FAILED", 409)
            outstanding = any(
                item["state"] not in {"PENDING", "SUBMITTING", "PROVIDER_ACCEPTED"}
                for item in items
            )
            pending = next((item for item in items if item["state"] in {"PENDING", "SUBMITTING"}), None)
            if pending and not outstanding:
                if pending["state"] == "SUBMITTING":
                    raise ConsentError("BACKLINKS_SEND_SUBMISSION_UNVERIFIED", 409)
                command = await BatchConfirmationSource(self, run_id, lease_id).load(
                    await authority(project_id, organization_id, write=True), pending["operation_id"],
                )
                pending["state"] = "SUBMITTING"
                await self.save(run_id, lease_id, items, state, reason)
                result = await BacklinksSender(
                    drafts, BatchConfirmationSource(self, run_id, lease_id),
                ).submit(
                    project_id, organization_id, None,
                    {**pending["target"], "operation_id": pending["operation_id"]},
                    confirmation_fingerprint(command),
                )
                pending.update(state="READY", sendIntentId=result["sendIntentId"])
            elif all(item["state"] == "PROVIDER_ACCEPTED" for item in items):
                state = "completed"
            if datetime.now(UTC) > batch.confirmed_at + timedelta(hours=24):
                state, reason = "paused", "BACKLINKS_SEND_MONITOR_TIMEOUT"
        except (ConsentError, BacklinksReadError) as exc:
            state, reason = "paused", exc.code
        except (KeyError, TypeError, ValueError):
            state, reason = "paused", "BACKLINKS_SEND_INVALID_EVIDENCE"
        await self.save(run_id, lease_id, items, state, reason, release=True)
        done = state in {"completed", "paused", "needs_review"}
        if done:
            accepted = sum(item["state"] == "PROVIDER_ACCEPTED" for item in items)
            await AgentRepository(self.sessions).finalize_run(
                run_id, f"Provider-accepted messages: {accepted}/{len(items)}. Not proof of delivery or reply.",
                {"send_batch_id": batch.id, "provider_accepted": accepted, "state": state},
                "completed" if state == "completed" else "failed", error_code=reason,
            )
        return {"done": done, "wait_seconds": 30}

    async def save(self, run_id, lease_id, items, state, reason, *, release=False):
        async with self.sessions() as session, session.begin():
            batch = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.run_id == run_id,
            ).with_for_update())
            if batch.lease_id != lease_id:
                raise ConsentError("BACKLINKS_AUTOMATION_LEASE_LOST")
            batch.items_json, batch.state, batch.reason = deepcopy(items), state, reason
            if release:
                batch.lease_id = batch.lease_expires_at = None


class BatchConfirmationSource:
    def __init__(self, store, run_id, lease_id):
        self.store, self.run_id, self.lease_id = store, run_id, lease_id

    async def load(self, context, operation_id):
        authority = await self.store.authority(
            self.run_id, self.lease_id, context.project.website_project_id,
            context.tenant.organization_id, write=True,
        )
        if (
            authority.actor.user_id != context.actor.user_id
            or authority.tenant.workspace_id != context.tenant.workspace_id
        ):
            raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
        async with self.store.sessions() as session:
            batch = await session.scalar(select(AgentBacklinksSendBatch).where(
                AgentBacklinksSendBatch.run_id == self.run_id,
            ))
            item = next((i for i in batch.items_json if i["operation_id"] == operation_id), None)
            if not item or item["state"] not in {"PENDING", "SUBMITTING"}:
                raise ConsentError("BACKLINKS_SEND_AUTHORIZATION_REQUIRED")
            return ConfirmedSendCommand(
                organization_id=context.tenant.organization_id, workspace_id=context.tenant.workspace_id,
                project_id=context.project.website_project_id, user_id=context.actor.user_id,
                operation_id=operation_id, expires_at=batch.expires_at, target=item["target"],
                readiness_snapshot=item["snapshot"],
                human_confirmation={
                    "confirmed": True,
                    "confirmedAt": batch.confirmed_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
                    "readinessSnapshotVersion": item["snapshot"]["snapshotVersion"],
                },
            )
