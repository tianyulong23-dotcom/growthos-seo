# Local Agent Test Database

Created on 2026-09-11 with user authorization.

- Database: `seo_agent_v11_test`, separate from business database `seo`.
- Uses the existing local PostgreSQL instance and persistent volume.
- No business rows, AI credentials or Gmail account records were copied.
- Platform Alembic head: `20260825_0066`.
- Schema prerequisites and database-local search path are initialized.
- Existing cluster roles are reused, not modified.
- No application connection settings or running services were changed.

From the repository root, initialize or upgrade again with:

```powershell
& backend/api/.venv/Scripts/python.exe backend/api/scripts/prepare_agent_test_database.py
```

The script fixes the host to loopback and database name to the test database.
It reads the local compose password without printing it, creates the database
only if absent, and runs the existing migrations. It never drops the database
or copies production data. Re-running it succeeded with zero project rows.
This prepares Platform/Agent tables, not the separate Backlinks Core migrations.

## Verification Boundary

Database creation, connection, migration and repeat initialization passed.
The two PostgreSQL Agent budget tests now reach their fixtures but fail because
their Project seed omits the current required workspace_id. Those test fixtures
must be updated to current project contracts before claiming integration tests
pass; database constraints were not weakened to accommodate outdated seeds.
The three Temporal takeover scenarios were not rerun in this database-setup task.
