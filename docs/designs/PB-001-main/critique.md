# PB-001 Critique: Send to Kindle MCP Server

Reviewed: docs/design-reviews/send-to-kindle/refined.md

## CRITICAL

### Config type does not belong in the domain layer

- **What's wrong:** The design places `Config` in `domain/config.ts`, stating it "represents the system's operational parameters." But `Config` contains SMTP host/port/credentials, HTTP port, auth tokens, and log levels. None of these are domain concepts. The domain is about converting content and delivering documents -- it has no business knowing about SMTP connection strings, HTTP ports, or log levels. Placing `Config` in the domain layer violates the dependency rule the design itself declares: "the domain layer has zero imports from infrastructure or application."
- **Why it matters:** Any module that imports from `domain/` now gets access to infrastructure configuration concerns. The domain layer becomes polluted with operational details. Worse, it creates a temptation to pass `Config` directly into domain services, coupling them to infrastructure shape.
- **Suggested fix:** Move the `Config` type to infrastructure where `loadConfig()` lives. The domain layer should not define or know about the config shape. Infrastructure modules receive only the specific parameters they need (which `SmtpMailer` already does correctly with `SmtpMailerConfig`).

### ContentConverter.toEpub() is synchronous but EPUB generation is async

- **What's wrong:** The `ContentConverter` port interface declares `toEpub()` as a synchronous method returning `EpubDocument`. However, `epub-gen-memory` (the suggested library) is asynchronous -- it returns a `Promise<Buffer>`. The `MarkdownEpubConverter` implementation cannot fulfill a synchronous interface if its underlying library is async.
- **Why it matters:** This will cause a compilation error or force the implementor to use a different library. If worked around with synchronous alternatives, it constrains library choices unnecessarily. If the port is left as-is, the implementation will not satisfy the interface contract.
- **Suggested fix:** Change the port signature to `toEpub(...): Promise<EpubDocument>` and update `SendToKindleService.execute()` to `await` it.

## HIGH

### EpubDocument has redundant sizeBytes field

- **What's wrong:** `EpubDocument` stores both `buffer: Buffer` and `sizeBytes: number` as separate constructor parameters. `sizeBytes` is always derivable from `buffer.length`. This creates a possible inconsistency: nothing prevents constructing `new EpubDocument(title, buffer, 999)` where `999 !== buffer.length`.
- **Why it matters:** Impossible states should be unrepresentable. Two sources of truth for the same fact (buffer size) is a bug waiting to happen, especially since `sizeBytes` flows into the `DeliverySuccess` response sent to clients.
- **Suggested fix:** Remove the `sizeBytes` constructor parameter. Derive it as a getter: `get sizeBytes(): number { return this.buffer.length; }`.

### Domain errors are thrown as exceptions but modeled as a discriminated union

- **What's wrong:** The design models errors as a discriminated union (`type DomainError = ValidationError | SizeLimitError | ...`) but uses `throw` for control flow. In TypeScript, `throw` erases type information -- a `catch` block receives `unknown`, not `DomainError`. The carefully typed discriminated union provides no compile-time safety at the catch site. The `mapErrorToResponse` function with its `switch` on `error.kind` will require runtime type guards or unsafe casting.
- **Why it matters:** The primary advantage of a discriminated union is exhaustiveness checking. When errors are thrown and caught, TypeScript cannot verify that all variants are handled. The design pays the complexity cost of the union without getting its main benefit.
- **Suggested fix:** Either (a) use a `Result<T, DomainError>` return type instead of exceptions to get actual type safety, or (b) keep exceptions but drop the pretense of a discriminated union -- just use a base class with subclasses and `instanceof` checks, which is the natural pattern for thrown errors in TypeScript.

### Logger is called from ToolHandler but not from SendToKindleService

