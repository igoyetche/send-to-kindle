# Paperboy — System Spec

> Last updated: 2026-04-10
> Status: Implemented (PB-018 in progress)

## 1. Problem Statement

A user working with an AI assistant (Claude) frequently generates long-form content — summaries, articles, research notes — that they want to read on their Kindle. Today, getting that content onto a Kindle requires manually copying text, formatting it, creating a file, and emailing it to their Kindle address. This multi-step process breaks the conversational flow and discourages the user from sending content to their reading device. The system should let Claude deliver content to a Kindle in a single step, transparently, as part of a normal conversation.

## 2. Goals and Non-Goals

### Goals

- G-1: A single tool invocation from an MCP client sends a document to the user's Kindle device
- G-2: The system accepts only Markdown as input content format
- G-3: The system produces well-formatted documents with correct title and author metadata visible in the Kindle library
- G-4: The system transforms the input into EPUB format
- G-5: The system is usable both from a local MCP client (same machine) and from a remote MCP client over the network
- G-6: End-to-end delivery completes without manual user intervention after the tool is invoked

### Non-Goals

- NG-1: No multi-user or multi-tenant support — this is a single-user personal tool
- NG-2: No reading or querying of Kindle library, highlights, or device state
- NG-3: No DRM, publishing workflows, or commercial distribution features
- NG-4: No support for binary input files (images, PDFs) as source content in v1
- NG-5: No delivery confirmation or read receipts — the system confirms dispatch, not device receipt

## 3. Users and Actors

| Actor | Description | Interaction |
| --- | --- | --- |
| **MCP Client (Claude)** | The AI assistant that generates content and invokes the tool on behalf of the user | Sends a tool call with title, content, and optional parameters; receives a structured success/error response |
| **End User** | The person who reads the delivered document on their Kindle | Configures the system once (credentials, Kindle address); does not interact with the system at delivery time |
| **Amazon Kindle Service** | Amazon's backend that receives emailed documents and delivers them to registered Kindle devices | Receives the formatted document via email; delivers it to the Kindle over Whispernet |
| **SMTP Provider** | The email infrastructure that relays the outbound message | Accepts the email from the system and delivers it to Amazon's mail servers |

## 4. Functional Requirements

### Content Ingestion

> Updated 2026-04-10 via feature: PB-018
> Updated 2026-04-14 via feature: PB-012

- **FR-1**: The system must resolve a document title that will appear as the document name in the Kindle library. The title is resolved in priority order: **(1) explicit caller-supplied title → (2) `title` field in YAML frontmatter (Markdown) or EPUB metadata (EPUB) → (3) filename stem** (for file-based inputs only; stdin and MCP have no filename fallback). See FR-27–FR-29 for frontmatter details.
- **FR-2**: The system must accept document content in Markdown format, or pre-built EPUB files (`.epub` extension) which bypass conversion. When YAML frontmatter is present in Markdown, it is parsed and stripped from the body before conversion (see FR-27).
- **FR-3**: The system must accept an optional author parameter (string) for document metadata. Default: `"Claude"`

### Frontmatter Metadata

> Updated 2026-04-10 via feature: PB-018

- **FR-27**: The system must parse YAML frontmatter from Markdown content. A frontmatter block is a `---`-delimited section at the start of the file (standard YAML front matter as produced by Paperclip and similar web-clipper tools). When frontmatter is present, the parsed block is stripped from the body before EPUB conversion so it does not appear in the rendered document.
- **FR-28**: The system must resolve the document title using the following priority chain per entry point:

  | Entry point | Resolution order |
  |---|---|
  | **CLI with `--file`** | explicit `--title` → frontmatter `title` → filename stem (minus `.md`) |
  | **CLI with stdin** | explicit `--title` → frontmatter `title` → **validation error** |
  | **MCP tool** | explicit `title` parameter → frontmatter `title` → **validation error** |
  | **Watcher** | frontmatter `title` → first H1 heading in body → filename stem |

