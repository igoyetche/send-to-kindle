import { describe, it, expect } from "vitest";
import { resolveTitle } from "../../src/domain/title-resolver.js";
import { ValidationError } from "../../src/domain/errors.js";

describe("resolveTitle", () => {
  it("returns first valid candidate", () => {
    const result = resolveTitle(["Article One", "Article Two"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Article One");
    }
  });

  it("skips undefined candidates", () => {
    const result = resolveTitle([undefined, "Article Two"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Article Two");
    }
  });

  it("skips empty/whitespace candidates", () => {
    const result = resolveTitle(["  ", "", "Article Three"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Article Three");
    }
  });

  it("returns error when all candidates are undefined", () => {
    const result = resolveTitle([undefined, undefined]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns error when all candidates are empty/whitespace", () => {
    const result = resolveTitle(["", "  ", "\n"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it("returns error on empty candidate list", () => {
    const result = resolveTitle([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it("trims whitespace from valid candidates", () => {
    const result = resolveTitle(["  Trimmed Title  "]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("Trimmed Title");
    }
  });
});
