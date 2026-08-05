# OpenAPI Contracts

`backlinks.v1.json` remains the Backlinks module source contract.
`seo4-platform-audit.v1.json` is the real FastAPI OpenAPI snapshot generated
from `john3947/seo` commit
`8261ea91a881948e3982a0eb96383c4c8bfa2523`. Its source blobs and document hash
are fixed in `seo4-platform-audit.v1.provenance.json`.

`platform.v1.json` is the generated public aggregate owned by the Platform
Gateway. It contains 88 paths and 97 operations:

- Platform Gateway health: 3 operations.
- Platform Project and settings routes: 17 operations.
- Audit routes: 18 operations.
- Agent routes: 13 operations.
- Keyword routes: 9 operations.
- Backlinks routes: 37 operations.

The aggregate uses the current FastAPI application rather than replaying the
older source snapshot, and excludes the private Backlinks `/health` route.
Imported operations retain their source
`operationId`, receive an `x-growthos-module` owner, and expose the canonical
Gateway `application/problem+json` 503 response.

The checker rejects duplicate method/path pairs, operation IDs, and conflicting
components. Byte-identical components are deduplicated. Generate or verify the
aggregate from `backend/api`:

```powershell
uv run --frozen python scripts/check_shared_contracts.py --write
uv run --frozen python scripts/check_shared_contracts.py
```
