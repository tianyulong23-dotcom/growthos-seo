# ADR-BL-0001: Backlinks Bounded Context

- Status: Accepted
- Date: 2026-07-21
- Scope: `backend/core/src/modules/backlinks`

## Context

The maintained product documents define one modular Core and one PostgreSQL
system of record. Within that Core, the backlinks module needs a strict boundary
so it does not recreate authentication, tenancy, project management, permissions,
secrets, tasks, notifications, reports, or other SEO modules.

The current repository also contains FastAPI, Python worker, Go crawler, and
Browser worker skeletons. They are migration evidence or conditional adapters;
they cannot become a second owner of backlinks facts.

This ADR fixes ownership and integration direction before any backlinks runtime,
route, table, workflow, or provider adapter is implemented.

## Decision

### Bounded context authority

`backend/core/src/modules/backlinks` is the sole application and domain owner for
backlinks-specific facts and decisions. Backlinks PostgreSQL tables are the
system of record for those facts, and backlinks domain services are the only
place that may decide their lifecycle transitions.

Temporal may schedule and replay work but is not a business system of record.
The frontend is a projection and command client; it must not own writable
backlinks state. Vendor SDKs and open-source components provide technical
capabilities behind Ports and never own business decisions.

Every tenant-owned backlinks fact must be scoped to `workspaceId` and, when
project-specific, `websiteProjectId`. A shared objective domain fact may be
reused only through an explicit evidence contract; contacts, messages, notes,
scores, decisions, and lifecycle state remain tenant-scoped.

### Owner

The backlinks bounded context owns:

| Capability | Owned facts and decisions |
|---|---|
| Recommendation and discovery | Recommendation context, prospects, domain evidence references, scoring evidence, readiness, deduplication, and user recommendation decisions |
| Contacts and opportunities | Contact evidence, contacts, opportunity creation, opportunity cycles, lifecycle state, and manual corrections |
| Assessment and drafting | Backlinks SEO evidence snapshots, model-run records, draft versions, approval invalidation, and human-edited content |
| Gmail outreach | Backlinks Gmail connection/binding metadata, sync checkpoints, send identities, immutable send snapshots, approvals, intents, attempts, results, replies, and reply matching; secret values remain upstream |
| Placement | Candidates, validation runs, placements, link occurrences, checks, link-state events, monitoring decisions, and manual overrides |
| Backlinks policy and governance | Backlinks suppression, progressive verification, send limits, capability and kill-switch enforcement records, provider usage/cost ledger, retention work, and audit metadata |
| Backlinks projections | Backlinks query projections, task suggestions, notification events, metrics, report revisions, and export records |

Only backlinks commands and domain services may change these facts. Activities,
adapters, HTTP handlers, Temporal history, and UI state cannot bypass that write
path.

### Non-owner

The backlinks bounded context does not own or implement:

| Upstream or adjacent capability | Boundary |
|---|---|
| Authentication and sessions | Receives a validated `ActorContext`; no user, account, login, password, session, or token lifecycle |
| Organization, Workspace, and Membership | Receives `TenantContext`; no CRUD, membership, role assignment, billing, or tenant lifecycle |
| WebsiteProject management | Receives `ProjectContext`; no WebsiteProject, WebsiteProfileVersion, PromotionTargetVersion, keyword, market, or project lifecycle CRUD |
| CurrentProjectContext and App Shell | Consumes the resolved project identity; no router, project selector, or global frontend state |
| Global authorization | Calls `PermissionPort`; roles are not interpreted as a replacement permission engine |
| Secret and KMS infrastructure | Calls `SecretStorePort` and persists references only; no plaintext Token, API key, or master key ownership |
| Global audit, tasks, notifications, and reports | Emits structured events or data through Ports; no duplicate platform framework or delivery channel |
| Commercial billing and subscriptions | Reads `QuotaDecisionPort`; provider usage accounting does not become commercial billing |
| SEO Audit, Keywords, Content, or global Performance | No implementation or shadow state |
| Provider infrastructure | AI, DataForSEO, Gmail, HTTP fetch, Browser rendering, and export implementations remain replaceable adapters |

### Upstream contracts

