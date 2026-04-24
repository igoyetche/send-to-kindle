# PB-008: EPUB Cover Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically generate a cover for every EPUB — a JPEG thumbnail visible in the Kindle library and a styled HTML first-page chapter inside the document.

**Architecture:** A new `CoverGenerator` class in the infrastructure layer is injected into `MarkdownEpubConverter`. It produces a JPEG buffer (via SVG → sharp) for the Kindle library thumbnail and an HTML string for the cover chapter. All three composition roots (`index.ts`, `cli-entry.ts`, `watch-entry.ts`) are updated to wire in the new class.

**Tech Stack:** `sharp` (already installed, v0.34.5), `node:buffer.File` (Node 22 built-in), `epub-gen-memory` native `cover` option, Node.js `import.meta.url` for asset path resolution.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/infrastructure/converter/assets/cover-icon.png` | Placeholder PNG icon (replaced later with real icon) |
| Create | `src/infrastructure/converter/cover-generator.ts` | `CoverGenerator` class: JPEG thumbnail + HTML chapter |
| Create | `test/infrastructure/converter/cover-generator.test.ts` | Unit tests for `CoverGenerator` and `wrapTitle` |
| Modify | `src/infrastructure/converter/markdown-epub-converter.ts` | Accept `CoverGenerator`, call in `toEpub()` |
| Modify | `test/infrastructure/converter/markdown-epub-converter.test.ts` | Inject fake `CoverGenerator`, add cover assertions |
| Modify | `src/index.ts` | Wire `CoverGenerator` into `MarkdownEpubConverter` |
| Modify | `src/cli-entry.ts` | Wire `CoverGenerator` into `MarkdownEpubConverter` |
| Modify | `src/watch-entry.ts` | Wire `CoverGenerator` into `MarkdownEpubConverter` |
| Modify | `docs/specs/main-spec.md` | Update FR-5, add FR-36 (cover image), FR-37 (cover chapter) |
| Modify | `docs/STATUS.md` | Move PB-008 from Backlog to Active Work |
| Modify | `docs/CHANGELOG.md` | Log spec changes |

---

## Task 1: Create placeholder icon PNG

**Files:**
- Create: `src/infrastructure/converter/assets/cover-icon.png`

- [x] **Step 1.1: Create the assets directory and generate the placeholder PNG** (2026-04-15)

Run this script from within the worktree directory (`C:/projects/experiments/paperboy/.worktrees/pb-008-epub-cover`):

```bash
node --input-type=module <<'SCRIPT'
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "src/infrastructure/converter/assets");
mkdirSync(dir, { recursive: true });

// Simple paperboy placeholder: dark background, circle head, body, legs
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#1e1e2e" rx="16"/>
  <circle cx="100" cy="65" r="28" fill="#cdd6f4"/>
  <rect x="64" y="98" width="72" height="58" rx="8" fill="#89b4fa"/>
  <rect x="28" y="112" width="36" height="12" rx="6" fill="#89b4fa"/>
  <rect x="136" y="112" width="36" height="12" rx="6" fill="#89b4fa"/>
  <rect x="72" y="156" width="22" height="34" rx="6" fill="#cdd6f4"/>
  <rect x="106" y="156" width="22" height="34" rx="6" fill="#cdd6f4"/>
</svg>`;

const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(dir, "cover-icon.png"), buffer);
console.log("Created:", join(dir, "cover-icon.png"), `(${buffer.length} bytes)`);
SCRIPT
```

Expected output: `Created: .../src/infrastructure/converter/assets/cover-icon.png (NNN bytes)`

- [x] **Step 1.2: Verify the file was created** (2026-04-15)

```bash
ls -la /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover/src/infrastructure/converter/assets/
```

Expected: `cover-icon.png` exists with size > 0.

- [x] **Step 1.3: Commit** (2026-04-15)

```bash
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover add src/infrastructure/converter/assets/cover-icon.png
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover commit -m "feat: PB-008 add placeholder cover icon PNG asset"
```