- **What's wrong:** The design shows the `ToolHandler` invoking `logger.logDeliverySuccess(...)` and `logger.logDeliveryFailure(...)`. But logging delivery attempts is an infrastructure/operational concern being handled in the application layer adapter. The `SendToKindleService` (the actual orchestrator) has no awareness of logging. This means if the service is ever called from a different entrypoint (the design mentions a future `PreviewService`), logging must be duplicated.
- **Why it matters:** Cross-cutting concerns attached to the wrong layer must be manually replicated for every new consumer of the domain service.
- **Suggested fix:** Either inject a logging port into `SendToKindleService`, or accept this as a pragmatic choice for a single-tool system and document the trade-off explicitly.

## MEDIUM

### Author value object takes defaultAuthor as constructor parameter

- **What's wrong:** `Author` accepts `(raw: string | undefined, defaultAuthor: string)` in its constructor. Value objects should be self-contained and not require external configuration to construct. The default author is a configuration concern that leaks into the domain. This makes `Author` context-dependent -- the same `undefined` input produces different `Author` values depending on who constructs it.
- **Why it matters:** Value object identity should depend solely on its attributes. Injecting a config default into construction muddies the boundary between "what the user provided" and "what the system defaulted to." It also makes testing harder -- every test must supply a default.
- **Suggested fix:** Resolve the default in the `ToolHandler` before constructing the value object: `const author = new Author(params.author ?? config.defaultAuthor)`. The `Author` constructor should take a single required string.

### No retry or timeout strategy for SMTP delivery

- **What's wrong:** The design specifies error categorization (auth, connection, rejection) but says nothing about timeouts or retries. SMTP connections can hang indefinitely. `nodemailer` defaults vary by version.
- **Why it matters:** A hanging SMTP connection will block the MCP tool call indefinitely. The MCP client has no way to cancel it. For a single-user tool, this means the entire server becomes unresponsive.
- **Suggested fix:** Specify an explicit connection timeout (e.g., 30 seconds) and socket timeout in `SmtpMailerConfig`. Document that retries are not implemented in v1 and why (single attempt is sufficient for a single-user tool; the user can retry manually).

### The "menu test" on SendToKindleService

- **What's wrong:** The design places `SendToKindleService` in the domain layer as the orchestrator. Applying the menu test: "Send to Kindle" is absolutely something a user would recognize as an action. However, the service does nothing beyond calling two interfaces in sequence. It is a two-line method with no conditional logic, no invariant enforcement, and no domain rules beyond "convert then send."
- **Why it matters:** This is not wrong per se, but it is worth acknowledging that the service is a pass-through. If the pipeline never gains conditional logic (e.g., "skip delivery for preview"), the service adds indirection without adding value. The `ToolHandler` could call `converter` then `mailer` directly.
- **Suggested fix:** Keep the service (it is the right place for future orchestration logic like preview mode), but acknowledge in the design that its current value is structural, not behavioral.

### Missing validation on email addresses in Config

- **What's wrong:** `loadConfig()` validates that required environment variables are present but does not validate their format. `KINDLE_EMAIL` and `SENDER_EMAIL` could contain arbitrary strings. An invalid email address will only fail at SMTP send time with a cryptic rejection error.
- **Why it matters:** Fail-fast is a stated design principle (Section 7.5). Accepting `KINDLE_EMAIL=not-an-email` at startup and failing at runtime violates this principle.
- **Suggested fix:** Add basic email format validation in `loadConfig()`. Even a simple regex check (`/.+@.+\..+/`) catches obvious misconfiguration.

### DocumentMailer.send() throws but signature says Promise<void>

- **What's wrong:** The `DocumentMailer` port declares `send(document: EpubDocument): Promise<void>` with a comment "Throws DeliveryError on failure." Error behavior is documented in a comment rather than in the type signature. The port interface does not communicate its failure mode.
- **Why it matters:** Consumers of the interface must read comments to understand behavior. This is fragile -- nothing in the type system prevents an implementation from throwing a completely different error type.
- **Suggested fix:** Either return `Promise<Result<void, DeliveryError>>` to make the error type explicit, or at minimum, document this as a known limitation of the thrown-exception approach.

