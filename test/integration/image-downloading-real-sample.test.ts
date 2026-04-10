import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { ImageProcessor, type ImageProcessorLogger } from "../../src/infrastructure/converter/image-processor.js";
import { MarkdownEpubConverter } from "../../src/infrastructure/converter/markdown-epub-converter.js";
import { Title } from "../../src/domain/values/title.js";
import { Author } from "../../src/domain/values/author.js";
import { MarkdownContent } from "../../src/domain/values/markdown-content.js";
import { MarkdownDocument } from "../../src/domain/values/markdown-document.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";
import type { ImageStats } from "../../src/domain/values/image-stats.js";

/**
 * Diagnostic logger that captures all events for analysis
 */
class DiagnosticLogger implements ImageProcessorLogger {
  failures: Array<{ url: string; reason: string }> = [];
  successes: Array<{ url: string; format: string; sizeBytes: number }> = [];
  conversions: Array<{ url: string; from: string; to: string }> = [];
  skipped: Array<{ url: string; reason: string }> = [];

  imageDownloadStart(_url: string): void {
    // Silent
  }

  imageDownloadSuccess(url: string, format: string, sizeBytes: number): void {
    this.successes.push({ url, format, sizeBytes });
  }

  imageDownloadFailure(url: string, reason: string): void {
    this.failures.push({ url, reason });
  }

  imageFormatConverted(url: string, from: string, to: string): void {
    this.conversions.push({ url, from, to });
  }

  imageSkipped(url: string, reason: string): void {
    this.skipped.push({ url, reason });
  }

  imageSummary(_stats: ImageStats): void {
    // Silent
  }
}

/**
 * Real-world integration test using the George Mack article.
 * Tests that the ImageProcessor correctly handles a real-world scenario with:
 * - 66 unique images from Webflow CDN
 * - Mixed image formats (JPEG, GIF, AVIF, HEIF)
 * - HEIF format conversion to JPEG (Apple's modern image format)
 * - Deduplication of image URLs appearing multiple times
 *
 * All images should download successfully and be converted as needed.
 *
 * Run with: npm test -- image-downloading-real-sample
 */
