import asyncio
import base64
import io
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

from app.modules.content.image_gateway import (
    AIImageProvider,
    ChartProvider,
    ImageProviderError,
    ImageRequest,
    ImageResult,
    PexelsStockProvider,
    ProjectAssetProvider,
    ScreenshotProvider,
    choose_visual_strategy,
    image_provider_for,
    visual_strategy_chain,
)
from app.modules.content import visual_generation
from app.modules.content.models import ContentAsset
from app.modules.content.object_storage import StoredTextNotFoundError
from app.modules.content.visual_generation import (
    ResolvedVisual,
    register_image_result,
    resolve_visuals,
    wait_for_ready_asset,
)
from app.modules.content.writing_gateway import (
    ArticlePlan,
    ChartDataPoint,
    EvidenceClaim,
    OutlineSection,
    VisualPlanItem,
)
from app.core.config import Settings


def visual(
    *,
    visual_id: str = "visual-1",
    strategy: str = "project_asset",
    title: str = "Solar battery installation",
) -> VisualPlanItem:
    return VisualPlanItem(
        visual_id=visual_id,
        section_id="section-1",
        reader_job="demonstrate",
        source_strategy=strategy,
        title=title,
        alt_instruction="Show the solar battery installation clearly",
    )


def request(item: VisualPlanItem) -> ImageRequest:
    return ImageRequest(
        run_id="run-1",
        project_id="project-1",
        visual=item,
        section_heading="How solar battery installation works",
        idempotency_key=f"key:{item.visual_id}",
    )


def png_bytes(width: int = 32, height: int = 18) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (width, height), "#176b5b").save(output, format="PNG")
    return output.getvalue()


def asset(
    asset_id: str,
    *,
    title: str | None,
    filename: str,
    alt_text: str | None = None,
    caption: str | None = None,
    description: str | None = None,
) -> ContentAsset:
    return ContentAsset(
        id=asset_id,
        project_id="project-1",
        asset_type="image",
        status="ready",
        original_filename=filename,
        title=title,
        default_alt_text=alt_text if alt_text is not None else f"Alt for {title}",
        caption=caption,
        description=description,
        mime_type="image/jpeg",
        detected_mime_type="image/jpeg",
        width=1600,
        height=900,
        source_type="upload",
        created_by="user-1",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )


def test_project_asset_provider_selects_relevant_image_instead_of_random_image() -> None:
    class Repository:
        async def list_ready_images(self, project_id: str, limit: int):
            assert project_id == "project-1"
            assert limit == 100
            return [
                asset("asset-unrelated", title="Office team portrait", filename="team.jpg"),
                asset(
                    "asset-solar",
                    title="Solar battery installation",
                    filename="solar-battery-installation.jpg",
                ),
            ]

    result = asyncio.run(ProjectAssetProvider(Repository()).acquire(request(visual())))  # type: ignore[arg-type]

    assert result.asset_id == "asset-solar"
    assert result.alt_text == "Alt for Solar battery installation"
    assert (result.width, result.height) == (1600, 900)


def test_project_asset_provider_omits_unrelated_images() -> None:
    class Repository:
        async def list_ready_images(self, project_id: str, limit: int):
            del project_id, limit
            return [asset("asset-team", title="Office team portrait", filename="team.jpg")]

    with pytest.raises(ImageProviderError) as error:
        asyncio.run(ProjectAssetProvider(Repository()).acquire(request(visual())))  # type: ignore[arg-type]

    assert error.value.code == "project_asset_not_relevant"


def test_project_asset_provider_uses_real_metadata_for_alt_and_rejects_missing_alt() -> None:
    class Repository:
        def __init__(self, item: ContentAsset) -> None:
            self.item = item

        async def list_ready_images(self, project_id: str, limit: int):
            del project_id, limit
            return [self.item]

    titled = asset(
        "asset-titled",
        title="Solar battery installation",
        filename="solar-battery.jpg",
        alt_text="",
    )
    result = asyncio.run(ProjectAssetProvider(Repository(titled)).acquire(request(visual())))  # type: ignore[arg-type]
    assert result.alt_text == "Solar battery installation"
    assert result.alt_source == "title"

    missing = asset(
        "asset-missing",
        title=None,
        filename="solar-battery.jpg",
        alt_text="",
    )
    with pytest.raises(ImageProviderError) as error:
        asyncio.run(ProjectAssetProvider(Repository(missing)).acquire(request(visual())))  # type: ignore[arg-type]
    assert error.value.code == "image_alt_missing"


