import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import epub from "epub-gen-memory";
import type { ContentConverter } from "../../domain/ports.js";
import type { Title, Author, MarkdownContent } from "../../domain/values/index.js";
import { EpubDocument } from "../../domain/values/index.js";
import { ConversionError, type Result, ok, err } from "../../domain/errors.js";

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
  async toEpub(
    title: Title,
    content: MarkdownContent,
    author: Author,
  ): Promise<Result<EpubDocument, ConversionError>> {
    try {
      const rawHtml = await marked.parse(content.value);

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

      const buffer = await epub(
        { title: title.value, author: author.value },
        [{ title: title.value, content: safeHtml }],
      );

      return ok(new EpubDocument(title.value, buffer));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown conversion error";
      return err(new ConversionError(message));
    }
  }
}
