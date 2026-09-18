import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.modules.agent.backlinks_chat_campaign import (
    POLICY, campaign_send_authorized, draft_limit, explicit_campaign, grant_campaign,
    queue_authorized_drafts,
)
from app.modules.agent.backlinks_consent import ConsentError, view
from app.modules.agent.backlinks_quality import BacklinksQuality
from app.modules.agent.models import AgentBacklinksConsent, AgentMessage, AgentRun
from test_agent_backlinks_chat_send import fake_approval_core, service_for
from test_agent_backlinks_drafts import CONTEXT, grant
from test_agent_backlinks_send import ACCOUNT
from test_agent_backlinks_send_batch import harness, identifier

REQUEST = {"promotionTargetUrl": "https://example.test/", "language": "en"}
COMMAND = "帮我跑推荐池，然后生成并发送一批开发信"
EXISTING_POOL_COMMAND = (
    "使用当前项目已有推荐池，不重新生成推荐。\n"
    "将有有效邮箱地址、尚未加入机会的网站加入机会，去重并跳过已发送、已回复、退订及发送状态不确定的目标。\n"
    "我授权你为这些目标生成个性化开发信，在内容审核和发送预检通过后，"
    "使用当前默认 Gmail 串行排队发送，无需我逐封确认。"
    "审核不通过的先修订再审核，不得绕过检查。\n"
    "遵守平台及本批授权上限，不重复创建正在执行的批次。"
    "最后报告：符合条件的网站数、加入机会数、草稿数、排队数、邮件服务商已接受数，"
    "以及跳过或失败的具体原因。不要把排队当作已发送，也不要把已发送当作已送达。"
)


@pytest.mark.parametrize("text", [
    EXISTING_POOL_COMMAND,
    "使用已有推荐池，将有邮箱的网站加入机会，生成并发送开发信。",
    "Use the existing recommendation pool and generate and send outreach emails.",
])
def test_existing_pool_command_passes_both_authorization_layers(text):
    from app.modules.agent.activities import user_explicitly_requested_write

    assert explicit_campaign(text)
    assert campaign_send_authorized(text)
    assert user_explicitly_requested_write(
        "start_backlink_campaign", [{"role": "user", "content": text}],
    )


@pytest.mark.parametrize("suffix", [
    "先不要发送邮件。", "不要生成草稿。", "仅预检，不要发送。",
    "Do not send emails.", "这只是测试。",
])
def test_existing_pool_constraints_do_not_erase_actual_refusal(suffix):
    assert not explicit_campaign(EXISTING_POOL_COMMAND + suffix)


@pytest.mark.parametrize("text", [
    "能不能使用已有推荐池并发送开发信？",
    "他说使用已有推荐池并发送开发信。",
    "修改代码，使用已有推荐池并发送开发信。",
    "如果使用已有推荐池并发送开发信。",
    '"使用已有推荐池并发送开发信"',
    "查看已有推荐池和开发信。",
])
def test_existing_pool_mention_is_not_authorization(text):
    assert not explicit_campaign(text)


def test_existing_pool_grant_persists_real_command_and_send_bounds():
    async def check(store, consent, core, request):
        service, run_id = await service_for(store, EXISTING_POOL_COMMAND)
        service.reader.read = AsyncMock(return_value={
            "data": {"connection": {"connectionId": ACCOUNT}},
        })
        args = (service.reader, store.sessions, "project", "org", grant(), run_id, REQUEST)
        with pytest.raises(ConsentError, match="RECOMMENDATION_MODE"):
            await grant_campaign(*args, "next_batch")
        _, consent_id, policy = await grant_campaign(*args, "current")
        assert policy["send_authorized"] is True
        assert policy["recommendation_mode"] == "current"
        assert policy["existing_recommendations_only"] is True
        assert policy["target_selection"] == "public_email"
        assert policy["skip_existing_opportunities"] is True
        assert policy["max_drafts"] == 5
        assert (await grant_campaign(*args, "current"))[1] == consent_id
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("text,expected", [
    (EXISTING_POOL_COMMAND, {"target_selection": "public_email", "skip_existing_opportunities": True}),
    ("使用已有推荐池，将有邮箱的网站加入机会，生成并发送开发信。",
     {"target_selection": "public_email"}),
    ("Use the existing recommendation pool. Select websites with valid email addresses "
     "that are not already joined and send outreach emails.",
     {"target_selection": "public_email", "skip_existing_opportunities": True}),
    ("使用已有推荐池，生成并发送开发信。", {}),
    ("使用已有推荐池，将有邮箱的网站加入机会，但仅选择系统推荐的站点，发送开发信。", {}),
    ("使用已有推荐池，仅选择与项目相关且有邮箱的网站，发送开发信。", {}),
    ("Use the existing recommendation pool; select only recommended websites with emails.", {}),
    ("Use the existing recommendation pool; select only relevant websites with emails.", {}),
])
def test_selection_policy_follows_original_user_scope(text, expected):
    from app.modules.agent.backlinks_chat_campaign import campaign_selection_policy

    assert campaign_selection_policy(text) == expected


