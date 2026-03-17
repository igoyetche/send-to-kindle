# PB-001: Send to Kindle MCP Server — Refined Architecture Design

## 1. Executive Summary

This document presents a refined architecture for the Send to Kindle MCP Server, a single-user tool that lets an MCP client (such as Claude) deliver Markdown content to a Kindle device via Amazon's "Send to Kindle" email service. The system accepts Markdown input, converts it to EPUB, and emails it to a configured Kindle address -- all within a single tool invocation.

The design is organized into three architectural layers: **domain**, **infrastructure**, and **application**. The domain layer defines value objects (`Title`, `Author`, `MarkdownContent`, `EpubDocument`), a domain service (`SendToKindleService`), domain error types, and port interfaces for conversion and delivery. The infrastructure layer provides concrete implementations using specific libraries (marked, nodemailer, etc.). The application layer adapts the domain for the MCP protocol. A composition root wires everything together with explicit dependency injection.

---

## 2. Identified Concerns

| # | Concern | Responsibility | Why Separate | Layer |
|---|---------|---------------|--------------|-------|
| 1 | **MCP Transport** | Wire protocol (stdio, HTTP/SSE), session management, request/response framing | Transport choice must not affect business logic | Application |
| 2 | **Tool Interface** | Tool registration, input parsing to domain objects, response formatting | Adapts MCP protocol to domain; changes when MCP schema changes | Application |
| 3 | **Domain Orchestration** | Pipeline coordination: validate, convert, deliver | Core business rule (convert-then-send); changes only when the workflow changes | Domain |
| 4 | **Content Conversion** | Markdown parsing, HTML sanitization, EPUB packaging | Isolated transformation with no side effects; most likely to change as formatting evolves | Infrastructure (implements domain port) |
| 5 | **Email Delivery** | SMTP connection, message composition, attachment handling | External I/O with failure modes fundamentally different from content processing | Infrastructure (implements domain port) |
| 6 | **Configuration** | Loading, validating, and providing environment-based settings | Credentials must be centrally managed; single source of truth | Infrastructure |
| 7 | **Domain Validation** | Enforcing invariants on titles, content, authors | Invariants must be defined once and enforced at construction time | Domain (value objects) |
| 8 | **Logging / Observability** | Structured logging of delivery attempts without credential leakage | Cross-cutting concern; must not couple modules together | Infrastructure |

---

## 3. High-Level Architecture

```
+------------------------------------------------------------------+
|                    Application Layer                              |
|                                                                   |
|  +---------------------------+  +-----------------------------+  |
|  |   MCP Transport (SDK)     |  |   Tool Handler (adapter)    |  |
|  |   stdio | HTTP/SSE        |-->|   - parse MCP input         |  |
|  +---------------------------+  |   - construct value objects  |  |
|                                 |   - call domain service      |  |
|                                 |   - format MCP response      |  |
|                                 +-----------------------------+  |
+------------------------------------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------+
|                      Domain Layer                                 |
|                                                                   |
|  Value Objects:  Title, Author, MarkdownContent, EpubDocument     |
|  Errors:         DomainError (discriminated union)                |
|  Ports:          ContentConverter, DocumentMailer (interfaces)    |
|  Service:        SendToKindleService (orchestration)              |
+------------------------------------------------------------------+
                      ^                       ^
                      |                       |
         implements   |                       |   implements
                      |                       |
+---------------------------+   +---------------------------+
|   Infrastructure Layer    |   |   Infrastructure Layer    |
|                           |   |                           |
|  MarkdownEpubConverter    |   |  SmtpMailer               |
|  (marked, sanitize-html,  |   |  (nodemailer)             |
|   epub-gen-memory)        |   |                           |
+---------------------------+   +---------------------------+
                      |                       |
                      +----------+------------+
                                 |
                    +---------------------------+
                    |  Configuration + Logger   |
                    +---------------------------+
```

**Dependency rule:** The domain layer has zero imports from infrastructure or application. Arrows point inward. Infrastructure implements domain-defined interfaces. The application layer calls into the domain.

---

## 4. Domain Layer

### 4.1 Value Objects

Value objects are immutable, self-validating, and defined by their attributes. They enforce invariants at construction time so that downstream code never operates on invalid data.

#### Title

