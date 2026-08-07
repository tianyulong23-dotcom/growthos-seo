import asyncio
import json

import httpx
import pytest

from seo_workers.keywords.providers import (
    RETRYABLE_FAILURE,
    DataForSEOClient,
    DataForSEOProviderConfig,
    JsonHttpClient,
    RelatedKeywordSeed,
)


async def content_plan_client(
    handler: httpx.MockTransport,
) -> tuple[DataForSEOClient, JsonHttpClient]:
    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=handler)
    return (
        DataForSEOClient(
            DataForSEOProviderConfig(login="api-login", password="api-password"),
            http,
        ),
        http,
    )


def related_keywords_response(
    *,
    tag: str,
    task_id: str,
    keyword: str,
    cost: float,
    status_code: int = 20000,
    status_message: str = "Ok.",
) -> dict:
    result = (
        [
            {
                "items": [
                    {
                        "keyword_data": {
                            "keyword": f"{keyword} guide",
                            "keyword_info": {"search_volume": 120},
                            "keyword_properties": {"keyword_difficulty": 21},
                            "search_intent_info": {"main_intent": "informational"},
                        }
                    }
                ]
            }
        ]
        if status_code == 20000
        else None
    )
    return {
        "status_code": 20000,
        "status_message": "Ok.",
        "tasks": [
            {
                "id": task_id,
                "status_code": status_code,
                "status_message": status_message,
                "cost": cost,
                "path": [
                    "v3",
                    "dataforseo_labs",
                    "google",
                    "related_keywords",
                    "live",
                ],
                "data": {"tag": tag, "keyword": keyword},
                "result": result,
            }
        ],
    }


@pytest.mark.anyio
async def test_related_keywords_batch_uses_one_task_per_http_request() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        task = json.loads(request.content)[0]
        return httpx.Response(
            200,
            json=related_keywords_response(
                tag=task["tag"],
                task_id=f"provider-{task['tag']}",
                keyword=task["keyword"],
                cost=0.011,
            ),
        )

    client, http = await content_plan_client(httpx.MockTransport(handler))
    seeds = [
        RelatedKeywordSeed(
            request_index=index,
            seed_keyword_id=f"seed-{index}",
            keyword=f"topic {index}",
            tag=f"content-plan:batch-1:{index}",
        )
        for index in range(1, 31)
    ]
    try:
        results = await client.related_keywords_batch(
            seeds=seeds,
            country="US",
            language="en",
            max_concurrency=4,
        )
    finally:
        await http.close()

    assert len(requests) == 30
    assert len(results) == 30
    assert [result.request_index for result in results] == list(range(1, 31))
    assert sum(result.cost_usd for result in results) == pytest.approx(0.33)
    for request, seed, result in zip(requests, seeds, results, strict=True):
        body = json.loads(request.content)
        assert len(body) == 1
        assert body[0] == {
            "keyword": seed.keyword,
            "location_name": "United States",
            "language_code": "en",
            "limit": 100,
            "include_seed_keyword": True,
            "include_serp_info": False,
            "tag": seed.tag,
        }
        assert request.url.path.endswith(
            "/dataforseo_labs/google/related_keywords/live"
        )
        assert result.seed_keyword_id == seed.seed_keyword_id
        assert result.tag == seed.tag
        assert result.status == "completed"
        assert result.provider_request_id == f"provider-{seed.tag}"
        assert result.rows[0].keyword == f"{seed.keyword} guide"


@pytest.mark.anyio
async def test_related_keywords_batch_isolates_empty_and_failed_tasks() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        task = json.loads(request.content)[0]
        if task["keyword"] == "network failure":
            raise httpx.ConnectError("connection refused", request=request)
        if task["keyword"] == "empty topic":
            return httpx.Response(
                200,
                json=related_keywords_response(
                    tag=task["tag"],
                    task_id="provider-empty",
                    keyword=task["keyword"],
                    cost=0.02,
                    status_code=40501,
                    status_message="No Search Results.",
                ),
            )
        return httpx.Response(
            200,
            json=related_keywords_response(
                tag=task["tag"],
                task_id="provider-success",
                keyword=task["keyword"],
                cost=0.01,
            ),
        )

    client, http = await content_plan_client(httpx.MockTransport(handler))
    try:
        results = await client.related_keywords_batch(
            seeds=[
                RelatedKeywordSeed(1, "seed-1", "valid topic", "tag-1"),
                RelatedKeywordSeed(2, "seed-2", "empty topic", "tag-2"),
                RelatedKeywordSeed(3, "seed-3", "network failure", "tag-3"),
            ],
            country="US",
            language="en",
            max_concurrency=2,
        )
    finally:
        await http.close()

    assert [result.status for result in results] == [
        "completed",
        "completed",
        RETRYABLE_FAILURE,
    ]
    assert len(results[0].rows) == 1
    assert results[1].rows == ()
    assert results[1].cost_usd == 0.02
    assert results[1].provider_request_id == "provider-empty"
    assert results[2].rows == ()
    assert results[2].error_code == "network_error"
    assert results[2].cost_usd == 0


@pytest.mark.anyio
async def test_related_keywords_batch_enforces_the_concurrency_limit() -> None:
    active = 0
    maximum_active = 0
    lock = asyncio.Lock()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, maximum_active
        task = json.loads(request.content)[0]
        async with lock:
            active += 1
            maximum_active = max(maximum_active, active)
        await asyncio.sleep(0.01)
        async with lock:
            active -= 1
        return httpx.Response(
            200,
            json=related_keywords_response(
                tag=task["tag"],
                task_id=f"provider-{task['tag']}",
                keyword=task["keyword"],
                cost=0.01,
            ),
        )

    client, http = await content_plan_client(httpx.MockTransport(handler))
    try:
        await client.related_keywords_batch(
            seeds=[
                RelatedKeywordSeed(index, f"seed-{index}", f"topic {index}", f"tag-{index}")
                for index in range(1, 11)
            ],
            country="US",
            language="en",
            max_concurrency=3,
        )
    finally:
        await http.close()

    assert maximum_active == 3


@pytest.mark.anyio
async def test_related_keywords_batch_rejects_invalid_seed_contracts() -> None:
    client, http = await content_plan_client(
        httpx.MockTransport(lambda _request: httpx.Response(500))
    )
    try:
        with pytest.raises(ValueError, match="最多接受 30"):
            await client.related_keywords_batch(
                seeds=[
                    RelatedKeywordSeed(index, f"seed-{index}", f"topic {index}", f"tag-{index}")
                    for index in range(1, 32)
                ],
                country="US",
                language="en",
            )
        with pytest.raises(ValueError, match="tag 必须唯一"):
            await client.related_keywords_batch(
                seeds=[
                    RelatedKeywordSeed(1, "seed-1", "topic 1", "same-tag"),
                    RelatedKeywordSeed(2, "seed-2", "topic 2", "same-tag"),
                ],
                country="US",
                language="en",
            )
    finally:
        await http.close()
