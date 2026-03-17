# PB-004: CLI Version + Claude Code Skill

> Status: Done
> Created: 2026-03-05
> Completed: 2026-03-17

## Problem

The MCP server requires a running process and an MCP-compatible client. Users who work in the terminal or through Claude Code have a simpler path available — a CLI tool that can be invoked directly via shell commands.

## Proposed Solution

Repackage the existing domain and infrastructure layers as a standalone CLI tool, published to npm. Then provide a Claude Code skill that teaches Claude how to invoke it.

### Two Distribution Paths from One Core

```
src/
  domain/          ← shared (values, service, ports, errors)
  infrastructure/  ← shared (converter, mailer, config, logger)
  application/
    tool-handler.ts    ← MCP adapter (existing)
    cli.ts             ← CLI adapter (new)
  index.ts             ← MCP composition root (existing)
  cli-entry.ts         ← CLI composition root (new)
```

The domain and infrastructure layers are already transport-agnostic. The CLI is a thin shell that parses arguments, constructs the same object graph, and calls `SendToKindleService.execute()`.

### CLI Interface

```bash
# Send markdown content from a file
send-to-kindle --title "Article Summary" --file summary.md

# Send markdown content from stdin (piped from Claude or another tool)
echo "# Hello" | send-to-kindle --title "Quick Note"

# Send with custom author
send-to-kindle --title "Research Notes" --file notes.md --author "Research Team"

# Send a URL (requires url-to-kindle feature)
send-to-kindle --url https://example.com/article

# Send to a specific device (requires multiple-kindle-addresses feature)
send-to-kindle --title "Article" --file article.md --device partner
```

### npm Package

```json
{
  "name": "send-to-kindle-cli",
  "bin": {
    "send-to-kindle": "./dist/cli-entry.js"
  }
}
```

Install and use globally:

```bash
npm install -g send-to-kindle-cli
send-to-kindle --title "Test" --file test.md
```

Or via npx (no install):

```bash
npx send-to-kindle-cli --title "Test" --file test.md
```

### Configuration

The CLI reads from `.env` in the current directory (via dotenv, already implemented) or from environment variables. Same config as the MCP server — no new configuration format.

For convenience, add a `--setup` command that creates a `.env` file interactively:

```bash
send-to-kindle --setup
# Prompts for KINDLE_EMAIL, SMTP credentials, etc.
# Writes to ~/.send-to-kindle/.env
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Document sent successfully |
| 1 | Validation error (missing title, empty content, size limit) |
| 2 | Conversion error (EPUB generation failed) |
| 3 | Delivery error (SMTP auth, connection, rejection) |
| 4 | Configuration error (missing env vars) |

## Claude Code Skill

A skill file (`.claude/skills/send-to-kindle.md`) that teaches Claude Code how to use the CLI:

```markdown
---
name: send-to-kindle
description: Send content to a Kindle device as an EPUB
triggers:
  - send to kindle
  - send this to my kindle
  - kindle
---

## How to Send Content to Kindle

Use the `send-to-kindle` CLI tool to convert content and send it.

### Send markdown content

Write the content to a temporary file, then send it:

\`\`\`bash
cat <<'CONTENT' > /tmp/kindle-doc.md
[markdown content here]
CONTENT
npx send-to-kindle-cli --title "Document Title" --file /tmp/kindle-doc.md
\`\`\`

### Send a URL

\`\`\`bash
npx send-to-kindle-cli --url "https://example.com/article"
\`\`\`

### Prerequisites

The user must have a `.env` file with SMTP and Kindle configuration,
or run `npx send-to-kindle-cli --setup` to create one.
```

This skill turns any Claude Code session into a "send to Kindle" capable environment — no MCP server, no background process, just a single CLI call.

## Changes Required

### New Files

- `src/application/cli.ts` — argument parser and CLI adapter
- `src/cli-entry.ts` — CLI composition root
- `skills/send-to-kindle.md` — Claude Code skill file

### Argument Parsing

Use a lightweight argument parser. Options:
- `commander` — most popular, full featured
- `citty` — minimal, modern ESM, zero deps
- Manual `process.argv` parsing — simplest, no dependency, sufficient for ~5 flags

Recommendation: start with manual `process.argv` parsing. The CLI has few flags and doesn't need subcommands.

### package.json Changes

- Add `"bin"` field pointing to CLI entry
- Add a `"send-to-kindle"` script for local dev
- Consider separate `"files"` list to keep the npm package minimal

### Testing

- Test the CLI adapter the same way as the tool handler — mock the service, verify argument parsing and error mapping
- Add an integration test that runs the CLI binary end-to-end with a mocked SMTP server

## Design Considerations

- **Shared config path** — both MCP and CLI should look for `.env` in the same location. Consider `~/.send-to-kindle/.env` as a global config alongside project-local `.env`.
- **stdin support** — essential for piping. Detect stdin with `!process.stdin.isTTY` and read content from it when `--file` is not provided.
- **Progress output** — the CLI should print progress to stderr (not stdout, in case output is piped). Use the same stderr convention as the logger.
- **Monorepo vs single package** — start as a single package with two entry points (`index.ts` for MCP, `cli-entry.ts` for CLI). Split into a monorepo only if the packages diverge significantly.

## Scope

Medium effort — new entry point, argument parser, skill file. The core pipeline (convert + send) is already built and tested. The main work is the CLI shell and the npm publishing setup.