## LOW

### Title.toFilename() belongs in infrastructure, not domain

- **What's wrong:** `Title.toFilename()` generates a URL-safe slug with `.epub` extension. The concept of "epub filename" is an infrastructure concern -- it is specific to how the file will be used by the EPUB packager and email attachment. The domain concept of "title" should not know about file naming conventions.
- **Why it matters:** If a future format is added (e.g., PDF), `Title` would need a `toPdfFilename()` method, violating the open-closed principle. Filename generation is a presentation/infrastructure concern.
- **Suggested fix:** Move filename generation to the `MarkdownEpubConverter` or a small utility in infrastructure. `Title` should only hold and validate the title string.

### EpubDocument delegates filename to Title

- **What's wrong:** `EpubDocument.filename` is defined as `get filename(): string { return this.title.toFilename(); }`. This creates a chain where a domain value object (`EpubDocument`) delegates to another value object (`Title`) for infrastructure behavior (filename generation). This is coupling, not cohesion.
- **Why it matters:** Minor coupling issue, but it means `EpubDocument` cannot be constructed or tested without `Title` carrying infrastructure behavior.
- **Suggested fix:** Have the converter set the filename directly when constructing `EpubDocument`, rather than deriving it through `Title`.

### No consideration for MCP tool description or parameter descriptions

- **What's wrong:** The design specifies the parameter schema but does not mention the tool description string or parameter descriptions that MCP clients use to understand when and how to invoke the tool. These are important for LLM-based clients like Claude to use the tool effectively.
- **Why it matters:** Poor tool descriptions lead to incorrect or suboptimal tool invocations by the MCP client.
- **Suggested fix:** Include the tool description and parameter descriptions in the design (e.g., "Converts Markdown content to EPUB and delivers it to your Kindle device via email").

### Over-structured logger for a single-tool system

- **What's wrong:** The logger defines purpose-specific methods (`logDeliveryAttempt`, `logDeliverySuccess`, `logDeliveryFailure`) with fixed field sets. For a system with exactly one tool and one operation, this is a custom logging framework for three log lines.
- **Why it matters:** A structured logger (e.g., `pino`) with a simple `logger.info({ title, sizeBytes, status }, "delivery complete")` call achieves the same result with zero custom code. The credential-safety argument is valid but solvable with a pino serializer or redaction config.
- **Suggested fix:** Use a standard structured logging library directly. The credential safety requirement can be met by never passing credentials to log calls (which the architecture already ensures by design).

### Test structure mirrors source structure exactly

- **What's wrong:** The test directory is a 1:1 mirror of `src/`. While this is common, it is not a design decision worth encoding in an architecture document. It also implies one test file per source file, which may not be the right granularity (e.g., value object tests might be better consolidated).
- **Why it matters:** Very minor. The test structure is an implementation detail that will evolve organically.
- **Suggested fix:** Remove the test structure from the architecture document, or note it as a suggested starting point rather than a prescribed layout.

## Summary

The most important issues to address before implementation:

1. **Config type in domain** (CRITICAL): This is a clear layer violation that undermines the dependency rule the design is built on. Move it to infrastructure.

2. **Synchronous ContentConverter port** (CRITICAL): The interface cannot be implemented with the suggested library. Make the port async.

3. **Exception-based discriminated union** (HIGH): The design pays for type modeling it cannot use. Either commit to Result types or simplify to class-based exceptions.

4. **Redundant sizeBytes in EpubDocument** (HIGH): Two sources of truth for buffer size. Derive it.

5. **Author default resolution** (MEDIUM): Configuration concern leaking into a value object constructor. Resolve defaults in the application layer.

The overall architecture is sound -- clean layering, proper dependency direction, good separation of conversion from delivery. The issues above are refinements, not fundamental redesigns. The design is ready for implementation once the critical items are resolved.
