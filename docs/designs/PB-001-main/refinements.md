# PB-001: Refinements to Send to Kindle MCP Server Architecture

This document catalogs specific issues found in the original `design.md` and the reasoning behind each proposed change. The refinements are grounded in two design disciplines: **Separation of Concerns** and **Tactical Domain-Driven Design**.

---

## Refinement 1: Introduce Explicit Domain Objects (Value Objects)

**Problem:** The design passes raw primitives (`string`, `Buffer`, `number`) between modules. The `title`, `author`, `content`, and `filename` are all bare strings with implicit constraints scattered across multiple modules. For example, title sanitization lives in the converter, but title validation lives in the tool handler. There is no single place where "what constitutes a valid title" is defined.

**Principle:** Tactical DDD -- Value Objects encapsulate validation and invariants. A value object is immutable, defined by its attributes, and self-validating. By making `Title`, `Author`, `MarkdownContent`, and `EpubDocument` into value objects, the invariants are enforced at construction time and cannot be bypassed.

**Change:** Introduce the following value objects in a `domain/` directory:

- `Title` -- validates non-empty, generates its own sanitized filename slug
- `Author` -- validates non-empty, applies default if absent
- `MarkdownContent` -- validates non-empty, enforces the 25 MB size limit
- `EpubDocument` -- wraps `Buffer` with `filename`, `sizeBytes`, and `title` metadata

This moves validation logic out of the tool handler (where it currently lives as procedural checks) and into the domain objects themselves. The tool handler becomes a thin adapter that constructs domain objects from raw input -- if construction succeeds, the data is valid.

---

## Refinement 2: Extract a Domain Service for the Delivery Pipeline

**Problem:** The tool handler currently owns orchestration (conversion then delivery), input validation, response formatting, AND tool registration. This is four distinct responsibilities in one module. The orchestration logic (convert-then-send) is a domain concern, but response formatting and tool registration are infrastructure concerns.

**Principle:** Separation of Concerns -- a module should have one reason to change. Tactical DDD -- Domain Services encapsulate operations that do not belong to a single entity or value object.

**Change:** Extract a `SendToKindleService` domain service that owns the pipeline:

```
SendToKindleService.execute(title: Title, content: MarkdownContent, author: Author): DeliveryResult
```

This service depends on a `Converter` interface and a `Mailer` interface (both defined in the domain layer). The tool handler becomes purely an adapter: it parses MCP input into domain objects, calls the service, and formats the result back into an MCP response. This separation means the domain pipeline can be tested without any MCP infrastructure, and the tool handler can be tested without any real conversion or delivery logic.

---

## Refinement 3: Define Domain Interfaces for Infrastructure Ports

**Problem:** The converter and mailer modules are defined with concrete implementations and library choices baked into their public APIs. The tool handler depends directly on these implementations. This means the domain orchestration logic is coupled to specific infrastructure decisions (nodemailer, marked, epub-gen-memory).

**Principle:** Separation of Concerns -- depend on abstractions, not concretions. Tactical DDD -- infrastructure implementations sit behind domain-defined interfaces (ports).

**Change:** Define two interfaces in the domain layer:

```typescript
// domain/ports.ts
interface ContentConverter {
  toEpub(title: Title, content: MarkdownContent, author: Author): EpubDocument;
}

interface DocumentMailer {
  send(document: EpubDocument): Promise<DeliveryResult>;
}
```

The concrete implementations (`MarkdownEpubConverter`, `SmtpMailer`) live in an `infrastructure/` directory and implement these interfaces. The domain service depends only on the interfaces. This makes testing trivial (inject fakes) and makes it possible to swap implementations without touching domain logic.

---

## Refinement 4: Introduce Domain Error Types Instead of String Categories

**Problem:** Errors are represented as string categories (`"VALIDATION_ERROR"`, `"SMTP_ERROR"`, etc.) with unstructured `details` strings. The tool handler must use string matching to determine error behavior. This is fragile and provides no compile-time safety.

**Principle:** Tactical DDD -- domain errors should be modeled as explicit types in the domain layer. Separation of Concerns -- error semantics belong to the domain, error formatting belongs to the adapter layer.

**Change:** Define a discriminated union of domain error types:

```typescript
type DomainError =
  | { kind: "validation"; field: string; message: string }
  | { kind: "conversion"; message: string }
  | { kind: "delivery"; cause: "auth" | "connection" | "rejection"; message: string }
  | { kind: "size_limit"; actualBytes: number; limitBytes: number };
```

The domain service returns `Result<DeliverySuccess, DomainError>` (a simple discriminated union, not a library). The tool handler maps these typed errors to the MCP response format. The mailer maps SMTP exceptions to `delivery` errors. The converter maps library exceptions to `conversion` errors. Each layer translates errors at its boundary rather than passing raw exceptions upward.

---

## Refinement 5: Restructure Project Layout to Reflect Architectural Layers

**Problem:** The current flat `src/` structure places all modules at the same level. There is no structural distinction between domain logic (conversion pipeline, validation rules) and infrastructure concerns (SMTP, MCP SDK integration, environment variable loading). A developer reading the directory listing cannot tell which modules are pure domain and which are infrastructure adapters.