@pytest.mark.parametrize("strategy", ["screenshot", "stock", "ai"])
def test_unconfigured_external_provider_reports_explicit_failure(strategy: str) -> None:
    provider = image_provider_for(
        strategy,
        asset_repository=SimpleNamespace(),
        settings=Settings(),
    )

    with pytest.raises(ImageProviderError) as error:
        asyncio.run(provider.acquire(request(visual(strategy=strategy))))

    assert error.value.code == "provider_unconfigured"


def test_chart_provider_renders_only_values_traceable_to_claims() -> None:
    item = visual(strategy="chart", title="Measured results").model_copy(
        update={
            "reader_job": "compare",
            "data_claim_ids": ["claim-1"],
            "chart_data": [
                ChartDataPoint(
                    label="Measured result",
                    value="42",
                    unit=" units",
                    claim_id="claim-1",
                )
            ],
        }
    )
    image_request = request(item).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="The measured result is 42 units.",
                    source_url="https://source.example/result",
                    source_title="Measurement report",
                    quote="The measured result is 42 units.",
                )
            ]
        }
    )

    result = asyncio.run(ChartProvider().acquire(image_request))

    assert result.provider == "chart"
    assert result.mime_type == "image/png"
    assert result.content is not None and result.content.startswith(b"\x89PNG")
    assert (result.width, result.height) == (1600, 900)
    assert result.alt_source == "verified_chart_data"
    assert "42 units" in result.alt_text
    assert result.source_url == "https://source.example/result"
    assert result.caption == "Sources: Measurement report"


def test_chart_provider_keeps_long_text_inside_canvas_and_contrasts_max_value() -> None:
    item = visual(
        strategy="chart",
        title="A very long chart title " * 10,
    ).model_copy(
        update={
            "reader_job": "compare",
            "data_claim_ids": ["claim-1", "claim-2"],
            "chart_data": [
                ChartDataPoint(
                    label="A very long category label " * 4,
                    value="29.97",
                    unit=" fps",
                    claim_id="claim-1",
                ),
                ChartDataPoint(
                    label="Maximum result",
                    value="59.94",
                    unit=" fps",
                    claim_id="claim-2",
                ),
            ],
        }
    )
    image_request = request(item).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="The first frame rate is 29.97 fps.",
                    source_url="https://source.example/result",
                    quote="29.97 fps",
                ),
                EvidenceClaim(
                    claim_id="claim-2",
                    claim="The maximum frame rate is 59.94 fps.",
                    source_url="https://source.example/result",
                    quote="59.94 fps",
                ),
            ]
        }
    )

    result = asyncio.run(ChartProvider().acquire(image_request))

    assert result.content is not None
    with Image.open(io.BytesIO(result.content)) as image:
        rgb = image.convert("RGB")
        # The maximum bar reaches x=1520. Its value must be rendered inside in white.
        max_value_region = rgb.crop((1300, 645, 1510, 670))
        assert any(
            red > 220 and green > 220 and blue > 220
            for _, (red, green, blue) in (
                max_value_region.getcolors(maxcolors=max_value_region.width * max_value_region.height)
                or []
            )
        )


def test_chart_provider_rejects_numbers_not_present_in_cited_claim() -> None:
    item = visual(strategy="chart").model_copy(
        update={
            "reader_job": "compare",
            "data_claim_ids": ["claim-1"],
            "chart_data": [
                ChartDataPoint(label="Result", value="99", claim_id="claim-1")
            ],
        }
    )
    image_request = request(item).model_copy(
        update={
            "claims": [
                EvidenceClaim(
                    claim_id="claim-1",
                    claim="The measured result is 42 units.",
                    source_url="https://source.example/result",
                )
            ]
        }
    )

    with pytest.raises(ImageProviderError) as error:
        asyncio.run(ChartProvider().acquire(image_request))

    assert error.value.code == "chart_data_unverified"


