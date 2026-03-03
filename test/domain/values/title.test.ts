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
