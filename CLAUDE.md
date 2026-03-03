# Send to Kindle MCP Server

A single-user MCP server that lets Claude send Markdown content to a Kindle device in one step—no manual formatting, no copy-paste. The system converts Markdown to EPUB and emails it to your configured Kindle address.

## Project Overview

**Purpose:** Enable Claude to deliver generated content (summaries, articles, research notes) directly to a Kindle device.

**Core workflow:** User asks Claude → Claude generates Markdown → Claude invokes `send_to_kindle` tool → system converts to EPUB and sends via email → document appears in Kindle library.

**Key constraints:**
- Single-user personal tool (no multi-tenant)
- Markdown input only → EPUB output only
- Support local (stdio) and remote (HTTP/SSE) MCP transports
- Containerized, runs on x86_64 and ARM64

See `docs/spec.md` for full requirements. See `docs/design-reviews/send-to-kindle/adr.md` for architecture decisions.

## Architecture

**Three-layer design** (strict dependency direction):
```
Application Layer  →  Domain Layer  ←  Infrastructure Layer
```

**Domain Layer:**
- Value objects: `Title`, `Author`, `MarkdownContent`, `EpubDocument`
- Service: `SendToKindleService` (orchestrates convert-then-deliver)
- Ports: `ContentConverter`, `DocumentMailer` (injected dependencies)
- Errors: Discriminated union `Result<T, DomainError>` for type-safe error handling

**Infrastructure Layer:**
- `MarkdownEpubConverter`: Markdown → `marked.parse()` → `sanitize-html` → `epub-gen-memory` → EPUB
- `SmtpMailer`: SMTP delivery with retry logic and timeout enforcement
- `Config`: Environment-based configuration with fail-fast validation

**Application Layer:**
- `ToolHandler`: MCP adapter, tool registration, error mapping
- Transport: stdio (default) + HTTP/SSE (when `MCP_HTTP_PORT` is set)

See `docs/design-reviews/send-to-kindle/adr.md` for full design rationale.

## Project Structure

```
src/
  domain/
    values/          # Immutable value objects
    ports.ts         # Interface contracts (ContentConverter, DocumentMailer)
    errors.ts        # Domain error discriminated union
    send-to-kindle-service.ts
  infrastructure/
    converter/       # EPUB generation (markdown-epub-converter.ts)
    mailer/          # Email delivery (smtp-mailer.ts)
    config.ts        # Configuration loading & validation
    logger.ts        # Structured logging
  application/
    tool-handler.ts  # MCP tool adapter
  index.ts           # Composition root, transports
Dockerfile           # Multi-stage build, Node 22 Alpine
docker-compose.yml
.env.example
package.json
tsconfig.json
```

## Setup

```bash
npm install
```

## Configuration

Required environment variables (see `.env.example`):

```
KINDLE_EMAIL=your-kindle-email@kindle.com
SENDER_EMAIL=approved-sender@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
DEFAULT_AUTHOR=Claude
```

**For HTTP/SSE transport (remote access):**
```
MCP_HTTP_PORT=3000
MCP_AUTH_TOKEN=your-secret-token
```

## Development

### Run locally (stdio transport)

```bash
npm run dev
```

### Run with HTTP/SSE transport

Set `MCP_HTTP_PORT` and `MCP_AUTH_TOKEN`, then:

```bash
npm run dev
```

The server listens on `http://localhost:3000` and requires Bearer token authentication.

### Build for production

```bash
npm run build
```

Compiles TypeScript to `dist/` directory.

## Docker

```bash
# Build
docker build -t send-to-kindle-mcp .

# Run with stdio (local)
docker run -i --env-file .env send-to-kindle-mcp

# Run with HTTP/SSE (remote)
docker run -p 3000:3000 --env-file .env send-to-kindle-mcp
```

## Design Principles

- **Type safety without compromise:** No `any`, no `as` assertions. Maximum TypeScript strictness.
- **Result types, not exceptions:** Domain errors use `Result<T, E>` for compile-time exhaustiveness checking.
- **Value objects validate once:** Invariants enforced at construction; no scattered validation.
- **Dependency injection:** All services receive dependencies via constructor; no global state.
- **Fail-fast config:** Configuration errors surface at startup, not at runtime during mail delivery.
- **Credential safety:** SMTP credentials and Kindle email never reach log output or tool responses.

## Testing

Test structure evolves during implementation. Prioritize:
1. Domain service (unit tests with fake converter/mailer)
2. Value object invariants
3. Error handling paths
4. Configuration validation

## Notes

- Learning MVP — focus on clear, simple code over premature optimization
- Don't commit `node_modules`, compiled `dist/`, or `.env`
- Architecture supports future extensions: preview mode, multiple Kindle addresses, delivery confirmation