def test_screenshot_provider_sends_exact_url_and_records_capture_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = png_bytes(160, 90)
    calls = []

    async def fake_request(method: str, url: str, **kwargs: object) -> httpx.Response:
        calls.append((method, url, kwargs))
        return httpx.Response(200, content=content, headers={"content-type": "image/png"})

    monkeypatch.setattr("app.modules.content.image_gateway._request", fake_request)
    item = visual(strategy="screenshot").model_copy(
        update={"target_url": "https://example.com/product", "aspect_ratio": "16:9"}
    )
    provider = ScreenshotProvider(
        Settings(
            article_screenshot_service_url="https://capture.example/screenshot",
            article_screenshot_api_key="secret",
        )
    )

    result = asyncio.run(provider.acquire(request(item)))

    assert (result.width, result.height) == (160, 90)
    assert result.source_url == "https://example.com/product"
    assert result.captured_at
    assert (result.viewport_width, result.viewport_height) == (1600, 900)
    method, url, kwargs = calls[0]
    assert (method, url) == ("POST", "https://capture.example/screenshot")
    assert kwargs["json"] == {
        "url": "https://example.com/product",
        "viewport": {"width": 1600, "height": 900},
        "full_page": True,
        "format": "png",
    }
    assert kwargs["headers"]["Authorization"] == "Bearer secret"


@pytest.mark.parametrize(
    "target_url",
    ["http://localhost/admin", "http://127.0.0.1/private", "http://10.0.0.2/"],
)
def test_screenshot_provider_rejects_non_public_targets(target_url: str) -> None:
    item = visual(strategy="screenshot").model_copy(update={"target_url": target_url})
    provider = ScreenshotProvider(
        Settings(article_screenshot_service_url="https://capture.example/screenshot")
    )

    with pytest.raises(ImageProviderError) as error:
        asyncio.run(provider.acquire(request(item)))

    assert error.value.code == "screenshot_url_forbidden"


def test_pexels_provider_preserves_license_creator_and_attribution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    async def fake_request(method: str, url: str, **kwargs: object) -> httpx.Response:
        calls.append((method, url, kwargs))
        return httpx.Response(
            200,
            json={
                "photos": [
                    {
                        "alt": "Solar panels and a home battery",
                        "photographer": "Example Creator",
                        "url": "https://www.pexels.com/photo/123/",
                        "src": {"large2x": "https://images.pexels.com/photos/123.jpeg"},
                    }
                ]
            },
        )

    monkeypatch.setattr("app.modules.content.image_gateway._request", fake_request)
    provider = PexelsStockProvider(
        Settings(article_stock_api_key="pexels-key", article_stock_provider="pexels")
    )

    result = asyncio.run(provider.acquire(request(visual(strategy="stock"))))

    assert result.source_url == "https://images.pexels.com/photos/123.jpeg"
    assert result.license_name == "Pexels License"
    assert result.creator_name == "Example Creator"
    assert result.attribution_url == "https://www.pexels.com/photo/123/"
    assert result.caption == "Photo by Example Creator on Pexels."
    assert calls[0][2]["params"] == {
        "query": "Solar battery installation",
        "per_page": 5,
        "orientation": "landscape",
    }


def test_pexels_provider_rejects_incomplete_attribution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_request(*_args: object, **_kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "photos": [
                    {
                        "alt": "Solar battery",
                        "photographer": "",
                        "url": "",
                        "src": {"large": "https://images.pexels.com/photos/123.jpeg"},
                    }
                ]
            },
        )

    monkeypatch.setattr("app.modules.content.image_gateway._request", fake_request)
    provider = PexelsStockProvider(Settings(article_stock_api_key="pexels-key"))

    with pytest.raises(ImageProviderError) as error:
        asyncio.run(provider.acquire(request(visual(strategy="stock"))))

    assert error.value.code == "stock_license_missing"


