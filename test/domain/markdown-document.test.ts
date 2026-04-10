import { describe, it, expect } from "vitest";
import { MarkdownDocument } from "../../src/domain/values/markdown-document.js";
import { MarkdownContent } from "../../src/domain/values/markdown-content.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";

describe("MarkdownDocument", () => {
  describe("fromParts()", () => {
    it("constructs from content and metadata", () => {
      const contentResult = MarkdownContent.create("# Title\n\nBody");
      expect(contentResult.ok).toBe(true);
      if (!contentResult.ok) throw new Error("Should succeed");

      const metadata = DocumentMetadata.fromRecord({
        title: "Article",
        url: "https://example.com",
      });

      const doc = MarkdownDocument.fromParts(
        contentResult.value,
        metadata,
      );

      expect(doc.content).toBe(contentResult.value);
      expect(doc.metadata).toBe(metadata);
    });

    it("preserves empty metadata", () => {
      const contentResult = MarkdownContent.create("# Title\n\nBody");
      expect(contentResult.ok).toBe(true);
      if (!contentResult.ok) throw new Error("Should succeed");

      const metadata = DocumentMetadata.empty();
      const doc = MarkdownDocument.fromParts(
        contentResult.value,
        metadata,
      );

      expect(doc.metadata.isEmpty).toBe(true);
    });
  });
});
