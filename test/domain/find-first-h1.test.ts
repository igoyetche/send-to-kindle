import { describe, it, expect } from "vitest";
import { findFirstH1 } from "../../src/domain/find-first-h1.js";

describe("findFirstH1", () => {
  it("extracts H1 at the start of the document", () => {
    const result = findFirstH1("# My Title\n\nContent");
    expect(result).toBe("My Title");
  });

  it("ignores H2 and lower headings", () => {
    const result = findFirstH1("## Subtitle\n\n# Main Title\n\nContent");
    expect(result).toBe("Main Title");
  });

  it("returns undefined when no H1 found", () => {
    const result = findFirstH1("## Subtitle\n\n### More\n\nContent");
    expect(result).toBeUndefined();
  });

  it("handles H1 with extra spaces", () => {
    const result = findFirstH1("#   Title with   Spaces  \n\nContent");
    expect(result).toBe("Title with   Spaces");
  });

  it("handles H1 in the middle of document", () => {
    const result = findFirstH1("Some text\n\n# Middle Title\n\nMore text");
    expect(result).toBe("Middle Title");
  });

  it("ignores H1-like text that is not a heading", () => {
    const result = findFirstH1("This is not a # heading\n\n# Real Heading");
    expect(result).toBe("Real Heading");
  });

  it("returns undefined on empty string", () => {
    const result = findFirstH1("");
    expect(result).toBeUndefined();
  });

  it("handles multiline content after H1", () => {
    const result = findFirstH1(
      "# Title\n\n# Another Title\n\nContent\n\n# Third Title",
    );
    expect(result).toBe("Title");
  });
});
