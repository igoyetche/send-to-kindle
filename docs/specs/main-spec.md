# Paperboy — System Spec

> Last updated: 2026-03-17
> Status: Implemented

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

- **FR-1**: The system must accept a document title (string, required) that will appear as the document name in the Kindle library
- **FR-2**: The system must accept document content (string, required) in Markdown format
- **FR-3**: The system must accept an optional author parameter (string) for document metadata. Default: `"Claude"`

### Content Conversion

- **FR-4**: The system must convert Markdown input to a valid EPUB document
- **FR-5**: The EPUB output must be a valid EPUB 3.0 package containing title and author metadata and a single content chapter
- **FR-6**: The EPUB output must preserve Markdown structure (headings, lists, emphasis, code blocks, links) as semantically appropriate EPUB/XHTML markup

### Document Delivery

- **FR-7**: The system must deliver the generated EPUB file as an email attachment to the configured Kindle email address
- **FR-8**: The email subject line must be the document title
- **FR-9**: The attachment filename must be a URL-safe, sanitized version of the title with the `.epub` extension (e.g., `clean-architecture.epub`)
- **FR-10**: The system must use SMTP to send the email through the configured email provider

### Response

- **FR-11**: On successful delivery, the system must return a structured response containing: success indicator, a human-readable message including the document title, and the file size in bytes
- **FR-12**: On failure, the system must return a structured response containing: failure indicator, an error category, and descriptive details

### Configuration

- **FR-13**: The system must be configurable with: Kindle delivery email address, sender email address, SMTP host/port/credentials, and a default author name. When running locally, configuration may be provided via a `.env` file in the project root; environment variables always take precedence over `.env` values
- **FR-14**: All configuration must be provided through environment variables or a configuration file — no credentials may be passed as tool parameters

### Validation

- **FR-15**: The system must reject requests missing the required `title` parameter with a clear error message
- **FR-16**: The system must reject requests missing the required `content` parameter with a clear error message
- **FR-17**: The system must reject content exceeding 25 MB with a size error before attempting delivery

## 5. Non-Functional Requirements

- **NFR-1 — Performance**: The system must complete content conversion and dispatch the email within 30 seconds for documents under 1 MB
- **NFR-2 — Availability**: The system should be available whenever the host machine (or host environment) is running; no independent uptime SLA is required
- **NFR-3 — Security**: SMTP credentials and the Kindle email address must never appear in tool call parameters, tool responses, or logs accessible to the MCP client
- **NFR-4 — Security**: Markdown input must be sanitized during conversion to prevent injection of scripts or malicious content in the generated EPUB
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

> Updated 2026-03-17 via feature: CLI Version + Claude Code Skill

The system provides a CLI entry point (`paperboy`) as an alternative to the MCP server, enabling terminal-based usage and Claude Code skill invocation.

### CLI Interface

```bash
paperboy --title <title> [--file <path>] [--author <name>] [--device <name>]
paperboy --help
paperboy --version
echo "# Content" | paperboy --title <title>
```

### CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--title <title>` | Yes | Title of the document sent to Kindle |
| `--file <path>` | No | Path to a Markdown file; reads from stdin if omitted |
| `--author <name>` | No | Author name embedded in the EPUB (default: configured value) |
| `--device <name>` | No | Target Kindle device name (default: first configured device) |
| `--help` | No | Show usage text and exit |
| `--version` | No | Show version number and exit |

### CLI Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Document sent successfully |
| 1 | Validation error (missing title, empty content, size limit) |
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

### Claude Code Skill

A skill file at `examples/claude-skill/SKILL.md` teaches Claude Code how to invoke the CLI for send-to-Kindle workflows. The skill documents only implemented flags and capabilities.

### Package Distribution

```json
{
  "name": "paperboy",
  "bin": { "paperboy": "./dist/cli-entry.js" }
}
```

Install globally (`npm install -g paperboy`) or run via `npx paperboy`.

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