The host Core must provide the following validated inputs. Later implementation
tasks may encode them as schemas and Ports but must preserve this direction.

| Contract | Required boundary |
|---|---|
| `ActorContext` | `userId`, `sessionId`, and `roles`; identity is read-only and must be paired with server-side permission checks |
| `TenantContext` | `organizationId` and `workspaceId`; the module validates scope for every query, command, job, and side effect |
| `ProjectContext` | `websiteProjectId`, `canonicalDomain`, `locale`, `countryCode`, `profileVersionId`, and `promotionTargetVersionId`; the module may store version IDs and necessary evidence snapshots but cannot update project data |
| `PermissionPort` | Decides `backlinks.read`, recommendation, opportunity, draft, Gmail connection, send approval/execution, reply, placement, and settings actions |
| `SecretStorePort` | Resolves and rotates secret references without exposing plaintext to domain objects, logs, events, fixtures, or API responses |
| `AuditSinkPort` | Accepts structured backlinks audit events without transferring backlinks lifecycle ownership |
| `TaskSinkPort` | Accepts task suggestions/events; task completion cannot silently mutate backlinks facts |
| `NotificationSinkPort` | Accepts notification events; delivery-channel state is outside this context |
| `QuotaDecisionPort` | Returns platform or commercial quota decisions; backlinks still owns provider usage and side-effect enforcement records |
| `ObjectStorePort` | Stores scoped artifacts and returns references or short-lived access; object storage is not a business database |
| `ClockPort` | Supplies controlled time for policies, workflows, and tests |
| `AIProviderPort` | Supplies model capability only; model output is evidence or a draft candidate until validated and approved |

All Ports require explicit input/output schemas, timeout and error
classification, retry and idempotency rules, degradation behavior, and test
stubs. Missing or inconsistent Actor, Tenant, Project, or Permission context
fails closed before reading data or starting an external side effect.

Project pause, deletion, restoration, or version-change signals are consumed as
upstream events. They may stop backlinks side effects or start backlinks-owned
retention work, but they do not authorize the module to mutate the upstream
project.

### Legacy runtime exclusion

- `backend/api` must not expose formal backlinks routes alongside the new Core.
- `backend/workers` must not register `Backlink*Workflow` or
  `Backlink*Activity`.
- `backend/crawler` must not write Prospect, Contact, Opportunity, or Placement
  facts.
- `backend/browser-worker` may only become an isolated `BrowserRendererPort`
  adapter with no database credentials or business write permission.
- No old and new runtime may dual-write PostgreSQL, Outbox, Job, Opportunity,
  Send, Reply, or Placement state.

## Consequences

- Each entity, command, event, route, workflow, and table must be assignable to
  either backlinks ownership or an explicit upstream/adapter contract.
- Backlinks implementation depends on host-provided context and Ports instead of
  direct global-module CRUD or vendor imports.
- Upstream context outages or authorization ambiguity block the affected
  operation rather than falling back to frontend or cached writable state.
- Project version references and evidence snapshots add storage and event
  handling, but prevent backlinks jobs from silently changing meaning.
- The old runtime skeletons can remain during migration without becoming a
  parallel authority; their removal remains a separate gated task.
- This ADR adds no global module, route, database table, provider call, or
  runtime implementation.

## Rejected

### Let backlinks implement global Auth, Workspace, or WebsiteProject

Rejected because it creates duplicate identity and tenant authorities, expands
the module beyond its product scope, and makes cross-workspace isolation
ambiguous.

### Treat the frontend or Temporal history as the fallback system of record

Rejected because local UI state and workflow history cannot enforce durable
authorization, concurrency, audit, or PostgreSQL constraints.

### Allow old Python, Go, FastAPI, or Browser skeletons to share backlinks writes

Rejected because dual ownership permits conflicting lifecycle transitions,
duplicate side effects, and migrations that cannot be reconciled safely.

### Let provider SDK objects cross into the domain

Rejected because vendor DTOs, retries, and statuses would become hidden business
rules and make adapters non-replaceable.

### Rebuild global tasks, notifications, reports, permissions, or secrets inside backlinks

Rejected because these are upstream platform capabilities. Backlinks emits or
consumes explicit contracts and retains ownership only of backlinks facts.
