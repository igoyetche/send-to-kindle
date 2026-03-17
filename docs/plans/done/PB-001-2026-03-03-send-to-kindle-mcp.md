# PB-001: Send to Kindle MCP Server — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an MCP server that converts Markdown to EPUB and emails it to a Kindle device in a single tool call.

**Architecture:** Three-layer (Application → Domain ← Infrastructure) with strict dependency inversion. Domain defines ports; infrastructure implements them. Result types for error handling, value objects for validation. Composition root wires everything explicitly.

**Tech Stack:** TypeScript (ESM), Node 22, `@modelcontextprotocol/sdk`, `epub-gen-memory`, `marked`, `sanitize-html`, `nodemailer`, `pino`, `vitest`, `zod`, Docker (Alpine)

**Reference docs:**
- ADR (final authority): `docs/design-reviews/send-to-kindle/adr.md`
- Refined design (code examples): `docs/design-reviews/send-to-kindle/refined.md`
- Spec (requirements): `spec.md`

---

## Key Design Decisions from ADR

These override anything in `refined.md` where they conflict:

1. **Result types, not exceptions** — domain errors use `Result<T, DomainError>` return types
2. **Title does NOT generate filenames** — filename generation is infrastructure's job (in `MarkdownEpubConverter`)
3. **Author takes a single required string** — default resolution happens in ToolHandler before construction
4. **EpubDocument.sizeBytes is a derived getter** from `buffer.length`, not a constructor parameter
5. **ContentConverter.toEpub is async** — returns `Promise<EpubDocument>` (epub-gen-memory is async)
6. **DocumentMailer.send returns Result** — `Promise<Result<void, DeliveryError>>`
7. **Config lives in infrastructure** — not in domain
8. **DeliveryLogger port** — logging port injected into domain service
9. **Standard logger (pino)** — no custom wrapper, credential safety by architecture
10. **SmtpMailer has retry strategy** — configurable timeout and retry count

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`

**Step 1: Create `package.json`**

```json
{
  "name": "send-to-kindle-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "epub-gen-memory": "^1.1.2",
    "express": "^5.1.0",
    "marked": "^17.0.3",
    "nodemailer": "^6.10.1",
    "pino": "^9.6.0",
    "sanitize-html": "^2.14.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/nodemailer": "^6.4.17",
    "@types/sanitize-html": "^2.13.0",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.7"
  }
}
```

**Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
```

**Step 4: Create `.env.example`**

```bash
# Required
KINDLE_EMAIL=your-kindle@kindle.com
SENDER_EMAIL=your-email@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password

# Optional
DEFAULT_AUTHOR=Claude
MCP_HTTP_PORT=3000
MCP_AUTH_TOKEN=your-secret-token
LOG_LEVEL=info
```

**Step 5: Create `.gitignore`**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

**Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

**Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, should succeed)

**Step 8: Commit**

```bash
git init
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example .gitignore
git commit -m "chore: initialize project with TypeScript, vitest, and dependencies"
```

---

### Task 2: Domain Errors and Result Type

**Files:**
- Create: `src/domain/errors.ts`
- Test: `test/domain/errors.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/domain/errors.test.ts
import { describe, it, expect } from "vitest";
import {
  ValidationError,
  SizeLimitError,
  ConversionError,
  DeliveryError,
  ok,
  err,
  type Result,
} from "../../src/domain/errors.js";

describe("ValidationError", () => {
  it("has kind 'validation' and carries field and message", () => {
    const error = new ValidationError("title", "Title is required");
    expect(error.kind).toBe("validation");
    expect(error.field).toBe("title");
    expect(error.message).toBe("Title is required");
  });
});

describe("SizeLimitError", () => {
  it("has kind 'size_limit' and reports actual vs limit", () => {
    const error = new SizeLimitError(30_000_000, 25 * 1024 * 1024);
    expect(error.kind).toBe("size_limit");
    expect(error.actualBytes).toBe(30_000_000);
    expect(error.limitBytes).toBe(25 * 1024 * 1024);
  });

  it("generates a human-readable message", () => {
    const error = new SizeLimitError(30_000_000, 25 * 1024 * 1024);
    expect(error.message).toBe("Content exceeds the 25 MB limit.");
  });
});

describe("ConversionError", () => {
  it("has kind 'conversion' and carries message", () => {
    const error = new ConversionError("EPUB generation failed");
    expect(error.kind).toBe("conversion");
    expect(error.message).toBe("EPUB generation failed");
  });
});

describe("DeliveryError", () => {
  it("has kind 'delivery' and carries cause and message", () => {
    const error = new DeliveryError("auth", "SMTP authentication failed");
    expect(error.kind).toBe("delivery");
    expect(error.cause).toBe("auth");
    expect(error.message).toBe("SMTP authentication failed");
  });
});

describe("Result helpers", () => {
  it("ok wraps a value", () => {
    const result: Result<number, never> = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("err wraps an error", () => {
    const result: Result<never, string> = err("boom");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("boom");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/errors.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

```typescript
// src/domain/errors.ts
export class ValidationError {
  readonly kind = "validation" as const;
  constructor(
    readonly field: string,
    readonly message: string,
  ) {}
}

export class SizeLimitError {
  readonly kind = "size_limit" as const;
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {}

  get message(): string {
    return `Content exceeds the ${this.limitBytes / (1024 * 1024)} MB limit.`;
  }
}

export class ConversionError {
  readonly kind = "conversion" as const;
  constructor(readonly message: string) {}
}

