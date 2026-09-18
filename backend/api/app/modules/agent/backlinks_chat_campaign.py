"""Bounded campaign authority derived from a persisted user command."""
import re
from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.modules.agent.backlinks_chat_send import BacklinksChatSend, explicit_chat_send
from app.modules.agent.backlinks_consent import ConsentError, consent_state, scope
from app.modules.agent.models import AgentBacklinksConsent, AgentMessage

POLICY = "backlinks-chat-campaign.v1"


def _campaign_intent_text(text):
    # Remove only complete, recognized safety clauses, never arbitrary negation.
    clauses = re.split(r"([，。；,;\n])", text)
    constraints = (
        r"(?:不|不要|不用)(?:重新|重复)(?:生成|启动)(?:外链)?推荐(?:池)?",
        r"(?:无需|不用|不需要)(?:我|用户)?(?:再|逐封)?确认",
        r"(?:也)?不要把(?:排队|已发送|服务商接受|邮件服务商接受)当(?:作|成)(?:已发送|已送达)",
        r"不要只生成(?:推荐|草稿|推荐或草稿)就结束",
        r"不强制要求网站带[“\"]推荐[”\"]标签",
        r"不要把[“\"]正在运行[”\"]当作完成",
        # These conditions reuse work or guard generation, not hypothetical consent.
        r"如果(?:外链)?推荐任务正在运行",
        r"如果没有可用(?:外链)?推荐",
        r"如果已有(?:符合本指令且)?授权有效的活动批次",
        r"(?:do\s+not|don't)\s+(?:regenerate|restart)\s+(?:the\s+)?recommendations?",
    )
    text = "".join(
        "" if any(re.fullmatch(pattern, clause.strip(), re.I) for pattern in constraints)
        else clause for clause in clauses
    )
    # A recipient's reply status is not a request to quote somebody else's command.
    return text.replace("已回复", "已回应")


def existing_pool_requested(text):
    return bool(re.search(
        r"(?:使用|复用|从)(?:当前项目|当前|本项目)?(?:已有|现有)?推荐池"
        r"|(?:use|reuse)(?:the)?(?:existing|current)recommendationpool",
        re.sub(r"\s+", "", text), re.I,
    ))


def campaign_selection_policy(text):
    """Derive selection scope from the original command, never model draft prose."""
    text = _campaign_intent_text(text)
    policy = {}
    if re.search(
        r"(?:尚未|还未|未|没有)加入机会|not\s+already\s+joined", text, re.I,
    ):
        policy["skip_existing_opportunities"] = True
    email_targets = re.search(
        r"(?:将|把|选择|筛选|处理)[^。；;\n]{0,48}有(?:有效|公开|已确认){0,2}"
        r"(?:邮箱|邮件|电子邮件)(?:地址)?[^。；;\n]{0,24}(?:网站|站点)"
        r"|(?:select|process|join)\s+(?:all\s+)?(?:websites|sites|targets)\s+"
        r"with\s+(?:(?:valid|public|confirmed)\s+)?emails?(?:\s+addresses)?",
        text, re.I,
    )
    relevance_required = re.search(
        r"(?:只|仅|必须)[^。；;\n]{0,24}(?:推荐|相关)"
        r"|\b(?:only|must\s+be)\s+(?:recommended|relevant)\b", text, re.I,
    )
    if existing_pool_requested(text) and email_targets and not relevance_required:
        policy["target_selection"] = "public_email"
    return policy


def draft_limit(text):
    """An explicit smaller mail count must not be widened by the default batch."""
    counts = re.findall(r"([0-9]+|[一二两三四五六七八九十])\s*封", text)
    chinese = dict(zip("一二两三四五六七八九十", (1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10)))
    limits = [int(value) if value.isascii() else chinese[value] for value in counts]
    english = dict(zip(
        ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"),
        range(11),
    ))
    counts = re.findall(
        r"\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)"
        r"\s+(?:outreach\s+)?(?:emails?|drafts?|messages?)\b", text.lower(),
    )
    limits.extend(int(value) if value.isdigit() else english[value] for value in counts)
    return min([5, *limits])


