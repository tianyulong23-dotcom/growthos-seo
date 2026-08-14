from __future__ import annotations

from typing import Any

from app.modules.agent.security import sanitize_text


BUSINESS_PROGRESS_LABELS = {
    "get_project_profile": {
        "completed": "项目资料已读取",
        "failed": "项目资料读取未完成",
    },
    "search_project_memory": {
        "completed": "项目信息已检索",
        "failed": "项目信息检索未完成",
    },
    "get_latest_audit": {
        "completed": "技术审核已读取",
        "failed": "技术审核读取未完成",
    },
    "get_audit_status": {
        "completed": "技术审核进度已检查",
        "failed": "技术审核进度检查未完成",
    },
    "get_audit_issues": {
        "completed": "技术审核问题已读取",
        "failed": "技术审核问题读取未完成",
    },
    "get_audit_pages": {
        "completed": "技术审核页面已读取",
        "failed": "技术审核页面读取未完成",
    },
    "update_project_memory": {
        "completed": "项目信息已更新",
        "failed": "项目信息更新未完成",
    },
    "update_business_profile": {
        "completed": "业务资料已更新",
        "failed": "业务资料更新未完成",
    },
    "refresh_business_profile": {
        "completed": "网站业务识别已启动",
        "failed": "网站业务识别启动未完成",
    },
    "start_technical_audit": {
        "completed": "技术审核已启动",
        "failed": "技术审核启动未完成",
    },
    "start_keyword_library": {
        "completed": "关键词库已启动",
        "failed": "关键词库启动未完成",
    },
    "get_keyword_library_status": {
        "completed": "关键词库进度已检查",
        "failed": "关键词库进度检查未完成",
    },
    "start_content_plan": {
        "completed": "内容计划已启动",
        "failed": "内容计划启动未完成",
    },
    "get_content_plan_status": {
        "completed": "内容计划进度已检查",
        "failed": "内容计划进度检查未完成",
    },
    "start_articles": {
        "completed": "计划文章已启动",
        "failed": "计划文章启动未完成",
    },
    "create_article": {
        "completed": "文章已创建",
        "failed": "文章创建未完成",
    },
    "get_article_generation_status": {
        "completed": "文章生成进度已检查",
        "failed": "文章生成进度检查未完成",
    },
    "list_keywords": {
        "completed": "关键词库已读取",
        "failed": "关键词库读取未完成",
    },
    "get_keyword_competitors": {
        "completed": "关键词竞品已读取",
        "failed": "关键词竞品读取未完成",
    },
    "get_keyword_opportunities": {
        "completed": "关键词机会已读取",
        "failed": "关键词机会读取未完成",
    },
    "get_search_performance": {
        "completed": "搜索表现已读取",
        "failed": "搜索表现读取未完成",
    },
    "get_article_performance": {
        "completed": "文章表现已读取",
        "failed": "文章表现读取未完成",
    },
}


ARTICLE_STATUS_LABELS = {
    "queued": "已排队",
    "running": "生成中",
    "completed": "已完成",
    "completed_with_warnings": "已完成，有少量警告",
    "failed": "生成失败",
    "cancelled": "已取消",
}


def business_progress_from_evidence(evidence: dict[str, Any]) -> list[dict[str, str]]:
    progress: list[dict[str, str]] = []
    positions: dict[str, int] = {}
    for index, item in enumerate(evidence.get("tool_evidence", [])):
        if not isinstance(item, dict):
            continue
        tool = str(item.get("tool", ""))
        labels = BUSINESS_PROGRESS_LABELS.get(tool)
        if labels is None:
            continue
        execution_status = str(item.get("execution_status", ""))
        if execution_status == "completed":
            status = "completed"
        elif execution_status == "failed":
            status = "failed"
        else:
            status = "interrupted"
        label = labels["completed" if status == "completed" else "failed"]
        tool_call_id = str(item.get("tool_call_id") or "")
        identity = tool_call_id or f"legacy:{tool}"
        entry = {"tool": tool, "label": label, "status": status}
        if tool_call_id:
            entry["tool_call_id"] = tool_call_id
        if identity in positions:
            progress[positions[identity]] = entry
        else:
            positions[identity] = len(progress)
            progress.append(entry)
    return progress