---

## Task 2: Create `CoverGenerator` — HTML chapter + wrapTitle

**Files:**
- Create: `src/infrastructure/converter/cover-generator.ts`
- Create: `test/infrastructure/converter/cover-generator.test.ts`

Write the failing tests first, then implement.

- [x] **Step 2.1: Write the failing tests for `wrapTitle` and `generateHtmlChapter`** (2026-04-15)

Create `test/infrastructure/converter/cover-generator.test.ts`:

```typescript
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

  it("truncates with ellipsis when title needs more than 3 lines", () => {
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
```

- [x] **Step 2.2: Run the tests to confirm they fail** (2026-04-15)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test -- --reporter=verbose test/infrastructure/converter/cover-generator.test.ts 2>&1 | tail -20
```

Expected: Tests fail with `Cannot find module` or import errors.

- [x] **Step 2.3: Create `src/infrastructure/converter/cover-generator.ts` with wrapTitle and generateHtmlChapter** (2026-04-15)

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Escapes XML/HTML special characters.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Extracts the hostname from a URL. Returns undefined on invalid URLs.
 */
function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Word-wraps a title into lines of at most `maxLineChars` characters.
 * At most `maxLines` lines are returned. If the title is longer, the last
 * line is truncated with an ellipsis (…).
 *
 * Note: a single word longer than maxLineChars is returned as-is on its own line.
 */
export function wrapTitle(
  title: string,
  maxLineChars = 30,
  maxLines = 3,
): string[] {
  const words = title.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxLineChars) {
      current += " " + word;
    } else {
      if (lines.length >= maxLines - 1) {
        // On the last allowed line — mark truncation and stop
        const withEllipsis = current + "…";
        current =
          withEllipsis.length <= maxLineChars
            ? withEllipsis
            : current.slice(0, maxLineChars - 1) + "…";
        break;
      }
      lines.push(current);
      current = word;
    }
  }

  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// CoverGenerator
// ---------------------------------------------------------------------------

export class CoverGenerator {
  private readonly iconBase64: string;

  constructor() {
    const dir = dirname(fileURLToPath(import.meta.url));
    const iconPath = join(dir, "assets", "cover-icon.png");
    this.iconBase64 = readFileSync(iconPath).toString("base64");
  }

  /**
   * Generates a styled HTML cover chapter with title, author, and optional source domain.
   * The chapter is inlined with CSS (Kindle does not reliably load external stylesheets).
   */
  generateHtmlChapter(
    title: string,
    author: string,
    sourceUrl?: string,
  ): string {
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    const domain =
      sourceUrl !== undefined ? extractDomain(sourceUrl) : undefined;
    const sourceHtml =
      domain !== undefined
        ? `<p class="source">${escapeXml(domain)}</p>`
        : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(title)}</title>
<style type="text/css">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1e2e; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
  .cover { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 60px 40px; max-width: 500px; }
  .icon { width: 120px; height: 120px; margin-bottom: 36px; }
  .title { color: #cdd6f4; font-size: 1.8em; font-weight: bold; line-height: 1.3; margin-bottom: 16px; }
  .author { color: #a6adc8; font-size: 1em; }
  .source { color: #6c7086; font-size: 0.8em; margin-top: 40px; }
</style>
</head>
<body>
<div class="cover">
  <img class="icon" src="${iconDataUri}" alt="Paperboy"/>
  <h1 class="title">${escapeXml(title)}</h1>
  <p class="author">${escapeXml(author)}</p>
  ${sourceHtml}
</div>
</body>
</html>`;
  }

  /**
   * Generates a 600×900 JPEG cover image for the Kindle library thumbnail.
   * SVG is rasterised to JPEG via sharp.
   */
  async generateImage(title: string, author: string): Promise<Buffer> {
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    const titleLines = wrapTitle(title);
    const titleStartY = 290;
    const lineSpacing = 46;

    const titleElements = titleLines
      .map(
        (line, i) =>
          `<text x="300" y="${titleStartY + i * lineSpacing}" font-family="sans-serif" font-size="32" font-weight="bold" fill="#cdd6f4" text-anchor="middle">${escapeXml(line)}</text>`,
      )
      .join("\n  ");

    const authorY = titleStartY + titleLines.length * lineSpacing + 28;

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="900" viewBox="0 0 600 900">
  <rect width="600" height="900" fill="#1e1e2e"/>
  <rect x="0" y="0" width="600" height="4" fill="#89b4fa"/>
  <image x="220" y="80" width="160" height="160" xlink:href="${iconDataUri}"/>
  ${titleElements}
  <text x="300" y="${authorY}" font-family="sans-serif" font-size="22" fill="#a6adc8" text-anchor="middle">${escapeXml(author)}</text>
</svg>`;

    return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }
}
```

- [x] **Step 2.4: Run the HTML chapter tests to confirm they pass** (2026-04-15)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test -- --reporter=verbose test/infrastructure/converter/cover-generator.test.ts 2>&1 | tail -30
```

Expected: All `wrapTitle` and `generateHtmlChapter` tests pass. The `generateImage` tests do not exist yet.

- [x] **Step 2.5: Commit** (2026-04-15)

```bash
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover add src/infrastructure/converter/cover-generator.ts test/infrastructure/converter/cover-generator.test.ts
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover commit -m "feat: PB-008 add CoverGenerator with HTML chapter and wrapTitle"
```

---

## Task 3: `CoverGenerator` — JPEG image generation

**Files:**
- Modify: `test/infrastructure/converter/cover-generator.test.ts` (add image tests)
- Modify: `src/infrastructure/converter/cover-generator.ts` (already has `generateImage`, tests just weren't added yet)

- [x] **Step 3.1: Add failing image tests to `test/infrastructure/converter/cover-generator.test.ts`** (2026-04-16)

Append a new describe block after the `generateHtmlChapter` describe block:

```typescript
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

  it("handles a title longer than 30 characters without throwing", async () => {
    const buffer = await generator.generateImage(
      "This is a very long title that exceeds thirty characters and needs wrapping",
      "Author",
    );
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });

  it("handles a title needing more than 3 lines without throwing", async () => {
    const buffer = await generator.generateImage(
      "Chapter One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve",
      "Some Author Name",
    );
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });

  it("escapes XML special characters in title and author without throwing", async () => {
    const buffer = await generator.generateImage(
      "Title & <Subtitle>",
      'Author "Quoted"',
    );
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  });
});
```

- [x] **Step 3.2: Run the image tests to confirm they pass** (2026-04-16)

(The `generateImage` method was already implemented in Task 2. This step verifies it works.)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test -- --reporter=verbose test/infrastructure/converter/cover-generator.test.ts 2>&1 | tail -30
```