@pytest.mark.parametrize("text,expected", [
    (COMMAND, True),
    ("跑推荐池并生成开发信草稿", True),
    ("run recommendation pool and send outreach emails", True),
    ("能不能跑推荐池并发送开发信？", False),
    ("如果跑推荐池并发送开发信", False),
    ("他说跑推荐池并发送开发信", False),
    ("修改代码让系统跑推荐池并发送开发信", False),
    ("不要跑推荐池并发送开发信", False),
    ("跑推荐池并发送开发信，先不发送邮件", False),
    ("跑推荐池", False),
    ("发送开发信", False),
])
def test_campaign_requires_compound_current_user_command(text, expected):
    assert explicit_campaign(text) is expected


@pytest.mark.parametrize("text,limit", [
    ("生成并发送一批开发信", 5), ("发送3封开发信", 3),
    ("最多两封", 2), ("发送100封", 5), ("发送0封", 0),
    ("send 2 outreach emails", 2), ("send one email", 1),
    ("generate three drafts", 3), ("send zero emails", 0),
])
def test_smaller_user_count_is_not_widened(text, limit):
    assert draft_limit(text) == limit


@pytest.mark.parametrize("text,allowed", [
    ("跑推荐池，发送最多5封开发信，仅发送审核与预检通过的邮件", True),
    ("run recommendation pool and send emails after preflight passes", True),
    ("跑推荐池并生成开发信，仅预检，不要发送", False),
    ("run recommendation pool and preflight emails; do not send", False),
    ("跑推荐池并生成草稿", False),
    ("帮 YouCine 跑当前推荐池并生成、发送开发信。模型2美元、付费工具2美元上限。"
     "审核、必要修稿和预检通过后用默认Gmail串行发送。", True),
    ("跑推荐池并发送开发信，付费工具预算2美元，先不要发送", False),
    ("修改工具，让系统跑推荐池并发送开发信，付费工具预算2美元", False),
    ("能否跑推荐池并发送开发信，付费工具费用上限2美元？", False),
])
def test_preflight_requirement_does_not_remove_sending_authority(text, allowed):
    assert campaign_send_authorized(text) is allowed


def test_grant_keeps_passed_preflight_condition_and_smaller_count():
    async def check(store, consent, core, request):
        service, run_id = await service_for(
            store, "帮我跑推荐池，生成并发送最多2封开发信，仅发送审核与预检通过的邮件",
        )
        service.reader.read = AsyncMock(return_value={
            "data": {"connection": {"connectionId": ACCOUNT}},
        })
        _, _, policy = await grant_campaign(
            service.reader, store.sessions, "project", "org", grant(), run_id, REQUEST, "current",
        )
        assert policy["send_authorized"] is True
        assert policy["max_drafts"] == 2
        assert not core.sent
    asyncio.run(harness(check))