def campaign_send_authorized(text):
    text = _campaign_intent_text(text)
    # Requiring a passed preflight is a sending condition, not a dry-run request.
    normalized = re.sub(
        r"预检通过|通过预检|preflight\s+(?:has\s+)?passed|preflight\s+passes",
        "", text, flags=re.IGNORECASE,
    )
    # A paid-tool spending ceiling is not a request to implement a tool.
    normalized = re.sub(
        r"付费工具(?=\s*(?:费用|预算|上限|[0-9$￥]))", "付费项目", normalized,
    )
    return explicit_chat_send(normalized)


def explicit_campaign(text):
    normalized = re.sub(r"\s+", "", _campaign_intent_text(text)).lower()
    if re.search(
        r"(?:不要|不用|无需|别|禁止|不允许|先不|暂不|不能|do.?not|don't|never)"
        r"[^，。；,;]{0,32}(?:推荐|机会|草稿|开发信|邮件|发送|recommendation|opportunit|draft|email|send)"
        r"|(?:能不能|能否|是否|怎么|如何|吗|么|canyou|couldyou|howdo|howto|dry.?run|模拟|测试|[?？])"
        r"|(?:如果|假如|假设|代码|功能|方案|他说|返回|回复|code|implement|[\"“”`<>])",
        normalized,
    ):
        return False
    recommends = re.search(
        r"(?:启动|开始|运行|生成|跑).{0,24}(?:外链推荐|推荐池)"
        r"|(?:外链推荐|推荐池).{0,12}(?:跑出来|跑起来|启动|生成)"
        r"|(?:start|run|generate).{0,24}(?:backlinkrecommendations|recommendationpool|recommendationbatch)",
        normalized,
    )
    drafts = re.search(
        r"(?:生成|创建|撰写|写|起草|发送|发).{0,20}(?:草稿|开发信|邮件)"
        r"|(?:create|generate|write|prepare|send).{0,24}(?:drafts|emails|outreach)",
        normalized,
    )
    return bool((recommends or existing_pool_requested(normalized)) and drafts)


async def grant_campaign(reader, sessions, project_id, organization_id, delegation,
                         run_id, request, recommendation_mode, *, require_seo_metrics=False):
    context, message_id = await BacklinksChatSend(reader, sessions, {}).authorize(
        project_id, organization_id, delegation, run_id, command_check=explicit_campaign,
    )
    async with sessions() as session:
        message = await session.get(AgentMessage, message_id)
        if existing_pool_requested(message.content) and recommendation_mode != "current":
            raise ConsentError("BACKLINKS_CAMPAIGN_RECOMMENDATION_MODE_NOT_AUTHORIZED")
        sending = campaign_send_authorized(message.content)
        maximum = draft_limit(message.content)
        if maximum < 1:
            raise ConsentError("BACKLINKS_CAMPAIGN_ZERO_LIMIT")
    sender = None
    if sending:
        status = await reader.read(
            project_id, organization_id, "get_backlink_gmail_status", {}, delegation=delegation,
        )
        connection = status["data"].get("connection") or {}
        sender = connection.get("connectionId")
        if not sender:
            raise ConsentError("BACKLINKS_CAMPAIGN_SENDER_REQUIRED", 409)
    request_id = str(uuid5(NAMESPACE_URL, f"backlinks-chat-campaign:{message_id}"))
    policy = {
        "policy_version": POLICY, "source_run_id": run_id, "source_message_id": message_id,
        "max_opportunities": 10, "max_drafts": maximum,
        "max_model_cost_usd": "2", "max_paid_tool_cost_usd": "2",
        "send_authorized": sending, "gmail_connection_id": sender,
        "draft_request": request, "recommendation_mode": recommendation_mode,
    }
    if require_seo_metrics or re.search(
        r"(?:筛选|选择|只用|仅用|要求)[^。；;\n]{0,80}SEO\s*指标(?:完整|齐全)",
        message.content, re.I,
    ):
        policy["require_seo_metrics"] = True
    # Preference still forbids next_batch, but explicitly permits generation if no pool exists.
    allow_initial_generation = bool(re.search(
        r"如果没有可用(?:外链)?推荐[，,]\s*再生成一批", message.content,
    )) and not re.search(
        r"(?:不要|不|不用)(?:重新|重复)?生成(?:外链)?推荐", message.content,
    )
    if existing_pool_requested(message.content) and not allow_initial_generation:
        policy["existing_recommendations_only"] = True
    policy.update(campaign_selection_policy(message.content))
    async with sessions() as session, session.begin():
        identity = (*scope(context), AgentBacklinksConsent.request_id == request_id)
        record = await session.scalar(select(AgentBacklinksConsent).where(*identity))
        if record is None:
            now = datetime.now(UTC)
            await session.execute(insert(AgentBacklinksConsent).values(
                id=request_id, organization_id=organization_id,
                workspace_id=context.tenant.workspace_id, project_id=project_id,
                user_id=context.actor.user_id, request_id=request_id, policy_json=policy,
                created_at=now, expires_at=now + timedelta(hours=24),
            ).on_conflict_do_nothing(constraint="uq_agent_backlinks_consents_request"))
            record = await session.scalar(select(AgentBacklinksConsent).where(*identity))
        if record.policy_json != policy:
            raise ConsentError("BACKLINKS_CAMPAIGN_AUTHORIZATION_CHANGED", 409)
        if consent_state(record, datetime.now(UTC)) != "active":
            raise ConsentError("BACKLINKS_CONSENT_INACTIVE")
    return context, request_id, policy


