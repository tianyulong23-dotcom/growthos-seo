from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.runtime import RuntimeDependencies

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: Literal["ok"]


@router.get(
    "/health",
    response_model=HealthResponse,
    operation_id="platformHealthV1",
)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/ready",
    response_model=HealthResponse,
    include_in_schema=False,
)
async def ready(request: Request) -> HealthResponse:
    runtime: RuntimeDependencies = request.app.state.runtime_dependencies
    try:
        await runtime.check()
    except Exception as error:
        raise HTTPException(status_code=503, detail="runtime dependencies unavailable") from error
    return HealthResponse(status="ok")
