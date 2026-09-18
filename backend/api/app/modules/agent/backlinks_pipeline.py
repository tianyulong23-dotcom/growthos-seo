from __future__ import annotations

from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.agent.backlinks_drafts import BacklinksDrafts, DraftRequest
from app.modules.agent.backlinks_read import BacklinksReadError


class StartRecommendationsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["initial", "next_batch"] = "initial"


class JoinRecommendationsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recommendationFeedItemIds: list[UUID] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def unique_items(self):
        if len(set(self.recommendationFeedItemIds)) != len(self.recommendationFeedItemIds):
            raise ValueError("Duplicate recommendation feed items")
        return self


class BatchDraftArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    opportunityIds: list[UUID] = Field(min_length=1, max_length=10)
    request: DraftRequest

    @model_validator(mode="after")
    def unique_items(self):
        if len(set(self.opportunityIds)) != len(self.opportunityIds):
            raise ValueError("Duplicate opportunities")
        return self


PIPELINE_WRITE_MODELS = {
    "start_backlink_recommendations": StartRecommendationsArgs,
    "join_backlink_recommendations": JoinRecommendationsArgs,
    "create_backlink_drafts": BatchDraftArgs,
}
PIPELINE_DESCRIPTIONS = {
    "start_backlink_recommendations": (
        "Use mode=initial for the first V2 recommendation job (may incur provider costs). "
        "Use mode=next_batch only on an explicit request for a new batch: it calls the existing "
        "get-more command without replacing a generation. Read the feed first. "
        "For RELEASED, use returned batchId for all subsequent reads and joins. "
        "POOL_EXHAUSTED or NEXT_BATCH_PREPARING is not success; never use old items instead. "
        "STARTED is job acceptance, not completion."
    ),
    "join_backlink_recommendations": (
        "Add up to 10 released V2 feed item IDs to project opportunities on explicit request. "
        "Use IDs from list_backlink_recommendations, never inventory IDs or invented domains. "
        "Core checks visibility and duplicates. Inspect each result and its confirmed contacts."
    ),
    "create_backlink_drafts": (
        "Create initial draft jobs for up to 10 saved opportunities on explicit batch request. "
        "Use a project promotion URL. Only active opportunities with the existing enabled "
        "CREATE_EMAIL_DRAFT action and one automatically selected confirmed contact qualify. "
        "Missing or ambiguous contacts and existing drafts are skipped. Query each accepted job "
        "then inspect its draft. Never approves or sends; acceptance is not generation success."
    ),
}


def child_operation(operation_id: str, step: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"agent-backlinks:{operation_id}:{step}"))