async def queue_authorized_drafts(store, context, consent_id, policy, limits):
    """Bind delegated approval to saved, passing versions; never renew a batch."""
    from app.modules.agent.backlinks_draft_review import (
        DraftApprovalItem, DraftReviewApproval, approve_reviewed_drafts, review_drafts,
    )
    from app.modules.agent.backlinks_quality import BacklinksQuality
    from app.modules.agent.backlinks_send_batch import SendBatchConfirmation, SendBatchPreviewRequest

    async with store.sessions() as session:
        consent = await store.consent(session, context, consent_id, active=True)
        if consent.policy_json != policy:
            raise ConsentError("BACKLINKS_CAMPAIGN_AUTHORIZATION_CHANGED", 409)
    if policy.get("policy_version") != POLICY or policy.get("send_authorized") is not True:
        raise ConsentError("BACKLINKS_CAMPAIGN_SEND_NOT_AUTHORIZED")
    request_id = str(uuid5(NAMESPACE_URL, f"backlinks-campaign-send:{consent_id}"))
    batches = (await store.list(context, consent_id))["items"]
    if batches:
        # Preview may have committed before the worker stopped. Reuse its pinned
        # manifest; an expired or changed preview must not silently be replaced.
        batch = batches[0]
        if batch["run_id"]:
            return batch
    else:
        reviewed = (await review_drafts(store, context, consent_id))["items"]
        selected = [item for item in reviewed if item["reviewable"]
                    and (item.get("quality") or {}).get("state") == "PASSED"]
        if not selected:
            return None
        if len(selected) > policy["max_drafts"] or len(selected) > 20:
            raise ConsentError("BACKLINKS_CAMPAIGN_SEND_LIMIT")
        for item in selected:
            await BacklinksQuality(store).require_pass(context, consent_id, item["draft_id"])
        await approve_reviewed_drafts(store, context, consent_id, DraftReviewApproval(
            request_id=request_id, confirmed=True,
            items=[DraftApprovalItem(**{key: item[key] for key in (
                "draft_id", "version_id", "expected_version",
            )}) for item in selected],
        ))
        batch = await store.preview(context, consent_id, SendBatchPreviewRequest(
            request_id=request_id, draft_ids=[item["draft_id"] for item in selected],
            gmail_connection_id=policy["gmail_connection_id"],
        ))
    return await store.confirm(
        context, consent_id, batch["id"],
        SendBatchConfirmation(confirmed=True, manifest_hash=batch["manifest_hash"]), limits,
    )