Expected: All tests pass including the new `generateImage` tests.

- [x] **Step 3.3: Run the full test suite to check no regressions** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test 2>&1 | tail -10
```

Expected: All 293 previously passing tests still pass, plus the new cover-generator tests.

- [x] **Step 3.4: Commit** (2026-04-16)

```bash
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover add test/infrastructure/converter/cover-generator.test.ts
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover commit -m "test: PB-008 add generateImage tests for CoverGenerator"
```

---

## Task 4: Update `MarkdownEpubConverter` to use `CoverGenerator`

**Files:**
- Modify: `test/infrastructure/converter/markdown-epub-converter.test.ts`
- Modify: `src/infrastructure/converter/markdown-epub-converter.ts`

Update the tests first (they will fail because the constructor still only accepts `ImageProcessor`), then update the implementation.

- [x] **Step 4.1: Update `test/infrastructure/converter/markdown-epub-converter.test.ts`** (2026-04-16)

Replace the full file with the updated version below. Key changes:
1. Import `CoverGenerator`
2. Add `fakeCoverGenerator` stub
3. Pass `fakeCoverGenerator` to all `new MarkdownEpubConverter(...)` calls
4. Add two new tests: cover generation is invoked, and cover chapter is in the EPUB

```typescript
import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import { MarkdownEpubConverter } from "../../../src/infrastructure/converter/markdown-epub-converter.js";
import type { ImageProcessor } from "../../../src/infrastructure/converter/image-processor.js";
import type { CoverGenerator } from "../../../src/infrastructure/converter/cover-generator.js";
import { Title } from "../../../src/domain/values/title.js";
import { Author } from "../../../src/domain/values/author.js";
import { MarkdownContent } from "../../../src/domain/values/markdown-content.js";
import { MarkdownDocument } from "../../../src/domain/values/markdown-document.js";
import { DocumentMetadata } from "../../../src/domain/values/document-metadata.js";

