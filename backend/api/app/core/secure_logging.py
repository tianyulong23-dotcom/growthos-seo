from __future__ import annotations

import logging
import traceback
from collections.abc import Mapping
from typing import Any

from app.core.config import Settings
from app.modules.agent.security import (
    register_sensitive_values,
    sanitize_agent_data,
    sanitize_text,
)


_STANDARD_LOG_RECORD_FIELDS = frozenset(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
)
_FACTORY_MARKER = "_seo_sensitive_logging_factory"


def configure_sensitive_logging(settings: Settings) -> None:
    register_sensitive_values(_settings_secrets(settings))
    _install_record_factory()

    for handler in _configured_handlers():
        if not any(isinstance(item, SensitiveDataFilter) for item in handler.filters):
            handler.addFilter(SensitiveDataFilter())


class SensitiveDataFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        _sanitize_record(record, include_extra=True)
        return True


def _install_record_factory() -> None:
    current_factory = logging.getLogRecordFactory()
    if getattr(current_factory, _FACTORY_MARKER, False):
        return

    def secure_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = current_factory(*args, **kwargs)
        _sanitize_record(record, include_extra=False)
        return record

    setattr(secure_factory, _FACTORY_MARKER, True)
    logging.setLogRecordFactory(secure_factory)


def _configured_handlers() -> set[logging.Handler]:
    handlers = set(logging.getLogger().handlers)
    for logger in logging.Logger.manager.loggerDict.values():
        if isinstance(logger, logging.Logger):
            handlers.update(logger.handlers)
    return handlers


def _sanitize_record(record: logging.LogRecord, *, include_extra: bool) -> None:
    if isinstance(record.args, tuple):
        record.args = tuple(_sanitize_value(value) for value in record.args)
    elif isinstance(record.args, Mapping):
        record.args = {
            key: sanitize_agent_data(value, str(key))
            for key, value in record.args.items()
        }
    sanitized_message = _sanitize_value(record.msg)
    if record.args and sanitized_message != record.msg:
        record.msg = sanitize_text(record.getMessage())
        record.args = ()
    else:
        record.msg = sanitized_message

    if record.exc_info:
        rendered = "".join(traceback.format_exception(*record.exc_info))
        record.exc_text = sanitize_text(rendered)
        record.exc_info = (
            RuntimeError,
            RuntimeError(sanitize_text(str(record.exc_info[1]))),
            record.exc_info[2],
        )
    elif record.exc_text:
        record.exc_text = sanitize_text(record.exc_text)

    if include_extra:
        for key, value in list(record.__dict__.items()):
            if key not in _STANDARD_LOG_RECORD_FIELDS and key != "message":
                record.__dict__[key] = sanitize_agent_data(value, key)


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, bytes):
        return sanitize_text(value.decode("utf-8", errors="replace"))
    if isinstance(value, Mapping):
        return sanitize_agent_data(dict(value))
    if isinstance(value, list):
        return sanitize_agent_data(value)
    if isinstance(value, tuple):
        return tuple(_sanitize_value(item) for item in value)
    return value


def _settings_secrets(settings: Settings) -> tuple[str, ...]:
    values = (
        settings.database_url,
        settings.crawler_database_url,
        settings.redis_url,
        settings.dataforseo_login,
        settings.dataforseo_password,
        settings.article_research_api_key,
        settings.article_research_fallback_api_key,
        settings.s3_access_key_id,
        settings.s3_secret_access_key,
        settings.business_profile_ai_api_key,
        settings.ai_settings_encryption_key,
        settings.crawler_proxy_url,
        settings.crawler_fallback_proxy_url,
        settings.google_pagespeed_api_key,
    )
    return tuple(value for value in values if value)
