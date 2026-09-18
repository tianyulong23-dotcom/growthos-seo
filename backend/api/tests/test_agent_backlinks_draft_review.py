"""Synthetic approval receipts and rollback-only scoped state; no real sends."""
import asyncio
from uuid import uuid4

import httpx
import pytest
from test_agent_backlinks_send_batch import harness
from test_agent_backlinks_continuation import identifier
from test_agent_backlinks_drafts import CONTEXT, META
from app.modules.agent.backlinks_consent import ConsentError
from app.modules.agent.backlinks_draft_review import (
    DraftReviewApproval, approve_reviewed_drafts, review_drafts,
)


@pytest.mark.parametrize("case", ["valid", "changed", "outside", "unconfirmed", "duplicate"])
def test_review_is_version_pinned_and_never_sends(case):
    async def check(store, consent, core, request):
        base = core.respond
        approvals = []

        def respond(req):
            if req.url.path.endswith("/approve"):
                approvals.append(req)
                draft_id = req.url.path.split("/")[-2]
                return httpx.Response(200, json={
                    "versionId": identifier("version:" + draft_id), "meta": META,
                })
            result = base(req)
            data = result.json()
            if "draft" in data:
                data["draft"]["draftVersion"] = 1
                return httpx.Response(200, json=data)
            return result

        store.gateway._client._transport = httpx.MockTransport(respond)
        core.approved = False
        review = await review_drafts(store, CONTEXT, consent)
        assert len(review["items"]) == 2 and review["sent"] is False
        first = review["items"][0]
        item = {key: first[key] for key in ("draft_id", "version_id", "expected_version")}
        if case == "changed":
            item["version_id"] = str(uuid4())
        if case == "outside":
            item["draft_id"] = str(uuid4())
        body = DraftReviewApproval(
            request_id=uuid4(), confirmed=case != "unconfirmed",
            items=[item, item] if case == "duplicate" else [item],
        )
        if case == "valid":
            result = await approve_reviewed_drafts(store, CONTEXT, consent, body)
            assert result == {"approved_draft_ids": [first["draft_id"]], "sent": False}
            assert len(approvals) == 1
        else:
            with pytest.raises(ConsentError):
                await approve_reviewed_drafts(store, CONTEXT, consent, body)
            assert not approvals
        assert not core.sent
    asyncio.run(harness(check))
