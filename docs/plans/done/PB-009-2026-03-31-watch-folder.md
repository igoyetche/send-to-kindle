# PB-009: Watch Folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `paperboy watch` foreground watcher that automatically converts and sends `.md` files dropped into a configured inbox folder to Kindle.

**Architecture:** The watcher is the third entry point into the domain (alongside MCP and CLI). It reuses all existing domain/infrastructure components, adding a new composition root (`watch-entry.ts`), application orchestrator (`application/watcher.ts`), domain title extractor, and infrastructure wrappers for chokidar and file operations. `cli-entry.ts` gains subcommand routing to delegate `paperboy watch` to the watcher module.

**Tech Stack:** TypeScript, chokidar v5 (file watching), vitest (testing), pino (logging)

**Design:** `docs/designs/PB-009-watch-folder/design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/domain/title-extractor.ts` | Extract title from first H1 in markdown, fall back to filename |
| Create | `src/application/watcher.ts` | Orchestrate file events: read, extract title, call service, move files |
| Create | `src/infrastructure/watcher/folder-watcher.ts` | Wrap chokidar for file system watching |
| Create | `src/infrastructure/watcher/file-mover.ts` | Move files to sent/error, write error files |
| Create | `src/watch-entry.ts` | Watcher composition root (dotenv, config, wire deps, start) |
| Modify | `src/cli-entry.ts` | Add subcommand routing: `watch` before `--help`/`--version` |
| Modify | `src/infrastructure/config.ts` | Add optional `watchFolder` to `Config` |
| Create | `scripts/service-templates/windows-task.xml` | Windows Task Scheduler template |
| Create | `scripts/service-templates/com.paperboy.watcher.plist` | macOS launchd template |
| Create | `scripts/service-templates/paperboy-watcher.service` | Linux systemd template |
| Create | `test/domain/title-extractor.test.ts` | Title extractor unit tests |
| Create | `test/application/watcher.test.ts` | Watcher orchestration unit tests |
| Create | `test/infrastructure/watcher/folder-watcher.test.ts` | Folder watcher unit tests |
| Create | `test/infrastructure/watcher/file-mover.test.ts` | File mover unit tests |
| Create | `test/integration/watch-binary.test.ts` | Integration: `paperboy watch --help` |

---

## Task 1: Install chokidar dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install chokidar**

```bash
npm install chokidar@^4
```

Note: chokidar v4 is the latest on npm. The design says v5 but v4 is the actual latest major. The `awaitWriteFinish` API is confirmed supported.

- [ ] **Step 2: Verify installation**

```bash
node -e "const c = await import('chokidar'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add chokidar dependency for watch folder feature"
```

---

## Task 2: Domain — Title extractor

**Files:**
- Create: `src/domain/title-extractor.ts`
- Create: `test/domain/title-extractor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/domain/title-extractor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractTitle } from "../../src/domain/title-extractor.js";

describe("extractTitle", () => {
  it("extracts title from first H1", () => {
    const result = extractTitle("# My Article\n\nSome content", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("My Article");
    }
  });

  it("uses first H1 when multiple exist", () => {
    const result = extractTitle("# First\n\n# Second", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("First");
    }
  });

  it("falls back to filename without .md extension", () => {
    const result = extractTitle("No heading here", "my-article.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("my-article");
    }
  });

  it("falls back to filename without .MD extension (case insensitive)", () => {
    const result = extractTitle("No heading here", "notes.MD");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("notes");
    }
  });

  it("falls back to full filename if no .md extension", () => {
    const result = extractTitle("No heading here", "readme");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("readme");
    }
  });

  it("trims whitespace from H1 content", () => {
    const result = extractTitle("#   Spaced Title   \n\nBody", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Spaced Title");
    }
  });

  it("returns error for empty content with empty filename", () => {
    const result = extractTitle("", "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("ignores H2 and lower headings", () => {
    const result = extractTitle("## Not H1\n### Also not", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("fallback");
    }
  });

  it("handles H1 that is not on the first line", () => {
    const result = extractTitle("Some preamble\n\n# Actual Title\n\nBody", "f.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Actual Title");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/domain/title-extractor.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement title extractor**

Create `src/domain/title-extractor.ts`:

```typescript
import { Title } from "./values/title.js";
import { type Result, type ValidationError } from "./errors.js";

/**
 * Extracts a Title from the first H1 heading in markdown content.
 * Falls back to the filename (without .md extension) if no H1 is found.
 * Delegates to Title.create for validation.
 */
export function extractTitle(
  content: string,
  filename: string,
): Result<Title, ValidationError> {
  const h1Match = /^#\s+(.+)$/m.exec(content);

  if (h1Match?.[1] !== undefined) {
    return Title.create(h1Match[1]);
  }

  const fallback = filename.replace(/\.md$/i, "");
  return Title.create(fallback);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/domain/title-extractor.test.ts
```

Expected: 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/title-extractor.ts test/domain/title-extractor.test.ts
git commit -m "feat(domain): add title extractor for watch folder"
```

---

## Task 3: Config — Add optional watchFolder field

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `test/infrastructure/config.test.ts`

- [ ] **Step 1: Read the current config test file**

Read `test/infrastructure/config.test.ts` to understand the existing test patterns before adding new tests.

- [ ] **Step 2: Write the failing test**

Add to the existing `test/infrastructure/config.test.ts` describe block:

```typescript
it("includes watchFolder when WATCH_FOLDER is set", () => {
  process.env.WATCH_FOLDER = "/tmp/kindle-inbox";
  // ... (all required env vars must also be set per existing test setup)
  const config = loadConfig();
  expect(config.watchFolder).toBe("/tmp/kindle-inbox");
});

it("omits watchFolder when WATCH_FOLDER is not set", () => {
  // ... (all required env vars set, but not WATCH_FOLDER)
  const config = loadConfig();
  expect(config.watchFolder).toBeUndefined();
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run test/infrastructure/config.test.ts
```

Expected: FAIL — `watchFolder` not on Config type

- [ ] **Step 4: Add watchFolder to Config interface and loadConfig**

In `src/infrastructure/config.ts`, add `watchFolder` to the `Config` interface:

```typescript
export interface Config {
  devices: DeviceRegistry;
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
  watchFolder?: string;
}
```

In `loadConfig()`, read the optional env var before the `return` statement:

```typescript
const watchFolder = process.env.WATCH_FOLDER || undefined;
```

Add `watchFolder` to the return object:

```typescript
return {
  devices,
  sender: { email: senderEmailResult.value.value },
  smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
  defaultAuthor,
  http,
  logLevel,
  watchFolder,
};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/infrastructure/config.test.ts
```

Expected: all config tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/config.ts test/infrastructure/config.test.ts
git commit -m "feat(config): add optional watchFolder to Config"
```

---

## Task 4: Infrastructure — File mover

**Files:**
- Create: `src/infrastructure/watcher/file-mover.ts`
- Create: `test/infrastructure/watcher/file-mover.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/infrastructure/watcher/file-mover.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createFileMover, type FileMoverDeps } from "../../../src/infrastructure/watcher/file-mover.js";