```typescript
class Title {
  readonly value: string;

  constructor(raw: string) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ValidationError("title", "The 'title' parameter is required and must be non-empty.");
    }
    this.value = trimmed;
  }

  /** Produces a URL-safe filename slug: lowercase, hyphens for spaces,
      non-alphanumeric removed, truncated to 100 chars, with .epub extension. */
  toFilename(): string {
    const slug = this.value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 100);
    return `${slug || "document"}.epub`;
  }
}
```

#### Author

```typescript
class Author {
  readonly value: string;

  constructor(raw: string | undefined, defaultAuthor: string) {
    const resolved = raw?.trim() || defaultAuthor;
    if (resolved.length === 0) {
      throw new ValidationError("author", "Author must be non-empty.");
    }
    this.value = resolved;
  }
}
```

#### MarkdownContent

```typescript
class MarkdownContent {
  static readonly MAX_BYTES = 25 * 1024 * 1024; // 25 MB
  readonly value: string;

  constructor(raw: string) {
    if (raw.length === 0) {
      throw new ValidationError("content", "The 'content' parameter is required and must be non-empty.");
    }
    if (Buffer.byteLength(raw, "utf-8") > MarkdownContent.MAX_BYTES) {
      throw new SizeLimitError(Buffer.byteLength(raw, "utf-8"), MarkdownContent.MAX_BYTES);
    }
    this.value = raw;
  }
}
```

#### EpubDocument

```typescript
class EpubDocument {
  constructor(
    readonly title: Title,
    readonly buffer: Buffer,
    readonly sizeBytes: number
  ) {}

  get filename(): string {
    return this.title.toFilename();
  }
}
```

### 4.2 Domain Errors

Errors are modeled as a discriminated union with explicit types rather than string categories. Each error variant carries structured data relevant to its kind.

```typescript
class ValidationError {
  readonly kind = "validation" as const;
  constructor(readonly field: string, readonly message: string) {}
}

class SizeLimitError {
  readonly kind = "size_limit" as const;
  constructor(readonly actualBytes: number, readonly limitBytes: number) {}

  get message(): string {
    return `Content exceeds the ${this.limitBytes / (1024 * 1024)} MB limit.`;
  }
}

class ConversionError {
  readonly kind = "conversion" as const;
  constructor(readonly message: string) {}
}

class DeliveryError {
  readonly kind = "delivery" as const;
  constructor(
    readonly cause: "auth" | "connection" | "rejection",
    readonly message: string
  ) {}
}

type DomainError = ValidationError | SizeLimitError | ConversionError | DeliveryError;
```

### 4.3 Port Interfaces

Ports define the contracts that infrastructure must fulfill. They are declared in the domain layer using domain types only.

```typescript
interface ContentConverter {
  toEpub(title: Title, content: MarkdownContent, author: Author): EpubDocument;
}

interface DocumentMailer {
  send(document: EpubDocument): Promise<void>;
  // Throws DeliveryError on failure
}
```

### 4.4 Domain Service: SendToKindleService

The domain service orchestrates the conversion-then-delivery pipeline. It depends only on the port interfaces defined above and the domain value objects.

```typescript
interface DeliverySuccess {
  title: string;
  filename: string;
  sizeBytes: number;
}

class SendToKindleService {
  constructor(
    private readonly converter: ContentConverter,
    private readonly mailer: DocumentMailer
  ) {}

  async execute(title: Title, content: MarkdownContent, author: Author): Promise<DeliverySuccess> {
    // Step 1: Convert content to EPUB
    const document = this.converter.toEpub(title, content, author);

    // Step 2: Deliver via email
    await this.mailer.send(document);

    // Step 3: Return success details
    return {
      title: title.value,
      filename: document.filename,
      sizeBytes: document.sizeBytes,
    };
  }
}
```

The service does not catch errors. Errors propagate as typed domain errors (`ConversionError`, `DeliveryError`) to the application layer, which is responsible for mapping them to MCP response format.

---

## 5. Infrastructure Layer

### 5.1 MarkdownEpubConverter (implements ContentConverter)

**Responsibility:** Transform Markdown input into a valid EPUB 3.0 document. Sanitize HTML content. This is the concrete implementation of the `ContentConverter` port.

**Internal pipeline:**

