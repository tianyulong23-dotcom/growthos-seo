from app.modules.agent.backlinks_read import BACKLINK_READ_DESCRIPTIONS
from app.modules.agent.model_gateway import SYSTEM_PROMPT


def test_context_only_blocker_routes_explicit_commands_to_chat_send():
    prompt = " ".join(SYSTEM_PROMPT.split())
    assert "SEND_CONTEXT_REQUIRED in account-level status is not a Gmail outage" in prompt
    assert "sender through send_backlink_drafts" in prompt
    assert "all other blockers still apply" in prompt
    description = BACKLINK_READ_DESCRIPTIONS["get_backlink_gmail_status"]
    assert "SEND_CONTEXT_REQUIRED alone" in description
    assert "explicit send command use send_backlink_drafts" in description
