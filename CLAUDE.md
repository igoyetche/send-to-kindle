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

## Coding Conventions

### TypeScript Configuration

- **tsconfig.json:** Maximum strictness from day one (`strict: true`, `noImplicitAny: true`, `noUncheckedIndexedAccess: true`, etc.)
- **No `any` type.** Ever. There's always a better solution. Check library types, read source code, use generics, use `unknown` and narrow.
- **No `as` type assertions.** If types don't match, your model is wrong. Fix the types, not the symptoms.
- **No `@ts-ignore`, `@ts-expect-error`, or `!` assertions.** These silence the compiler. Understand the error and fix it.

### Naming Conventions

**Types & Interfaces:**
- Use PascalCase: `Title`, `Author`, `ContentConverter`, `DeliveryError`
- Value objects: `Title`, `MarkdownContent`, `EpubDocument`
- Ports (interfaces): `ContentConverter`, `DocumentMailer`, `DeliveryLogger`
- Result type: `Result<T, E>` (generic error handling)

**Functions & Methods:**
- Use camelCase: `toEpub()`, `send()`, `loadConfig()`
- Action verbs for functions: `convert`, `validate`, `send`, `load`, `parse`
- Question for boolean: `isValid()`, `isEmpty()`, `shouldRetry()`

**Constants:**
- Use UPPER_SNAKE_CASE: `DEFAULT_AUTHOR`, `MAX_FILE_SIZE`, `SMTP_TIMEOUT_MS`

**Variables:**
- Use camelCase: `emailAddress`, `documentTitle`, `smtpConfig`

### Value Objects (Domain Layer)

```typescript
// Immutable, self-validating
export class Title {
  readonly value: string;

  constructor(value: string) {
    if (!value || value.trim().length === 0) {
      throw new Error('Title cannot be empty');
    }
    this.value = value.trim();
  }
}

// Export single static constructor if validation is complex
export class MarkdownContent {
  private constructor(readonly value: string) {}

  static create(value: string): Result<MarkdownContent, ValidationError> {
    if (!value || value.trim().length === 0) {
      return { kind: 'error', error: { kind: 'validation', details: '...' } };
    }
    if (Buffer.byteLength(value) > MAX_SIZE) {
      return { kind: 'error', error: { kind: 'sizeLimitError', ... } };
    }
    return { kind: 'ok', value: new MarkdownContent(value) };
  }
}
```

**Principles:**
- Validation happens at construction (throw) or via factory method (return `Result`)
- Properties are `readonly`
- No getters/setters—expose the invariant as a property
- No methods that mutate state (immutable by default)

### Ports & Dependencies (Domain Layer)

```typescript
// Interface contract, language-agnostic
export interface ContentConverter {
  toEpub(title: Title, content: MarkdownContent, author: Author): Promise<EpubDocument>;
}

export interface DocumentMailer {
  send(document: EpubDocument): Promise<Result<void, DeliveryError>>;
}

export interface DeliveryLogger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
```

**Principles:**
- One responsibility per port
- Async operations return `Promise<T>` or `Promise<Result<T, E>>`
- Error handling uses `Result` types, not exceptions
- Parameterize with domain value objects, not primitives

### Error Handling (Domain Layer)

```typescript
// Discriminated union for exhaustive type checking
export type DomainError =
  | { kind: 'validation'; details: string }
  | { kind: 'sizeLimitError'; maxBytes: number; actualBytes: number }
  | { kind: 'conversionError'; details: string }
  | { kind: 'deliveryError'; category: 'auth' | 'connection' | 'rejection'; details: string };

// Result type for safe error propagation
export type Result<T, E> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: E };

// Usage at call sites
const result = await converter.toEpub(title, content, author);
if (result.kind === 'error') {
  // TypeScript narrows result.error to EpubDocument
  switch (result.error.kind) {
    case 'conversionError': return handleConversionError(...);
    case 'sizeLimitError': return handleSizeError(...);
    // Compiler enforces exhaustiveness
  }
}
```

**Principles:**
- Use `Result<T, E>` instead of throwing exceptions in domain code
- Discriminated unions with `kind` field enable exhaustive switching
- Compiler enforces all error cases are handled
- Errors contain actionable context (not just messages)

### Service Construction (Domain Layer)

```typescript
export class SendToKindleService {
  constructor(
    private converter: ContentConverter,
    private mailer: DocumentMailer,
    private logger: DeliveryLogger,
  ) {}

  async send(title: Title, content: MarkdownContent, author: Author): Promise<Result<void, DomainError>> {
    // Service orchestrates, doesn't execute
    const epubResult = await this.converter.toEpub(title, content, author);
    if (epubResult.kind === 'error') {
      this.logger.error('Conversion failed', { title: title.value, error: epubResult.error });
      return epubResult; // Propagate
    }

    const deliveryResult = await this.mailer.send(epubResult.value);
    if (deliveryResult.kind === 'error') {
      this.logger.error('Delivery failed', { title: title.value, error: deliveryResult.error });
      return deliveryResult;
    }

    this.logger.info('Delivery succeeded', { title: title.value, size: epubResult.value.sizeBytes });
    return { kind: 'ok', value: undefined };
  }
}
```

