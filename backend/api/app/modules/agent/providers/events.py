from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


StreamEventKind = Literal[
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
    "error",
]


@dataclass(frozen=True)
class ProviderStreamEvent:
    kind: StreamEventKind
    delta: str = ""
    index: int | None = None
    tool_call_id: str = ""
    tool_name: str = ""
    id_delta: str = ""
    name_delta: str = ""
    arguments_delta: str = ""
    stop_reason: str | None = None
    usage: dict[str, int | float | str | None] | None = None
    response_id: str | None = None
    error: Exception | None = None
    raw: dict[str, Any] | None = None
