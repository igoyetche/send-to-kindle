# ADR: send-to-kindle

**Status:** Accepted
**Date:** 2026-03-03

## Context

A single-user MCP server that lets Claude (or any MCP client) send Markdown content to a Kindle device. The user asks Claude to summarize or generate content, Claude invokes the `send_to_kindle` tool, and the system converts Markdown to EPUB and emails it to the configured Kindle address — all in a single tool call with no manual steps.

The system must:
- Accept Markdown input only, produce EPUB output only
- Deliver via SMTP email to Amazon's Send to Kindle service
- Support both local (stdio) and remote (HTTP/SSE) MCP transports
- Run as a containerized application on x86_64 and ARM64

The spec is defined in `spec.md`. The full design review produced `design.md` (initial), `refined.md` (refined), and `critique.md` (critique).

## Decision

### Architecture: Three-Layer Design

The system uses a three-layer architecture with strict dependency direction:

```
Application Layer  →  Domain Layer  ←  Infrastructure Layer
```

The domain layer imports nothing from infrastructure or application.

### Domain Layer

**Value Objects** (immutable, self-validating):
- `Title` — validates non-empty. Does NOT generate filenames (that's infrastructure).
- `Author` — takes a single required string. Default resolution happens in the ToolHandler before construction.
- `MarkdownContent` — validates non-empty, enforces 25 MB size limit at construction.
- `EpubDocument` — wraps `Buffer` with `title` metadata. `sizeBytes` is a derived getter from `buffer.length`, not a constructor parameter.

**Domain Service:**
- `SendToKindleService` — orchestrates convert-then-deliver pipeline. Receives a logging port, `ContentConverter` port, and `DocumentMailer` port via constructor injection.

**Port Interfaces:**
- `ContentConverter.toEpub(title, content, author): Promise<EpubDocument>` — async, since `epub-gen-memory` returns `Promise<Buffer>`.
- `DocumentMailer.send(document): Promise<Result<void, DeliveryError>>` — returns Result type, not exceptions.
- `DeliveryLogger` — logging port injected into the domain service.

**Error Handling — Result Types:**
- Domain errors use `Result<T, DomainError>` return types instead of thrown exceptions.
- `DomainError` is a discriminated union: `ValidationError | SizeLimitError | ConversionError | DeliveryError`.
- This provides compile-time exhaustiveness checking at every call site.
- The ToolHandler maps `DomainError` variants to MCP response format in a single `switch` on `error.kind`.

**No Config in Domain:**
- The `Config` type lives in infrastructure alongside `loadConfig()`. The domain layer has no knowledge of SMTP settings, HTTP ports, or environment variables.

### Infrastructure Layer

**MarkdownEpubConverter** (implements `ContentConverter`):
- Pipeline: Markdown → `marked.parse()` → `sanitize-html` → `epub-gen-memory` → `EpubDocument`
- Uses `epub-gen-memory` via its `EPub` named export: `new EPub(options, chapters).genEpub()` returns `Promise<Buffer>`. The package default export is not callable.
- Generates the sanitized filename (URL-safe slug + `.epub`) when constructing `EpubDocument`
- Library: `epub-gen-memory` (in-memory, async, EPUB 3.0, TypeScript)

**SmtpMailer** (implements `DocumentMailer`):
- Receives only its SMTP/email config subset, not the full `Config`
- Returns `Result<void, DeliveryError>` with categorized errors: `auth`, `connection`, `rejection`
- Implements retry strategy with configurable timeout and retry count
- Explicit connection and socket timeouts (prevents indefinite hangs)
- Library: `nodemailer`

**Configuration** (`loadConfig()`):
- Loads from environment variables, fail-fast on missing required values
- Validates email format for `KINDLE_EMAIL` and `SENDER_EMAIL` at startup
- Enforces: if `MCP_HTTP_PORT` is set, `MCP_AUTH_TOKEN` must also be set
- Coerces `SMTP_PORT` to number

**Logger:**
- Standard structured logger (`pino`) used directly — no custom logging wrapper
- Configured to write to stderr (`pino.destination(2)`) — stdout is reserved for JSON-RPC when using stdio transport
- Credential safety ensured by architecture: credentials never reach log call sites

### Application Layer

**ToolHandler** (MCP adapter):
- Registers `send_to_kindle` tool with MCP SDK including tool description and parameter descriptions
- Resolves author default from config before constructing the `Author` value object
- Parses MCP input → constructs domain value objects → calls `SendToKindleService` → maps Result to MCP response
- Single place where `DomainError` variants are translated to protocol-level responses

**Transport:**
- stdio by default; HTTP/SSE when `MCP_HTTP_PORT` is set; both can run simultaneously
- Bearer token authentication for HTTP/SSE via `MCP_AUTH_TOKEN`

### Composition Root (`index.ts`)

Explicit dependency wiring:
1. `loadConfig()` → Config
2. Create logger (pino)
3. Create `MarkdownEpubConverter` → implements `ContentConverter`
4. Create `SmtpMailer(config.smtp, config.kindle, config.sender)` → implements `DocumentMailer`
5. Create `SendToKindleService(converter, mailer, logger)`
6. Create `ToolHandler(service, config.defaultAuthor, logger)`
7. Register with MCP SDK, attach transports

### Container

- Multi-stage Docker build: TypeScript compilation → production image with compiled JS only
- Base image: `node:22-alpine` (x86_64 + ARM64)
- No volume mounts — all state is transient (in-memory EPUB generation)

### Project Structure

```
send-to-kindle-mcp/
  src/
    domain/
      values/
        title.ts
        author.ts
        markdown-content.ts
        epub-document.ts
        index.ts
      errors.ts
      ports.ts
      send-to-kindle-service.ts
    infrastructure/
      converter/
        markdown-epub-converter.ts
      mailer/
        smtp-mailer.ts
      config.ts
      logger.ts
    application/
      tool-handler.ts
    index.ts
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
```

Test structure is not prescribed — it will evolve organically during implementation.

## Consequences

### Positive

- Clean separation: conversion, delivery, and MCP protocol are fully independent
- Domain layer is testable without any infrastructure — fakes for converter and mailer
- Result types provide compile-time exhaustiveness checking for all error paths
- Value objects enforce invariants once, at construction — no scattered validation
- In-memory EPUB generation works well in containers (no temp files, no cleanup)
- Composition root makes the full dependency graph visible in one file
- Fail-fast config with email validation catches misconfigurations at startup

### Negative

- Three-layer architecture adds indirection for what is a small system
- Result types add verbosity compared to try/catch
- `SendToKindleService` is thin — currently just convert-then-deliver with logging

### Mitigations

- The layers are small (most modules are single files) — indirection cost is low
- Result type verbosity pays off with type safety at every boundary
- The domain service already justifies itself with logging port injection and will be the natural home for future orchestration (preview mode, multiple devices)

## Alternatives Considered

### Original Design (design.md)

Flat module structure with raw primitives, string-based error categories, synchronous converter port, and all orchestration in the tool handler.

**Why refined:** Primitives scattered validation across modules, string errors provided no type safety, sync port couldn't work with `epub-gen-memory`, and the tool handler had too many responsibilities (validation, orchestration, response formatting, tool registration).

### Rejected Approaches

None — all 15 critique findings were accepted. Key decisions:
- Result types chosen over class-based exceptions (Finding 4)
- Logging port injected into domain service rather than kept in ToolHandler (Finding 5)
- SMTP retries added rather than deferred (Finding 7)
- Standard logger chosen over custom wrapper (Finding 14)

## Open Issues

- **OQ-1** (Amazon email bounces): Accept "email dispatched" as success. Bounce detection is asynchronous and outside system control.
- **OQ-4** (Preview capability): Deferred to a future version. Architecture supports it trivially via a service that calls converter but not mailer.
- **OQ-5** (Multiple Kindle addresses): Single address for v1.
- **Retry strategy details**: Exact retry count, backoff strategy, and timeout values to be determined during implementation.

## Process Improvements

### Corrections Made

- **Architect assumed synchronous EPUB generation** — the suggested library (`epub-gen-memory`) is async. This was caught by the Critique but should have been caught by the Architect when specifying library choices. *Improvement: when the Architect recommends a specific library, verify its API contract matches the interface being designed.*
- **Implementation used wrong `epub-gen-memory` entry point** — the default export is an object, not a callable function. The correct API is the named `EPub` constructor: `new EPub(options, chapters).genEpub()`. The error was swallowed by a `try/catch` and returned as a `ConversionError`, causing silent failures that the test suite did not catch because tests only asserted `result.ok === true` without verifying the failure path. *Improvement: tests should assert the error path explicitly (e.g., `if (!result.ok) throw new Error(result.error.message)`) so silent failures surface immediately.*
- **Refiner placed Config in domain** — operational parameters (SMTP settings, HTTP ports) are not domain concepts. The Refiner applied "separate shape from loading" correctly but put the shape in the wrong layer. *Improvement: the Refiner should apply a litmus test — "would a domain expert recognize this concept?" — before placing types in the domain layer.*
- **Refiner modeled errors as discriminated union but used throw** — mixed two incompatible patterns. *Improvement: when introducing typed errors, the Refiner should specify the propagation mechanism (Result vs exceptions) at the same time, not leave it implicit.*

### Proposed Improvements

- Architect should verify async/sync contracts of recommended libraries against port interfaces
- Refiner should apply "domain expert" litmus test for domain layer placement decisions
- Refiner should pair error type design with error propagation mechanism
