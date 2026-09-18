"""Read persisted send and inbox evidence; never starts a provider operation."""
from datetime import datetime

from app.modules.agent.backlinks_read import BacklinksReadError


def after(value, boundary):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) >= datetime.fromisoformat(
            boundary.replace("Z", "+00:00"),
        )
    except (AttributeError, TypeError, ValueError):
        return False


async def monitor_batches(batches, read):
    async def inspect(name, args):
        try:
            return (await read(name, args))["data"]
        except BacklinksReadError as exc:
            return {"unavailable": True, "reason": exc.code}

    targets = [item for batch in batches["items"] for item in batch["items"] if item.get("sendIntentId")]
    mail = await inspect("list_backlink_mail", {"limit": 20}) if targets else {"items": []}
    connections, items = {}, []
    for item in targets[:20]:
        data = await inspect("get_backlink_send_intent", {"sendIntentId": item["sendIntentId"]})
        intent = data.get("sendIntent")
        target = item["target"]
        if not intent or (
            intent.get("draftId") != target["draftId"]
            or intent.get("approvedDraftVersionId") != target["approvedDraftVersionId"]
            or (intent.get("deliveryEnvelope") or {}).get("gmailConnectionId") != target["gmailConnectionId"]
        ):
            items.append({"draft_id": target["draftId"], "state": "UNVERIFIED",
                          "reason": data.get("reason", "SEND_EVIDENCE_MISMATCH")})
            continue
        connection_id = target["gmailConnectionId"]
        if connection_id not in connections:
            connections[connection_id] = await inspect(
                "get_backlink_gmail_sync_status", {"connectionId": connection_id},
            )
        replies = [{
            key: message[key] for key in ("id", "threadId", "receivedAt", "subject")
        } for message in mail.get("items", []) if (
            message.get("direction") == "INBOUND"
            and message.get("matchStatus") == "MATCH_CONFIRMED"
            and message.get("matchedOpportunityId") == intent.get("opportunityId")
            and after(message.get("receivedAt"), intent.get("requestedSendAt"))
        )]
        items.append({
            "draft_id": target["draftId"], "send_intent_id": intent["sendIntentId"],
            "version_id": intent["approvedDraftVersionId"], "state": intent["status"],
            "attempt": intent.get("attempt"), "connection_id": connection_id,
            "reply_state": "OPPORTUNITY_REPLY_FOUND" if replies else "NOT_OBSERVED",
            "replies": replies,
        })
    return {
        "items": items, "connections": connections,
        "mail_unavailable": bool(mail.get("unavailable")),
        "partial": bool(mail.get("hasMore") or mail.get("nextCursor") or len(targets) > 20),
        "scope": "Latest 20 persisted project messages and 20 send intents. Replies are opportunity-level, "
                 "not proof of a reply to this exact email. NOT_OBSERVED is not proof of no reply. "
                 "Provider acceptance is not delivery; disabled/stale sync requires verification.",
    }
