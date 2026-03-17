# PB-001: Send to Kindle MCP Server — Architecture Design

## 1. Executive Summary

This document presents an architecture for the Send to Kindle MCP Server, a single-user tool that lets an MCP client (such as Claude) deliver Markdown content to a Kindle device via Amazon's "Send to Kindle" email service. The system accepts Markdown input, converts it to EPUB, and emails it to a configured Kindle address -- all within a single tool invocation.

The design decomposes the system into five clearly separated concerns: **transport**, **tool interface**, **content conversion**, **email delivery**, and **configuration**. Each concern maps to an isolated module with well-defined boundaries and a narrow public API.

---

## 2. Identified Concerns

The spec describes a pipeline with distinct responsibilities. Below is the full enumeration of concerns, why they must be separated, and where they sit in the architecture.

| # | Concern | Responsibility | Why Separate |
|---|---------|---------------|--------------|
| 1 | **MCP Transport** | Wire protocol (stdio, HTTP/SSE), session management, request/response framing | Transport choice must not affect business logic; the spec requires both stdio and HTTP/SSE (C-2, C-3) |
| 2 | **Tool Interface** | Tool registration, parameter schema, input validation, response shaping | Decouples the MCP protocol layer from domain logic; validation rules (FR-15 through FR-17) are tool-specific, not transport-specific |
| 3 | **Content Conversion** | Markdown parsing, HTML sanitization, EPUB packaging | Isolated transformation with no side effects; testable without network; most likely module to change as formatting requirements evolve |
| 4 | **Email Delivery** | SMTP connection, message composition, attachment handling | External I/O with failure modes (auth errors, timeouts) fundamentally different from content processing; must be independently mockable for testing |
| 5 | **Configuration** | Loading, validating, and providing environment-based settings | Credentials and addresses must be centrally managed and never leak into other layers (NFR-3); single source of truth |
| 6 | **Logging / Observability** | Structured logging of delivery attempts without credential leakage | Cross-cutting concern that must be consistently applied but must not couple modules together |

---

## 3. High-Level Architecture

```
+------------------------------------------------------------------+
|                        MCP Transport Layer                       |
|           (stdio transport  |  HTTP/SSE transport)               |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                      Tool Interface Layer                        |
|  - Tool registration (send_to_kindle)                            |
|  - Input validation (title, content, author)                     |
|  - Orchestration: conversion -> delivery                         |
|  - Response formatting (success / error)                         |
+------------------------------------------------------------------+
          |                                        |
          v                                        v
+-------------------------+          +-------------------------+
|   Content Conversion    |          |    Email Delivery       |
|                         |          |                         |
| - Markdown -> HTML      |          | - SMTP connection       |
| - HTML sanitization     |          | - Message composition   |
| - EPUB 3.0 packaging   |          | - Attachment handling   |
| - Title sanitization    |          | - Error categorization  |
+-------------------------+          +-------------------------+
          |                                        |
          +----------------+-----------------------+
                           |
                           v
              +-------------------------+
              |    Configuration        |
              |                         |
              | - Environment loading   |
              | - Validation            |
              | - Credential isolation  |
              +-------------------------+
                           |
                           v
              +-------------------------+
              |    Logger               |
              |                         |
              | - Structured log output |
              | - Credential redaction  |
              +-------------------------+
```

---

## 4. Module Specifications

### 4.1 MCP Transport Layer

**Responsibility:** Accept MCP tool calls over either stdio or HTTP/SSE and forward them to the tool interface layer. Return responses back over the same transport.

**Boundary:** This layer is entirely provided by the MCP SDK (`@modelcontextprotocol/sdk`). The application code does not implement protocol framing. The only application concern is selecting which transport to activate based on configuration or command-line flags.

