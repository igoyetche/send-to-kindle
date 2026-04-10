# PB-018: Markdown Frontmatter Metadata

**Status:** Active — Design
**Date:** 2026-04-10
**Design Started:** 2026-04-10
**Branch:** `pb-018-markdown-frontmatter-metadata`

## Motivation

Markdown files produced by Paperclip (and similar web-clipper tools) ship with metadata in the file itself — `title`, `url`, and `date`. Today Paperboy ignores this metadata and forces the user to supply `--title` on every CLI invocation and `title` on every MCP call, even though the information is already sitting in the file.

This hurts two workflows in particular:

- **Watcher folder:** when Paperclip drops a file into the watch folder, Paperboy currently has to invent a title from the filename because no CLI arg exists. Filenames are usually slugified and ugly, so the Kindle library ends up with titles like `how-react-18-breaks-your-useeffect` instead of `How React 18 Breaks Your useEffect`.
- **Manual CLI/MCP:** the user has to re-type (or copy) a title that already exists in the file.

Using the metadata from the file itself removes the friction and lets the Kindle library show clean, human-readable titles automatically.

## Scope

- Read metadata (`title`, `url`, `date`) from Markdown files that carry it.
- Make `title` optional in both the CLI and the MCP tool.
- When `title` is not explicitly provided, resolve it from metadata; fall back to the filename only if metadata is absent.
- An explicit title (CLI arg or MCP parameter) always wins over metadata — it is an override, not a default.

## Acceptance Criteria

- [ ] Markdown files with metadata (`title`, `url`, `date`) are parsed and the metadata is made available to the conversion pipeline
- [ ] CLI `--title` is optional. When omitted with a `--file` input, title resolves in this order: **(1) explicit arg → (2) metadata `title` → (3) filename stem**
- [ ] CLI `--title` is optional. When omitted with **stdin** input, title resolves in this order: **(1) explicit arg → (2) metadata `title` → (3) hard error** (no filename to fall back to)
- [ ] MCP tool `title` parameter is optional. Title resolves in this order: **(1) explicit parameter → (2) metadata `title` → (3) hard error** (MCP has no filename to fall back to)
- [ ] An explicit title always overrides the metadata title, even if metadata is present
- [ ] Markdown files without metadata continue to work unchanged — existing behavior is preserved
- [ ] Metadata block is stripped from the rendered EPUB content (the reader should not see the raw metadata block)
- [ ] Watcher-folder runs automatically pick up metadata titles without any CLI changes from the user
- [ ] When no title is resolvable anywhere, a clear validation error surfaces (CLI exit code, MCP error response)
- [ ] No regression in existing tests; new tests cover metadata parsing and each branch of title resolution
- [ ] TypeScript compiles with zero errors in strict mode

## Out of Scope

- Custom or extensible metadata schemas — only `title`, `url`, `date` are read in this feature
- Rendering `url` and `date` in the reader experience — this feature only makes them available in the conversion context; they will be consumed by a later feature (book cover)
- Writing/generating metadata on output
- Backfilling metadata into files that don't have it
- Metadata formats other than YAML frontmatter (TOML, JSON header, HTML comment) — only YAML frontmatter is supported

## Resolved Decisions

- **Metadata format:** Only YAML frontmatter (`---` fenced block at the top of the file) is supported. Matches what Paperclip emits. Other formats are explicitly out of scope.
- **`url` and `date` handling:** Parsed and carried through the conversion pipeline as part of the document context, so a later feature (cover generation) can render them. This feature does **not** render them anywhere itself — it only makes them available.
- **Filename fallback cleanup:** None. Use the raw filename stem as-is (no unslugification, no title-casing).
- **Malformed frontmatter:** Hard error. If a file has a frontmatter block that fails to parse, surface a clear validation error — do not silently fall back.
- **Stdin input in CLI:** Hard error. When content is piped via stdin, if the content carries no frontmatter and no `--title` is provided, exit with a clear validation error. No synthetic titles, no filename fallback (there is no filename). Metadata-only stdin (frontmatter present, no `--title`) is still supported — title resolves from metadata.

## Open Questions

_None — all decisions resolved, ready for design phase._
