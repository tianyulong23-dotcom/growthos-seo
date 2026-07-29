# ADR-BL-0003: Shared Repository Deployment Topology

## Status

Accepted by `BL-AI-ARCH-002`.

## Date

2026-07-23

## Context

The repository hosts more than the Backlinks product area. Content, Keywords,
Website Audit, and Backlinks may have different owners, delivery schedules, and
runtime choices.

ADR-BL-0002 selected TypeScript/Fastify for the Backlinks Core and described it
as a plugin in one shared Core API process. That remains a valid Backlinks
runtime decision, but the single-process deployment assumption is not proven
for the shared repository.

`BL-AI-ARCH-001` established the current repository facts:

- `backend/api` is a Python/FastAPI application and currently exposes only
  `GET /health`;
- `backend/core` is a TypeScript/Fastify Backlinks package;
- `backend/core/src/index.ts` is not a service bootstrap and no shared
  Python/Node plugin host exists;
- no Platform API or Backlinks API is currently listening;
- the frontend has one configured API base and must not gain a second one.

The platform must avoid:

- forcing every module into one language or process;
- exposing multiple public API bases to the browser;
- implementing Backlinks commands in both FastAPI and Fastify;
- sharing database credentials that allow cross-module writes;
- using one unowned route, workflow, or frontend file as a merge hotspot.

## Decision

### One public platform gateway

The browser and external clients use one public Platform Gateway.

The gateway owns:

- authentication;
- Organization, Workspace, Website Project, and membership resolution;
- permission pre-decision;
- correlation, rate limiting, and the public error envelope;
- route dispatch;
- aggregate OpenAPI and platform health.

The gateway does not own Backlinks business facts and must not write Backlinks
tables directly.

### Backlinks remains the domain authority

The existing TypeScript/Fastify Backlinks Core remains the sole implementation
of Backlinks commands, lifecycle transitions, database writes, domain audit,
outbox, cost gates, and workflow policies.

### Selected topology: cross-process private service

The accepted topology is:

```text
Browser / CLI / external integration
  -> FastAPI Platform Gateway (the only public API)
    -> private authenticated HTTP/JSON
      -> Fastify Backlinks Domain Core API
        -> Backlinks PostgreSQL role/schema

Backlinks Temporal Worker
  -> Backlinks application/domain code
  -> Backlinks PostgreSQL role/schema
```

FastAPI and Fastify run in separate processes. The choice follows the verified
Python and Node.js runtimes and avoids creating an unsupported cross-language
in-process plugin mechanism. It does not authorize a microservice split inside
the Backlinks bounded context.

`backend/api` is the current Platform Gateway implementation path.
`backend/core` remains the current Backlinks package path until
`BL-AI-ARCH-003` decides path ownership. This decision assigns runtime roles;
it does not claim that either current skeleton is already deployable.

### Public and private exposure

- FastAPI Platform Gateway owns the only browser/external API base.
- Fastify Backlinks Core has no public ingress, public DNS, browser CORS, or
  browser-held service credential.
- A local Backlinks listener, when implemented, binds only to an explicitly
  private interface and is reached only through the gateway or controlled
  service tests.
- Public `GET /health` belongs to the Platform Gateway and represents platform
  health.
- Backlinks service health remains private. The current Backlinks `/health`
  contract is excluded from the public aggregate or renamed during
  `BL-AI-ARCH-006`; it does not create a second public `/health`.

### FastAPI and Fastify responsibilities

| Responsibility | FastAPI Platform Gateway | Fastify Backlinks Core |
|---|---|---|
| Public TLS/API ingress | Owns | Prohibited |
| Authentication/session validation | Owns | Trusts only authenticated internal context |
| Organization, Workspace, Website Project, and membership resolution | Owns authoritative platform lookup | Verifies supplied context and Backlinks resource ownership |
| Permission handling | Performs platform pre-decision | Performs final domain/resource/RLS authorization |
| Public rate limit, correlation ID, and error envelope | Owns | Preserves correlation and returns stable module errors |
| Backlinks command/state-machine execution | Prohibited | Sole owner |
| Backlinks SQL, lifecycle, audit, outbox, and usage writes | Prohibited | Sole owner |
| Backlinks OpenAPI | Aggregates the module contract | Generates the module contract |
| Backlinks Worker/Temporal execution | Does not host | Backlinks Worker owns |

### Internal invocation contract

The gateway-to-Backlinks hop is versioned private HTTP/JSON.

- The gateway strips any browser-supplied internal context headers.
- The gateway produces an integrity-protected `PlatformRequestContext`.
- Backlinks validates contract version, integrity, expiry, audience, resource
  ownership, role, RLS, expected version, idempotency, and domain rules.
