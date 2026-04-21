/**
 * MarkdownEpubConverter — Implements FR-1, FR-36, FR-37 (PB-008)
 *
 * Converts a MarkdownDocument to an EpubDocument by:
 *  1. Parsing Markdown to HTML via marked
 *  2. Sanitizing HTML via sanitize-html
 *  3. Processing embedded images via ImageProcessor
 *  4. Generating a cover image and HTML chapter via CoverGenerator
 *  5. Assembling the EPUB via epub-gen-memory with pre-downloaded images
 */

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

/**
 * Converts Markdown content to EPUB format, injecting a styled cover page
 * and embedding any remote images locally inside the EPUB container.
 *
 * Implements FR-1 (PB-008): Markdown → EPUB conversion pipeline.
 * Implements FR-36, FR-37 (PB-008): cover HTML chapter and cover JPEG image.
 */
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

      // Process images — download remote images and return them as buffers
      const { html: processedHtml, images: processedImages, stats } =
        await this.imageProcessor.process(safeHtml);

      // Generate cover assets — FR-36 (HTML chapter) and FR-37 (JPEG image)
      const coverCss = await this.coverGenerator.generateCoverCss();
      const jpegBuffer = await this.coverGenerator.generateImage(
        title.value,
        author.value,
      );
      const htmlChapter = this.coverGenerator.generateHtmlChapter(
        title.value,
        author.value,
        document.metadata.url,
      );
      // Copy into a concrete ArrayBuffer so File() receives ArrayBuffer (not
      // ArrayBufferLike, which includes SharedArrayBuffer and fails strict TS).
      const coverUint8 = new Uint8Array(jpegBuffer.byteLength);
      coverUint8.set(jpegBuffer);
      const coverFile = new File([coverUint8], "cover.jpg", { type: "image/jpeg" });

      // Build image buffer map for pre-downloaded images
      const imageBufferMap = new Map<string, { buffer: Buffer; format: string }>();
      for (const img of processedImages) {
        imageBufferMap.set(img.filename, {
          buffer: img.buffer,
          format: img.format,
        });
      }

      const epubInstance = createEpubWithPredownloadedImages(
        { title: title.value, author: author.value, cover: coverFile, css: coverCss },
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

      // Attach image map so the overridden downloadAllImages() can use it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (epubInstance as any).__imageBufferMap = imageBufferMap;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const buffer = await (epubInstance as any).genEpub();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return ok(new EpubDocument(title.value, buffer, stats, author.value, document.metadata.date));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown conversion error";
      return err(new ConversionError(message));
    }
  }
}