def test_ai_image_provider_records_generation_metadata_and_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = png_bytes(64, 64)
    calls = []

    async def fake_request(method: str, url: str, **kwargs: object) -> httpx.Response:
        calls.append((method, url, kwargs))
        return httpx.Response(
            200,
            json={
                "id": "image-request-1",
                "model": "image-model-v1",
                "data": [
                    {
                        "b64_json": base64.b64encode(content).decode("ascii"),
                        "revised_prompt": "A labeled solar battery layout",
                    }
                ],
            },
        )

    monkeypatch.setattr("app.modules.content.image_gateway._request", fake_request)
    item = visual(strategy="ai").model_copy(
        update={"prompt": "Draw a clear solar battery layout", "aspect_ratio": "1:1"}
    )
    provider = AIImageProvider(
        Settings(
            article_ai_image_base_url="https://images.example/v1",
            article_ai_image_api_key="image-key",
            article_ai_image_model="image-model-v1",
            article_ai_image_cost_usd=0.04,
        )
    )

    result = asyncio.run(provider.acquire(request(item)))

    assert result.content == content
    assert (result.width, result.height) == (64, 64)
    assert result.generation_request_id == "image-request-1"
    assert result.generation_prompt == "Draw a clear solar battery layout"
    assert result.model_name == "image-model-v1"
    assert str(result.cost_usd) == "0.04"
    assert result.alt_text == "A labeled solar battery layout"
    assert calls[0][1] == "https://images.example/v1/images/generations"
    assert calls[0][2]["json"]["size"] == "1024x1024"


def test_choose_visual_strategy_enforces_real_evidence_and_prefers_project_assets() -> None:
    project_visual = visual(strategy="ai")
    chart_visual = visual(strategy="stock").model_copy(
        update={
            "reader_job": "compare",
            "data_claim_ids": ["claim-1"],
            "chart_data": [
                ChartDataPoint(label="Result", value="42", claim_id="claim-1")
            ],
        }
    )
    proof_visual = visual(strategy="ai").model_copy(update={"reader_job": "prove"})

    assert choose_visual_strategy(
        project_visual, has_relevant_project_asset=True
    ) == "project_asset"
    assert choose_visual_strategy(
        chart_visual, has_relevant_project_asset=True
    ) == "chart"
    assert choose_visual_strategy(
        proof_visual, has_relevant_project_asset=False
    ) == "screenshot"


def test_visual_strategy_chain_falls_back_only_for_non_evidence_images() -> None:
    illustrative = visual(strategy="stock").model_copy(update={"reader_job": "explain"})
    proof = visual(strategy="stock").model_copy(update={"reader_job": "prove"})
    product = visual(strategy="project_asset").model_copy(
        update={"target_url": "https://example.com/product"}
    )

    assert visual_strategy_chain(
        illustrative, has_relevant_project_asset=False
    ) == ["stock", "ai"]
    assert visual_strategy_chain(proof, has_relevant_project_asset=False) == [
        "screenshot"
    ]
    assert visual_strategy_chain(product, has_relevant_project_asset=False) == [
        "project_asset",
        "screenshot",
    ]


