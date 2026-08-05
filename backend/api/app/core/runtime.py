from dataclasses import dataclass

from httpx import AsyncClient
from sqlalchemy import text
from temporalio.client import Client

from app.core.config import Settings
from app.db.session import engine


@dataclass
class RuntimeDependencies:
    settings: Settings
    temporal: Client | None = None
    core_client: AsyncClient | None = None

    async def start(self) -> None:
        if not self.settings.runtime_dependency_checks_enabled:
            return
        try:
            self.core_client = AsyncClient(
                base_url=self.settings.backlinks_private_base_url,
                timeout=self.settings.runtime_dependency_timeout_seconds,
            )
            await self._check_database()
            self.temporal = await Client.connect(self.settings.temporal_address)
            await self._check_temporal()
            await self._check_core()
        except Exception:
            await self.close()
            raise

    async def check(self) -> None:
        if not self.settings.runtime_dependency_checks_enabled:
            return
        await self._check_database()
        await self._check_temporal()
        await self._check_core()

    async def close(self) -> None:
        if self.core_client is not None:
            await self.core_client.aclose()
        await engine.dispose()

    async def _check_database(self) -> None:
        async with engine.connect() as connection:
            result = await connection.execute(
                text(
                    """
                    SELECT current_setting('server_version_num')::integer,
                           login.rolcanlogin,
                           login.rolsuper,
                           login.rolbypassrls,
                           current_setting('row_security') = 'on',
                           to_regclass('platform.projects')::text,
                           to_regclass('backlinks.backlink_project_context_snapshots')::text
                      FROM pg_roles AS login
                     WHERE login.rolname = current_user
                    """
                )
            )
            (
                server_version,
                can_login,
                is_superuser,
                bypass_rls,
                row_security_enabled,
                projects_table,
                context_table,
            ) = result.one()
        if not can_login or is_superuser or bypass_rls or not row_security_enabled:
            raise RuntimeError("DATABASE_ROLE_PREREQUISITE_FAILED")
        if int(server_version) < 180_000 or projects_table is None or context_table is None:
            raise RuntimeError("DATABASE_MIGRATION_PREREQUISITE_FAILED")

    async def _check_temporal(self) -> None:
        if self.temporal is None:
            raise RuntimeError("TEMPORAL_CLIENT_NOT_CONNECTED")
        healthy = await self.temporal.service_client.check_health()
        if not healthy:
            raise RuntimeError("TEMPORAL_NOT_READY")

    async def _check_core(self) -> None:
        if self.core_client is None:
            raise RuntimeError("BACKLINKS_CORE_CLIENT_NOT_CONNECTED")
        response = await self.core_client.get("/ready")
        response.raise_for_status()
