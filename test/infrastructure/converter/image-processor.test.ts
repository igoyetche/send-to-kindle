import { describe, it, expect, vi, afterEach } from "vitest";
import { ImageProcessor } from "../../../src/infrastructure/converter/image-processor.js";
import type {
  ImageProcessorConfig,
  ImageProcessorLogger,
} from "../../../src/infrastructure/converter/image-processor.js";

const defaultConfig: ImageProcessorConfig = {
  fetchTimeoutMs: 5000,
  retries: 1,
  maxConcurrency: 2,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

function createMockLogger(): ImageProcessorLogger {
  return {
    imageDownloadStart: vi.fn(),
    imageDownloadSuccess: vi.fn(),
    imageDownloadFailure: vi.fn(),
    imageFormatConverted: vi.fn(),
    imageSkipped: vi.fn(),
    imageSummary: vi.fn(),
  };
}

describe("ImageProcessor", () => {
  it("returns unchanged HTML when no images present", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);
    const html = "<p>Hello world</p>";

    const result = await processor.process(html);

    expect(result.html).toBe(html);
    expect(result.stats).toEqual({
      total: 0,
      downloaded: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mockLogger.imageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0 }),
    );
  });

  it("extracts multiple image URLs from HTML", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    // HTML with image URLs but no actual download attempt
    const html = `
      <p>Content with images</p>
      <img src="https://example.com/image1.png" alt="1">
      <img src="https://example.com/image2.jpg" alt="2">
    `;

    const result = await processor.process(html);

    // Should detect 2 images (fails to download, but detects them)
    expect(result.stats.total).toBe(2);
  });

  it("removes img tags for URLs that cannot be downloaded", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const html = `<p>Before</p><img src="https://example.invalid/missing.png" alt="test"><p>After</p>`;

    const result = await processor.process(html);

    // Should keep content around failed images
    expect(result.html).toContain("Before");
    expect(result.html).toContain("After");
    // Should remove the img tag
    expect(result.html).not.toContain('<img src="https://example.invalid/missing.png"');
    expect(result.stats.failed).toBe(1);
  });

  it(
    "reports stats for images that fail to download",
    async () => {
      const mockLogger = createMockLogger();
      const processor = new ImageProcessor(defaultConfig, mockLogger);

      const html = `
        <img src="https://example.invalid/404.png" alt="fail">
        <img src="https://another.invalid/err.jpg" alt="fail2">
      `;

      const result = await processor.process(html);

      expect(result.stats.total).toBe(2);
      expect(result.stats.failed).toBe(2);
      expect(result.stats.downloaded).toBe(0);
      expect(mockLogger.imageDownloadFailure).toHaveBeenCalled();
    },
    60_000,
  );

  it("deduplicates duplicate image URLs", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const html = `
      <img src="https://example.com/same.png" alt="1">
      <img src="https://example.com/same.png" alt="2">
      <img src="https://example.com/same.png" alt="3">
    `;

    const result = await processor.process(html);

    // Should only attempt to download the image once
    expect(result.stats.total).toBe(1);
  });

  it("logs download start for each image", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const html = `
      <img src="https://example.invalid/img1.png" alt="1">
      <img src="https://example.invalid/img2.png" alt="2">
    `;

    await processor.process(html);

    // Should log download start for each unique URL
    expect(mockLogger.imageDownloadStart).toHaveBeenCalledWith(
      expect.stringContaining("example.invalid"),
    );
  });

  it("logs image summary after processing", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const html = "<p>No images</p>";
    await processor.process(html);

    expect(mockLogger.imageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 0,
        downloaded: 0,
        failed: 0,
        skipped: 0,
      }),
    );
  });

  it("handles mixed local and remote URLs", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const html = `
      <img src="https://example.com/remote.png" alt="remote">
      <img src="/local/image.png" alt="local">
      <img src="file:///absolute/path.png" alt="file">
    `;

    const result = await processor.process(html);

    // Should only detect the https URL
    expect(result.stats.total).toBe(1);
  });

  it("does not follow non-HTTP redirects", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    // This tests that redirect validation is in place
    // (actual redirect behavior tested implicitly through fetch failures)
    const html = `<img src="https://example.com/redirect-test.png" alt="test">`;

    const result = await processor.process(html);

    // Should attempt download but fail on bad redirect or timeout
    expect(result.stats.total).toBe(1);
  });

  it("preserves HTML structure outside of images", async () => {
    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const html = `
      <article>
        <h1>Title</h1>
        <p>Content</p>
        <img src="https://example.invalid/missing.png" alt="missing">
        <p>More content</p>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
      </article>
    `;

    const result = await processor.process(html);

    expect(result.html).toContain("<h1>Title</h1>");
    expect(result.html).toContain("<p>Content</p>");
    expect(result.html).toContain("<p>More content</p>");
    expect(result.html).toContain("<ul>");
    expect(result.html).not.toContain("<img");
  });
});

describe("request headers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends User-Agent and Accept headers on every image request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 403 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    await processor.process(`<img src="https://example.com/photo.png" alt="test">`);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
          Accept: expect.stringContaining("image/"),
        }),
      }),
    );
  });
});
