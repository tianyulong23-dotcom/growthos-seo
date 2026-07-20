from temporalio.client import Client

from app.core.config import get_settings


async def connect_temporal() -> Client:
    return await Client.connect(get_settings().temporal_address)
