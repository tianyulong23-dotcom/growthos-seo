from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


OnboardingRunStatus = Literal["running", "waiting_for_confirmation", "completed"]
OnboardingStepStatus = Literal[
    "blocked", "ready", "running", "completed", "failed", "skipped"
]


class OnboardingStepResponse(BaseModel):
    key: str
    position: int = Field(ge=1)
    status: OnboardingStepStatus
    attempts: int = Field(ge=0)
    external_run_id: str | None
    last_error_code: str | None
    last_error_message: str | None
    started_at: datetime | None
    finished_at: datetime | None


class OnboardingRunResponse(BaseModel):
    id: str
    project_id: str
    status: OnboardingRunStatus
    started_at: datetime
    business_confirmed_at: datetime | None
    completed_at: datetime | None
    steps: list[OnboardingStepResponse]