class BacklinksPipeline:
    def __init__(self, drafts: BacklinksDrafts):
        self.drafts = drafts
        self.reader = drafts.reader

    async def execute(self, project_id, organization_id, delegation, name, arguments):
        operation_id = arguments["operation_id"]
        values = PIPELINE_WRITE_MODELS[name].model_validate({
            k: v for k, v in arguments.items() if k != "operation_id"
        }).model_dump(mode="json")
        # Resolve before every invocation; persisted tool arguments are not authority.
        await self.reader.resolve_write_context(
            project_id, organization_id, delegation, write=True,
        )
        if name == "start_backlink_recommendations":
            if values["mode"] == "next_batch":
                return await self._next_batch(project_id, organization_id, delegation, operation_id)
            return await self._start(project_id, organization_id, delegation, operation_id)
        ids = values.get("recommendationFeedItemIds", values.get("opportunityIds"))
        results = []
        for identifier in ids:
            # Expiry/revocation must abort, not become an ordinary per-item skip.
            await self.reader.resolve_write_context(
                project_id, organization_id, delegation, write=True,
            )
            try:
                if name == "join_backlink_recommendations":
                    result = await self._join(
                        project_id, organization_id, delegation, identifier,
                        child_operation(operation_id, f"join:{identifier}"),
                    )
                else:
                    result = await self._draft(
                        project_id, organization_id, delegation, identifier,
                        values["request"], child_operation(operation_id, f"draft:{identifier}"),
                    )
            except BacklinksReadError:
                # A write may have committed before its response was lost. Do not
                # retry with another key or report this item as a definite failure.
                result = {"state": "UNVERIFIED", "next": "Read persisted state before retrying."}
                results.append({"id": identifier, **result})
                break
            results.append({"id": identifier, **result})
        return {
            "operation_id": operation_id, "results": results,
            "remainingIds": ids[len(results):],
            "verified": all(item["state"] != "UNVERIFIED" for item in results),
            "verification": "per_item_persisted_evidence_only",
            "sent": False,
        }

    async def _next_batch(self, project_id, organization_id, delegation, operation_id):
        before = (await self.reader.read(
            project_id, organization_id, "list_backlink_recommendations", {"limit": 1},
            delegation=delegation,
        ))["data"].get("latestGeneration")
        if not before:
            raise BacklinksReadError("BACKLINKS_INITIAL_GENERATION_REQUIRED")
        result = await self.drafts._request(
            project_id, organization_id, delegation, "recommendation-user-release/get-more",
            body={}, operation_id=operation_id, success_statuses=(200,),
            schema_version="backlinks.recommendation-user-release.v2",
        )
        state = result.get("state")
        if state not in {
            "RELEASED", "NOT_UNLOCKED", "NEXT_BATCH_PREPARING",
            "POOL_EXHAUSTED", "INITIAL_BATCH_NOT_READY",
        }:
            raise BacklinksReadError("BACKLINKS_INVALID_BATCH_RECEIPT")
        response = {"operation_id": operation_id, "state": state, "verified": True,
                    "sent": False, "verification": "batch_publication_only"}
        if state != "RELEASED":
            return response
        ordinal = result.get("releasedBatchOrdinal")
        feed = (await self.reader.read(
            project_id, organization_id, "list_backlink_recommendations", {"limit": 1},
            delegation=delegation,
        ))["data"]
        generation = feed.get("latestGeneration")
        if not generation or generation.get("generationContractId") != before.get("generationContractId"):
            raise BacklinksReadError("BACKLINKS_GENERATION_CHANGED")
        # Ordinals restart for each pool generation. Never select by ordinal alone.
        pool_generation = (generation or {}).get("visiblePoolGeneration")
        batches = feed.get("releasedPool", {}).get("filterOptions", {}).get("batches", [])
        matches = [b for b in batches if b.get("batchOrdinal") == ordinal
                   and b.get("visiblePoolGeneration") == pool_generation]
        if type(ordinal) is not int or type(pool_generation) is not int or len(matches) != 1:
            raise BacklinksReadError("BACKLINKS_BATCH_READBACK_MISMATCH")
        return {**response, "batchId": str(UUID(matches[0]["batchId"])),
                "batchOrdinal": ordinal, "visiblePoolGeneration": pool_generation,
                "generationContractId": str(UUID(generation["generationContractId"]))}

    async def _start(self, project_id, organization_id, delegation, operation_id):
        schema = "backlinks.recommendation-seeds.v2"
        prepared = await self.drafts._request(
            project_id, organization_id, delegation, "recommendation-seeds/generate",
            body={"seeds": []},
            operation_id=child_operation(operation_id, "seeds"),
            success_statuses=(200,), schema_version=schema,
        )
        if prepared.get("state") == "INPUT_REQUIRED":
            return {
                "state": "INPUT_REQUIRED", "reasonCodes": prepared.get("reasonCodes", []),
                "verified": True, "verification": "input_required_response_only",
            }
        confirmation = prepared.get("confirmation")
        if prepared.get("state") != "READY" or not isinstance(confirmation, dict):
            raise BacklinksReadError("BACKLINKS_INVALID_GENERATION_CONFIRMATION")
        # These pins come only from Core's stored snapshot, never model arguments.
        pins = GenerationPins.model_validate(confirmation).model_dump(mode="json")
        launched = await self.drafts._request(
            project_id, organization_id, delegation, "recommendation-seeds/launch",
            body=pins, operation_id=child_operation(operation_id, "launch"),
            success_statuses=(200,), schema_version=schema,
        )
        if (
            launched.get("generationContractId") != pins["generationContractId"]
            or launched.get("state") not in {"STARTED", "ALREADY_STARTED"}
        ):
            raise BacklinksReadError("BACKLINKS_GENERATION_RECEIPT_MISMATCH")
        return {
            "operation_id": operation_id, "state": launched["state"],
            "verified": True,
            "generationContractId": pins["generationContractId"],
            "jobId": str(UUID(launched["jobId"])),
            "verification": "job_acceptance_only",
            "next": "Read list_backlink_recommendations.latestGeneration; do not busy-poll.",
        }

    async def _join(self, project_id, organization_id, delegation, identifier, operation_id):
        receipt = await self.drafts._request(
            project_id, organization_id, delegation, "opportunities",
            body={"recommendationFeedItemId": identifier}, operation_id=operation_id,
            success_statuses=(201,),
        )
        if receipt.get("recommendationFeedItemId") != identifier:
            raise BacklinksReadError("BACKLINKS_JOIN_RECEIPT_MISMATCH")
        opportunity_id = str(UUID(receipt["opportunityId"]))
        detail = await self.reader.read(
            project_id, organization_id, "get_backlink_opportunity",
            {"opportunityId": opportunity_id}, delegation=delegation,
        )
        if detail["data"]["item"].get("id") != opportunity_id:
            raise BacklinksReadError("BACKLINKS_OPPORTUNITY_ID_MISMATCH")
        return {
            "state": "EXISTING" if receipt.get("existingOpportunity") else "JOINED",
            "opportunityId": opportunity_id,
            "contactReviewRequired": receipt.get("contactReviewRequired"),
        }

    async def _draft(self, project_id, organization_id, delegation, identifier, request, operation_id):
        detail = await self.reader.read(
            project_id, organization_id, "get_backlink_opportunity",
            {"opportunityId": identifier}, delegation=delegation,
        )
        item = detail["data"]["item"]
        if item.get("id") != identifier:
            raise BacklinksReadError("BACKLINKS_OPPORTUNITY_ID_MISMATCH")
        if item.get("draftId"):
            return {"state": "EXISTING_DRAFT", "draftId": item["draftId"]}
        action = item.get("primaryNextAction") or {}
        if (
            item.get("managementStatus") != "ACTIVE"
            or action.get("kind") != "CREATE_EMAIL_DRAFT"
            or action.get("enabled") is not True
        ):
            return {"state": "SKIPPED", "reason": "OPPORTUNITY_NOT_READY"}
        contacts = (await self.reader.read(
            project_id, organization_id, "get_backlink_contacts",
            {"opportunityId": identifier}, delegation=delegation,
        ))["data"]
        selection = contacts["selection"]
        selected = [
            contact for contact in contacts["items"]
            if contact.get("id") == selection.get("autoSelectedContactId")
            and contact.get("opportunityId") == identifier
            and contact.get("status") == "active"
            and contact.get("guessed") is False
            and contact.get("confirmedAt") and contact.get("normalizedEmail")
        ]
        if selection.get("state") != "AUTO_SELECTED" or len(selected) != 1:
            return {"state": "SKIPPED", "reason": "CONFIRMED_CONTACT_REQUIRED"}
        contact = selected[0]
        receipt = await self.drafts.create(project_id, organization_id, delegation, {
            "operation_id": operation_id, "opportunityId": identifier,
            "contactId": contact["id"], "contactVersion": contact["version"],
            "request": request,
        })
        return {"state": "JOB_ACCEPTED", **receipt}


class GenerationPins(BaseModel):
    model_config = ConfigDict(extra="forbid")
    generationContractId: UUID
    seedSnapshotFingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