def test_register_image_result_uses_asset_service_for_url_and_bytes() -> None:
    class Service:
        def __init__(self) -> None:
            self.imports = []
            self.ingests = []
            self.metadata_updates = []
            self.provider_metadata_updates = []

        async def import_url(self, **kwargs):
            self.imports.append(kwargs)
            return SimpleNamespace(asset_id="asset-url")

        async def ingest_bytes(self, **kwargs):
            self.ingests.append(kwargs)
            return SimpleNamespace(asset_id="asset-bytes")

        async def update_metadata(self, **kwargs):
            self.metadata_updates.append(kwargs)

        async def update_provider_metadata(self, **kwargs):
            self.provider_metadata_updates.append(kwargs)

    async def scenario() -> None:
        service = Service()
        item_request = request(visual())
        url_id = await register_image_result(
            ImageResult(
                visual_id="visual-1",
                provider="stock",
                source_url="https://images.example/solar.jpg",
                filename="solar.jpg",
                alt_text="Installed solar battery",
                alt_source="provider_metadata",
            ),
            request=item_request,
            asset_service=service,  # type: ignore[arg-type]
        )
        bytes_id = await register_image_result(
            ImageResult(
                visual_id="visual-1",
                provider="ai",
                source_url="https://source.example/evidence-page",
                content=b"image-bytes",
                filename="solar.png",
                mime_type="image/png",
                alt_text="Solar battery layout",
                alt_source="provider_metadata",
            ),
            request=item_request,
            asset_service=service,  # type: ignore[arg-type]
        )

        assert url_id == "asset-url"
        assert bytes_id == "asset-bytes"
        assert len(service.imports) == 1
        assert service.imports[0]["request"].source_url == "https://images.example/solar.jpg"
        assert service.ingests[0]["content"] == b"image-bytes"
        assert service.ingests[0]["source_type"] == "ai"
        assert [item["request"].default_alt_text for item in service.metadata_updates] == [
            "Installed solar battery",
            "Solar battery layout",
        ]
        assert [
            item["provider_metadata"]["provider"]
            for item in service.provider_metadata_updates
        ] == ["stock", "ai"]
        assert service.provider_metadata_updates[1]["provider_metadata"]["source_url"] == (
            "https://source.example/evidence-page"
        )

    asyncio.run(scenario())


def test_wait_for_ready_asset_polls_until_processing_finishes() -> None:
    class Service:
        def __init__(self) -> None:
            self.statuses = ["processing", "processing", "ready"]

        async def get_asset(self, project_id: str, asset_id: str):
            assert (project_id, asset_id) == ("project-1", "asset-1")
            return SimpleNamespace(
                status=self.statuses.pop(0),
                failure_code=None,
                width=1200,
                height=675,
            )

    result = asyncio.run(
        wait_for_ready_asset(
            Service(),  # type: ignore[arg-type]
            project_id="project-1",
            asset_id="asset-1",
            timeout_seconds=0.1,
            poll_seconds=0.001,
        )
    )

    assert result.status == "ready"
    assert (result.width, result.height) == (1200, 675)


def test_wait_for_ready_asset_reports_failed_and_timed_out_processing() -> None:
    class Service:
        def __init__(self, status: str) -> None:
            self.status = status

        async def get_asset(self, project_id: str, asset_id: str):
            del project_id, asset_id
            return SimpleNamespace(
                status=self.status,
                failure_code="unsafe_image" if self.status == "quarantined" else None,
            )

    with pytest.raises(ImageProviderError) as failed:
        asyncio.run(
            wait_for_ready_asset(
                Service("quarantined"),  # type: ignore[arg-type]
                project_id="project-1",
                asset_id="asset-1",
                timeout_seconds=0,
            )
        )
    assert failed.value.code == "unsafe_image"

    with pytest.raises(ImageProviderError) as timed_out:
        asyncio.run(
            wait_for_ready_asset(
                Service("processing"),  # type: ignore[arg-type]
                project_id="project-1",
                asset_id="asset-1",
                timeout_seconds=0,
            )
        )
    assert timed_out.value.code == "image_processing_timeout"