- **FR-29**: If a frontmatter block exists but cannot be parsed as valid YAML, the system must return a frontmatter error rather than falling back or attempting conversion.
- **FR-30**: The `url` and `date` fields from frontmatter, when present, must be made available to the EPUB conversion pipeline as document context. They are not rendered in PB-018 (reserved for a future feature), but must not be silently dropped.

### EPUB Passthrough

> Added 2026-04-14 via feature: PB-012

- **FR-31**: When the CLI receives a `--file` argument with a `.epub` extension, the system must send the file directly to the mailer without running the Markdown-to-EPUB conversion pipeline.
- **FR-32**: When the watcher detects a `.epub` file in the watch folder, the system must send it directly to the mailer without conversion.
- **FR-33**: For EPUB passthrough, the title is resolved in priority order: **(1) explicit `--title` flag → (2) `dc:title` field from EPUB metadata (OPF package document) → (3) filename stem** (minus `.epub`). All fallbacks are silent; a malformed EPUB that lacks readable metadata uses the filename stem.
- **FR-34**: EPUB files up to 50 MB are accepted. Files exceeding 50 MB are rejected with a size error before attempting delivery.
- **FR-35**: MCP EPUB passthrough is out of scope — the MCP tool accepts Markdown text content only; binary EPUB cannot be expressed as an MCP text parameter.

### Content Conversion

> Updated 2026-04-15 via feature: PB-008

- **FR-4**: The system must convert Markdown input to a valid EPUB document
- **FR-5**: The EPUB output must be a valid EPUB 3.0 package containing title and author metadata, a cover image, a cover chapter, and a content chapter
- **FR-36**: Every EPUB produced by the system must include a cover image (JPEG, 600×900 px) embedded in the EPUB manifest for display as a library thumbnail in Kindle. The cover is generated automatically from the document title and author — no user-supplied image or configuration is required.
- **FR-37**: Every EPUB produced by the system must include a styled cover chapter as the first page of the document. The cover chapter displays: the paperboy icon, the document title, the author, and — when a `url` field is present in frontmatter — the source domain (hostname only, e.g., `theverge.com`). The source domain is not displayed on the cover image thumbnail.
- **FR-6**: The EPUB output must preserve Markdown structure (headings, lists, emphasis, code blocks, links) as semantically appropriate EPUB/XHTML markup

### Image Handling

> Updated 2026-04-08 via feature: PB-016

- **FR-18**: The system must download images referenced via `http://` or `https://` URLs in Markdown content and embed them in the generated EPUB
- **FR-19**: Image downloads must be resilient — a single failed image must not prevent the rest of the document from being converted and delivered
- **FR-20**: Images in formats not supported by Kindle (AVIF, WebP, TIFF, SVG) must be converted to JPEG before embedding in the EPUB
- **FR-21**: Format detection must use actual image bytes (magic bytes / file signature), not URL extension or HTTP Content-Type header alone
- **FR-22**: Images exceeding 5 MB individually must be skipped with a warning
- **FR-23**: If total downloaded image payload exceeds 100 MB, remaining images must be skipped and the document delivered with images already downloaded
- **FR-24**: On successful delivery of content containing images, the response must include image statistics: total found, downloaded, failed, and skipped counts
- **FR-25**: Failed image download URLs must be logged at warn level with the URL and failure reason
- **FR-26**: Image download timeout, retry count, concurrency, and size limits must be configurable via environment variables with sensible defaults

### Document Delivery

- **FR-7**: The system must deliver the generated EPUB file as an email attachment to the configured Kindle email address
- **FR-8**: The email subject line must be the document title
- **FR-9**: The attachment filename must be a URL-safe, sanitized version of the title with the `.epub` extension (e.g., `clean-architecture.epub`)
- **FR-10**: The system must use SMTP to send the email through the configured email provider

### Response