```
MarkdownContent.value
  |
  v
marked.parse() --> raw HTML string
  |
  v
sanitize-html --> safe HTML string (no scripts, no event handlers)
  |
  v
EPUB packager --> EPUB 3.0 buffer
  |               - content.opf with title + author metadata
  |               - single XHTML chapter preserving semantic structure
  |               - mimetype, META-INF/container.xml
  v
EpubDocument(title, buffer, sizeBytes)
```

**Error handling:** Catches library exceptions and wraps them in `ConversionError` with a descriptive message. Never exposes library-specific error types to the domain.

**Library choices:**
- `marked` for Markdown-to-HTML conversion
- `sanitize-html` for HTML sanitization with a strict allowlist
- `epub-gen-memory` (or equivalent in-memory EPUB library) for EPUB packaging without temporary files

### 5.2 SmtpMailer (implements DocumentMailer)

**Responsibility:** Send a single email with an EPUB attachment to the configured Kindle address via SMTP. This is the concrete implementation of the `DocumentMailer` port.

**Constructor dependencies:** Receives only the SMTP and email configuration it needs -- not the entire `Config` object.

```typescript
interface SmtpMailerConfig {
  kindle: { email: string };
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
}

class SmtpMailer implements DocumentMailer {
  constructor(private readonly config: SmtpMailerConfig) {}

  async send(document: EpubDocument): Promise<void> {
    // Compose email:
    //   From: config.sender.email
    //   To: config.kindle.email
    //   Subject: document.title.value
    //   Body: minimal text (Amazon ignores the body)
    //   Attachment: document.buffer as document.filename

    // On SMTP errors, categorize and throw DeliveryError:
    //   - Authentication failures --> DeliveryError("auth", ...)
    //   - Connection failures     --> DeliveryError("connection", ...)
    //   - Rejection failures      --> DeliveryError("rejection", ...)
  }
}
```

**Library choice:** `nodemailer` -- mature, well-maintained, supports all required SMTP features.

### 5.3 Configuration Module

**Responsibility:** Load configuration from environment variables (or `.env` file), validate that all required values are present, and return a typed configuration object.

**Boundary:** Read-only after initialization. No other module reads `process.env` directly.