def test_resolve_visuals_runs_concurrently_and_isolates_one_provider_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    article_plan = ArticlePlan(
        title="Solar battery guide",
        search_intent="Understand solar battery installation",
        article_type="guide",
        meta_title="Solar battery guide",
        meta_description="A practical solar battery guide.",
        slug="solar-battery-guide",
        sections=[
            OutlineSection(
                section_id=f"section-{index}",
                heading=f"Solar battery step {index}",
                objective=f"Explain step {index}.",
            )
            for index in range(1, 4)
        ],
        visuals=[
            VisualPlanItem(
                visual_id=f"visual-{index}",
                section_id=f"section-{index}",
                reader_job="demonstrate",
                source_strategy="project_asset" if index < 3 else "ai",
                title=f"Solar battery step {index}",
                alt_instruction=f"Solar battery step {index}",
            )
            for index in range(1, 4)
        ],
    )
    writes = []
    active = 0
    maximum_active = 0

    class Store:
        def __init__(self, _settings) -> None:
            pass

        async def read_json(self, ref: str):
            if ref == "planning-ref":
                return {"plan": article_plan.model_dump(mode="json")}
            raise StoredTextNotFoundError("object not found")

        async def write_json(self, key: str, value: dict):
            writes.append((key, value))
            return "resolved-ref"

    class Provider:
        name = "test-provider"

        async def acquire(self, image_request: ImageRequest) -> ImageResult:
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            if image_request.visual.visual_id == "visual-3":
                raise ImageProviderError("provider_timeout", "Timed out")
            return ImageResult(
                visual_id=image_request.visual.visual_id,
                provider=self.name,
                asset_id=f"asset-{image_request.visual.visual_id}",
                alt_text=image_request.visual.alt_instruction,
                alt_source="provider_metadata",
                width=1200,
                height=675,
            )

    class Repository:
        async def list_ready_images(self, project_id: str, limit: int):
            del project_id, limit
            return []

        async def find_import_by_idempotency(self, *args):
            del args
            return None

        async def find_ingested_by_idempotency(self, *args):
            del args
            return None

    monkeypatch.setattr(visual_generation, "S3ArtifactStore", Store)
    monkeypatch.setattr(
        visual_generation,
        "image_provider_for",
        lambda *_args, **_kwargs: Provider(),
    )
    result = asyncio.run(
        resolve_visuals(
            settings=SimpleNamespace(s3_bucket="test-bucket"),  # type: ignore[arg-type]
            context={
                "run_id": "run-1",
                "project_id": "project-1",
                "completed_steps": {"planning": {"output_ref": "planning-ref"}},
            },
            asset_repository=Repository(),  # type: ignore[arg-type]
            asset_service=SimpleNamespace(),  # type: ignore[arg-type]
            concurrency=3,
        )
    )

    assert maximum_active == 3
    assert result["summary"] == {
        "planned_count": 3,
        "ready_count": 2,
        "omitted_count": 1,
        "required_failed_count": 0,
    }
    resolved_write = next(value for key, value in writes if key.endswith("resolved.json.gz"))
    assert [item["status"] for item in resolved_write["visuals"]] == [
        "ready",
        "ready",
        "omitted",
    ]
    assert resolved_write["visuals"][2]["failure_code"] == "provider_timeout"
    assert resolved_write["visuals"][2]["attempts"] == 2
    assert any(key.endswith("visuals/plan.json.gz") for key, _ in writes)
    assert sum(key.endswith("result.json.gz") for key, _ in writes) == 3


