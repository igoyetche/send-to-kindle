# PB-018: Markdown Frontmatter Metadata — Design

**Status:** ✅ Design Approved — Ready for Spec Update + Plan
**Date:** 2026-04-10
**Approved:** 2026-04-10
**Feature:** docs/features/active/PB-018-markdown-frontmatter-metadata.md
**Branch:** `pb-018-markdown-frontmatter-metadata`

---

## Summary

Teach Paperboy to read YAML frontmatter (`title`, `url`, `date`) from Markdown files, make `title` optional across CLI / MCP / watcher, and carry `url` and `date` through the conversion pipeline as document context for a future feature (cover generation — likely PB-008).

The change is primarily a **domain-layer** addition (a new `DocumentMetadata` value object + a title-resolution helper) plus **adapter-layer** refactors in the three entry points (`cli.ts`, `tool-handler.ts`, `watcher.ts`) so each source funnels through the same resolution chain.

---

## Current State

### Title handling today — three different stories

| Entry point | Title today | Fallback chain |
|---|---|---|
| **CLI** (`src/application/cli.ts`) | `--title` is **required** (parse error if missing) | None — hard error |
| **MCP** (`src/application/tool-handler.ts`) | `title` parameter **required** by handler shape | None — hard error |
| **Watcher** (`src/application/watcher.ts`) | Not required — extracted via `extractTitle()` | First H1 in content → filename stem (minus `.md`) |

The watcher's title extraction lives in `src/domain/title-extractor.ts` and is only ~20 lines:

```typescript
export function extractTitle(content: string, filename: string): Result<Title, ValidationError> {
  const h1Match = /^#\s+(.+)$/m.exec(content);
  if (h1Match?.[1] !== undefined) return Title.create(h1Match[1]);
  const fallback = filename.replace(/\.md$/i, "");
  return Title.create(fallback);
}
```

### Content flow today

```
raw string (infra reads file/stdin)
    → MarkdownContent.create(raw)     [domain value, just a string wrapper with size guard]
    → service.execute(title, content, author, device)
    → converter.toEpub(title, content, author)
    → mailer.send(document, device)
```

`MarkdownContent` is a simple wrapper — no parsing, no metadata, no structure. The converter gets the full raw string (including any frontmatter) and passes it to `marked.parse()`. **Today, frontmatter would render into the EPUB as visible text** (a `---` separator followed by `title: ...` lines), which is exactly the behavior PB-018 must fix.

### What needs to change

1. Frontmatter must be **parsed** out of the raw content before conversion.
2. `title` must become **optional** in CLI args and MCP input.
3. A **single, consistent** title-resolution chain must exist so the three entry points behave predictably.
4. `url` and `date` must survive into the conversion stage (not used yet, but reachable).
5. Malformed frontmatter must be a **hard error** (per feature decision).
6. Existing files without frontmatter must keep working unchanged.

---

## Proposed Architecture

### New domain value object — `DocumentMetadata`

Represents the parsed, validated frontmatter block. All fields are optional because frontmatter may be absent or partial.

```typescript
// src/domain/values/document-metadata.ts
export class DocumentMetadata {
  private constructor(
    readonly title: string | undefined,
    readonly url: string | undefined,
    readonly date: string | undefined,
  ) {}

  static empty(): DocumentMetadata {
    return new DocumentMetadata(undefined, undefined, undefined);
  }

  /**
   * Builds a DocumentMetadata from a parsed frontmatter object.
   * Permissive: unknown fields are ignored; non-string values are dropped.
   * Empty/whitespace strings are normalized to undefined.
   */
  static fromRecord(raw: Record<string, unknown>): DocumentMetadata {
    return new DocumentMetadata(
      normalizeString(raw["title"]),
      normalizeString(raw["url"]),
      normalizeString(raw["date"]),
    );
  }

  get isEmpty(): boolean {
    return this.title === undefined && this.url === undefined && this.date === undefined;
  }
}
```

**Why a value object and not a plain interface?** So future invariants (e.g. "date must parse as ISO 8601") have a home; so construction is the single place rules are enforced; consistent with the rest of the domain style (`Title`, `Author`, `MarkdownContent`).

