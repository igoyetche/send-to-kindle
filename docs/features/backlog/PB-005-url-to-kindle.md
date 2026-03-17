# PB-005: URL to Kindle

> Status: Backlog
> Created: 2026-03-05
> Completed: —

## Problem

Users frequently want to send web articles to their Kindle for later reading. Today, Claude must fetch the URL, extract the content, summarize or reformat it, and then pass it through `send_to_kindle`. This works but loses the original article's structure, and Claude has to do unnecessary work.

## Proposed Solution

A second MCP tool, `send_url_to_kindle`, that accepts a URL, extracts the readable content, converts it to EPUB, and sends it to the Kindle — all in one step.

### New Tool: `send_url_to_kindle`

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | yes | The article URL to fetch and send |
| `title` | string | no | Override the extracted title |
| `author` | string | no | Override the extracted author |

### Pipeline

```
URL → fetch → Readability extraction → clean HTML → EPUB → email → Kindle
```

1. **Fetch** — HTTP GET with a browser-like User-Agent, follow redirects, enforce timeout (10s)
2. **Extract** — Use Mozilla's Readability algorithm (via `@mozilla/readability` + `jsdom`) to extract the article content, title, author, and byline
3. **Sanitize** — Run the extracted HTML through the existing `sanitize-html` step
4. **Convert** — Pass the sanitized HTML directly to `epub-gen-memory` (skip the Markdown parse step since content is already HTML)
5. **Send** — Reuse the existing `SmtpMailer`

### Example Usage

```
User: "Send this article to my Kindle: https://example.com/great-article"
Claude: send_url_to_kindle(url: "https://example.com/great-article")
```

```
User: "Send that article to my Kindle with a different title"
Claude: send_url_to_kindle(url: "https://...", title: "Better Title")
```

## Changes Required

### New Dependencies

- `@mozilla/readability` — Mozilla's Readability algorithm for extracting article content
- `jsdom` — DOM implementation for Readability (it needs a `document` object)

### Domain Layer

- New port: `ContentExtractor` — extracts readable content from a URL
  ```typescript
  interface ContentExtractor {
    extract(url: URL): Promise<Result<ExtractedContent, ExtractionError>>;
  }
  ```
- New value object: `ExtractedContent` — wraps extracted title, author, and HTML content
- New error type: `ExtractionError` with causes: `fetch_failed`, `not_readable`, `timeout`

### Infrastructure Layer

- New implementation: `ReadabilityExtractor` — fetches URL, parses with jsdom, extracts with Readability
- New converter path: `HtmlEpubConverter` or extend `MarkdownEpubConverter` to accept pre-parsed HTML (skipping `marked.parse()`)

### Application Layer

- New tool registration in composition root
- New handler or extend `ToolHandler` to handle both tools

## Design Considerations

- **Paywall content** — Readability extraction won't work behind paywalls. Return a clear error, not a broken EPUB.
- **Images** — Readability preserves image references. The EPUB should embed them or omit them. Start with omitting (simpler), add embedding later.
- **JavaScript-rendered pages** — jsdom doesn't execute JavaScript. SPAs and JS-rendered articles won't extract correctly. This is a known limitation; document it. A future version could use Playwright.
- **Rate limiting / robots.txt** — The tool fetches one URL per invocation. Respect rate limits; consider checking `robots.txt` as a courtesy.

## Scope

Medium effort — new dependencies, new port + implementation, new tool registration. The existing mailer and EPUB generation are fully reusable.
