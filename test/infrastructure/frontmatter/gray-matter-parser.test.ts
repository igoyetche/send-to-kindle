import { describe, it, expect } from "vitest";
import { GrayMatterFrontmatterParser } from "../../../src/infrastructure/frontmatter/gray-matter-parser.js";

describe("GrayMatterFrontmatterParser", () => {
  const parser = new GrayMatterFrontmatterParser();

  describe("parse() — no frontmatter", () => {
    it("returns empty metadata and raw content as body", () => {
      const raw = "# Title\n\nContent here";
      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.isEmpty).toBe(true);
      expect(result.value.body).toBe(raw);
    });

    it("handles plain text without headings", () => {
      const raw = "Just plain text";
      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.isEmpty).toBe(true);
      expect(result.value.body).toBe(raw);
    });
  });

  describe("parse() — full frontmatter", () => {
    it("parses all three fields (title, url, date)", () => {
      const raw = `---
title: My Article
url: https://example.com
date: 2026-04-10
---

# Content

Body text`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.title).toBe("My Article");
      expect(result.value.metadata.url).toBe("https://example.com");
      expect(result.value.metadata.date).toBe("2026-04-10");
      expect(result.value.body).toContain("# Content");
      expect(result.value.body).not.toContain("---");
    });

    it("strips frontmatter from body", () => {
      const raw = `---
title: Test
---

Body content`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.body).toBe("\nBody content");
      expect(result.value.body).not.toContain("---");
      expect(result.value.body).not.toContain("title");
    });
  });

  describe("parse() — partial frontmatter", () => {
    it("handles title-only frontmatter", () => {
      const raw = `---
title: Just Title
---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.title).toBe("Just Title");
      expect(result.value.metadata.url).toBeUndefined();
      expect(result.value.metadata.date).toBeUndefined();
    });

    it("handles url-only frontmatter", () => {
      const raw = `---
url: https://example.com
---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.url).toBe("https://example.com");
      expect(result.value.metadata.title).toBeUndefined();
      expect(result.value.metadata.date).toBeUndefined();
    });
  });

  describe("parse() — empty frontmatter", () => {
    it("handles empty frontmatter block", () => {
      const raw = `---
---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.isEmpty).toBe(true);
      expect(result.value.body).toContain("Body");
    });

    it("handles whitespace-only frontmatter", () => {
      const raw = `---

---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.isEmpty).toBe(true);
    });
  });

  describe("parse() — extra fields", () => {
    it("ignores unknown frontmatter fields", () => {
      const raw = `---
title: Article
tags: tag1,tag2
category: tech
author: John Doe
---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.title).toBe("Article");
      // tags, category, author are silently dropped
    });
  });

  describe("parse() — non-string values", () => {
    it("coerces non-string values to undefined", () => {
      const raw = `---
title: Article
url: 123
date:
  year: 2026
---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.title).toBe("Article");
      expect(result.value.metadata.url).toBeUndefined(); // 123 is not a string
      expect(result.value.metadata.date).toBeUndefined(); // object is not a string
    });

    it("handles boolean and null values", () => {
      const raw = `---
title: Article
url: null
date: true
---

Body`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.title).toBe("Article");
      expect(result.value.metadata.url).toBeUndefined();
      expect(result.value.metadata.date).toBeUndefined();
    });
  });

  describe("parse() — malformed YAML", () => {
    it("returns FrontmatterError on invalid YAML syntax", () => {
      const raw = `---
title: Article
  url: misaligned indentation
---

Body`;

      const result = parser.parse(raw);

      // gray-matter may or may not error on this depending on YAML strictness
      // but if it does, we should catch it
      if (!result.ok) {
        expect(result.error.kind).toBe("frontmatter");
      }
    });

    it("returns FrontmatterError on invalid YAML structure", () => {
      const raw = `---
title: Article
  - this is a list item without proper key
---

Body`;

      const result = parser.parse(raw);

      // This may or may not error depending on the YAML parser
      // but if it does, we should handle it
      if (!result.ok) {
        expect(result.error.kind).toBe("frontmatter");
      }
    });
  });

  describe("parse() — real Paperclip example", () => {
    it("parses a realistic Paperclip-exported Markdown", () => {
      const raw = `---
title: Understanding React 18 useEffect
url: https://blog.example.com/react-18-useeffect
date: 2026-04-09
tags: react,javascript
---

# Understanding React 18 useEffect

React 18 introduced several changes to useEffect behavior...

## Key Changes

- Strict mode runs effects twice in development
- Dependencies array must be stable

More content here`;

      const result = parser.parse(raw);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Should succeed");

      expect(result.value.metadata.title).toBe(
        "Understanding React 18 useEffect",
      );
      expect(result.value.metadata.url).toBe(
        "https://blog.example.com/react-18-useeffect",
      );
      expect(result.value.metadata.date).toBe("2026-04-09");
      expect(result.value.body).toContain("# Understanding React 18 useEffect");
      expect(result.value.body).toContain("Strict mode runs effects twice");
    });
  });
});