- **FR-11**: On successful delivery, the system must return a structured response containing: success indicator, a human-readable message including the document title, the file size in bytes, and image statistics when applicable
- **FR-12**: On failure, the system must return a structured response containing: failure indicator, an error category, and descriptive details

### Configuration

- **FR-13**: The system must be configurable with: Kindle delivery email address, sender email address, SMTP host/port/credentials, and a default author name. When running locally, configuration may be provided via a `.env` file in the project root; environment variables always take precedence over `.env` values
- **FR-14**: All configuration must be provided through environment variables or a configuration file — no credentials may be passed as tool parameters

### Validation

> Updated 2026-04-10 via feature: PB-018

- **FR-15**: The system must reject requests where no title can be resolved (no explicit title, no frontmatter `title`, and no filename fallback for the entry point) with a clear validation error message.
- **FR-16**: The system must reject requests missing the required `content` parameter with a clear error message
- **FR-17**: The system must reject content exceeding 25 MB with a size error before attempting delivery. The 25 MB limit applies to the **stripped body** (after frontmatter is removed), not the raw file size.

## 5. Non-Functional Requirements

- **NFR-1 — Performance**: The system must complete content conversion and dispatch the email within 30 seconds for text-only documents under 1 MB. For documents with images, conversion must complete within 90 seconds for up to 50 images assuming adequate network connectivity
- **NFR-2 — Availability**: The system should be available whenever the host machine (or host environment) is running; no independent uptime SLA is required
- **NFR-3 — Security**: SMTP credentials and the Kindle email address must never appear in tool call parameters, tool responses, or logs accessible to the MCP client
- **NFR-4 — Security**: Markdown input must be sanitized during conversion to prevent injection of scripts or malicious content in the generated EPUB
- **NFR-8 — Security**: Image downloading must not follow redirects to non-HTTP(S) protocols (e.g., `file://`, `data:`, `ftp://`) to prevent SSRF-style attacks
- **NFR-5 — Security**: Remote access to the system must be authenticated and encrypted — the MCP endpoint must not be publicly accessible without access control
- **NFR-6 — Observability**: The system must log each delivery attempt with: timestamp, document title, output format, file size, and success/failure status. Logs must not contain SMTP credentials. When using stdio transport, logs must be written to stderr — stdout is reserved exclusively for JSON-RPC messages
- **NFR-7 — Portability**: The system must be deployable on x86_64 and ARM64 architectures (to support common servers and single-board computers like Raspberry Pi)

## 6. Constraints

- **C-1**: The system must implement the Model Context Protocol (MCP) and expose its functionality as an MCP tool
- **C-2**: The system must support MCP stdio transport for local use with MCP clients like Claude Desktop and Claude Code
- **C-3**: The system must support MCP HTTP/SSE transport for remote access from MCP clients over the network
- **C-4**: Document delivery depends on Amazon's "Send to Kindle" email service — the sender email address must be pre-approved in the user's Amazon account
- **C-5**: The system relies on an external SMTP provider for email delivery; it does not implement its own mail transfer agent
- **C-6**: Amazon's service imposes format and size constraints on accepted attachments — the system must produce files in formats Amazon accepts (`.epub`)
- **C-7**: The system must run as a containerized application, packaged with all its dependencies and ready to deploy via a container runtime
- **C-8**: For local development, the system must support loading configuration from a `.env` file as a fallback. Environment variables set by the container runtime always take precedence; `.env` is never loaded in production containers where env vars are already injected

## 7. Key Scenarios

### Scenario 1: Claude sends a Markdown summary to Kindle

1. User asks Claude: "Summarize this article and send it to my Kindle"
2. Claude generates a Markdown summary
3. Claude invokes `send_to_kindle` with `title` and `content` (Markdown)
4. The system converts the Markdown to a valid EPUB document
5. The system attaches the EPUB file to an email and sends it to the configured Kindle address
6. The system returns a success response to Claude with the document title and file size
7. Claude tells the user: "I've sent 'Article Summary' to your Kindle"
8. The document appears in the user's Kindle library within minutes

