import { describe, it, expect } from "vitest";
import { EpubDocument } from "../../../src/domain/values/epub-document.js";

describe("EpubDocument", () => {
  it("wraps a buffer with a title", () => {
    const buffer = Buffer.from("fake epub content");
    const doc = new EpubDocument("Clean Architecture", buffer);
    expect(doc.title).toBe("Clean Architecture");
    expect(doc.buffer).toBe(buffer);
  });

  it("derives sizeBytes from buffer length", () => {
    const buffer = Buffer.alloc(1024);
    const doc = new EpubDocument("Test", buffer);
    expect(doc.sizeBytes).toBe(1024);
  });
});
