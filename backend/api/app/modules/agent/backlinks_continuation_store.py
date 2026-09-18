"""Durable checkpoints on the existing Agent dispatch queue."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import select

from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.agent.backlinks_automation import BACKLINKS_READY_TRIGGER
from app.modules.agent.backlinks_consent import ConsentError, consent_state, scope, view as consent_view
from app.modules.agent.backlinks_continuation import (
    TERMINAL_STAGES,
    ContinuationStep,
    initial_checkpoint,
)
from app.modules.agent.backlinks_drafts import BacklinksDrafts
from app.modules.agent.backlinks_pipeline import BacklinksPipeline
from app.modules.agent.backlinks_read import BacklinksReader
from app.modules.agent.models import (
    AgentBacklinksConsent,
    AgentBacklinksContinuation,
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentSystemTrigger,
    AgentWorkflowDispatch,
)
from app.modules.agent.repository import AgentRepository
from app.modules.projects.authority import SQLAlchemyWebsiteProjectAuthority
from app.modules.projects.models import Project

ACTIVE = {"queued", "running", "executing", "verifying"}


def continuation_summary(state):
    verified = sum(item["state"] == "VERIFIED_DRAFT" for item in state["results"])
    passed = sum(item.get("quality", {}).get("state") == "PASSED" for item in state["results"])
    failed_jobs = sum(item["state"] == "JOB_FAILED" for item in state["results"])
    review_errors = sum(item.get("quality", {}).get("state") == "ERROR" for item in state["results"])
    blocked = sum(item.get("quality", {}).get("state") == "BLOCKED" for item in state["results"])
    send_status = state.get("send_batch", {}).get("state")
    if send_status in {"NO_PASSING_DRAFTS", "NO_ELIGIBLE_TARGETS"}:
        summary = f"未创建发送批次，排队 0 封，本任务发送 0 封。原因：{send_status}。"
    elif send_status:
        summary = f"发送批次状态：{send_status}。排队不代表已发送，需核对邮件服务商接受结果。"
    else:
        summary = "本任务未提交邮件发送。"
    summary = (
        f"已生成并校验草稿 {verified} 封，审核通过 {passed} 封，"
        f"生成失败 {failed_jobs} 封，审核不可用 {review_errors} 封，"
        f"审核拦截 {blocked} 封。{summary}"
    )
    selection = state.get("selection")
    if selection:
        reasons = {
            "NO_PUBLIC_EMAIL": "没有可用的公开邮箱",
            "ARCHIVED": "已归档",
            "ALREADY_JOINED": "已加入机会",
            "SEO_METRICS_MISSING": "SEO 指标不完整",
            "RECOMMENDATION_REQUIRED": "不符合仅推荐站点的筛选条件",
        }
        skipped = "；".join(
            f"{reasons.get(reason, reason)} {count}"
            for reason, count in selection["skipped"].items()
        ) or "无"
        summary += (
            f" 已扫描 {selection['scanned']} 个网站，"
            f"符合筛选条件 {selection['eligible']} 个。跳过：{skipped}。"
        )
    return summary


class BacklinksContinuationStore:
    def __init__(self, sessions):
        self.sessions = sessions

    @staticmethod
    def view(record, run, consent):
        return {
            "run_id": run.id, "conversation_id": run.conversation_id, "status": run.status,
            "checkpoint": record.checkpoint_json,
            "sending_allowed": consent_view(consent, datetime.now(UTC))["sending_allowed"],
            "accounting": "conservative_reservations_not_actual_spend",
        }

    async def start(self, context, consent_id, request, limits, *, recommendation_mode="current"):
        if recommendation_mode not in {"current", "next_batch"}:
            raise ConsentError("BACKLINKS_AUTOMATION_MODE_INVALID", 422)
        if "backlinks:write" not in context.permissions:
            raise ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
        now = datetime.now(UTC)
        async with self.sessions() as session, session.begin():
            consent = await session.scalar(select(AgentBacklinksConsent).where(
                *scope(context), AgentBacklinksConsent.id == consent_id,
            ).with_for_update())
            if consent is None:
                raise ConsentError("BACKLINKS_CONSENT_NOT_FOUND", 404)
            if consent_state(consent, now) != "active":
                raise ConsentError("BACKLINKS_CONSENT_INACTIVE")
            if consent.policy_json.get("policy_version") not in {
                "backlinks-drafts-only.v1", "backlinks-chat-campaign.v1",
            }:
                raise ConsentError("BACKLINKS_CONSENT_POLICY_MISMATCH")
            if consent.policy_json.get("policy_version") == "backlinks-chat-campaign.v1":
                if (consent.policy_json.get("draft_request") != request
                    or consent.policy_json.get("recommendation_mode") != recommendation_mode):
                    raise ConsentError("BACKLINKS_CAMPAIGN_AUTHORIZATION_CHANGED", 409)
            existing = await session.scalar(select(AgentBacklinksContinuation).where(
                AgentBacklinksContinuation.consent_id == consent.id,
            ))
            if existing:
                if (existing.request_json != request
                    or existing.checkpoint_json.get("recommendation_mode", "current") != recommendation_mode):
                    raise ConsentError("BACKLINKS_AUTOMATION_REQUEST_CONFLICT", 409)
                run = await session.get(AgentRun, existing.run_id)
                await self.resume_recommendation(session, context, consent, existing, run, now)
                return self.view(existing, run, consent)
            # Serialize starts even when different users hold separate project consents.
            project = await session.scalar(select(Project).where(
                Project.id == consent.project_id,
            ).with_for_update())
            self.check_project(project, consent)
            active = await session.scalar(
                select(AgentRun.id).join(
                    AgentBacklinksContinuation, AgentBacklinksContinuation.run_id == AgentRun.id,
                ).join(
                    AgentBacklinksConsent,
                    AgentBacklinksConsent.id == AgentBacklinksContinuation.consent_id,
                ).where(AgentBacklinksConsent.project_id == project.id, AgentRun.status.in_(ACTIVE))
            )
            if active:
                raise ConsentError("BACKLINKS_AUTOMATION_ALREADY_RUNNING", 409)
            ready = await session.scalar(select(AgentSystemTrigger).where(
                AgentSystemTrigger.project_id == project.id,
                AgentSystemTrigger.organization_id == consent.organization_id,
                AgentSystemTrigger.trigger == BACKLINKS_READY_TRIGGER,
            ))
            if ready is None:
                raise ConsentError("BACKLINKS_PROJECT_INPUTS_NOT_READY", 409)
            conversation_id, message_id, run_id = (str(uuid4()) for _ in range(3))
            conversation = AgentConversation(
                id=conversation_id, organization_id=consent.organization_id,
                project_id=project.id, created_by=consent.user_id,
                title="Backlinks draft automation",
            )
            session.add(conversation)
            await session.flush()
            session.add(AgentMessage(
                id=message_id, conversation_id=conversation_id, run_id=run_id, role="user",
                content="Run the bounded consent workflow. Send only if its recorded policy "
                "explicitly authorizes this campaign's reviewed drafts.",
                metadata_json={"automation_consent_id": consent.id},
            ))
            await session.flush()
            conversation.active_message_id = message_id
            bounded_limits = {
                **limits, "backlinks_continuation": True,
                "run_timeout_seconds": max(1, int((consent.expires_at - now).total_seconds())),
            }
            bounded_limits.pop("backlinks_delegation", None)
            run = AgentRun(
                id=run_id, conversation_id=conversation_id, user_message_id=message_id,
                workflow_id=f"agent:{run_id}", status="queued", limits_json=bounded_limits,
            )
            session.add(run)
            await session.flush()
            record = AgentBacklinksContinuation(
                run_id=run_id, consent_id=consent.id, roles_json=list(context.actor.roles),
                request_json=request, checkpoint_json=initial_checkpoint(recommendation_mode),
            )
            session.add_all([record, AgentWorkflowDispatch(
                run_id=run_id, workflow_id=run.workflow_id,
                task_payload={"run_id": run_id, "limits": bounded_limits},
            )])
            return self.view(record, run, consent)

    async def resume_recommendation(self, session, context, consent, record, run, now):
        state = deepcopy(record.checkpoint_json)
        stage = {
            "RECOMMENDATIONS_NOT_RELEASED": "recommend",
            "RECOMMENDATIONS_REQUIRE_REVIEW": "recommend",
            "REFILL_REQUIRES_REVIEW": "wait_refill",
        }.get(state.get("reason"))
        interrupted_wait = (
            run.error_code == "agent_workflow_closed"
            and state.get("stage") in {"recommend", "wait_refill"}
            and state.get("resumed_from") in {
                "RECOMMENDATIONS_NOT_RELEASED",
                "RECOMMENDATIONS_REQUIRE_REVIEW", "REFILL_REQUIRES_REVIEW",
            }
        )
        if interrupted_wait:
            stage = state["stage"]
        quality_resume = (
            run.status == "completed" and state.get("stage") == "done"
            and state.get("send_batch", {}).get("state") == "NO_PASSING_DRAFTS"
            and consent.policy_json.get("policy_version") == "backlinks-chat-campaign.v1"
            and consent.policy_json.get("send_authorized") is True
            and not state.get("pending") and not state.get("quality_resume_started")
            and any(item.get("state") == "VERIFIED_DRAFT" for item in state.get("results", []))
        )
        if not quality_resume and not (
            run.status == "failed" and stage
            and (state.get("stage") == "paused" or interrupted_wait)
            and state.get("generation") and not state.get("pending")
            and not state.get("results") and not state.get("queue")
            and state.get("usage", {}).get("opportunities") == 0
            and state.get("usage", {}).get("drafts") == 0
        ):
            return
        if record.lease_expires_at and record.lease_expires_at > now:
            raise ConsentError("BACKLINKS_AUTOMATION_ALREADY_RUNNING", 409)
        project = await session.scalar(select(Project).where(
            Project.id == consent.project_id,
        ).with_for_update())
        self.check_project(project, consent)
        active = await session.scalar(
            select(AgentRun.id).join(AgentBacklinksContinuation,
                AgentBacklinksContinuation.run_id == AgentRun.id,
            ).join(AgentBacklinksConsent,
                AgentBacklinksConsent.id == AgentBacklinksContinuation.consent_id,
            ).where(AgentBacklinksConsent.project_id == project.id, AgentRun.status.in_(ACTIVE))
        )
        if active:
            raise ConsentError("BACKLINKS_AUTOMATION_ALREADY_RUNNING", 409)
        dispatch = await session.get(AgentWorkflowDispatch, run.id)
        # Preserve the pinned generation, all reservations and the original expiry.
        # The next tick must reread Core evidence before it can advance.
        if quality_resume:
            state["quality_queue"] = list(dict.fromkeys(
                item["draftId"] for item in state["results"]
                if item.get("state") == "VERIFIED_DRAFT"
            ))
            state["quality_resume_started"] = True
            state["quality_review_attempts"] = {}
            state.pop("send_batch", None)
        state["stage"] = "quality" if quality_resume else stage
        if "reason" in state:
            state["resumed_from"] = state.pop("reason")
        record.checkpoint_json = state
        record.roles_json = list(context.actor.roles)
        record.lease_id = record.lease_expires_at = None
        run.workflow_id = f"agent:{run.id}:resume:{uuid4()}"
        run.status, run.finished_at = "queued", None
        run.error_code = run.error_message = None
        dispatch.workflow_id, dispatch.status = run.workflow_id, "pending"
        dispatch.next_attempt_at, dispatch.dispatched_at = now, None
        dispatch.last_error = None

    @staticmethod
    def check_project(project, consent):
        if (
            project is None or project.status != "ACTIVE" or project.archived_at is not None
            or project.organization_id != consent.organization_id
            or project.workspace_id != consent.workspace_id
        ):
            raise ConsentError("BACKLINKS_AUTOMATION_PROJECT_UNAVAILABLE")

    async def get(self, context, consent_id):
        if "backlinks:read" not in context.permissions:
            raise ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
        async with self.sessions() as session:
            row = (await session.execute(
                select(AgentBacklinksContinuation, AgentRun, AgentBacklinksConsent)
                .join(AgentRun, AgentRun.id == AgentBacklinksContinuation.run_id)
                .join(AgentBacklinksConsent,
                      AgentBacklinksConsent.id == AgentBacklinksContinuation.consent_id)
                .where(*scope(context), AgentBacklinksConsent.id == consent_id)
            )).first()
            if row is None:
                raise ConsentError("BACKLINKS_AUTOMATION_NOT_FOUND", 404)
            return self.view(*row)

    async def authority(self, run_id, lease_id, project_id, organization_id, *, write):
        now = datetime.now(UTC)
        async with self.sessions() as session:
            record = await session.get(AgentBacklinksContinuation, run_id)
            run = await session.get(AgentRun, run_id)
            if (
                record is None or run is None or run.status not in ACTIVE
                or record.lease_id != lease_id or record.lease_expires_at <= now
            ):
                raise ConsentError("BACKLINKS_AUTOMATION_STOPPED")
            consent = await session.get(AgentBacklinksConsent, record.consent_id)
            if consent_state(consent, now) != "active":
                raise ConsentError("BACKLINKS_CONSENT_INACTIVE")
            project = await session.get(Project, consent.project_id)
            self.check_project(project, consent)
            if project_id != consent.project_id or organization_id != consent.organization_id:
                raise ConsentError("BACKLINKS_AUTOMATION_SCOPE_MISMATCH")
            return ResolvedPlatformRequestContext(
                actor=PlatformActor(consent.user_id, f"agent-consent:{consent.id}", tuple(record.roles_json)),
                tenant=PlatformTenant(consent.organization_id, consent.workspace_id),
                project=PlatformProject(project.id, project.project_key),
                permissions=("backlinks:write",) if write else ("backlinks:read",),
                correlation_id=f"agent-continuation-{uuid4()}",
            )

    async def tick(self, run_id, settings, *, gateway=None):
        now, lease_id = datetime.now(UTC), str(uuid4())
        async with self.sessions() as session, session.begin():
            record = await session.scalar(select(AgentBacklinksContinuation).where(
                AgentBacklinksContinuation.run_id == run_id,
            ).with_for_update())
            run = await session.get(AgentRun, run_id)
            if record is None or run is None or run.status not in ACTIVE:
                return {"done": True}
            if record.lease_expires_at and record.lease_expires_at > now:
                return {"done": False, "wait_seconds": 30}
            record.lease_id, record.lease_expires_at = lease_id, now + timedelta(seconds=660)
            state = deepcopy(record.checkpoint_json)
            consent = await session.get(AgentBacklinksConsent, record.consent_id)
            policy, project_id, organization_id = (
                consent.policy_json, consent.project_id, consent.organization_id,
            )
            request = record.request_json
            run.status, run.started_at = "running", run.started_at or now

        async def save(checkpoint, *, release=False):
            async with self.sessions() as session, session.begin():
                record = await session.scalar(select(AgentBacklinksContinuation).where(
                    AgentBacklinksContinuation.run_id == run_id,
                ).with_for_update())
                if record.lease_id != lease_id:
                    raise ConsentError("BACKLINKS_AUTOMATION_LEASE_LOST")
                record.checkpoint_json = deepcopy(checkpoint)
                if release:
                    record.lease_id = record.lease_expires_at = None

        async def authority(project_id, organization_id, *, write):
            return await self.authority(
                run_id, lease_id, project_id, organization_id, write=write,
            )

        reader = BacklinksReader(
            settings, SQLAlchemyWebsiteProjectAuthority(self.sessions), gateway, authority=authority,
        )
        async def review(checkpoint, draft_id):
            from decimal import Decimal, InvalidOperation
            from dataclasses import replace
            from app.modules.agent.backlinks_quality import BacklinksQuality
            from app.modules.agent.backlinks_quality_repair import BacklinksQualityRepair
            from app.modules.agent.backlinks_send_batch import BacklinksSendBatchStore
            from app.modules.agent.backlinks_drafts import BacklinksDrafts
            from app.modules.agent.backlinks_read import BacklinksReadError
            try:
                quote = await BacklinksDrafts(reader)._request(
                    project_id, organization_id, None, "automation-budget",
                    schema_version="backlinks.automation-budget.v1",
                )
                reservation = Decimal(str(quote["draftModelReservationUsd"]))
                if (quote.get("accounting") != "conservative_reservations"
                    or not reservation.is_finite() or reservation <= 0):
                    raise ValueError
                context = await authority(project_id, organization_id, write=True)
                context = replace(context, permissions=("backlinks:read", "backlinks:write"))
                quality = BacklinksQuality(BacklinksSendBatchStore(self.sessions, settings, gateway=gateway))
                repair = BacklinksQualityRepair(quality.store, quality=quality)
                budget_blocked = False

                def bounded(provider):
                    async def call(*args, **kwargs):
                        nonlocal budget_blocked
                        await authority(project_id, organization_id, write=True)
                        total = Decimal(checkpoint["usage"]["model_usd"]) + reservation
                        if total > Decimal(policy["max_model_cost_usd"]):
                            budget_blocked = True
                            raise ValueError("MODEL_BUDGET_LIMIT")
                        checkpoint["usage"]["model_usd"] = str(total)
                        await save(checkpoint)
                        return await provider(*args, **kwargs)
                    return call

                quality.reviewer = bounded(quality.reviewer)
                repair.repairer = bounded(repair.repairer)
                evaluator = (
                    repair if policy.get("policy_version") == "backlinks-chat-campaign.v1"
                    else quality
                )
                result = await evaluator.evaluate(
                    context, consent.id, [draft_id],
                    retry=(checkpoint.get("quality_review_attempts", {}).get(draft_id, 0) > 1
                           or checkpoint.get("quality_resume_started") is True),
                )
                if budget_blocked:
                    return {"state": "BLOCKED", "reasons": ["MODEL_BUDGET_LIMIT"]}
                return result["items"][0]
            except (BacklinksReadError, KeyError, ValueError, InvalidOperation):
                return {"state": "ERROR", "reasons": ["AI_REVIEW_UNAVAILABLE"]}

        step = ContinuationStep(
            BacklinksPipeline(BacklinksDrafts(reader)), project_id=project_id,
            organization_id=organization_id, run_id=run_id, policy=policy, request=request, save=save,
            review=review,
        )
        try:
            await authority(project_id, organization_id, write=False)
            state = await step.advance(state)
            if (state["stage"] == "done" and not state.get("quality_pending")
                and policy.get("send_authorized") is True
                and policy.get("policy_version") == "backlinks-chat-campaign.v1"):
                from dataclasses import replace
                from app.modules.agent.backlinks_chat_campaign import queue_authorized_drafts
                from app.modules.agent.backlinks_send_batch import BacklinksSendBatchStore
                # Candidate/quality readers use the persisted checkpoint, including
                # when the last candidate and terminal stage were produced this tick.
                await save(state)
                context = await authority(project_id, organization_id, write=True)
                context = replace(context, permissions=("backlinks:read", "backlinks:write"))
                batch = await queue_authorized_drafts(
                    BacklinksSendBatchStore(self.sessions, settings, gateway=gateway),
                    context, consent.id, policy, run.limits_json,
                )
                state["send_batch"] = (
                    {key: batch[key] for key in ("id", "run_id", "state")}
                    if batch else {"state": (
                        "NO_ELIGIBLE_TARGETS"
                        if state.get("selection", {}).get("eligible") == 0 and not state["results"]
                        else "NO_PASSING_DRAFTS"
                    )}
                )
        except ConsentError as exc:
            # Preserve a committed intent if revocation occurred during a compound command.
            async with self.sessions() as session:
                record = await session.get(AgentBacklinksContinuation, run_id)
                state = deepcopy(record.checkpoint_json)
            step.pause(state, exc.code)
        await save(state, release=True)
        done = state["stage"] in TERMINAL_STAGES and (
            state["stage"] != "done" or not state.get("quality_pending")
        )
        if done:
            await AgentRepository(self.sessions).finalize_run(
                run_id, continuation_summary(state),
                {"backlinks_automation": state, "sent": False},
                "completed" if state["stage"] == "done" else "failed",
                error_code=state.get("reason") if state["stage"] == "paused" else None,
            )
        return {"done": done, "wait_seconds": 30 if (
            state.get("quality_pending") or state["stage"] in {"recommend", "publish", "job"}
        ) else 1}
