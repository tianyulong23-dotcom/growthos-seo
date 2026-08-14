from __future__ import annotations

import asyncio
import errno
import json
import random
import socket
import threading
from collections.abc import AsyncIterator, Callable
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.modules.agent.providers.base import (
    ProviderConfig,
    ProviderRequest,
    ProviderResult,
    TokenCount,
)
from app.modules.agent.providers.errors import ProviderError
from app.modules.agent.providers.events import ProviderStreamEvent
from app.modules.agent.providers.tokenizers import local_count, truncate_with_model
from app.modules.agent.providers.usage import ProviderUsage, optional_float, optional_int
from app.modules.settings.provider_privacy import apply_provider_privacy


RETRYABLE_STATUS_CODES = {408, 409, 429, 500, 502, 503, 504}
CONTEXT_OVERFLOW_MARKERS = (
    "context_length_exceeded",
    "context length exceeded",
    "maximum context length",
    "maximum context",
    "prompt is too long",
    "too many input tokens",
    "token limit exceeded",
    "context window",
)
MAX_RESPONSE_BYTES = 1024 * 1024


def request_not_submitted(error: BaseException) -> bool:
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, (socket.gaierror, ConnectionRefusedError)):
        return True
    return isinstance(reason, OSError) and (
        reason.errno in {errno.ENETUNREACH, errno.EHOSTUNREACH}
        or getattr(reason, "winerror", None) in {10051, 10065}
    )


def endpoint_for(base_url: str, suffix: str) -> str:
    normalized = base_url.rstrip("/")
    return normalized if normalized.endswith(suffix) else normalized + suffix


def retry_after_seconds(headers: Message | None) -> float | None:
    if headers is None:
        return None
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def classify_http_error(
    status_code: int,
    response_body: bytes,
    headers: Message | None = None,
) -> ProviderError:
    text = response_body[:65_536].decode("utf-8", errors="replace").lower()
    if any(marker in text for marker in CONTEXT_OVERFLOW_MARKERS):
        return ProviderError(
            "The model context is too large and must be compacted before retrying.",
            code="model_context_overflow",
            retryable=False,
            status_code=status_code,
        )
    if status_code in {401, 403}:
        return ProviderError(
            "模型 API 密钥无效或没有权限",
            code="model_provider_auth_failed",
            retryable=False,
            status_code=status_code,
        )
    if status_code in RETRYABLE_STATUS_CODES:
        return ProviderError(
            "模型服务请求过多，请稍后重试"
            if status_code == 429
            else f"模型服务暂时不可用（HTTP {status_code}）",
            code="model_provider_unavailable",
            retryable=True,
            status_code=status_code,
            retry_after_seconds=retry_after_seconds(headers),
        )
    return ProviderError(
        f"模型服务拒绝了请求（HTTP {status_code}）",
        code="model_provider_request_rejected",
        retryable=False,
        status_code=status_code,
    )


def parse_usage(payload: dict[str, Any]) -> ProviderUsage:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    prompt_details = (
        usage.get("prompt_tokens_details")
        if isinstance(usage.get("prompt_tokens_details"), dict)
        else (
            usage.get("input_tokens_details")
            if isinstance(usage.get("input_tokens_details"), dict)
            else {}
        )
    )
    completion_details = (
        usage.get("completion_tokens_details")
        if isinstance(usage.get("completion_tokens_details"), dict)
        else (
            usage.get("output_tokens_details")
            if isinstance(usage.get("output_tokens_details"), dict)
            else {}
        )
    )
    return ProviderUsage(
        input_tokens=optional_int(usage.get("prompt_tokens", usage.get("input_tokens"))),
        output_tokens=optional_int(
            usage.get("completion_tokens", usage.get("output_tokens"))
        ),
        total_tokens=optional_int(usage.get("total_tokens")),
        cached_input_tokens=optional_int(
            prompt_details.get("cached_tokens", usage.get("cache_read_input_tokens"))
        ),
        cache_write_tokens=optional_int(usage.get("cache_creation_input_tokens")),
        reasoning_tokens=optional_int(completion_details.get("reasoning_tokens")),
        cost=optional_float(usage.get("cost", usage.get("total_cost", payload.get("cost")))),
        cost_currency=(
            str(usage.get("cost_currency", usage.get("currency")))[:20]
            if usage.get("cost_currency", usage.get("currency"))
            else None
        ),
    )


