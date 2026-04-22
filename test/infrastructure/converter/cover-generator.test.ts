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

  it("appends ellipsis when content doesn't fit in maxLines", () => {
    // This title needs more than 3 lines with 30-char limit
    const tooLong =
      "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen";
    const lines = wrapTitle(tooLong);
    expect(lines.length).toBeLessThanOrEqual(3);
    const lastLine = lines.at(-1) ?? "";
    expect(lastLine.endsWith("…")).toBe(true);
  });

  it("does NOT append ellipsis when all words fit in maxLines", () => {
    // This title fits exactly in 3 lines without overflow
    const fitsExactly = "Short line Short line Short";
    const lines = wrapTitle(fitsExactly);
    expect(lines.length).toBeLessThanOrEqual(3);
    const lastLine = lines.at(-1) ?? "";
    expect(lastLine.endsWith("…")).toBe(false);
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

  it("does not contain any inline styles or embedded images", () => {
    const html = generator.generateHtmlChapter("Title", "Claude");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:");
  });
});

describe("CoverGenerator.generateCoverCss", () => {
  const generator = new CoverGenerator();

  it("returns a non-empty CSS string", () => {
    const css = generator.generateCoverCss();
    expect(typeof css).toBe("string");
    expect(css.length).toBeGreaterThan(0);
  });

  it("contains cover chapter class selectors", () => {
    const css = generator.generateCoverCss();
    expect(css).toContain(".cover");
    expect(css).toContain(".kicker");
    expect(css).toContain(".title");
    expect(css).toContain(".author");
    expect(css).toContain(".rule");
  });

  it("does not contain any base64 data URIs", () => {
    const css = generator.generateCoverCss();
    expect(css).not.toContain("data:image");
    expect(css).not.toContain("base64");
  });
});

describe("CoverGenerator.generateImage", () => {
  const generator = new CoverGenerator();

  it("returns a Buffer with JPEG magic bytes (FF D8 FF)", async () => {
    const buffer = await generator.generateImage("My Title", "Claude");
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
    expect(buffer[2]).toBe(0xff);
  });

  it("returns a non-empty buffer for a short title", async () => {
    const buffer = await generator.generateImage("Hi", "Author");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("returns valid JPEG when title longer than 30 characters", async () => {
    const buffer = await generator.generateImage(
      "This is a very long title that exceeds thirty characters and needs wrapping",
      "Author",
    );
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });

  it("returns valid JPEG when title needing more than 3 lines", async () => {
    const buffer = await generator.generateImage(
      "Chapter One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve",
      "Some Author Name",
    );
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });

  it("returns valid JPEG when title and author have XML special characters", async () => {
    const buffer = await generator.generateImage(
      "Title & <Subtitle>",
      'Author "Quoted"',
    );
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });
});
