# Send to Kindle MCP Server

An MCP server that lets Claude send Markdown content directly to your Kindle. Write or generate content in Claude, invoke the `send_to_kindle` tool, and the document appears in your Kindle library as an EPUB.

## How It Works

1. Claude generates Markdown content (summaries, articles, research notes)
2. Claude calls the `send_to_kindle` MCP tool
3. The server converts Markdown to EPUB
4. The EPUB is emailed to your Kindle address
5. The document appears in your Kindle library

## Prerequisites

- **Node.js 22** or later
- An **SMTP account** — any provider works; Gmail is the easiest option, see [Gmail setup](#gmail-setup) below
- Your **Kindle email address** (found in Amazon account settings under "Send to Kindle")
- The SMTP sender address must be in your [Amazon approved senders list](https://www.amazon.com/sendtokindle)

## Setup

```bash
git clone <repo-url>
cd send-to-kindle-mcp
npm install
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

> The `.env` file loads automatically when running locally. In Docker, set environment variables directly — they take precedence over `.env`.

### Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `KINDLE_EMAIL` | Your Kindle's receive address | `your-kindle@kindle.com` |
| `SENDER_EMAIL` | Email that sends the EPUB | `you@gmail.com` |
| `SMTP_HOST` | SMTP server hostname | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_USER` | SMTP login username | `you@gmail.com` |
| `SMTP_PASS` | SMTP app password | `abcd-efgh-ijkl-mnop` |

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_AUTHOR` | `Claude` | Author name when none is specified |
| `MCP_HTTP_PORT` | — | Enables HTTP/SSE transport on this port |
| `MCP_AUTH_TOKEN` | — | Required when `MCP_HTTP_PORT` is set |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |

## Usage

### Local (stdio transport)

Run the server and connect Claude Desktop or another MCP client via stdio:

```bash
npm run dev
```

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "send-to-kindle": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/send-to-kindle-mcp",
      "env": {
        "KINDLE_EMAIL": "your-kindle@kindle.com",
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

### Docker

```bash
# Build
docker build -t send-to-kindle-mcp .

# Run with stdio
docker run -i --env-file .env send-to-kindle-mcp

# Run with HTTP/SSE
docker run -p 3000:3000 --env-file .env send-to-kindle-mcp
```

Or with Docker Compose:

```bash
docker compose up
```

## MCP Tool

The server exposes a single tool:

### `send_to_kindle`

Convert Markdown content to EPUB and send it to a Kindle device via email.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Document title (appears in Kindle library) |
| `content` | string | yes | Document body in Markdown format |
| `author` | string | no | Author name (defaults to `DEFAULT_AUTHOR`) |

**Success response:**

```json
{
  "success": true,
  "message": "Document 'My Article' sent to Kindle successfully.",
  "sizeBytes": 24576
}
```

**Error response:**

```json
{
  "success": false,
  "error": "VALIDATION_ERROR",
  "details": "Title cannot be empty"
}
```

Error codes: `VALIDATION_ERROR`, `SIZE_ERROR`, `CONVERSION_ERROR`, `SMTP_ERROR`.

## Development

```bash
npm run dev          # Run with tsx (no build step)
npm run build        # Compile TypeScript to dist/
npm test             # Run automated tests
npm run test:watch   # Run tests in watch mode
npm run test:email   # Send a real test email to verify SMTP config
```

### Gmail Setup (Recommended)

Any SMTP provider works. Gmail is recommended for personal use — it's free, requires no domain, and has no sending restrictions for individual use.

Gmail requires an **App Password** — your regular password will not work for SMTP.

1. Enable 2-Step Verification: Google Account → Security → 2-Step Verification
2. Create an App Password: Google Account → Security → App Passwords
3. Use the generated 16-character password as `SMTP_PASS` in `.env`

Then add your sender address to Amazon's approved list: Amazon Account → Manage Your Content and Devices → Preferences → Personal Document Settings → Approved Personal Document E-mail List.

## Architecture

Three-layer design with strict dependency inversion:

```
Application (MCP adapter) → Domain (service, values, ports) ← Infrastructure (EPUB, SMTP)
```

- **Domain**: Value objects (`Title`, `Author`, `MarkdownContent`, `EpubDocument`), service orchestration, port interfaces, typed errors with `Result<T, E>`
- **Infrastructure**: Markdown-to-EPUB conversion (`marked` + `sanitize-html` + `epub-gen-memory`), SMTP delivery (`nodemailer`), Pino logging
- **Application**: MCP tool registration, error-to-response mapping

## License

MIT
