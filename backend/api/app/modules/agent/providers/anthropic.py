from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app.modules.agent.providers.base import ProviderRequest, ProviderResult, TokenCount
from app.modules.agent.providers.errors import ProviderError
from app.modules.agent.providers.openai import (
    MAX_RESPONSE_BYTES,
    OpenAIProvider,
    classify_http_error,
)
from app.modules.agent.providers.tokenizers import local_count
from app.modules.agent.providers.usage import ProviderUsage, optional_int


def anthropic_endpoint(base_url: str, path: str) -> str:
    normalized = base_url.rstrip("/")
    return normalized + path if normalized.endswith("/v1") else normalized + "/v1" + path


def anthropic_usage(payload: dict[str, Any]) -> ProviderUsage:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    input_tokens = optional_int(usage.get("input_tokens"))
    output_tokens = optional_int(usage.get("output_tokens"))
    return ProviderUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=(input_tokens or 0) + (output_tokens or 0)
        if input_tokens is not None or output_tokens is not None
        else None,
        cached_input_tokens=optional_int(usage.get("cache_read_input_tokens")),
        cache_write_tokens=optional_int(usage.get("cache_creation_input_tokens")),
    )


class AnthropicProvider(OpenAIProvider):
    def headers(self) -> dict[str, str]:
        return {
            "x-api-key": self.config.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

    def serialize(self, request: ProviderRequest, *, stream: bool) -> dict[str, Any]:
        system, messages = self._messages(request.messages)
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "max_tokens": request.max_output_tokens or 4096,
        }
        if system:
            payload["system"] = system
        if request.tools:
            payload["tools"] = [
                {
                    "name": item["function"]["name"],
                    "description": item["function"].get("description", ""),
                    "input_schema": item["function"]["parameters"],
                }
                for item in request.tools
            ]
            if request.tool_choice == "auto":
                payload["tool_choice"] = {"type": "auto"}
        if stream:
            payload["stream"] = True
        return payload

    @staticmethod
    def _messages(
        messages: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]]]:
        systems: list[str] = []
        converted: list[dict[str, Any]] = []
        for message in messages:
            role = str(message.get("role") or "user")
            if role == "system":
                systems.append(str(message.get("content") or ""))
                continue
            if role == "tool":
                role = "user"
                content: Any = [{
                    "type": "tool_result",
                    "tool_use_id": str(message.get("tool_call_id") or ""),
                    "content": str(message.get("content") or ""),
                }]
            elif role == "assistant" and isinstance(message.get("tool_calls"), list):
                content = []
                if message.get("content"):
                    content.append({"type": "text", "text": str(message["content"])})
                for call in message["tool_calls"]:
                    function = call.get("function") if isinstance(call, dict) else {}
                    if not isinstance(function, dict):
                        continue
                    try:
                        arguments = json.loads(str(function.get("arguments") or "{}"))
                    except json.JSONDecodeError:
                        arguments = {}
                    content.append({
                        "type": "tool_use",
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "input": arguments,
                    })
            else:
                role = "assistant" if role == "assistant" else "user"
                content = str(message.get("content") or "")
            if converted and converted[-1]["role"] == role:
                previous = converted[-1]["content"]
                previous_blocks = previous if isinstance(previous, list) else [
                    {"type": "text", "text": str(previous)}
                ]
                next_blocks = content if isinstance(content, list) else [
                    {"type": "text", "text": str(content)}
                ]
                converted[-1]["content"] = previous_blocks + next_blocks
            else:
                converted.append({"role": role, "content": content})
        return "\n\n".join(systems), converted

    async def complete(self, request: ProviderRequest) -> ProviderResult:
        payload = await self._retry(lambda: __import__("asyncio").to_thread(
            self._complete_anthropic_once, request
        ))
        message: dict[str, Any] = {"content": ""}
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for block in payload.get("content", []):
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text_parts.append(str(block.get("text") or ""))
            elif block.get("type") == "tool_use":
                tool_calls.append({
                    "id": str(block.get("id") or ""),
                    "type": "function",
                    "function": {
                        "name": str(block.get("name") or ""),
                        "arguments": json.dumps(
                            block.get("input") or {}, ensure_ascii=False, separators=(",", ":")
                        ),
                    },
                })
        message["content"] = "".join(text_parts)
        if tool_calls:
            message["tool_calls"] = tool_calls
        return ProviderResult(
            provider=self.config.provider,
            model=self.config.model,
            response_model=str(payload.get("model") or self.config.model),
            message=message,
            usage=anthropic_usage(payload),
            stop_reason=str(payload.get("stop_reason")) if payload.get("stop_reason") else None,
            response_id=str(payload.get("id")) if payload.get("id") else None,
            raw=payload,
        )

    def _complete_anthropic_once(self, request: ProviderRequest) -> dict[str, Any]:
        raw_request = Request(
            anthropic_endpoint(self.config.base_url, "/messages"),
            data=json.dumps(self.serialize(request, stream=False)).encode(),
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

    def _stream_sync(self, request: ProviderRequest, emit: Any, stop: Any, response_holder: Any) -> None:
        raw_request = Request(
            anthropic_endpoint(self.config.base_url, "/messages"),
            data=json.dumps(self.serialize(request, stream=True)).encode(),
            method="POST",
            headers={**self.headers(), "Accept": "text/event-stream"},
        )
        total_bytes = 0
        completed = False
        input_usage: dict[str, Any] = {}
        output_usage: dict[str, Any] = {}
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
                    if not decoded or not decoded.startswith("data:"):
                        continue
                    try:
                        event = json.loads(decoded[5:].strip())
                    except json.JSONDecodeError as exc:
                        raise ProviderError(
                            "模型流式响应格式不兼容",
                            code="model_provider_invalid_response",
                            retryable=False,
                        ) from exc
                    event_type = event.get("type")
                    if event_type == "message_start":
                        message = event.get("message") or {}
                        response_id = str(message.get("id") or "") or None
                        input_usage = dict(message.get("usage") or {})
                    elif event_type == "content_block_start":
                        index = int(event.get("index") or 0)
                        block = event.get("content_block") or {}
                        if block.get("type") == "tool_use":
                            emit("toolcall_delta", {
                                "index": index,
                                "id_delta": str(block.get("id") or ""),
                                "name_delta": str(block.get("name") or ""),
                                "arguments_delta": "",
                            })
                    elif event_type == "content_block_delta":
                        index = int(event.get("index") or 0)
                        delta = event.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            emit("content_delta", str(delta.get("text") or ""))
                        elif delta.get("type") == "input_json_delta":
                            emit("toolcall_delta", {
                                "index": index,
                                "id_delta": "",
                                "name_delta": "",
                                "arguments_delta": str(delta.get("partial_json") or ""),
                            })
                    elif event_type == "message_delta":
                        delta = event.get("delta") or {}
                        if delta.get("stop_reason"):
                            stop_reason = str(delta["stop_reason"])
                        output_usage = dict(event.get("usage") or {})
                    elif event_type == "error":
                        error = event.get("error") or {}
                        error_type = str(error.get("type") or "")
                        retryable = error_type in {
                            "overloaded_error", "rate_limit_error", "api_error"
                        }
                        raise ProviderError(
                            str(error.get("message") or "模型服务流式请求失败"),
                            code="model_provider_unavailable"
                            if retryable else "model_provider_request_rejected",
                            retryable=retryable,
                        )
                    elif event_type == "message_stop":
                        completed = True
                        break
                if not stop.is_set() and not completed:
                    raise ProviderError(
                        "模型流式响应在完成前中断",
                        code="model_provider_unavailable",
                        retryable=True,
                    )
            usage = anthropic_usage({"usage": {**input_usage, **output_usage}}).as_dict()
            emit("done", {
                "usage": usage,
                "stop_reason": stop_reason,
                "response_id": response_id,
            })
        except HTTPError as exc:
            emit("error", classify_http_error(exc.code, self._error_body(exc), exc.headers))
        except Exception as exc:
            if isinstance(exc, ProviderError):
                emit("error", exc)
            else:
                super()._stream_sync(request, emit, stop, response_holder)
        finally:
            response_holder.pop("response", None)

    async def count_tokens(self, request: ProviderRequest) -> TokenCount:
        try:
            count = await self._retry(lambda: __import__("asyncio").to_thread(
                self._count_tokens_once, request
            ))
        except ProviderError as exc:
            if exc.status_code not in {404, 405, 422}:
                raise
            return local_count(self.config.provider, self.config.model, request)
        return TokenCount(
            tokens=count,
            provider=self.config.provider,
            model=self.config.model,
            count_source="anthropic_count_tokens_api",
            exact=True,
        )

    def _count_tokens_once(self, request: ProviderRequest) -> int:
        payload = self.serialize(request, stream=False)
        payload.pop("max_tokens", None)
        raw_request = Request(
            anthropic_endpoint(self.config.base_url, "/messages/count_tokens"),
            data=json.dumps(payload).encode(),
            method="POST",
            headers=self.headers(),
        )
        try:
            with urlopen(raw_request, timeout=self.config.timeout_seconds) as response:
                response_body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raise classify_http_error(exc.code, self._error_body(exc), exc.headers) from exc
        try:
            count = json.loads(response_body).get("input_tokens")
        except json.JSONDecodeError as exc:
            raise ProviderError(
                "模型 Token 计数响应格式不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            ) from exc
        if not isinstance(count, int):
            raise ProviderError(
                "模型 Token 计数响应格式不兼容",
                code="model_provider_invalid_response",
                retryable=False,
            )
        return count