def test_seo_requirement_is_persisted_and_cannot_be_dropped_on_replay():
    async def check(store, consent, core, request):
        service, run_id = await service_for(store, COMMAND)
        service.reader.read = AsyncMock(return_value={
            "data": {"connection": {"connectionId": ACCOUNT}},
        })
        args = (service.reader, store.sessions, "project", "org", grant(), run_id, REQUEST, "current")
        _, consent_id, policy = await grant_campaign(*args, require_seo_metrics=True)
        assert policy["require_seo_metrics"] is True
        assert (await grant_campaign(*args, require_seo_metrics=True))[1] == consent_id
        with pytest.raises(ConsentError, match="AUTHORIZATION_CHANGED"):
            await grant_campaign(*args)
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("sending", [True, False])
def test_grant_records_actual_user_authority_and_does_not_renew(sending):
    async def check(store, consent, core, request):
        service, run_id = await service_for(
            store, COMMAND if sending else "跑推荐池并生成开发信草稿",
        )
        service.reader.read = AsyncMock(return_value={
            "data": {"connection": {"connectionId": ACCOUNT}},
        })
        args = (service.reader, store.sessions, "project", "org", grant(), run_id, REQUEST, "current")
        context, consent_id, policy = await grant_campaign(*args)
        assert policy["send_authorized"] is sending
        assert policy["gmail_connection_id"] == (ACCOUNT if sending else None)
        assert policy["max_drafts"] == 5 and policy["max_paid_tool_cost_usd"] == "2"
        async with store.sessions() as session:
            record = await session.get(AgentBacklinksConsent, consent_id)
            expires = record.expires_at
            run = await session.get(AgentRun, run_id)
            assert policy["source_message_id"] == run.user_message_id
            assert view(record, datetime.now(UTC))["sending_allowed"] is sending
        assert (await grant_campaign(*args))[1] == consent_id
        async with store.sessions() as session, session.begin():
            record = await session.get(AgentBacklinksConsent, consent_id)
            assert record.expires_at == expires
            record.revoked_at = datetime.now(UTC)
        with pytest.raises(ConsentError, match="INACTIVE"):
            await grant_campaign(*args)
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("change", ["source", "missing_sender", "changed_request"])
def test_grant_fails_closed(change):
    async def check(store, consent, core, request):
        service, run_id = await service_for(store, COMMAND)
        service.reader.read = AsyncMock(return_value={"data": {"connection": {"connectionId": ACCOUNT}}})
        args = [service.reader, store.sessions, "project", "org", grant(), run_id, REQUEST, "current"]
        if change == "source":
            async with store.sessions() as session, session.begin():
                run = await session.get(AgentRun, run_id)
                message = await session.get(AgentMessage, run.user_message_id)
                message.role = "assistant"
        elif change == "missing_sender":
            service.reader.read.return_value = {"data": {"connection": None}}
        else:
            await grant_campaign(*args)
            args[-2] = {**REQUEST, "language": "pt"}
        with pytest.raises(ConsentError):
            await grant_campaign(*args)
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("case", ["pass", "blocked", "draft_only", "revoked"])
def test_automatic_handoff_reviews_pins_queues_once_and_never_sends_inline(case):
    async def check(store, consent, core, request):
        policy = {"policy_version": POLICY, "send_authorized": case != "draft_only",
                  "gmail_connection_id": ACCOUNT, "max_drafts": 5}
        async with store.sessions() as session, session.begin():
            record = await session.get(AgentBacklinksConsent, consent)
            record.policy_json = {**record.policy_json, **policy}
            policy = record.policy_json
        await BacklinksQuality(store).evaluate(CONTEXT, consent, [identifier(0), identifier(1)])
        if case == "blocked":
            core.draft_override = {"freshness": {"state": "STALE", "regenerateRequired": True}}
        if case == "revoked":
            async with store.sessions() as session, session.begin():
                record = await session.get(AgentBacklinksConsent, consent)
                record.revoked_at = datetime.now(UTC)
        if case in {"draft_only", "revoked"}:
            with pytest.raises(ConsentError):
                await queue_authorized_drafts(store, CONTEXT, consent, policy, {})
        else:
            batch = await queue_authorized_drafts(store, CONTEXT, consent, policy, {})
            if case == "blocked":
                assert batch is None
            else:
                assert batch["run_id"] and batch["state"] == "queued"
                replay = await queue_authorized_drafts(store, CONTEXT, consent, policy, {})
                assert replay["id"] == batch["id"]
                assert len(core.approvals) == 2
        assert not core.sent
    asyncio.run(harness(check))