**Key decisions:**
- Stdio is the default transport, activated when no HTTP port is configured.
- HTTP/SSE transport activates when an `MCP_HTTP_PORT` environment variable is set.
- HTTP/SSE transport must enforce authentication (NFR-5). A bearer token mechanism is recommended for v1, configured via `MCP_AUTH_TOKEN`. This addresses OQ-3 from the spec with the simplest viable option that still provides access control.
- Both transports can be active simultaneously to support local and remote access from one deployment.

**Public interface:** None exposed to application code -- the SDK handles this. The application registers tools via the SDK's server API.

### 4.2 Tool Interface Layer (`tool-handler`)

**Responsibility:** Register the `send_to_kindle` tool with its schema, validate incoming parameters, orchestrate the conversion-then-delivery pipeline, and format structured responses.

**Boundary:** This module knows the tool's parameter schema and response format. It delegates all content work to the converter and all I/O to the mailer. It never touches SMTP connections or Markdown parsing directly.

**Input validation rules (from spec):**
- `title` is required, non-empty string (FR-15)
- `content` is required, non-empty string (FR-16)
- `content` must not exceed 25 MB (FR-17)
- `author` is optional, defaults to configured `DEFAULT_AUTHOR` or `"Claude"` (FR-3)

**Orchestration sequence:**

```
validate(params)
  |
  v
convertedDoc = converter.toEpub(title, content, author)
  |
  v
result = mailer.send(title, convertedDoc.buffer, convertedDoc.filename)
  |
  v
return formatResponse(result, convertedDoc.sizeBytes)
```

**Error handling:** Catches errors from both downstream modules and maps them to the structured error response format defined in FR-12. Error categories include: `VALIDATION_ERROR`, `CONVERSION_ERROR`, `SMTP_ERROR`, `SIZE_ERROR`.

**Public API:**

```typescript
// Registered with MCP SDK -- not called directly
interface SendToKindleParams {
  title: string;
  content: string;
  author?: string;
}

interface SuccessResponse {
  success: true;
  message: string;
  sizeBytes: number;
}

interface ErrorResponse {
  success: false;
  error: string;
  details: string;
}
```

### 4.3 Content Conversion Module (`converter`)

**Responsibility:** Transform Markdown input into a valid EPUB 3.0 document. Sanitize content. Generate safe filenames.

**Boundary:** Pure transformation -- no network I/O, no file system writes beyond temporary buffers. Receives strings, returns buffers. Has no knowledge of email, SMTP, or MCP.

**Internal pipeline:**

```
Markdown string
  |
  v
marked.parse() --> raw HTML string
  |
  v
sanitize-html --> safe HTML string (NFR-4: no scripts, no event handlers)
  |
  v
EPUB packager --> EPUB 3.0 buffer
  |               - content.opf with title + author metadata (FR-5)
  |               - single XHTML chapter preserving semantic structure (FR-6)
  |               - mimetype, META-INF/container.xml
  v
{ buffer: Buffer, filename: string, sizeBytes: number }
```

**Filename sanitization (FR-9):** The title is converted to a URL-safe slug: lowercased, spaces replaced with hyphens, non-alphanumeric characters removed, truncated to 100 characters, with `.epub` appended.

**Public API:**

```typescript
interface ConvertedDocument {
  buffer: Buffer;
  filename: string;  // e.g., "clean-architecture.epub"
  sizeBytes: number;
}

function toEpub(title: string, markdownContent: string, author: string): ConvertedDocument;
```

**Library choices:**
- `marked` for Markdown-to-HTML conversion
- `sanitize-html` for HTML sanitization with a strict allowlist
- `epub-gen-memory` (or equivalent in-memory EPUB library) for EPUB packaging without temporary files

### 4.4 Email Delivery Module (`mailer`)

**Responsibility:** Send a single email with a file attachment to the configured Kindle address via SMTP.

**Boundary:** Knows only about SMTP and email composition. Has no knowledge of Markdown, EPUB internals, or MCP. Receives a buffer and metadata, sends an email, returns success or a categorized error.

