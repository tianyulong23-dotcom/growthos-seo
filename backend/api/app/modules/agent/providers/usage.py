from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ProviderUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    cached_input_tokens: int | None = None
    cache_write_tokens: int | None = None
    reasoning_tokens: int | None = None
    cost: float | None = None
    cost_currency: str | None = None

    def as_dict(self) -> dict[str, int | float | str | None]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "cost": self.cost,
            "cost_currency": self.cost_currency,
        }


def optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None
