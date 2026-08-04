import asyncio

from temporalio.worker import Worker

from app.core.config import get_settings
from app.core.secure_logging import configure_sensitive_logging
from app.modules.agent.activities import AGENT_ACTIVITIES
from app.modules.agent.workflows import AgentWorkflow
from app.workflows.client import connect_temporal


async def main() -> None:
    settings = get_settings()
    configure_sensitive_logging(settings)
    client = await connect_temporal()
    worker = Worker(
        client, task_queue=settings.agent_task_queue,
        workflows=[AgentWorkflow], activities=AGENT_ACTIVITIES,
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
