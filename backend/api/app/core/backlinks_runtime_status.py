import asyncio
from collections.abc import Awaitable, Callable

from temporalio.api.enums.v1 import TaskQueueType
from temporalio.api.taskqueue.v1 import TaskQueue
from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest
from temporalio.client import Client


class BacklinksRuntimeStatus:
    def __init__(
        self,
        *,
        address: str,
        namespace: str,
        task_queue: str,
        timeout_seconds: float,
        connect: Callable[..., Awaitable[Client]] = Client.connect,
    ) -> None:
        self._address = address
        self._namespace = namespace
        self._task_queue = task_queue
        self._timeout_seconds = timeout_seconds
        self._connect = connect
        self._client: Client | None = None
        self._client_lock = asyncio.Lock()

    async def business_consumers_running(self) -> bool:
        try:
            client = await asyncio.wait_for(
                self._get_client(),
                timeout=self._timeout_seconds,
            )
            response = await asyncio.wait_for(
                client.service_client.workflow_service.describe_task_queue(
                    DescribeTaskQueueRequest(
                        namespace=self._namespace,
                        task_queue=TaskQueue(name=self._task_queue),
                        task_queue_type=TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW,
                        report_pollers=True,
                    )
                ),
                timeout=self._timeout_seconds,
            )
        except Exception:
            self._client = None
            return False
        return bool(response.pollers)

    async def _get_client(self) -> Client:
        if self._client is not None:
            return self._client
        async with self._client_lock:
            if self._client is None:
                self._client = await self._connect(
                    self._address,
                    namespace=self._namespace,
                )
            return self._client