def test_resolve_visuals_times_out_one_provider_without_blocking_another(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    article_plan = ArticlePlan(
        title="Solar battery guide",
        search_intent="Understand solar batteries",
        article_type="guide",
        meta_title="Solar battery guide",
        meta_description="A practical guide.",
        slug="solar-guide",
        sections=[
            OutlineSection(section_id="section-1", heading="First", objective="First"),
            OutlineSection(section_id="section-2", heading="Second", objective="Second"),
        ],
        visuals=[
            visual(visual_id="visual-slow", title="Slow image"),
            visual(visual_id="visual-fast", title="Fast image").model_copy(
                update={"section_id": "section-2"}
            ),
        ],
    )
    writes = []

    class Store:
        def __init__(self, _settings) -> None:
            pass

        async def read_json(self, ref: str):
            if ref == "planning-ref":
                return {"plan": article_plan.model_dump(mode="json")}
            raise StoredTextNotFoundError("object not found")

        async def write_json(self, key: str, value: dict):
            writes.append((key, value))
            return key

    class Provider:
        name = "project_asset"

        async def acquire(self, image_request: ImageRequest) -> ImageResult:
            if image_request.visual.visual_id == "visual-slow":
                await asyncio.sleep(0.2)
            return ImageResult(
                visual_id=image_request.visual.visual_id,
                provider=self.name,
                asset_id=f"asset-{image_request.visual.visual_id}",
                alt_text=image_request.visual.title,
                alt_source="title",
                width=1200,
                height=675,
            )

    class Repository:
        async def list_ready_images(self, project_id: str, limit: int):
            del project_id, limit
            return []

        async def find_import_by_idempotency(self, *args):
            del args
            return None

        async def find_ingested_by_idempotency(self, *args):
            del args
            return None

    monkeypatch.setattr(visual_generation, "S3ArtifactStore", Store)
    monkeypatch.setattr(visual_generation, "image_provider_for", lambda *_a, **_k: Provider())
    result = asyncio.run(
        resolve_visuals(
            settings=SimpleNamespace(
                article_image_provider_timeout_seconds=0.01,
                article_image_processing_timeout_seconds=1,
                article_image_max_attempts=1,
                s3_bucket="test-bucket",
            ),  # type: ignore[arg-type]
            context={
                "run_id": "run-timeout",
                "project_id": "project-1",
                "completed_steps": {"planning": {"output_ref": "planning-ref"}},
            },
            asset_repository=Repository(),  # type: ignore[arg-type]
            asset_service=SimpleNamespace(),  # type: ignore[arg-type]
            concurrency=2,
        )
    )

    assert result["summary"]["ready_count"] == 1
    resolved_write = next(value for key, value in writes if key.endswith("resolved.json.gz"))
    by_id = {item["visual_id"]: item for item in resolved_write["visuals"]}
    assert by_id["visual-slow"]["failure_code"] == "provider_timeout"
    assert by_id["visual-fast"]["status"] == "ready"


def test_resolve_visuals_falls_back_from_stock_to_ai_and_updates_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    article_plan = ArticlePlan(
        title="Solar battery guide",
        search_intent="Understand solar batteries",
        article_type="guide",
        meta_title="Solar battery guide",
        meta_description="A practical guide.",
        slug="solar-guide",
        sections=[OutlineSection(section_id="section-1", heading="First", objective="First")],
        visuals=[
            visual(strategy="stock").model_copy(update={"reader_job": "explain"})
        ],
    )
    writes = []
    provider_calls = []

    class Store:
        def __init__(self, _settings) -> None:
            pass

        async def read_json(self, ref: str):
            if ref == "planning-ref":
                return {"plan": article_plan.model_dump(mode="json")}
            raise StoredTextNotFoundError("object not found")

        async def write_json(self, key: str, value: dict):
            writes.append((key, value))
            return key

    class Provider:
        def __init__(self, strategy: str) -> None:
            self.name = strategy

        async def acquire(self, image_request: ImageRequest) -> ImageResult:
            provider_calls.append(self.name)
            if self.name == "stock":
                raise ImageProviderError("stock_no_result", "No licensed image found")
            assert image_request.visual.source_strategy == "ai"
            return ImageResult(
                visual_id=image_request.visual.visual_id,
                provider="ai",
                asset_id="asset-ai",
                alt_text="Illustration of a residential solar battery system",
                alt_source="provider_metadata",
                width=1200,
                height=675,
            )

    class Repository:
        async def list_ready_images(self, project_id: str, limit: int):
            del project_id, limit
            return []

        async def find_import_by_idempotency(self, *args):
            del args
            return None

        async def find_ingested_by_idempotency(self, *args):
            del args
            return None

    monkeypatch.setattr(visual_generation, "S3ArtifactStore", Store)
    monkeypatch.setattr(
        visual_generation,
        "image_provider_for",
        lambda strategy, **_kwargs: Provider(strategy),
    )
    result = asyncio.run(
        resolve_visuals(
            settings=SimpleNamespace(
                article_image_max_attempts=1,
                s3_bucket="test-bucket",
            ),  # type: ignore[arg-type]
            context={
                "run_id": "run-fallback",
                "project_id": "project-1",
                "completed_steps": {"planning": {"output_ref": "planning-ref"}},
            },
            asset_repository=Repository(),  # type: ignore[arg-type]
            asset_service=SimpleNamespace(),  # type: ignore[arg-type]
        )
    )

    assert provider_calls == ["stock", "ai"]
    assert result["summary"]["ready_count"] == 1
    resolved = next(value for key, value in writes if key.endswith("resolved.json.gz"))
    item = resolved["visuals"][0]
    assert item["source_strategy"] == "ai"
    assert item["attempt_log"] == [
        {
            "provider": "stock",
            "attempt": 1,
            "status": "failed",
            "error_code": "stock_no_result",
            "elapsed_ms": item["attempt_log"][0]["elapsed_ms"],
        },
        {
            "provider": "ai",
            "attempt": 1,
            "status": "succeeded",
            "elapsed_ms": item["attempt_log"][1]["elapsed_ms"],
        },
    ]
    assert resolved["plan"]["visuals"][0]["source_strategy"] == "ai"


def test_find_idempotent_import_preserves_fallback_strategy() -> None:
    imported = SimpleNamespace(
        id="asset-ai-fallback",
        provider_metadata={"source_strategy": "ai"},
    )

    class Repository:
        async def find_import_by_idempotency(self, *args):
            del args
            return imported

        async def find_ingested_by_idempotency(self, *args):
            raise AssertionError(f"unexpected ingested lookup: {args}")

    found = asyncio.run(
        visual_generation._find_idempotent_asset(
            Repository(),  # type: ignore[arg-type]
            project_id="project-1",
            strategies=["stock", "ai"],
            idempotency_key="key-1",
        )
    )

    assert found == (imported, "ai")


def test_resolve_visuals_reuses_successful_artifact_without_calling_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    article_plan = ArticlePlan(
        title="Solar battery guide",
        search_intent="Understand solar batteries",
        article_type="guide",
        meta_title="Solar battery guide",
        meta_description="A practical guide.",
        slug="solar-guide",
        sections=[OutlineSection(section_id="section-1", heading="First", objective="First")],
        visuals=[visual()],
    )
    context = {
        "run_id": "run-cached",
        "project_id": "project-1",
        "completed_steps": {"planning": {"output_ref": "planning-ref"}},
    }
    cache_key = visual_generation._visual_idempotency_key(context, article_plan.visuals[0])
    writes = []
    provider_calls = 0

    class Store:
        def __init__(self, _settings) -> None:
            pass

        async def read_json(self, ref: str):
            if ref == "planning-ref":
                return {"plan": article_plan.model_dump(mode="json")}
            if ref.endswith("visuals/visual-1/result.json.gz"):
                return {
                    "kind": "resolved_visual",
                    "idempotency_key": cache_key,
                    "visual": ResolvedVisual(
                        visual_id="visual-1",
                        section_id="section-1",
                        asset_id="asset-1",
                        status="ready",
                        alt_text="Installed solar battery",
                        alt_source="default_alt_text",
                        provider="project_asset",
                        source_strategy="project_asset",
                        width=1200,
                        height=675,
                    ).model_dump(mode="json"),
                }
            raise StoredTextNotFoundError("object not found")

        async def write_json(self, key: str, value: dict):
            writes.append((key, value))
            return key

    class Repository:
        async def list_ready_images(self, project_id: str, limit: int):
            del project_id, limit
            return []

    class Provider:
        name = "project_asset"

        async def acquire(self, image_request: ImageRequest) -> ImageResult:
            nonlocal provider_calls
            provider_calls += 1
            raise AssertionError(f"provider called for {image_request.visual.visual_id}")

    class Service:
        async def get_asset(self, project_id: str, asset_id: str):
            assert (project_id, asset_id) == ("project-1", "asset-1")
            return SimpleNamespace(
                asset_id="asset-1",
                status="ready",
                width=1200,
                height=675,
            )

    monkeypatch.setattr(visual_generation, "S3ArtifactStore", Store)
    monkeypatch.setattr(visual_generation, "image_provider_for", lambda *_a, **_k: Provider())
    result = asyncio.run(
        resolve_visuals(
            settings=SimpleNamespace(s3_bucket="test-bucket"),  # type: ignore[arg-type]
            context=context,
            asset_repository=Repository(),  # type: ignore[arg-type]
            asset_service=Service(),  # type: ignore[arg-type]
        )
    )

    assert provider_calls == 0
    assert result["summary"]["ready_count"] == 1
    resolved = next(value for key, value in writes if key.endswith("resolved.json.gz"))
    assert resolved["visuals"][0]["reused"] is True
