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
