from __future__ import annotations

import re
from collections import OrderedDict
from threading import RLock
from typing import Any, Iterable


SENSITIVE_KEYS = {
    "apikey", "authorization", "authtoken", "cookie", "setcookie", "password",
    "secret", "databaseurl", "token", "accesstoken", "refreshtoken", "privatekey",
    "clientsecret", "sessionid", "connectionstring",
}
BEARER_PATTERN = re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+")
BASIC_PATTERN = re.compile(r"(?i)basic\s+[A-Za-z0-9+/=]+")
URL_CREDENTIAL_PATTERN = re.compile(
    r"(?P<prefix>\b[a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s@/]+@"
)
API_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b")
SECRET_PARAMETER_PATTERN = re.compile(
    r"(?i)(?P<prefix>\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|"
    r"client[_-]?secret|private[_-]?key|connection[_-]?string|password|"
    r"session[_-]?id|cookie|secret|token)\s*[=:]\s*)[^\s&;,]+"
)
_RUNTIME_SECRETS: OrderedDict[str, None] = OrderedDict()
_RUNTIME_SECRETS_LOCK = RLock()
_MAX_RUNTIME_SECRETS = 1_000


def register_sensitive_values(values: Iterable[str | None]) -> None:
    candidates = {
        value for value in values if isinstance(value, str) and len(value) >= 4
    }
    if not candidates:
        return
    with _RUNTIME_SECRETS_LOCK:
        for value in sorted(candidates, key=len, reverse=True):
            _RUNTIME_SECRETS[value] = None
            _RUNTIME_SECRETS.move_to_end(value)
        while len(_RUNTIME_SECRETS) > _MAX_RUNTIME_SECRETS:
            _RUNTIME_SECRETS.popitem(last=False)


def registered_sensitive_values() -> tuple[str, ...]:
    with _RUNTIME_SECRETS_LOCK:
        return tuple(sorted(_RUNTIME_SECRETS.keys(), key=len, reverse=True))


def sanitize_text(value: str, secrets: Iterable[str] = ()) -> str:
    sanitized = BEARER_PATTERN.sub("Bearer [REDACTED]", value)
    sanitized = BASIC_PATTERN.sub("Basic [REDACTED]", sanitized)
    sanitized = URL_CREDENTIAL_PATTERN.sub(r"\g<prefix>[REDACTED]@", sanitized)
    sanitized = API_KEY_PATTERN.sub("[REDACTED]", sanitized)
    sanitized = SECRET_PARAMETER_PATTERN.sub(r"\g<prefix>[REDACTED]", sanitized)
    for secret in sorted(
        {
            item
            for item in (*registered_sensitive_values(), *secrets)
            if isinstance(item, str) and len(item) >= 4
        },
        key=len,
        reverse=True,
    ):
        sanitized = sanitized.replace(secret, "[REDACTED]")
    return sanitized


def sanitize_agent_data(
    value: Any,
    key: str = "",
    *,
    secrets: Iterable[str] = (),
) -> Any:
    normalized_key = re.sub(r"[^a-z0-9]", "", key.casefold())
    if normalized_key in SENSITIVE_KEYS or normalized_key.endswith(
        ("apikey", "authtoken", "accesstoken", "refreshtoken", "clientsecret", "privatekey")
    ):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            str(item_key)[:200]: sanitize_agent_data(
                item_value, str(item_key), secrets=secrets
            )
            for item_key, item_value in list(value.items())[:500]
        }
    if isinstance(value, list):
        return [sanitize_agent_data(item, secrets=secrets) for item in value[:500]]
    if isinstance(value, tuple):
        return [sanitize_agent_data(item, secrets=secrets) for item in value[:500]]
    if isinstance(value, str):
        return sanitize_text(value, secrets)[:100_000]
    return value
