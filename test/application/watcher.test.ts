import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processFile, processEpubFile, startWatcher } from "../../src/application/watcher.js";
import type { WatcherDeps, StartWatcherDeps } from "../../src/application/watcher.js";
import {
  ConversionError,
  DeliveryError,
  FrontmatterError,
  ok,
  err,
} from "../../src/domain/errors.js";
import type { DeliverySuccess } from "../../src/domain/send-to-kindle-service.js";
import type { FrontmatterParser } from "../../src/domain/ports.js";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import { Author } from "../../src/domain/values/author.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(): KindleDevice {
  const emailResult = EmailAddress.create("user@kindle.com", "email");
  if (!emailResult.ok) throw new Error("test setup: bad email");
  const deviceResult = KindleDevice.create("personal", emailResult.value);
  if (!deviceResult.ok) throw new Error("test setup: bad device");
  return deviceResult.value;
}

function makeRegistry(): DeviceRegistry {
  const device = makeDevice();
  const registryResult = DeviceRegistry.create([device]);
  if (!registryResult.ok) throw new Error("test setup: bad registry");
  return registryResult.value;
}

function makeAuthor(): Author {
  const result = Author.create("Claude");
  if (!result.ok) throw new Error("test setup: bad author");
  return result.value;
}

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function fakeFrontmatterParser(): FrontmatterParser {
  return {
    parse: vi.fn((raw: string) => {
      // Return the raw content as body with empty metadata
      return ok({
        metadata: DocumentMetadata.empty(),
        body: raw,
      });
    }),
  };
}

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  const successResult: DeliverySuccess = {
    title: "My Article",
    sizeBytes: 1024,
    deviceName: "personal",
  };

  return {
    service: {
      execute: vi.fn().mockResolvedValue(ok(successResult)),
      sendEpub: vi.fn().mockResolvedValue(ok(successResult)),
    },
    devices: makeRegistry(),
    defaultAuthor: makeAuthor(),
    frontmatterParser: fakeFrontmatterParser(),
    watchFolder: "/watch",
    readFile: vi.fn().mockResolvedValue("# My Article\n\nContent here."),
    readEpubFile: vi.fn().mockResolvedValue({
      buffer: Buffer.from("epub-bytes"),
      suggestedTitle: "My EPUB Book",
    }),
    moveToSent: vi.fn().mockResolvedValue("/watch/sent/my-article.md"),
    moveToError: vi.fn().mockResolvedValue("/watch/error/my-article.md"),
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processFile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Success path
  // -------------------------------------------------------------------------

  describe("success path", () => {
    it("reads file, extracts H1 title, sends, moves to sent", async () => {
      const deps = makeDeps();

      const promise = processFile("/inbox/my-article.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.readFile).toHaveBeenCalledWith("/inbox/my-article.md");
      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/my-article.md");
      expect(deps.moveToError).not.toHaveBeenCalled();
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Sent my-article.md"),
      );
    });

    it("logs processing start before sending", async () => {
      const deps = makeDeps();

      const promise = processFile("/inbox/report.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Processing report.md"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Empty file
  // -------------------------------------------------------------------------

  describe("empty file", () => {
    it("moves to error without calling service", async () => {
      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue(""),
      });

      const promise = processFile("/inbox/empty.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).not.toHaveBeenCalled();
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/empty.md",
        "validation",
        expect.stringContaining("empty"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Oversized file
  // -------------------------------------------------------------------------

  describe("oversized file", () => {
    it("moves to error when content exceeds size limit", async () => {
      // SizeLimitError is returned by MarkdownContent.create for oversized content
      // We simulate by mocking the content as a large string
      const oversized = "x".repeat(26 * 1024 * 1024); // 26 MB > 25 MB limit
      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue(oversized),
      });

      const promise = processFile("/inbox/big.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).not.toHaveBeenCalled();
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/big.md",
        "size_limit",
        expect.stringContaining("MB"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Conversion failure
  // -------------------------------------------------------------------------

  describe("conversion failure", () => {
    it("moves to error on conversion error, no retry", async () => {
      const deps = makeDeps({
        service: {
          execute: vi.fn().mockResolvedValue(
            err(new ConversionError("EPUB generation failed")),
          ),
        },
      });

      const promise = processFile("/inbox/article.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/article.md",
        "conversion",
        "EPUB generation failed",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Transient SMTP failure — retries 4 times total (1 + 3), then error
  // -------------------------------------------------------------------------

  describe("transient SMTP failure (connection)", () => {
    it("retries 3 times then moves to error after all attempts fail", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue(err(new DeliveryError("connection", "ECONNREFUSED")));

      const deps = makeDeps({ service: { execute } });

      const promise = processFile("/inbox/a.md", deps);

      // Advance through all retries: 2s + 4s + 8s
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(8000);

      await promise;

      expect(execute).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/a.md",
        "delivery",
        "ECONNREFUSED",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Permanent SMTP failure (auth) — no retry
  // -------------------------------------------------------------------------

  describe("permanent SMTP failure (auth)", () => {
    it("does not retry on auth failure, moves straight to error", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue(err(new DeliveryError("auth", "535 Authentication failed")));

      const deps = makeDeps({ service: { execute } });

      const promise = processFile("/inbox/a.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(execute).toHaveBeenCalledTimes(1);
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/a.md",
        "delivery",
        "535 Authentication failed",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. Permanent SMTP failure (rejection) — no retry
  // -------------------------------------------------------------------------

  describe("permanent SMTP failure (rejection)", () => {
    it("does not retry on rejection failure, moves straight to error", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue(err(new DeliveryError("rejection", "550 Rejected")));

      const deps = makeDeps({ service: { execute } });

      const promise = processFile("/inbox/a.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(execute).toHaveBeenCalledTimes(1);
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/a.md",
        "delivery",
        "550 Rejected",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Transient failure then success on retry
  // -------------------------------------------------------------------------

  describe("transient failure then success", () => {
    it("succeeds on second attempt after one transient failure", async () => {
      const successResult: DeliverySuccess = {
        title: "My Article",
        sizeBytes: 2048,
        deviceName: "personal",
      };

      const execute = vi
        .fn()
        .mockResolvedValueOnce(err(new DeliveryError("connection", "timeout")))
        .mockResolvedValueOnce(ok(successResult));

      const deps = makeDeps({ service: { execute } });

      const promise = processFile("/inbox/a.md", deps);

      // Advance past first retry delay (2s)
      await vi.advanceTimersByTimeAsync(2000);

      await promise;

      expect(execute).toHaveBeenCalledTimes(2);
      expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/a.md");
      expect(deps.moveToError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 9. File read error — logs warning, does NOT move file
  // -------------------------------------------------------------------------

  describe("file read error", () => {
    it("logs a warning and does not move the file when read fails", async () => {
      const deps = makeDeps({
        readFile: vi.fn().mockRejectedValue(new Error("ENOENT: file not found")),
      });

      const promise = processFile("/inbox/missing.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).not.toHaveBeenCalled();
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("ENOENT: file not found"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 10. Filename fallback when no H1
  // -------------------------------------------------------------------------

  describe("filename fallback title", () => {
    it("uses filename (without .md) as title when no H1 heading present", async () => {
      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue("Just some content without a heading."),
      });

      const promise = processFile("/inbox/my-report.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      const [titleArg] = (deps.service.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [{ value: string }, ...unknown[]];
      expect(titleArg.value).toBe("my-report");
      expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/my-report.md");
    });
  });

  // -------------------------------------------------------------------------
  // 11. Frontmatter title resolution
  // -------------------------------------------------------------------------

  describe("frontmatter title resolution", () => {
    it("uses metadata title from frontmatter when present", async () => {
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.fromRecord({ title: "From Metadata" }),
            body: "# This is H1\nBody content",
          }),
        ),
      } as unknown as FrontmatterParser;

      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue("---\ntitle: From Metadata\n---\n# This is H1\nBody content"),
        frontmatterParser,
      });

      const promise = processFile("/inbox/article.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      const [titleArg] = (deps.service.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [{ value: string }, ...unknown[]];
      expect(titleArg.value).toBe("From Metadata");
      expect(deps.moveToSent).toHaveBeenCalled();
    });

    it("prefers metadata title over H1 when both present", async () => {
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.fromRecord({ title: "Metadata Wins" }),
            body: "# H1 Title\nBody",
          }),
        ),
      } as unknown as FrontmatterParser;

      const deps = makeDeps({
        readFile: vi
          .fn()
          .mockResolvedValue("---\ntitle: Metadata Wins\n---\n# H1 Title\nBody"),
        frontmatterParser,
      });

      const promise = processFile("/inbox/test.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      const [titleArg] = (deps.service.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [{ value: string }, ...unknown[]];
      expect(titleArg.value).toBe("Metadata Wins");
    });

    it("falls back to H1 when no metadata title (regression check)", async () => {
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.empty(),
            body: "# H1 Title\nBody",
          }),
        ),
      } as unknown as FrontmatterParser;

      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue("# H1 Title\nBody"),
        frontmatterParser,
      });

      const promise = processFile("/inbox/test.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      const [titleArg] = (deps.service.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [{ value: string }, ...unknown[]];
      expect(titleArg.value).toBe("H1 Title");
    });

    it("falls back to filename when no metadata or H1 (regression check)", async () => {
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.empty(),
            body: "Just content",
          }),
        ),
      } as unknown as FrontmatterParser;

      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue("Just content"),
        frontmatterParser,
      });

      const promise = processFile("/inbox/my-file.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).toHaveBeenCalledTimes(1);
      const [titleArg] = (deps.service.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [{ value: string }, ...unknown[]];
      expect(titleArg.value).toBe("my-file");
    });

    it("moves to error on malformed frontmatter", async () => {
      const frontmatterParser = {
        parse: vi
          .fn()
          .mockReturnValue(err(new FrontmatterError("Invalid YAML in frontmatter"))),
      } as unknown as FrontmatterParser;

      const deps = makeDeps({
        readFile: vi
          .fn()
          .mockResolvedValue("---\ninvalid: yaml: here:\n---\n# Body"),
        frontmatterParser,
      });

      const promise = processFile("/inbox/bad.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.execute).not.toHaveBeenCalled();
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/bad.md",
        "frontmatter",
        expect.stringContaining("YAML"),
      );
    });

    it("strips frontmatter body before MarkdownContent validation", async () => {
      // Create content that would exceed size limit if frontmatter weren't stripped
      const oversizedFrontmatter = "---\n" + "x".repeat(100) + "\n---\n";
      const oversizedBody = "y".repeat(26 * 1024 * 1024); // 26 MB without frontmatter

      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.empty(),
            body: oversizedBody,
          }),
        ),
      } as unknown as FrontmatterParser;

      const deps = makeDeps({
        readFile: vi.fn().mockResolvedValue(oversizedFrontmatter + oversizedBody),
        frontmatterParser,
      });

      const promise = processFile("/inbox/large.md", deps);
      await vi.runAllTimersAsync();
      await promise;

      // Should fail on body size validation, not frontmatter parsing
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/large.md",
        "size_limit",
        expect.stringContaining("MB"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// processEpubFile tests
// ---------------------------------------------------------------------------

describe("processEpubFile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("success path", () => {
    it("reads EPUB, sends via sendEpub, moves to sent", async () => {
      const deps = makeDeps();

      const promise = processEpubFile("/inbox/book.epub", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.readEpubFile).toHaveBeenCalledWith("/inbox/book.epub");
      expect(deps.service.sendEpub).toHaveBeenCalledTimes(1);
      expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/book.epub");
      expect(deps.moveToError).not.toHaveBeenCalled();
      expect(deps.service.execute).not.toHaveBeenCalled();
    });

    it("logs processing start and sent message", async () => {
      const deps = makeDeps();

      const promise = processEpubFile("/inbox/my-book.epub", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Processing my-book.epub"),
      );
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Sent my-book.epub"),
      );
    });

    it("uses title from EPUB metadata (suggestedTitle)", async () => {
      const deps = makeDeps({
        readEpubFile: vi.fn().mockResolvedValue({
          buffer: Buffer.from("epub"),
          suggestedTitle: "Clean Architecture",
        }),
      });

      const promise = processEpubFile("/inbox/book.epub", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.sendEpub).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Clean Architecture" }),
        expect.anything(),
      );
    });
  });

  describe("EPUB read error", () => {
    it("logs a warning and does not move file when readEpubFile throws", async () => {
      const deps = makeDeps({
        readEpubFile: vi.fn().mockRejectedValue(new Error("file too large")),
      });

      const promise = processEpubFile("/inbox/big.epub", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.sendEpub).not.toHaveBeenCalled();
      expect(deps.moveToSent).not.toHaveBeenCalled();
      expect(deps.moveToError).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("file too large"),
      );
    });
  });

  describe("device not configured", () => {
    it("moves to error when device resolution fails", async () => {
      const { ValidationError, err } = await import("../../src/domain/errors.js");
      const fakeDevices = {
        resolve: vi.fn().mockReturnValue(err(new ValidationError("device", "No devices configured"))),
        defaultDevice: undefined,
      } as unknown as DeviceRegistry;
      const deps = makeDeps({ devices: fakeDevices });

      const promise = processEpubFile("/inbox/book.epub", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.service.sendEpub).not.toHaveBeenCalled();
      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/book.epub",
        "validation",
        expect.any(String),
      );
    });
  });

  describe("delivery failure", () => {
    it("moves to error on permanent delivery error", async () => {
      const deps = makeDeps({
        service: {
          execute: vi.fn(),
          sendEpub: vi.fn().mockResolvedValue(err(new DeliveryError("auth", "SMTP auth failed"))),
        },
      });

      const promise = processEpubFile("/inbox/book.epub", deps);
      await vi.runAllTimersAsync();
      await promise;

      expect(deps.moveToError).toHaveBeenCalledWith(
        "/inbox/book.epub",
        "delivery",
        "SMTP auth failed",
      );
      expect(deps.moveToSent).not.toHaveBeenCalled();
    });

    it("retries on transient delivery error then succeeds", async () => {
      const successResult: DeliverySuccess = {
        title: "My EPUB Book",
        sizeBytes: 2048,
        deviceName: "personal",
      };
      const sendEpub = vi
        .fn()
        .mockResolvedValueOnce(err(new DeliveryError("connection", "timeout")))
        .mockResolvedValueOnce(ok(successResult));

      const deps = makeDeps({ service: { execute: vi.fn(), sendEpub } });

      const promise = processEpubFile("/inbox/book.epub", deps);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(sendEpub).toHaveBeenCalledTimes(2);
      expect(deps.moveToSent).toHaveBeenCalledWith("/inbox/book.epub");
      expect(deps.moveToError).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// startWatcher tests
// ---------------------------------------------------------------------------

function makeStartWatcherDeps(overrides: Partial<StartWatcherDeps> = {}): StartWatcherDeps {
  const base = makeDeps(overrides);
  const onFileCallbacks: Array<(path: string) => void> = [];

  return {
    ...base,
    listFiles: vi.fn().mockResolvedValue([]),
    createWatcher: vi.fn().mockImplementation(({ onFile }: { inboxPath: string; onFile: (path: string) => void }) => {
      onFileCallbacks.push(onFile);
      return { close: vi.fn().mockResolvedValue(undefined) };
    }),
    ...overrides,
  };
}

describe("startWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Processes existing files on startup
  // -------------------------------------------------------------------------

  describe("existing files on startup", () => {
    it("processes all existing .md files found in the watch folder", async () => {
      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockImplementation((_dir: string, ext: string) =>
          Promise.resolve(ext === ".md" ? ["/watch/a.md", "/watch/b.md"] : []),
        ),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;
      await handle.shutdown();

      expect(deps.listFiles).toHaveBeenCalledWith("/watch", ".md");
      expect(deps.listFiles).toHaveBeenCalledWith("/watch", ".epub");
      expect(deps.service.execute).toHaveBeenCalledTimes(2);
      expect(deps.moveToSent).toHaveBeenCalledWith("/watch/a.md");
      expect(deps.moveToSent).toHaveBeenCalledWith("/watch/b.md");
    });

    it("processes existing .epub files found in the watch folder", async () => {
      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockImplementation((_dir: string, ext: string) =>
          Promise.resolve(ext === ".epub" ? ["/watch/book.epub"] : []),
        ),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;
      await handle.shutdown();

      expect(deps.listFiles).toHaveBeenCalledWith("/watch", ".epub");
      expect(deps.service.sendEpub).toHaveBeenCalledTimes(1);
      expect(deps.moveToSent).toHaveBeenCalledWith("/watch/book.epub");
    });

    it("handles empty watch folder without error", async () => {
      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockResolvedValue([]),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;
      await handle.shutdown();

      expect(deps.service.execute).not.toHaveBeenCalled();
      expect(deps.service.sendEpub).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Skips already-sent file when moveToSent fails
  // -------------------------------------------------------------------------

  describe("move failure deduplication", () => {
    it("marks file as sent in-memory and skips it on re-enqueue when moveToSent throws", async () => {
      let moveCallCount = 0;
      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockResolvedValue(["/watch/article.md"]),
        moveToSent: vi.fn().mockImplementation(() => {
          moveCallCount++;
          throw new Error("EXDEV: cross-device link not permitted");
        }),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;

      // moveToSent threw — file should be in sentPaths, warn logged
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Sent but could not move article.md"),
      );
      expect(moveCallCount).toBe(1);

      await handle.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // 3. moveToError failure does not crash the queue
  // -------------------------------------------------------------------------

  describe("moveToError failure resilience", () => {
    it("logs a warning and continues processing when moveToError throws", async () => {
      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockResolvedValue(["/watch/bad.md"]),
        readFile: vi.fn().mockResolvedValue(""),
        moveToError: vi.fn().mockRejectedValue(new Error("EPERM: permission denied")),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;
      await handle.shutdown();

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not move bad.md to error/"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Clean shutdown
  // -------------------------------------------------------------------------

  describe("graceful shutdown", () => {
    it("closes the watcher on shutdown", async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockResolvedValue([]),
        createWatcher: vi.fn().mockReturnValue({ close: closeFn }),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;
      await handle.shutdown();

      expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it("waits for in-flight processing before closing watcher", async () => {
      const order: string[] = [];
      let resolveMove!: () => void;
      const moveDone = new Promise<void>((res) => { resolveMove = res; });

      const deps = makeStartWatcherDeps({
        listFiles: vi.fn().mockResolvedValue(["/watch/slow.md"]),
        moveToSent: vi.fn().mockImplementation(async () => {
          await moveDone;
          order.push("moved");
          return "/watch/sent/slow.md";
        }),
        createWatcher: vi.fn().mockReturnValue({
          close: vi.fn().mockImplementation(() => {
            order.push("closed");
          }),
        }),
      });

      const handlePromise = startWatcher(deps);
      await vi.runAllTimersAsync();
      const handle = await handlePromise;

      const shutdownPromise = handle.shutdown();

      // Resolve the in-flight move after shutdown is requested
      resolveMove();
      await vi.runAllTimersAsync();
      await shutdownPromise;

      // moved should come before closed
      expect(order.indexOf("moved")).toBeLessThan(order.indexOf("closed"));
    });
  });
});
