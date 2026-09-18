"""Persisted user authority in legacy system-owned conversations, without I/O."""
import asyncio
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.modules.agent.backlinks_chat_send import BacklinksChatSend
from app.modules.agent.backlinks_consent import ConsentError
from test_agent_backlinks_drafts import CONTEXT, NOW, SETTINGS, Projects, grant
from app.modules.agent.backlinks_read import BacklinksReader


@pytest.mark.parametrize("case", [
    "valid", "missing", "tampered", "other_user", "other_project",
    "trigger", "assistant", "old_message", "other_owner", "expired_at_submission",
    "other_session", "other_organization",
])
def test_legacy_conversation_requires_original_signed_user_authority(case):
    async def check():
        source = grant()
        message = SimpleNamespace(
            id="message", conversation_id="conversation", role="user",
            content="Send these saved outreach drafts", metadata_json={}, created_at=NOW,
        )
        conversation = SimpleNamespace(
            id="conversation", organization_id="org", project_id="project",
            created_by="system", active_message_id="message",
        )
        if case == "missing":
            source = None
        elif case == "tampered":
            source = deepcopy(source)
            source["claims"]["actor"]["user_id"] = "forged"
        elif case == "other_user":
            source = grant(replace(CONTEXT, actor=replace(CONTEXT.actor, user_id="someone-else")))
        elif case == "other_project":
            source = grant(replace(CONTEXT, project=replace(CONTEXT.project, website_project_id="other")))
        elif case == "other_session":
            source = grant(replace(CONTEXT, actor=replace(CONTEXT.actor, session_id="another-session")))
        elif case == "other_organization":
            source = grant(replace(CONTEXT, tenant=replace(CONTEXT.tenant, organization_id="another-org")))
        elif case == "trigger":
            message.metadata_json = {"trigger": "backlinks_project_ready"}
        elif case == "assistant":
            message.role = "assistant"
        elif case == "old_message":
            conversation.active_message_id = "new-message"
        elif case == "other_owner":
            conversation.created_by = "another-person"
        elif case == "expired_at_submission":
            from datetime import timedelta
            message.created_at = NOW + timedelta(hours=1)
        run = SimpleNamespace(
            id="run", status="running", conversation_id=conversation.id,
            user_message_id=message.id, limits_json={"backlinks_delegation": source},
        )
        records = {"run": run, "conversation": conversation, "message": message}
        session = AsyncMock()
        session.__aenter__.return_value = session
        session.get.side_effect = lambda model, key: records.get(key)
        reader = BacklinksReader(SETTINGS, Projects())
        service = BacklinksChatSend(reader, lambda: session, {})
        if case == "valid":
            _, message_id = await service.authorize("project", "org", grant(), "run")
            assert message_id == "message"
        else:
            with pytest.raises(ConsentError, match="EXPLICIT_USER_COMMAND_REQUIRED"):
                await service.authorize("project", "org", grant(), "run")
    asyncio.run(check())