**Email composition (from spec):**
- **From:** configured `SENDER_EMAIL`
- **To:** configured `KINDLE_EMAIL`
- **Subject:** document title (FR-8)
- **Body:** minimal text (Amazon ignores the body)
- **Attachment:** the EPUB buffer with the sanitized filename

**Error categorization:** The module catches SMTP-specific errors and translates them into domain-level categories:
- Authentication failures (wrong credentials)
- Connection failures (host unreachable, timeout)
- Rejection failures (recipient rejected, message too large)

**Public API:**

```typescript
interface DeliveryResult {
  success: boolean;
  error?: string;
  details?: string;
}

function send(title: string, attachmentBuffer: Buffer, filename: string): Promise<DeliveryResult>;
```

**Library choice:** `nodemailer` -- mature, well-maintained, supports all required SMTP features.

### 4.5 Configuration Module (`config`)

**Responsibility:** Load configuration from environment variables (or `.env` file), validate that all required values are present, and expose a typed configuration object. Ensure credentials never propagate beyond this module except to the specific consumers that need them (mailer for SMTP, mailer for addresses).

**Boundary:** Read-only after initialization. Other modules access configuration through this module's exported object -- they never read `process.env` directly. This creates a single place to audit credential access.

**Required variables:**

| Variable | Required | Used By | Description |
|----------|----------|---------|-------------|
| `KINDLE_EMAIL` | Yes | mailer | Recipient Kindle address |
| `SENDER_EMAIL` | Yes | mailer | From address (must be Amazon-approved) |
| `SMTP_HOST` | Yes | mailer | SMTP server hostname |
| `SMTP_PORT` | Yes | mailer | SMTP server port |
| `SMTP_USER` | Yes | mailer | SMTP authentication username |
| `SMTP_PASS` | Yes | mailer | SMTP authentication password |
| `DEFAULT_AUTHOR` | No | tool-handler | Default author name (fallback: `"Claude"`) |
| `MCP_HTTP_PORT` | No | transport | Port for HTTP/SSE transport |
| `MCP_AUTH_TOKEN` | Conditional | transport | Required if `MCP_HTTP_PORT` is set |
| `LOG_LEVEL` | No | logger | Logging verbosity (fallback: `"info"`) |

**Startup behavior:** The configuration module is the first thing initialized. If any required variable is missing, the process exits immediately with a clear error message naming the missing variable. This prevents the server from starting in a broken state.

**Public API:**

```typescript
interface Config {
  kindle: { email: string };
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  author: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}

function loadConfig(): Config;  // throws on missing required values
```

### 4.6 Logger (cross-cutting)

**Responsibility:** Provide structured logging for delivery attempts per NFR-6. Ensure credentials never appear in log output.

**Log fields per delivery attempt:**
- Timestamp
- Document title
- Output format (always `epub` in v1)
- File size in bytes
- Success/failure status
- Error category (on failure)

**Credential safety:** The logger does not accept arbitrary objects for logging. It exposes purpose-specific methods (`logDeliveryAttempt`, `logDeliverySuccess`, `logDeliveryFailure`) that accept only the fields listed above.

---

## 5. Dependency Graph

```
index.ts (entry point)
  |
  +---> config (loaded first, passed to dependents)
  |
  +---> transport (SDK-provided, receives tool registrations)
  |
  +---> tool-handler
            |
            +---> converter (no dependencies beyond libraries)
            |
            +---> mailer (depends on config for SMTP settings)
            |
            +---> logger (depends on config for log level)
```

Key properties of this graph:
- **No circular dependencies.** Each module depends only on modules below it.
- **`converter` is a leaf node** with zero infrastructure dependencies -- fully unit-testable.
- **`mailer` depends only on `config`** -- testable with a mock SMTP server.
- **`tool-handler` is the only orchestrator** -- it is the single place where conversion and delivery are composed.

---

## 6. Project Structure