### Scenario 2: SMTP authentication failure

1. Claude invokes `send_to_kindle` with valid content
2. The system converts the content successfully
3. The system attempts to send the email but SMTP authentication fails (wrong credentials)
4. The system returns a failure response with error category "SMTP authentication failed" and descriptive details
5. Claude informs the user that delivery failed and suggests checking the email configuration

### Scenario 3: Content exceeds size limit

1. Claude invokes `send_to_kindle` with an extremely large content body (over 25 MB)
2. The system validates the content size before conversion
3. The system rejects the request with a size error indicating the 25 MB limit
4. Claude informs the user and suggests splitting the content into smaller documents

### Scenario 4: Remote invocation from claude.ai

1. The user has the system running on a home server accessible over a secure network tunnel
2. The user is chatting with Claude on claude.ai, which connects to the MCP server via HTTP/SSE
3. Claude invokes `send_to_kindle` remotely
4. The system authenticates the request, processes the content, and delivers the email
5. The system returns a success response over the HTTP/SSE connection

## 8. CLI Distribution

> Updated 2026-03-31 via removal: Claude Code Skill approach dropped
> Updated 2026-04-10 via feature: PB-018

The system provides a CLI entry point (`paperboy`) as an alternative to the MCP server, enabling terminal-based usage.

### CLI Interface

```bash
paperboy [--title <title>] --file <path> [--author <name>] [--device <name>]
paperboy [--title <title>] --file <path.epub>  # sends pre-built EPUB directly
paperboy [--title <title>]                     # reads from stdin if piped
paperboy --help
paperboy --version
```

### CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--title <title>` | No | Title of the document. Overrides frontmatter title when both are present. If omitted, resolved from frontmatter or filename stem (see Title Resolution below). |
| `--file <path>` | No | Path to a Markdown (`.md`) or pre-built EPUB (`.epub`) file; reads from stdin if omitted |
| `--author <name>` | No | Author name embedded in the EPUB (default: configured value) |
| `--device <name>` | No | Target Kindle device name (default: first configured device) |
| `--help` | No | Show usage text and exit |
| `--version` | No | Show version number and exit |

### CLI Title Resolution

When `--title` is not provided, the CLI resolves the title in this order:

1. `title` field from YAML frontmatter in the document
2. Filename stem (minus `.md`) — **only when `--file` is used**
3. If no title can be resolved: exit with code 1 and a descriptive error

When stdin is used without `--file`, there is no filename fallback — frontmatter is the only source if `--title` is omitted. A document piped via stdin with no frontmatter and no `--title` is an error.

### CLI Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Document sent successfully |
| 1 | Validation error (unresolvable title, empty content, size limit, malformed frontmatter) |
| 2 | EPUB conversion error |
| 3 | Email delivery error (SMTP auth, connection, rejection) |
| 4 | Configuration error (missing or invalid environment variables) |

### CLI Configuration Resolution

The CLI loads environment variables in the following order (first match wins):

1. Shell environment variables (always take precedence)
2. `.env` file in the current working directory
3. `~/.paperboy/.env` fallback for global user configuration

`--help` and `--version` flags work without any configuration.

### Content Source Resolution

1. If `--file <path>` is provided → read from file (rejects files > 25 MB)
2. If no `--file` and stdin is piped (`!process.stdin.isTTY`) → read from stdin (30-second timeout)
3. If no `--file` and stdin is a terminal → error with guidance

### Package Distribution

```json
{
  "name": "paperboy",
  "bin": { "paperboy": "./dist/cli-entry.js" }
}
```

Install globally (`npm install -g paperboy`) or run via `npx paperboy`.

### Watch Folder

> Updated 2026-03-31 via feature: PB-009
> Updated 2026-04-10 via feature: PB-018
> Updated 2026-04-14 via feature: PB-012

