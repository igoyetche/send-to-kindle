import { describe, it, expect } from "vitest";
import { CoverGenerator, wrapTitle } from "../../../src/infrastructure/converter/cover-generator.js";

describe("wrapTitle", () => {
  it("returns a single line for a short title", () => {
    expect(wrapTitle("Short Title")).toEqual(["Short Title"]);
  });

  it("returns the title unchanged when it fits within 30 chars", () => {
    expect(wrapTitle("Exactly thirty characters here")).toEqual([
      "Exactly thirty characters here",
    ]);
  });

  it("wraps at word boundary when line would exceed 30 chars", () => {
    const lines = wrapTitle("The quick brown fox jumps over the lazy dog");
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((line) => expect(line.length).toBeLessThanOrEqual(30));
  });

  it("appends ellipsis when all available lines are consumed by wrapping", () => {
    const veryLong =
      "This is an extremely long title that would need four or more lines to display";
    const lines = wrapTitle(veryLong);
    expect(lines.length).toBeLessThanOrEqual(3);
    const lastLine = lines[lines.length - 1] ?? "";
    expect(lastLine.endsWith("…")).toBe(true);
  });

  it("returns a single line even if it exceeds 30 chars (single long word)", () => {
    const singleLongWord = "Supercalifragilisticexpialidocious";
    const lines = wrapTitle(singleLongWord);
    expect(lines).toEqual([singleLongWord]);
  });
});

describe("CoverGenerator.generateHtmlChapter", () => {
  const generator = new CoverGenerator();

  it("includes the title in the HTML output", () => {
    const html = generator.generateHtmlChapter("My Title", "Claude");
    expect(html).toContain("My Title");
  });

  it("includes the author in the HTML output", () => {
    const html = generator.generateHtmlChapter("Title", "Arthur Author");
    expect(html).toContain("Arthur Author");
  });

  it("includes source domain when a valid URL is provided", () => {
    const html = generator.generateHtmlChapter(
      "Title",
      "Claude",
      "https://theverge.com/article/123",
    );
    expect(html).toContain("theverge.com");
  });

  it("omits source section when sourceUrl is undefined", () => {
    const html = generator.generateHtmlChapter("Title", "Claude");
    expect(html).not.toContain('class="source"');
  });

  it("omits source section when sourceUrl is malformed", () => {
    const html = generator.generateHtmlChapter("Title", "Claude", "not-a-url");
    expect(html).not.toContain('class="source"');
    expect(html).not.toContain("not-a-url");
  });

  it("escapes HTML special characters in title", () => {
    const html = generator.generateHtmlChapter(
      "Title & Subtitle <test>",
      "Claude",
    );
    expect(html).toContain("Title &amp; Subtitle &lt;test&gt;");
    expect(html).not.toContain("<test>");
  });

  it("escapes HTML special characters in author", () => {
    const html = generator.generateHtmlChapter("Title", 'Author "Quoted"');
    expect(html).toContain("Author &quot;Quoted&quot;");
  });

  it("includes an img tag for the icon", () => {
    const html = generator.generateHtmlChapter("Title", "Claude");
    expect(html).toContain("<img");
    expect(html).toContain("data:image/png;base64,");
  });
});
