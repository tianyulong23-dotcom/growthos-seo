from uuid import uuid4

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.modules.agent.models import AgentSystemTrigger

BACKLINKS_READY_TRIGGER = "backlinks_project_ready"


async def record_backlinks_ready(session, resolved, payload):
    """Persist intent only; the dispatcher excludes this trigger until durable consent exists."""
    if payload.get("inputComplete") is not True or payload.get("projectStatus") != "ACTIVE":
        return
    await session.execute(
        pg_insert(AgentSystemTrigger).values(
            id=str(uuid4()),
            organization_id=resolved.tenant.organization_id,
            project_id=resolved.project.website_project_id,
            trigger=BACKLINKS_READY_TRIGGER,
            trigger_version="initial",
            status="pending",
            content=(
                "Backlinks project inputs are ready. Automation is awaiting durable "
                "project authorization. After authorization, inspect the current V2 feed, "
                "start the initial recommendation job only if absent, wait for publication, "
                "join released items and generate drafts for eligible confirmed contacts. "
                "Inspect every saved draft. This trigger never authorizes approval or sending."
            ),
            trusted_write_tools_json=[],
        ).on_conflict_do_nothing(constraint="uq_agent_system_triggers_identity")
    )
