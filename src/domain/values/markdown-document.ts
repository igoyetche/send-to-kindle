import type { MarkdownContent } from "./markdown-content.js";
import type { DocumentMetadata } from "./document-metadata.js";

/**
 * Wraps parsed Markdown content and extracted document metadata.
 *
 * The body has already been stripped of frontmatter and validated for size.
 * Metadata (title, url, date) is available for use by the converter and
 * downstream processors (e.g., cover generation).
 */
export class MarkdownDocument {
  private constructor(
    readonly content: MarkdownContent,
    readonly metadata: DocumentMetadata,
  ) {}

  /**
   * Constructs a MarkdownDocument from its parts.
   */
  static fromParts(
    content: MarkdownContent,
    metadata: DocumentMetadata,
  ): MarkdownDocument {
    return new MarkdownDocument(content, metadata);
  }
}
