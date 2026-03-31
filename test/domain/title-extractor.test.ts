import { describe, it, expect } from "vitest";
import { extractTitle } from "../../src/domain/title-extractor.js";

describe("extractTitle", () => {
  it("extracts title from first H1", () => {
    const result = extractTitle("# My Article\n\nSome content", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("My Article");
  });

  it("uses first H1 when multiple exist", () => {
    const result = extractTitle("# First\n\n# Second", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("First");
  });

  it("falls back to filename without .md extension", () => {
    const result = extractTitle("No heading here", "my-article.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("my-article");
  });

  it("falls back to filename without .MD extension (case insensitive)", () => {
    const result = extractTitle("No heading here", "notes.MD");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("notes");
  });

  it("falls back to full filename if no .md extension", () => {
    const result = extractTitle("No heading here", "readme");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("readme");
  });

  it("trims whitespace from H1 content", () => {
    const result = extractTitle("#   Spaced Title   \n\nBody", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("Spaced Title");
  });

  it("returns error for empty content with empty filename", () => {
    const result = extractTitle("", "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  it("ignores H2 and lower headings", () => {
    const result = extractTitle("## Not H1\n### Also not", "fallback.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("fallback");
  });

  it("handles H1 that is not on the first line", () => {
    const result = extractTitle("Some preamble\n\n# Actual Title\n\nBody", "f.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("Actual Title");
  });
});
