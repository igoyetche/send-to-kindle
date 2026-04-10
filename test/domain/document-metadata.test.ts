import { describe, it, expect } from "vitest";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";

describe("DocumentMetadata", () => {
  describe("empty()", () => {
    it("creates metadata with all fields undefined", () => {
      const meta = DocumentMetadata.empty();
      expect(meta.title).toBeUndefined();
      expect(meta.url).toBeUndefined();
      expect(meta.date).toBeUndefined();
    });

    it("isEmpty returns true", () => {
      const meta = DocumentMetadata.empty();
      expect(meta.isEmpty).toBe(true);
    });
  });

  describe("fromRecord()", () => {
    it("parses all fields when present", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "My Article",
        url: "https://example.com",
        date: "2026-04-10",
      });
      expect(meta.title).toBe("My Article");
      expect(meta.url).toBe("https://example.com");
      expect(meta.date).toBe("2026-04-10");
    });

    it("handles partial frontmatter (title only)", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "Just Title",
      });
      expect(meta.title).toBe("Just Title");
      expect(meta.url).toBeUndefined();
      expect(meta.date).toBeUndefined();
    });

    it("ignores unknown fields", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "Article",
        tags: "tag1,tag2",
        description: "A description",
      });
      expect(meta.title).toBe("Article");
      // tags and description are silently dropped
    });

    it("coerces non-string values to undefined", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "Article",
        url: 123, // number, not string
        date: { year: 2026 }, // object, not string
      });
      expect(meta.title).toBe("Article");
      expect(meta.url).toBeUndefined();
      expect(meta.date).toBeUndefined();
    });

    it("normalizes whitespace-only strings to undefined", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "  ",
        url: "\n\t",
        date: "",
      });
      expect(meta.title).toBeUndefined();
      expect(meta.url).toBeUndefined();
      expect(meta.date).toBeUndefined();
    });

    it("trims valid string values", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "  Article Title  ",
        url: "\nhttps://example.com\n",
        date: " 2026-04-10 ",
      });
      expect(meta.title).toBe("Article Title");
      expect(meta.url).toBe("https://example.com");
      expect(meta.date).toBe("2026-04-10");
    });

    it("isEmpty returns true for all-undefined fields", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "  ",
        url: null,
      });
      expect(meta.isEmpty).toBe(true);
    });

    it("isEmpty returns false when at least one field is set", () => {
      const meta = DocumentMetadata.fromRecord({
        title: "Article",
        url: "  ",
      });
      expect(meta.isEmpty).toBe(false);
    });
  });
});