The `Config` type is defined in the domain layer (it represents the system's operational parameters):

```typescript
// domain/config.ts
interface Config {
  kindle: { email: string };
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}
```

The loading function lives in infrastructure:

```typescript
// infrastructure/config.ts
function loadConfig(): Config {
  // Reads from process.env
  // Throws immediately if required variables are missing
  // Coerces SMTP_PORT to number
  // Enforces: if MCP_HTTP_PORT is set, MCP_AUTH_TOKEN must also be set
}
```

**Required variables:**

| Variable | Required | Used By | Description |
|----------|----------|---------|-------------|
| `KINDLE_EMAIL` | Yes | SmtpMailer | Recipient Kindle address |
| `SENDER_EMAIL` | Yes | SmtpMailer | From address (must be Amazon-approved) |
| `SMTP_HOST` | Yes | SmtpMailer | SMTP server hostname |
| `SMTP_PORT` | Yes | SmtpMailer | SMTP server port |
| `SMTP_USER` | Yes | SmtpMailer | SMTP authentication username |
| `SMTP_PASS` | Yes | SmtpMailer | SMTP authentication password |
| `DEFAULT_AUTHOR` | No | Tool handler | Default author name (fallback: `"Claude"`) |
| `MCP_HTTP_PORT` | No | Transport | Port for HTTP/SSE transport |
| `MCP_AUTH_TOKEN` | Conditional | Transport | Required if `MCP_HTTP_PORT` is set |
| `LOG_LEVEL` | No | Logger | Logging verbosity (fallback: `"info"`) |

**Startup behavior:** If any required variable is missing, the process exits immediately with a clear error message naming the missing variable.

### 5.4 Logger (cross-cutting)

**Responsibility:** Provide structured logging for delivery attempts. Ensure credentials never appear in log output.

**Log fields per delivery attempt:**
- Timestamp
- Document title
- Output format (always `epub` in v1)
- File size in bytes
- Success/failure status
- Error kind (on failure)

**Credential safety:** The logger exposes purpose-specific methods (`logDeliveryAttempt`, `logDeliverySuccess`, `logDeliveryFailure`) that accept only the fields listed above. It does not accept arbitrary objects.

---

## 6. Application Layer

### 6.1 MCP Transport

**Responsibility:** Accept MCP tool calls over either stdio or HTTP/SSE and forward them to the tool handler. Return responses back over the same transport.

This layer is entirely provided by the MCP SDK (`@modelcontextprotocol/sdk`). The application code does not implement protocol framing.

**Key decisions:**
- Stdio is the default transport, activated when no HTTP port is configured.
- HTTP/SSE transport activates when `MCP_HTTP_PORT` is set.
- HTTP/SSE transport enforces bearer token authentication via `MCP_AUTH_TOKEN`.
- Both transports can be active simultaneously.

### 6.2 Tool Handler (MCP Adapter)

**Responsibility:** Adapt between the MCP protocol and the domain layer. This is the only module that knows about both MCP types and domain types.

**What it does:**
1. Registers the `send_to_kindle` tool with the MCP SDK, including its parameter schema.
2. Parses raw MCP input parameters into domain value objects (`Title`, `Author`, `MarkdownContent`).
3. Calls `SendToKindleService.execute()` with the domain objects.
4. Maps the result (or caught domain errors) to the MCP response format.
5. Invokes the logger for observability.

**Input schema (registered with MCP SDK):**

```typescript
interface SendToKindleParams {
  title: string;
  content: string;
  author?: string;
}
```

**Response format:**

```typescript
interface SuccessResponse {
  success: true;
  message: string;
  sizeBytes: number;
}

interface ErrorResponse {
  success: false;
  error: string;   // mapped from DomainError.kind
  details: string; // mapped from DomainError.message
}
```

**Error mapping:**

```typescript
function mapErrorToResponse(error: DomainError): ErrorResponse {
  switch (error.kind) {
    case "validation":
      return { success: false, error: "VALIDATION_ERROR", details: error.message };
    case "size_limit":
      return { success: false, error: "SIZE_ERROR", details: error.message };
    case "conversion":
      return { success: false, error: "CONVERSION_ERROR", details: error.message };
    case "delivery":
      return { success: false, error: "SMTP_ERROR", details: error.message };
  }
}
```

This mapping is the single place where domain errors are translated to protocol-level responses. Credential information never reaches this point because the `DeliveryError` type carries only a categorized cause and a safe message.

---

## 7. Dependency Graph

```
index.ts (composition root)
  |
  +---> loadConfig() --> Config
  |
  +---> create Logger(config.logLevel)
  |
  +---> create MarkdownEpubConverter() --> implements ContentConverter
  |
  +---> create SmtpMailer(config.smtp, config.kindle, config.sender) --> implements DocumentMailer
  |
  +---> create SendToKindleService(converter, mailer)
  |
  +---> create ToolHandler(service, config.defaultAuthor, logger)
  |
  +---> create MCP Server (SDK)
  |       |
  |       +---> register tool via ToolHandler
  |       +---> attach stdio transport
  |       +---> attach HTTP/SSE transport (if config.http is set)
```

Key properties:
- **No circular dependencies.** Each layer depends only on the layer directly below it.
- **The domain layer has zero infrastructure imports.** It defines ports; it does not know who implements them.
- **`MarkdownEpubConverter` is a leaf node** with zero infrastructure dependencies beyond its libraries -- fully unit-testable.
- **`SmtpMailer` receives only its configuration subset** -- it does not import the config module.
- **`SendToKindleService` depends only on domain interfaces** -- testable with simple fakes.
- **`index.ts` is the only file that knows about all concrete types** -- the composition root.

---

## 8. Project Structure

```
send-to-kindle-mcp/
  src/
    domain/
      values/
        title.ts              # Title value object with filename generation
        author.ts             # Author value object with default resolution
        markdown-content.ts   # MarkdownContent value object with size validation
        epub-document.ts      # EpubDocument value object
        index.ts              # Barrel export
      errors.ts               # DomainError types (ValidationError, DeliveryError, etc.)
      ports.ts                # ContentConverter, DocumentMailer interfaces
      config.ts               # Config type definition (shape only, no loading)
      send-to-kindle-service.ts  # Domain service: orchestration
    infrastructure/
      converter/
        markdown-epub-converter.ts  # ContentConverter implementation
      mailer/
        smtp-mailer.ts              # DocumentMailer implementation
      config.ts                     # loadConfig() from environment
      logger.ts                     # Structured logging
    application/
      tool-handler.ts               # MCP adapter: parse, delegate, format
    index.ts                        # Composition root
  test/
    domain/
      values/
        title.test.ts               # Title validation, filename generation
        markdown-content.test.ts    # Size limit enforcement
      send-to-kindle-service.test.ts  # Orchestration with fake converter/mailer
    infrastructure/
      converter/
        markdown-epub-converter.test.ts  # EPUB generation, HTML sanitization
      mailer/
        smtp-mailer.test.ts          # Integration tests with mock SMTP
      config.test.ts                 # Required variable enforcement
    application/
      tool-handler.test.ts           # MCP input parsing, response formatting, error mapping
    e2e/
      full-pipeline.test.ts          # End-to-end: tool call to SMTP dispatch
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
```

---

## 9. Data Flow: Happy Path

```
MCP Client (Claude)
  |
  |  send_to_kindle({ title: "Clean Architecture", content: "# Chapter 1\n...", author: "Claude" })
  |
  v
[Transport Layer - stdio or HTTP/SSE]
  |
  v
[Tool Handler]
  |-- construct Title("Clean Architecture")     --> validates non-empty
  |-- construct MarkdownContent("# Chapter 1...") --> validates non-empty, < 25 MB
  |-- construct Author("Claude", defaultAuthor)    --> resolves to "Claude"
  |
  v
[SendToKindleService.execute(title, content, author)]
  |
  v
[ContentConverter.toEpub(title, content, author)]
  |-- marked.parse(content.value) --> HTML
  |-- sanitize-html(html) --> safe HTML
  |-- epub-gen(title.value, author.value, safeHtml) --> EPUB buffer
  |-- return EpubDocument(title, buffer, 48210)
  |
  v
[DocumentMailer.send(document)]
  |-- compose email: from=sender, to=kindle, subject=document.title.value
  |-- attach: document.filename ("clean-architecture.epub"), document.buffer
  |-- nodemailer.sendMail() --> SMTP --> Amazon
  |
  v
[SendToKindleService] returns DeliverySuccess { title, filename, sizeBytes }
  |
  v
[Tool Handler]
  |-- logger.logDeliverySuccess({ title: "Clean Architecture", format: "epub", sizeBytes: 48210 })
  |-- format MCP response
  |
  v
[Transport Layer]
  |
  |  { success: true, message: "Document 'Clean Architecture' sent to Kindle successfully.", sizeBytes: 48210 }
  |
  v
MCP Client (Claude)
```

---

## 10. Data Flow: Error Paths

### 10.1 Validation failure (missing title)

```
[Tool Handler]
  |-- construct Title("")  -->  throws ValidationError("title", "The 'title' parameter is required...")
  |
  v
[Tool Handler] catches ValidationError
  |-- maps to { success: false, error: "VALIDATION_ERROR", details: "The 'title' parameter is required..." }
  |
  v
Return response. No conversion or delivery attempted.
```

### 10.2 SMTP authentication failure

```
[SendToKindleService]
  |-- converter.toEpub() succeeds
  |-- mailer.send() --> SmtpMailer catches SMTP AUTH error
  |                 --> throws DeliveryError("auth", "SMTP authentication failed. Check server configuration.")
  |
  v
[Tool Handler] catches DeliveryError
  |-- logger.logDeliveryFailure({ title, errorKind: "delivery" })
  |-- maps to { success: false, error: "SMTP_ERROR", details: "SMTP authentication failed. Check server configuration." }
```

Credentials never appear in the `DeliveryError` because the `SmtpMailer` constructs the error with a safe, pre-written message.

### 10.3 Content exceeds size limit

```
[Tool Handler]
  |-- construct MarkdownContent(<26 MB string>)
  |     --> throws SizeLimitError(27262976, 26214400)
  |
  v
[Tool Handler] catches SizeLimitError
  |-- maps to { success: false, error: "SIZE_ERROR", details: "Content exceeds the 25 MB limit." }
```

Rejected at value object construction. No conversion or delivery attempted.

---

## 11. Container Architecture

```
+-------------------------------------------+
|  Docker Container                         |
|                                           |
|  Node.js runtime (Alpine-based)           |
|  send-to-kindle-mcp application           |
|                                           |
|  Exposes:                                 |
|    - stdin/stdout (stdio transport)       |
|    - Port $MCP_HTTP_PORT (HTTP/SSE)       |
|                                           |
|  Reads:                                   |
|    - Environment variables for config     |
+-------------------------------------------+
```

**Dockerfile strategy:**
- Multi-stage build: build stage compiles TypeScript, production stage copies only compiled JS and `node_modules`.
- Base image: `node:22-alpine` (supports both x86_64 and ARM64).
- No volume mounts required -- all state is transient (in-memory EPUB generation, no persistent storage).

---

## 12. Testing Strategy

| Layer | Module | Test Type | What Is Tested | Dependencies |
|-------|--------|-----------|----------------|-------------|
| Domain | `Title` | Unit | Non-empty validation, filename slug generation, truncation, special characters | None |
| Domain | `MarkdownContent` | Unit | Non-empty validation, size limit enforcement | None |
| Domain | `Author` | Unit | Default resolution, non-empty validation | None |
| Domain | `SendToKindleService` | Unit | Orchestration: calls converter then mailer, returns success structure | Fake ContentConverter, fake DocumentMailer |
| Infrastructure | `MarkdownEpubConverter` | Unit | Markdown-to-HTML, HTML sanitization, EPUB structure, edge cases | Libraries only (no I/O) |
| Infrastructure | `SmtpMailer` | Integration | Email composition, attachment encoding, error categorization | Mock SMTP server |
| Infrastructure | `loadConfig` | Unit | Required variable enforcement, type coercion, conditional requirements | Controlled `process.env` |
| Application | `ToolHandler` | Unit | MCP input parsing, value object construction, error mapping to response format | Fake SendToKindleService |
| End-to-end | Full pipeline | Integration | Tool call through to SMTP dispatch | Mock SMTP server, real converter |

The domain layer is fully testable without any infrastructure. The infrastructure layer is testable with library-level or mock-server dependencies. The application layer is testable with a fake domain service. Each layer's tests are independent of the others.

---

## 13. Addressing Open Questions

| Question | Recommendation |
|----------|---------------|
| **OQ-1** (Amazon email bounces) | Accept "email dispatched" as success. Bounce detection is asynchronous and outside the system's control. Document this limitation in the tool's response message. |
| **OQ-3** (Remote authentication) | Use bearer token authentication for HTTP/SSE transport. Token configured via `MCP_AUTH_TOKEN`. Sufficient for single-user tool over encrypted channel. |
| **OQ-4** (Preview capability) | Defer to a future version. The domain service pattern makes this trivial: create a `PreviewService` that calls `ContentConverter.toEpub()` but not `DocumentMailer.send()`. No changes to existing code. |
| **OQ-5** (Multiple Kindle addresses) | Single address for v1. Adding multiple addresses would require a new value object (e.g., `KindleDevice`) and a change to `Config`. The domain service and port interfaces would need minimal adjustment. |

---

## 14. Separation of Concerns Summary

| Layer | Module | Owns | Does NOT Handle |
|-------|--------|------|-----------------|
| Domain | Value objects | Input invariants, self-validation, filename derivation | Parsing, formatting, I/O |
| Domain | `SendToKindleService` | Pipeline orchestration (convert-then-send) | MCP protocol, SMTP, HTML parsing |
| Domain | Port interfaces | Contracts for conversion and delivery | Implementation details |
| Domain | Domain errors | Error semantics and categorization | Error formatting for protocols |
| Infrastructure | `MarkdownEpubConverter` | Markdown-to-EPUB transformation | Email, MCP, configuration loading |
| Infrastructure | `SmtpMailer` | SMTP connection, email composition, error translation | Content formatting, validation |
| Infrastructure | `loadConfig` | Environment variable reading, startup validation | Runtime behavior |
| Infrastructure | Logger | Structured log output, credential redaction | Business logic |
| Application | `ToolHandler` | MCP schema, input parsing, response formatting, error mapping | Conversion, delivery, SMTP |
| Application | Transport (SDK) | Wire protocol | Everything above the wire |

Each module can be understood, tested, and modified independently. A change to EPUB structure affects only `MarkdownEpubConverter`. A change to the email provider affects only `SmtpMailer`. A change to the MCP schema affects only `ToolHandler`. A change to validation rules affects only the relevant value object. The domain service changes only if the workflow itself changes. This is the core architectural property the design preserves.