def responses_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "user")
        if role == "tool":
            items.append({
                "type": "function_call_output",
                "call_id": str(message.get("tool_call_id") or ""),
                "output": message.get("content") or "",
            })
            continue
        content = message.get("content")
        if content is not None and content != "" and content != []:
            items.append({"role": role, "content": content})
        raw_calls = message.get("tool_calls")
        if not isinstance(raw_calls, list):
            continue
        for raw_call in raw_calls:
            if not isinstance(raw_call, dict):
                continue
            function = raw_call.get("function")
            if not isinstance(function, dict):
                function = {}
            items.append({
                "type": "function_call",
                "call_id": str(raw_call.get("id") or ""),
                "name": str(function.get("name") or ""),
                "arguments": str(function.get("arguments") or ""),
            })
    return items


def responses_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for tool in tools:
        function = tool.get("function")
        if tool.get("type") != "function" or not isinstance(function, dict):
            converted.append(tool)
            continue
        converted.append({
            "type": "function",
            "name": str(function.get("name") or ""),
            "description": str(function.get("description") or ""),
            "parameters": function.get("parameters") or {},
            "strict": bool(function.get("strict", False)),
        })
    return converted


def responses_text_format(response_format: dict[str, Any]) -> dict[str, Any]:
    if response_format.get("type") != "json_schema":
        return dict(response_format)
    schema = response_format.get("json_schema")
    if not isinstance(schema, dict):
        return dict(response_format)
    return {
        "type": "json_schema",
        "name": str(schema.get("name") or "response"),
        "strict": bool(schema.get("strict", False)),
        "schema": schema.get("schema") or {},
    }


def normalize_responses_payload(payload: dict[str, Any]) -> dict[str, Any]:
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    output = payload.get("output")
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "function_call":
            tool_calls.append({
                "id": str(item.get("call_id") or item.get("id") or ""),
                "type": "function",
                "function": {
                    "name": str(item.get("name") or ""),
                    "arguments": str(item.get("arguments") or ""),
                },
            })
            continue
        content = item.get("content")
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, dict):
                continue
            if part.get("type") in {"output_text", "text"} and isinstance(
                part.get("text"), str
            ):
                text_parts.append(part["text"])
    message: dict[str, Any] = {
        "role": "assistant",
        "content": "".join(text_parts),
    }
    if tool_calls:
        message["tool_calls"] = tool_calls
    normalized = dict(payload)
    normalized["choices"] = [{
        "message": message,
        "finish_reason": "tool_calls" if tool_calls else payload.get("status"),
    }]
    return normalized


