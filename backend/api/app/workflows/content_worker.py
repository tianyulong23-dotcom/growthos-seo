import asyncio

from temporalio.worker import Worker

from app.core.config import get_settings
from app.core.secure_logging import configure_sensitive_logging
from app.modules.content.activities import CONTENT_ACTIVITIES
from app.modules.content.workflows import ArticleGenerationWorkflow
from app.modules.content_plan.activities import CONTENT_PLAN_ACTIVITIES
from app.modules.content_plan.workflows import (
    ContentPlanGenerationWorkflow,
    ContentPlanPreparationWorkflow,
)
from app.workflows.client import connect_temporal


async def main() -> None:
    settings = get_settings()
    configure_sensitive_logging(settings)
    client = await connect_temporal()
    worker = Worker(
        client,
        task_queue=settings.content_task_queue,
        workflows=[
            ArticleGenerationWorkflow,
            ContentPlanGenerationWorkflow,
            ContentPlanPreparationWorkflow,
        ],
        activities=[*CONTENT_ACTIVITIES, *CONTENT_PLAN_ACTIVITIES],
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
