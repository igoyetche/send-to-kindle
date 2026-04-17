/**
 * EPub factory that supports pre-downloaded images.
 *
 * epub-gen-memory always attempts to download images from URLs, even if
 * image.data is pre-populated. This helper overrides downloadAllImages()
 * on an EPub instance to skip download attempts and directly write pre-set
 * image buffers.
 *
 * This allows us to:
 * 1. Download and convert images ourselves (via ImageProcessor)
 * 2. Pre-populate the EPub instance with downloaded image buffers
 * 3. Let EPub create proper OEBPS/images/ structure
 * 4. Avoid double-downloading and get proper EPUB image files (Kindle-compatible)
 *
 * See: PB-017 design for motivation and architecture
 */

import * as epubModule from "epub-gen-memory";

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
const EPubClass = (epubModule as any).EPub;

/**
 * Creates an EPub instance with pre-downloaded images embedded correctly.
 *
 * Strategy:
 * 1. Pass HTML with original image URLs unchanged to EPub
 * 2. Let epub-gen-memory's normalizeHTML() detect URLs and create image objects with UUID filenames
 * 3. Override downloadAllImages() to:
 *    - Match detected image URLs to pre-downloaded buffers (from __imageBufferMap)
 *    - Fill in image.data for matched images
 *    - Write files with UUID-based filenames that HTML references
 *
 * This ensures downloaded image buffers are paired with the correct UUID paths.
 */
 
export function createEpubWithPredownloadedImages(
  options: unknown,
  chapters: unknown,
): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const epub = new EPubClass(options, chapters);

  // Override downloadAllImages to match pre-downloaded images to detected URLs
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  (epub).downloadAllImages = function (): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (!this.images || !this.images.length) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.log?.("No images to embed");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.log?.("Embedding pre-downloaded images (skipping network download)");

    // Get the buffer map that was attached by the converter
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const imageBufferMap = (this).__imageBufferMap as Map<
      string,
      { buffer: Buffer; format: string }
    > | undefined;

    // Fill in image.data for images by matching filenames or using sequential order
    if (imageBufferMap) {
      const buffers = Array.from(imageBufferMap.values());
      let bufferIndex = 0;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      for (const image of this.images) {
        // epub-gen-memory processes all <img> src attrs including data: URIs — skip them
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (typeof image.url === "string" && image.url.startsWith("data:")) continue;

        // Try exact filename match first
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        let bufferData = imageBufferMap.get(image.filename || "");

        // Fall back to sequential assignment
        if (!bufferData && bufferIndex < buffers.length) {
          bufferData = buffers[bufferIndex];
          bufferIndex += 1;
        }

        if (bufferData) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          image.data = bufferData.buffer;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          this.log?.(`Assigned buffer to ${image.id}`);
        }
      }
    }

    // Get or create the images folder in OEBPS
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const oebps = this.zip?.folder("OEBPS");
    if (!oebps) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.warn?.("Could not access OEBPS folder");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const imagesFolder = oebps.folder("images");
    if (!imagesFolder) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.warn?.("Could not create OEBPS/images folder");
      return;
    }

    // Write image files with UUID-based filenames
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    for (const image of this.images) {
      // Skip data URI phantom entries — see guard in assignment loop above
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof image.url === "string" && image.url.startsWith("data:")) continue;

      // Extract filename from href (contains the UUID that HTML references)
      // href format: "images/uuid.extension"
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const hrefMatch = image.href?.match(/images\/(.+)$/);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const filename = hrefMatch ? hrefMatch[1] : `${image.id}.${image.extension}`;

      // Write file if we have data
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (image.data && typeof image.data !== "string") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        imagesFolder.file(filename, image.data);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.log?.(`Embedded image ${filename} (${image.data.length} bytes)`);
      } else {
        // Image was detected but we don't have data for it (not pre-downloaded)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.warn?.(
          `Image ${filename} has no data - skipping (will appear as broken image in EPUB)`,
        );
      }
    }
  };

  return epub;
}
