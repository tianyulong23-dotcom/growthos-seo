from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


AssetType = Literal["image", "video", "audio", "file"]
AssetStatus = Literal[
    "pending",
    "uploading",
    "uploaded",
    "processing",
    "ready",
    "pending_delete",
    "failed",
    "quarantined",
]


class AssetUploadCreateRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    byte_size: int = Field(gt=0)
    declared_mime_type: str = Field(min_length=1, max_length=255)
    asset_type: AssetType
    sha256: str | None = Field(default=None, pattern=r"^[a-fA-F0-9]{64}$")
    source_type: Literal["upload", "paste"] = "upload"

    @field_validator("filename")
    @classmethod
    def clean_filename(cls, value: str) -> str:
        cleaned = value.strip().replace("\\", "/").rsplit("/", 1)[-1]
        if not cleaned or cleaned in {".", ".."} or "\x00" in cleaned:
            raise ValueError("asset_filename_invalid")
        return cleaned


class AssetUploadCreateResponse(BaseModel):
    asset_id: str
    upload_id: str
    status: str
    part_size: int
    maximum_bytes: int
    expires_at: datetime


class AssetUploadPartResponse(BaseModel):
    asset_id: str
    upload_id: str
    part_number: int
    etag: str
    byte_size: int
    uploaded_bytes: int
    status: str


class CompletedPart(BaseModel):
    part_number: int = Field(gt=0)
    etag: str = Field(min_length=1, max_length=255)


class AssetUploadCompleteRequest(BaseModel):
    parts: list[CompletedPart] = Field(min_length=1, max_length=10_000)
    sha256: str | None = Field(default=None, pattern=r"^[a-fA-F0-9]{64}$")


class AssetImportRequest(BaseModel):
    source_url: str = Field(min_length=1, max_length=4096)
    asset_type: AssetType
    filename: str | None = Field(default=None, max_length=255)


class AssetUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    default_alt_text: str | None = Field(default=None, max_length=2_000)
    caption: str | None = Field(default=None, max_length=5_000)
    description: str | None = Field(default=None, max_length=10_000)

    @field_validator("title", "default_alt_text", "caption", "description")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def require_changed_field(self) -> "AssetUpdateRequest":
        if not self.model_fields_set:
            raise ValueError("asset_metadata_empty")
        return self


class AssetDownloadAuthorizationRequest(BaseModel):
    disposition: Literal["inline", "attachment"] = "inline"
    variant_type: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
    )


class AssetDownloadAuthorizationResponse(BaseModel):
    url: str
    expires_at: datetime


class AssetVariantResponse(BaseModel):
    variant_type: str
    format: str
    width: int | None
    height: int | None
    byte_size: int
    status: str


class AssetResponse(BaseModel):
    asset_id: str
    canonical_asset_id: str | None = None
    asset_type: AssetType
    status: str
    original_filename: str
    title: str | None
    default_alt_text: str | None
    caption: str | None
    description: str | None
    mime_type: str | None
    detected_mime_type: str | None
    byte_size: int | None
    content_hash: str | None
    width: int | None
    height: int | None
    duration_ms: int | None
    source_type: str
    source_url: str | None
    final_source_url: str | None
    provider_metadata: dict[str, object] = Field(default_factory=dict)
    failure_code: str | None
    failure_detail: str | None
    created_at: datetime
    updated_at: datetime
    ready_at: datetime | None
    active_reference_count: int = 0
    variants: list[AssetVariantResponse] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)


class AssetCollectionResponse(BaseModel):
    items: list[AssetResponse]
    next_cursor: str | None = None


class AssetUsageItem(BaseModel):
    article_id: str
    article_title: str | None
    article_status: str
    current_reference_count: int
    version_reference_count: int
    binding_roles: list[str]
    node_ids: list[str]
    version_numbers: list[int]


class AssetUsageResponse(BaseModel):
    asset_id: str
    active_reference_count: int
    article_count: int
    items: list[AssetUsageItem]


class AssetProblemResponse(BaseModel):
    error: dict[str, object]
