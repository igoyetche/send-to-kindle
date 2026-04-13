import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { ContentConverter } from "../../domain/ports.js";
import type { Title, Author, MarkdownDocument } from "../../domain/values/index.js";
import { EpubDocument } from "../../domain/values/index.js";
import { ConversionError, type Result, ok, err } from "../../domain/errors.js";
import type { ImageProcessor } from "./image-processor.js";
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
  constructor(private readonly imageProcessor: ImageProcessor) {}

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
      const { html: processedHtml, images: processedImages, stats } = await this.imageProcessor.process(safeHtml);

      // Create a map of downloaded image buffers by filename
      // This will be used in downloadAllImages to fill in image.data
      const imageBufferMap = new Map<string, { buffer: Buffer; format: string }>();

      // Build map indexed by filename (ImageProcessor returns images in download order)
      for (const img of processedImages) {
        imageBufferMap.set(img.filename, { buffer: img.buffer, format: img.format });
      }

      // Create EPUB instance with custom downloadAllImages that uses pre-downloaded data
       
      const epubInstance = createEpubWithPredownloadedImages(
        { title: title.value, author: author.value },
        [{ title: title.value, content: processedHtml }],
      );

      // Attach the image map so downloadAllImages can access it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (epubInstance as any).__imageBufferMap = imageBufferMap; // eslint-disable-line @typescript-eslint/no-explicit-any

      // Generate EPUB with pre-downloaded images
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