**Principles:**
- Services receive all dependencies via constructor (no `new` inside services)
- Services orchestrate, they don't implement conversions or delivery
- Services propagate `Result` types, don't catch and re-throw
- Logging happens at service layer (error paths + success), never in domain values

### Infrastructure Implementations

```typescript
export class MarkdownEpubConverter implements ContentConverter {
  async toEpub(title: Title, content: MarkdownContent, author: Author): Promise<EpubDocument> {
    try {
      const html = marked.parse(content.value);
      const sanitized = sanitizeHtml(html, { /* config */ });
      const buffer = await epubGenMemory({ title: title.value, content: sanitized, author: author.value });
      const filename = sanitizeFilename(title.value) + '.epub';
      return new EpubDocument(buffer, title, filename);
    } catch (err) {
      throw new Error(`EPUB conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export class SmtpMailer implements DocumentMailer {
  constructor(private config: SmtpConfig, private logger: DeliveryLogger) {}

  async send(document: EpubDocument): Promise<Result<void, DeliveryError>> {
    try {
      // Implementation with retry logic, timeout enforcement
      await this.sendWithRetry(document);
      return { kind: 'ok', value: undefined };
    } catch (err) {
      return { kind: 'error', error: this.categorizeError(err) };
    }
  }

  private categorizeError(err: unknown): DeliveryError {
    // Map caught errors to domain DeliveryError discriminants
    if (err instanceof AuthError) return { kind: 'deliveryError', category: 'auth', details: err.message };
    if (err instanceof ConnectError) return { kind: 'deliveryError', category: 'connection', details: err.message };
    return { kind: 'deliveryError', category: 'rejection', details: 'Unknown error' };
  }
}
```

**Principles:**
- Implement ports exactly as defined (same signatures)
- Infrastructure code may throw errors; catch and convert to domain types
- Configuration lives in infrastructure, not domain
- Dependencies are injected via constructor

### Composition Root (`index.ts`)

```typescript
async function main() {
  // Load config first (fail-fast)
  const config = loadConfig();
  const logger = createLogger(config);

  // Wire dependencies bottom-up
  const converter = new MarkdownEpubConverter();
  const mailer = new SmtpMailer(config.smtp, logger);
  const service = new SendToKindleService(converter, mailer, logger);

  // Attach to MCP
  const handler = new ToolHandler(service, config.defaultAuthor);
  const server = setupMcp(handler);

  // Start transports
  if (config.httpPort) {
    startHttpTransport(server, config.httpPort, config.authToken);
  }
  startStdioTransport(server);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Principles:**
- Single place where object graph is constructed
- Dependency direction is clear and visual
- Fail-fast: config validation happens before object creation

### Imports and Layer Boundaries

```typescript
// ✅ CORRECT: Domain imports only domain
import { Title, Author, MarkdownContent } from '../domain/values';
import { SendToKindleService } from '../domain/send-to-kindle-service';

// ❌ WRONG: Domain imports infrastructure
import { MarkdownEpubConverter } from '../infrastructure/converter';

// ✅ CORRECT: Infrastructure imports domain contracts
import { ContentConverter } from '../domain/ports';
import { DeliveryError } from '../domain/errors';

// ✅ CORRECT: Application imports both
import { SendToKindleService } from '../domain/send-to-kindle-service';
import { ToolHandler } from './tool-handler';
```

**Principles:**
- Domain layer: imports only domain (values, services, ports, errors)
- Infrastructure layer: imports domain contracts and errors, never application
- Application layer: imports domain and infrastructure; orchestrates them
- Circular imports are a bug—fix the module boundary

### Testing Patterns

```typescript
// Domain service test (no infrastructure dependencies)
describe('SendToKindleService', () => {
  let service: SendToKindleService;
  let mockConverter: Partial<ContentConverter>;
  let mockMailer: Partial<DocumentMailer>;

  beforeEach(() => {
    mockConverter = {
      toEpub: jest.fn().mockResolvedValue({ kind: 'ok', value: new EpubDocument(...) })
    };
    mockMailer = {
      send: jest.fn().mockResolvedValue({ kind: 'ok', value: undefined })
    };
    service = new SendToKindleService(mockConverter as ContentConverter, mockMailer as DocumentMailer, logger);
  });

  it('should convert and deliver', async () => {
    const result = await service.send(title, content, author);
    expect(result.kind).toBe('ok');
  });

  it('should propagate conversion errors', async () => {
    (mockConverter.toEpub as jest.Mock).mockResolvedValue({
      kind: 'error',
      error: { kind: 'conversionError', details: 'Invalid markdown' }
    });
    const result = await service.send(title, content, author);
    expect(result.kind).toBe('error');
  });
});

// Value object test
describe('Title', () => {
  it('should reject empty strings', () => {
    expect(() => new Title('')).toThrow();
  });

  it('should trim whitespace', () => {
    const title = new Title('  Hello  ');
    expect(title.value).toBe('Hello');
  });
});
```

**Principles:**
- Test domain logic in isolation with fake ports
- Test error paths exhaustively
- Test value object invariants at construction
- No mocking domain objects; mock only ports

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
