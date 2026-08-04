# Backend Entrypoint Inventory

> Task: `BL-AI-001`
> Inventory date: `2026-07-21`
> Scope: existing Python, Go, TypeScript, and Browser backend skeletons only

## Ownership rule

The repository does not contain `CODEOWNERS` or another named maintainer record for
these backend directories. The Owner column therefore records architectural
ownership from the current README files and the V1.2 plan; it does not infer a
person from Git authorship.

## Entrypoints

| Runtime / directory | Entrypoint and launch command | Owner | Current purpose | Port | Keep? |
|---|---|---|---|---|---|
| Python FastAPI: `backend/api/` | `app/main.py`; `uv run uvicorn app.main:app --reload` | Legacy platform API skeleton; not Backlinks Core | Exposes the current `/health` route and contains placeholder database, cache, and Temporal clients | `8000/TCP` inbound by the documented Uvicorn default | **Temporary yes.** Keep `/health` during OSS-00 as legacy evidence. It must not receive formal backlinks routes or own backlinks facts. Remove only in a later dedicated task after Core health, smoke, contract, and frontend cutover gates pass and no other team owns it. |
| Python workers: `backend/workers/` | `src/seo_workers/__main__.py`; `uv run python -m seo_workers --list` | No written module owner; backlinks workflows are owned by the future TypeScript Core worker | CLI registry listing `analysis`, `ai`, `integration`, and `publish`; it does not currently start a Temporal worker | No inbound listener; `7233/TCP` is only the configured Temporal endpoint elsewhere and is not used by this CLI entry | **Conditional.** Keep unchanged for now. It may remain only if another module supplies a written owner; it must not register `Backlink*Workflow` or `Backlink*Activity`. |
| Go crawler: `backend/crawler/` | `cmd/crawler/main.go`; `go run ./cmd/crawler` | Platform crawler candidate; explicitly not owned by the backlinks module | Starts a process that logs lifecycle state and waits for shutdown; current implementation has no crawl transport or business writes | None | **Conditional.** Keep unchanged as a platform candidate, but do not include it in the backlinks release without a platform-level crawler ADR. It must not write Prospect, Contact, or Placement facts. |
| TypeScript Browser worker: `backend/browser-worker/` | `src/worker.ts`; no runnable `start` script exists in `package.json` | Conditional `BrowserRendererPort` adapter; business decisions remain in Backlinks Core | Declares render, DOM snapshot, and screenshot capabilities; current code is a capability module plus a unit test, not a running worker | None | **Conditional.** Keep unchanged for the future isolated renderer evaluation. It must have no database credentials or business write permission. Delete only in a later dedicated task if the Playwright capability remains disabled and no other module uses it. |

## Findings

- No standalone TypeScript backend/Core entrypoint exists yet; `backend/core/` was
  absent before this task.
- The running `http://127.0.0.1:4174/` process is the Vite frontend, not a backend
  entrypoint. It returned HTTP `200` during this inventory.
- The frontend API client defaults to `http://localhost:8000`, which currently
  points at the legacy FastAPI skeleton.
- No files or directories from the existing skeletons were deleted or modified by
  `BL-AI-001`.

## Evidence inspected

- `README.md`
- `backend/README.md`
- `backend/api/README.md`, `backend/api/pyproject.toml`,
  `backend/api/app/main.py`
- `backend/workers/README.md`, `backend/workers/pyproject.toml`,
  `backend/workers/src/seo_workers/__main__.py`
- `backend/crawler/README.md`, `backend/crawler/go.mod`,
  `backend/crawler/cmd/crawler/main.go`
- `backend/browser-worker/README.md`, `backend/browser-worker/package.json`,
  `backend/browser-worker/src/worker.ts`
- `frontend/src/api/client.ts`
- V1.2 sections 23.1 and OSS-00