The `paperboy watch` command starts a foreground watcher that monitors a configured folder for `.md` and `.epub` files, converts or passes through as appropriate, and sends each to Kindle automatically.

```bash
paperboy watch          # start the watcher
paperboy watch --help   # show watcher usage
```

**Configuration:**

```
WATCH_FOLDER=/path/to/kindle-inbox
```

Added to the existing `.env` configuration. Optional — only required when using `paperboy watch`. MCP and CLI entry points ignore it.

**Folder structure (managed by the watcher):**

```
/path/to/kindle-inbox/       # user drops .md or .epub files here
  sent/                      # auto-created, successful deliveries moved here
  error/                     # auto-created, failed deliveries + .error.txt
```

**Processing pipeline — Markdown files (`.md`):**
1. New `.md` file detected (chokidar with `awaitWriteFinish`)
2. Read file; parse and strip YAML frontmatter (if present). Malformed frontmatter → move to `error/`
3. Resolve title: frontmatter `title` → first H1 in body → filename stem
4. Create value objects, call `SendToKindleService.execute()`
5. On success: move to `sent/`
6. On transient SMTP failure: retry up to 3x with exponential backoff (2s, 4s, 8s)
7. On permanent failure or retries exhausted: move to `error/` + write `.error.txt`

**Processing pipeline — EPUB files (`.epub`):**
1. New `.epub` file detected (chokidar with `awaitWriteFinish`)
2. Read file bytes; extract title from EPUB metadata (`dc:title`). Fallback: filename stem
3. Call `SendToKindleService.sendEpub()` — no conversion step
4. On success: move to `sent/`
5. Same retry and error handling as Markdown pipeline

**Error file format** (`error/<name>.error.txt`):
```
Timestamp: 2026-03-31T14:30:00.000Z
Error: delivery
Message: SMTP connection timed out after 3 retries
```

**Startup behaviour:** Scans inbox for existing `.md` files and processes them.

**Graceful shutdown:** Listens for SIGINT/SIGTERM, waits for current file to complete.

**OS service registration (Phase 1):** Template configs in `scripts/service-templates/` with documented install one-liners per OS (Windows Task Scheduler, macOS launchd, Linux systemd).

## 9. Open Questions (Archived)

- **OQ-1**: What happens when Amazon rejects or bounces the email (e.g., sender not approved)? Bounce detection is asynchronous and may not be capturable at send time. Should the system attempt any verification, or accept "email dispatched" as success?
- **OQ-3**: For remote access (HTTP/SSE), what authentication mechanism is appropriate? Token-based, mutual TLS, or reliance on a VPN/tunnel (e.g., Tailscale)?
- **OQ-4**: Should there be a `preview_document` capability that returns the converted document content without sending it, so the user can review before delivery?
- **OQ-5**: Should the system support sending to multiple Kindle addresses (e.g., personal and family devices), or is single-device sufficient for v1?

## 10. Success Criteria

- **SC-1**: A user can ask Claude to send content to their Kindle, and the document appears in the Kindle library with the correct title and readable formatting — with no manual steps after the conversation
- **SC-2**: The tool works reliably for documents of typical length (up to ~50,000 words / ~300 KB) producing valid EPUB output
- **SC-3**: The system is operational via local stdio transport within 15 minutes of initial setup (configuration + Amazon sender approval)
- **SC-4**: The system is operational via remote HTTP/SSE transport for access from outside the local machine
- **SC-5**: Structured error responses provide enough information for Claude to give the user actionable guidance when delivery fails

## 11. Context and References

- [Amazon Send to Kindle documentation](https://www.amazon.com/sendtokindle) — supported formats, email setup, approved sender list
- [Model Context Protocol specification](https://modelcontextprotocol.io/) — MCP tool definition, stdio and HTTP/SSE transport specs
- [EPUB 3.0 specification](https://www.w3.org/TR/epub-33/) — requirements for valid EPUB packages
- Project idea document: `project_idea.md` in this repository