```
send-to-kindle-mcp/
  src/
    index.ts              # Entry point: load config, create transports, register tools
    config.ts             # Configuration loading and validation
    tool-handler.ts       # Tool registration, validation, orchestration
    converter.ts          # Markdown -> EPUB conversion
    mailer.ts             # SMTP email delivery
    logger.ts             # Structured logging
    types.ts              # Shared type definitions
  test/
    converter.test.ts     # Unit tests for conversion (no I/O)
    mailer.test.ts        # Integration tests with mock SMTP
    tool-handler.test.ts  # Orchestration tests with mocked converter/mailer
    config.test.ts        # Validation tests
  Dockerfile              # Multi-stage build, ARM64 + x86_64 compatible
  docker-compose.yml      # Service definition
  .env.example            # Template for required environment variables
  package.json
  tsconfig.json
```

---

## 7. Key Design Decisions

### 7.1 TypeScript over JavaScript

TypeScript provides compile-time type checking for the configuration object, tool parameters, and inter-module contracts. Given that credential leakage is a security concern (NFR-3), typed interfaces make it harder to accidentally pass the wrong data between layers.

### 7.2 EPUB-only output (no HTML/TXT formats in v1)

The formal spec (spec.md) narrows the output to EPUB only (FR-4, FR-5), diverging from the earlier project idea that considered HTML and TXT. This simplifies the converter to a single pipeline and avoids a format parameter on the tool interface. The architecture supports adding formats later by extending the converter module without changing the tool handler's orchestration flow.

### 7.3 In-memory EPUB generation

The converter produces an EPUB buffer entirely in memory rather than writing temporary files to disk. This eliminates cleanup concerns, avoids filesystem permission issues in containers, and keeps the converter side-effect-free.

### 7.4 Bearer token authentication for HTTP/SSE

For remote access (C-3, NFR-5), the design uses a pre-shared bearer token rather than mutual TLS or OAuth. This is appropriate for a single-user tool where the token can be configured as an environment variable and transmitted over an already-encrypted channel (Tailscale, TLS). It avoids the operational complexity of certificate management.

### 7.5 Fail-fast configuration

The server refuses to start if required configuration is missing. This avoids a scenario where the server starts, accepts a tool call, and then fails at delivery time because SMTP credentials were never configured. The user gets immediate feedback during setup.

---

## 8. Data Flow: Happy Path

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
  |-- validate: title present, content present, content < 25 MB
  |
  v
[Converter]
  |-- marked.parse(markdown) --> HTML
  |-- sanitize-html(html) --> safe HTML
  |-- epub-gen(title, author, safeHtml) --> EPUB buffer (e.g., 48,210 bytes)
  |-- sanitize filename: "clean-architecture.epub"
  |
  v
[Tool Handler] receives { buffer, filename: "clean-architecture.epub", sizeBytes: 48210 }
  |
  v
[Mailer]
  |-- compose email: from=config.sender, to=config.kindle, subject="Clean Architecture"
  |-- attach: "clean-architecture.epub" (48,210 bytes)
  |-- nodemailer.sendMail() --> SMTP --> Amazon
  |
  v
[Tool Handler] receives { success: true }
  |
  v
[Logger] logDeliverySuccess({ title: "Clean Architecture", format: "epub", sizeBytes: 48210 })
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

## 9. Data Flow: Error Paths

### 9.1 Validation failure (missing title)

```
Tool Handler: validate({ content: "..." })  -->  title missing
  |
  v
Return: { success: false, error: "VALIDATION_ERROR", details: "The 'title' parameter is required." }
```

No conversion or delivery is attempted. No log entry beyond a debug-level note.

### 9.2 SMTP authentication failure

```
Converter: succeeds, returns EPUB buffer
  |
  v
Mailer: sendMail() throws SMTP AUTH error
  |
  v
Mailer: categorizes as { success: false, error: "SMTP_ERROR", details: "SMTP authentication failed..." }
  |
  v
Tool Handler: receives error, does NOT include credentials in response
  |
  v
Logger: logDeliveryFailure({ title, error: "SMTP_ERROR" })  // no credentials logged
  |
  v
Return: { success: false, error: "SMTP_ERROR", details: "SMTP authentication failed. Check server configuration." }
```

