# PB-008: EPUB Cover Generation — Design

**Status:** Approved
**Date:** 2026-04-15
**Spec:** docs/specs/main-spec.md (FR-5 updated)

## Summary

Generate a cover automatically for every EPUB produced by paperboy, using the document's title and author. No new required parameters or configuration. The cover appears in two places: as a thumbnail in the Kindle library (a JPEG image embedded in the EPUB manifest) and as a styled first-page chapter inside the document.

The implementation is entirely within the infrastructure layer. No domain layer changes.

## Current State

The conversion pipeline produces EPUBs with no cover image. The Kindle library shows a generic placeholder for all paperboy documents. Documents are not visually distinguishable from one another in the library grid.

## Decision: Dedicated `CoverGenerator` class (Approach A)

Three approaches were evaluated:

| Approach | Description | Verdict |
|----------|-------------|---------|
| **A. Dedicated `CoverGenerator` class** | New infrastructure component, injected into `MarkdownEpubConverter` | **Chosen**: single responsibility, independently testable, follows existing `ImageProcessor` pattern |
| **B. Inline in `MarkdownEpubConverter`** | Cover logic added directly to `toEpub()` | Rejected: converter grows from ~75 to ~200+ lines, mixes two concerns, harder to test cover logic in isolation |
| **C. Override `makeCover` in `epub-with-images.ts`** | Extend the existing epub-gen-memory override file | Rejected: mixes infrastructure glue with design/rendering logic in a file already complex from the image workaround |

## Architecture

### Updated Conversion Pipeline

```
Markdown
  → marked.parse()              → rawHtml
  → sanitize-html               → safeHtml
  → ImageProcessor.process()    → { html: processedHtml, stats }
  → CoverGenerator.generateImage()        → jpegBuffer            ← NEW
  → CoverGenerator.generateHtmlChapter()  → htmlChapter           ← NEW
  → epub-gen-memory (with cover File + cover chapter prepended)
  → EpubDocument
```

### New Component

**`src/infrastructure/converter/cover-generator.ts`**

```
CoverGenerator
  constructor()              — reads bundled icon PNG once at construction time
  generateImage(title, author)                    → Promise<Buffer>  (JPEG)
  generateHtmlChapter(title, author, sourceUrl?)  → string           (HTML)
```

No injected dependencies. The icon asset is read synchronously via `fs.readFileSync` relative to `import.meta.url` at construction time.

### Icon Asset

**`src/infrastructure/converter/assets/cover-icon.png`**

A placeholder PNG checked into the repository. When the real paperboy icon is provided, it replaces this file — no code changes required. The placeholder is a simple SVG-rendered paperboy silhouette (~200×200 px).

## Cover Image (JPEG Thumbnail)

**Dimensions:** 600×900 px (2:3 ratio — standard EPUB cover, what Kindle expects)

**Generation:**
1. Read icon PNG → encode as base64 data URI
2. Build SVG string:
   - Background rectangle: `#1e1e2e`
   - Icon: `<image>` element, centered, upper third, 160×160 px
   - Title: `<text>` elements, centered white, ~36px — word-wrapped into lines of ≤30 chars at word boundaries, max 3 lines, truncated with `…` if longer
   - Author: `<text>`, centered, `#a0a0c0`, ~20px, below title
3. `sharp(Buffer.from(svgString)).jpeg({ quality: 90 }).toBuffer()`
4. Wrap as `new File([jpegBuffer], 'cover.jpg', { type: 'image/jpeg' })` and pass to epub-gen-memory's `options.cover`

epub-gen-memory handles all OPF manifest wiring for the cover image automatically via its `makeCover()` method.

## HTML First-Page Chapter

Inserted as the first chapter:

```typescript
{ title: '', content: htmlChapter, excludeFromToc: true, beforeToc: true }
```

**Layout** (full-page, centered column, CSS inlined):
- Background: `#1e1e2e`
- Icon: inline base64 PNG, ~120×120 px, centered near the top
- Title: large, white, centered
- Author: smaller, `#a0a0c0`, below title
- Source domain: small, `#6060a0`, bottom — only rendered when `sourceUrl` is present

**Domain extraction:**
```typescript
function extractDomain(url: string): string | undefined {
  try { return new URL(url).hostname; }
  catch { return undefined; }
}
```

Silent failure — a malformed URL simply omits the source line. The `sourceUrl` comes from `document.metadata.url` (already plumbed through the pipeline via PB-018/FR-30).

CSS is inlined in a `<style>` tag inside the chapter HTML. Kindle does not reliably load external stylesheets from chapters.

## Integration Points

### `MarkdownEpubConverter` constructor

```typescript
constructor(
  private readonly imageProcessor: ImageProcessor,
  private readonly coverGenerator: CoverGenerator,
) {}
```

### `toEpub()` additions (before epub-gen-memory call)

```typescript
const jpegBuffer = await this.coverGenerator.generateImage(title.value, author.value);
const htmlChapter = this.coverGenerator.generateHtmlChapter(
  title.value, author.value, document.metadata.url
);
const coverFile = new File([jpegBuffer], 'cover.jpg', { type: 'image/jpeg' });

// epub-gen-memory call receives:
//   options: { title, author, cover: coverFile }
//   chapters: [coverChapter, contentChapter]
```

### Composition roots

Both `src/index.ts` and `src/cli-entry.ts` gain one line each:

```typescript
const coverGenerator = new CoverGenerator();
const converter = new MarkdownEpubConverter(imageProcessor, coverGenerator);
```

## Spec Changes

- **FR-5** (currently: "EPUB output must contain title and author metadata and a single content chapter") — update to: "EPUB output must contain title and author metadata, a cover image, a cover chapter, and a content chapter"
- Add new FR for cover generation (to be numbered in sequence)

## Testing

### New: `test/infrastructure/converter/cover-generator.test.ts`
- `generateImage()` returns Buffer with JPEG magic bytes (`FF D8 FF`)
- `generateImage()` with a title longer than 30 chars produces valid JPEG without throwing
- `generateHtmlChapter()` with a URL includes the extracted hostname
- `generateHtmlChapter()` without a URL omits the source line
- `generateHtmlChapter()` with a malformed URL omits the source line (silent failure)

### Updated: `test/infrastructure/converter/markdown-epub-converter.test.ts`
- Existing tests inject a fake `CoverGenerator` returning a minimal JPEG stub and short HTML
- Add: verify `generateImage` called with correct title and author
- Add: verify `generateHtmlChapter` called with correct sourceUrl from metadata

### Fake for unit tests
```typescript
const fakeCoverGenerator = {
  generateImage: vi.fn().mockResolvedValue(Buffer.from([0xFF, 0xD8, 0xFF])),
  generateHtmlChapter: vi.fn().mockReturnValue('<div>cover</div>'),
};
```

## Open Questions (Resolved)

- **OQ-1**: HTML chapter vs. image cover → **Both**: JPEG for library thumbnail, HTML chapter for first-page
- **OQ-2**: Decorative elements beyond title/author → **Source domain** on HTML chapter only (too small for thumbnail); icon PNG; no other decorative elements
