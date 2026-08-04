from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class AuditScope(StrEnum):
    DOMAIN = "domain"
    SUBDOMAINS = "subdomains"
    DIRECTORY = "directory"


class RenderingMode(StrEnum):
    AUTO = "auto"
    OFF = "off"
    ALL = "all"


PathValue = Annotated[str, Field(min_length=1, max_length=2048, pattern=r"^/")]
ParameterValue = Annotated[
    str,
    Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+\*?$"),
]
IssueExclusionValue = Annotated[str, Field(min_length=1, max_length=2048)]

DEFAULT_ISSUE_EXCLUSION_PATTERNS = """
/wp-admin/*
/wp-content/plugins/*
/wp-content/themes/*
/wp-content/uploads/*
/wp-includes/*
/wp-login.php
/wp-cron.php
/xmlrpc.php
/wp-json/*
/wp-activate.php
/wp-signup.php
/wp-trackback.php
/login*
/signin*
/sign-in*
/log-in*
/auth/*
/authenticate/*
/register*
/signup*
/sign-up*
/registration/*
/logout*
/signout*
/sign-out*
/log-out*
/forgot-password*
/reset-password*
/password-reset*
/recover-password*
/change-password*
/account/password/*
/user/password/*
/activate/*
/verification/*
/verify/*
/confirm/*
/admin/*
/administrator/*
/_admin/*
/backend/*
/dashboard/*
/cpanel/*
/phpmyadmin/*
/pma/*
/webmail/*
/plesk/*
/control-panel/*
/manage/*
/manager/*
/checkout/*
/cart/*
/basket/*
/payment/*
/billing/*
/order/*
/orders/*
/purchase/*
/account/*
/profile/*
/settings/*
/preferences/*
/my-account/*
/user/*
/member/*
/members/*
/cgi-bin/*
/cgi/*
/fcgi-bin/*
/.git/*
/.svn/*
/.hg/*
/.bzr/*
/.cvs/*
/.env
/.env.*
/.htaccess
/.htpasswd
/web.config
/app.config
/composer.json
/package.json
/node_modules/*
/vendor/*
/bower_components/*
/jspm_packages/*
/includes/*
/lib/*
/libs/*
/src/*
/dist/*
/build/*
/builds/*
/_next/*
/.next/*
/out/*
/_nuxt/*
/.nuxt/*
/test/*
/tests/*
/spec/*
/specs/*
/__tests__/*
/debug/*
/dev/*
/development/*
/staging/*
/api/internal/*
/api/admin/*
/api/private/*
/private/*
/system/*
/core/*
/internal/*
/tmp/*
/temp/*
/cache/*
/logs/*
/log/*
/backup/*
/backups/*
/old/*
/archive/*
/archives/*
/config/*
/configs/*
/configuration/*
/upload/*
/uploads/*
/uploader/*
/file-upload/*
/search*
*/search/*
?s=*
?search=*
*/filter/*
?filter=*
*/sort/*
?sort=*
/print/*
?print=*
/preview/*
?preview=*
/embed/*
?embed=*
/amp/*
/amp
/feed/*
/feeds/*
/rss/*
*.rss
/atom/*
*.atom
*.json
*.xml
*.yaml
*.yml
*.toml
*.ini
*.conf
*.log
*.txt
*.csv
*.sql
*.db
*.bak
*.backup
*.old
*.orig
*.tmp
*.swp
*.map
*.min.js
*.min.css
""".strip().splitlines()


class CreateAuditRunRequest(BaseModel):
    max_pages: int = Field(default=1000, ge=1, le=5_000)
    scope: AuditScope = AuditScope.DOMAIN
    directory: PathValue | None = None
    rendering: RenderingMode = RenderingMode.AUTO
    allowed_paths: list[PathValue] = Field(default_factory=list, max_length=100)
    excluded_paths: list[PathValue] = Field(default_factory=list, max_length=100)
    ignored_parameters: list[ParameterValue] = Field(
        default_factory=lambda: ["utm_*", "gclid", "fbclid", "msclkid", "yclid"],
        max_length=100,
    )
    issue_exclusion_patterns: list[IssueExclusionValue] = Field(
        default_factory=lambda: list(DEFAULT_ISSUE_EXCLUSION_PATTERNS),
        max_length=250,
    )
    enable_duplication_check: bool = True
    duplication_threshold: float = Field(default=0.85, ge=0, le=1)
    enable_pagespeed: bool = False

    @field_validator(
        "allowed_paths",
        "excluded_paths",
        "ignored_parameters",
        "issue_exclusion_patterns",
        mode="after",
    )
    @classmethod
    def unique_values(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values))

    @field_validator("directory", mode="after")
    @classmethod
    def clean_directory(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if cleaned != "/":
            cleaned = cleaned.rstrip("/")
        return cleaned

    @model_validator(mode="after")
    def validate_directory_scope(self) -> "CreateAuditRunRequest":
        if self.scope == AuditScope.DIRECTORY and not self.directory:
            raise ValueError("directory is required when scope is directory")
        if self.scope != AuditScope.DIRECTORY:
            self.directory = None
        return self


class RecalculateAuditIssuesRequest(BaseModel):
    issue_exclusion_patterns: list[IssueExclusionValue] = Field(
        default_factory=list,
        max_length=250,
    )

    @field_validator("issue_exclusion_patterns", mode="after")
    @classmethod
    def unique_values(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values))


class AuditSummary(BaseModel):
    page_count: int = 0
    health_score: int = 0
    errors: int = 0
    warnings: int = 0
    notices: int = 0
    rendered_pages: int = 0
    resource_checks_truncated: bool = False


class AuditPageSpeedState(BaseModel):
    configured: bool
    status: Literal["disabled", "pending", "running", "completed", "failed"]
    message: str
    provider: str = "Google PageSpeed Insights"


AuditRunStatus = Literal[
    "queued",
    "running",
    "paused",
    "stopping",
    "stopped",
    "recalculating",
    "completed",
    "failed",
]


class AuditRunResponse(BaseModel):
    run_id: str
    project_id: str
    status: AuditRunStatus
    stage: str
    message: str
    progress: int = Field(ge=0, le=100)
    discovered: int = 0
    processed: int = 0
    selected: int = 0
    created_at: datetime
    completed_at: datetime | None = None
    can_resume: bool = False
    archived_at: datetime | None = None
    summary: AuditSummary | None = None
    pagespeed: AuditPageSpeedState | None = None
    issue_exclusion_patterns: list[str] = Field(default_factory=list)


class AuditRunCollection(BaseModel):
    items: list[AuditRunResponse]
    total: int
    page: int
    page_size: int


class AuditActivityItem(BaseModel):
    sequence: int
    url: str
    final_url: str
    status_code: int | None
    title: str
    error: str
    error_type: str
    depth: int | None
    rendered: bool
    response_time_ms: int | None
    fetched_at: datetime | None


class AuditActivityCollection(BaseModel):
    items: list[AuditActivityItem]
    next_cursor: int


class AuditIssueResponse(BaseModel):
    id: str
    title: str
    code: str
    severity: Literal["error", "warning", "notice"]
    category: str
    affected_count: int
    description: str
    recommendation: str
    urls: list[str]
    raw: dict = Field(default_factory=dict)


class AuditIssueCollection(BaseModel):
    items: list[AuditIssueResponse]
    total: int
    page: int
    page_size: int


class AuditPageResponse(BaseModel):
    id: str
    url: str
    final_url: str
    status_code: int | None
    title: str
    description: str
    content_type: str
    indexable: bool | None
    word_count: int | None
    response_time_ms: int | None
    rendered: bool | None
    issues_count: int
    depth: int | None
    canonical: str
    h1: list[str] = Field(default_factory=list)
    h2: list[str] = Field(default_factory=list)
    h3: list[str] = Field(default_factory=list)
    headings: list[str] = Field(default_factory=list)
    meta_tags: dict[str, str] = Field(default_factory=dict)
    size_bytes: int = 0
    language: str = ""
    charset: str = ""
    viewport: str = ""
    robots: str = ""
    author: str = ""
    keywords: str = ""
    generator: str = ""
    theme_color: str = ""
    open_graph: dict[str, str] = Field(default_factory=dict)
    twitter_tags: dict[str, str] = Field(default_factory=dict)
    structured_data: list[dict] = Field(default_factory=list)
    schema_org: list[dict] = Field(default_factory=list)
    analytics: dict = Field(default_factory=dict)
    images: list[dict] = Field(default_factory=list)
    broken_images: list[dict] = Field(default_factory=list)
    internal_links: int = 0
    external_links: int = 0
    hreflang: list[dict] = Field(default_factory=list)
    redirects: list[dict] = Field(default_factory=list)
    linked_from: list[str] = Field(default_factory=list)
    discovered_from: str = ""
    error: str = ""
    error_type: str = ""
    raw: dict = Field(default_factory=dict)


class AuditPageCollection(BaseModel):
    items: list[AuditPageResponse]
    total: int
    page: int
    page_size: int


class AuditLinkResponse(BaseModel):
    id: str
    source_url: str
    target_url: str
    anchor_text: str
    status_code: int | None
    kind: str
    internal: bool | None
    follow: bool | None
    error: str
    placement: str
    target_domain: str
    rel: str
    in_navigation: bool
    raw: dict = Field(default_factory=dict)


class AuditLinkCollection(BaseModel):
    items: list[AuditLinkResponse]
    total: int
    page: int
    page_size: int


class AuditExternalResourceResponse(BaseModel):
    id: str
    url: str
    final_url: str
    status_code: int | None
    content_type: str
    size_bytes: int
    title: str
    error: str
    error_type: str
    checked_at: datetime | None
    raw: dict = Field(default_factory=dict)


class AuditExternalResourceCollection(BaseModel):
    items: list[AuditExternalResourceResponse]
    total: int
    page: int
    page_size: int


class AuditStatusCodeResponse(BaseModel):
    status_code: int
    status: str
    count: int
    percentage: float
    error_type: str = ""


class AuditStatusCodeCollection(BaseModel):
    items: list[AuditStatusCodeResponse]
    total: int


class AuditVisualizationNode(BaseModel):
    id: str
    label: str
    url: str
    group: str
    depth: int | None
    issue_count: int
    raw: dict = Field(default_factory=dict)


class AuditVisualizationEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str
    raw: dict = Field(default_factory=dict)


class AuditVisualizationResponse(BaseModel):
    nodes: list[AuditVisualizationNode]
    edges: list[AuditVisualizationEdge]
    total_nodes: int
    total_edges: int
    truncated: bool


class AuditPageSpeedResultResponse(BaseModel):
    id: str
    url: str
    strategy: str
    performance_score: int | None
    accessibility_score: int | None
    best_practices_score: int | None
    seo_score: int | None
    metrics: dict
    error: str
    analyzed_at: datetime


class AuditPageSpeedCollection(BaseModel):
    items: list[AuditPageSpeedResultResponse]
    total: int


AuditExportDataset = Literal["issues", "pages", "links"]
AuditExportFormat = Literal["csv", "json", "xml", "xlsx"]
