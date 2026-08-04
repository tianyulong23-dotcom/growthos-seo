from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError


CONTROL_RETRY = RetryPolicy(maximum_attempts=2)
STAGE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=5),
    maximum_attempts=2,
)
ARTICLE_STAGES = (
    ("preparing", 5),
    ("collecting", 15),
    ("competitor_research", 30),
    ("planning", 45),
    ("writing", 65),
    ("editing", 80),
)
MAX_REPAIR_ITERATIONS = 3
RETRY_INITIAL_SECONDS = 5
RETRY_MAX_SECONDS = 60


def retry_delay(attempt: int) -> float:
    return float(min(RETRY_MAX_SECONDS, RETRY_INITIAL_SECONDS * (2 ** max(0, attempt))))


@workflow.defn(name="ArticleGenerationWorkflow")
class ArticleGenerationWorkflow:
    @workflow.run
    async def run(self, payload: dict[str, Any]) -> None:
        if set(payload) != {"run_id"}:
            raise ValueError("ArticleGenerationWorkflow only accepts run_id")
        run_id = str(payload["run_id"])
        started = await self._call("content_begin_run", {"run_id": run_id})
        if started is None or started.get("status") != "running":
            return

        warnings: list[dict[str, str]] = []
        for step_key, progress in ARTICLE_STAGES:
            result = await self._run_stage(
                run_id,
                step_key=step_key,
                stage_kind=step_key,
                progress=progress,
            )
            if result is None or result.get("status") == "cancelled":
                return
            self._append_warnings(warnings, result)

        check_key = "checking_1"
        result = await self._run_stage(
            run_id,
            step_key=check_key,
            stage_kind="checking",
            input_step_key="editing",
            repair_iteration=0,
            progress=88,
        )
        if result is None or result.get("status") == "cancelled":
            return
        self._append_warnings(warnings, result)
        checking_passed = self._checking_passed(result)
        checking_repairable = self._checking_repairable(result)
        evidence_issue_count = self._evidence_issue_count(result)
        content_score_passed = self._content_score_passed(result)
        previous_repairable_fingerprint = self._repairable_fingerprint(result)
        previous_repairable_count = self._repairable_issue_count(result)
        repaired = False
        converged = False

        for repair_iteration in range(1, MAX_REPAIR_ITERATIONS + 1):
            if checking_passed or not checking_repairable:
                break
            repaired = True
            revision_key = f"revising_{repair_iteration}"
            result = await self._run_stage(
                run_id,
                step_key=revision_key,
                stage_kind="revising",
                input_step_key=check_key,
                repair_iteration=repair_iteration,
                progress=min(90 + repair_iteration * 2, 96),
            )
            if result is None or result.get("status") == "cancelled":
                return
            self._append_warnings(warnings, result)
            revised_sections = self._revised_section_count(result)

            check_key = f"checking_{repair_iteration + 1}"
            result = await self._run_stage(
                run_id,
                step_key=check_key,
                stage_kind="checking",
                input_step_key=revision_key,
                repair_iteration=repair_iteration,
                progress=min(91 + repair_iteration * 2, 98),
            )
            if result is None or result.get("status") == "cancelled":
                return
            self._append_warnings(warnings, result)
            checking_passed = self._checking_passed(result)
            checking_repairable = self._checking_repairable(result)
            evidence_issue_count = self._evidence_issue_count(result)
            latest_content_score_passed = self._content_score_passed(result)
            if latest_content_score_passed is not None:
                content_score_passed = latest_content_score_passed
            current_fingerprint = self._repairable_fingerprint(result)
            current_count = self._repairable_issue_count(result)
            if (
                not checking_passed
                and checking_repairable
                and (
                    revised_sections == 0
                    or (
                        current_fingerprint is not None
                        and previous_repairable_fingerprint is not None
                        and current_fingerprint == previous_repairable_fingerprint
                    )
                    or (
                        current_count is not None
                        and previous_repairable_count is not None
                        and current_count >= previous_repairable_count
                    )
                )
            ):
                converged = True
                break
            previous_repairable_fingerprint = current_fingerprint
            previous_repairable_count = current_count

        if checking_passed and repaired:
            warnings = self._clear_resolved_quality_warnings(warnings)
        elif converged:
            warnings.append(
                {
                    "code": "quality_revision_converged",
                    "message": "自动修订已停止：继续改写没有减少可修复问题，已返回当前完整稿",
                }
            )
        elif checking_repairable:
            warnings.append(
                {
                    "code": "quality_issues_remaining",
                    "message": "文章已完整生成并完成三轮自动修订，仍有部分质量问题未解决",
                }
            )
        if evidence_issue_count > 0:
            warnings.append(
                {
                    "code": "quality_evidence_gaps",
                    "message": "文章已完整生成；缺少的数据或证据已作为质量提示保留，不再重复改写",
                }
            )
        if content_score_passed is True:
            warnings = [
                item
                for item in warnings
                if item.get("code") != "content_quality_below_threshold"
            ]
        finish_payload = {
            "run_id": run_id,
            "status": "completed_with_warnings" if warnings else "completed",
            "warnings": warnings,
        }
        finish_attempt = 0
        while True:
            try:
                await self._call("content_finish_run", finish_payload)
                break
            except ActivityError:
                await self._sleep(retry_delay(finish_attempt))
                finish_attempt += 1

    async def _run_stage(
        self,
        run_id: str,
        *,
        step_key: str,
        stage_kind: str,
        progress: int,
        input_step_key: str | None = None,
        repair_iteration: int = 0,
    ) -> dict[str, Any] | None:
        payload: dict[str, Any] = {
            "run_id": run_id,
            "step_key": step_key,
            "stage_kind": stage_kind,
            "progress": progress,
            "repair_iteration": repair_iteration,
        }
        if input_step_key:
            payload["input_step_key"] = input_step_key
        busy_attempt = 0
        while True:
            try:
                result = await self._call("content_execute_stage", payload)
            except ActivityError:
                recovery_attempt = 0
                while True:
                    try:
                        result = await self._call("content_recover_stage", payload)
                        break
                    except ActivityError:
                        await self._sleep(retry_delay(recovery_attempt))
                        recovery_attempt += 1
            if result is None or result.get("status") != "busy":
                return result
            await self._sleep(retry_delay(busy_attempt))
            busy_attempt += 1

    @staticmethod
    def _checking_passed(result: dict[str, Any]) -> bool:
        checking_result = result.get("result")
        return bool(
            isinstance(checking_result, dict)
            and checking_result.get("passed") is True
            and checking_result.get("issue_count") == 0
        )

    @staticmethod
    def _checking_repairable(result: dict[str, Any]) -> bool:
        checking_result = result.get("result")
        if not isinstance(checking_result, dict):
            return False
        if "repairable" in checking_result:
            return checking_result.get("repairable") is True
        return bool(
            checking_result.get("check_status") != "unavailable"
            and int(checking_result.get("issue_count") or 0) > 0
        )

    @staticmethod
    def _evidence_issue_count(result: dict[str, Any]) -> int:
        checking_result = result.get("result")
        if not isinstance(checking_result, dict):
            return 0
        return int(checking_result.get("evidence_issue_count") or 0)

    @staticmethod
    def _content_score_passed(result: dict[str, Any]) -> bool | None:
        checking_result = result.get("result")
        if not isinstance(checking_result, dict):
            return None
        value = checking_result.get("content_score_passed")
        return value if isinstance(value, bool) else None

    @staticmethod
    def _repairable_issue_count(result: dict[str, Any]) -> int | None:
        checking_result = result.get("result")
        if not isinstance(checking_result, dict):
            return None
        if "repairable_issue_count" in checking_result:
            return int(checking_result.get("repairable_issue_count") or 0)
        return None

    @staticmethod
    def _repairable_fingerprint(result: dict[str, Any]) -> tuple[str, ...] | None:
        checking_result = result.get("result")
        if not isinstance(checking_result, dict):
            return None
        values = checking_result.get("repairable_issue_fingerprint")
        if not isinstance(values, list):
            return None
        return tuple(sorted(str(item) for item in values))

    @staticmethod
    def _revised_section_count(result: dict[str, Any]) -> int:
        revision_result = result.get("result")
        if not isinstance(revision_result, dict):
            return 0
        return int(revision_result.get("revised_sections") or 0)

    @staticmethod
    def _append_warnings(
        warnings: list[dict[str, str]], result: dict[str, Any]
    ) -> None:
        stage_warnings = list(result.get("warnings", []))
        if result.get("warning"):
            stage_warnings.append(result["warning"])
        for warning in stage_warnings:
            if warning and warning.get("code"):
                warnings.append(
                    {
                        "code": str(warning["code"]),
                        "message": str(warning.get("message", "")),
                    }
                )

    @staticmethod
    def _clear_resolved_quality_warnings(
        warnings: list[dict[str, str]],
    ) -> list[dict[str, str]]:
        resolved_codes = {
            "writing_degraded",
            "checking_degraded",
            "revising_degraded",
        }
        return [item for item in warnings if item.get("code") not in resolved_codes]

    async def _sleep(self, seconds: float) -> None:
        await workflow.sleep(timedelta(seconds=seconds))

    async def _call(
        self, name: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        is_stage = name in {"content_execute_stage", "content_recover_stage"}
        return await workflow.execute_activity(
            name,
            payload,
            start_to_close_timeout=timedelta(seconds=3600 if is_stage else 120),
            heartbeat_timeout=timedelta(seconds=90) if is_stage else None,
            retry_policy=STAGE_RETRY if is_stage else CONTROL_RETRY,
        )