function makeTitle(v: string) {
  const r = Title.create(v);
  if (!r.ok) throw new Error("bad setup");
  return r.value;
}

function makeAuthor(v: string) {
  const r = Author.create(v);
  if (!r.ok) throw new Error("bad setup");
  return r.value;
}

function makeContent(v: string) {
  const r = MarkdownContent.create(v);
  if (!r.ok) throw new Error("bad setup");
  return r.value;
}

function makeDocument(v: string, url?: string) {
  const content = makeContent(v);
  const metadata =
    url !== undefined
      ? DocumentMetadata.fromRecord({ url })
      : DocumentMetadata.empty();
  return MarkdownDocument.fromParts(content, metadata);
}

// Minimal valid JPEG header (3 bytes) — enough to pass File wrapping
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff]);

describe("MarkdownEpubConverter", () => {
  // Mock ImageProcessor that passes HTML through unchanged
  const mockImageProcessor: ImageProcessor = {
    // eslint-disable-next-line @typescript-eslint/require-await
    process: vi.fn(async (html: string) => ({
      html,
      images: [],
      stats: { total: 0, downloaded: 0, failed: 0, skipped: 0 },
    })),
  };

  // Fake CoverGenerator — avoids running sharp in unit tests
  const fakeCoverGenerator: CoverGenerator = {
    // eslint-disable-next-line @typescript-eslint/require-await
    generateImage: vi.fn(async () => FAKE_JPEG),
    generateHtmlChapter: vi.fn(() => "<div>cover</div>"),
  };

  const converter = new MarkdownEpubConverter(
    mockImageProcessor,
    fakeCoverGenerator,
  );

  it("produces an EpubDocument with correct title", async () => {
    const result = await converter.toEpub(
      makeTitle("Test Book"),
      makeDocument("# Chapter 1\n\nHello world."),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Test Book");
      expect(result.value.sizeBytes).toBeGreaterThan(0);
      expect(result.value.buffer).toBeInstanceOf(Buffer);
    }
  });

  it("does not return a conversion error on valid input", async () => {
    const result = await converter.toEpub(
      makeTitle("Valid Book"),
      makeDocument("# Hello\n\nSome content."),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(
        `Expected conversion to succeed but got error: ${result.error.message}`,
      );
    }
  });

  it("produces a non-empty EPUB buffer with valid zip magic bytes", async () => {
    const result = await converter.toEpub(
      makeTitle("Magic Bytes Test"),
      makeDocument("# Hello"),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer[0]).toBe(0x50); // P
      expect(result.value.buffer[1]).toBe(0x4b); // K
      expect(result.value.buffer[2]).toBe(0x03);
      expect(result.value.buffer[3]).toBe(0x04);
    }
  });

  it("generates a URL-safe filename from title", async () => {
    const result = await converter.toEpub(
      makeTitle("Clean Architecture: A Guide"),
      makeDocument("# Hello"),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Clean Architecture: A Guide");
    }
  });

  it("sanitizes script tags from markdown", async () => {
    const result = await converter.toEpub(
      makeTitle("XSS Test"),
      makeDocument('Hello <script>alert("xss")</script> World'),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
  });

  it("preserves markdown structure (headings, lists, emphasis)", async () => {
    const md = [
      "# Heading 1",
      "## Heading 2",
      "- item 1",
      "- item 2",
      "",
      "**bold** and *italic*",
      "",
      "```\ncode block\n```",
    ].join("\n");

    const result = await converter.toEpub(
      makeTitle("Structure Test"),
      makeDocument(md),
      makeAuthor("Claude"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("calls generateImage with title and author", async () => {
    vi.clearAllMocks();
    await converter.toEpub(
      makeTitle("Cover Test"),
      makeDocument("# Hello"),
      makeAuthor("Tester"),
    );
    expect(fakeCoverGenerator.generateImage).toHaveBeenCalledWith(
      "Cover Test",
      "Tester",
    );
  });

  it("calls generateHtmlChapter with title, author, and sourceUrl from metadata", async () => {
    vi.clearAllMocks();
    await converter.toEpub(
      makeTitle("Source Test"),
      makeDocument("# Hello", "https://theverge.com/article/123"),
      makeAuthor("Claude"),
    );
    expect(fakeCoverGenerator.generateHtmlChapter).toHaveBeenCalledWith(
      "Source Test",
      "Claude",
      "https://theverge.com/article/123",
    );
  });

  it("embeds images with UUID-based filenames and removes original URLs", async () => {
    const testImageBuffer1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const testImageBuffer2 = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const mockImageProcessorWithImages: ImageProcessor = {
      // eslint-disable-next-line @typescript-eslint/require-await
      process: vi.fn(async (html: string) => ({
        html,
        images: [
          { filename: "image-001.jpeg", buffer: testImageBuffer1, format: "jpeg" },
          { filename: "image-002.png", buffer: testImageBuffer2, format: "png" },
        ],
        stats: { total: 2, downloaded: 2, failed: 0, skipped: 0 },
      })),
    };

    const converterWithImages = new MarkdownEpubConverter(
      mockImageProcessorWithImages,
      fakeCoverGenerator,
    );

    const result = await converterWithImages.toEpub(
      makeTitle("Images Test"),
      makeDocument(
        '# Test\n\n<img src="https://example.com/image1.jpg" alt="img1">\n<img src="https://example.com/image2.png" alt="img2">',
      ),
      makeAuthor("Claude"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Conversion failed: ${result.error.message}`);
    }

    const epubBuffer = result.value.buffer;
    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(epubBuffer);

    const imageFiles = Object.keys(loadedZip.files).filter(
      (path) => path.startsWith("OEBPS/images/") && !path.endsWith("/"),
    );
    expect(imageFiles.length).toBe(2);

    imageFiles.forEach((path) => {
      const filename = path.split("/").pop();
      expect(filename).toMatch(/^[a-f0-9\-]{36}\.(jpeg|png)$/);
    });

    // Find the content chapter (not the cover chapter — cover has no img UUID tags)
    const allChapterPaths = Object.keys(loadedZip.files).filter((path) =>
      path.match(/OEBPS\/\d+_.*\.xhtml$/),
    );
    expect(allChapterPaths.length).toBeGreaterThanOrEqual(1);

    // Read all chapters and find the one containing img src with UUID pattern
    let contentChapterHtml = "";
    for (const chapterPath of allChapterPaths) {
      const file = loadedZip.file(chapterPath);
      if (file) {
        const html = await file.async("string");
        if (/images\/[a-f0-9\-]{36}/.test(html)) {
          contentChapterHtml = html;
          break;
        }
      }
    }

    expect(contentChapterHtml).not.toBe("");

    const imgRegex = /<img[^>]+src="([^"]+)"/g;
    const imgSrcs: string[] = [];
    let match;
    while ((match = imgRegex.exec(contentChapterHtml)) !== null) {
      imgSrcs.push(match[1] ?? "");
    }

    expect(imgSrcs.length).toBe(2);
    imgSrcs.forEach((src) => {
      expect(src).toMatch(/^images\/[a-f0-9\-]{36}\.(jpeg|png)$/);
      expect(imageFiles).toContain(`OEBPS/${src}`);
    });

    expect(contentChapterHtml).not.toContain("data:image/");
  });

  it("preserves original image URLs in HTML during processing (not replaced with data URIs)", async () => {
    const testImageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    const mockImageProcessorWithImages: ImageProcessor = {
      // eslint-disable-next-line @typescript-eslint/require-await
      process: vi.fn(async (html: string) => {
        expect(html).toContain("https://example.com/test.jpg");
        return {
          html,
          images: [{ filename: "image-001.jpeg", buffer: testImageBuffer, format: "jpeg" }],
          stats: { total: 1, downloaded: 1, failed: 0, skipped: 0 },
        };
      }),
    };

    const converterWithImages = new MarkdownEpubConverter(
      mockImageProcessorWithImages,
      fakeCoverGenerator,
    );

    const result = await converterWithImages.toEpub(
      makeTitle("URL Preservation Test"),
      makeDocument('# Test\n\n<img src="https://example.com/test.jpg" alt="test">'),
      makeAuthor("Claude"),
    );

    expect(result.ok).toBe(true);
    expect(mockImageProcessorWithImages.process).toHaveBeenCalled();
  });
});
```

- [x] **Step 4.2: Run the updated converter tests to confirm they fail** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test -- --reporter=verbose test/infrastructure/converter/markdown-epub-converter.test.ts 2>&1 | tail -20
```

Expected: Tests fail because `MarkdownEpubConverter` constructor doesn't accept a second argument yet.

- [x] **Step 4.3: Update `src/infrastructure/converter/markdown-epub-converter.ts`** (2026-04-16)

Replace the full file:

```typescript
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { File } from "node:buffer";
import type { ContentConverter } from "../../domain/ports.js";
import type { Title, Author, MarkdownDocument } from "../../domain/values/index.js";
import { EpubDocument } from "../../domain/values/index.js";
import { ConversionError, type Result, ok, err } from "../../domain/errors.js";
import type { ImageProcessor } from "./image-processor.js";
import type { CoverGenerator } from "./cover-generator.js";
import { createEpubWithPredownloadedImages } from "./epub-with-images.js";

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "blockquote", "pre", "code",
  "b", "i", "em", "strong", "u", "s", "sup", "sub",
  "ul", "ol", "li",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "div", "span",
];

export class MarkdownEpubConverter implements ContentConverter {
  constructor(
    private readonly imageProcessor: ImageProcessor,
    private readonly coverGenerator: CoverGenerator,
  ) {}

  async toEpub(
    title: Title,
    document: MarkdownDocument,
    author: Author,
  ): Promise<Result<EpubDocument, ConversionError>> {
    try {
      const rawHtml = await marked.parse(document.content.value);

      const safeHtml = sanitizeHtml(rawHtml, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: {
          a: ["href", "title"],
          img: ["src", "alt", "title"],
          td: ["colspan", "rowspan"],
          th: ["colspan", "rowspan"],
        },
        allowedSchemes: ["http", "https", "mailto"],
      });

      // Process images
      const { html: processedHtml, images: processedImages, stats } =
        await this.imageProcessor.process(safeHtml);

      // Generate cover assets
      const jpegBuffer = await this.coverGenerator.generateImage(
        title.value,
        author.value,
      );
      const htmlChapter = this.coverGenerator.generateHtmlChapter(
        title.value,
        author.value,
        document.metadata.url,
      );
      const coverFile = new File([jpegBuffer], "cover.jpg", {
        type: "image/jpeg",
      });

      // Build image buffer map for pre-downloaded images
      const imageBufferMap = new Map<string, { buffer: Buffer; format: string }>();
      for (const img of processedImages) {
        imageBufferMap.set(img.filename, {
          buffer: img.buffer,
          format: img.format,
        });
      }

      const epubInstance = createEpubWithPredownloadedImages(
        { title: title.value, author: author.value, cover: coverFile },
        [
          {
            title: "",
            content: htmlChapter,
            excludeFromToc: true,
            beforeToc: true,
          },
          { title: title.value, content: processedHtml },
        ],
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (epubInstance as any).__imageBufferMap = imageBufferMap; // eslint-disable-line @typescript-eslint/no-explicit-any

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      const buffer = await (epubInstance as any).genEpub(); // eslint-disable-line @typescript-eslint/no-explicit-any

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return ok(new EpubDocument(title.value, buffer, stats, author.value, document.metadata.date));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown conversion error";
      return err(new ConversionError(message));
    }
  }
}
```

- [x] **Step 4.4: Run the converter tests to confirm they pass** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test -- --reporter=verbose test/infrastructure/converter/markdown-epub-converter.test.ts 2>&1 | tail -20
```

Expected: All tests pass.

- [x] **Step 4.5: Run the full test suite to check for regressions** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test 2>&1 | tail -10
```

Expected: All previously passing tests still pass. TypeScript may fail to build — that is expected and will be fixed in Task 5.

- [x] **Step 4.6: Commit** (2026-04-16)

```bash
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover add src/infrastructure/converter/markdown-epub-converter.ts test/infrastructure/converter/markdown-epub-converter.test.ts
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover commit -m "feat: PB-008 update MarkdownEpubConverter to inject and use CoverGenerator"
```

---

## Task 5: Wire `CoverGenerator` into all composition roots

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli-entry.ts`
- Modify: `src/watch-entry.ts`

All three files currently construct `MarkdownEpubConverter` with only `imageProcessor`. This task adds `coverGenerator` to each.

- [x] **Step 5.1: Update `src/index.ts`** (2026-04-16)

Add the import and wiring. The change is two lines — one import, one instantiation, one constructor update.

In `src/index.ts`, add the import after the existing `ImageProcessor` import:

```typescript
import { CoverGenerator } from "./infrastructure/converter/cover-generator.js";
```

Change line 19–20 from:
```typescript
const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const converter = new MarkdownEpubConverter(imageProcessor);
```

To:
```typescript
const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const coverGenerator = new CoverGenerator();
const converter = new MarkdownEpubConverter(imageProcessor, coverGenerator);
```

- [x] **Step 5.2: Update `src/cli-entry.ts`** (2026-04-16)

Add the import after the existing `ImageProcessor` import:

```typescript
import { CoverGenerator } from "./infrastructure/converter/cover-generator.js";
```

Change lines 95–96 from:
```typescript
const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const converter = new MarkdownEpubConverter(imageProcessor);
```

To:
```typescript
const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const coverGenerator = new CoverGenerator();
const converter = new MarkdownEpubConverter(imageProcessor, coverGenerator);
```

- [x] **Step 5.3: Update `src/watch-entry.ts`** (2026-04-16)

Add the import after the existing `ImageProcessor` import:

```typescript
import { CoverGenerator } from "./infrastructure/converter/cover-generator.js";
```

Change lines 104–105 from:
```typescript
const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const converter = new MarkdownEpubConverter(imageProcessor);
```

To:
```typescript
const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const coverGenerator = new CoverGenerator();
const converter = new MarkdownEpubConverter(imageProcessor, coverGenerator);
```

- [x] **Step 5.4: Build to verify TypeScript compiles cleanly** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm run build 2>&1 | tail -10
```

Expected: `tsc` exits with no errors and no output.

- [x] **Step 5.5: Run the full test suite** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test 2>&1 | tail -10
```

Expected: All tests pass (293 original + new cover-generator tests).

- [x] **Step 5.6: Commit** (2026-04-16)

```bash
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover add src/index.ts src/cli-entry.ts src/watch-entry.ts
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover commit -m "feat: PB-008 wire CoverGenerator into all composition roots"
```

---

## Task 6: Update spec, STATUS.md, and CHANGELOG.md

**Files:**
- Modify: `docs/specs/main-spec.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/CHANGELOG.md`

- [x] **Step 6.1: Update `docs/specs/main-spec.md`** (2026-04-16)

In the **Content Conversion** section, replace the current FR-5:

```
- **FR-5**: The EPUB output must be a valid EPUB 3.0 package containing title and author metadata and a single content chapter
```

With:

```
- **FR-5**: The EPUB output must be a valid EPUB 3.0 package containing title and author metadata, a cover image, a cover chapter, and a content chapter
- **FR-36**: Every EPUB produced by the system must include a cover image (JPEG, 600×900 px) embedded in the EPUB manifest for display as a library thumbnail in Kindle. The cover is generated automatically from the document title and author — no user-supplied image or configuration is required.
- **FR-37**: Every EPUB produced by the system must include a styled cover chapter as the first page of the document. The cover chapter displays: the paperboy icon, the document title, the author, and — when a `url` field is present in frontmatter — the source domain (hostname only, e.g., `theverge.com`). The source domain is not displayed on the cover image thumbnail.
```

Add `> Updated 2026-04-15 via feature: PB-008` above the Content Conversion heading.

- [x] **Step 6.2: Update `docs/STATUS.md`** (2026-04-16)

Move PB-008 from the **Backlog** table to the **Active Work** table:

Remove from Backlog:
```
| PB-008 | EPUB Cover Generation | Feature | specs/main-spec.md | — | Medium |
```

Add to Active Work:
```
| PB-008 | EPUB Cover Generation | 🔄 In Progress | specs/main-spec.md | plans/backlog/PB-008-epub-cover.md | Medium |
```

Update `Last updated` date to `2026-04-15`.

- [x] **Step 6.3: Update `docs/CHANGELOG.md`** (2026-04-16)

Prepend a new entry:

```markdown
## 2026-04-15 — PB-008: EPUB Cover Generation — Spec update

**Changed:** FR-5 updated — EPUB output now includes cover image + cover chapter (previously "single content chapter").

**Added:** FR-36 — Cover JPEG image (600×900 px) embedded in EPUB manifest for Kindle library thumbnail. Generated automatically from title and author via SVG → sharp → JPEG.

**Added:** FR-37 — Cover HTML chapter as first page of document. Displays paperboy icon, title, author, and source domain (from frontmatter `url`, hostname only). Source domain appears only in the chapter, not on the thumbnail.
```

- [x] **Step 6.4: Run tests to confirm nothing is broken** (2026-04-16)

```bash
cd /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover && npm test 2>&1 | tail -10
```

Expected: All tests pass.

- [x] **Step 6.5: Commit** (2026-04-16)

```bash
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover add docs/specs/main-spec.md docs/STATUS.md docs/CHANGELOG.md
git -C /c/projects/experiments/paperboy/.worktrees/pb-008-epub-cover commit -m "docs: PB-008 update spec (FR-5, FR-36, FR-37), STATUS.md, CHANGELOG.md"
```

---

## Completion Checklist

After all tasks are done, verify before marking complete:

- [ ] `npm test` passes with 0 failures
- [ ] `npm run build` exits with no TypeScript errors
- [ ] EPUB cover image (JPEG) is embedded in the generated EPUB (visible in Kindle library)
- [ ] Cover HTML chapter appears as the first page in the EPUB
- [ ] Source domain appears in the HTML chapter when frontmatter `url` is present
- [ ] Source domain does NOT appear on the cover image thumbnail
- [ ] All three composition roots wire `CoverGenerator`
- [ ] `docs/specs/main-spec.md` updated with FR-36 and FR-37
- [ ] `docs/STATUS.md` shows PB-008 as In Progress
- [ ] `docs/CHANGELOG.md` has a new entry for PB-008
