from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    model_validator,
)


RunStatus = Literal[
    "queued", "running", "executing", "verifying",
    "completed", "cancelled", "failed", "limit_reached",
    # Legacy values remain readable for historical runs.
    "waiting_approval", "rejected", "expired",
]
ActionStatus = Literal[
    "pending", "approved", "rejected", "executing", "completed", "failed", "expired"
]


class PageContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    module: str = Field(min_length=1, max_length=100)
    view: str | None = Field(default=None, max_length=100)


class SendMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=20_000)
    client_request_id: str = Field(min_length=1, max_length=100)
    page_context: PageContext | None = None


class RewindConversationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: str = Field(min_length=1, max_length=200)
    client_request_id: str = Field(min_length=1, max_length=100)


class EditMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    client_request_id: str = Field(min_length=1, max_length=100)


class ApproveActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parameters_hash: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


class AgentMessageResponse(BaseModel):
    id: str
    run_id: str | None
    role: Literal["user", "assistant", "system_event"]
    content: str
    metadata: dict = Field(default_factory=dict)
    sequence: int
    created_at: datetime


class AgentActionResponse(BaseModel):
    id: str
    run_id: str
    tool_name: str
    status: ActionStatus
    preview: dict
    parameters_hash: str
    expires_at: datetime
    result: dict


class AgentConversationResponse(BaseModel):
    id: str
    project_id: str
    title: str
    created_at: datetime
    updated_at: datetime


class AgentConversationCollection(BaseModel):
    items: list[AgentConversationResponse]
    total: int
    page: int
    page_size: int


class AgentConversationDetail(BaseModel):
    conversation: AgentConversationResponse
    messages: list[AgentMessageResponse]
    run: AgentRunResponse | None
    action: AgentActionResponse | None


class SendMessageResponse(BaseModel):
    message_id: str
    run_id: str
    status: RunStatus


class AgentRunStepResponse(BaseModel):
    sequence: int
    step_type: Literal["model", "tool", "action", "execution", "verification", "cancellation"]
    name: str
    label: str
    summary: str | None = None
    status: Literal["running", "completed", "failed", "cancelled"]
    input: dict = Field(default_factory=dict)
    output: dict = Field(default_factory=dict)
    duration_ms: int | None
    error_code: str | None
    error_message: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    cost: float | None
    cost_currency: str | None
    created_at: datetime
    finished_at: datetime | None


class AgentRunResponse(BaseModel):
    id: str
    conversation_id: str
    status: RunStatus
    current_step: int
    error_code: str | None
    error_message: str | None
    action: AgentActionResponse | None = None
    final_message_id: str | None = None
    model_calls: int = 0
    tool_calls: int = 0
    failed_steps: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost: float | None = None
    cost_currency: str | None = None
    steps: list[AgentRunStepResponse] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class AgentOperationSummary(BaseModel):
    active_by_status: dict[str, int] = Field(default_factory=dict)
    stuck_runs: list[dict] = Field(default_factory=list)
    recent_failed: int = 0
    recent_failure_codes: dict[str, int] = Field(default_factory=dict)


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2_000)


MemoryFactValue = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000),
]

MemoryCategory = Literal[
    "business_positioning", "products_services", "target_customers",
    "target_markets", "competitors", "seo_goals", "strategy_limits",
]


class MemoryFactAdd(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["add"]
    category: MemoryCategory
    value: MemoryFactValue
    source: Literal["user_confirmed", "platform_data", "inferred"]


class MemoryFactUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["update"]
    fact_id: str = Field(min_length=1, max_length=100)
    value: MemoryFactValue
    source: Literal["user_confirmed", "platform_data", "inferred"]


class MemoryFactDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["delete"]
    fact_id: str = Field(min_length=1, max_length=100)
    source: Literal["user_confirmed", "platform_data", "inferred"]


MemoryOperation = Annotated[
    MemoryFactAdd | MemoryFactUpdate | MemoryFactDelete,
    Field(discriminator="operation"),
]


class UpdateProjectMemoryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operations: list[MemoryOperation] = Field(min_length=1, max_length=20)


class ResearchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: str = Field(min_length=1, max_length=500)
    input_scope: dict = Field(default_factory=dict)
    conclusion: str = Field(min_length=1, max_length=2_000)


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool_call_id: str | None = Field(default=None, min_length=1, max_length=200)
    tool: str = Field(min_length=1, max_length=100)
    arguments: dict = Field(default_factory=dict)


class ToolCallsDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["tool_calls"]
    tool_calls: list[ToolCall] = Field(min_length=1, max_length=8)


class FinalDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["final"]
    answer: str = Field(min_length=1, max_length=8_000)
    evidence: list[Evidence] = Field(default_factory=list, max_length=20)
    research: ResearchUpdate | None = None


class JudgeCriterion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requirement: str = Field(min_length=1, max_length=1_000)
    status: Literal["completed", "partial", "failed", "blocked"]
    evidence: str = Field(min_length=1, max_length=2_000)


class JudgeDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["completed", "partial", "failed", "blocked"]
    reason: str = Field(min_length=1, max_length=1_000)
    criteria: list[JudgeCriterion] = Field(min_length=1, max_length=20)
    remaining_work: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)]
    ] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_completion_consistency(self) -> JudgeDecision:
        all_completed = all(item.status == "completed" for item in self.criteria)
        if self.status == "completed" and not all_completed:
            raise ValueError("completed verdict requires every criterion to be completed")
        if self.status != "completed" and all_completed:
            raise ValueError("non-completed verdict requires an unfinished criterion")
        if self.status == "completed" and self.remaining_work:
            raise ValueError("completed verdict cannot contain remaining work")
        if self.status != "completed" and not self.remaining_work:
            raise ValueError("non-completed verdict requires remaining work")
        return self


ModelDecision = Annotated[ToolCallsDecision | FinalDecision, Field(discriminator="type")]
model_decision_adapter = TypeAdapter(ModelDecision)
