# Shared Frontend Module Registration

> Task: `BL-AI-ARCH-007`
> Date: `2026-07-24`
> Status: repository implementation and local frontend acceptance `PROVEN`

## Registration Contract

The Platform frontend owns one module registration contract:

```ts
type PlatformModuleRegistration = {
  id: "audit" | "keywords" | "content" | "backlinks";
  routes: readonly RouteObject[];
  navigation: readonly NavigationItem[];
  requiredCapabilities: readonly string[];
};
```

`frontend/src/app/module-registry.ts` is the only shared composition point for
Audit, Keywords, Content, and Backlinks registrations. `frontend/src/App.tsx`
consumes registered routes, while the App Shell consumes registered navigation.
The registry does not import module mock data or module-private React state.

## Ownership Boundary

| Surface | Evidence | Ownership rule |
|---|---|---|
| `frontend/src/app/module-contract.ts` | `PROVEN`: defines the shared registration and navigation types | Platform frontend owns the contract |
| `frontend/src/app/module-registry.ts` | `PROVEN`: composes the four module registrations in the existing navigation order | Platform frontend owns registration only |
| `frontend/src/app/platform-navigation.ts` | `PROVEN`: composes module navigation with Performance and Settings | Platform frontend owns shared navigation |
| `frontend/src/app/project-context.ts` | `PROVEN`: contains the current prototype Project Context fixture | Platform Context owns the future authoritative contract; current data is non-authoritative |
| `frontend/src/pages/module-page.tsx` | `PROVEN`: contains only the shared header, tabs, redirect, and content slots | Shared shell cannot own module business state |
| `frontend/src/features/audit/**` | `PROVEN`: Audit registration, page state, and mock rows are isolated here | Audit owns module-private frontend behavior |
| `frontend/src/features/keywords/**` | `PROVEN`: Keywords registration, page state, and mock rows are isolated here | Keywords owns module-private frontend behavior |
| `frontend/src/features/content/**` | `PROVEN`: Content registration, page state, and mock rows are isolated here | Content owns module-private frontend behavior |
| `frontend/src/features/outreach/**` | `PROVEN`: Backlinks registration, page state, mock rows, and Gateway client are isolated here | Backlinks owns module-private frontend behavior |

The former cross-module `frontend/src/data/mock-data.ts` file is removed.
Module mocks are private to their feature directories. Shared pages and shell
components do not import feature mock modules.

## Route And Navigation Registration

| Module | Registered route root | First registered tab | Result |
|---|---|---|---|
| Audit | `audit/:view` | `audit/overview` | `PROVEN` |
| Keywords | `keywords/:view` | `keywords/library` | `PROVEN` |
| Content | `content/:view` | `content/opportunities` | `PROVEN` |
| Backlinks | `backlinks/:view` | `backlinks/projects` | `PROVEN` |

The existing information architecture is preserved: Audit, Keywords, Content,
Backlinks, and Performance remain the workspace navigation order. Website
Projects remain the first Backlinks tab at
`/projects/:projectId/backlinks/projects`; no separate main-navigation entry
was added.

## API Boundary

`frontend/src/api/client.ts` is the only frontend transport base and reads
`VITE_API_BASE_URL`, defaulting to `http://localhost:8000`. It exports the
shared `apiRequest` transport. The Backlinks client under
`frontend/src/features/outreach/api/client.ts` calls that transport and does
not define or call a private Fastify address.

Repository scans found one `VITE_API_BASE_URL` declaration, one default API
base, and one direct `fetch` implementation. No paid Provider endpoint was
called.

## Acceptance Evidence

- `PROVEN`: frontend `typecheck`, `lint`, and production `build` passed.
- `PROVEN`: `http://127.0.0.1:4174` returned HTTP 200 from listener PID 21288.
- `PROVEN`: Playwright opened Audit, Keywords, Content, Backlinks,
  Performance, and Settings routes at 1440 by 900 without horizontal overflow.
- `PROVEN`: Playwright opened Audit, Keywords, Content, and Backlinks at 390
  by 844 without horizontal overflow; the Website Projects tab remained
  present inside Backlinks.
- `PROVEN`: browser console errors were limited to two handled
  `GET http://localhost:8000/health` connection refusals because the local
  Platform Gateway was not running.
- `PROVEN`: screenshots are stored at
  `frontend/output/playwright/bl-ai-arch-007-desktop.png` and
  `frontend/output/playwright/bl-ai-arch-007-mobile.png`.

## Remaining Unknowns And Boundaries

- `UNKNOWN`: named human owners and review approvals for shared frontend and
  affected module paths.
- `UNKNOWN`: deployed Platform Gateway availability and authoritative Project
  Context backend implementation.
- No backend business code, database state, production service, paid Provider,
  Git commit, Git push, `BL-AI-ARCH-008`, or `BL-AI-074` was executed.