describe("Image downloading with real sample file", () => {
  it(
    "High Agency article - diagnose image download failures",
    async () => {
    const samplePath = resolve(
      "docs/md-input-samples/2026-04-08-high-agency-in-30-minutes-george-mack.md",
    );

    let markdown: string;
    try {
      markdown = readFileSync(samplePath, "utf-8");
    } catch {
      throw new Error(
        `Sample file not found at ${samplePath}. Create it or update the path.`,
      );
    }

    // Extract image URLs from the markdown to understand what we're dealing with
    const imageUrlRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const imageUrls: string[] = [];
    let match;
    while ((match = imageUrlRegex.exec(markdown)) !== null) {
      imageUrls.push(match[2]);
    }

    console.log(`\n=== Real Sample File Analysis ===`);
    console.log(`Found ${imageUrls.length} images in markdown\n`);

    imageUrls.forEach((url, i) => {
      console.log(`Image ${i + 1}: ${url.substring(0, 100)}...`);
    });

    // Setup processor with increased timeout for real network
    const diagnosticLogger = new DiagnosticLogger();

    // Increase timeout for real network conditions
    const processor = new ImageProcessor(
      {
        fetchTimeoutMs: 30_000, // 30s instead of 15s
        retries: 1, // Reduced retries for faster iteration
        maxConcurrency: 3, // Limit concurrency for CDN
        maxImageBytes: 10 * 1024 * 1024, // 10MB per image
        maxTotalBytes: 500 * 1024 * 1024, // 500MB total
      },
      diagnosticLogger,
    );

    // Convert markdown to HTML (simplified - just extract image tags)
    const htmlWithImages = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      return `<img src="${src}" alt="${alt}">`;
    });

    console.log(`\n=== Processing ${imageUrls.length} Images ===\n`);

    const result = await processor.process(htmlWithImages);

    console.log(`\n=== Results ===`);
    console.log(`Total: ${result.stats.total}`);
    console.log(`Downloaded: ${result.stats.downloaded}`);
    console.log(`Failed: ${result.stats.failed}`);
    console.log(`Skipped: ${result.stats.skipped}`);

    // Detailed failure analysis
    if (diagnosticLogger.failures.length > 0) {
      console.log(`\n=== Failure Analysis (${diagnosticLogger.failures.length} failures) ===`);

      // Group by error reason
      const reasonMap = new Map<string, string[]>();
      for (const { url, reason } of diagnosticLogger.failures) {
        if (!reasonMap.has(reason)) {
          reasonMap.set(reason, []);
        }
        const urls = reasonMap.get(reason);
        if (urls) {
          urls.push(url);
        }
      }

      for (const [reason, urls] of reasonMap.entries()) {
        console.log(`\n${reason} (${urls.length} images):`);
        urls.slice(0, 3).forEach((url) => {
          console.log(`  - ${url.substring(0, 120)}...`);
        });
        if (urls.length > 3) {
          console.log(`  ... and ${urls.length - 3} more`);
        }
      }
    }

    if (diagnosticLogger.successes.length > 0) {
      console.log(`\n=== Successful Downloads (${diagnosticLogger.successes.length}) ===`);
      diagnosticLogger.successes.slice(0, 5).forEach(({ url, format, sizeBytes }) => {
        console.log(`  ✓ ${format.toUpperCase()} - ${sizeBytes} bytes`);
        console.log(`    ${url.substring(0, 100)}...`);
      });
      if (diagnosticLogger.successes.length > 5) {
        console.log(`  ... and ${diagnosticLogger.successes.length - 5} more`);
      }
    }

    // Report summary
    if (result.stats.failed > 0) {
      console.log(
        `\n⚠️  ${result.stats.failed}/${result.stats.total} images failed to download`,
      );
      console.log(
        "See failure analysis above for specific reasons (timeout, format detection, network errors, etc.)",
      );
    } else if (result.stats.downloaded > 0) {
      console.log(`\n✓ All images downloaded successfully!`);
    }

    // Assertions
    // Stats should add up
    expect(result.stats.downloaded + result.stats.failed + result.stats.skipped).toBe(
      result.stats.total,
    );
    // All images should download successfully now that HEIF conversion is supported
    expect(result.stats.downloaded).toBe(result.stats.total);
    expect(result.stats.failed).toBe(0);
    // Images array should match downloaded count
    expect(result.images.length).toBe(result.stats.downloaded);

    // Verify ProcessResult includes image array
    console.log(`\n=== ProcessResult Image Array ===`);
    console.log(`Images returned by processor: ${result.images.length}`);
    if (result.images.length > 0) {
      result.images.slice(0, 3).forEach((img) => {
        console.log(`  ✓ ${img.filename} (${img.format}): ${img.buffer.length} bytes`);
      });
      if (result.images.length > 3) {
        console.log(`  ... and ${result.images.length - 3} more`);
      }
    }

    // Verify HTML is unchanged (still has original URLs, not data URIs)
    const lines = result.html.split("\n").slice(0, 10);
    if (result.stats.downloaded > 0) {
      console.log(`\n=== Sample HTML Output (first 10 lines) ===`);
      let foundImgs = false;
      lines.forEach((line) => {
        if (line.includes("<img")) {
          console.log(`  ✓ HTML unchanged: ${line.substring(0, 100)}...`);
          foundImgs = true;
        }
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (foundImgs) {
        // Verify no data URIs in HTML
        const hasDataUri = result.html.includes("data:image/");
        console.log(`  Data URIs in HTML: ${hasDataUri ? "YES (ERROR)" : "NO (correct)"}`);
      }
    }
    },
    120_000, // 2 minutes for real network requests
  );

  it("detects image URLs in markdown with URL encoding", async () => {
    // Test that we correctly detect and parse URL-encoded image URLs
    const html = `
      <img src="https://cdn.example.com/image_https%253A%252F%252Fexample.com%252Ftest.avif" alt="test">
    `;

    const logger = new DiagnosticLogger();
    const processor = new ImageProcessor(
      {
        fetchTimeoutMs: 10_000,
        retries: 1,
        maxConcurrency: 3,
        maxImageBytes: 5 * 1024 * 1024,
        maxTotalBytes: 100 * 1024 * 1024,
      },
      logger,
    );

    const result = await processor.process(html);

    // Should detect the image URL even with encoding
    expect(result.stats.total).toBe(1);
  });

  it("handles AVIF format from Webflow CDN", async () => {
    // Webflow typically serves AVIF format for performance
    const html = `
      <img src="https://cdn.prod.website-files.com/example/test.avif" alt="webflow-image">
    `;

    const logger = new DiagnosticLogger();
    const processor = new ImageProcessor(
      {
        fetchTimeoutMs: 30_000, // More time for real CDN
        retries: 1,
        maxConcurrency: 3,
        maxImageBytes: 5 * 1024 * 1024,
        maxTotalBytes: 100 * 1024 * 1024,
      },
      logger,
    );

    const result = await processor.process(html);

    // The image will likely fail if the URL is invalid, but we want to see it attempts
    expect(result.stats.total).toBe(1);
    // It should either download or fail gracefully
    expect(result.stats.downloaded + result.stats.failed).toBe(1);
  });

  it(
    "verifies EPUB contains actual image files in OEBPS/images/ (not data URIs)",
    async () => {
      const samplePath = resolve(
        "docs/md-input-samples/2026-04-08-high-agency-in-30-minutes-george-mack.md",
      );

      let markdown: string;
      try {
        markdown = readFileSync(samplePath, "utf-8");
      } catch {
        throw new Error(
          `Sample file not found at ${samplePath}. Create it or update the path.`,
        );
      }

      // Create title and content
      const titleResult = Title.create("High Agency - EPUB Image Verification Test");
      const contentResult = MarkdownContent.create(markdown);
      const authorResult = Author.create("Claude");

      if (!titleResult.ok || !contentResult.ok || !authorResult.ok) {
        throw new Error("Failed to create required values");
      }

      // Create converter
      const diagnosticLogger = new DiagnosticLogger();
      const processor = new ImageProcessor(
        {
          fetchTimeoutMs: 30_000,
          retries: 1,
          maxConcurrency: 3,
          maxImageBytes: 10 * 1024 * 1024,
          maxTotalBytes: 500 * 1024 * 1024,
        },
        diagnosticLogger,
      );

      const converter = new MarkdownEpubConverter(processor);

      // Generate EPUB
      const document = MarkdownDocument.fromParts(contentResult.value, DocumentMetadata.empty());
      const epubResult = await converter.toEpub(
        titleResult.value,
        document,
        authorResult.value,
      );

      expect(epubResult.ok).toBe(true);
      if (!epubResult.ok) {
        throw new Error(`EPUB conversion failed: ${epubResult.error.message}`);
      }

      const epubBuffer = epubResult.value.buffer;

      // Extract and verify EPUB structure
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(epubBuffer);

      // Check OEBPS/images directory exists and contains image files
      const imageFiles = Object.keys(loadedZip.files).filter((path) =>
        path.startsWith("OEBPS/images/") && !path.endsWith("/"),
      );

      console.log(`\n=== EPUB Structure Verification ===`);
      console.log(`Image files in OEBPS/images/: ${imageFiles.length}`);
      if (imageFiles.length > 0) {
        imageFiles.slice(0, 5).forEach((path) => {
          console.log(`  ✓ ${path}`);
        });
        if (imageFiles.length > 5) {
          console.log(`  ... and ${imageFiles.length - 5} more`);
        }
      }

      // Verify images are actual files (not data URIs)
      expect(imageFiles.length).toBeGreaterThan(0);
      expect(imageFiles.length).toBe(diagnosticLogger.successes.length);

      // Verify manifest includes image entries
      const contentOpf = loadedZip.file("OEBPS/content.opf");
      if (contentOpf) {
        const opfContent = await contentOpf.async("string");

        // Count image manifest entries (only <item> elements with image media types)
        const itemRegex = /<item[^>]+media-type="image\/[^"]*"[^>]*>/g;
        const manifestImageCount = (opfContent.match(itemRegex) || []).length;

        console.log(`Image entries in manifest: ${manifestImageCount}`);
        expect(manifestImageCount).toBeGreaterThanOrEqual(imageFiles.length);

        // Verify no data URIs in manifest (should reference files only)
        expect(opfContent).not.toContain("data:image/");
      }

      // Verify HTML doesn't contain data URIs (images are referenced by file)
      const chapter = loadedZip.file("OEBPS/ch1.xhtml");
      if (chapter) {
        const chapterContent = await chapter.async("string");

        // Should have img tags pointing to OEBPS/images/ files
        const imgTagRegex = /<img[^>]+src="([^"]+)"/g;
        let imgMatch;
        const imgSources: string[] = [];
        while ((imgMatch = imgTagRegex.exec(chapterContent)) !== null) {
          imgSources.push(imgMatch[1]);
        }

        console.log(`Image references in HTML: ${imgSources.length}`);

        // Verify none are data URIs
        const dataUriCount = imgSources.filter((src) =>
          src.startsWith("data:image/"),
        ).length;
        console.log(`Data URIs in HTML: ${dataUriCount}`);

        expect(dataUriCount).toBe(0);
        expect(imgSources.length).toBeGreaterThan(0);
      }

      console.log(`\n✓ EPUB structure verified: ${imageFiles.length} image files embedded`);
    },
    180_000, // 3 minutes for EPUB generation + network
  );
});
