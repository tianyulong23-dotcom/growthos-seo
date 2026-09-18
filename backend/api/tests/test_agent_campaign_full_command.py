import asyncio
from unittest.mock import AsyncMock

import pytest

from app.modules.agent.backlinks_chat_campaign import (
    campaign_selection_policy, campaign_send_authorized, explicit_campaign, grant_campaign,
)
from app.modules.agent.backlinks_consent import ConsentError
from app.modules.agent.progress import failure_answer
from test_agent_backlinks_chat_send import service_for
from test_agent_backlinks_drafts import grant
from test_agent_backlinks_send import ACCOUNT
from test_agent_backlinks_send_batch import harness
from test_agent_chat_campaign import REQUEST

FULL_COMMAND = """请为当前 YouCine 项目执行一批完整外链任务，从推荐池到开发信发送，不要只生成推荐或草稿就结束。

1. 自动检查并完成必要的外链初始化，使用已确认的项目资料，不编造缺失信息。
2. 优先使用已有推荐池；如果推荐任务正在运行，就接续等待同一个任务，不重复启动。如果没有可用推荐，再生成一批。
3. 筛选有有效公开邮箱、SEO 指标完整、尚未加入机会的网站。请核对自然搜索流量、DataForSEO Rank 和垃圾评分；缺失值不能当作零。不强制要求网站带“推荐”标签，但排除明确不相关的网站。
4. 去重并跳过已发送、已回复、退订、已归档及发送状态不确定的目标。最多加入 10 个机会，最多发送 5 封邮件；不足时按实际合格数量执行。
5. 根据项目资料和目标网站的真实信息生成个性化英文开发信，不编造对方身份、合作关系或承诺。审核不通过时，在本批额度内修订并重新审核。

我明确授权本批生成草稿，并在内容审核和发送预检通过后，使用当前默认 Gmail 串行排队发送，无需我逐封确认。遵守平台和本批预算、授权及发送上限，不绕过安全检查。

如果已有符合本指令且授权有效的活动批次，继续该批次，不重复创建。异步任务请保存进度并按平台机制接续，不要把“正在运行”当作完成。遇到无法恢复的错误，报告准确阶段、错误码和已发生的操作。

最后报告：SEO 指标完整的网站数、公开邮箱网站数、符合条件数、加入机会数、草稿数、排队数、邮件服务商已接受数，以及跳过或失败原因。不要把排队当作已发送，也不要把服务商接受当作已送达。"""


def test_original_full_command_passes_both_guards_and_preserves_selection():
    from app.modules.agent.activities import user_explicitly_requested_write

    assert len(FULL_COMMAND) == 659
    assert explicit_campaign(FULL_COMMAND)
    assert campaign_send_authorized(FULL_COMMAND)
    assert user_explicitly_requested_write(
        "start_backlink_campaign", [{"role": "user", "content": FULL_COMMAND}],
    )
    assert campaign_selection_policy(FULL_COMMAND) == {
        "target_selection": "public_email", "skip_existing_opportunities": True,
    }


@pytest.mark.parametrize("text", [
    FULL_COMMAND + "\n先不要发送邮件。",
    FULL_COMMAND + "\n只生成草稿，不要发送。",
    FULL_COMMAND + "\n这是模拟测试，不实际执行。",
    "他说：" + FULL_COMMAND,
    '"' + FULL_COMMAND + '"',
    "帮我修改代码支持以下指令：" + FULL_COMMAND,
    "如果我授权了就发送邮件。使用已有推荐池并生成开发信。",
    "使用已有推荐池。如果价格低就发送开发信。",
    "如果已有符合本指令且授权有效的活动批次，不要发送邮件。",
])
def test_full_command_normalization_never_erases_refusal_or_hypothetical_authority(text):
    assert not explicit_campaign(text)
    assert not campaign_send_authorized(text)


def test_original_command_persists_send_and_seo_bounds_without_sending():
    async def check(store, consent, core, request):
        service, run_id = await service_for(store, FULL_COMMAND)
        service.reader.read = AsyncMock(return_value={
            "data": {"connection": {"connectionId": ACCOUNT}},
        })
        args = (service.reader, store.sessions, "project", "org", grant(), run_id, REQUEST)
        _, consent_id, policy = await grant_campaign(*args, "current")
        assert policy["send_authorized"] is True
        assert policy["require_seo_metrics"] is True
        assert policy["target_selection"] == "public_email"
        assert policy["max_drafts"] == 5
        assert policy["max_opportunities"] == 10
        assert not policy.get("existing_recommendations_only")
        assert (await grant_campaign(*args, "current"))[1] == consent_id
        with pytest.raises(ConsentError, match="RECOMMENDATION_MODE"):
            await grant_campaign(*args, "next_batch")
        assert not core.sent
    asyncio.run(harness(check))


def test_authorization_failure_reports_its_real_stage_without_claiming_a_model_failure():
    answer = failure_answer([], error_code="write_not_explicitly_requested")
    assert "write_not_explicitly_requested" in answer
    assert "授权" in answer
    assert "回答整理中断" not in answer
    assert "重新发起" not in answer
