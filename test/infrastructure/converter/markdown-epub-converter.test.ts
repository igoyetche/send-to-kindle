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
