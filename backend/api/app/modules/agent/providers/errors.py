from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderErrorDetails:
    code: str
    retryable: bool
    status_code: int | None = None
    retry_after_seconds: float | None = None
    request_not_submitted: bool = False


class ProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        retryable: bool,
        status_code: int | None = None,
        retry_after_seconds: float | None = None,
        request_not_submitted: bool = False,
    ) -> None:
        super().__init__(message)
        self.details = ProviderErrorDetails(
            code=code,
            retryable=retryable,
            status_code=status_code,
            retry_after_seconds=retry_after_seconds,
            request_not_submitted=request_not_submitted,
        )

    @property
    def code(self) -> str:
        return self.details.code

    @property
    def retryable(self) -> bool:
        return self.details.retryable

    @property
    def status_code(self) -> int | None:
        return self.details.status_code

    @property
    def retry_after_seconds(self) -> float | None:
        return self.details.retry_after_seconds

    @property
    def request_not_submitted(self) -> bool:
        return self.details.request_not_submitted
