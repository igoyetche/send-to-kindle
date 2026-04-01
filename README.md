# Paperboy

Send Markdown content to your Kindle as an EPUB — from the terminal, from Claude Code, or from any MCP client.

## How It Works

1. You provide Markdown content (a file, stdin, or via Claude)
2. Paperboy converts it to EPUB
3. The EPUB is emailed to your Kindle address
4. The document appears in your Kindle library

## Three Ways to Use It

### CLI

```bash
# From a file
paperboy --title "My Article" --file article.md

# From stdin
cat article.md | paperboy --title "My Article"

# With options
paperboy --title "Notes" --file notes.md --author "Alice" --device "Alice's Kindle"
```

### Folder Watcher

Drop `.md` files into a watched folder — Paperboy converts and sends them automatically.

```bash
paperboy watch
```

### MCP Server

Connect Claude Desktop or any MCP client to the server. Claude can then send content to your Kindle in a single tool call during conversation.

## Prerequisites

- **Node.js 22** or later
- An **SMTP account** — any provider works; Gmail is the easiest option, see [Gmail setup](#gmail-setup) below
- Your **Kindle email address** (found in Amazon account settings under "Send to Kindle")
- The SMTP sender address must be in your [Amazon approved senders list](https://www.amazon.com/sendtokindle)

## Setup

```bash
git clone <repo-url>
cd send-to-kindle
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

> The `.env` file loads automatically when running locally. In Docker, set environment variables directly — they take precedence over `.env`.

### Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `KINDLE_DEVICES` | Named device(s) in `name:email` format | `personal:your-kindle@kindle.com` |
| `SENDER_EMAIL` | Email that sends the EPUB | `you@gmail.com` |
| `SMTP_HOST` | SMTP server hostname | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_USER` | SMTP login username | `you@gmail.com` |
| `SMTP_PASS` | SMTP app password | `abcd-efgh-ijkl-mnop` |

Multiple devices: `KINDLE_DEVICES=personal:you@kindle.com,partner:them@kindle.com`

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_AUTHOR` | `Claude` | Author name when none is specified |
| `WATCH_FOLDER` | — | Path to folder for the `paperboy watch` command (auto-sends files) |
| `MCP_HTTP_PORT` | — | Enables HTTP/SSE transport on this port |
| `MCP_AUTH_TOKEN` | — | Required when `MCP_HTTP_PORT` is set |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |

## CLI Usage

### Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--title <title>` | Yes | Title of the document sent to Kindle |
| `--file <path>` | No | Path to a Markdown file; reads from stdin if omitted |
| `--author <name>` | No | Author name embedded in the EPUB (default: configured value) |
| `--device <name>` | No | Target Kindle device name (default: first configured device) |
| `--help` | No | Show usage text and exit |
| `--version` | No | Show version number and exit |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Document sent successfully |
| 1 | Validation error (missing title, empty content, size limit) |
| 2 | EPUB conversion error |
| 3 | Email delivery error (SMTP auth, connection, rejection) |
| 4 | Configuration error (missing or invalid environment variables) |

### Configuration Resolution

The CLI loads configuration in this order (first match wins):

1. Shell environment variables
2. `.env` file in the current working directory
3. `~/.paperboy/.env` fallback for global user configuration

`--help` and `--version` work without any configuration.

## MCP Server Usage

### Local (stdio transport)

```bash
npm run dev
```

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "paperboy": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/send-to-kindle",
      "env": {
        "KINDLE_DEVICES": "personal:your-kindle@kindle.com",
        "SENDER_EMAIL": "you@gmail.com",
        "SMTP_HOST": "smtp.gmail.com",
        "SMTP_PORT": "587",
        "SMTP_USER": "you@gmail.com",
        "SMTP_PASS": "your-app-password"
      }
    }
  }
}
```

### Remote (HTTP/SSE transport)

Set `MCP_HTTP_PORT` and `MCP_AUTH_TOKEN`, then start the server:

```bash
MCP_HTTP_PORT=3000 MCP_AUTH_TOKEN=your-secret npm run dev
```

The server accepts MCP requests at `POST /mcp` with Bearer token authentication.

### MCP Tool: `send_to_kindle`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Document title (appears in Kindle library) |
| `content` | string | yes | Document body in Markdown format |
| `author` | string | no | Author name (defaults to `DEFAULT_AUTHOR`) |
| `device` | string | no | Target Kindle device name |

### Docker

```bash
# Build
docker build -t paperboy .