def display_parts_from_evidence(
    evidence: dict[str, Any], final_answer: str
) -> list[dict[str, str]]:
    events = evidence.get("display_events")
    if not isinstance(events, list):
        events = evidence.get("tool_evidence", [])

    parts: list[dict[str, str]] = []
    tool_positions: dict[str, int] = {}
    for item in events:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            text = sanitize_text(str(item.get("text", ""))).strip()
            if text:
                parts.append({"type": "text", "text": text})
            continue

        tool = str(item.get("tool", ""))
        labels = BUSINESS_PROGRESS_LABELS.get(tool)
        if labels is None:
            continue
        execution_status = str(item.get("execution_status", ""))
        if execution_status == "completed":
            status = "completed"
        elif execution_status == "failed":
            status = "failed"
        else:
            status = "interrupted"
        tool_call_id = str(item.get("tool_call_id") or "")
        identity = tool_call_id or f"legacy:{tool}"
        part = {
            "type": "tool",
            "tool": tool,
            "label": labels["completed" if status == "completed" else "failed"],
            "status": status,
        }
        if tool_call_id:
            part["tool_call_id"] = tool_call_id
        if identity in tool_positions:
            parts[tool_positions[identity]] = part
        else:
            tool_positions[identity] = len(parts)
            parts.append(part)

    answer = sanitize_text(final_answer).strip()
    if answer:
        parts.append({"type": "text", "text": answer})
    return parts


def failure_answer(
    progress: list[dict[str, str]],
    failure_reason: str | None = None,
    *,
    error_code: str | None = None,
    limit_reached: bool = False,
    evidence: dict[str, Any] | None = None,
) -> str:
    created_articles = []
    for item in (evidence or {}).get("tool_evidence", []):
        if not isinstance(item, dict):
            continue
        if (
            item.get("tool") != "create_article"
            or item.get("execution_status") != "completed"
            or item.get("ok") is not True
        ):
            continue
        data = item.get("data")
        if isinstance(data, dict) and data.get("article_id"):
            created_articles.append(data)

    if created_articles:
        tool_rollup = (
            (evidence or {}).get("execution_summary", {}).get("by_tool", {})
            if isinstance((evidence or {}).get("execution_summary"), dict)
            else {}
        )
        content_plan_rollup = (
            tool_rollup.get("start_content_plan", {})
            if isinstance(tool_rollup, dict)
            else {}
        )
        content_plan_created = bool(
            isinstance(content_plan_rollup, dict)
            and content_plan_rollup.get("completed")
        ) or any(
            isinstance(item, dict)
            and item.get("tool") == "start_content_plan"
            and item.get("execution_status") == "completed"
            and item.get("ok") is True
            for item in (evidence or {}).get("tool_evidence", [])
        )
        lines = ["文章已经创建，生成任务没有丢失。"]
        for article in created_articles:
            lines.extend(["", "**文章**", ""])
            keyword = sanitize_text(str(article.get("primary_keyword") or "")).strip()
            title = sanitize_text(str(article.get("title") or "")).strip()
            article_id = sanitize_text(str(article.get("article_id") or "")).strip()
            status = sanitize_text(str(article.get("status") or "")).strip()
            progress_value = article.get("progress")
            if keyword:
                lines.append(f"- 关键词：{keyword}")
            if title:
                lines.append(f"- 标题：{title}")
            lines.append(f"- 文章 ID：{article_id}")
            if status:
                status_text = ARTICLE_STATUS_LABELS.get(status, status)
                if isinstance(progress_value, int):
                    status_text = f"{status_text}（{progress_value}%）"
                lines.append(f"- 当前状态：{status_text}")
        if not content_plan_created:
            lines.extend([
                "",
                "这次是直接按关键词生成文章，没有创建内容计划。",
            ])
        rate_limited = error_code == "model_provider_unavailable" and any(
            marker in sanitize_text(failure_reason or "")
            for marker in ("请求过多", "限流", "rate limit", "too many requests")
        )
        failure_note = (
            "最后的回答整理遇到模型服务限流"
            if rate_limited
            else "最后的回答整理未完成"
        )
        lines.extend([
            "",
            f"{failure_note}，但不影响已经启动的文章任务。无需重新生成这篇文章。",
        ])
        return "\n".join(lines)

    completed = [item["label"] for item in progress if item["status"] == "completed"]
    failed_progress = next(
        (
            item["label"]
            for item in reversed(progress)
            if item["status"] != "completed"
        ),
        None,
    )
    stopped = failed_progress or "回答整理中断"
    if completed:
        intro = (
            "本次任务已达到平台运行上限，已完成的步骤和业务操作已经保留。"
            if limit_reached
            else "本次任务没有完成，但已完成的步骤和业务操作已经保留。"
        )
        lines = [intro, "", "**已完成**", ""]
        lines.extend(f"- {label}" for label in completed)
    else:
        lines = [
            (
                "本次任务已达到平台运行上限，尚未产生可确认的业务结果。"
                if limit_reached
                else "本次任务没有完成，尚未产生可确认的业务结果。"
            )
        ]
    lines.extend([
        "",
        "**停在**",
        "",
        f"- {stopped}",
        "",
        "**下一步**",
        "",
        "请重新发起未完成的工作。系统会先读取当前项目状态，再继续执行。",
    ])
    return "\n".join(lines)
