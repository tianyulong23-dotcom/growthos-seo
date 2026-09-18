"""References to accepted domain tasks, not copies of their mutable state."""

START_TO_KIND = {
    "start_technical_audit": ("audit", "网站审计"),
    "refresh_business_profile": ("project", "网站资料"),
    "start_keyword_library": ("keywords", "关键词生成"),
    "start_content_plan": ("content_plan", "内容计划"),
    "create_article": ("article", "文章生成"),
}
ACTIVE = {"queued", "running", "waiting", "blocked", "executing", "verifying", "ready", "dispatching", "retry_scheduled"}


def task_references(name: str, result: dict) -> list[dict]:
    if name == "create_backlink_drafts":
        return [
            task for item in result.get("results", [])[:10] if isinstance(item, dict)
            for task in task_references("create_backlink_draft", item)
        ]
    if result.get("verified") is not True:
        return []

    def ref(kind, title, identifier, related=None, status=None):
        if not isinstance(identifier, str) or not identifier:
            return []
        return [{
            "kind": kind, "task_id": identifier, "related_id": related or (None if kind == "agent" else identifier),
            "title": title, "status": status or result.get("status") or result.get("state") or "queued",
        }]

    if name in START_TO_KIND:
        kind, title = START_TO_KIND[name]
        return ref(kind, title, result.get("run_id") or result.get("batch_id"), result.get("article_id"))
    if name == "start_articles":
        return [task for article in result.get("articles", [])[:2] for task in ref(
            "article", "文章生成", article.get("run_id"), article.get("article_id"), article.get("status"),
        )]
    if name == "create_backlink_draft":
        return ref("draft", "开发信草稿", result.get("jobId"), result.get("draftId"))
    if name == "start_backlink_recommendations" and result.get("state") in {"STARTED", "ALREADY_STARTED"}:
        return ref("recommendation", "推荐池生成", result.get("generationContractId"), status="queued")
    if name == "start_backlink_campaign":
        return ref("agent", "外链自动化", result.get("run_id"), result.get("conversation_id"))
    if name == "send_backlink_drafts" and isinstance(result.get("batch"), dict):
        batch = result["batch"]
        return ref("agent", "逐封发送", batch.get("run_id"), status="queued")
    return []


def pending_references(results: list[dict]) -> list[dict]:
    return [
        task for result in results if result.get("ok") is True
        for task in result.get("data", {}).get("background_tasks", [])
        if str(task.get("status", "")).lower() in ACTIVE
    ]