**Principle:** Separation of Concerns -- the directory structure should mirror the architectural layers. Tactical DDD -- the domain layer is the core; infrastructure and application layers surround it.

**Change:** Reorganize into three layers:

```
src/
  domain/
    values/           # Value objects: Title, Author, MarkdownContent, EpubDocument
    errors.ts         # DomainError discriminated union
    ports.ts          # ContentConverter, DocumentMailer interfaces
    send-to-kindle-service.ts  # Domain service: orchestration
  infrastructure/
    converter/        # MarkdownEpubConverter implementation (marked, sanitize-html, epub-gen)
    mailer/           # SmtpMailer implementation (nodemailer)
    config.ts         # Environment variable loading
    logger.ts         # Structured logging
  application/
    tool-handler.ts   # MCP tool registration, input parsing, response formatting
  index.ts            # Entry point: wiring
```

The dependency rule is strictly enforced: `domain/` imports nothing from `infrastructure/` or `application/`. `application/` imports from `domain/`. `infrastructure/` implements `domain/` interfaces. `index.ts` wires everything together (composition root).

---

## Refinement 6: Move Filename Sanitization Into the Title Value Object

**Problem:** Filename sanitization is currently described as part of the converter module. But the sanitized filename is derived entirely from the title -- it has nothing to do with Markdown parsing, HTML sanitization, or EPUB packaging. Placing it in the converter means the converter has two reasons to change: EPUB format changes AND filename formatting changes.

**Principle:** Separation of Concerns -- filename derivation is a property of the title, not of the conversion process. Tactical DDD -- value objects should encapsulate all behavior derived from their data.

**Change:** The `Title` value object exposes a `toFilename(): string` method that produces the sanitized slug. The converter calls `title.toFilename()` when it needs a filename for the EPUB. This also makes filename generation independently testable as a unit test of the `Title` value object.

---

## Refinement 7: Make the Mailer Depend on EpubDocument, Not Raw Primitives

**Problem:** The mailer's current API is `send(title: string, attachmentBuffer: Buffer, filename: string)`. This is a "primitive obsession" anti-pattern -- three separate primitives that always travel together and represent a single concept (the document to deliver). If a fourth field were needed (e.g., author for the email subject), every call site and test would need updating.

**Principle:** Tactical DDD -- when multiple primitives always appear together, they should be a value object. Separation of Concerns -- the mailer should receive a cohesive document concept, not decomposed parts.

**Change:** The mailer accepts `EpubDocument` (which contains `buffer`, `filename`, `title`, and `sizeBytes`). This reduces the mailer's parameter surface and ensures the mailer always receives a structurally valid document.

---

## Refinement 8: Separate Configuration Shape From Configuration Loading

**Problem:** The configuration module currently combines two concerns: (1) the schema/shape of valid configuration, and (2) the mechanism for loading it from environment variables. If the system later needs to load configuration from a file, a secrets manager, or test fixtures, the loading mechanism changes but the shape does not.

**Principle:** Separation of Concerns -- the configuration contract (what is needed) is separate from the configuration source (where it comes from).

**Change:** Define a `Config` type in the domain layer (it is a domain concept -- the system's operational parameters). The `loadConfig()` function in `infrastructure/config.ts` is the one implementation that reads from `process.env` and returns a `Config`. Tests can construct `Config` objects directly without touching environment variables.

---

## Refinement 9: Composition Root Pattern for Wiring

**Problem:** The current design implies that modules import their dependencies directly (e.g., mailer imports config). This creates hidden coupling -- the mailer module contains both SMTP logic and a hard reference to the configuration module.

**Principle:** Separation of Concerns -- modules should receive their dependencies, not fetch them. Tactical DDD -- the composition root (entry point) is the only place that knows about all concrete implementations.

**Change:** `index.ts` becomes an explicit composition root:

1. Load config
2. Create logger
3. Create converter (implements ContentConverter)
4. Create mailer (implements DocumentMailer, receives SMTP config subset)
5. Create domain service (receives converter and mailer)
6. Create tool handler (receives domain service)
7. Register tool handler with MCP SDK transport

Each module receives only the dependencies it needs via constructor/factory parameters. No module imports another module directly. This makes the dependency graph explicit and inspectable in one file.

---

## Summary of Changes

| # | Refinement | Primary Principle |
|---|-----------|-------------------|
| 1 | Value objects for Title, Author, MarkdownContent, EpubDocument | Tactical DDD |
| 2 | Domain service for delivery pipeline | Separation of Concerns + Tactical DDD |
| 3 | Domain-defined interfaces (ports) for converter and mailer | Separation of Concerns |
| 4 | Typed domain errors instead of string categories | Tactical DDD |
| 5 | Layered project structure (domain / infrastructure / application) | Separation of Concerns |
| 6 | Filename sanitization in Title value object | Separation of Concerns + Tactical DDD |
| 7 | Mailer accepts EpubDocument, not raw primitives | Tactical DDD |
| 8 | Separate Config type from loading mechanism | Separation of Concerns |
| 9 | Composition root for dependency wiring | Separation of Concerns |