function makeDeps(overrides?: Partial<FileMoverDeps>): FileMoverDeps {
  return {
    rename: vi.fn<(src: string, dest: string) => Promise<void>>().mockResolvedValue(undefined),
    writeFile: vi.fn<(path: string, content: string) => Promise<void>>().mockResolvedValue(undefined),
    mkdir: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
    exists: vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(false),
    ...overrides,
  };
}

describe("createFileMover", () => {
  describe("moveToSent", () => {
    it("creates sent dir and moves file", async () => {
      const deps = makeDeps();
      const mover = createFileMover("/inbox", deps);

      await mover.moveToSent("/inbox/article.md");

      expect(deps.mkdir).toHaveBeenCalledWith("/inbox/sent");
      expect(deps.rename).toHaveBeenCalledWith("/inbox/article.md", "/inbox/sent/article.md");
    });

    it("appends timestamp when destination exists", async () => {
      const deps = makeDeps({
        exists: vi.fn<(path: string) => Promise<boolean>>()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      });
      const mover = createFileMover("/inbox", deps);

      await mover.moveToSent("/inbox/article.md");

      // Second call to rename should use timestamped name
      const renameCall = vi.mocked(deps.rename).mock.calls[0];
      expect(renameCall).toBeDefined();
      expect(renameCall![1]).toMatch(/\/inbox\/sent\/article-\d+\.md$/);
    });
  });

  describe("moveToError", () => {
    it("creates error dir, moves file, and writes error file", async () => {
      const deps = makeDeps();
      const mover = createFileMover("/inbox", deps);

      await mover.moveToError("/inbox/article.md", "delivery", "SMTP timeout");

      expect(deps.mkdir).toHaveBeenCalledWith("/inbox/error");
      expect(deps.rename).toHaveBeenCalledWith("/inbox/article.md", "/inbox/error/article.md");
      expect(deps.writeFile).toHaveBeenCalledWith(
        "/inbox/error/article.error.txt",
        expect.stringContaining("Error: delivery"),
      );
      expect(deps.writeFile).toHaveBeenCalledWith(
        "/inbox/error/article.error.txt",
        expect.stringContaining("Message: SMTP timeout"),
      );
    });

    it("appends timestamp when destination exists", async () => {
      const deps = makeDeps({
        exists: vi.fn<(path: string) => Promise<boolean>>()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      });
      const mover = createFileMover("/inbox", deps);

      await mover.moveToError("/inbox/article.md", "delivery", "fail");

      const renameCall = vi.mocked(deps.rename).mock.calls[0];
      expect(renameCall).toBeDefined();
      expect(renameCall![1]).toMatch(/\/inbox\/error\/article-\d+\.md$/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/infrastructure/watcher/file-mover.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement file mover**

Create `src/infrastructure/watcher/file-mover.ts`:

```typescript
import { basename, join, extname } from "node:path";

export interface FileMoverDeps {
  rename: (src: string, dest: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

export interface FileMover {
  moveToSent: (filePath: string) => Promise<string>;
  moveToError: (filePath: string, errorKind: string, errorMessage: string) => Promise<string>;
}

function deduplicatePath(
  dir: string,
  name: string,
  ext: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  return (async () => {
    const candidate = join(dir, `${name}${ext}`);
    if (!(await exists(candidate))) return candidate;
    const stamped = join(dir, `${name}-${Date.now()}${ext}`);
    return stamped;
  })();
}

export function createFileMover(inboxPath: string, deps: FileMoverDeps): FileMover {
  const sentDir = join(inboxPath, "sent");
  const errorDir = join(inboxPath, "error");

  return {
    async moveToSent(filePath: string): Promise<string> {
      await deps.mkdir(sentDir);
      const file = basename(filePath);
      const ext = extname(file);
      const name = file.slice(0, -ext.length || undefined);
      const dest = await deduplicatePath(sentDir, name, ext, deps.exists);
      await deps.rename(filePath, dest);
      return dest;
    },

    async moveToError(filePath: string, errorKind: string, errorMessage: string): Promise<string> {
      await deps.mkdir(errorDir);
      const file = basename(filePath);
      const ext = extname(file);
      const name = file.slice(0, -ext.length || undefined);
      const dest = await deduplicatePath(errorDir, name, ext, deps.exists);
      await deps.rename(filePath, dest);

      const errorFileName = `${basename(dest, ext)}.error.txt`;
      const errorFilePath = join(errorDir, errorFileName);
      const errorContent = [
        `Timestamp: ${new Date().toISOString()}`,
        `Error: ${errorKind}`,
        `Message: ${errorMessage}`,
      ].join("\n") + "\n";
      await deps.writeFile(errorFilePath, errorContent);

      return dest;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/infrastructure/watcher/file-mover.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/watcher/file-mover.ts test/infrastructure/watcher/file-mover.test.ts
git commit -m "feat(infra): add file mover for watch folder sent/error handling"
```

---

## Task 5: Infrastructure — Folder watcher (chokidar wrapper)

**Files:**
- Create: `src/infrastructure/watcher/folder-watcher.ts`
- Create: `test/infrastructure/watcher/folder-watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/infrastructure/watcher/folder-watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFolderWatcher, type FolderWatcherOptions } from "../../../src/infrastructure/watcher/folder-watcher.js";

// We test the watcher's filtering and callback logic, not chokidar internals.
// The watcher is constructed with a mock watch function.

describe("createFolderWatcher", () => {
  it("calls onFile for .md files in inbox root", () => {
    const onFile = vi.fn();
    const closeFn = vi.fn().mockResolvedValue(undefined);
    let capturedHandler: ((path: string) => void) | undefined;

    const mockWatch = vi.fn().mockReturnValue({
      on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (path: string) => void) {
        if (event === "add") capturedHandler = handler;
        return this;
      }),
      close: closeFn,
    });

    const opts: FolderWatcherOptions = {
      inboxPath: "/inbox",
      onFile,
      watch: mockWatch,
    };

    createFolderWatcher(opts);

    // Simulate chokidar firing an add event
    expect(capturedHandler).toBeDefined();
    capturedHandler!("/inbox/article.md");

    expect(onFile).toHaveBeenCalledWith("/inbox/article.md");
  });

  it("ignores non-.md files", () => {
    const onFile = vi.fn();
    let capturedHandler: ((path: string) => void) | undefined;

    const mockWatch = vi.fn().mockReturnValue({
      on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (path: string) => void) {
        if (event === "add") capturedHandler = handler;
        return this;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    createFolderWatcher({ inboxPath: "/inbox", onFile, watch: mockWatch });

    capturedHandler!("/inbox/photo.jpg");

    expect(onFile).not.toHaveBeenCalled();
  });

  it("ignores files in sent/ subdirectory", () => {
    const onFile = vi.fn();
    let capturedHandler: ((path: string) => void) | undefined;

    const mockWatch = vi.fn().mockReturnValue({
      on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (path: string) => void) {
        if (event === "add") capturedHandler = handler;
        return this;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    createFolderWatcher({ inboxPath: "/inbox", onFile, watch: mockWatch });

    capturedHandler!("/inbox/sent/article.md");

    expect(onFile).not.toHaveBeenCalled();
  });

  it("ignores files in error/ subdirectory", () => {
    const onFile = vi.fn();
    let capturedHandler: ((path: string) => void) | undefined;

    const mockWatch = vi.fn().mockReturnValue({
      on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (path: string) => void) {
        if (event === "add") capturedHandler = handler;
        return this;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    createFolderWatcher({ inboxPath: "/inbox", onFile, watch: mockWatch });

    capturedHandler!("/inbox/error/article.md");

    expect(onFile).not.toHaveBeenCalled();
  });

  it("close stops the watcher", async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);

    const mockWatch = vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: closeFn,
    });

    const watcher = createFolderWatcher({
      inboxPath: "/inbox",
      onFile: vi.fn(),
      watch: mockWatch,
    });

    await watcher.close();

    expect(closeFn).toHaveBeenCalled();
  });

  it("passes correct chokidar options including ignored paths", () => {
    const mockWatch = vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    createFolderWatcher({
      inboxPath: "/inbox",
      onFile: vi.fn(),
      watch: mockWatch,
    });

    expect(mockWatch).toHaveBeenCalledWith(
      "/inbox",
      expect.objectContaining({
        depth: 0,
        awaitWriteFinish: expect.objectContaining({
          stabilityThreshold: 2000,
          pollInterval: 200,
        }),
      }),
    );

    // Verify ignored paths include sent/ and error/
    const callArgs = mockWatch.mock.calls[0];
    expect(callArgs).toBeDefined();
    const options = callArgs![1] as { ignored?: string[] };
    expect(options.ignored).toContain("/inbox/sent");
    expect(options.ignored).toContain("/inbox/error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/infrastructure/watcher/folder-watcher.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement folder watcher**

Create `src/infrastructure/watcher/folder-watcher.ts`:

```typescript
import { join, dirname, extname, normalize } from "node:path";

interface ChokidarWatcher {
  on: (event: string, handler: (path: string) => void) => ChokidarWatcher;
  close: () => Promise<void>;
}

type WatchFn = (
  path: string,
  options: {
    depth: number;
    ignored: string[];
    awaitWriteFinish: { stabilityThreshold: number; pollInterval: number };
  },
) => ChokidarWatcher;

export interface FolderWatcherOptions {
  inboxPath: string;
  onFile: (filePath: string) => void;
  watch: WatchFn;
}

export interface FolderWatcher {
  close: () => Promise<void>;
}

export function createFolderWatcher(opts: FolderWatcherOptions): FolderWatcher {
  const { inboxPath, onFile, watch } = opts;
  const normalizedInbox = normalize(inboxPath);

  const watcher = watch(inboxPath, {
    depth: 0,
    ignored: [join(inboxPath, "sent"), join(inboxPath, "error")],
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on("add", (filePath: string) => {
    const normalizedFile = normalize(filePath);

    // Defense in depth: only process .md files directly in inbox root
    if (extname(normalizedFile).toLowerCase() !== ".md") return;
    if (normalize(dirname(normalizedFile)) !== normalizedInbox) return;

    onFile(filePath);
  });

  return {
    close: () => watcher.close(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/infrastructure/watcher/folder-watcher.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/watcher/folder-watcher.ts test/infrastructure/watcher/folder-watcher.test.ts
git commit -m "feat(infra): add folder watcher wrapping chokidar"
```

---

## Task 6: Application — Watcher orchestrator

This is the core orchestration module. It receives file events and coordinates: read file, extract title, create value objects, call service, move to sent/error with retry logic.

**Files:**
- Create: `src/application/watcher.ts`
- Create: `test/application/watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/application/watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { processFile, type WatcherDeps } from "../../src/application/watcher.js";
import { Title, Author, MarkdownContent, EpubDocument } from "../../src/domain/values/index.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import {
  ok,
  err,
  DeliveryError,
  ConversionError,
  ValidationError,
} from "../../src/domain/errors.js";

function makeDevice(): KindleDevice {
  const email = EmailAddress.create("user@kindle.com", "email");
  if (!email.ok) throw new Error("bad email");
  const device = KindleDevice.create("personal", email.value);
  if (!device.ok) throw new Error("bad device");
  return device.value;
}

function makeRegistry(): DeviceRegistry {
  const result = DeviceRegistry.create([makeDevice()]);
  if (!result.ok) throw new Error("bad registry");
  return result.value;
}

function makeAuthor(): Author {
  const result = Author.create("Claude");
  if (!result.ok) throw new Error("bad author");
  return result.value;
}

function makeDeps(overrides?: Partial<WatcherDeps>): WatcherDeps {
  return {
    service: {
      execute: vi.fn().mockResolvedValue(ok({ title: "Test", sizeBytes: 1024, deviceName: "personal" })),
    },
    devices: makeRegistry(),
    defaultAuthor: makeAuthor(),
    watchFolder: "/inbox",
    readFile: vi.fn<(path: string) => Promise<string>>().mockResolvedValue("# Test Article\n\nContent here"),
    moveToSent: vi.fn<(path: string) => Promise<string>>().mockResolvedValue("/inbox/sent/article.md"),
    moveToError: vi.fn<(path: string, kind: string, msg: string) => Promise<string>>().mockResolvedValue("/inbox/error/article.md"),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe("processFile", () => {
  it("reads file, extracts title, sends, and moves to sent on success", async () => {
    const deps = makeDeps();
    await processFile("/inbox/article.md", deps);

    expect(deps.readFile).toHaveBeenCalledWith("/inbox/article.md");
    expect(deps.service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Test Article" }),
      expect.objectContaining({ value: "# Test Article\n\nContent here" }),
      expect.objectContaining({ value: "Claude" }),
      expect.objectContaining({ name: "personal" }),
    );
    expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/article.md");
  });

  it("moves to error when file is empty", async () => {
    const deps = makeDeps({
      readFile: vi.fn<(path: string) => Promise<string>>().mockResolvedValue(""),
    });

    await processFile("/inbox/empty.md", deps);

    expect(deps.moveToError).toHaveBeenCalledWith(
      "/inbox/empty.md",
      "validation",
      expect.stringContaining("empty"),
    );
    expect(deps.service.execute).not.toHaveBeenCalled();
  });

  it("moves to error when content exceeds size limit", async () => {
    const bigContent = "x".repeat(26 * 1024 * 1024);
    const deps = makeDeps({
      readFile: vi.fn<(path: string) => Promise<string>>().mockResolvedValue(bigContent),
    });

    await processFile("/inbox/big.md", deps);

    expect(deps.moveToError).toHaveBeenCalledWith(
      "/inbox/big.md",
      "size_limit",
      expect.any(String),
    );
  });

  it("moves to error on conversion failure", async () => {
    const deps = makeDeps({
      service: {
        execute: vi.fn().mockResolvedValue(err(new ConversionError("EPUB gen failed"))),
      },
    });

    await processFile("/inbox/bad.md", deps);

    expect(deps.moveToError).toHaveBeenCalledWith(
      "/inbox/bad.md",
      "conversion",
      "EPUB gen failed",
    );
  });

  it("retries transient SMTP failure then moves to error after exhausting retries", async () => {
    const execute = vi.fn()
      .mockResolvedValue(err(new DeliveryError("connection", "SMTP timeout")));

    const deps = makeDeps({ service: { execute } });

    await processFile("/inbox/article.md", deps);

    // 1 initial + 3 retries = 4 calls
    expect(execute).toHaveBeenCalledTimes(4);
    expect(deps.moveToError).toHaveBeenCalledWith(
      "/inbox/article.md",
      "delivery",
      expect.stringContaining("SMTP timeout"),
    );
  });

  it("does not retry permanent SMTP failure (auth)", async () => {
    const execute = vi.fn()
      .mockResolvedValue(err(new DeliveryError("auth", "Auth failed")));

    const deps = makeDeps({ service: { execute } });

    await processFile("/inbox/article.md", deps);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(deps.moveToError).toHaveBeenCalledWith(
      "/inbox/article.md",
      "delivery",
      "Auth failed",
    );
  });

  it("does not retry permanent SMTP failure (rejection)", async () => {
    const execute = vi.fn()
      .mockResolvedValue(err(new DeliveryError("rejection", "Rejected")));

    const deps = makeDeps({ service: { execute } });

    await processFile("/inbox/article.md", deps);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(deps.moveToError).toHaveBeenCalledWith(
      "/inbox/article.md",
      "delivery",
      "Rejected",
    );
  });

  it("retries transient failure and succeeds on retry", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(err(new DeliveryError("connection", "Timeout")))
      .mockResolvedValueOnce(ok({ title: "Test", sizeBytes: 1024, deviceName: "personal" }));

    const deps = makeDeps({ service: { execute } });

    await processFile("/inbox/article.md", deps);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/article.md");
    expect(deps.moveToError).not.toHaveBeenCalled();
  });

  it("logs warning when read fails and does not move file", async () => {
    const deps = makeDeps({
      readFile: vi.fn<(path: string) => Promise<string>>().mockRejectedValue(new Error("EPERM")),
    });

    await processFile("/inbox/locked.md", deps);

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
    expect(deps.moveToSent).not.toHaveBeenCalled();
    expect(deps.moveToError).not.toHaveBeenCalled();
  });

  it("falls back to filename when no H1 heading", async () => {
    const deps = makeDeps({
      readFile: vi.fn<(path: string) => Promise<string>>().mockResolvedValue("No heading, just content"),
    });

    await processFile("/inbox/my-notes.md", deps);

    expect(deps.service.execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: "my-notes" }),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/application/watcher.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement watcher orchestrator**

Create `src/application/watcher.ts`:

```typescript
import { basename } from "node:path";
import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import type { DeviceRegistry } from "../domain/device-registry.js";
import type { Author } from "../domain/values/author.js";
import { MarkdownContent } from "../domain/values/markdown-content.js";
import { extractTitle } from "../domain/title-extractor.js";

export interface WatcherLogger {
  info: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
}

export interface WatcherDeps {
  service: Pick<SendToKindleService, "execute">;
  devices: DeviceRegistry;
  defaultAuthor: Author;
  watchFolder: string;
  readFile: (path: string) => Promise<string>;
  moveToSent: (filePath: string) => Promise<string>;
  moveToError: (filePath: string, errorKind: string, errorMessage: string) => Promise<string>;
  logger: WatcherLogger;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function isTransient(cause: string): boolean {
  return cause === "connection";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processFile(
  filePath: string,
  deps: WatcherDeps,
): Promise<void> {
  const filename = basename(filePath);

  // Step 1: Read file
  let content: string;
  try {
    content = await deps.readFile(filePath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown read error";
    deps.logger.warn(`Could not read ${filename}: ${message}`);
    return;
  }

  // Step 2: Validate content is not empty
  if (content.length === 0) {
    deps.logger.error(`File ${filename} is empty`);
    await deps.moveToError(filePath, "validation", `File '${filename}' is empty`);
    return;
  }

  // Step 3: Create MarkdownContent value object (validates size)
  const contentResult = MarkdownContent.create(content);
  if (!contentResult.ok) {
    deps.logger.error(`File ${filename}: ${contentResult.error.message}`);
    await deps.moveToError(filePath, contentResult.error.kind, contentResult.error.message);
    return;
  }

  // Step 4: Extract title
  const titleResult = extractTitle(content, filename);
  if (!titleResult.ok) {
    deps.logger.error(`File ${filename}: title extraction failed — ${titleResult.error.message}`);
    await deps.moveToError(filePath, "validation", titleResult.error.message);
    return;
  }

  // Step 5: Resolve device (use default)
  const deviceResult = deps.devices.resolve();
  if (!deviceResult.ok) {
    deps.logger.error(`No device configured: ${deviceResult.error.message}`);
    await deps.moveToError(filePath, "validation", deviceResult.error.message);
    return;
  }

  // Step 6: Send with retry for transient failures
  deps.logger.info(`Processing ${filename}...`);

  let lastError: { kind: string; message: string } | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      deps.logger.info(`Retry ${attempt}/${MAX_RETRIES} for ${filename} in ${backoff}ms`);
      await delay(backoff);
    }

    const result = await deps.service.execute(
      titleResult.value,
      contentResult.value,
      deps.defaultAuthor,
      deviceResult.value,
    );

    if (result.ok) {
      deps.logger.info(`Sent ${filename} (${result.value.sizeBytes} bytes)`);
      await deps.moveToSent(filePath);
      return;
    }

    lastError = { kind: result.error.kind, message: result.error.message };

    // Non-delivery errors: no retry
    if (result.error.kind !== "delivery") {
      break;
    }

    // Permanent delivery errors: no retry
    if (!isTransient(result.error.cause)) {
      break;
    }
  }

  // All retries exhausted or non-retryable error
  deps.logger.error(`Failed to process ${filename}: ${lastError?.message ?? "unknown"}`);
  await deps.moveToError(filePath, lastError?.kind ?? "unknown", lastError?.message ?? "Unknown error");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/application/watcher.test.ts
```

Expected: all tests PASS

Note: The retry tests use real `setTimeout` via `delay()`. If tests are slow, consider using `vi.useFakeTimers()`. For now, the delays in tests are 0ms because the mocked `execute` resolves immediately — the delay only runs when `attempt > 0`, and with mocked fast responses, total test time should be under 30 seconds. If this is too slow, add `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync()` in a follow-up.

- [ ] **Step 5: Commit**

```bash
git add src/application/watcher.ts test/application/watcher.test.ts
git commit -m "feat(app): add watcher orchestrator with retry logic"
```

---

## Task 7: Watcher run loop and graceful shutdown

This adds the top-level `startWatcher` function that wires the folder watcher to the `processFile` orchestrator, handles sequential processing, in-memory deduplication, and graceful shutdown.

**Files:**
- Modify: `src/application/watcher.ts`
- Modify: `test/application/watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/application/watcher.test.ts`:

```typescript
import { startWatcher, processFile, type WatcherDeps } from "../../src/application/watcher.js";

// ... (existing imports and helpers stay)

describe("startWatcher", () => {
  it("processes existing files in inbox on startup", async () => {
    const deps = makeDeps();
    const listFiles = vi.fn<(dir: string, ext: string) => Promise<string[]>>()
      .mockResolvedValue(["/inbox/existing.md"]);

    const { shutdown } = await startWatcher({
      ...deps,
      listFiles,
      createWatcher: vi.fn().mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) }),
    });

    // Give the startup scan time to process
    await new Promise((r) => setTimeout(r, 50));
    await shutdown();

    expect(listFiles).toHaveBeenCalledWith("/inbox", ".md");
    expect(deps.readFile).toHaveBeenCalledWith("/inbox/existing.md");
  });

  it("tracks sent files to avoid re-processing on move failure", async () => {
    const execute = vi.fn()
      .mockResolvedValue(ok({ title: "Test", sizeBytes: 1024, deviceName: "personal" }));

    const moveToSent = vi.fn<(path: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("EPERM"))
      .mockResolvedValueOnce("/inbox/sent/article.md");

    const deps = makeDeps({ service: { execute }, moveToSent });
    const listFiles = vi.fn<(dir: string, ext: string) => Promise<string[]>>()
      .mockResolvedValue([]);

    let capturedOnFile: ((path: string) => void) | undefined;
    const createWatcher = vi.fn().mockImplementation((opts: { onFile: (path: string) => void }) => {
      capturedOnFile = opts.onFile;
      return { close: vi.fn().mockResolvedValue(undefined) };
    });

    const { shutdown } = await startWatcher({
      ...deps,
      listFiles,
      createWatcher,
    });

    // First processing: send succeeds, move fails
    capturedOnFile!("/inbox/article.md");
    await new Promise((r) => setTimeout(r, 50));

    // Second event for same file: should be skipped
    capturedOnFile!("/inbox/article.md");
    await new Promise((r) => setTimeout(r, 50));

    await shutdown();

    // execute called only once (second time skipped)
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/application/watcher.test.ts
```

Expected: FAIL — `startWatcher` not exported

- [ ] **Step 3: Add startWatcher to watcher.ts**

Add the following to the end of `src/application/watcher.ts`:

```typescript
export interface StartWatcherDeps extends WatcherDeps {
  listFiles: (dir: string, ext: string) => Promise<string[]>;
  createWatcher: (opts: { inboxPath: string; onFile: (path: string) => void }) => { close: () => Promise<void> };
}

export interface WatcherHandle {
  shutdown: () => Promise<void>;
}

export async function startWatcher(deps: StartWatcherDeps): Promise<WatcherHandle> {
  const sentPaths = new Set<string>();
  let processing = false;
  let shutdownRequested = false;
  const queue: string[] = [];

  async function drainQueue(): Promise<void> {
    while (queue.length > 0 && !shutdownRequested) {
      const next = queue.shift();
      if (next === undefined) break;

      if (sentPaths.has(next)) {
        deps.logger.warn(`Skipping already-sent file: ${basename(next)}`);
        continue;
      }

      processing = true;
      try {
        await processFile(next, deps);
        await deps.moveToSent(next).catch(() => {
          // Move failed after send — track to prevent re-processing
          sentPaths.add(next);
          deps.logger.warn(`Sent but could not move ${basename(next)}`);
        });
      } catch {
        // processFile handles its own errors; this catches unexpected throws
      }
      processing = false;
    }
  }

  function enqueue(filePath: string): void {
    if (sentPaths.has(filePath)) {
      deps.logger.warn(`Skipping already-sent file: ${basename(filePath)}`);
      return;
    }
    queue.push(filePath);
    void drainQueue();
  }

  // Start file watcher
  const watcher = deps.createWatcher({
    inboxPath: deps.watchFolder,
    onFile: enqueue,
  });

  // Scan existing files on startup
  const existing = await deps.listFiles(deps.watchFolder, ".md");
  for (const file of existing) {
    enqueue(file);
  }

  return {
    shutdown: async () => {
      shutdownRequested = true;
      // Wait for current file to finish
      while (processing) {
        await delay(100);
      }
      await watcher.close();
    },
  };
}
```

**Wait** — There's a design issue. The `processFile` function already calls `moveToSent` internally. The `startWatcher` should NOT call `moveToSent` again. Let me reconsider.

Actually, `processFile` already handles move-to-sent and move-to-error internally. The `startWatcher` just needs to handle the sent-but-not-moved tracking. Let me revise:

Replace the `startWatcher` implementation with:

```typescript
export interface StartWatcherDeps extends WatcherDeps {
  listFiles: (dir: string, ext: string) => Promise<string[]>;
  createWatcher: (opts: { inboxPath: string; onFile: (path: string) => void }) => { close: () => Promise<void> };
}

export interface WatcherHandle {
  shutdown: () => Promise<void>;
}

export async function startWatcher(deps: StartWatcherDeps): Promise<WatcherHandle> {
  const sentPaths = new Set<string>();
  let processing = false;
  let shutdownRequested = false;
  const queue: string[] = [];

  // Wrap moveToSent to track paths on failure
  const wrappedDeps: WatcherDeps = {
    ...deps,
    moveToSent: async (filePath: string) => {
      try {
        return await deps.moveToSent(filePath);
      } catch (e: unknown) {
        sentPaths.add(filePath);
        const msg = e instanceof Error ? e.message : "unknown";
        deps.logger.warn(`Sent but could not move ${basename(filePath)}: ${msg}`);
        return filePath;
      }
    },
  };

  async function processNext(): Promise<void> {
    while (queue.length > 0 && !shutdownRequested) {
      const next = queue.shift();
      if (next === undefined) break;

      if (sentPaths.has(next)) {
        deps.logger.warn(`Skipping already-sent file: ${basename(next)}`);
        continue;
      }

      processing = true;
      await processFile(next, wrappedDeps);
      processing = false;
    }
  }

  function enqueue(filePath: string): void {
    if (sentPaths.has(filePath)) return;
    queue.push(filePath);
    void processNext();
  }

  const watcher = deps.createWatcher({
    inboxPath: deps.watchFolder,
    onFile: enqueue,
  });

  // Scan existing files
  const existing = await deps.listFiles(deps.watchFolder, ".md");
  for (const file of existing) {
    enqueue(file);
  }

  return {
    shutdown: async () => {
      shutdownRequested = true;
      while (processing) {
        await delay(100);
      }
      await watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/application/watcher.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/application/watcher.ts test/application/watcher.test.ts
git commit -m "feat(app): add startWatcher with queue, dedup, and graceful shutdown"
```

---

## Task 8: Composition root — watch-entry.ts

**Files:**
- Create: `src/watch-entry.ts`

- [ ] **Step 1: Create watch-entry.ts**

Create `src/watch-entry.ts`:

```typescript
#!/usr/bin/env node

/**
 * Watch folder composition root.
 *
 * Wires all dependencies and starts the folder watcher. Handles dotenv loading
 * (same pattern as cli-entry.ts), config validation, and graceful shutdown.
 */

import dotenv from "dotenv";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, rename, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { watch } from "chokidar";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { Author } from "./domain/values/author.js";
import { createFileMover } from "./infrastructure/watcher/file-mover.js";
import { createFolderWatcher } from "./infrastructure/watcher/folder-watcher.js";
import { startWatcher } from "./application/watcher.js";
import type { WatcherLogger } from "./application/watcher.js";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// --help handling
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stderr.write(`
paperboy watch — Watch a folder for .md files and send them to Kindle

USAGE
  paperboy watch [--help]

The watcher monitors WATCH_FOLDER for new .md files, converts each to EPUB,
and emails it to your configured Kindle device.

Processed files are moved to WATCH_FOLDER/sent/.
Failed files are moved to WATCH_FOLDER/error/ with an .error.txt file.

CONFIGURATION
  Set WATCH_FOLDER in your .env file or environment:
    WATCH_FOLDER=/path/to/kindle-inbox

  All other configuration (SMTP, devices, author) uses the same env vars
  as the CLI and MCP server.

`.trimStart());
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Load .env (same pattern as cli-entry.ts)
// ---------------------------------------------------------------------------

dotenv.config();

const fallbackPath = join(homedir(), ".paperboy", ".env");
const fallbackResult = dotenv.config({ path: fallbackPath });

if (fallbackResult.error) {
  const nodeError = fallbackResult.error as NodeJS.ErrnoException;
  if (nodeError.code !== "ENOENT") {
    process.stderr.write(
      `Warning: could not parse ${fallbackPath}: ${fallbackResult.error.message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Load and validate config
// ---------------------------------------------------------------------------

try {
  const config = loadConfig();

  if (!config.watchFolder) {
    process.stderr.write(
      "Error: WATCH_FOLDER environment variable is required for the watcher.\n" +
      "Set it in your .env file: WATCH_FOLDER=/path/to/kindle-inbox\n",
    );
    process.exit(4);
  }

  const watchFolder = resolve(config.watchFolder);

  if (!existsSync(watchFolder)) {
    process.stderr.write(`Error: Watch folder does not exist: ${watchFolder}\n`);
    process.exit(4);
  }

  // ---------------------------------------------------------------------------
  // 3. Wire dependencies
  // ---------------------------------------------------------------------------

  const pinoLogger = createPinoLogger(config.logLevel);
  const deliveryLogger = createDeliveryLogger(pinoLogger);
  const converter = new MarkdownEpubConverter();
  const mailer = new SmtpMailer({ sender: config.sender, smtp: config.smtp });
  const service = new SendToKindleService(converter, mailer, deliveryLogger);

  const authorResult = Author.create(config.defaultAuthor);
  if (!authorResult.ok) {
    process.stderr.write(`Error: invalid DEFAULT_AUTHOR: ${authorResult.error.message}\n`);
    process.exit(4);
  }

  const fileMover = createFileMover(watchFolder, {
    rename: async (src, dest) => { await rename(src, dest); },
    writeFile: async (path, content) => { await writeFile(path, content, "utf-8"); },
    mkdir: async (path) => { await mkdir(path, { recursive: true }); },
    exists: async (path) => {
      try { await stat(path); return true; } catch { return false; }
    },
  });

  const logger: WatcherLogger = {
    info: (msg) => pinoLogger.info(msg),
    error: (msg) => pinoLogger.error(msg),
    warn: (msg) => pinoLogger.warn(msg),
  };

  // ---------------------------------------------------------------------------
  // 4. Start watcher
  // ---------------------------------------------------------------------------

  logger.info(`Starting watcher on ${watchFolder}`);

  const handle = await startWatcher({
    service,
    devices: config.devices,
    defaultAuthor: authorResult.value,
    watchFolder,
    readFile: (path) => readFile(path, "utf-8"),
    moveToSent: (filePath) => fileMover.moveToSent(filePath),
    moveToError: (filePath, kind, msg) => fileMover.moveToError(filePath, kind, msg),
    logger,
    listFiles: async (dir, ext) => {
      const entries = await readdir(dir);
      return entries
        .filter((e) => e.endsWith(ext))
        .map((e) => join(dir, e));
    },
    createWatcher: (opts) =>
      createFolderWatcher({
        inboxPath: opts.inboxPath,
        onFile: opts.onFile,
        watch: (path, options) => watch(path, options),
      }),
  });

  // ---------------------------------------------------------------------------
  // 5. Graceful shutdown
  // ---------------------------------------------------------------------------

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await handle.shutdown();
    logger.info("Watcher stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Watcher is running. Press Ctrl+C to stop.");

} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Configuration error: ${message}\n`);
  process.exit(4);
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (or only pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add src/watch-entry.ts
git commit -m "feat: add watch-entry.ts composition root"
```

---

## Task 9: CLI subcommand routing

**Files:**
- Modify: `src/cli-entry.ts`
- Modify: `test/integration/cli-binary.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add to `test/integration/cli-binary.test.ts`:

```typescript
it("delegates to watch --help and exits 0", async () => {
  const WATCH_ENTRY_PATH = resolve("dist/watch-entry.js");
  // This test verifies that `paperboy watch --help` is routed correctly
  const { exitCode, stderr } = await runCli(["watch", "--help"]);

  expect(exitCode).toBe(0);
  expect(stderr).toContain("paperboy watch");
  expect(stderr).toContain("WATCH_FOLDER");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build
npx vitest run test/integration/cli-binary.test.ts
```

Expected: FAIL — `watch` is rejected as "Unexpected argument"

- [ ] **Step 3: Add subcommand routing to cli-entry.ts**

In `src/cli-entry.ts`, add the subcommand check **before** the `--help` and `--version` checks (before line 38). Insert after `const rawArgs = process.argv.slice(2);`:

```typescript
// ---------------------------------------------------------------------------
// 0a. Subcommand routing: "watch" delegates to watch-entry module
// ---------------------------------------------------------------------------

if (rawArgs[0] === "watch") {
  // Replace process.argv so watch-entry sees args after "watch"
  process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs.slice(1)];
  await import("./watch-entry.js");
  // watch-entry handles its own process.exit; this line is only reached
  // if the import completes synchronously (e.g., --help path)
  // eslint-disable-next-line no-restricted-syntax -- watch-entry runs to completion
}
```

Wait — the current `cli-entry.ts` is not an async module at the top level. The `await import()` won't work unless we make the top level async or use `.then()`. Looking at the existing code, lines 104-122 use `await run(...)` inside a try/catch, which means the file already has top-level await.

Actually, looking more carefully at `cli-entry.ts`, the `await run(...)` at line 104 means it's already using top-level await. So we can use `await import()`.

But there's a subtlety: after the dynamic import, `watch-entry.ts` calls `process.exit()` in all paths, so we don't need to worry about fall-through. But to be safe, add an early return pattern. Since this is module-level code, we can't `return`. We need to guard the rest of the file.

Better approach: check for `watch` and use dynamic import, then the watch-entry will `process.exit()` itself. If for some reason it doesn't, we should also exit. Let me restructure:

```typescript
// Insert before the --help check (before current line 38)

// ---------------------------------------------------------------------------
// 0a. Subcommand routing: "watch" delegates to watch-entry module
// ---------------------------------------------------------------------------

if (rawArgs[0] === "watch") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs.slice(1)];
  await import("./watch-entry.js");
  // watch-entry calls process.exit() in all code paths;
  // this is a safety net in case it doesn't
  process.exit(0);
}
```

- [ ] **Step 4: Run build and integration tests**

```bash
npm run build
npx vitest run test/integration/cli-binary.test.ts
```

Expected: all integration tests PASS (including the new watch --help test)

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli-entry.ts test/integration/cli-binary.test.ts
git commit -m "feat(cli): add watch subcommand routing in cli-entry"
```

---

## Task 10: OS service template configs

**Files:**
- Create: `scripts/service-templates/windows-task.xml`
- Create: `scripts/service-templates/com.paperboy.watcher.plist`
- Create: `scripts/service-templates/paperboy-watcher.service`

- [ ] **Step 1: Create Windows Task Scheduler template**

Create `scripts/service-templates/windows-task.xml`:

```xml
<?xml version="1.0" encoding="UTF-16"?>
<!--
  Paperboy Watcher — Windows Task Scheduler config

  HOW TO USE:
  1. Replace C:\path\to\node.exe with your Node.js path (run: where node)
  2. Replace C:\path\to\watch-entry.js with the full path to dist/watch-entry.js
  3. Import: schtasks /create /tn "PaperboyWatcher" /xml "path\to\this\file.xml"

  Or use the one-liner (replace paths):
    schtasks /create /tn "PaperboyWatcher" /tr "\"C:\path\to\node.exe\" \"C:\path\to\watch-entry.js\"" /sc onlogon /rl limited
-->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <!-- Replace with your actual paths -->
      <Command>C:\path\to\node.exe</Command>
      <Arguments>C:\path\to\watch-entry.js</Arguments>
    </Exec>
  </Actions>
</Task>
```

- [ ] **Step 2: Create macOS launchd plist template**

Create `scripts/service-templates/com.paperboy.watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  Paperboy Watcher — macOS launchd config

  HOW TO USE:
  1. Replace /path/to/node with your Node.js path (run: which node)
  2. Replace /path/to/watch-entry.js with the full path to dist/watch-entry.js
  3. Copy to ~/Library/LaunchAgents/ and load:
     cp com.paperboy.watcher.plist ~/Library/LaunchAgents/
     launchctl load ~/Library/LaunchAgents/com.paperboy.watcher.plist

  To unload:
     launchctl unload ~/Library/LaunchAgents/com.paperboy.watcher.plist
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paperboy.watcher</string>

  <key>ProgramArguments</key>
  <array>
    <!-- Replace with your actual paths -->
    <string>/path/to/node</string>
    <string>/path/to/watch-entry.js</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>~/Library/Logs/paperboy-watcher.log</string>

  <key>StandardErrorPath</key>
  <string>~/Library/Logs/paperboy-watcher.log</string>
</dict>
</plist>
```

- [ ] **Step 3: Create Linux systemd service template**

Create `scripts/service-templates/paperboy-watcher.service`:

```ini
# Paperboy Watcher — systemd user unit
#
# HOW TO USE:
# 1. Replace /path/to/node with your Node.js path (run: which node)
# 2. Replace /path/to/watch-entry.js with the full path to dist/watch-entry.js
# 3. Copy and enable:
#    cp paperboy-watcher.service ~/.config/systemd/user/
#    systemctl --user enable --now paperboy-watcher
#
# To check status:
#    systemctl --user status paperboy-watcher
#
# To view logs:
#    journalctl --user -u paperboy-watcher

[Unit]
Description=Paperboy Watcher — auto-send .md files to Kindle
After=network-online.target

[Service]
Type=simple
# Replace with your actual paths
ExecStart=/path/to/node /path/to/watch-entry.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Commit**

```bash
git add scripts/service-templates/
git commit -m "docs: add OS service template configs for watcher"
```

---

## Task 11: Update feature docs and status

**Files:**
- Create: `docs/features/active/PB-009-watch-folder.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/specs/main-spec.md`

- [ ] **Step 1: Create feature doc**

Create `docs/features/active/PB-009-watch-folder.md`:

```markdown
# PB-009: Watch Folder

**Status:** Active
**Date:** 2026-03-31

## Motivation

Users want a "set and forget" way to send Markdown files to their Kindle. Rather than running CLI commands for each file, they drop `.md` files into a folder and the watcher handles conversion and delivery automatically.

## Scope

**Phase 1 (this feature):**
- `paperboy watch` foreground watcher command
- Template service configs in `scripts/service-templates/`
- Documented one-liner install per OS

**Phase 2 (follow-up):**
- `paperboy watch install/uninstall/status` automated service management

## Acceptance Criteria

- [ ] `paperboy watch` starts a foreground watcher on the configured `WATCH_FOLDER`
- [ ] `.md` files dropped into the folder are converted to EPUB and sent to Kindle
- [ ] Processed files are moved to `WATCH_FOLDER/sent/`
- [ ] Failed files are moved to `WATCH_FOLDER/error/` with `.error.txt`
- [ ] Transient SMTP failures are retried up to 3 times with exponential backoff
- [ ] `paperboy watch --help` shows watcher usage
- [ ] Existing `.md` files in the folder are processed on startup
- [ ] Graceful shutdown on SIGINT/SIGTERM
- [ ] Service template configs for Windows, macOS, Linux
```

- [ ] **Step 2: Update STATUS.md**

Add a row for PB-009 with status 🔄 In Progress.

- [ ] **Step 3: Update CHANGELOG.md**

Add entry for PB-009 implementation start.

- [ ] **Step 4: Update main-spec.md**

Add a section for the watch folder feature describing the `WATCH_FOLDER` env var and `paperboy watch` command.

- [ ] **Step 5: Commit**

```bash
git add docs/features/active/PB-009-watch-folder.md docs/STATUS.md docs/CHANGELOG.md docs/specs/main-spec.md
git commit -m "docs: add PB-009 feature doc, update status and changelog"
```

---

## Task 12: Full build and integration verification

- [ ] **Step 1: Run full build**

```bash
npm run build
```

Expected: clean compilation, no errors

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass (existing + new)

- [ ] **Step 3: Run linter**

```bash
npm run lint
```

Expected: no lint errors

- [ ] **Step 4: Manual smoke test**

Create a temporary test folder and test the watcher:

```bash
mkdir -p /tmp/kindle-test-inbox
WATCH_FOLDER=/tmp/kindle-test-inbox node dist/watch-entry.js --help
```

Expected: prints watcher help text and exits 0

```bash
node dist/cli-entry.js watch --help
```

Expected: prints watcher help text (routed through cli-entry) and exits 0

- [ ] **Step 5: Commit any final fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address issues found during integration verification"
```
