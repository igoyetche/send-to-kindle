---
name: paperboy
description: Send markdown content to a Kindle device as an EPUB via the paperboy CLI
---

## How to Send Content to Kindle

Use the `paperboy` CLI to convert Markdown content to EPUB and deliver it to a Kindle device via email.

### Before first use

Check if paperboy is installed. If not, install it globally:

```bash
which paperboy
```

If the command is not found:

```bash
npm install -g @your-username/paperboy
```

### Send from a file

```bash
paperboy --title "Document Title" --file path/to/document.md
```

### Send generated content

Write content to a temp file first (avoids shell escaping issues):

```bash
cat <<'CONTENT' > /tmp/kindle-doc.md
# Your Title

Your markdown content here...
CONTENT
paperboy --title "Document Title" --file /tmp/kindle-doc.md
```

### Alternative: run without installing

If you prefer not to install globally, use `npx` (downloads on first use, then caches):

```bash
npx @your-username/paperboy --title "Document Title" --file path/to/document.md
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--title <title>` | Yes | Title that appears in Kindle library |
| `--file <path>` | No | Path to Markdown file (reads stdin if omitted) |
| `--author <name>` | No | Author name in EPUB metadata |
| `--device <name>` | No | Target Kindle device (uses default if omitted) |

### Prerequisites

The user must have a `.env` file with SMTP and Kindle configuration. Required variables:

```
KINDLE_DEVICES=personal:user@kindle.com
SENDER_EMAIL=sender@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sender@gmail.com
SMTP_PASS=app-password
```

Place this in the working directory as `.env` or at `~/.paperboy/.env` for global access.
