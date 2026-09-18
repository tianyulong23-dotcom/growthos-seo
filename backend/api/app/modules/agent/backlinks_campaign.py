"""Conversation adapters for existing consent-bound business workflows."""
from uuid import UUID
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

from app.modules.agent.backlinks_consent import BacklinksConsentStore, ConsentError
from app.modules.agent.backlinks_continuation_store import BacklinksContinuationStore
from app.modules.agent.backlinks_drafts import DraftRequest
from app.modules.agent.backlinks_send_batch import BacklinksSendBatchStore
from app.modules.agent.backlinks_read import BacklinksReadError
from app.modules.agent.backlinks_mail_monitoring import monitor_batches


class CampaignStatusArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    consent_id: UUID | None = None


class StartCampaignArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    consent_id: UUID | None = None
    request: DraftRequest | None = None
    recommendation_mode: Literal["current", "next_batch"] | None = None
    require_seo_metrics: bool | None = None

    @model_validator(mode="after")
    def require_new_campaign_request(self):
        if self.consent_id is None and self.request is None:
            raise ValueError("A new campaign requires a draft request")
        return self


def send_handoff(execution, batches):
    """Expose persisted candidates, never infer permission to send from a draft run."""
    checkpoint = (execution or {}).get("checkpoint") or {}
    reserved = {
        item["target"]["draftId"]
        for batch in batches["items"] for item in batch["items"]
    }
    candidates = list(dict.fromkeys(
        item["draftId"] for item in checkpoint.get("results", [])
        if item.get("state") == "VERIFIED_DRAFT" and item.get("draftId")
        and item["draftId"] not in reserved
    ))
    if not execution:
        state = "NOT_STARTED"
    elif checkpoint.get("stage") == "paused" or execution.get("status") in {"failed", "cancelled"}:
        state = "PAUSED"
    elif checkpoint.get("stage") != "done" or checkpoint.get("quality_pending"):
        state = "PREPARING_DRAFTS"
    else:
        state = "AWAITING_SEND_AUTHORIZATION" if candidates else "NO_UNBATCHED_DRAFTS"
    if state != "AWAITING_SEND_AUTHORIZATION":
        candidates = []
    return {
        "state": state, "draft_ids": candidates[:20],
        "remaining_count": max(0, len(candidates) - 20),
        "sending_allowed": False,
        "next": "These are draft candidates, not approved send targets. Read each saved draft "
        "and its current contact/version, then read the Gmail sender. Only a current explicit "
        "user send command for those exact drafts may call send_backlink_drafts (at most 20). "
        "Otherwise obtain send authorization; draft-only consent does not authorize sending. "
        "Check project send intents before submission, including batches under other consents. "
        "Never resubmit queued, accepted or uncertain sends. Use the returned send consent_id "
        "to monitor that batch; it is separate from this draft campaign.",
    }


