from __future__ import annotations

import asyncio
import errno
import random
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")

RETRY_DELAYS_SECONDS = (0.25, 1.0, 2.5)
MAX_JITTER_SECONDS = 0.25

TRANSIENT_CODES = {
    "CONNECTION_CLOSED",
    "CONNECTION_ENDED",
    "CONNECTION_DESTROYED",
    "CONNECT_TIMEOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "57P01",
    "57P02",
    "57P03",
}
PRE_EXECUTION_CODES = {
    "CONNECT_TIMEOUT",
    "ECONNREFUSED",
    "08001",
    "08004",
    "57P03",
}
TRANSIENT_ERRNOS = {
    errno.ECONNRESET,
    errno.ECONNREFUSED,
    errno.EPIPE,
    errno.ETIMEDOUT,
}
PRE_EXECUTION_ERRNOS = {errno.ECONNREFUSED}


def _error_chain(error: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        chain.append(current)
        for related in (
            getattr(current, "orig", None),
            current.__cause__,
            current.__context__,
        ):
            if isinstance(related, BaseException):
                pending.append(related)
    return chain


def _error_codes(error: BaseException) -> tuple[set[str], set[int]]:
    string_codes: set[str] = set()
    numeric_codes: set[int] = set()
    for item in _error_chain(error):
        for attribute in ("sqlstate", "pgcode", "code"):
            value = getattr(item, attribute, None)
            if isinstance(value, str) and value:
                string_codes.add(value.upper())
        error_number = getattr(item, "errno", None)
        if isinstance(error_number, int):
            numeric_codes.add(error_number)
        elif isinstance(error_number, str) and error_number:
            string_codes.add(error_number.upper())
    return string_codes, numeric_codes


def is_transient_database_error(
    error: BaseException,
    *,
    read_only: bool,
) -> bool:
    string_codes, numeric_codes = _error_codes(error)
    transient = (
        any(code.startswith("08") for code in string_codes)
        or bool(string_codes & TRANSIENT_CODES)
        or bool(numeric_codes & TRANSIENT_ERRNOS)
        or (
            read_only
            and any(
                bool(getattr(item, "connection_invalidated", False))
                for item in _error_chain(error)
            )
        )
    )
    if not transient:
        return False
    if read_only:
        return True
    return bool(
        string_codes & PRE_EXECUTION_CODES
        or numeric_codes & PRE_EXECUTION_ERRNOS
    )


async def retry_database_operation(
    operation: Callable[[], Awaitable[T]],
    *,
    read_only: bool,
) -> T:
    for attempt in range(len(RETRY_DELAYS_SECONDS) + 1):
        try:
            return await operation()
        except Exception as error:
            if (
                attempt >= len(RETRY_DELAYS_SECONDS)
                or not is_transient_database_error(error, read_only=read_only)
            ):
                raise
            await asyncio.sleep(
                RETRY_DELAYS_SECONDS[attempt]
                + random.uniform(0, MAX_JITTER_SECONDS)
            )
    raise RuntimeError("database retry loop exited unexpectedly")


def retry_database_read(
    function: Callable[P, Awaitable[T]],
) -> Callable[P, Awaitable[T]]:
    @wraps(function)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
        async def operation() -> T:
            return await function(*args, **kwargs)

        return await retry_database_operation(operation, read_only=True)

    return wrapped