### New domain value object — `MarkdownDocument`

Wraps the parsed content *and* the parsed metadata. This is what gets passed to the service instead of a raw `MarkdownContent`.

```typescript
// src/domain/values/markdown-document.ts
export class MarkdownDocument {
  private constructor(
    readonly content: MarkdownContent,       // body without frontmatter
    readonly metadata: DocumentMetadata,      // parsed frontmatter (may be empty)
  ) {}

  static fromParts(
    content: MarkdownContent,
    metadata: DocumentMetadata,
  ): MarkdownDocument {
    return new MarkdownDocument(content, metadata);
  }
}
```

Note: construction is intentionally dumb. The actual parsing lives in a port (see below) so the domain stays free of YAML library dependencies.

### New port — `FrontmatterParser`

Parsing YAML is an infrastructure concern (it depends on a library). Following the existing pattern of ports (`ContentConverter`, `DocumentMailer`), we add one more:

```typescript
// src/domain/ports.ts — add
export interface FrontmatterParser {
  /**
   * Splits a raw markdown string into its frontmatter block and body content.
   * - No frontmatter → ok({ metadata: empty, body: raw })
   * - Well-formed frontmatter → ok({ metadata: parsed, body: content after the closing '---' })
   * - Malformed frontmatter (e.g. unclosed block, invalid YAML) → err(FrontmatterError)
   */
  parse(raw: string): Result<{ metadata: DocumentMetadata; body: string }, FrontmatterError>;
}
```

And a new error type in `src/domain/errors.ts`:

```typescript
export class FrontmatterError {
  readonly kind = "frontmatter" as const;
  constructor(readonly message: string) {}
}

export type DomainError =
  | ValidationError
  | SizeLimitError
  | ConversionError
  | DeliveryError
  | FrontmatterError;   // NEW
```

`FrontmatterError` maps to CLI exit code **1** (same category as validation) and MCP error code `FRONTMATTER_ERROR`.

### New infrastructure — `GrayMatterFrontmatterParser`

Implements the port using a YAML library.

```typescript
// src/infrastructure/frontmatter/gray-matter-parser.ts
export class GrayMatterFrontmatterParser implements FrontmatterParser {
  parse(raw: string): Result<{ metadata: DocumentMetadata; body: string }, FrontmatterError> {
    try {
      const parsed = matter(raw);  // gray-matter
      const metadata = DocumentMetadata.fromRecord(parsed.data);
      return ok({ metadata, body: parsed.content });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Malformed frontmatter";
      return err(new FrontmatterError(message));
    }
  }
}
```

