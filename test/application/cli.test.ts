import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import {
  parseArgs,
  resolveContentSource,
  mapErrorToExitCode,
  formatSuccess,
  formatError,
  run,
} from "../../src/application/cli.js";
import type { CliArgs, CliDeps } from "../../src/application/cli.js";
import {
  ValidationError,
  SizeLimitError,
  ConversionError,
  DeliveryError,
  ok,
  err,
} from "../../src/domain/errors.js";
import type { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import type { FrontmatterParser } from "../../src/domain/ports.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCliArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    kind: "args",
    title: "Test Title",
    filePath: undefined,
    author: undefined,
    device: undefined,
    help: false,
    version: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  describe("FR-CLI-1: happy path", () => {
    it("parses --title and --file into CliArgs", () => {
      const result = parseArgs(["--title", "Test", "--file", "notes.md"]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.title).toBe("Test");
        expect(result.filePath).toBe("notes.md");
        expect(result.help).toBe(false);
        expect(result.version).toBe(false);
      }
    });

    it("parses --title, --author, and --device into CliArgs with all fields populated", () => {
      const result = parseArgs([
        "--title", "Test",
        "--author", "Team",
        "--device", "partner",
      ]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.title).toBe("Test");
        expect(result.author).toBe("Team");
        expect(result.device).toBe("partner");
      }
    });

    it("parses all flags together", () => {
      const result = parseArgs([
        "--title", "My Doc",
        "--file", "doc.md",
        "--author", "Alice",
        "--device", "alice-kindle",
      ]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.title).toBe("My Doc");
        expect(result.filePath).toBe("doc.md");
        expect(result.author).toBe("Alice");
        expect(result.device).toBe("alice-kindle");
        expect(result.help).toBe(false);
        expect(result.version).toBe(false);
      }
    });

    it("returns CliArgs with help: true when --help is passed", () => {
      const result = parseArgs(["--help"]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.help).toBe(true);
        expect(result.version).toBe(false);
      }
    });

    it("returns CliArgs with version: true when --version is passed", () => {
      const result = parseArgs(["--version"]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.version).toBe(true);
        expect(result.help).toBe(false);
      }
    });

    it("allows --help without --title (title not required for boolean flags)", () => {
      const result = parseArgs(["--help"]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.title).toBe("");
      }
    });

    it("allows --version without --title (title not required for boolean flags)", () => {
      const result = parseArgs(["--version"]);

      expect(result.kind).toBe("args");
    });

    it("parses flags in any order", () => {
      const result = parseArgs(["--author", "Bob", "--title", "My Title"]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.title).toBe("My Title");
        expect(result.author).toBe("Bob");
      }
    });
  });

  describe("FR-CLI-1: error cases", () => {
    it("allows empty argv (title is optional at parse level, resolved later)", () => {
      const result = parseArgs([]);

      expect(result.kind).toBe("args");
      if (result.kind === "args") {
        expect(result.title).toBe("");
        expect(result.help).toBe(false);
        expect(result.version).toBe(false);
      }
    });

    it("returns ParseError when --title flag has no value", () => {
      const result = parseArgs(["--title"]);

      expect(result.kind).toBe("parse-error");
      if (result.kind === "parse-error") {
        expect(result.message).toContain("--title");
      }
    });

    it("returns ParseError when --file flag has no value", () => {
      const result = parseArgs(["--title", "My Doc", "--file"]);

      expect(result.kind).toBe("parse-error");
      if (result.kind === "parse-error") {
        expect(result.message).toContain("--file");
      }
    });

    it("returns ParseError when --author flag has no value", () => {
      const result = parseArgs(["--title", "My Doc", "--author"]);

      expect(result.kind).toBe("parse-error");
      if (result.kind === "parse-error") {
        expect(result.message).toContain("--author");
      }
    });

    it("returns ParseError when --device flag has no value", () => {
      const result = parseArgs(["--title", "My Doc", "--device"]);

      expect(result.kind).toBe("parse-error");
      if (result.kind === "parse-error") {
        expect(result.message).toContain("--device");
      }
    });

    it("returns ParseError mentioning unknown flag when given --unknown", () => {
      const result = parseArgs(["--unknown", "value"]);

      expect(result.kind).toBe("parse-error");
      if (result.kind === "parse-error") {
        expect(result.message).toContain("--unknown");
      }
    });

    it("returns ParseError when a value-bearing flag is followed by another flag instead of a value", () => {
      const result = parseArgs(["--title", "--file"]);

      expect(result.kind).toBe("parse-error");
      if (result.kind === "parse-error") {
        expect(result.message).toContain("--title");
      }
    });

    it("returns ParseError when a bare word without -- prefix is passed", () => {
      const result = parseArgs(["myfile.md"]);

      expect(result.kind).toBe("parse-error");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveContentSource
// ---------------------------------------------------------------------------

describe("resolveContentSource", () => {
  describe("FR-CLI-1: content source resolution", () => {
    it("returns file source when filePath is provided", () => {
      const args = makeCliArgs({ filePath: "notes.md" });
      const result = resolveContentSource(args, true);

      expect(result).toEqual({ kind: "file", path: "notes.md" });
    });

    it("returns file source when filePath is provided regardless of isTTY", () => {
      const args = makeCliArgs({ filePath: "article.md" });

      expect(resolveContentSource(args, false)).toEqual({ kind: "file", path: "article.md" });
      expect(resolveContentSource(args, true)).toEqual({ kind: "file", path: "article.md" });
    });

    it("returns stdin source when filePath is undefined and isTTY is false (piped input)", () => {
      const args = makeCliArgs({ filePath: undefined });
      const result = resolveContentSource(args, false);

      expect(result).toEqual({ kind: "stdin" });
    });

    it('returns "missing" when filePath is undefined and isTTY is true (interactive terminal)', () => {
      const args = makeCliArgs({ filePath: undefined });
      const result = resolveContentSource(args, true);

      expect(result).toBe("missing");
    });
  });
});

// ---------------------------------------------------------------------------
// mapErrorToExitCode
// ---------------------------------------------------------------------------

describe("mapErrorToExitCode", () => {
  describe("FR-CLI-2: exit code mapping", () => {
    it("maps ValidationError to exit code 1", () => {
      const error = new ValidationError("title", "Title is required");
      expect(mapErrorToExitCode(error)).toBe(1);
    });

    it("maps SizeLimitError to exit code 1", () => {
      const error = new SizeLimitError(30 * 1024 * 1024, 25 * 1024 * 1024);
      expect(mapErrorToExitCode(error)).toBe(1);
    });

    it("maps ConversionError to exit code 2", () => {
      const error = new ConversionError("EPUB generation failed");
      expect(mapErrorToExitCode(error)).toBe(2);
    });

    it("maps DeliveryError with auth cause to exit code 3", () => {
      const error = new DeliveryError("auth", "Authentication failed");
      expect(mapErrorToExitCode(error)).toBe(3);
    });

    it("maps DeliveryError with connection cause to exit code 3", () => {
      const error = new DeliveryError("connection", "Connection refused");
      expect(mapErrorToExitCode(error)).toBe(3);
    });

    it("maps DeliveryError with rejection cause to exit code 3", () => {
      const error = new DeliveryError("rejection", "Message rejected");
      expect(mapErrorToExitCode(error)).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// formatSuccess
// ---------------------------------------------------------------------------

describe("formatSuccess", () => {
  describe("FR-CLI-3: success output formatting", () => {
    it("returns a string containing the title, device name, and byte count", () => {
      const result = formatSuccess({
        title: "Test",
        sizeBytes: 1024,
        deviceName: "personal",
      });

      expect(result).toContain("Test");
      expect(result).toContain("personal");
      expect(result).toContain("1024");
    });

    it("includes title in single quotes", () => {
      const result = formatSuccess({
        title: "My Article",
        sizeBytes: 2048,
        deviceName: "work",
      });

      expect(result).toContain("'My Article'");
    });

    it("includes device name in parentheses", () => {
      const result = formatSuccess({
        title: "Notes",
        sizeBytes: 512,
        deviceName: "partner",
      });

      expect(result).toContain("(partner)");
    });

    it("produces the exact expected format for a representative input", () => {
      const result = formatSuccess({
        title: "Test",
        sizeBytes: 1024,
        deviceName: "personal",
      });

      expect(result).toBe("Sent 'Test' to Kindle (personal) — 1024 bytes");
    });
  });
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe("formatError", () => {
  describe("FR-CLI-3: error output formatting", () => {
    it('returns a string starting with "Error:"', () => {
      const result = formatError("something went wrong");

      expect(result.startsWith("Error:")).toBe(true);
    });

    it("includes the provided message in the output", () => {
      const message = "Could not connect to SMTP server";
      const result = formatError(message);

      expect(result).toContain(message);
    });

    it("produces the exact expected format", () => {
      const result = formatError("validation failed");

      expect(result).toBe("Error: validation failed");
    });

    it("handles empty string message", () => {
      const result = formatError("");

      expect(result).toBe("Error: ");
    });
  });
});

// ---------------------------------------------------------------------------
// run helpers
// ---------------------------------------------------------------------------

function makeRunDevice(name: string, email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup: invalid email");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup: invalid device name");
  return deviceResult.value;
}

function makeRunRegistry(...names: string[]): DeviceRegistry {
  const devices = names.map((n, i) => makeRunDevice(n, `d${i}@kindle.com`));
  const result = DeviceRegistry.create(devices);
  if (!result.ok) throw new Error("bad test setup: invalid registry");
  return result.value;
}

function fakeRunService(
  result = ok({ title: "Test", sizeBytes: 1024, deviceName: "personal" }),
): Pick<SendToKindleService, "execute"> {
  return {
    execute: vi.fn().mockResolvedValue(result),
  };
}

function fakeFrontmatterParser(): FrontmatterParser {
  return {
    parse: vi.fn((raw: string) => {
      // Return the raw content as body with empty metadata
      // This simulates: no frontmatter → metadata is empty, body is the raw content
      return ok({
        metadata: DocumentMetadata.empty(),
        body: raw,
      });
    }),
  };
}

function makeDeps(overrides?: Partial<CliDeps>): CliDeps {
  return {
    service: fakeRunService(),
    devices: makeRunRegistry("personal"),
    defaultAuthor: "Claude",
    frontmatterParser: fakeFrontmatterParser(),
    argv: ["--title", "Test", "--file", "notes.md"],
    isTTY: true,
    readFromFile: vi.fn().mockResolvedValue("# Hello"),
    readFromStdin: vi.fn().mockResolvedValue("# Hello"),
    stdin: Readable.from([]),
    stderr: vi.fn(),
    version: "1.0.0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe("run", () => {
  describe("FR-CLI-4: happy path", () => {
    it("FR-CLI-4: returns 0 and writes success message to stderr on valid args and successful service result", async () => {
      const service = fakeRunService(
        ok({ title: "Test", sizeBytes: 2048, deviceName: "personal" }),
      );
      const stderr = vi.fn();
      const deps = makeDeps({ service, stderr });

      const code = await run(deps);

      expect(code).toBe(0);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toContain("Test");
      expect(combined).toContain("personal");
    });
  });

  describe("FR-CLI-4: --help and --version flags", () => {
    it("FR-CLI-4: returns 0 and writes usage text to stderr when --help is passed", async () => {
      const stderr = vi.fn();
      const deps = makeDeps({ argv: ["--help"], stderr });

      const code = await run(deps);

      expect(code).toBe(0);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toContain("paperboy");
      expect(combined).toContain("--title");
    });

    it("FR-CLI-4: returns 0 and writes version string to stderr when --version is passed", async () => {
      const stderr = vi.fn();
      const deps = makeDeps({ argv: ["--version"], stderr, version: "2.3.4" });

      const code = await run(deps);

      expect(code).toBe(0);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      expect(calls).toContain("2.3.4");
    });
  });

  describe("FR-CLI-4: unresolvable title", () => {
    it("FR-CLI-4: returns 1 and writes error to stderr when stdin has no title in frontmatter or --title arg", async () => {
      const stderr = vi.fn();
      // Stdin without --title and no frontmatter → unresolvable title
      const readFromStdin = vi.fn().mockResolvedValue("Just body content with no H1");
      const deps = makeDeps({
        argv: [], // No --title, no --file (so will use stdin)
        isTTY: false,
        readFromStdin,
        stderr,
      });

      const code = await run(deps);

      expect(code).toBe(1);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toMatch(/title|error/i);
    });
  });

  describe("FR-CLI-4: --file pointing to nonexistent file", () => {
    it("FR-CLI-4: returns 1 and writes not-found message to stderr when --file path does not exist", async () => {
      const stderr = vi.fn();
      const readFromFile = vi.fn().mockRejectedValue(
        new Error("ENOENT: no such file or directory, open 'ghost.md'"),
      );
      const deps = makeDeps({
        argv: ["--title", "Test", "--file", "ghost.md"],
        readFromFile,
        stderr,
      });

      const code = await run(deps);

      expect(code).toBe(1);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toMatch(/not found|no such file|ENOENT/i);
    });
  });

  describe("FR-CLI-4: --file pointing to oversized file", () => {
    it("FR-CLI-4: returns 1 and writes size limit message to stderr when file content exceeds 25 MB", async () => {
      const oversizedContent = "x".repeat(26 * 1024 * 1024);
      const stderr = vi.fn();
      const readFromFile = vi.fn().mockResolvedValue(oversizedContent);
      const deps = makeDeps({
        argv: ["--title", "Test", "--file", "big.md"],
        readFromFile,
        stderr,
      });

      const code = await run(deps);

      expect(code).toBe(1);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toMatch(/limit|size|MB/i);
    });
  });

  describe("FR-CLI-4: empty stdin content", () => {
    it('FR-CLI-4: returns 1 and writes "No content received" to stderr when stdin yields empty string', async () => {
      const stderr = vi.fn();
      const readFromStdin = vi.fn().mockResolvedValue("");
      const deps = makeDeps({
        argv: ["--title", "Test"],
        isTTY: false,
        readFromStdin,
        stderr,
      });

      const code = await run(deps);

      expect(code).toBe(1);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toContain("No content received");
    });
  });

  describe("FR-CLI-4: stdin with isTTY: true and no --file", () => {
    it("FR-CLI-4: returns 1 and writes message about using --file or piping when stdin is a TTY and no --file given", async () => {
      const stderr = vi.fn();
      const deps = makeDeps({
        argv: ["--title", "Test"],
        isTTY: true,
        stderr,
      });

      const code = await run(deps);

      expect(code).toBe(1);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toMatch(/--file|pipe/i);
    });
  });

  describe("FR-CLI-4: service error exit codes", () => {
    it("FR-CLI-4: returns 2 when service returns ConversionError", async () => {
      const service = fakeRunService(err(new ConversionError("EPUB gen failed")));
      const deps = makeDeps({ service });

      const code = await run(deps);

      expect(code).toBe(2);
    });

    it("FR-CLI-4: returns 3 when service returns DeliveryError", async () => {
      const service = fakeRunService(err(new DeliveryError("auth", "bad credentials")));
      const deps = makeDeps({ service });

      const code = await run(deps);

      expect(code).toBe(3);
    });
  });

  describe("FR-CLI-4: device resolution", () => {
    it("FR-CLI-4: calls service with the resolved device when --device matches a registered device", async () => {
      const service = fakeRunService(
        ok({ title: "Test", sizeBytes: 512, deviceName: "partner" }),
      );
      const deps = makeDeps({
        service,
        argv: ["--title", "Test", "--file", "notes.md", "--device", "partner"],
        devices: makeRunRegistry("personal", "partner"),
      });

      const code = await run(deps);

      expect(code).toBe(0);
      expect(service.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ name: "partner" }),
      );
    });

    it("FR-CLI-4: returns 1 with error listing available devices when --device is unknown", async () => {
      const stderr = vi.fn();
      const deps = makeDeps({
        argv: ["--title", "Test", "--file", "notes.md", "--device", "unknown-device"],
        devices: makeRunRegistry("personal", "partner"),
        stderr,
      });

      const code = await run(deps);

      expect(code).toBe(1);
      const calls = stderr.mock.calls.map((c) => c[0] as string);
      const combined = calls.join("\n");
      expect(combined).toContain("personal");
      expect(combined).toContain("partner");
    });
  });

  describe("FR-CLI-4: default author", () => {
    it("FR-CLI-4: calls service with the default author from deps when --author flag is not provided", async () => {
      const service = fakeRunService();
      const deps = makeDeps({
        service,
        argv: ["--title", "Test", "--file", "notes.md"],
        defaultAuthor: "DefaultBot",
      });

      await run(deps);

      expect(service.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ value: "DefaultBot" }),
        expect.anything(),
      );
    });
  });
});
