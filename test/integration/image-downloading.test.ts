import { describe, it, expect, vi } from "vitest";
import { MarkdownEpubConverter } from "../../src/infrastructure/converter/markdown-epub-converter.js";
import { ImageProcessor } from "../../src/infrastructure/converter/image-processor.js";
import type { CoverGenerator } from "../../src/infrastructure/converter/cover-generator.js";
import { createPinoLogger, createImageProcessorLogger } from "../../src/infrastructure/logger.js";
import { Title } from "../../src/domain/values/title.js";
import { Author } from "../../src/domain/values/author.js";
import { MarkdownContent } from "../../src/domain/values/markdown-content.js";
import { MarkdownDocument } from "../../src/domain/values/markdown-document.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";

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

function makeDocument(v: string) {
  const content = makeContent(v);
  const metadata = DocumentMetadata.empty();
  return MarkdownDocument.fromParts(content, metadata);
}

// Fake CoverGenerator — avoids running sharp in integration tests
const fakeCoverGenerator: CoverGenerator = {
  // eslint-disable-next-line @typescript-eslint/require-await
  generateImage: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff])),
  generateHtmlChapter: vi.fn(() => "<div>cover</div>"),
  generateCoverCss: vi.fn(() => ".cover { color: red; }"),
};

describe.skip("Image downloading integration", () => {
  // These tests require network access and real image downloads.
  // Skip by default; run with `npm test -- --reporter=verbose` to include them.
  // They serve as validation that the full pipeline works with real content.

  it("converts markdown with remote images to EPUB", async () => {
    const config = {
      fetchTimeoutMs: 30000,
      retries: 2,
      maxConcurrency: 3,
      maxImageBytes: 5 * 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
    };

    const logger = createPinoLogger("silent");
    const imageProcessorLogger = createImageProcessorLogger(logger);
    const imageProcessor = new ImageProcessor(config, imageProcessorLogger);
    const converter = new MarkdownEpubConverter(imageProcessor, fakeCoverGenerator);

    // Simple markdown with a real, small image
    const markdown = `
# Test Document with Image

This document includes a remote image.

![Test Image](https://via.placeholder.com/200)

The image should be embedded in the EPUB.
`;

    const result = await converter.toEpub(
      makeTitle("Image Test"),
      makeContent(markdown),
      makeAuthor("Test"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sizeBytes).toBeGreaterThan(1000);
      expect(result.value.imageStats).toBeDefined();
      if (result.value.imageStats) {
        expect(result.value.imageStats.total).toBe(1);
        // May succeed or fail depending on network, but should attempt
        expect(result.value.imageStats.downloaded + result.value.imageStats.failed).toBe(1);
      }
    }
  });

  it("handles multiple images in content", async () => {
    const config = {
      fetchTimeoutMs: 30000,
      retries: 1,
      maxConcurrency: 3,
      maxImageBytes: 5 * 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
    };

    const logger = createPinoLogger("silent");
    const imageProcessorLogger = createImageProcessorLogger(logger);
    const imageProcessor = new ImageProcessor(config, imageProcessorLogger);
    const converter = new MarkdownEpubConverter(imageProcessor, fakeCoverGenerator);

    const markdown = `
# Document with Multiple Images

![Image 1](https://via.placeholder.com/100)

Some text here.

![Image 2](https://via.placeholder.com/150)

More text.

![Image 3](https://via.placeholder.com/200)
`;

    const result = await converter.toEpub(
      makeTitle("Multi-Image Test"),
      makeContent(markdown),
      makeAuthor("Test"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imageStats).toBeDefined();
      if (result.value.imageStats) {
        expect(result.value.imageStats.total).toBe(3);
        // At least attempt to download all 3
        expect(result.value.imageStats.downloaded + result.value.imageStats.failed).toBe(3);
      }
    }
  });

  it("gracefully handles broken image URLs", async () => {
    const config = {
      fetchTimeoutMs: 10000,
      retries: 1,
      maxConcurrency: 2,
      maxImageBytes: 5 * 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
    };

    const logger = createPinoLogger("silent");
    const imageProcessorLogger = createImageProcessorLogger(logger);
    const imageProcessor = new ImageProcessor(config, imageProcessorLogger);
    const converter = new MarkdownEpubConverter(imageProcessor, fakeCoverGenerator);

    const markdown = `
# Document with Broken Image

Good image:
![Valid](https://via.placeholder.com/200)

Broken image:
![Invalid](https://example.com/nonexistent-image-12345.png)

More content should still work.
`;

    const result = await converter.toEpub(
      makeTitle("Mixed Images"),
      makeContent(markdown),
      makeAuthor("Test"),
    );

    // Should still succeed even with one broken image
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imageStats).toBeDefined();
      if (result.value.imageStats) {
        expect(result.value.imageStats.total).toBe(2);
        // One should succeed (placeholder), one should fail
        expect(result.value.imageStats.failed).toBeGreaterThan(0);
      }
    }
  });
});

describe("Image downloading (text-only fallback)", () => {
  // These tests always run — they verify that text-only documents
  // are not affected by image processing.

  it("processes text-only markdown without image overhead", async () => {
    const config = {
      fetchTimeoutMs: 15000,
      retries: 2,
      maxConcurrency: 5,
      maxImageBytes: 5 * 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
    };

    const logger = createPinoLogger("silent");
    const imageProcessorLogger = createImageProcessorLogger(logger);
    const imageProcessor = new ImageProcessor(config, imageProcessorLogger);
    const converter = new MarkdownEpubConverter(imageProcessor, fakeCoverGenerator);

    const markdown = `
# Text-Only Document

This document contains no images, just text.

## Section 1

Some content here.

## Section 2

More content here.

- List item 1
- List item 2
- List item 3
`;

    const result = await converter.toEpub(
      makeTitle("Text Only"),
      makeDocument(markdown),
      makeAuthor("Test"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sizeBytes).toBeGreaterThan(0);
      expect(result.value.imageStats).toBeDefined();
      if (result.value.imageStats) {
        expect(result.value.imageStats.total).toBe(0);
        expect(result.value.imageStats.downloaded).toBe(0);
        expect(result.value.imageStats.failed).toBe(0);
      }
    }
  });
});
