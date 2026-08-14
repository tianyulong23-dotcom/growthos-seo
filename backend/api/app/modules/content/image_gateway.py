from __future__ import annotations

import base64
import io
import ipaddress
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings
from app.modules.content.asset_repository import AssetRepository
from app.modules.content.models import ContentAsset
from app.modules.content.writing_gateway import (
    ChartDataPoint,
    EvidenceClaim,
    VisualPlanItem,
)


class ImageRequest(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    run_id: str
    project_id: str
    visual: VisualPlanItem
    section_heading: str = ""
    idempotency_key: str
    claims: list[EvidenceClaim] = Field(default_factory=list)


class ImageResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    visual_id: str
    provider: str
    asset_id: str | None = None
    source_url: str | None = None
    content: bytes | None = None
    filename: str | None = None
    mime_type: str | None = None
    width: int | None = None
    height: int | None = None
    alt_text: str = ""
    alt_source: str | None = None
    caption: str | None = None
    license_name: str | None = None
    creator_name: str | None = None
    attribution_url: str | None = None
    generation_request_id: str | None = None
    generation_prompt: str | None = None
    model_name: str | None = None
    captured_at: str | None = None
    viewport_width: int | None = None
    viewport_height: int | None = None
    cost_usd: Decimal | None = None


class ImageProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ImageProvider(Protocol):
    async def acquire(self, request: ImageRequest) -> ImageResult: ...


@dataclass(frozen=True)
class ProjectAssetMatch:
    asset: ContentAsset
    score: int


class ProjectAssetProvider:
    name = "project_asset"

    def __init__(self, repository: AssetRepository) -> None:
        self.repository = repository

    async def acquire(self, request: ImageRequest) -> ImageResult:
        assets = await self.repository.list_ready_images(request.project_id, limit=100)
        match = best_project_asset_match(request, assets)
        if match is None:
            raise ImageProviderError(
                "project_asset_not_relevant",
                "No relevant ready project image was found.",
            )
        asset = match.asset
        alt_source = None
        alt_text = ""
        for field_name in ("default_alt_text", "title", "caption", "description"):
            candidate = str(getattr(asset, field_name, None) or "").strip()
            if candidate:
                alt_source = field_name
                alt_text = candidate
                break
        if not alt_text:
            raise ImageProviderError(
                "image_alt_missing",
                "The matched project image has no descriptive metadata for alt text.",
            )
        return ImageResult(
            visual_id=request.visual.visual_id,
            provider=self.name,
            asset_id=asset.id,
            mime_type=asset.detected_mime_type or asset.mime_type,
            width=asset.width,
            height=asset.height,
            alt_text=alt_text,
            alt_source=alt_source,
            caption=asset.caption,
            source_url=asset.final_source_url or asset.source_url,
        )


class UnconfiguredImageProvider:
    def __init__(self, name: str) -> None:
        self.name = name

    async def acquire(self, request: ImageRequest) -> ImageResult:
        del request
        raise ImageProviderError(
            "provider_unconfigured",
            f"The {self.name} image provider is not configured.",
        )


class ChartProvider:
    name = "chart"

    async def acquire(self, request: ImageRequest) -> ImageResult:
        claims = {item.claim_id: item for item in request.claims}
        points = []
        for point in request.visual.chart_data:
            claim = claims.get(point.claim_id)
            if (
                point.claim_id not in request.visual.data_claim_ids
                or claim is None
                or not point.value.is_finite()
                or not _claim_contains_value(claim, point.value)
            ):
                continue
            points.append((point, claim))
        if not points:
            raise ImageProviderError(
                "chart_data_unverified",
                "The chart has no numeric values traceable to its cited claims.",
            )
        content, width, height = _render_bar_chart(request.visual, points)
        sources = list(dict.fromkeys(claim.source_title or claim.source_url for _, claim in points))
        caption = request.visual.caption or "Sources: " + "; ".join(sources[:3])
        values = ", ".join(
            f"{point.label} {point.value.normalize()}{point.unit}" for point, _ in points[:5]
        )
        return ImageResult(
            visual_id=request.visual.visual_id,
            provider=self.name,
            content=content,
            filename=f"{_safe_filename(request.visual.visual_id)}.png",
            mime_type="image/png",
            width=width,
            height=height,
            alt_text=f"{request.visual.title}: {values}",
            alt_source="verified_chart_data",
            caption=caption,
            source_url=points[0][1].source_url,
        )


class ScreenshotProvider:
    name = "screenshot"

    def __init__(self, settings: Settings) -> None:
        self.service_url = settings.article_screenshot_service_url.strip()
        self.api_key = settings.article_screenshot_api_key.strip()

    async def acquire(self, request: ImageRequest) -> ImageResult:
        if not self.service_url:
            raise ImageProviderError(
                "provider_unconfigured", "The screenshot image provider is not configured."
            )
        target_url = str(request.visual.target_url or "").strip()
        _validate_public_url(target_url)
        width, height = _dimensions(request.visual.aspect_ratio)
        headers = {"Accept": "application/json, image/png"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {
            "url": target_url,
            "viewport": {"width": width, "height": height},
            "full_page": True,
            "format": "png",
        }
        response = await _request("POST", self.service_url, headers=headers, json=payload)
        captured_at = datetime.now(UTC).isoformat()
        if response.headers.get("content-type", "").lower().startswith("image/"):
            content = response.content
        else:
            body = _response_json(response)
            encoded = body.get("image_base64") or body.get("content_base64")
            if not isinstance(encoded, str) or not encoded:
                raise ImageProviderError(
                    "image_provider_invalid_response",
                    "The screenshot service returned no image.",
                )
            try:
                content = base64.b64decode(encoded, validate=True)
            except ValueError as exc:
                raise ImageProviderError(
                    "image_provider_invalid_response",
                    "The screenshot service returned invalid image data.",
                ) from exc
            captured_at = str(body.get("captured_at") or captured_at)
        actual_width, actual_height = _image_dimensions(content)
        host = urlsplit(target_url).hostname or target_url
        return ImageResult(
            visual_id=request.visual.visual_id,
            provider=self.name,
            content=content,
            filename=f"{_safe_filename(request.visual.visual_id)}.png",
            mime_type="image/png",
            width=actual_width,
            height=actual_height,
            alt_text=request.visual.alt_instruction.strip(),
            alt_source="screenshot_plan",
            caption=request.visual.caption or f"Screenshot of {host}, captured {captured_at[:10]}.",
            source_url=target_url,
            captured_at=captured_at,
            viewport_width=width,
            viewport_height=height,
        )


class PexelsStockProvider:
    name = "stock"

    def __init__(self, settings: Settings) -> None:
        self.api_key = settings.article_stock_api_key.strip()
        self.base_url = settings.article_stock_base_url.rstrip("/")

    async def acquire(self, request: ImageRequest) -> ImageResult:
        if not self.api_key:
            raise ImageProviderError(
                "provider_unconfigured", "The stock image provider is not configured."
            )
        query = " ".join(
            str(request.visual.prompt or request.visual.title or request.section_heading).split()
        )[:200]
        orientation = "square" if request.visual.aspect_ratio == "1:1" else "landscape"
        response = await _request(
            "GET",
            f"{self.base_url}/search",
            headers={"Authorization": self.api_key},
            params={"query": query, "per_page": 5, "orientation": orientation},
        )
        body = _response_json(response)
        photos = body.get("photos")
        if not isinstance(photos, list):
            photos = []
        photo = next(
            (
                item
                for item in photos
                if isinstance(item, dict)
                and isinstance(item.get("src"), dict)
                and str(item.get("alt") or "").strip()
            ),
            None,
        )
        if photo is None:
            raise ImageProviderError("stock_no_result", "No suitable licensed image was found.")
        source = photo["src"].get("large2x") or photo["src"].get("large")
        if not isinstance(source, str) or not source:
            raise ImageProviderError(
                "image_provider_invalid_response", "The stock provider returned no image URL."
            )
        creator = str(photo.get("photographer") or "").strip()
        attribution = str(photo.get("url") or "").strip()
        if not creator or not attribution:
            raise ImageProviderError(
                "stock_license_missing", "The stock image has incomplete attribution metadata."
            )
        return ImageResult(
            visual_id=request.visual.visual_id,
            provider=self.name,
            source_url=source,
            filename=f"{_safe_filename(request.visual.visual_id)}.jpg",
            mime_type="image/jpeg",
            alt_text=str(photo["alt"]).strip(),
            alt_source="pexels_alt",
            caption=request.visual.caption or f"Photo by {creator} on Pexels.",
            license_name="Pexels License",
            creator_name=creator,
            attribution_url=attribution,
        )


class AIImageProvider:
    name = "ai"

    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.article_ai_image_base_url.rstrip("/")
        self.api_key = settings.article_ai_image_api_key.strip()
        self.model = settings.article_ai_image_model.strip()
        self.cost_usd = Decimal(str(settings.article_ai_image_cost_usd))

    async def acquire(self, request: ImageRequest) -> ImageResult:
        if not self.base_url or not self.api_key or not self.model:
            raise ImageProviderError(
                "provider_unconfigured", "The AI image provider is not configured."
            )
        prompt = str(request.visual.prompt or request.visual.alt_instruction).strip()
        response = await _request(
            "POST",
            _endpoint(self.base_url, "/images/generations"),
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "prompt": prompt,
                "n": 1,
                "size": _ai_size(request.visual.aspect_ratio),
                "response_format": "b64_json",
            },
        )
        body = _response_json(response)
        data = body.get("data")
        item = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else {}
        encoded = item.get("b64_json")
        image_url = item.get("url")
        revised_prompt = str(item.get("revised_prompt") or "").strip()
        content = None
        if isinstance(encoded, str) and encoded:
            try:
                content = base64.b64decode(encoded, validate=True)
            except ValueError as exc:
                raise ImageProviderError(
                    "image_provider_invalid_response",
                    "The AI image provider returned invalid image data.",
                ) from exc
        if content is None and not isinstance(image_url, str):
            raise ImageProviderError(
                "image_provider_invalid_response", "The AI image provider returned no image."
            )
        width = height = None
        if content is not None:
            width, height = _image_dimensions(content)
        return ImageResult(
            visual_id=request.visual.visual_id,
            provider=self.name,
            source_url=image_url if isinstance(image_url, str) else None,
            content=content,
            filename=f"{_safe_filename(request.visual.visual_id)}.png",
            mime_type="image/png",
            width=width,
            height=height,
            alt_text=revised_prompt or request.visual.alt_instruction.strip(),
            alt_source="generation_metadata" if revised_prompt else "generation_plan",
            caption=request.visual.caption,
            generation_request_id=str(body.get("id") or item.get("id") or "") or None,
            generation_prompt=prompt,
            model_name=str(body.get("model") or self.model),
            cost_usd=self.cost_usd,
        )


def choose_visual_strategy(
    visual: VisualPlanItem,
    *,
    has_relevant_project_asset: bool,
) -> str:
    """Turn the model's source suggestion into a deterministic provider choice."""
    if visual.required:
        return "project_asset"
    if (
        visual.data_claim_ids
        and visual.chart_data
        and visual.reader_job in {"compare", "prove"}
    ):
        return "chart"
    if visual.source_strategy == "screenshot":
        return "project_asset" if has_relevant_project_asset else "screenshot"
    if visual.source_strategy == "project_asset":
        return "project_asset"
    if visual.reader_job == "prove":
        return "project_asset" if has_relevant_project_asset else "screenshot"
    if has_relevant_project_asset:
        return "project_asset"
    return visual.source_strategy


def visual_strategy_chain(
    visual: VisualPlanItem,
    *,
    has_relevant_project_asset: bool,
) -> list[str]:
    """Return ordered providers without allowing illustrative images to replace evidence."""
    primary = choose_visual_strategy(
        visual,
        has_relevant_project_asset=has_relevant_project_asset,
    )
    strategies = [primary]
    if primary == "project_asset" and visual.target_url:
        strategies.append("screenshot")
    if (
        visual.source_strategy == "stock"
        and visual.reader_job in {"explain", "orient"}
    ):
        strategies.extend(("stock", "ai"))
    elif primary == "project_asset" and visual.source_strategy != "project_asset":
        strategies.append(visual.source_strategy)
    return list(dict.fromkeys(strategies))


def image_provider_for(
    strategy: str,
    *,
    asset_repository: AssetRepository,
    settings: Settings,
) -> ImageProvider:
    if strategy == "project_asset":
        return ProjectAssetProvider(asset_repository)
    if strategy == "screenshot":
        return ScreenshotProvider(settings)
    if strategy == "chart":
        return ChartProvider()
    if strategy == "stock" and settings.article_stock_provider == "pexels":
        return PexelsStockProvider(settings)
    if strategy == "ai":
        return AIImageProvider(settings)
    return UnconfiguredImageProvider(strategy)


def best_project_asset_match(
    request: ImageRequest,
    assets: list[ContentAsset],
) -> ProjectAssetMatch | None:
    query_terms = _search_terms(
        " ".join(
            (
                request.visual.title,
                request.visual.alt_instruction,
                request.section_heading,
            )
        )
    )
    if not query_terms:
        return None
    best: ProjectAssetMatch | None = None
    for asset in assets:
        asset_terms = _search_terms(
            " ".join(
                str(value or "")
                for value in (
                    asset.original_filename,
                    asset.title,
                    asset.default_alt_text,
                    asset.caption,
                    asset.description,
                )
            )
        )
        overlap = query_terms.intersection(asset_terms)
        if not overlap:
            continue
        score = sum(2 if len(term) >= 5 else 1 for term in overlap)
        candidate = ProjectAssetMatch(asset=asset, score=score)
        if best is None or candidate.score > best.score:
            best = candidate
    return best


def _search_terms(value: str) -> set[str]:
    lowered = value.lower()
    words = {
        item
        for item in re.findall(r"[a-z0-9]+", lowered)
        if len(item) >= 2
    }
    cjk_runs = re.findall(r"[\u3400-\u9fff]+", lowered)
    cjk_terms = {
        run[index : index + 2]
        for run in cjk_runs
        for index in range(max(0, len(run) - 1))
    }
    return words.union(cjk_terms)


def _claim_contains_value(claim: EvidenceClaim, value: Decimal) -> bool:
    haystack = f"{claim.claim} {claim.quote}".replace(",", "")
    candidates = {format(value, "f"), format(value.normalize(), "f")}
    return any(
        re.search(rf"(?<![\d.]){re.escape(candidate)}(?![\d.])", haystack)
        for candidate in candidates
    )


def _render_bar_chart(
    visual: VisualPlanItem,
    points: list[tuple[ChartDataPoint, EvidenceClaim]],
) -> tuple[bytes, int, int]:
    width, height = _dimensions(visual.aspect_ratio)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title_font = _font(max(28, width // 32), bold=True)
    label_font = _font(max(20, width // 48))
    value_font = _font(max(18, width // 55), bold=True)
    margin = max(60, width // 20)
    title = _fit_text_to_width(draw, visual.title, title_font, width - (2 * margin))
    draw.text((margin, margin), title, fill="#17212b", font=title_font)
    top = margin + max(70, height // 10)
    bottom = height - margin
    chart_height = max(100, bottom - top)
    maximum = max(abs(float(point.value)) for point, _ in points) or 1.0
    row_height = chart_height / len(points)
    label_width = min(width * 0.32, 420)
    bar_left = margin + label_width
    bar_right = width - margin
    colors = ("#176b5b", "#2779a7", "#b85c38", "#6b5b95", "#7a7f35")
    for index, (point, _) in enumerate(points):
        center_y = top + row_height * (index + 0.5)
        label = _fit_text_to_width(
            draw,
            str(point.label),
            label_font,
            label_width - 24,
        )
        label_bbox = draw.textbbox((0, 0), label, font=label_font)
        label_height = label_bbox[3] - label_bbox[1]
        draw.text(
            (margin, center_y - (label_height / 2) - label_bbox[1]),
            label,
            fill="#263746",
            font=label_font,
        )
        bar_width = max(4, (bar_right - bar_left) * abs(float(point.value)) / maximum)
        draw.rounded_rectangle(
            (bar_left, center_y - 18, bar_left + bar_width, center_y + 18),
            radius=8,
            fill=colors[index % len(colors)],
        )
        value_label = _fit_text_to_width(
            draw,
            f"{point.value.normalize()}{point.unit}",
            value_font,
            (bar_right - bar_left) - 16,
        )
        value_bbox = draw.textbbox((0, 0), value_label, font=value_font)
        value_width = value_bbox[2] - value_bbox[0]
        value_height = value_bbox[3] - value_bbox[1]
        outside_x = bar_left + bar_width + 12
        if outside_x + value_width <= bar_right:
            value_x = outside_x
            value_color = "#17212b"
        else:
            value_x = max(bar_left + 8, bar_left + bar_width - value_width - 12)
            value_color = "#ffffff"
        draw.text(
            (value_x, center_y - (value_height / 2) - value_bbox[1]),
            value_label,
            fill=value_color,
            font=value_font,
        )
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue(), width, height


def _fit_text_to_width(
    draw: ImageDraw.ImageDraw,
    value: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    max_width: float,
) -> str:
    if draw.textlength(value, font=font) <= max_width:
        return value
    suffix = "..."
    if draw.textlength(suffix, font=font) > max_width:
        return ""
    low, high = 0, len(value)
    while low < high:
        middle = (low + high + 1) // 2
        if draw.textlength(f"{value[:middle]}{suffix}", font=font) <= max_width:
            low = middle
        else:
            high = middle - 1
    return f"{value[:low].rstrip()}{suffix}"


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    paths = (
        (
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
            if bold
            else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
        ),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    )
    for path in paths:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _dimensions(aspect_ratio: str) -> tuple[int, int]:
    return {"1:1": (1200, 1200), "4:3": (1200, 900)}.get(aspect_ratio, (1600, 900))


def _ai_size(aspect_ratio: str) -> str:
    return "1024x1024" if aspect_ratio == "1:1" else "1536x1024"


def _image_dimensions(content: bytes) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
            return image.width, image.height
    except Exception as exc:
        raise ImageProviderError("image_invalid", "The provider returned an invalid image.") from exc


def _validate_public_url(value: str) -> None:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ImageProviderError("screenshot_url_invalid", "The screenshot URL is invalid.")
    hostname = parsed.hostname.casefold()
    if hostname == "localhost" or hostname.endswith(".local"):
        raise ImageProviderError("screenshot_url_forbidden", "The screenshot URL is not public.")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return
    if not address.is_global:
        raise ImageProviderError("screenshot_url_forbidden", "The screenshot URL is not public.")


async def _request(method: str, url: str, **kwargs: object) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            response = await client.request(method, url, **kwargs)
    except httpx.TimeoutException as exc:
        raise ImageProviderError("provider_timeout", "The image provider timed out.") from exc
    except httpx.HTTPError as exc:
        raise ImageProviderError(
            "provider_unavailable", "The image provider could not be reached."
        ) from exc
    if response.status_code in {401, 403}:
        raise ImageProviderError("provider_auth_failed", "The image provider rejected its credentials.")
    if response.status_code == 429 or response.status_code >= 500:
        raise ImageProviderError("provider_unavailable", "The image provider is temporarily unavailable.")
    if response.status_code >= 400:
        raise ImageProviderError("provider_rejected", "The image provider rejected the request.")
    return response


def _response_json(response: httpx.Response) -> dict[str, object]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise ImageProviderError(
            "image_provider_invalid_response", "The image provider returned invalid JSON."
        ) from exc
    if not isinstance(payload, dict):
        raise ImageProviderError(
            "image_provider_invalid_response", "The image provider returned invalid JSON."
        )
    return payload


def _endpoint(base_url: str, suffix: str) -> str:
    return base_url if base_url.endswith(suffix) else base_url + suffix


def _safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", value).strip(".-")[:80] or "article-image"
