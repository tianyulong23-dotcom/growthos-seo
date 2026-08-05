import asyncio
import json
from typing import Any

from app.modules.agent.events import (
    STREAM_MAX_LENGTH,
    STREAM_TTL_SECONDS,
    AgentEventStore,
    conversation_sequence_key,
    conversation_stream_key,
    message_end_key,
)


class FakeRedis:
    def __init__(self) -> None:
        self.sequence = 0
        self.rows: list[tuple[str, dict[str, str]]] = []
        self.expired: list[tuple[str, int]] = []
        self.xadd_options: dict[str, Any] = {}
        self.values: dict[str, str] = {}

    async def incr(self, key: str) -> int:
        self.sequence += 1
        return self.sequence

    async def xadd(
        self, key: str, fields: dict[str, str], **options: Any
    ) -> str:
        event_id = f"{len(self.rows) + 1}-0"
        self.rows.append((event_id, fields))
        self.xadd_options = {"key": key, **options}
        return event_id

    async def expire(self, key: str, seconds: int) -> None:
        self.expired.append((key, seconds))

    async def eval(self, script: str, key_count: int, *args: Any) -> str | None:
        stream_key, sequence_key, marker_key = map(str, args[:3])
        if marker_key in self.values:
            return None
        event = json.loads(str(args[3]))
        self.sequence += 1
        event["sequence"] = self.sequence
        event["created_at"] = str(args[4])
        event_id = f"{len(self.rows) + 1}-0"
        self.rows.append((event_id, {
            "event": "message_end",
            "data": json.dumps(event, ensure_ascii=False, separators=(",", ":")),
        }))
        self.values[marker_key] = "1"
        ttl = int(args[6])
        self.expired.extend([(stream_key, ttl), (sequence_key, ttl)])
        return event_id

    async def xrevrange(self, key: str, count: int) -> list[Any]:
        return self.rows[-count:][::-1]

    async def xread(
        self, streams: dict[str, str], count: int, block: int
    ) -> list[Any]:
        after_id = next(iter(streams.values()))
        rows = [row for row in self.rows if row[0] > after_id][:count]
        return [(next(iter(streams)), rows)] if rows else []


def test_event_store_publishes_sanitized_sequenced_replayable_events() -> None:
    redis = FakeRedis()
    store = AgentEventStore(redis)

    event_id = asyncio.run(store.publish(
        "conversation-1",
        "text_delta",
        {"delta": "api_key=secret-value", "run_id": "run-1"},
        secrets=("secret-value",),
    ))
    events = asyncio.run(store.read("conversation-1", "0-0", block_ms=1))

    assert event_id == "1-0"
    assert events is not None
    assert events[0]["id"] == "1-0"
    assert events[0]["event"] == "text_delta"
    assert events[0]["data"]["sequence"] == 1
    assert events[0]["data"]["delta"] == "api_key=[REDACTED]"
    assert redis.xadd_options == {
        "key": conversation_stream_key("conversation-1"),
        "maxlen": STREAM_MAX_LENGTH,
        "approximate": True,
    }
    assert redis.expired == [
        (conversation_stream_key("conversation-1"), STREAM_TTL_SECONDS),
        (conversation_sequence_key("conversation-1"), STREAM_TTL_SECONDS),
    ]


def test_event_store_replays_only_events_after_redis_id() -> None:
    redis = FakeRedis()
    store = AgentEventStore(redis)
    asyncio.run(store.publish("conversation-1", "message_start", {"value": 1}))
    asyncio.run(store.publish("conversation-1", "text_delta", {"value": 2}))

    events = asyncio.run(store.read("conversation-1", "1-0", block_ms=1))

    assert events is not None
    assert [event["id"] for event in events] == ["2-0"]
    assert asyncio.run(store.latest_id("conversation-1")) == "2-0"


def test_event_store_closes_each_message_attempt_only_once() -> None:
    redis = FakeRedis()
    store = AgentEventStore(redis)
    payload = {
        "run_id": "run-1",
        "message_id": "message-1",
        "attempt": 0,
        "status": "completed",
    }

    first = asyncio.run(store.close_message("conversation-1", payload))
    duplicate = asyncio.run(store.close_message(
        "conversation-1", {**payload, "status": "cancelled"}
    ))
    next_attempt = asyncio.run(store.close_message(
        "conversation-1", {**payload, "attempt": 1, "status": "completed"}
    ))

    assert first == "1-0"
    assert duplicate is None
    assert next_attempt == "2-0"
    assert [json.loads(fields["data"])["status"] for _, fields in redis.rows] == [
        "completed", "completed",
    ]
    assert message_end_key(
        "conversation-1", "run-1", "message-1", 0
    ) in redis.values