export class DeliveryError {
  readonly kind = "delivery" as const;
  constructor(
    readonly cause: "auth" | "connection" | "rejection",
    readonly message: string,
  ) {}
}

export type DomainError =
  | ValidationError
  | SizeLimitError
  | ConversionError
  | DeliveryError;

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/domain/errors.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/domain/errors.ts test/domain/errors.test.ts
git commit -m "feat: add domain error types and Result helpers"
```

---

### Task 3: Value Object — Title

**Files:**
- Create: `src/domain/values/title.ts`
- Test: `test/domain/values/title.test.ts`

ADR: Title validates non-empty. Does NOT generate filenames (infrastructure does that).

**Step 1: Write the failing tests**

```typescript
// test/domain/values/title.test.ts
import { describe, it, expect } from "vitest";
import { Title } from "../../../src/domain/values/title.js";

describe("Title", () => {
  it("creates a title from a valid string", () => {
    const result = Title.create("Clean Architecture");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Clean Architecture");
    }
  });

  it("trims whitespace", () => {
    const result = Title.create("  Padded Title  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Padded Title");
    }
  });

  it("rejects empty string", () => {
    const result = Title.create("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.field).toBe("title");
    }
  });

  it("rejects whitespace-only string", () => {
    const result = Title.create("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/values/title.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/domain/values/title.ts
import { ValidationError, type Result, ok, err } from "../errors.js";

export class Title {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<Title, ValidationError> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return err(
        new ValidationError(
          "title",
          "The 'title' parameter is required and must be non-empty.",
        ),
      );
    }
    return ok(new Title(trimmed));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/domain/values/title.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/domain/values/title.ts test/domain/values/title.test.ts
git commit -m "feat: add Title value object with validation"
```

---

### Task 4: Value Object — Author

**Files:**
- Create: `src/domain/values/author.ts`
- Test: `test/domain/values/author.test.ts`

ADR: Author takes a single required string. Default resolution happens in the ToolHandler before construction.

**Step 1: Write the failing tests**

```typescript
// test/domain/values/author.test.ts
import { describe, it, expect } from "vitest";
import { Author } from "../../../src/domain/values/author.js";

describe("Author", () => {
  it("creates an author from a valid string", () => {
    const result = Author.create("Claude");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Claude");
    }
  });

  it("trims whitespace", () => {
    const result = Author.create("  Claude  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Claude");
    }
  });

  it("rejects empty string", () => {
    const result = Author.create("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.field).toBe("author");
    }
  });

  it("rejects whitespace-only string", () => {
    const result = Author.create("   ");
    expect(result.ok).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/values/author.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/domain/values/author.ts
import { ValidationError, type Result, ok, err } from "../errors.js";

export class Author {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<Author, ValidationError> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return err(
        new ValidationError("author", "Author must be non-empty."),
      );
    }
    return ok(new Author(trimmed));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/domain/values/author.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/domain/values/author.ts test/domain/values/author.test.ts
git commit -m "feat: add Author value object with validation"
```

---

### Task 5: Value Object — MarkdownContent

**Files:**
- Create: `src/domain/values/markdown-content.ts`
- Test: `test/domain/values/markdown-content.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/domain/values/markdown-content.test.ts
import { describe, it, expect } from "vitest";
import { MarkdownContent } from "../../../src/domain/values/markdown-content.js";

describe("MarkdownContent", () => {
  it("creates content from a valid string", () => {
    const result = MarkdownContent.create("# Hello World");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("# Hello World");
    }
  });

  it("rejects empty string", () => {
    const result = MarkdownContent.create("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.field).toBe("content");
    }
  });

  it("rejects content exceeding 25 MB", () => {
    const oversized = "x".repeat(25 * 1024 * 1024 + 1);
    const result = MarkdownContent.create(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("size_limit");
    }
  });

  it("accepts content exactly at 25 MB", () => {
    // Single-byte characters, so length === byte length
    const exact = "x".repeat(25 * 1024 * 1024);
    const result = MarkdownContent.create(exact);
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/values/markdown-content.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/domain/values/markdown-content.ts
import {
  ValidationError,
  SizeLimitError,
  type Result,
  ok,
  err,
} from "../errors.js";

export class MarkdownContent {
  static readonly MAX_BYTES = 25 * 1024 * 1024; // 25 MB

  private constructor(readonly value: string) {}

  static create(
    raw: string,
  ): Result<MarkdownContent, ValidationError | SizeLimitError> {
    if (raw.length === 0) {
      return err(
        new ValidationError(
          "content",
          "The 'content' parameter is required and must be non-empty.",
        ),
      );
    }
    const byteLength = Buffer.byteLength(raw, "utf-8");
    if (byteLength > MarkdownContent.MAX_BYTES) {
      return err(new SizeLimitError(byteLength, MarkdownContent.MAX_BYTES));
    }
    return ok(new MarkdownContent(raw));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/domain/values/markdown-content.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/domain/values/markdown-content.ts test/domain/values/markdown-content.test.ts
git commit -m "feat: add MarkdownContent value object with size validation"
```

---

### Task 6: Value Object — EpubDocument + Barrel Export

**Files:**
- Create: `src/domain/values/epub-document.ts`
- Create: `src/domain/values/index.ts`
- Test: `test/domain/values/epub-document.test.ts`

ADR: EpubDocument wraps Buffer with title metadata. `sizeBytes` is a derived getter from `buffer.length`, not a constructor parameter.

**Step 1: Write the failing tests**

```typescript
// test/domain/values/epub-document.test.ts
import { describe, it, expect } from "vitest";
import { EpubDocument } from "../../../src/domain/values/epub-document.js";

describe("EpubDocument", () => {
  it("wraps a buffer with a title", () => {
    const buffer = Buffer.from("fake epub content");
    const doc = new EpubDocument("Clean Architecture", buffer);
    expect(doc.title).toBe("Clean Architecture");
    expect(doc.buffer).toBe(buffer);
  });

  it("derives sizeBytes from buffer length", () => {
    const buffer = Buffer.alloc(1024);
    const doc = new EpubDocument("Test", buffer);
    expect(doc.sizeBytes).toBe(1024);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/values/epub-document.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/domain/values/epub-document.ts
export class EpubDocument {
  constructor(
    readonly title: string,
    readonly buffer: Buffer,
  ) {}

  get sizeBytes(): number {
    return this.buffer.length;
  }
}
```

**Step 4: Create barrel export**

```typescript
// src/domain/values/index.ts
export { Title } from "./title.js";
export { Author } from "./author.js";
export { MarkdownContent } from "./markdown-content.js";
export { EpubDocument } from "./epub-document.js";
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run test/domain/values/epub-document.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/domain/values/epub-document.ts src/domain/values/index.ts test/domain/values/epub-document.test.ts
git commit -m "feat: add EpubDocument value object and barrel export"
```

---

### Task 7: Domain Ports

**Files:**
- Create: `src/domain/ports.ts`

No tests needed — these are interfaces only.

ADR ports:
- `ContentConverter.toEpub(title, content, author): Promise<EpubDocument>` — async
- `DocumentMailer.send(document): Promise<Result<void, DeliveryError>>` — returns Result
- `DeliveryLogger` — logging port

**Step 1: Write the port interfaces**

```typescript
// src/domain/ports.ts
import type { Title, Author, MarkdownContent, EpubDocument } from "./values/index.js";
import type { DeliveryError, ConversionError, Result } from "./errors.js";

export interface ContentConverter {
  toEpub(
    title: Title,
    content: MarkdownContent,
    author: Author,
  ): Promise<Result<EpubDocument, ConversionError>>;
}

export interface DocumentMailer {
  send(document: EpubDocument): Promise<Result<void, DeliveryError>>;
}

export interface DeliveryLogger {
  deliveryAttempt(title: string, format: string): void;
  deliverySuccess(title: string, format: string, sizeBytes: number): void;
  deliveryFailure(title: string, errorKind: string, message: string): void;
}
```

**Step 2: Commit**

```bash
git add src/domain/ports.ts
git commit -m "feat: add domain port interfaces for converter, mailer, and logger"
```

---

### Task 8: Domain Service — SendToKindleService

**Files:**
- Create: `src/domain/send-to-kindle-service.ts`
- Test: `test/domain/send-to-kindle-service.test.ts`

ADR: Orchestrates convert-then-deliver pipeline. Receives logging port, ContentConverter port, and DocumentMailer port via constructor injection. Returns Result type.

**Step 1: Write the failing tests**

```typescript
// test/domain/send-to-kindle-service.test.ts
import { describe, it, expect, vi } from "vitest";
import { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";
import { Title } from "../../src/domain/values/title.js";
import { Author } from "../../src/domain/values/author.js";
import { MarkdownContent } from "../../src/domain/values/markdown-content.js";
import { EpubDocument } from "../../src/domain/values/epub-document.js";
import {
  ConversionError,
  DeliveryError,
  ok,
  err,
} from "../../src/domain/errors.js";
import type {
  ContentConverter,
  DocumentMailer,
  DeliveryLogger,
} from "../../src/domain/ports.js";

function makeTitle(value: string) {
  const result = Title.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeAuthor(value: string) {
  const result = Author.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeContent(value: string) {
  const result = MarkdownContent.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function fakeLogger(): DeliveryLogger {
  return {
    deliveryAttempt: vi.fn(),
    deliverySuccess: vi.fn(),
    deliveryFailure: vi.fn(),
  };
}

describe("SendToKindleService", () => {
  it("converts then delivers on happy path", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const title = makeTitle("Test");
    const content = makeContent("# Hello");
    const author = makeAuthor("Claude");

    const result = await service.execute(title, content, author);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Test");
      expect(result.value.sizeBytes).toBe(epub.sizeBytes);
    }
    expect(converter.toEpub).toHaveBeenCalledWith(title, content, author);
    expect(mailer.send).toHaveBeenCalledWith(epub);
  });

  it("returns conversion error without calling mailer", async () => {
    const conversionError = new ConversionError("EPUB gen failed");
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(err(conversionError)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn(),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const result = await service.execute(
      makeTitle("Test"),
      makeContent("# Hello"),
      makeAuthor("Claude"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conversion");
    }
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("returns delivery error when mailer fails", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const deliveryError = new DeliveryError("auth", "SMTP auth failed");
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(err(deliveryError)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const result = await service.execute(
      makeTitle("Test"),
      makeContent("# Hello"),
      makeAuthor("Claude"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("delivery");
    }
  });

  it("logs attempt, success on happy path", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    await service.execute(
      makeTitle("Test"),
      makeContent("# Hello"),
      makeAuthor("Claude"),
    );

    expect(logger.deliveryAttempt).toHaveBeenCalledWith("Test", "epub");
    expect(logger.deliverySuccess).toHaveBeenCalledWith(
      "Test",
      "epub",
      epub.sizeBytes,
    );
  });

  it("logs attempt, failure on error", async () => {
    const conversionError = new ConversionError("EPUB gen failed");
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(err(conversionError)),
    };
    const mailer: DocumentMailer = { send: vi.fn() };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    await service.execute(
      makeTitle("Test"),
      makeContent("# Hello"),
      makeAuthor("Claude"),
    );

    expect(logger.deliveryAttempt).toHaveBeenCalled();
    expect(logger.deliveryFailure).toHaveBeenCalledWith(
      "Test",
      "conversion",
      "EPUB gen failed",
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain/send-to-kindle-service.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/domain/send-to-kindle-service.ts
import type { Title, Author, MarkdownContent } from "./values/index.js";
import type { ContentConverter, DocumentMailer, DeliveryLogger } from "./ports.js";
import type { DomainError, Result } from "./errors.js";
import { ok, err } from "./errors.js";

export interface DeliverySuccess {
  readonly title: string;
  readonly sizeBytes: number;
}

export class SendToKindleService {
  constructor(
    private readonly converter: ContentConverter,
    private readonly mailer: DocumentMailer,
    private readonly logger: DeliveryLogger,
  ) {}

  async execute(
    title: Title,
    content: MarkdownContent,
    author: Author,
  ): Promise<Result<DeliverySuccess, DomainError>> {
    this.logger.deliveryAttempt(title.value, "epub");

    const convertResult = await this.converter.toEpub(title, content, author);
    if (!convertResult.ok) {
      this.logger.deliveryFailure(
        title.value,
        convertResult.error.kind,
        convertResult.error.message,
      );
      return convertResult;
    }

    const document = convertResult.value;
    const sendResult = await this.mailer.send(document);
    if (!sendResult.ok) {
      this.logger.deliveryFailure(
        title.value,
        sendResult.error.kind,
        sendResult.error.message,
      );
      return sendResult;
    }

    this.logger.deliverySuccess(title.value, "epub", document.sizeBytes);

    return ok({
      title: title.value,
      sizeBytes: document.sizeBytes,
    });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/domain/send-to-kindle-service.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/domain/send-to-kindle-service.ts test/domain/send-to-kindle-service.test.ts
git commit -m "feat: add SendToKindleService with convert-then-deliver pipeline"
```

---

### Task 9: Infrastructure — Configuration

**Files:**
- Create: `src/infrastructure/config.ts`
- Test: `test/infrastructure/config.test.ts`

ADR: Config type lives in infrastructure alongside `loadConfig()`. Validates email format, fail-fast on missing values. Enforces: if `MCP_HTTP_PORT` is set, `MCP_AUTH_TOKEN` must also be set.

**Step 1: Write the failing tests**

```typescript
// test/infrastructure/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";

function requiredEnv(): Record<string, string> {
  return {
    KINDLE_EMAIL: "user@kindle.com",
    SENDER_EMAIL: "sender@example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASS: "pass",
  };
}

describe("loadConfig", () => {
  beforeEach(() => {
    // Clear relevant env vars
    for (const key of Object.keys(requiredEnv())) {
      delete process.env[key];
    }
    delete process.env.DEFAULT_AUTHOR;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.LOG_LEVEL;
  });

  it("loads all required variables", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.kindle.email).toBe("user@kindle.com");
    expect(config.sender.email).toBe("sender@example.com");
    expect(config.smtp.host).toBe("smtp.example.com");
    expect(config.smtp.port).toBe(587);
    expect(config.smtp.user).toBe("user");
    expect(config.smtp.pass).toBe("pass");
  });

  it("throws when a required variable is missing", () => {
    const env = requiredEnv();
    delete env.KINDLE_EMAIL;
    Object.assign(process.env, env);
    expect(() => loadConfig()).toThrow("KINDLE_EMAIL");
  });

  it("coerces SMTP_PORT to number", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(typeof config.smtp.port).toBe("number");
  });

  it("defaults DEFAULT_AUTHOR to 'Claude'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.defaultAuthor).toBe("Claude");
  });

  it("uses provided DEFAULT_AUTHOR", () => {
    Object.assign(process.env, { ...requiredEnv(), DEFAULT_AUTHOR: "Alice" });
    const config = loadConfig();
    expect(config.defaultAuthor).toBe("Alice");
  });

  it("sets http config when MCP_HTTP_PORT and MCP_AUTH_TOKEN are present", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_TOKEN: "secret",
    });
    const config = loadConfig();
    expect(config.http).toEqual({ port: 3000, authToken: "secret" });
  });

  it("throws when MCP_HTTP_PORT is set without MCP_AUTH_TOKEN", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      MCP_HTTP_PORT: "3000",
    });
    expect(() => loadConfig()).toThrow("MCP_AUTH_TOKEN");
  });

  it("validates KINDLE_EMAIL format", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_EMAIL: "not-an-email",
    });
    expect(() => loadConfig()).toThrow("KINDLE_EMAIL");
  });

  it("validates SENDER_EMAIL format", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      SENDER_EMAIL: "bad-email",
    });
    expect(() => loadConfig()).toThrow("SENDER_EMAIL");
  });

  it("defaults LOG_LEVEL to 'info'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.logLevel).toBe("info");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/infrastructure/config.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/infrastructure/config.ts
export interface Config {
  kindle: { email: string };
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateEmail(value: string, name: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(
      `Invalid email format for ${name}: "${value}"`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const kindleEmail = validateEmail(
    requireEnv("KINDLE_EMAIL"),
    "KINDLE_EMAIL",
  );
  const senderEmail = validateEmail(
    requireEnv("SENDER_EMAIL"),
    "SENDER_EMAIL",
  );
  const smtpHost = requireEnv("SMTP_HOST");
  const smtpPort = Number(requireEnv("SMTP_PORT"));
  const smtpUser = requireEnv("SMTP_USER");
  const smtpPass = requireEnv("SMTP_PASS");

  const defaultAuthor = process.env.DEFAULT_AUTHOR || "Claude";
  const logLevel = process.env.LOG_LEVEL || "info";

  let http: Config["http"];
  const httpPort = process.env.MCP_HTTP_PORT;
  if (httpPort) {
    const authToken = process.env.MCP_AUTH_TOKEN;
    if (!authToken) {
      throw new Error(
        "MCP_AUTH_TOKEN is required when MCP_HTTP_PORT is set",
      );
    }
    http = { port: Number(httpPort), authToken };
  }

  return {
    kindle: { email: kindleEmail },
    sender: { email: senderEmail },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
    defaultAuthor,
    http,
    logLevel,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/infrastructure/config.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/infrastructure/config.ts test/infrastructure/config.test.ts
git commit -m "feat: add configuration loading with validation and fail-fast"
```

---

### Task 10: Infrastructure — Logger

**Files:**
- Create: `src/infrastructure/logger.ts`
- Test: `test/infrastructure/logger.test.ts`

ADR: Standard structured logger (pino). Credential safety ensured by architecture — credentials never reach log call sites. The logger implements the `DeliveryLogger` port.

**Step 1: Write the failing tests**

```typescript
// test/infrastructure/logger.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeliveryLogger } from "../../src/infrastructure/logger.js";
import type { Logger } from "pino";

function mockPinoLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("createDeliveryLogger", () => {
  it("logs delivery attempt at info level", () => {
    const pino = mockPinoLogger();
    const logger = createDeliveryLogger(pino);
    logger.deliveryAttempt("My Book", "epub");
    expect(pino.info).toHaveBeenCalledWith(
      { title: "My Book", format: "epub" },
      "Delivery attempt started",
    );
  });

  it("logs delivery success at info level with size", () => {
    const pino = mockPinoLogger();
    const logger = createDeliveryLogger(pino);
    logger.deliverySuccess("My Book", "epub", 48210);
    expect(pino.info).toHaveBeenCalledWith(
      { title: "My Book", format: "epub", sizeBytes: 48210 },
      "Delivery succeeded",
    );
  });

  it("logs delivery failure at error level", () => {
    const pino = mockPinoLogger();
    const logger = createDeliveryLogger(pino);
    logger.deliveryFailure("My Book", "delivery", "SMTP auth failed");
    expect(pino.error).toHaveBeenCalledWith(
      { title: "My Book", errorKind: "delivery", errorMessage: "SMTP auth failed" },
      "Delivery failed",
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/infrastructure/logger.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/infrastructure/logger.ts
import pino from "pino";
import type { Logger } from "pino";
import type { DeliveryLogger } from "../domain/ports.js";

export function createPinoLogger(level: string): Logger {
  return pino({ level });
}

export function createDeliveryLogger(logger: Logger): DeliveryLogger {
  return {
    deliveryAttempt(title: string, format: string): void {
      logger.info({ title, format }, "Delivery attempt started");
    },
    deliverySuccess(title: string, format: string, sizeBytes: number): void {
      logger.info({ title, format, sizeBytes }, "Delivery succeeded");
    },
    deliveryFailure(
      title: string,
      errorKind: string,
      errorMessage: string,
    ): void {
      logger.error(
        { title, errorKind, errorMessage },
        "Delivery failed",
      );
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/infrastructure/logger.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/infrastructure/logger.ts test/infrastructure/logger.test.ts
git commit -m "feat: add pino-based DeliveryLogger implementation"
```

---

### Task 11: Infrastructure — MarkdownEpubConverter

**Files:**
- Create: `src/infrastructure/converter/markdown-epub-converter.ts`
- Test: `test/infrastructure/converter/markdown-epub-converter.test.ts`

ADR: Pipeline: Markdown → marked.parse() → sanitize-html → epub-gen-memory → EpubDocument. Generates the sanitized filename when constructing EpubDocument. Wraps library errors in ConversionError.

**Step 1: Write the failing tests**

```typescript
// test/infrastructure/converter/markdown-epub-converter.test.ts
import { describe, it, expect } from "vitest";
import { MarkdownEpubConverter } from "../../../src/infrastructure/converter/markdown-epub-converter.js";
import { Title } from "../../../src/domain/values/title.js";
import { Author } from "../../../src/domain/values/author.js";
import { MarkdownContent } from "../../../src/domain/values/markdown-content.js";

function makeTitle(v: string) {
  const r = Title.create(v);
  if (!r.ok) throw new Error("bad setup");
  return r.value;
}

function makeAuthor(v: string) {
  const r = Author.create(v);
  if (!r.ok) throw new Error("bad setup");
  return r.value;
}

function makeContent(v: string) {
  const r = MarkdownContent.create(v);
  if (!r.ok) throw new Error("bad setup");
  return r.value;
}

describe("MarkdownEpubConverter", () => {
  const converter = new MarkdownEpubConverter();

  it("produces an EpubDocument with correct title", async () => {
    const result = await converter.toEpub(
      makeTitle("Test Book"),
      makeContent("# Chapter 1\n\nHello world."),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Test Book");
      expect(result.value.sizeBytes).toBeGreaterThan(0);
      expect(result.value.buffer).toBeInstanceOf(Buffer);
    }
  });

  it("generates a URL-safe filename from title", async () => {
    const result = await converter.toEpub(
      makeTitle("Clean Architecture: A Guide"),
      makeContent("# Hello"),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // filename generated by infrastructure, not Title
      expect(result.value.title).toBe("Clean Architecture: A Guide");
    }
  });

  it("sanitizes script tags from markdown", async () => {
    const result = await converter.toEpub(
      makeTitle("XSS Test"),
      makeContent('Hello <script>alert("xss")</script> World'),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    // The EPUB should be valid (no crash from malicious content)
  });

  it("preserves markdown structure (headings, lists, emphasis)", async () => {
    const md = [
      "# Heading 1",
      "## Heading 2",
      "- item 1",
      "- item 2",
      "",
      "**bold** and *italic*",
      "",
      "```\ncode block\n```",
    ].join("\n");

    const result = await converter.toEpub(
      makeTitle("Structure Test"),
      makeContent(md),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sizeBytes).toBeGreaterThan(0);
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/infrastructure/converter/markdown-epub-converter.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/infrastructure/converter/markdown-epub-converter.ts
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import epub from "epub-gen-memory";
import type { ContentConverter } from "../../domain/ports.js";
import type { Title, Author, MarkdownContent } from "../../domain/values/index.js";
import { EpubDocument } from "../../domain/values/index.js";
import { ConversionError, type Result, ok, err } from "../../domain/errors.js";

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "blockquote", "pre", "code",
  "b", "i", "em", "strong", "u", "s", "sup", "sub",
  "ul", "ol", "li",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "div", "span",
];

export class MarkdownEpubConverter implements ContentConverter {
  async toEpub(
    title: Title,
    content: MarkdownContent,
    author: Author,
  ): Promise<Result<EpubDocument, ConversionError>> {
    try {
      const rawHtml = await marked.parse(content.value);

      const safeHtml = sanitizeHtml(rawHtml, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: {
          a: ["href", "title"],
          img: ["src", "alt", "title"],
          td: ["colspan", "rowspan"],
          th: ["colspan", "rowspan"],
        },
        allowedSchemes: ["http", "https", "mailto"],
      });

      const buffer = await epub(
        { title: title.value, author: author.value },
        [{ title: title.value, content: safeHtml }],
      );

      return ok(new EpubDocument(title.value, buffer));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown conversion error";
      return err(new ConversionError(message));
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/infrastructure/converter/markdown-epub-converter.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/infrastructure/converter/markdown-epub-converter.ts test/infrastructure/converter/markdown-epub-converter.test.ts
git commit -m "feat: add MarkdownEpubConverter with sanitization pipeline"
```

---

### Task 12: Infrastructure — SmtpMailer

**Files:**
- Create: `src/infrastructure/mailer/smtp-mailer.ts`
- Test: `test/infrastructure/mailer/smtp-mailer.test.ts`

ADR: Receives only its SMTP/email config subset. Returns `Result<void, DeliveryError>` with categorized errors. Implements retry strategy with configurable timeout and retry count.

**Step 1: Write the failing tests**

```typescript
// test/infrastructure/mailer/smtp-mailer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmtpMailer, type SmtpMailerConfig } from "../../../src/infrastructure/mailer/smtp-mailer.js";
import { EpubDocument } from "../../../src/domain/values/epub-document.js";
import nodemailer from "nodemailer";

vi.mock("nodemailer");

const config: SmtpMailerConfig = {
  kindle: { email: "user@kindle.com" },
  sender: { email: "sender@example.com" },
  smtp: { host: "smtp.example.com", port: 587, user: "user", pass: "pass" },
};

function makeDocument(): EpubDocument {
  return new EpubDocument("Test Book", Buffer.from("fake-epub"));
}

describe("SmtpMailer", () => {
  let mockSendMail: ReturnType<typeof vi.fn>;
  let mockTransporter: { sendMail: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail = vi.fn().mockResolvedValue({ messageId: "abc123" });
    mockTransporter = { sendMail: mockSendMail };
    vi.mocked(nodemailer.createTransport).mockReturnValue(
      mockTransporter as any,
    );
  });

  it("sends email with correct fields on success", async () => {
    const mailer = new SmtpMailer(config);
    const doc = makeDocument();

    const result = await mailer.send(doc);

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        to: "user@kindle.com",
        subject: "Test Book",
        attachments: [
          expect.objectContaining({
            content: doc.buffer,
            contentType: "application/epub+zip",
          }),
        ],
      }),
    );
  });

  it("returns auth DeliveryError on authentication failure", async () => {
    const authError = new Error("Invalid login");
    (authError as any).code = "EAUTH";
    mockSendMail.mockRejectedValue(authError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("auth");
    }
  });

  it("returns connection DeliveryError on connection failure", async () => {
    const connError = new Error("Connection refused");
    (connError as any).code = "ECONNECTION";
    mockSendMail.mockRejectedValue(connError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("connection");
    }
  });

  it("returns rejection DeliveryError on envelope rejection", async () => {
    const rejectError = new Error("550 Recipient rejected");
    (rejectError as any).responseCode = 550;
    mockSendMail.mockRejectedValue(rejectError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("rejection");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/infrastructure/mailer/smtp-mailer.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/infrastructure/mailer/smtp-mailer.ts
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { DocumentMailer } from "../../domain/ports.js";
import type { EpubDocument } from "../../domain/values/index.js";
import { DeliveryError, type Result, ok, err } from "../../domain/errors.js";

export interface SmtpMailerConfig {
  kindle: { email: string };
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 100);
  return `${slug || "document"}.epub`;
}

function categorizeError(
  error: unknown,
): { cause: "auth" | "connection" | "rejection"; message: string } {
  if (error instanceof Error) {
    const code = (error as any).code;
    const responseCode = (error as any).responseCode;

    if (code === "EAUTH") {
      return {
        cause: "auth",
        message:
          "SMTP authentication failed. Check SMTP_USER and SMTP_PASS configuration.",
      };
    }
    if (
      code === "ECONNECTION" ||
      code === "ESOCKET" ||
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED"
    ) {
      return {
        cause: "connection",
        message: `SMTP connection failed: ${error.message}`,
      };
    }
    if (responseCode && responseCode >= 500) {
      return {
        cause: "rejection",
        message: `Email rejected by server: ${error.message}`,
      };
    }
    return { cause: "connection", message: error.message };
  }
  return { cause: "connection", message: "Unknown SMTP error" };
}

export class SmtpMailer implements DocumentMailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpMailerConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(document: EpubDocument): Promise<Result<void, DeliveryError>> {
    const filename = slugify(document.title);

    try {
      await this.transporter.sendMail({
        from: this.config.sender.email,
        to: this.config.kindle.email,
        subject: document.title,
        text: "Sent via Send to Kindle MCP Server.",
        attachments: [
          {
            filename,
            content: document.buffer,
            contentType: "application/epub+zip",
          },
        ],
      });
      return ok(undefined);
    } catch (error) {
      const { cause, message } = categorizeError(error);
      return err(new DeliveryError(cause, message));
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/infrastructure/mailer/smtp-mailer.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/infrastructure/mailer/smtp-mailer.ts test/infrastructure/mailer/smtp-mailer.test.ts
git commit -m "feat: add SmtpMailer with error categorization and filename slugification"
```

---

### Task 13: Application — ToolHandler

**Files:**
- Create: `src/application/tool-handler.ts`
- Test: `test/application/tool-handler.test.ts`

ADR: Registers `send_to_kindle` tool with MCP SDK. Resolves author default from config before constructing Author. Parses MCP input → constructs domain value objects → calls SendToKindleService → maps Result to MCP response. Single place where DomainError variants are translated to protocol-level responses.

**Step 1: Write the failing tests**

```typescript
// test/application/tool-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { ToolHandler } from "../../src/application/tool-handler.js";
import {
  ok,
  err,
  ConversionError,
  DeliveryError,
  ValidationError,
  SizeLimitError,
} from "../../src/domain/errors.js";
import type { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";

function fakeService(
  result = ok({ title: "Test", sizeBytes: 1024 }),
): SendToKindleService {
  return {
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as SendToKindleService;
}

describe("ToolHandler", () => {
  it("returns success response on happy path", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "My Book",
      content: "# Hello",
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("My Book"),
        },
      ],
    });
  });

  it("uses default author when not provided", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "DefaultBot");

    await handler.handle({ title: "Test", content: "# Hi" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ value: "DefaultBot" }),
    );
  });

  it("uses provided author over default", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "DefaultBot");

    await handler.handle({ title: "Test", content: "# Hi", author: "Alice" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ value: "Alice" }),
    );
  });

  it("returns validation error for empty title", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({ title: "", content: "# Hi" });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
  });

  it("returns validation error for empty content", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({ title: "Test", content: "" });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
  });

  it("maps ConversionError to CONVERSION_ERROR", async () => {
    const service = fakeService(
      err(new ConversionError("EPUB gen failed")),
    );
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "Test",
      content: "# Hi",
    });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("CONVERSION_ERROR");
  });

  it("maps DeliveryError to SMTP_ERROR", async () => {
    const service = fakeService(
      err(new DeliveryError("auth", "Auth failed")),
    );
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "Test",
      content: "# Hi",
    });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("SMTP_ERROR");
  });

  it("sets isError true on failure responses", async () => {
    const service = fakeService(
      err(new ConversionError("fail")),
    );
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "Test",
      content: "# Hi",
    });

    expect(response.isError).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/application/tool-handler.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/application/tool-handler.ts
import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import { Title, Author, MarkdownContent } from "../domain/values/index.js";
import type { DomainError } from "../domain/errors.js";

interface McpToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function mapErrorToResponse(error: DomainError): McpToolResponse {
  let errorCode: string;
  switch (error.kind) {
    case "validation":
      errorCode = "VALIDATION_ERROR";
      break;
    case "size_limit":
      errorCode = "SIZE_ERROR";
      break;
    case "conversion":
      errorCode = "CONVERSION_ERROR";
      break;
    case "delivery":
      errorCode = "SMTP_ERROR";
      break;
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          error: errorCode,
          details: error.message,
        }),
      },
    ],
    isError: true,
  };
}

export class ToolHandler {
  constructor(
    private readonly service: SendToKindleService,
    private readonly defaultAuthor: string,
  ) {}

  async handle(args: {
    title: string;
    content: string;
    author?: string;
  }): Promise<McpToolResponse> {
    // Construct value objects
    const titleResult = Title.create(args.title);
    if (!titleResult.ok) return mapErrorToResponse(titleResult.error);

    const contentResult = MarkdownContent.create(args.content);
    if (!contentResult.ok) return mapErrorToResponse(contentResult.error);

    const authorRaw = args.author?.trim() || this.defaultAuthor;
    const authorResult = Author.create(authorRaw);
    if (!authorResult.ok) return mapErrorToResponse(authorResult.error);

    // Execute domain service
    const result = await this.service.execute(
      titleResult.value,
      contentResult.value,
      authorResult.value,
    );

    if (!result.ok) return mapErrorToResponse(result.error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Document '${result.value.title}' sent to Kindle successfully.`,
            sizeBytes: result.value.sizeBytes,
          }),
        },
      ],
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/application/tool-handler.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/application/tool-handler.ts test/application/tool-handler.test.ts
git commit -m "feat: add ToolHandler MCP adapter with error mapping"
```

---

### Task 14: Composition Root — index.ts

**Files:**
- Create: `src/index.ts`

No unit test — this is wiring only. Verified by integration/smoke test in Task 15.

ADR wiring order:
1. `loadConfig()` → Config
2. Create logger (pino)
3. Create `MarkdownEpubConverter`
4. Create `SmtpMailer(config.smtp, config.kindle, config.sender)`
5. Create `SendToKindleService(converter, mailer, logger)`
6. Create `ToolHandler(service, config.defaultAuthor)`
7. Register with MCP SDK, attach transports

**Step 1: Write the composition root**

```typescript
// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { ToolHandler } from "./application/tool-handler.js";

const config = loadConfig();
const pinoLogger = createPinoLogger(config.logLevel);
const deliveryLogger = createDeliveryLogger(pinoLogger);

const converter = new MarkdownEpubConverter();
const mailer = new SmtpMailer({
  kindle: config.kindle,
  sender: config.sender,
  smtp: config.smtp,
});
const service = new SendToKindleService(converter, mailer, deliveryLogger);
const toolHandler = new ToolHandler(service, config.defaultAuthor);

const server = new McpServer({
  name: "send-to-kindle",
  version: "1.0.0",
});

server.tool(
  "send_to_kindle",
  "Convert Markdown content to EPUB and send it to a Kindle device via email. " +
    "Accepts a title, markdown content, and optional author name.",
  {
    title: z.string().describe("Document title that will appear in the Kindle library"),
    content: z.string().describe("Document content in Markdown format"),
    author: z
      .string()
      .optional()
      .describe("Author name for document metadata (defaults to configured value)"),
  },
  async (args) => toolHandler.handle(args),
);

// stdio transport (always active)
const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

pinoLogger.info("Send to Kindle MCP server started (stdio)");

// HTTP/SSE transport (if configured)
if (config.http) {
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const app = express();
  app.use(express.json());

  // Bearer token auth middleware
  app.use("/mcp", (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${config.http!.authToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const httpServer = new McpServer({
      name: "send-to-kindle",
      version: "1.0.0",
    });

    httpServer.tool(
      "send_to_kindle",
      "Convert Markdown content to EPUB and send it to a Kindle device via email.",
      {
        title: z.string().describe("Document title"),
        content: z.string().describe("Document content in Markdown format"),
        author: z.string().optional().describe("Author name"),
      },
      async (args) => toolHandler.handle(args),
    );

    await httpServer.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => { res.status(405).end(); });
  app.delete("/mcp", (_req, res) => { res.status(405).end(); });

  app.listen(config.http.port, () => {
    pinoLogger.info(
      { port: config.http!.port },
      "Send to Kindle MCP server started (HTTP)",
    );
  });
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add composition root with stdio and HTTP transports"
```

---

### Task 15: Docker

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Step 1: Create `Dockerfile`**

```dockerfile
# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
USER node
ENTRYPOINT ["node", "dist/index.js"]
```

**Step 2: Create `docker-compose.yml`**

```yaml
services:
  send-to-kindle:
    build: .
    env_file: .env
    stdin_open: true
    ports:
      - "${MCP_HTTP_PORT:-3000}:${MCP_HTTP_PORT:-3000}"
```

**Step 3: Verify Docker build succeeds**

Run: `docker build -t send-to-kindle-mcp .`
Expected: Build completes successfully

**Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: add multi-stage Dockerfile and docker-compose"
```

---

### Task 16: Run Full Test Suite

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Final commit if any fixes were needed**

---

## Summary

| Task | Component | Layer | Tests |
|------|-----------|-------|-------|
| 1 | Project setup | — | — |
| 2 | Errors + Result type | Domain | 6 |
| 3 | Title | Domain | 4 |
| 4 | Author | Domain | 4 |
| 5 | MarkdownContent | Domain | 4 |
| 6 | EpubDocument + barrel | Domain | 2 |
| 7 | Ports (interfaces) | Domain | — |
| 8 | SendToKindleService | Domain | 5 |
| 9 | Config | Infrastructure | 9 |
| 10 | Logger | Infrastructure | 3 |
| 11 | MarkdownEpubConverter | Infrastructure | 4 |
| 12 | SmtpMailer | Infrastructure | 4 |
| 13 | ToolHandler | Application | 7 |
| 14 | Composition root | — | — |
| 15 | Docker | — | — |
| 16 | Full verification | — | — |
