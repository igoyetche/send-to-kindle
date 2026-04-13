import sharp from "sharp";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import type { ImageStats } from "../../domain/values/image-stats.js";

// Configuration
export interface ImageProcessorConfig {
  readonly fetchTimeoutMs: number;
  readonly retries: number;
  readonly maxConcurrency: number;
  readonly maxImageBytes: number;
  readonly maxTotalBytes: number;
}

// Logging interface
export interface ImageProcessorLogger {
  imageDownloadStart(url: string): void;
  imageDownloadSuccess(
    url: string,
    format: string,
    sizeBytes: number,
    durationMs: number,
  ): void;
  imageDownloadFailure(url: string, reason: string): void;
  imageFormatConverted(url: string, from: string, to: string): void;
  imageSkipped(url: string, reason: string): void;
  imageSummary(stats: ImageStats): void;
}

// Processed image data for EPUB embedding
export interface ProcessedImage {
  readonly filename: string;
  readonly buffer: Buffer;
  readonly format: string;
}

// Result type
export interface ProcessResult {
  readonly html: string;
  readonly images: ProcessedImage[];
  readonly stats: ImageStats;
}

// Supported formats that Kindle can handle
const KINDLE_FORMATS = new Set(["jpeg", "jpg", "png", "gif", "bmp"]);

// Formats that need conversion to JPEG
const CONVERT_FORMATS = new Set(["avif", "webp", "tiff", "svg", "heif", "heic"]);

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "image/webp,image/avif,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

function isPrivateIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) // 169.254.0.0/16 link-local
    );
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" || // loopback
      lower.startsWith("fc") || // fc00::/7 unique local
      lower.startsWith("fd") || // fc00::/7 unique local
      lower.startsWith("fe80") // fe80::/10 link-local
    );
  }
  return false;
}

interface DownloadedImage {
  url: string;
  buffer: Buffer;
  format: string;
}

/**
 * Processes images in HTML: downloads remote images and converts unsupported formats.
 * Returns downloaded image buffers separately for EPUB embedding, keeps HTML unchanged.
 */
export class ImageProcessor {
  constructor(
    private readonly config: ImageProcessorConfig,
    private readonly logger: ImageProcessorLogger,
  ) {}

  async process(html: string): Promise<ProcessResult> {
    // Extract image URLs
    const imageUrls = this.extractImageUrls(html);

    let stats: ImageStats;
    let processedImages: ProcessedImage[] = [];
    let processedHtml = html;

    if (imageUrls.length === 0) {
      stats = { total: 0, downloaded: 0, failed: 0, skipped: 0 };
    } else {
      // Download and process images
      const result = await this.downloadImages(imageUrls);
      stats = result.stats;
      const downloadedImages = result.images;
      processedImages = this.generateProcessedImages(downloadedImages);

      // Remove img tags for failed images
      for (const url of imageUrls) {
        if (!downloadedImages.some((img) => img.url === url)) {
          processedHtml = this.removeImageTag(processedHtml, url);
        }
      }
    }

    this.logger.imageSummary(stats);

    return { html: processedHtml, images: processedImages, stats };
  }