**Library choice:** `gray-matter`. See [Open Design Questions — DQ-1](#dq-1-yaml-library-choice).

### New domain helper — `resolveTitle`

Single canonical title-resolution function. Each adapter feeds its candidates in order and gets back a `Title` or a validation error.

```typescript
// src/domain/title-resolver.ts
/**
 * Resolves a Title by trying candidates in order until one produces a valid Title.
 * First candidate wins. Empty/whitespace candidates are skipped.
 * Returns a ValidationError if no candidate yields a valid title.
 */
export function resolveTitle(
  candidates: ReadonlyArray<string | undefined>,
): Result<Title, ValidationError> {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const result = Title.create(trimmed);
    if (result.ok) return result;
  }
  return err(new ValidationError("title", "No title could be resolved from the provided sources."));
}
```

Each adapter builds its own candidate list; the order encodes the precedence rule.

| Adapter | Candidate order |
|---|---|
| **CLI (file)** | `[args.title, metadata.title, filenameStem]` |
| **CLI (stdin)** | `[args.title, metadata.title]` — **no filename fallback** |
| **MCP** | `[args.title, metadata.title]` — **no filename fallback** |
| **Watcher** | `[metadata.title, h1FromBody, filenameStem]` |

Note the watcher keeps its H1 fallback (between metadata and filename). See [DQ-3](#dq-3-watcher-h1-fallback-keep-drop-or-demote).

### Service signature change

`SendToKindleService.execute` currently takes `(title, content, author, device)`. Two options:

**A. Keep `title` as a separate parameter** and pass the metadata alongside:
```typescript
execute(title: Title, document: MarkdownDocument, author: Author, device: KindleDevice)
```
Adapters resolve the title themselves (via `resolveTitle`) and pass it in. Metadata still reaches the service via `document.metadata` for the future cover feature.

**B. Inline resolution in the service**:
```typescript
execute(document: MarkdownDocument, explicitTitle: string | undefined, filenameFallback: string | undefined, author, device)
```
Service calls `resolveTitle` internally.

**Recommendation: Option A.** The title-resolution chain varies per adapter (stdin vs file vs watcher vs MCP), so the adapter is the right place to build it. The service stays focused on orchestration: "I get a resolved title and a document, I convert then deliver." This also keeps the `DeliverySuccess.title` return path simple — the service already knows the title.

Final signature:
```typescript
execute(
  title: Title,
  document: MarkdownDocument,
  author: Author,
  device: KindleDevice,
): Promise<Result<DeliverySuccess, DomainError>>
```

### Converter signature change

`ContentConverter.toEpub` currently takes `(title, content, author)`. It needs the metadata too (so a future cover generator can read `url` / `date`):

```typescript
// Before
toEpub(title: Title, content: MarkdownContent, author: Author): Promise<Result<EpubDocument, ConversionError>>

// After
toEpub(title: Title, document: MarkdownDocument, author: Author): Promise<Result<EpubDocument, ConversionError>>
```

For PB-018 itself, `MarkdownEpubConverter` simply pulls `document.content` and passes it through the existing `marked.parse()` pipeline. The metadata is ignored by the converter for now — but it's *there*, and the next feature (PB-008 cover) can consume it without another port change.

### Adapter changes

**CLI (`src/application/cli.ts`):**
- `parseArgs`: remove "title is required" error; title becomes `string | undefined`
- `run`:
  1. Read raw content (file or stdin)
  2. Call `frontmatterParser.parse(raw)` → `{ metadata, body }` (or `FrontmatterError`)
  3. `MarkdownContent.create(body)` → validates size on the stripped body
  4. Build title candidates based on source (file vs stdin)
  5. `resolveTitle(candidates)` → `Title` or validation error
  6. Build `MarkdownDocument.fromParts(content, metadata)`
  7. Call `service.execute(title, document, author, device)`
- `CliDeps` gains `frontmatterParser: FrontmatterParser`
- Help text updated: `--title` listed as optional, docs describe fallback chain
- New parse error message when no title can be resolved: *"No title provided. Pass --title, add a `title:` frontmatter entry, or (with --file) the filename is used."*

**MCP (`src/application/tool-handler.ts`):**
- Tool schema: `title` becomes optional
- `handle`:
  1. Parse frontmatter from `args.content`
  2. Resolve title from `[args.title, metadata.title]`
  3. Validate stripped body
  4. Call service
- Tool description updated to advertise: *"If `title` is omitted, it is read from the document's frontmatter `title` field."*

**Watcher (`src/application/watcher.ts`):**
- `processFile`:
  1. Read file (existing)
  2. Parse frontmatter (new)
  3. Resolve title from `[metadata.title, h1FromBody, filenameStem]` (reusing or replacing `extractTitle`)
  4. Validate stripped body
  5. Call service
- `title-extractor.ts` is either updated to accept `metadata` as an extra input, or **deleted** and replaced by inline candidate-list building in `watcher.ts`. See [DQ-4](#dq-4-fate-of-title-extractorts).

### Composition roots

Each entry point (`src/index.ts`, `src/cli-entry.ts`, `src/watch-entry.ts`) instantiates `GrayMatterFrontmatterParser` once and injects it into the adapter:

```typescript
const frontmatterParser = new GrayMatterFrontmatterParser();
// ...
const handler = new ToolHandler(service, config.defaultAuthor, devices, frontmatterParser);
```

---

## Content Flow After PB-018

```
raw string (infra reads file/stdin/mcp arg)
    │
    ▼
frontmatterParser.parse(raw)
    ├─ err(FrontmatterError)   → surface to user, exit
    └─ ok({ metadata, body })
        │
        ▼
MarkdownContent.create(body)              [size check on stripped body]
    │
    ▼
resolveTitle([explicit, metadata.title, fallback])
    │
    ▼
MarkdownDocument.fromParts(content, metadata)
    │
    ▼
service.execute(title, document, author, device)
    │
    ▼
converter.toEpub(title, document, author)  [reads document.content; ignores metadata for now]
```

---

## Affected Specs

- **`docs/specs/main-spec.md`** — update the CLI, MCP, and watcher sections:
  - Title is no longer universally required; document the three resolution chains
  - Add a new functional requirement for frontmatter parsing (FR-018 or similar)
  - Add a new error category (`frontmatter`) to the error table
  - Update size limit wording: the 25 MB limit applies to the **stripped body**, not the raw file (so a large frontmatter block doesn't eat into the content budget — though realistically frontmatter is tiny)

No other specs are affected. CHANGELOG entry will be added at spec-update time per the workflow rules.

---

## Testing Strategy

Five layers of tests mirror the existing structure:

### Unit — Domain

- **`DocumentMetadata`** — `empty()`, `fromRecord()` with all combinations of present/missing/non-string fields, `isEmpty` semantics
- **`MarkdownDocument`** — construction from parts
- **`resolveTitle`** — empty list, all-undefined list, first-wins, whitespace skipping, all-empty error
- **`FrontmatterParser` port** — no-frontmatter pass-through, well-formed → metadata + body, malformed → error (using a fake implementation to keep domain tests library-free)

### Unit — Infrastructure

- **`GrayMatterFrontmatterParser`** — real gray-matter with:
  - Plain markdown (no frontmatter) → empty metadata, body === raw
  - Full frontmatter (title/url/date) → all three parsed, body stripped
  - Partial frontmatter (only title) → title set, others undefined
  - Empty frontmatter (`---\n---`) → empty metadata, body preserved
  - Extra fields (tags, description) → ignored, no error
  - Malformed YAML → `FrontmatterError`
  - Non-string values (e.g. `title: 123`) → coerced to undefined, no error

### Unit — Application adapters

- **`cli.ts`**:
  - `parseArgs` accepts missing `--title` without erroring
  - `run` with `--file` and frontmatter → title from metadata
  - `run` with `--file` and no frontmatter → title from filename stem
  - `run` with `--file` and `--title` override → explicit wins over metadata
  - `run` with stdin + frontmatter → metadata wins
  - `run` with stdin + no frontmatter + no `--title` → validation error, exit 1
  - `run` with malformed frontmatter → `FrontmatterError`, exit 1
  - Help text mentions optional title
- **`tool-handler.ts`**:
  - `title` omitted + metadata present → metadata title
  - `title` provided + metadata present → explicit wins
  - `title` omitted + no metadata → validation error
  - Malformed frontmatter → `FRONTMATTER_ERROR` response
- **`watcher.ts`**:
  - File with frontmatter → metadata title used
  - File with only H1 (no frontmatter) → H1 used (regression)
  - File with neither → filename stem used (regression)
  - File with frontmatter AND H1 → metadata wins (precedence)
  - File moved to `error/` with `frontmatter` kind on malformed frontmatter

### Integration

- CLI binary with a real frontmatter file (via tmp dir) → success, correct exit code
- Watcher (if already covered by existing integration tests) → regression pass

### Regression

- Every existing test that passed a no-frontmatter markdown string should continue to pass unchanged

---

## Implementation Phases

Rough ordering for the plan (to be broken into tasks in the PLAN phase):

1. **Domain scaffolding** — `DocumentMetadata`, `MarkdownDocument`, `FrontmatterError`, `FrontmatterParser` port, `resolveTitle` helper + tests
2. **Infrastructure parser** — `GrayMatterFrontmatterParser` + tests + `gray-matter` dependency
3. **Service signature migration** — update `SendToKindleService.execute` and `ContentConverter.toEpub` + update `MarkdownEpubConverter` + fix all callers/tests
4. **CLI adapter** — relax `parseArgs`, thread through parser, build candidate list, update help text + tests
5. **MCP adapter** — update tool schema, thread through parser + tests
6. **Watcher adapter** — thread through parser, fold frontmatter into existing chain + tests (decide DQ-4 first)
7. **Composition roots** — wire `GrayMatterFrontmatterParser` in `index.ts`, `cli-entry.ts`, `watch-entry.ts`
8. **Spec update** — update `main-spec.md`, CHANGELOG entry
9. **End-to-end validation** — manual run with a real Paperclip file; verify frontmatter is stripped from the EPUB output

---

## Resolved Design Decisions

All open design questions have been answered (2026-04-10). Details preserved below for traceability.

### DD-1 — YAML library choice ✅ `gray-matter`

Chosen over a raw `yaml` parser or a custom minimal parser. Rationale: purpose-built for markdown frontmatter, handles `---` fence detection, and sits in the same weight class as other project dependencies (`marked`, `sanitize-html`). No homegrown YAML.

Dependency added in this feature: `gray-matter` (runtime).

### DD-2 — Domain shape ✅ `MarkdownDocument` wrapper

New domain value object `MarkdownDocument` wraps `MarkdownContent` (body) + `DocumentMetadata` (parsed frontmatter). `MarkdownContent` keeps its single responsibility (validated-body string with size guard). The wrapper is what flows through the service and converter.

### DD-3 — Watcher H1 fallback ✅ Option A — Keep, between metadata and filename

Watcher candidate order: **`metadata.title → first H1 in body → filename stem`**. Existing watcher files without frontmatter continue to behave exactly like today — no regression. Frontmatter-bearing files get the metadata title.

### DD-4 — Fate of `title-extractor.ts` ✅ Option A — Delete and replace

`src/domain/title-extractor.ts` is deleted. The canonical resolver is `resolveTitle(candidates)`. The one piece of unique logic (H1 scanning via regex) becomes a small helper — `src/domain/find-first-h1.ts` — that returns `string | undefined`. The watcher builds its own candidate list inline.

### DD-5 — Where parsing runs ✅ Adapter layer

Each adapter (`cli.ts`, `tool-handler.ts`, `watcher.ts`) calls `frontmatterParser.parse()` directly, symmetric with how each adapter already calls `Title.create` / `MarkdownContent.create`. The service signature stays domain-typed; it receives a `MarkdownDocument` and a resolved `Title`.

### DD-6 — Error exit code ✅ CLI exit 1, MCP `FRONTMATTER_ERROR`

`FrontmatterError.kind = "frontmatter"` maps to:
- CLI exit code **1** (same bucket as validation / size_limit — input problem)
- MCP error code `FRONTMATTER_ERROR`
- `mapErrorToExitCode` in `cli.ts` gains a new case; `mapErrorToResponse` in `tool-handler.ts` gains a new case. Both are exhaustive switches so the compiler flags any missed paths.

---

## Non-Goals / Explicit Deferrals

- **Rendering `url` / `date`** — this design carries them through to the converter but the converter still ignores them. Rendering is PB-008's job.
- **Extensible metadata schema** — only `title`, `url`, `date` are recognized; extra keys are silently dropped.
- **Non-YAML frontmatter** — no TOML, JSON, HTML-comment variants.
- **Synthetic titles for stdin** — hard error as per feature decision.
- **Writing frontmatter on output** — not in scope.

---

## Summary of Decisions

| # | Decision | Resolution |
|---|---|---|
| DD-1 | YAML library | ✅ `gray-matter` |
| DD-2 | Domain shape | ✅ New `MarkdownDocument` wrapper |
| DD-3 | Watcher H1 fallback | ✅ Keep, slot between metadata and filename |
| DD-4 | `title-extractor.ts` | ✅ Delete; replace with `resolveTitle` + small `findFirstH1` helper |
| DD-5 | Where parsing runs | ✅ Adapter layer (CLI/MCP/watcher each call the parser) |
| DD-6 | Error exit code | ✅ `frontmatter` → CLI exit 1, MCP `FRONTMATTER_ERROR` |

All decisions locked in. Next step in the workflow pipeline: **SPEC update** (update `main-spec.md`, add CHANGELOG entry) → then **PLAN** (task breakdown).