class OpenAIProvider:
    def __init__(self, config: ProviderConfig) -> None:
        self.config = config

    def headers(self) -> dict[str, str]:
        return {
            "Authorization": "Bearer " + self.config.api_key,
            "Content-Type": "application/json",
        }

    def serialize(self, request: ProviderRequest, *, stream: bool) -> dict[str, Any]:
        if self.config.api_protocol == "responses":
            payload: dict[str, Any] = {
                "model": self.config.model,
                "input": responses_input(request.messages),
                "reasoning": {"effort": self.config.reasoning_effort},
            }
            if request.response_format is not None:
                payload["text"] = {
                    "format": responses_text_format(request.response_format)
                }
            if request.tools:
                payload["tools"] = responses_tools(request.tools)
            if request.tool_choice is not None:
                payload["tool_choice"] = request.tool_choice
            if request.parallel_tool_calls is not None and request.tools:
                payload["parallel_tool_calls"] = request.parallel_tool_calls
            if request.max_output_tokens is not None:
                payload["max_output_tokens"] = request.max_output_tokens
            if request.metadata:
                payload["metadata"] = request.metadata
            if stream:
                payload["stream"] = True
            return apply_provider_privacy(self.config.base_url, payload)
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": request.messages,
            "reasoning_effort": self.config.reasoning_effort,
        }
        if request.response_format is not None:
            payload["response_format"] = request.response_format
        if request.tools:
            payload["tools"] = request.tools
        if request.tool_choice is not None:
            payload["tool_choice"] = request.tool_choice
        if request.parallel_tool_calls is not None and request.tools:
            payload["parallel_tool_calls"] = request.parallel_tool_calls
        if request.max_output_tokens is not None:
            payload["max_completion_tokens"] = request.max_output_tokens
        if stream:
            payload["stream"] = True
            payload["stream_options"] = {"include_usage": True}
        return apply_provider_privacy(self.config.base_url, payload)

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        payload = await self._retry(lambda: asyncio.to_thread(self._complete_once, request))
        if self.config.api_protocol == "responses":
            payload = normalize_responses_payload(payload)
        try:
            choice = payload["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError(
                "模型服务响应格式不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            ) from exc
        if not isinstance(message, dict):
            raise ProviderError(
                "模型服务响应格式不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            )
        return ProviderResult(
            provider=self.config.provider,
            model=self.config.model,
            response_model=str(payload.get("model") or self.config.model),
            message=message,
            usage=parse_usage(payload),
            stop_reason=str(choice.get("finish_reason")) if choice.get("finish_reason") else None,
            response_id=str(payload.get("id")) if payload.get("id") else None,
            raw=payload,
        )

    def _complete_once(self, request: ProviderRequest) -> dict[str, Any]:
        endpoint = endpoint_for(
            self.config.base_url,
            "/responses"
            if self.config.api_protocol == "responses"
            else "/chat/completions",
        )
        body = json.dumps(self.serialize(request, stream=False)).encode()
        raw_request = Request(
            endpoint,
            data=body,
            method="POST",
            headers=self.headers(),
        )
        response_body = self._read_response(raw_request)
        try:
            payload = json.loads(response_body)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                "模型服务响应格式不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            ) from exc
        if not isinstance(payload, dict):
            raise ProviderError(
                "模型服务响应格式不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            )
        return payload

    def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderStreamEvent]:
        return self._stream_with_retries(request)

    async def _stream_with_retries(
        self, request: ProviderRequest
    ) -> AsyncIterator[ProviderStreamEvent]:
        visible = False
        yield ProviderStreamEvent(kind="start")
        for attempt in range(self.config.max_retries + 1):
            try:
                async for event in self._stream_once(request):
                    if event.kind in {"text_delta", "thinking_delta", "toolcall_delta"}:
                        visible = True
                    yield event
                return
            except ProviderError as exc:
                if visible or not exc.retryable or attempt >= self.config.max_retries:
                    if (
                        exc.retryable
                        and self.config.max_retries > 0
                        and attempt >= self.config.max_retries
                    ):
                        raise ProviderError(
                            str(exc),
                            code=exc.code,
                            retryable=False,
                            status_code=exc.status_code,
                            request_not_submitted=exc.request_not_submitted,
                        ) from exc
                    raise
                await self._sleep_before_retry(attempt, exc.retry_after_seconds)

    async def _stream_once(
        self, request: ProviderRequest
    ) -> AsyncIterator[ProviderStreamEvent]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        stop = threading.Event()
        response_holder: dict[str, Any] = {}

        def emit(kind: str, value: Any) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, (kind, value))

        producer = asyncio.create_task(
            asyncio.to_thread(self._stream_sync, request, emit, stop, response_holder)
        )
        text_started = False
        tool_started: set[int] = set()
        try:
            while True:
                kind, value = await queue.get()
                if kind == "content_delta":
                    if not text_started:
                        text_started = True
                        yield ProviderStreamEvent(kind="text_start")
                    yield ProviderStreamEvent(kind="text_delta", delta=str(value))
                elif kind == "toolcall_delta":
                    update = dict(value)
                    index = int(update.get("index", 0))
                    if index not in tool_started:
                        tool_started.add(index)
                        yield ProviderStreamEvent(kind="toolcall_start", index=index)
                    yield ProviderStreamEvent(
                        kind="toolcall_delta",
                        index=index,
                        id_delta=str(update.get("id_delta") or ""),
                        name_delta=str(update.get("name_delta") or ""),
                        arguments_delta=str(update.get("arguments_delta") or ""),
                    )
                elif kind == "error":
                    raise value
                elif kind == "done":
                    metadata = dict(value)
                    if text_started:
                        yield ProviderStreamEvent(kind="text_end")
                    for index in sorted(tool_started):
                        yield ProviderStreamEvent(kind="toolcall_end", index=index)
                    yield ProviderStreamEvent(
                        kind="done",
                        stop_reason=metadata.get("stop_reason"),
                        usage=metadata.get("usage"),
                        response_id=metadata.get("response_id"),
                        raw=metadata,
                    )
                    break
            await producer
        except BaseException:
            stop.set()
            response = response_holder.get("response")
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            await asyncio.gather(producer, return_exceptions=True)
            raise

    def _stream_sync(
        self,
        request: ProviderRequest,
        emit: Callable[[str, Any], None],
        stop: threading.Event,
        response_holder: dict[str, Any],
    ) -> None:
        endpoint = endpoint_for(
            self.config.base_url,
            "/responses"
            if self.config.api_protocol == "responses"
            else "/chat/completions",
        )
        body = json.dumps(self.serialize(request, stream=True)).encode()
        raw_request = Request(
            endpoint,
            data=body,
            method="POST",
            headers={**self.headers(), "Accept": "text/event-stream"},
        )
        total_bytes = 0
        completed = False
        usage: dict[str, int | float | str | None] | None = None
        stop_reason: str | None = None
        response_id: str | None = None
        try:
            with urlopen(raw_request, timeout=self.config.timeout_seconds) as response:
                response_holder["response"] = response
                while not stop.is_set():
                    line = response.readline()
                    if not line:
                        break
                    total_bytes += len(line)
                    if total_bytes > MAX_RESPONSE_BYTES:
                        raise ProviderError(
                            "模型服务响应过大",
                            code="model_provider_response_too_large",
                            retryable=False,
                        )
                    decoded = line.decode("utf-8", errors="strict").strip()
                    if not decoded or decoded.startswith(":") or not decoded.startswith("data:"):
                        continue
                    data = decoded[5:].strip()
                    if data == "[DONE]":
                        completed = True
                        break
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError as exc:
                        raise ProviderError(
                            "模型流式响应格式不兼容",
                            code="model_provider_invalid_response",
                            retryable=False,
                        ) from exc
                    if event.get("id"):
                        response_id = str(event["id"])
                    if self.config.api_protocol == "responses":
                        event_type = str(event.get("type") or "")
                        response_payload = (
                            event.get("response")
                            if isinstance(event.get("response"), dict)
                            else {}
                        )
                        if response_payload.get("id"):
                            response_id = str(response_payload["id"])
                        if event_type == "response.output_text.delta":
                            delta = event.get("delta")
                            if isinstance(delta, str) and delta:
                                emit("content_delta", delta)
                        elif event_type == "response.output_item.added":
                            item = event.get("item")
                            if isinstance(item, dict) and item.get("type") == "function_call":
                                index = event.get("output_index", 0)
                                emit("toolcall_delta", {
                                    "index": index if isinstance(index, int) else 0,
                                    "id_delta": str(item.get("call_id") or item.get("id") or ""),
                                    "name_delta": str(item.get("name") or ""),
                                    "arguments_delta": str(item.get("arguments") or ""),
                                })
                        elif event_type == "response.function_call_arguments.delta":
                            index = event.get("output_index", 0)
                            emit("toolcall_delta", {
                                "index": index if isinstance(index, int) else 0,
                                "id_delta": "",
                                "name_delta": "",
                                "arguments_delta": str(event.get("delta") or ""),
                            })
                        elif event_type == "response.completed":
                            completed = True
                            stop_reason = str(response_payload.get("status") or "completed")
                            usage = parse_usage(response_payload).as_dict()
                        elif event_type in {"response.failed", "response.incomplete"}:
                            raise ProviderError(
                                "模型服务未完成响应",
                                code="model_provider_invalid_response",
                                retryable=False,
                            )
                        continue
                    if isinstance(event.get("usage"), dict):
                        usage = parse_usage(event).as_dict()
                    choices = event.get("choices")
                    if not isinstance(choices, list):
                        continue
                    for choice in choices:
                        if not isinstance(choice, dict):
                            continue
                        if choice.get("finish_reason") is not None:
                            completed = True
                            stop_reason = str(choice["finish_reason"])
                        delta = choice.get("delta")
                        if not isinstance(delta, dict):
                            continue
                        content = delta.get("content")
                        if isinstance(content, str) and content:
                            emit("content_delta", content)
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict) and isinstance(part.get("text"), str):
                                    emit("content_delta", part["text"])
                        raw_calls = delta.get("tool_calls")
                        if not isinstance(raw_calls, list):
                            continue
                        for fallback_index, raw_call in enumerate(raw_calls):
                            if not isinstance(raw_call, dict):
                                continue
                            function = raw_call.get("function")
                            if not isinstance(function, dict):
                                function = {}
                            index = raw_call.get("index", fallback_index)
                            emit("toolcall_delta", {
                                "index": index if isinstance(index, int) else fallback_index,
                                "id_delta": str(raw_call.get("id") or ""),
                                "name_delta": str(function.get("name") or ""),
                                "arguments_delta": str(function.get("arguments") or ""),
                            })
                if not stop.is_set() and not completed:
                    raise ProviderError(
                        "模型流式响应在完成前中断",
                        code="model_provider_unavailable",
                        retryable=True,
                    )
            emit("done", {
                "usage": usage,
                "stop_reason": stop_reason,
                "response_id": response_id,
            })
        except HTTPError as exc:
            emit("error", classify_http_error(exc.code, self._error_body(exc), exc.headers))
        except (TimeoutError, socket.timeout):
            emit("error", ProviderError(
                "模型服务响应超时",
                code="model_provider_timeout",
                retryable=True,
            ))
        except (URLError, OSError):
            emit("error", ProviderError(
                "无法连接模型服务",
                code="model_provider_unavailable",
                retryable=True,
            ))
        except Exception as exc:
            emit("error", exc)
        finally:
            response_holder.pop("response", None)

    async def count_tokens(self, request: ProviderRequest) -> TokenCount:
        return local_count(self.config.provider, self.config.model, request)

    def truncate_text(self, text: str, max_tokens: int) -> str:
        return truncate_with_model(
            self.config.provider, self.config.model, text, max_tokens
        )

    async def test_connection(self) -> None:
        result = await self.complete(ProviderRequest(
            messages=[
                {"role": "system", "content": "Return only JSON."},
                {"role": "user", "content": 'Return {"ok":true}.'},
            ],
            response_format={"type": "json_object"},
            max_output_tokens=32,
        ))
        content = str(result.message.get("content") or "").strip()
        content = content.removeprefix("```json").removeprefix("```")
        content = content.removesuffix("```").strip()
        try:
            if json.loads(content).get("ok") is not True:
                raise ValueError
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ProviderError(
                "模型响应格式与当前项目不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            ) from exc

    async def _retry(self, operation: Callable[[], Any]) -> Any:
        for attempt in range(self.config.max_retries + 1):
            try:
                return await operation()
            except ProviderError as exc:
                if not exc.retryable or attempt >= self.config.max_retries:
                    if (
                        exc.retryable
                        and self.config.max_retries > 0
                        and attempt >= self.config.max_retries
                    ):
                        raise ProviderError(
                            str(exc),
                            code=exc.code,
                            retryable=False,
                            status_code=exc.status_code,
                            request_not_submitted=exc.request_not_submitted,
                        ) from exc
                    raise
                await self._sleep_before_retry(attempt, exc.retry_after_seconds)
        raise AssertionError("provider retry loop exhausted")

    async def _sleep_before_retry(
        self, attempt: int, retry_after: float | None
    ) -> None:
        delay = retry_after if retry_after is not None else min(2**attempt, 60)
        await asyncio.sleep(delay + random.uniform(0, max(delay * 0.1, 0.001)))

    def _read_response(self, request: Request) -> bytes:
        try:
            with urlopen(request, timeout=self.config.timeout_seconds) as response:
                response_body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raise classify_http_error(exc.code, self._error_body(exc), exc.headers) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderError(
                "模型服务响应超时",
                code="model_provider_timeout",
                retryable=True,
            ) from exc
        except (URLError, OSError) as exc:
            raise ProviderError(
                "无法连接模型服务",
                code="model_provider_unavailable",
                retryable=True,
                request_not_submitted=request_not_submitted(exc),
            ) from exc
        if len(response_body) > MAX_RESPONSE_BYTES:
            raise ProviderError(
                "模型服务响应过大",
                code="model_provider_response_too_large",
                retryable=False,
            )
        return response_body

    @staticmethod
    def _error_body(exc: HTTPError) -> bytes:
        try:
            return exc.read(65_537)
        except (AttributeError, OSError, ValueError):
            return b""