  private extractImageUrls(html: string): string[] {
    const regex = /<img[^>]+src="(https?:\/\/[^"]+)"/gi;
    const urls: string[] = [];
    let match;

    while ((match = regex.exec(html)) !== null) {
      const url = match[1];
      if (url) {
        urls.push(url);
      }
    }

    // Deduplicate
    return Array.from(new Set(urls));
  }

  private async downloadImages(
    urls: string[],
  ): Promise<{ images: DownloadedImage[]; stats: ImageStats }> {
    const images: DownloadedImage[] = [];
    let totalBytes = 0;
    let failed = 0;
    let skipped = 0;

    // Process in batches to limit concurrency
    for (let i = 0; i < urls.length; i += this.config.maxConcurrency) {
      const batch = urls.slice(i, i + this.config.maxConcurrency);
      const results = await Promise.allSettled(
        batch.map((url) => this.downloadAndProcessImage(url, totalBytes)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (!result) continue;

        const url = batch[j] || "";

        if (result.status === "fulfilled") {
          const value = result.value;
          if (value !== null) {
            const { buffer, format } = value;

            // Check if total would exceed limit
            if (totalBytes + buffer.length > this.config.maxTotalBytes) {
              this.logger.imageSkipped(
                url,
                "Total image payload would exceed limit",
              );
              skipped += 1;
              continue;
            }

            images.push({ url, buffer, format });
            totalBytes += buffer.length;
          }
        } else {
          failed += 1;
          const reason =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          this.logger.imageDownloadFailure(url, reason);
        }
      }
    }

    return {
      images,
      stats: {
        total: urls.length,
        downloaded: images.length,
        failed,
        skipped,
      },
    };
  }

  private async downloadAndProcessImage(
    url: string,
    _currentTotalBytes: number,
  ): Promise<{ buffer: Buffer; format: string } | null> {
    this.logger.imageDownloadStart(url);

    let buffer: Buffer | null = null;
    let lastError: Error | null = null;

    // Retry loop
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        buffer = await this.fetchWithTimeout(url);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.config.retries) {
          // Will retry
          continue;
        }
      }
    }

    if (buffer === null) {
      throw lastError || new Error("Failed to download image");
    }

    // Check size
    if (buffer.length > this.config.maxImageBytes) {
      throw new Error(
        `Image exceeds ${this.config.maxImageBytes} bytes (${buffer.length} bytes)`,
      );
    }

    // Detect format
    let metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch (error) {
      throw new Error(
        `Could not detect image format: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const detectedFormat = metadata.format || "unknown";
    const format = detectedFormat.toLowerCase();

    if (format === "unknown") {
      throw new Error("Could not determine image format");
    }

    // Convert if needed
    let finalBuffer = buffer;
    let finalFormat = format;

    if (CONVERT_FORMATS.has(format)) {
      try {
        finalBuffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
        finalFormat = "jpeg";
        this.logger.imageFormatConverted(url, format, "jpeg");
      } catch (error) {
        throw new Error(
          `Could not convert ${format} to JPEG: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (!KINDLE_FORMATS.has(format)) {
      throw new Error(`Unsupported image format: ${format}`);
    }

    const duration = 0; // Not tracking actual duration in this implementation
    this.logger.imageDownloadSuccess(url, finalFormat, finalBuffer.length, duration);

    return { buffer: finalBuffer, format: finalFormat };
  }

  private async validateUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Redirect to non-HTTP protocol: ${url}`);
    }

    // URL.hostname for IPv6 literals includes brackets: "[::1]" — strip them
    // before passing to dns.lookup, which expects bare IP strings.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

    const { address } = await dnsLookup(hostname, { verbatim: false });
    if (isPrivateIp(address)) {
      throw new Error(
        `Blocked: URL resolves to private IP address (${address})`,
      );
    }
  }

  private async fetchWithTimeout(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.fetchTimeoutMs,
    );

    try {
      return await this.doFetch(url, controller.signal, 0);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Download timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async doFetch(
    url: string,
    signal: AbortSignal,
    redirectsFollowed: number,
  ): Promise<Buffer> {
    await this.validateUrl(url);

    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal,
      redirect: "manual",
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectsFollowed >= 5) {
        throw new Error("Too many redirects (> 5)");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirect without Location header");
      }
      return this.doFetch(location, signal, redirectsFollowed + 1);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private generateProcessedImages(
    downloadedImages: DownloadedImage[],
  ): ProcessedImage[] {
    return downloadedImages.map((img, index) => ({
      filename: this.generateFilename(index + 1, img.format),
      buffer: img.buffer,
      format: img.format,
    }));
  }

  private generateFilename(index: number, format: string): string {
    const paddedIndex = String(index).padStart(3, "0");
    return `image-${paddedIndex}.${format}`;
  }

  private removeImageTag(html: string, url: string): string {
    // Escape special regex characters
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`<img[^>]+src="${escapedUrl}"[^>]*>`, "gi");
    return html.replace(regex, "");
  }
}