def test_event_store_releases_message_end_claim_when_publish_fails() -> None:
    class PublishFailingRedis(FakeRedis):
        async def eval(
            self, script: str, key_count: int, *args: Any
        ) -> str:
            raise ConnectionError("redis unavailable")

    redis = PublishFailingRedis()
    store = AgentEventStore(redis)
    payload = {"run_id": "run-1", "message_id": "message-1", "attempt": 0}

    assert asyncio.run(store.close_message("conversation-1", payload)) is None
    assert message_end_key(
        "conversation-1", "run-1", "message-1", 0
    ) not in redis.values


def test_event_store_finds_only_an_unclosed_turn_for_the_same_run() -> None:
    redis = FakeRedis()
    store = AgentEventStore(redis)
    asyncio.run(store.publish(
        "conversation-1", "turn_start", {"run_id": "run-old", "round": 9}
    ))
    asyncio.run(store.publish(
        "conversation-1", "turn_start", {"run_id": "run-1", "round": 1}
    ))
    asyncio.run(store.publish(
        "conversation-1", "turn_end", {"run_id": "run-1", "round": 1}
    ))
    asyncio.run(store.publish(
        "conversation-1", "turn_start", {"run_id": "run-1", "round": 2}
    ))

    assert asyncio.run(store.active_turn("conversation-1", "run-1")) == 2

    asyncio.run(store.publish(
        "conversation-1", "turn_end", {"run_id": "run-1", "round": 2}
    ))
    assert asyncio.run(store.active_turn("conversation-1", "run-1")) is None


def test_event_store_finds_newest_unclosed_message_for_same_run_and_attempt() -> None:
    redis = FakeRedis()
    store = AgentEventStore(redis)
    asyncio.run(store.publish(
        "conversation-1",
        "message_start",
        {
            "run_id": "run-other", "round": 9, "message_id": "other",
            "part_id": "other:assistant", "phase": "decision", "attempt": 0,
        },
    ))
    asyncio.run(store.publish(
        "conversation-1",
        "message_start",
        {
            "run_id": "run-1", "round": 1, "message_id": "decision",
            "part_id": "decision:assistant", "phase": "decision", "attempt": 0,
        },
    ))
    asyncio.run(store.publish(
        "conversation-1",
        "message_end",
        {
            "run_id": "run-1", "round": 1, "message_id": "decision",
            "part_id": "decision:assistant", "phase": "decision", "attempt": 0,
            "status": "invalid",
        },
    ))
    asyncio.run(store.publish(
        "conversation-1",
        "message_start",
        {
            "run_id": "run-1", "round": 1, "message_id": "decision",
            "part_id": "decision:assistant", "phase": "decision", "attempt": 1,
        },
    ))

    assert asyncio.run(store.active_message("conversation-1", "run-1")) == {
        "round": 1,
        "message_id": "decision",
        "part_id": "decision:assistant",
        "phase": "decision",
        "attempt": 1,
    }


def test_event_store_filters_active_message_by_round_and_ignores_bad_rows() -> None:
    redis = FakeRedis()
    store = AgentEventStore(redis)
    redis.rows.append(("1-0", {"event": "message_start", "data": "not-json"}))
    asyncio.run(store.publish(
        "conversation-1",
        "message_start",
        {
            "run_id": "run-1", "round": 1, "message_id": "round-1",
            "part_id": "round-1:assistant", "phase": "decision", "attempt": 0,
        },
    ))
    asyncio.run(store.publish(
        "conversation-1",
        "message_start",
        {
            "run_id": "run-1", "round": 2, "message_id": "round-2",
            "part_id": "round-2:assistant", "phase": "decision", "attempt": 0,
        },
    ))

    active = asyncio.run(store.active_message(
        "conversation-1", "run-1", round_number=1
    ))

    assert active is not None
    assert active["message_id"] == "round-1"
    assert asyncio.run(store.active_message(
        "conversation-1", "run-1", round_number=3
    )) is None


def test_event_store_ignores_malformed_rows() -> None:
    redis = FakeRedis()
    redis.rows = [
        ("1-0", {"event": "text_delta", "data": "not-json"}),
        ("2-0", {"event": "text_delta", "data": json.dumps(["not-object"])}),
    ]

    assert asyncio.run(AgentEventStore(redis).read("conversation-1", "0-0")) == []


def test_event_store_failure_never_breaks_agent_execution() -> None:
    class FailingRedis:
        def __getattr__(self, name: str) -> Any:
            async def fail(*args: Any, **kwargs: Any) -> Any:
                raise ConnectionError("redis unavailable")
            return fail

    store = AgentEventStore(FailingRedis())

    assert asyncio.run(store.publish("conversation-1", "text_delta", {})) is None
    assert asyncio.run(store.read("conversation-1", "0-0")) is None
    assert asyncio.run(store.latest_id("conversation-1")) is None
    assert asyncio.run(store.active_turn("conversation-1", "run-1")) is None
    assert asyncio.run(store.active_message("conversation-1", "run-1")) is None