# Run with stdio
docker run -i --env-file .env paperboy

# Run with HTTP/SSE
docker run -p 3000:3000 --env-file .env paperboy
```

Or with Docker Compose:

```bash
docker compose up
```

## Folder Watcher

The folder watcher monitors a directory for Markdown files and automatically sends each one to your Kindle. Drop a `.md` file in — it converts, sends, and moves the file to `sent/` when done (or `error/` if something goes wrong).

### Setup

Add `WATCH_FOLDER` to your `.env`:

```
WATCH_FOLDER=/path/to/your/kindle-inbox
```

The folder must exist before starting the watcher. The `sent/` and `error/` subdirectories are created automatically.

### Run

```bash
paperboy watch
```

Files already in the folder when the watcher starts are processed immediately. New files are picked up as they arrive.

### Run as a background service

Service templates are provided in `scripts/service-templates/`.

**Linux (systemd):**

```bash
# Edit the file and replace /path/to/npx with the output of: which npx
cp scripts/service-templates/paperboy-watcher.service ~/.config/systemd/user/
systemctl --user enable --now paperboy-watcher
systemctl --user status paperboy-watcher
journalctl --user -u paperboy-watcher   # view logs
```

**macOS (launchd):**

```bash
# Edit the file and replace /path/to/npx with the output of: which npx
cp scripts/service-templates/com.paperboy.watcher.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.paperboy.watcher.plist
# Logs: ~/Library/Logs/paperboy-watcher.log
```

**Windows (Task Scheduler):**

```powershell
# Edit the file and replace C:\path\to\npx.cmd with the output of: where npx
schtasks /create /tn "PaperboyWatcher" /xml "scripts\service-templates\windows-task.xml"

# Or as a one-liner (no XML edit needed):
schtasks /create /tn "PaperboyWatcher" /tr "\"C:\path\to\npx.cmd\" paperboy watch" /sc onlogon /rl limited
```

The task starts at login and restarts automatically on failure.

### How it works

- Watches only the root of `WATCH_FOLDER` (not subdirectories)
- Waits 2 seconds after a file stops changing before processing (safe for slow copies)
- Processes files one at a time
- Retries transient SMTP failures up to 3 times with exponential backoff
- Permanent errors (auth failure, rejection) are not retried
- Shuts down gracefully on SIGINT/SIGTERM, draining any in-progress file

## Security

**Dependency Scanning:** npm audit is enforced at two points:

1. **Pre-commit hook** — blocks commits if high/critical vulnerabilities are found
2. **CI/CD workflow** — blocks merges if high/critical vulnerabilities are found

Run locally: `npm run audit:ci` (exits non-zero if vulnerabilities present)

## Development

```bash
npm run dev          # Run MCP server with tsx (no build step)
npm run cli -- --help  # Run CLI with tsx
npm run build        # Compile TypeScript to dist/
npm test             # Run automated tests (190 tests)
npm run test:watch   # Run tests in watch mode
npm run test:email   # Send a real test email to verify SMTP config
npm run audit:ci     # Check for high/critical npm vulnerabilities
```

### Gmail Setup

Any SMTP provider works. Gmail is recommended for personal use — it's free, requires no domain, and has no sending restrictions for individual use.

Gmail requires an **App Password** — your regular password will not work for SMTP.

1. Enable 2-Step Verification: Google Account > Security > 2-Step Verification
2. Create an App Password: Google Account > Security > App Passwords
3. Use the generated 16-character password as `SMTP_PASS` in `.env`

Then add your sender address to Amazon's approved list: Amazon Account > Manage Your Content and Devices > Preferences > Personal Document Settings > Approved Personal Document E-mail List.

## Architecture

Three-layer design with strict dependency inversion:

```
Application (MCP + CLI adapters) --> Domain (service, values, ports) <-- Infrastructure (EPUB, SMTP)
```

- **Domain**: Value objects (`Title`, `Author`, `MarkdownContent`, `EpubDocument`), service orchestration, port interfaces, typed errors with `Result<T, E>`
- **Infrastructure**: Markdown-to-EPUB conversion (`marked` + `sanitize-html` + `epub-gen-memory`), SMTP delivery (`nodemailer`), Pino logging, CLI content reader
- **Application**: MCP tool handler, CLI adapter (arg parsing, exit codes, orchestration), two composition roots (`index.ts` for MCP, `cli-entry.ts` for CLI)

## License

MIT
