import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processFile } from "../../src/application/watcher.js";
import type { WatcherDeps } from "../../src/application/watcher.js";
import {
  ConversionError,
  DeliveryError,
  ok,
  err,
} from "../../src/domain/errors.js";
import type { DeliverySuccess } from "../../src/domain/send-to-kindle-service.js";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import { Author } from "../../src/domain/values/author.js";

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

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  const successResult: DeliverySuccess = {
    title: "My Article",
    sizeBytes: 1024,
    deviceName: "personal",
  };

  return {
    service: {
      execute: vi.fn().mockResolvedValue(ok(successResult)),
    },
    devices: makeRegistry(),
    defaultAuthor: makeAuthor(),
    watchFolder: "/watch",
    readFile: vi.fn().mockResolvedValue("# My Article\n\nContent here."),
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
});
