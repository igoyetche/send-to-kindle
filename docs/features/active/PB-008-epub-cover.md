---
code: PB-008
title: EPUB Cover Generation
status: Active
priority: Medium
created: 2026-03-19
activated: 2026-04-15
---

# PB-008 — EPUB Cover Generation

## Motivation

Documents sent to Kindle currently have no cover page. In the Kindle library, books without a cover display a generic placeholder. Adding a generated cover improves the reading experience and makes paperboy-delivered documents visually distinguishable from one another.

## Scope

Generate a cover automatically from the document's title and author at conversion time — no user-supplied image required.

## Acceptance Criteria

- [ ] Every EPUB produced by paperboy includes a cover derived from the document title and author
- [ ] The cover is generated automatically — no new required parameters or configuration
- [ ] The cover renders correctly on Kindle devices (tested via Send to Kindle email)
- [ ] No regression in existing tests; new tests cover the cover generation path
- [ ] TypeScript compiles with zero errors in strict mode

## Out of Scope

- User-supplied cover images
- Custom fonts or branding
- Cover preview in CLI output

## Open Questions (Resolved)

- **OQ-1**: HTML cover chapter vs. image cover → **Both**: JPEG thumbnail for Kindle library, styled HTML chapter for first page
- **OQ-2**: Decorative elements → source domain (HTML chapter only), paperboy icon PNG (placeholder until real icon provided)
