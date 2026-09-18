"""One bounded step through existing Backlinks commands; never approve or send."""

from copy import deepcopy
from decimal import Decimal, InvalidOperation
import re
from uuid import UUID

from app.modules.agent.backlinks_consent import ConsentError
from app.modules.agent.backlinks_pipeline import child_operation
from app.modules.agent.backlinks_read import BacklinksReadError

TERMINAL_STAGES = {"done", "paused"}
GENERATION_SUCCEEDED = {"SUCCESS", "PARTIAL_SUCCESS", "SUCCEEDED"}
GENERATION_PENDING = {"QUEUED", "RUNNING", "RETRY_SCHEDULED", "PENDING", "PENDING_LAUNCH"}


def initial_checkpoint(recommendation_mode="current"):
    return {
        "stage": "recommend", "generation": None, "cursor": None, "cursors": [],
        "recommendation_mode": recommendation_mode, "batch_id": None,
        "queue": [], "seen": [], "results": [], "pending": None, "read_failures": 0,
        "usage": {"opportunities": 0, "drafts": 0, "model_usd": "0", "paid_usd": "0"},
    }


class ContinuationStep:
    def __init__(self, pipeline, *, project_id, organization_id, run_id, policy, request, save, review=None):
        self.pipeline = pipeline
        self.drafts = pipeline.drafts
        self.reader = pipeline.reader
        self.project_id, self.organization_id, self.run_id = project_id, organization_id, run_id
        self.policy, self.request, self.save = policy, request, save
        self.review = review

    async def read(self, name, arguments):
        return (await self.reader.read(
            self.project_id, self.organization_id, name, arguments,
        ))["data"]

    async def request_core(self, path, **kwargs):
        return await self.drafts._request(
            self.project_id, self.organization_id, None, path, **kwargs,
        )

    def pause(self, state, reason):
        state.update(stage="paused", reason=reason)

    def selection_skip_reason(self, item):
        if item.get("archived"):
            return "ARCHIVED"
        if (self.policy.get("skip_existing_opportunities")
                and (item.get("opportunity") or {}).get("opportunityId")):
            return "ALREADY_JOINED"
        contact = item.get("contact") or {}
        email = contact.get("email")
        if (not isinstance(email, str)
                or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)
                or contact.get("outcome") not in (None, "PUBLIC_EMAIL_FOUND")
                or (self.policy.get("target_selection") == "public_email"
                    and contact.get("outcome") != "PUBLIC_EMAIL_FOUND")):
            return "NO_PUBLIC_EMAIL"
        metrics = item.get("metrics") or {}
        if self.policy.get("require_seo_metrics") and not all(
            type(metrics.get(key)) in (int, float)
            and 0 <= metrics[key] < float("inf")
            for key in ("targetMarketOrganicTraffic", "dataForSeoRank", "spamScore")
        ):
            return "SEO_METRICS_MISSING"
        if (self.policy.get("target_selection") != "public_email"
                and item.get("recommended") is not True):
            return "RECOMMENDATION_REQUIRED"
        return None

    async def write(self, state, name, arguments, *, counter=None, cost=None):
        usage = state["usage"]
        if counter and usage[counter] >= self.policy[f"max_{counter}"]:
            self.pause(state, f"{counter.upper()}_LIMIT")
            return None
        if cost:
            quote = await self.request_core(
                "automation-budget", schema_version="backlinks.automation-budget.v1",
            )
            field = "draftModelReservationUsd" if cost == "model" else "recommendationPaidReservationUsd"
            try:
                amount = Decimal(str(quote[field]))
                if quote.get("accounting") != "conservative_reservations" or not amount.is_finite() or amount <= 0:
                    raise ValueError
            except (KeyError, ValueError, InvalidOperation):
                self.pause(state, "BUDGET_BOUND_UNAVAILABLE")
                return None
            total = Decimal(usage[f"{cost}_usd"]) + amount
            limit = self.policy["max_model_cost_usd" if cost == "model" else "max_paid_tool_cost_usd"]
            if total > Decimal(limit):
                self.pause(state, f"{cost.upper()}_BUDGET_LIMIT")
                return None
            usage[f"{cost}_usd"] = str(total)
        if counter:
            usage[counter] += 1
        operation_key = f"{name}:{state.get('item', 'initial')}"
        if state.get("refill_started"):
            operation_key += ":refill"
        operation = child_operation(self.run_id, operation_key)
        # Commit intent and reservation before any write. A lost receipt is not retry permission.
        state["pending"] = {"tool": name, "operation_id": operation}
        await self.save(deepcopy(state))
        if name == "publish":
            result = await self.request_core(
                "recommendation-user-release/publish-initial", body={},
                operation_id=operation, success_statuses=(200,),
                schema_version="backlinks.recommendation-user-release.v2",
            )
        else:
            result = await self.pipeline.execute(
                self.project_id, self.organization_id, None, name,
                {**arguments, "operation_id": operation},
            )
        if result.get("verified") is False:
            self.pause(state, "WRITE_RECEIPT_UNVERIFIED")
            return None
        state["pending"] = None
        return result

    async def advance(self, checkpoint):
        state = deepcopy(checkpoint)
        if state.get("stage") == "quality" and self.review:
            if not state.get("quality_pending") and state.get("quality_queue"):
                state["quality_pending"] = state["quality_queue"].pop(0)
                await self.save(deepcopy(state))
            if state.get("quality_pending"):
                await self.review_pending(state)
            if not state.get("quality_queue") and not state.get("quality_pending"):
                state["stage"] = "done"
            return state
        if state.get("quality_pending") and self.review:
            await self.review_pending(state)
            return state
        if state["stage"] in TERMINAL_STAGES:
            return state
        if state["pending"]:
            self.pause(state, "WRITE_RECEIPT_UNVERIFIED")
            return state
        try:
            await self._advance(state)
            state["read_failures"] = 0
        except BacklinksReadError as exc:
            if state["pending"]:
                self.pause(state, "WRITE_RECEIPT_UNVERIFIED")
            else:
                state["read_failures"] += 1
                if not exc.retryable or state["read_failures"] >= 3:
                    self.pause(state, exc.code)
        except ConsentError:
            raise
        except (KeyError, TypeError, ValueError):
            self.pause(state, "INVALID_BUSINESS_EVIDENCE")
        return state

    async def review_pending(self, state):
        draft_id = state["quality_pending"]
        result = next(item for item in state["results"] if item.get("draftId") == draft_id)
        attempts = state.setdefault("quality_review_attempts", {})
        if attempts.get(draft_id, 0) >= 2:
            result.setdefault("quality", {
                "state": "ERROR", "reasons": ["AI_REVIEW_INTERRUPTED"],
            })
            state.pop("quality_pending")
            await self.save(deepcopy(state))
            return
        # Persist before the call: a lost provider receipt still consumes an attempt.
        attempts[draft_id] = attempts.get(draft_id, 0) + 1
        await self.save(deepcopy(state))
        result["quality"] = await self.review(state, draft_id)
        recoverable = (
            result["quality"].get("state") == "ERROR"
            and result["quality"].get("retryable") is not False
            and bool(set(result["quality"].get("reasons", [])) & {
                "AI_REVIEW_UNAVAILABLE", "AI_REVIEW_INTERRUPTED",
            })
        )
        if not recoverable or attempts[draft_id] >= 2:
            state.pop("quality_pending")
        await self.save(deepcopy(state))

    def finish_item(self, state, result):
        state["results"].append({
            "feedItemId": state["item"],
            **({"opportunityId": state["opportunity"]} if "opportunity" in state else {}),
            **result,
        })
        for key in ("item", "opportunity", "job", "draft"):
            state.pop(key, None)
        state["stage"] = "join" if state["queue"] else "page"

    async def _advance(self, state):
        stage = state["stage"]
        if stage in {"recommend", "page"}:
            arguments = {"limit": 20, "sort": "released_asc"}
            if state.get("batch_id"):
                arguments["batchId"] = state["batch_id"]
            if stage == "page" and state["cursor"]:
                arguments["cursor"] = state["cursor"]
            feed = await self.read("list_backlink_recommendations", arguments)
            latest = feed["latestGeneration"]
            if state["generation"] and (
                not latest or latest["generationContractId"] != state["generation"]
            ):
                self.pause(state, "GENERATION_CHANGED")
                return
            if stage == "recommend":
                if latest is None:
                    if self.policy.get("existing_recommendations_only"):
                        self.pause(state, "EXISTING_RECOMMENDATIONS_UNAVAILABLE")
                        return
                    if feed["items"]:
                        self.pause(state, "GENERATION_EVIDENCE_MISSING")
                        return
                    result = await self.write(
                        state, "start_backlink_recommendations", {}, cost="paid",
                    )
                    if result is not None:
                        if result["state"] == "INPUT_REQUIRED":
                            self.pause(state, "INPUT_REQUIRED")
                        else:
                            state["generation"] = result["generationContractId"]
                            if state.get("recommendation_mode") == "next_batch":
                                state.update(stage="wait_refill", refill_started=True)
                    return
                state["generation"] = latest["generationContractId"]
                if latest["jobState"] in GENERATION_SUCCEEDED:
                    if latest["releaseResult"] not in {"AVAILABLE", "RELEASED"}:
                        self.pause(state, "RECOMMENDATIONS_NOT_RELEASED")
                    else:
                        state["stage"] = (
                            "next_batch" if state.get("recommendation_mode") == "next_batch" else "publish"
                        )
                elif latest["jobState"] not in GENERATION_PENDING:
                    self.pause(state, "RECOMMENDATIONS_REQUIRE_REVIEW")
                return
            if len(state["seen"]) >= 1000 or len(state["cursors"]) >= 50:
                self.pause(state, "SCAN_LIMIT")
                return
            for item in feed["items"]:
                identifier = item["itemId"]
                if identifier in state["seen"]:
                    continue
                state["seen"].append(identifier)
                selection = state.setdefault("selection", {
                    "scanned": 0, "eligible": 0, "skipped": {},
                })
                selection["scanned"] += 1
                reason = self.selection_skip_reason(item)
                if reason:
                    selection["skipped"][reason] = selection["skipped"].get(reason, 0) + 1
                    continue
                selection["eligible"] += 1
                state["queue"].append(identifier)
            cursor = feed["nextCursor"]
            if cursor and cursor in state["cursors"]:
                self.pause(state, "PAGINATION_CYCLE")
                return
            if cursor:
                state["cursors"].append(cursor)
            state["cursor"] = cursor
            state["last_page"] = cursor is None
            state["stage"] = "join" if state["queue"] else ("done" if cursor is None else "page")
        elif stage == "next_batch":
            status = await self.request_core(
                "recommendation-user-release/status",
                schema_version="backlinks.recommendation-user-release.v2",
            )
            if status.get("getMoreState") == "NEXT_BATCH_PREPARING":
                state["batch_waits"] = state.get("batch_waits", 0) + 1
                if state["batch_waits"] >= 120:
                    self.pause(state, "NEXT_BATCH_WAIT_TIMEOUT")
                return
            if status.get("getMoreState") == "POOL_EXHAUSTED":
                state["stage"] = "refill"
                return
            if status.get("getMoreState") != "RELEASE_NEXT":
                self.pause(state, "NEXT_BATCH_NOT_READY")
                return
            result = await self.write(state, "start_backlink_recommendations", {"mode": "next_batch"})
            if result is not None:
                if result["state"] in {"POOL_EXHAUSTED", "NEXT_BATCH_PREPARING"}:
                    # A concurrent publication can change status after the pre-read.
                    # Do not repeat the completed command's idempotency key.
                    self.pause(state, "BATCH_STATE_CHANGED")
                elif result["state"] != "RELEASED":
                    self.pause(state, result["state"])
                elif result["generationContractId"] != state["generation"]:
                    self.pause(state, "GENERATION_CHANGED")
                else:
                    state.update(batch_id=result["batchId"], stage="page")
        elif stage == "refill":
            if state.get("refill_started"):
                self.pause(state, "REFILL_LIMIT")
                return
            feed = await self.read("list_backlink_recommendations", {"limit": 1})
            latest = feed.get("latestGeneration") or {}
            if latest.get("generationContractId") != state["generation"]:
                self.pause(state, "GENERATION_CHANGED")
                return
            state["refill_started"] = True
            result = await self.write(
                state, "start_backlink_recommendations", {"mode": "initial"}, cost="paid",
            )
            if result is not None:
                if result["state"] == "INPUT_REQUIRED":
                    self.pause(state, "INPUT_REQUIRED")
                elif result["generationContractId"] == state["generation"]:
                    self.pause(state, "REFILL_GENERATION_NOT_ADVANCED")
                else:
                    state.update(generation=result["generationContractId"], stage="wait_refill")
        elif stage == "wait_refill":
            feed = await self.read("list_backlink_recommendations", {"limit": 1})
            latest = feed.get("latestGeneration") or {}
            if latest.get("generationContractId") != state["generation"]:
                self.pause(state, "GENERATION_CHANGED")
            elif latest.get("jobState") in GENERATION_SUCCEEDED and latest.get("releaseResult") in {"AVAILABLE", "RELEASED"}:
                state["stage"] = "publish_refill"
            elif latest.get("jobState") not in GENERATION_PENDING:
                self.pause(state, "REFILL_REQUIRES_REVIEW")
            else:
                state["refill_waits"] = state.get("refill_waits", 0) + 1
                if state["refill_waits"] >= 120:
                    self.pause(state, "REFILL_WAIT_TIMEOUT")
        elif stage == "publish_refill":
            result = await self.write(state, "publish", {})
            if result is not None:
                if result["state"] != "PUBLISHED":
                    self.pause(state, "REFILL_PUBLICATION_NOT_READY")
                else:
                    state.update(refill_ordinal=result["currentBatchOrdinal"], stage="pin_refill")
        elif stage == "pin_refill":
            feed = await self.read("list_backlink_recommendations", {"limit": 1})
            latest = feed.get("latestGeneration") or {}
            if latest.get("generationContractId") != state["generation"]:
                self.pause(state, "GENERATION_CHANGED")
                return
            batches = feed.get("releasedPool", {}).get("filterOptions", {}).get("batches", [])
            if type(latest.get("visiblePoolGeneration")) is not int or latest["visiblePoolGeneration"] < 1:
                self.pause(state, "REFILL_BATCH_NOT_VERIFIED")
                return
            matches = [batch for batch in batches
                       if batch.get("batchOrdinal") == state["refill_ordinal"]
                       and batch.get("visiblePoolGeneration") == latest.get("visiblePoolGeneration")]
            if len(matches) != 1:
                self.pause(state, "REFILL_BATCH_NOT_VERIFIED")
            else:
                state.update(batch_id=str(UUID(matches[0]["batchId"])), stage="page")
        elif stage == "publish":
            result = await self.write(state, "publish", {})
            if result is not None:
                if result["state"] == "PUBLISHED":
                    state.update(refill_ordinal=result["currentBatchOrdinal"], stage="pin_refill")
                elif result["state"] != "NOT_READY":
                    self.pause(state, "INVALID_PUBLICATION_RECEIPT")
        elif stage == "join":
            if state["usage"]["drafts"] >= self.policy["max_drafts"]:
                state.update(stage="done", reason="DRAFT_ATTEMPT_LIMIT")
                return
            if state["usage"]["opportunities"] >= self.policy["max_opportunities"]:
                state.update(stage="done", reason="OPPORTUNITY_LIMIT")
                return
            state["item"] = state["queue"][0]
            result = await self.write(
                state, "join_backlink_recommendations",
                {"recommendationFeedItemIds": [state["item"]]}, counter="opportunities",
            )
            if result is not None:
                item = result["results"][0]
                if item["id"] != state["item"] or item["state"] not in {"JOINED", "EXISTING"}:
                    self.pause(state, "JOIN_RECEIPT_UNVERIFIED")
                    return
                state["queue"].pop(0)
                state["opportunity"] = item["opportunityId"]
                if item["state"] == "EXISTING" and self.policy.get("skip_existing_opportunities"):
                    self.finish_item(state, {"state": "SKIPPED", "reason": "ALREADY_JOINED"})
                    return
                state["stage"] = "draft"
        elif stage == "draft":
            result = await self.write(
                state, "create_backlink_drafts",
                {"opportunityIds": [state["opportunity"]], "request": self.request},
                counter="drafts", cost="model",
            )
            if result is not None:
                item = result["results"][0]
                if item["id"] != state["opportunity"]:
                    self.pause(state, "DRAFT_RECEIPT_UNVERIFIED")
                elif item["state"] == "JOB_ACCEPTED":
                    state.update(job=item["jobId"], draft=item["draftId"], stage="job")
                elif item["state"] in {"SKIPPED", "EXISTING_DRAFT"}:
                    self.finish_item(state, {
                        "state": item["state"], "draftId": item.get("draftId"),
                        "reason": item.get("reason"),
                    })
                else:
                    self.pause(state, "DRAFT_RECEIPT_UNVERIFIED")
        elif stage in {"job", "verify"}:
            is_job = stage == "job"
            evidence = await self.drafts.read(
                self.project_id, self.organization_id, None,
                "get_backlink_draft_job" if is_job else "get_backlink_draft",
                {"jobId": state["job"]} if is_job else {"draftId": state["draft"]},
            )
            if is_job:
                job = evidence["data"]["job"]
                if job["draftId"] != state["draft"]:
                    self.pause(state, "DRAFT_JOB_MISMATCH")
                elif job["status"] == "SUCCEEDED":
                    state["stage"] = "verify"
                elif job["status"] not in {"QUEUED", "RUNNING", "RETRY_SCHEDULED"}:
                    self.finish_item(state, {
                        "state": "JOB_FAILED",
                        "draftId": state["draft"],
                        "jobStatus": job.get("status"),
                        "reason": (
                            job.get("diagnosticCode")
                            or job.get("lastErrorCategory")
                            or "DRAFT_GENERATION_FAILED"
                        ),
                        **{
                            key: job[key] for key in (
                                "diagnosticCode", "lastErrorCategory", "fallbackReason",
                                "attemptCount", "retryable",
                            ) if key in job
                        },
                    })
            else:
                checks = evidence["checks"]
                verified = (
                    evidence["data"]["draft"]["opportunityId"] == state["opportunity"]
                    and all(checks.get(key) is True for key in (
                        "hasText", "contactMatchesSnapshot", "fresh", "aiGenerated", "unapprovedDraft",
                    ))
                )
                self.finish_item(state, {
                    "state": "VERIFIED_DRAFT" if verified else "DRAFT_REQUIRES_REVIEW",
                    "draftId": state["draft"],
                })
                if verified and self.review:
                    state["quality_pending"] = state["results"][-1]["draftId"]
                    await self.save(deepcopy(state))
                    await self.review_pending(state)
        else:
            self.pause(state, "INVALID_CHECKPOINT")
        if (state["stage"] == "page" and state.get("last_page") and not state["queue"]
                and not state.get("quality_pending")):
            state["stage"] = "done"