### 9.3 Content exceeds size limit

```
Tool Handler: validate({ title: "Big Doc", content: <26 MB string> })
  |
  v
Content size > 25 MB --> reject immediately
  |
  v
Return: { success: false, error: "SIZE_ERROR", details: "Content exceeds the 25 MB limit." }
```

---

## 10. Container Architecture

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
- Base image: `node:22-alpine` (supports both x86_64 and ARM64 per NFR-7).
- No volume mounts required -- all state is transient (in-memory EPUB generation, no persistent storage).

**docker-compose.yml** defines a single service. An optional SMTP relay sidecar (e.g., `namshi/smtp`) can be added if the user prefers to relay through a local container rather than connecting directly to an external SMTP provider.

---

## 11. Testing Strategy

| Layer | Test Type | What Is Tested | Mocking |
|-------|-----------|----------------|---------|
| `converter` | Unit | Markdown-to-EPUB conversion, HTML sanitization, filename generation | None needed -- pure functions |
| `mailer` | Integration | Email composition, attachment encoding, error categorization | Mock SMTP server (e.g., `smtp-tester` or Mailpit in Docker) |
| `tool-handler` | Unit | Validation rules, orchestration flow, response formatting | Mock converter and mailer |
| `config` | Unit | Required variable enforcement, type coercion, defaults | Controlled `process.env` |
| End-to-end | Integration | Full pipeline from tool call to SMTP dispatch | Mock SMTP server, real converter |

The converter being a pure-function module with no I/O is a direct result of the separation of concerns -- it is the most testable component and the one most likely to have edge cases (malformed Markdown, large documents, special characters in titles).

---

## 12. Addressing Open Questions

| Question | Recommendation |
|----------|---------------|
| **OQ-1** (Amazon email bounces) | Accept "email dispatched" as success. Bounce detection is asynchronous and outside the system's control. Document this limitation clearly in the tool's response message. |
| **OQ-3** (Remote authentication) | Use bearer token authentication for HTTP/SSE transport. Token is configured via `MCP_AUTH_TOKEN` environment variable. This is sufficient for a single-user tool accessed over an encrypted channel. |
| **OQ-4** (Preview capability) | Defer to a future version. The architecture supports adding a `preview_document` tool that calls the converter but skips the mailer -- the separation between conversion and delivery makes this trivial to add. |
| **OQ-5** (Multiple Kindle addresses) | Single address for v1. Supporting multiple addresses would require changing the tool schema (adding a `device` parameter) and the configuration model. The current architecture isolates these in `tool-handler` and `config` respectively, so the change would be contained. |

---

## 13. Separation of Concerns Summary

The table below maps each functional requirement from the spec to exactly one owning module, demonstrating that no module has overlapping responsibilities.

| Module | Owns Requirements | Does NOT Handle |
|--------|-------------------|-----------------|
| `config` | FR-13, FR-14, NFR-3 (credential isolation) | Anything at runtime after initialization |
| `tool-handler` | FR-1, FR-2, FR-3, FR-11, FR-12, FR-15, FR-16, FR-17 | Markdown parsing, SMTP connections |
| `converter` | FR-4, FR-5, FR-6, FR-9, NFR-4 (sanitization) | Email, configuration, transport |
| `mailer` | FR-7, FR-8, FR-10 | Content formatting, validation |
| `logger` | NFR-6 | Business logic decisions |
| Transport (SDK) | C-1, C-2, C-3, NFR-5 | Everything above the wire protocol |

Each module can be understood, tested, and modified independently. A change to the EPUB structure (e.g., adding CSS styling) affects only `converter`. A change to the email provider affects only `mailer`. A change to the tool schema affects only `tool-handler`. This is the core architectural property the design preserves.
