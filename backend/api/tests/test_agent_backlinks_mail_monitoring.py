import asyncio
from copy import deepcopy

from app.modules.agent.backlinks_mail_monitoring import monitor_batches


def test_monitor_matches_exact_send_version_and_only_confirmed_later_opportunity_mail():
    async def check():
        target = {"draftId": "draft", "approvedDraftVersionId": "version", "gmailConnectionId": "account"}
        batches = {"items": [{"items": [{"target": target, "sendIntentId": "intent"}]}]}
        intent = {**target, "sendIntentId": "intent", "opportunityId": "opportunity",
                  "status": "PROVIDER_ACCEPTED", "requestedSendAt": "2026-09-15T01:00:00Z",
                  "deliveryEnvelope": {"gmailConnectionId": "account"}}
        mail = {"id": "mail", "threadId": "thread", "subject": "Reply", "direction": "INBOUND",
                "matchStatus": "MATCH_CONFIRMED", "matchedOpportunityId": "opportunity",
                "receivedAt": "2026-09-15T02:00:00Z"}
        calls = []
        async def read(name, args):
            calls.append((name, args))
            if name == "list_backlink_mail":
                return {"data": {"items": [mail, {**mail, "id": "wrong", "matchedOpportunityId": "other"},
                    {**mail, "id": "old", "receivedAt": "2026-09-14T02:00:00Z"}], "hasMore": True}}
            if name == "get_backlink_send_intent":
                return {"data": {"sendIntent": deepcopy(intent)}}
            return {"data": {"state": "POLLING", "killSwitchOpen": True}}
        result = await monitor_batches(batches, read)
        assert result["items"][0]["state"] == "PROVIDER_ACCEPTED"
        assert [item["id"] for item in result["items"][0]["replies"]] == ["mail"]
        assert result["partial"] and result["connections"]["account"]["killSwitchOpen"]
        assert ("get_backlink_gmail_sync_status", {"connectionId": "account"}) in calls
        intent["approvedDraftVersionId"] = "changed"
        result = await monitor_batches(batches, read)
        assert result["items"][0]["state"] == "UNVERIFIED"
        assert "replies" not in result["items"][0]
    asyncio.run(check())