class BacklinksCampaign:
    def __init__(self, reader, sessions, limits):
        self.reader, self.sessions, self.limits = reader, sessions, limits

    async def status(self, project_id, organization_id, delegation, consent_id=None):
        context = await self.reader.resolve_write_context(
            project_id, organization_id, delegation, write=False,
        )
        consents = BacklinksConsentStore(self.sessions)
        if consent_id is None:
            listed = await consents.list(context)
            return {**listed, "sending_allowed": any(
                item["sending_allowed"] for item in listed["items"]
            ),
                    "next": "For a new explicit recommendation-to-outreach command, "
                    "start_backlink_campaign may omit consent_id to record bounded chat authority. "
                    "Never reuse or enlarge a different campaign's authority."}
        consent = await consents.get(context, str(consent_id))
        execution = (
            None if consent["policy"]["policy_version"] == "backlinks-chat-send.v1"
            else await BacklinksContinuationStore(self.sessions).get(context, str(consent_id))
        )
        batches = await BacklinksSendBatchStore(
            self.sessions, self.reader.settings, gateway=self.reader.gateway,
        ).list(context, str(consent_id))
        summaries = [{key: batch[key] for key in ("id", "state", "reason", "run_id")}
                     | {"items": [{key: item[key] for key in ("target", "state", "sendIntentId")
                                   if key in item} for item in batch["items"]]}
                     for batch in batches["items"]]
        monitoring = {}
        for name, args in (("get_backlink_gmail_status", {}),
                           ("list_backlink_mail", {"limit": 20})):
            try:
                monitoring[name] = await self.reader.read(
                    project_id, organization_id, name, args, delegation=delegation,
                )
            except BacklinksReadError as exc:
                monitoring[name] = {"unavailable": True, "reason": exc.code}
        connection = monitoring.get("get_backlink_gmail_status", {}).get("data", {}).get("connection")
        if connection and connection.get("connectionId"):
            try:
                monitoring["sync"] = await self.reader.read(
                    project_id, organization_id, "get_backlink_gmail_sync_status",
                    {"connectionId": connection["connectionId"]}, delegation=delegation,
                )
            except BacklinksReadError as exc:
                monitoring["sync"] = {"unavailable": True, "reason": exc.code}
        async def read(name, args):
            return await self.reader.read(project_id, organization_id, name, args, delegation=delegation)
        batch_monitoring = await monitor_batches(batches, read) if batches["items"] else None
        handoff = send_handoff(execution, batches)
        if consent["policy"].get("policy_version") == "backlinks-chat-campaign.v1":
            checkpoint = (execution or {}).get("checkpoint", {})
            recorded_batch = checkpoint.get("send_batch", {})
            live_batch = next((batch for batch in batches["items"]
                               if batch["id"] == recorded_batch.get("id")), None)
            repair_available = (
                (execution or {}).get("status") == "completed"
                and checkpoint.get("send_batch", {}).get("state") == "NO_PASSING_DRAFTS"
                and consent["sending_allowed"] and not batches["items"]
                and not checkpoint.get("quality_resume_started")
                and not checkpoint.get("pending")
                and any(item.get("state") == "VERIFIED_DRAFT"
                        for item in checkpoint.get("results", []))
            )
            handoff = {
                "state": (live_batch or recorded_batch).get("state", "CAMPAIGN_OWNS_HANDOFF"),
                "provider_accepted_count": sum(
                    item.get("state") == "PROVIDER_ACCEPTED"
                    for batch in batches["items"] for item in batch["items"]
                ),
                "sending_allowed": consent["sending_allowed"],
                "repair_resume_available": repair_available,
                "next": "This bounded campaign owns its automatic handoff. "
                "Monitor its checkpoint and batches; do not submit its drafts separately. "
                "Only if repair_resume_available is true, call "
                "start_backlink_campaign with only consent_id to attempt bounded repair "
                "of its saved drafts. Never change its request or create replacement authority. "
                "A completed preparation run does not mean any email was sent.",
            }
        return {"execution": execution, "send_batches": {"items": summaries},
                "send_handoff": handoff,
                "batch_monitoring": batch_monitoring,
                "mail_monitoring": monitoring,
                "next": "For a new explicit chat command to send saved drafts, use send_backlink_drafts. "
                "Do not resubmit drafts already in these send batches. "
                "Use list_backlink_mail/get_backlink_mail_thread and Gmail sync diagnostics "
                "for persisted correspondence. The mail page is project-wide, not batch-only; "
                "do not label unassociated mail as a campaign reply. Provider acceptance is not delivery. "
                "An unavailable/stale sync is not an empty inbox. Monitoring uses existing Gmail "
                "polling/push workflows and requires a healthy, enabled connection."}

    async def start(self, project_id, organization_id, delegation, arguments, *, run_id=None):
        values = StartCampaignArgs.model_validate(arguments)
        policy = {}
        request = values.request.model_dump(mode="json") if values.request else None
        mode = values.recommendation_mode
        if values.consent_id is None:
            from app.modules.agent.backlinks_chat_campaign import grant_campaign
            context, consent_id, policy = await grant_campaign(
                self.reader, self.sessions, project_id, organization_id, delegation,
                run_id, request, mode or "next_batch",
                require_seo_metrics=values.require_seo_metrics is True,
            )
            mode = mode or "next_batch"
        else:
            context = await self.reader.resolve_write_context(
                project_id, organization_id, delegation, write=True,
            )
            read_context = await self.reader.resolve_write_context(
                project_id, organization_id, delegation, write=False,
            )
            consent_id = str(values.consent_id)
            consent = await BacklinksConsentStore(self.sessions).get(read_context, consent_id)
            policy = consent["policy"]
            if (values.require_seo_metrics is not None
                    and values.require_seo_metrics != policy.get("require_seo_metrics", False)):
                raise ConsentError("BACKLINKS_CAMPAIGN_AUTHORIZATION_CHANGED", 409)
            if request is None:
                request = policy.get("draft_request")
            if mode is None:
                mode = policy.get("recommendation_mode", "next_batch")
            if request is None:
                raise ValueError("This consent requires an explicit draft request")
        # The durable store revalidates owner, scope, expiry, budget and readiness.
        execution = await BacklinksContinuationStore(self.sessions).start(
            context, consent_id, request,
            self.limits, recommendation_mode=mode,
        )
        return {
            **execution, "verified": True, "verification": "persisted_campaign_only",
            "consent_id": consent_id, "sending_allowed": policy.get("send_authorized", False),
            "authorization_policy": policy,
            "next": "The durable recommendation-to-draft workflow is accepted, not completed. "
            "Use get_backlink_campaign with this consent_id for progress and send_handoff. "
            "Do not also start individual recommendation, join or draft jobs. "
            "A chat campaign sends only its own passing drafts under its recorded bounded "
            "send authority. Draft-only consent never authorizes sending.",
        }
