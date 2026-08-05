from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from app.cache.client import get_redis
from app.modules.agent.security import sanitize_agent_data


STREAM_MAX_LENGTH = 2_000
STREAM_TTL_SECONDS = 86_400

_CLOSE_MESSAGE_SCRIPT = """
if redis.call('EXISTS', KEYS[3]) == 1 then
    return false
end
local sequence = redis.call('INCR', KEYS[2])
local event = cjson.decode(ARGV[1])
event['sequence'] = sequence
event['created_at'] = ARGV[2]
local event_id = redis.call(
    'XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], '*',
    'event', 'message_end', 'data', cjson.encode(event)
)
redis.call('SET', KEYS[3], '1', 'EX', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return event_id
"""


def conversation_stream_key(conversation_id: str) -> str:
    return f"agent:conversation:{conversation_id}:events"


def conversation_sequence_key(conversation_id: str) -> str:
    return f"agent:conversation:{conversation_id}:sequence"


def message_end_key(
    conversation_id: str,
    run_id: str,
    message_id: str,
    attempt: int,
) -> str:
    return (
        f"agent:conversation:{conversation_id}:run:{run_id}:"
        f"message:{message_id}:attempt:{attempt}:ended"
    )


class AgentEventStore:
    def __init__(self, redis: Any | None = None) -> None:
        self.redis = redis or get_redis()

    async def publish(
        self,
        conversation_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        secrets: tuple[str, ...] = (),
    ) -> str | None:
        stream_key = conversation_stream_key(conversation_id)
        sequence_key = conversation_sequence_key(conversation_id)
        try:
            sequence = int(await self.redis.incr(sequence_key))
            event = sanitize_agent_data(
                {
                    **payload,
                    "type": event_type,
                    "sequence": sequence,
                    "created_at": datetime.now(UTC).isoformat(),
                },
                secrets=secrets,
            )
            event_id = await self.redis.xadd(
                stream_key,
                {
                    "event": event_type,
                    "data": json.dumps(
                        event, ensure_ascii=False, separators=(",", ":")
                    ),
                },
                maxlen=STREAM_MAX_LENGTH,
                approximate=True,
            )
            await self.redis.expire(stream_key, STREAM_TTL_SECONDS)
            await self.redis.expire(sequence_key, STREAM_TTL_SECONDS)
            return str(event_id)
        except Exception:
            return None

    async def close_message(
        self,
        conversation_id: str,
        payload: dict[str, Any],
        *,
        secrets: tuple[str, ...] = (),
    ) -> str | None:
        try:
            run_id = str(payload["run_id"])
            message_id = str(payload["message_id"])
            attempt = int(payload["attempt"])
        except (KeyError, TypeError, ValueError):
            return None
        marker_key = message_end_key(
            conversation_id, run_id, message_id, attempt
        )
        try:
            event = sanitize_agent_data(
                {**payload, "type": "message_end"}, secrets=secrets
            )
            event_id = await self.redis.eval(
                _CLOSE_MESSAGE_SCRIPT,
                3,
                conversation_stream_key(conversation_id),
                conversation_sequence_key(conversation_id),
                marker_key,
                json.dumps(event, ensure_ascii=False, separators=(",", ":")),
                datetime.now(UTC).isoformat(),
                STREAM_MAX_LENGTH,
                STREAM_TTL_SECONDS,
            )
        except Exception:
            return None
        return str(event_id) if event_id else None

    async def latest_id(self, conversation_id: str) -> str | None:
        try:
            rows = await self.redis.xrevrange(
                conversation_stream_key(conversation_id), count=1
            )
        except Exception:
            return None
        return str(rows[0][0]) if rows else "0-0"

    async def active_turn(self, conversation_id: str, run_id: str) -> int | None:
        try:
            rows = await self.redis.xrevrange(
                conversation_stream_key(conversation_id), count=STREAM_MAX_LENGTH
            )
        except Exception:
            return None
        closed_rounds: set[int] = set()
        for _, fields in rows:
            try:
                data = json.loads(fields["data"])
                if not isinstance(data, dict) or str(data.get("run_id")) != run_id:
                    continue
                event_type = str(fields.get("event") or data.get("type") or "")
                round_number = int(data["round"])
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
            if event_type == "turn_end":
                closed_rounds.add(round_number)
            elif event_type == "turn_start" and round_number not in closed_rounds:
                return round_number
        return None

    async def active_message(
        self,
        conversation_id: str,
        run_id: str,
        *,
        round_number: int | None = None,
    ) -> dict[str, Any] | None:
        try:
            rows = await self.redis.xrevrange(
                conversation_stream_key(conversation_id), count=STREAM_MAX_LENGTH
            )
        except Exception:
            return None
        closed_messages: set[tuple[str, int]] = set()
        for _, fields in rows:
            try:
                data = json.loads(fields["data"])
                if not isinstance(data, dict) or str(data.get("run_id")) != run_id:
                    continue
                event_type = str(fields.get("event") or data.get("type") or "")
                message_id = str(data["message_id"])
                attempt = int(data["attempt"])
                event_round = (
                    int(data["round"]) if data.get("round") is not None else None
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
            if round_number is not None and event_round != round_number:
                continue
            identity = (message_id, attempt)
            if event_type == "message_end":
                closed_messages.add(identity)
                continue
            if event_type != "message_start" or identity in closed_messages:
                continue
            message = {
                "message_id": message_id,
                "attempt": attempt,
            }
            for key in ("round", "part_id", "phase"):
                if key in data:
                    message[key] = data[key]
            return message
        return None

    async def read(
        self,
        conversation_id: str,
        after_id: str,
        *,
        block_ms: int = 750,
        count: int = 100,
    ) -> list[dict[str, Any]] | None:
        try:
            streams = await self.redis.xread(
                {conversation_stream_key(conversation_id): after_id},
                count=count,
                block=block_ms,
            )
        except Exception:
            return None
        events: list[dict[str, Any]] = []
        for _, rows in streams:
            for event_id, fields in rows:
                try:
                    data = json.loads(fields["data"])
                    if not isinstance(data, dict):
                        continue
                    events.append({
                        "id": str(event_id),
                        "event": str(
                            fields.get("event") or data.get("type") or "message"
                        ),
                        "data": data,
                    })
                except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                    continue
        return events


def build_agent_event_store() -> AgentEventStore:
    return AgentEventStore()
