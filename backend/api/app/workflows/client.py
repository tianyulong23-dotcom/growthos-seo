from temporalio.client import Client

from app.core.config import get_settings


async def connect_temporal() -> Client:
    settings = get_settings()
    return await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )
