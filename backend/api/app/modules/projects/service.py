from dataclasses import dataclass
from datetime import UTC, datetime
import re
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.projects.models import (
    Project,
    ProjectAuditEvent,
    ProjectOutboxEvent,
    PromotionTargetVersion,
    SiteProfile,
    WebsiteProfileVersion,
)


class ProjectValidationError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


class ProjectConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProjectProfileInput:
    name: str
    domain: str
    country: str
    target_market: str
    language: str
    products: tuple[str, ...]
    keywords: tuple[str, ...]
    target_urls: tuple[str, ...]


@dataclass(frozen=True)
class ProjectProfilePatch:
    name: str | None = None
    domain: str | None = None
    country: str | None = None
    target_market: str | None = None
    language: str | None = None
    products: tuple[str, ...] | None = None
    keywords: tuple[str, ...] | None = None
    target_urls: tuple[str, ...] | None = None


@dataclass(frozen=True)
class WebsiteProjectRecord:
    website_project_id: str
    website_project_key: str
    organization_id: str
    workspace_id: str
    status: str
    archived_at: datetime | None
    name: str
    domain: str
    country: str
    target_market: str
    language: str
    health: int
    context_version: int
    profile_version_id: str
    promotion_target_version_id: str
    products: tuple[str, ...]
    keywords: tuple[str, ...]
    target_urls: tuple[str, ...]
    input_required: tuple[str, ...]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class ProjectMutationResult:
    project: WebsiteProjectRecord
    outbox_event_id: str
    projection_payload: dict[str, object]


_RESERVED_MARKERS = {"canary", "demo", "fixture", "test"}
_LANGUAGE_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Z]{2})?$")


def _dedupe_text(values: tuple[str, ...], field: str) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = raw.strip()
        if not value:
            continue
        if len(value) > 300:
            raise ProjectValidationError(field, f"{field} entries must be 300 characters or less.")
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return tuple(result)


def normalize_domain(value: str) -> str:
    raw = value.strip().lower().rstrip(".")
    if not raw:
        raise ProjectValidationError("domain", "A main domain is required.")
    if "://" in raw:
        parsed = urlsplit(raw)
        try:
            port = parsed.port
        except ValueError as error:
            raise ProjectValidationError("domain", "The main domain is invalid.") from error
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.username is not None
            or parsed.password is not None
            or port is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ProjectValidationError("domain", "Enter only the main website domain.")
        raw = parsed.hostname or ""
    if raw.startswith("www."):
        raw = raw[4:]
    try:
        normalized = raw.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise ProjectValidationError("domain", "The main domain is invalid.") from error
    labels = normalized.split(".")
    if (
        len(labels) < 2
        or any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            or re.fullmatch(r"[a-z0-9-]+", label) is None
            for label in labels
        )
    ):
        raise ProjectValidationError("domain", "The main domain is invalid.")
    if normalized == "localhost" or any(label in _RESERVED_MARKERS for label in labels):
        raise ProjectValidationError("domain", "Test, demo, canary, and fixture domains are not allowed.")
    return normalized


def _normalize_country(value: str) -> str:
    country = value.strip().upper()
    if re.fullmatch(r"[A-Z]{2}", country) is None:
        raise ProjectValidationError("country", "Country must be a two-letter code.")
    return country


def _normalize_language(value: str) -> str:
    raw = value.strip().replace("_", "-")
    parts = raw.split("-")
    language = parts[0].lower() if parts else ""
    normalized = language if len(parts) == 1 else f"{language}-{parts[1].upper()}"
    if _LANGUAGE_RE.fullmatch(normalized) is None:
        raise ProjectValidationError("language", "Language must be a supported locale such as en or en-US.")
    return normalized


def normalize_profile(input: ProjectProfileInput) -> ProjectProfileInput:
    name = input.name.strip()
    if not name or len(name) > 120:
        raise ProjectValidationError("name", "Project name must contain 1 to 120 characters.")
    if any(marker in re.split(r"[^a-z0-9]+", name.lower()) for marker in _RESERVED_MARKERS):
        raise ProjectValidationError("name", "Test, demo, canary, and fixture projects are not allowed.")
    domain = normalize_domain(input.domain)
    target_market = input.target_market.strip()
    if not target_market or len(target_market) > 120:
        raise ProjectValidationError(
            "target_market",
            "Target market must contain 1 to 120 characters.",
        )
    products = _dedupe_text(input.products, "products")
    keywords = _dedupe_text(input.keywords, "keywords")
    target_urls = _dedupe_text(input.target_urls, "target_urls")
    for target_url in target_urls:
        parsed = urlsplit(target_url)
        try:
            port = parsed.port
        except ValueError as error:
            raise ProjectValidationError(
                "target_urls",
                "Target URLs must use HTTPS and belong to the main domain.",
            ) from error
        host = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or port is not None
            or parsed.fragment
            or (host != domain and not host.endswith(f".{domain}"))
        ):
            raise ProjectValidationError(
                "target_urls",
                "Target URLs must use HTTPS and belong to the main domain.",
            )
    return ProjectProfileInput(
        name=name,
        domain=domain,
        country=_normalize_country(input.country),
        target_market=target_market,
        language=_normalize_language(input.language),
        products=products,
        keywords=keywords,
        target_urls=target_urls,
    )


def _input_required(
    products: tuple[str, ...],
    keywords: tuple[str, ...],
    target_urls: tuple[str, ...],
) -> tuple[str, ...]:
    return tuple(
        field
        for field, value in (
            ("products", products),
            ("keywords", keywords),
            ("target_urls", target_urls),
        )
        if not value
    )


def _profile_fallback(profile: SiteProfile | None) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    if profile is None or not isinstance(profile.profile_json, dict):
        return (), (), ()
    data = profile.profile_json
    products = tuple(
        item.strip()
        for item in data.get("products_services", [])
        if isinstance(item, str) and item.strip()
    )
    keywords = tuple(
        item.strip()
        for item in data.get("content_topics", [])
        if isinstance(item, str) and item.strip()
    )
    target_urls = tuple(
        page["url"].strip()
        for page in data.get("key_pages", [])
        if isinstance(page, dict)
        and isinstance(page.get("url"), str)
        and page["url"].strip()
    )
    return products, keywords, target_urls


class WebsiteProjectService:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    @staticmethod
    async def _set_scope(
        session: AsyncSession,
        organization_id: str,
        project_id: str = "",
    ) -> None:
        await session.execute(
            text(
                "SELECT set_config('app.current_organization_id', :organization_id, true), "
                "set_config('app.current_project_id', :project_id, true)"
            ),
            {"organization_id": organization_id, "project_id": project_id},
        )

    @staticmethod
    def _visible_workspace_clause(workspace_id: str, legacy_project_id: str):
        return or_(
            Project.workspace_id == workspace_id,
            (Project.workspace_id.is_(None) & (Project.id == legacy_project_id)),
        )

    @staticmethod
    def _public_key(project: Project, legacy_project_id: str, legacy_project_key: str) -> str:
        if project.id == legacy_project_id:
            return legacy_project_key
        return project.project_key

    @staticmethod
    def _is_reserved(project: Project) -> bool:
        tokens = set(re.split(r"[^a-z0-9]+", f"{project.name} {project.domain} {project.project_key}".lower()))
        return bool(tokens & _RESERVED_MARKERS)

    def _record(
        self,
        project: Project,
        profile_version: WebsiteProfileVersion | None,
        promotion_version: PromotionTargetVersion | None,
        site_profile: SiteProfile | None,
        *,
        workspace_id: str,
        legacy_project_id: str,
        legacy_project_key: str,
    ) -> WebsiteProjectRecord:
        fallback_products, fallback_keywords, fallback_urls = _profile_fallback(site_profile)
        products = (
            tuple(profile_version.products)
            if profile_version is not None
            else fallback_products
        )
        keywords = (
            tuple(promotion_version.keywords)
            if promotion_version is not None
            else fallback_keywords
        )
        target_urls = (
            tuple(promotion_version.target_urls)
            if promotion_version is not None
            else fallback_urls
        )
        required = _input_required(products, keywords, target_urls)
        return WebsiteProjectRecord(
            website_project_id=project.id,
            website_project_key=self._public_key(
                project,
                legacy_project_id,
                legacy_project_key,
            ),
            organization_id=project.organization_id,
            workspace_id=project.workspace_id or workspace_id,
            status=project.status,
            archived_at=project.archived_at,
            name=profile_version.name if profile_version is not None else project.name,
            domain=(
                profile_version.canonical_domain
                if profile_version is not None
                else project.domain
            ),
            country=(
                profile_version.country_code
                if profile_version is not None
                else project.country
            ),
            target_market=(
                profile_version.target_market
                if profile_version is not None
                else project.target_market
            ),
            language=(
                profile_version.locale
                if profile_version is not None
                else project.language
            ),
            health=project.health,
            context_version=project.context_version,
            profile_version_id=(
                profile_version.id
                if profile_version is not None
                else f"{project.id}:legacy-profile"
            ),
            promotion_target_version_id=(
                promotion_version.id
                if promotion_version is not None
                else f"{project.id}:legacy-promotion-target"
            ),
            products=products,
            keywords=keywords,
            target_urls=target_urls,
            input_required=required,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )

    async def _select_rows(
        self,
        session: AsyncSession,
        *,
        organization_id: str,
        workspace_id: str,
        legacy_project_id: str,
        authorized_project_ids: tuple[str, ...] | None = None,
        project_key: str | None = None,
        include_archived: bool = False,
    ):
        query = (
            select(Project, WebsiteProfileVersion, PromotionTargetVersion, SiteProfile)
            .outerjoin(
                WebsiteProfileVersion,
                WebsiteProfileVersion.id == Project.current_profile_version_id,
            )
            .outerjoin(
                PromotionTargetVersion,
                PromotionTargetVersion.id == Project.current_promotion_target_version_id,
            )
            .outerjoin(SiteProfile, SiteProfile.project_id == Project.id)
            .where(
                Project.organization_id == organization_id,
                self._visible_workspace_clause(workspace_id, legacy_project_id),
            )
        )
        if authorized_project_ids is not None:
            query = query.where(Project.id.in_(authorized_project_ids))
        if project_key is not None:
            query = query.where(
                or_(Project.project_key == project_key, Project.id == project_key)
            )
        if not include_archived:
            query = query.where(Project.status == "ACTIVE")
        return (await session.execute(query.order_by(Project.updated_at.desc(), Project.id))).all()

    async def list_projects(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        legacy_project_id: str,
        legacy_project_key: str,
        authorized_project_ids: tuple[str, ...] | None,
        include_archived: bool,
    ) -> tuple[WebsiteProjectRecord, ...]:
        async with self._sessions() as session, session.begin():
            await self._set_scope(session, organization_id)
            rows = await self._select_rows(
                session,
                organization_id=organization_id,
                workspace_id=workspace_id,
                legacy_project_id=legacy_project_id,
                authorized_project_ids=authorized_project_ids,
                include_archived=include_archived,
            )
        return tuple(
            self._record(
                project,
                profile,
                promotion,
                site_profile,
                workspace_id=workspace_id,
                legacy_project_id=legacy_project_id,
                legacy_project_key=legacy_project_key,
            )
            for project, profile, promotion, site_profile in rows
            if not self._is_reserved(project)
        )

    async def get_project(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        legacy_project_id: str,
        legacy_project_key: str,
        authorized_project_ids: tuple[str, ...] | None,
        project_key: str,
        include_archived: bool = False,
    ) -> WebsiteProjectRecord | None:
        lookup_key = legacy_project_id if project_key == legacy_project_key else project_key
        async with self._sessions() as session, session.begin():
            await self._set_scope(session, organization_id)
            rows = await self._select_rows(
                session,
                organization_id=organization_id,
                workspace_id=workspace_id,
                legacy_project_id=legacy_project_id,
                authorized_project_ids=authorized_project_ids,
                project_key=lookup_key,
                include_archived=include_archived,
            )
        if len(rows) != 1 or self._is_reserved(rows[0][0]):
            return None
        return self._record(
            *rows[0],
            workspace_id=workspace_id,
            legacy_project_id=legacy_project_id,
            legacy_project_key=legacy_project_key,
        )

    @staticmethod
    def _project_key(domain: str, project_id: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", domain).strip("-")[:80]
        return f"{slug}-{project_id[:8]}"

    @staticmethod
    def _projection_payload(
        *,
        project: Project,
        profile: ProjectProfileInput,
        profile_version_id: str,
        promotion_target_version_id: str,
        input_required: tuple[str, ...],
        job_id: str,
        outbox_event_id: str,
    ) -> dict[str, object]:
        return {
            "snapshotId": profile_version_id,
            "snapshotVersion": project.context_version,
            "projectStatus": "ACTIVE" if project.status == "ACTIVE" else "PAUSED",
            "canonicalDomain": project.domain,
            "locale": project.language,
            "countryCode": project.country,
            "profileVersionId": profile_version_id,
            "promotionTargetVersionId": promotion_target_version_id,
            "products": list(profile.products),
            "keywords": list(profile.keywords),
            "targetUrls": list(profile.target_urls),
            "inputComplete": not input_required,
            "jobId": job_id,
            "outboxEventId": outbox_event_id,
        }

    @staticmethod
    def _append_version_facts(
        session: AsyncSession,
        *,
        project: Project,
        workspace_id: str,
        profile: ProjectProfileInput,
        actor_id: str,
        event_type: str,
    ) -> tuple[str, str, str, dict[str, object]]:
        input_required = _input_required(
            profile.products,
            profile.keywords,
            profile.target_urls,
        )
        profile_version_id = str(uuid4())
        promotion_version_id = str(uuid4())
        outbox_event_id = str(uuid4())
        job_id = str(uuid4())
        core_outbox_event_id = str(uuid4())
        project.current_profile_version_id = profile_version_id
        project.current_promotion_target_version_id = promotion_version_id
        session.add_all(
            [
                WebsiteProfileVersion(
                    id=profile_version_id,
                    organization_id=project.organization_id,
                    workspace_id=workspace_id,
                    project_id=project.id,
                    version=project.context_version,
                    name=profile.name,
                    canonical_domain=profile.domain,
                    country_code=profile.country,
                    target_market=profile.target_market,
                    locale=profile.language,
                    products=list(profile.products),
                    input_required=list(input_required),
                    created_by=actor_id,
                ),
                PromotionTargetVersion(
                    id=promotion_version_id,
                    organization_id=project.organization_id,
                    workspace_id=workspace_id,
                    project_id=project.id,
                    version=project.context_version,
                    keywords=list(profile.keywords),
                    target_urls=list(profile.target_urls),
                    input_required=list(input_required),
                    created_by=actor_id,
                ),
                ProjectAuditEvent(
                    id=str(uuid4()),
                    organization_id=project.organization_id,
                    workspace_id=workspace_id,
                    project_id=project.id,
                    event_type=event_type,
                    context_version=project.context_version,
                    payload={
                        "profileVersionId": profile_version_id,
                        "promotionTargetVersionId": promotion_version_id,
                        "status": project.status,
                    },
                    actor_id=actor_id,
                ),
            ]
        )
        projection = WebsiteProjectService._projection_payload(
            project=project,
            profile=profile,
            profile_version_id=profile_version_id,
            promotion_target_version_id=promotion_version_id,
            input_required=input_required,
            job_id=job_id,
            outbox_event_id=core_outbox_event_id,
        )
        session.add(
            ProjectOutboxEvent(
                id=outbox_event_id,
                organization_id=project.organization_id,
                workspace_id=workspace_id,
                project_id=project.id,
                event_type="platform.website-project-context.changed.v1",
                aggregate_version=project.context_version,
                payload=projection,
                created_by=actor_id,
            )
        )
        return profile_version_id, promotion_version_id, outbox_event_id, projection

    async def create_project(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        legacy_project_id: str,
        legacy_project_key: str,
        authorized_project_ids: tuple[str, ...] | None,
        actor_id: str,
        profile: ProjectProfileInput,
    ) -> ProjectMutationResult:
        del authorized_project_ids
        normalized = normalize_profile(profile)
        project_id = str(uuid4())
        now = datetime.now(UTC)
        project = Project(
            id=project_id,
            organization_id=organization_id,
            workspace_id=workspace_id,
            project_key=self._project_key(normalized.domain, project_id),
            status="ACTIVE",
            name=normalized.name,
            domain=normalized.domain,
            country=normalized.country,
            target_market=normalized.target_market,
            language=normalized.language,
            health=0,
            context_version=1,
            created_at=now,
            updated_at=now,
        )
        try:
            async with self._sessions() as session, session.begin():
                await self._set_scope(session, organization_id)
                session.add(project)
                await session.flush()
                profile_id, promotion_id, outbox_id, projection = (
                    self._append_version_facts(
                        session,
                        project=project,
                        workspace_id=workspace_id,
                        profile=normalized,
                        actor_id=actor_id,
                        event_type="WEBSITE_PROJECT_CREATED",
                    )
                )
                await session.flush()
        except IntegrityError as error:
            raise ProjectConflictError(
                "A Website Project with this domain already exists in the organization."
            ) from error
        record = WebsiteProjectRecord(
            website_project_id=project.id,
            website_project_key=project.project_key,
            organization_id=organization_id,
            workspace_id=workspace_id,
            status=project.status,
            archived_at=None,
            name=normalized.name,
            domain=normalized.domain,
            country=normalized.country,
            target_market=normalized.target_market,
            language=normalized.language,
            health=0,
            context_version=1,
            profile_version_id=profile_id,
            promotion_target_version_id=promotion_id,
            products=normalized.products,
            keywords=normalized.keywords,
            target_urls=normalized.target_urls,
            input_required=_input_required(
                normalized.products,
                normalized.keywords,
                normalized.target_urls,
            ),
            created_at=now,
            updated_at=now,
        )
        return ProjectMutationResult(record, outbox_id, projection)

    async def _mutate_project(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        legacy_project_id: str,
        legacy_project_key: str,
        authorized_project_ids: tuple[str, ...] | None,
        project_key: str,
        actor_id: str,
        patch: ProjectProfilePatch | None,
        status: str | None,
        event_type: str,
    ) -> ProjectMutationResult | None:
        lookup_key = legacy_project_id if project_key == legacy_project_key else project_key
        try:
            async with self._sessions() as session, session.begin():
                await self._set_scope(session, organization_id)
                rows = await self._select_rows(
                    session,
                    organization_id=organization_id,
                    workspace_id=workspace_id,
                    legacy_project_id=legacy_project_id,
                    authorized_project_ids=authorized_project_ids,
                    project_key=lookup_key,
                    include_archived=True,
                )
                if len(rows) != 1:
                    return None
                project, profile_version, promotion_version, site_profile = rows[0]
                current = self._record(
                    project,
                    profile_version,
                    promotion_version,
                    site_profile,
                    workspace_id=workspace_id,
                    legacy_project_id=legacy_project_id,
                    legacy_project_key=legacy_project_key,
                )
                candidate = normalize_profile(
                    ProjectProfileInput(
                        name=patch.name if patch and patch.name is not None else current.name,
                        domain=patch.domain if patch and patch.domain is not None else current.domain,
                        country=patch.country if patch and patch.country is not None else current.country,
                        target_market=(
                            patch.target_market
                            if patch and patch.target_market is not None
                            else current.target_market
                        ),
                        language=(
                            patch.language
                            if patch and patch.language is not None
                            else current.language
                        ),
                        products=(
                            patch.products
                            if patch and patch.products is not None
                            else current.products
                        ),
                        keywords=(
                            patch.keywords
                            if patch and patch.keywords is not None
                            else current.keywords
                        ),
                        target_urls=(
                            patch.target_urls
                            if patch and patch.target_urls is not None
                            else current.target_urls
                        ),
                    )
                )
                project.name = candidate.name
                project.domain = candidate.domain
                project.country = candidate.country
                project.target_market = candidate.target_market
                project.language = candidate.language
                if status is not None:
                    project.status = status
                    project.archived_at = datetime.now(UTC) if status == "ARCHIVED" else None
                project.context_version += 1
                project.updated_at = datetime.now(UTC)
                profile_id, promotion_id, outbox_id, projection = (
                    self._append_version_facts(
                        session,
                        project=project,
                        workspace_id=workspace_id,
                        profile=candidate,
                        actor_id=actor_id,
                        event_type=event_type,
                    )
                )
                await session.flush()
                record = WebsiteProjectRecord(
                    website_project_id=project.id,
                    website_project_key=self._public_key(
                        project,
                        legacy_project_id,
                        legacy_project_key,
                    ),
                    organization_id=organization_id,
                    workspace_id=workspace_id,
                    status=project.status,
                    archived_at=project.archived_at,
                    name=candidate.name,
                    domain=candidate.domain,
                    country=candidate.country,
                    target_market=candidate.target_market,
                    language=candidate.language,
                    health=project.health,
                    context_version=project.context_version,
                    profile_version_id=profile_id,
                    promotion_target_version_id=promotion_id,
                    products=candidate.products,
                    keywords=candidate.keywords,
                    target_urls=candidate.target_urls,
                    input_required=_input_required(
                        candidate.products,
                        candidate.keywords,
                        candidate.target_urls,
                    ),
                    created_at=project.created_at,
                    updated_at=project.updated_at,
                )
        except IntegrityError as error:
            raise ProjectConflictError(
                "A Website Project with this domain already exists in the organization."
            ) from error
        return ProjectMutationResult(record, outbox_id, projection)

    async def update_project(self, **kwargs) -> ProjectMutationResult | None:
        return await self._mutate_project(
            **kwargs,
            status=None,
            event_type="WEBSITE_PROJECT_PROFILE_UPDATED",
        )

    async def archive_project(self, **kwargs) -> ProjectMutationResult | None:
        return await self._mutate_project(
            **kwargs,
            patch=None,
            status="ARCHIVED",
            event_type="WEBSITE_PROJECT_ARCHIVED",
        )

    async def restore_project(self, **kwargs) -> ProjectMutationResult | None:
        return await self._mutate_project(
            **kwargs,
            patch=None,
            status="ACTIVE",
            event_type="WEBSITE_PROJECT_RESTORED",
        )

    async def mark_projection(
        self,
        *,
        organization_id: str,
        project_id: str,
        outbox_event_id: str,
        published: bool,
        error: str | None = None,
    ) -> None:
        async with self._sessions() as session, session.begin():
            await self._set_scope(session, organization_id, project_id)
            event = await session.scalar(
                select(ProjectOutboxEvent).where(
                    ProjectOutboxEvent.id == outbox_event_id,
                    ProjectOutboxEvent.project_id == project_id,
                )
            )
            if event is None:
                return
            event.status = "published" if published else "failed"
            event.last_error = None if published else (error or "Backlinks Core unavailable")
            event.published_at = datetime.now(UTC) if published else None