- The gateway forwards one correlation ID and maps transport failures into the
  public error envelope without inventing a business result.
- The gateway does not automatically replay a write unless the operation has
  the required idempotency contract.
- Exact context fields and producer/consumer tests belong to
  `BL-AI-ARCH-004`; aggregate OpenAPI and route-conflict enforcement belong to
  `BL-AI-ARCH-006`.

### Public proxy routes are allowed; duplicate business routes are not

ADR-BL-0001's legacy exclusion is clarified:

- a Platform Gateway proxy/adapter may expose the public Backlinks route;
- only the Backlinks Core may implement the associated command;
- a legacy backend must not contain a second state machine, SQL write path,
  lifecycle, or audit implementation for the same command.

### Platform context

The gateway produces a versioned, integrity-protected
`PlatformRequestContext`. The Backlinks Core consumes it and still enforces
resource ownership, role, RLS, expected version, idempotency, and domain rules.

Browser-supplied tenant or project headers are never trusted as platform
context.

### Public route ownership

The Platform Gateway is the public owner of every
`/api/v1/projects/{websiteProjectKey}/backlinks/**` method/path. Backlinks Core
is the domain owner and private internal target. The canonical method-level
table is `docs/architecture/shared-module-ownership.md`.

FastAPI may implement only a gateway adapter for these routes. It may not
contain a second Backlinks command handler, state machine, repository, SQL
write, lifecycle, audit, outbox, usage ledger, or Temporal workflow.

### Shared infrastructure isolation

When infrastructure is shared:

- PostgreSQL uses module schemas and write roles;
- Temporal uses module task queues and workflow ID prefixes;
- provider secrets are available only to the owning module;
- events and OpenAPI documents are versioned and namespaced;
- reporting access is read-only.

### Current path

`backend/core` is treated as the current Backlinks package path until
`BL-AI-ARCH-003` confirms ownership. A possible move to
`backend/services/backlinks-core` must be a separate, reviewable change and must
not rewrite migration history.

## Consequences

Positive:

- Backlinks keeps its implemented TypeScript domain and security controls;
- other modules can retain their suitable runtimes;
- the browser sees one coherent product API;
- module owners can upload independently with explicit shared boundaries;
- database and workflow collisions are testable.

Costs:

- an internal context contract is required;
- aggregate OpenAPI and route ownership need automated checks;
- cross-process deployment adds timeout and observability requirements;
- shared frontend files need joint review.
- Platform availability is required for all public Backlinks requests.

## Rejected Alternatives

### Rewrite all modules into TypeScript

Rejected because language uniformity does not justify replacing working,
owned module implementations.

### Rewrite Backlinks into Python/FastAPI

Rejected because it would discard completed domain, security, cost, workflow,
and test work without a product requirement.

### Let the browser call every module directly

Rejected because authentication, tenant resolution, public contracts, and
failure handling would diverge.

### Load Backlinks into the FastAPI process

Rejected because the verified gateway and Backlinks implementations use Python
and Node.js, and the repository contains no safe shared in-process plugin host.
Adding an embedding or foreign-function bridge would add coupling without a
product requirement.

### Expose Fastify publicly beside FastAPI

Rejected because it creates two browser API bases, duplicate public route
ownership, divergent authentication, and a path to dual implementation.

### Let the gateway write every module's database

Rejected because it creates a second domain implementation and removes
bounded-context ownership.

### One shared database role

Rejected because a defect or migration in one module could mutate another
module's facts.

## Supersession

If accepted, this ADR supersedes only the deployment topology and legacy
backend interpretation in ADR-BL-0002. ADR-BL-0002's TypeScript/Fastify,
PostgreSQL, Temporal, Drizzle, and explicit-composition decisions remain valid
for the Backlinks Core unless separately superseded.

It clarifies, but does not replace, ADR-BL-0001's Backlinks bounded-context
ownership.

## Acceptance Evidence

- `docs/architecture/shared-backend-inventory.md` proves the current Python and
  Node.js runtime split, entrypoints, listeners, and frontend API behavior.
- `docs/architecture/shared-module-ownership.md` records one public owner and
  one domain owner for every current Backlinks method/path.
- The shared-repository supplements require one public gateway, module-owned
  writes, and no browser-direct internal service.

The ADR is accepted before implementation. `PlatformRequestContext` tests,
database role isolation, aggregate OpenAPI conflict tests, Temporal namespace
inventory, and the `BL-AI-001` through `BL-AI-073` compatibility report remain
later `SHARED-REPO-GATE` work and are not evidence claimed by this task.
