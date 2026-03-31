# PB-009: Watch Folder — Design

**Status:** Accepted (revised after critique and decision review)
**Date:** 2026-03-31
**Critique:** docs/designs/PB-009-watch-folder/critique.md

## Summary

A folder watcher that automatically converts and sends `.md` files dropped into a configured inbox folder to a Kindle device.

**Phased delivery:**
- **Phase 1 (this feature):** `paperboy watch` foreground watcher + template service configs in `scripts/service-templates/` + documented install one-liner per OS
- **Phase 2 (follow-up feature):** Automated `paperboy watch install/uninstall/status` commands

## Architecture

The watch adapter is the third entry point into the domain, alongside MCP and CLI. It reuses all existing domain and infrastructure components.

```
Entry Points:
  index.ts        → MCP server (stdio / HTTP+SSE)
  cli-entry.ts    → CLI routing: detects "watch" subcommand early, delegates
                    to watch module; otherwise proceeds with --flag parsing
  watch-entry.ts  → Watcher composition root (dotenv, config, wire deps)

All three share:
  Domain:         SendToKindleService, value objects, ports
  Infrastructure: MarkdownEpubConverter, SmtpMailer, config, logger
```

### Subcommand Routing

`cli-entry.ts` checks `argv[0]` **before** `--help`/`--version` interception:

```
if argv[0] === "watch" → import and run watch-entry logic with remaining args
if --help              → print CLI usage (not watcher usage)
if --version           → print version
otherwise              → proceed with existing --flag parsing (unchanged)
```

This ordering is critical: `paperboy watch --help` must show watcher help, not CLI help. The subcommand check must come first.

The `watch` subcommand delegates to `watch-entry.ts` which is a separate composition root with its own config validation, dependency wiring, and `--help` handling.

### New Components

| Component | Layer | Responsibility |
|-----------|-------|----------------|
| `watch-entry.ts` | Composition root | Dotenv loading, config, wire deps, start watcher |
| `application/watcher.ts` | Application | Orchestrate: receive file events, call domain for title extraction, call service, delegate file I/O to injected deps |
| `domain/title-extractor.ts` | Domain | Extract title from first H1 in markdown, fall back to filename |
| `infrastructure/watcher/folder-watcher.ts` | Infrastructure | File system watching (wraps chokidar) |
| `infrastructure/watcher/file-mover.ts` | Infrastructure | Move files to sent/error, write error files |

Phase 2 adds:
| `infrastructure/os-service/service-installer.ts` | Infrastructure | OS-specific service install/uninstall |

### CLI Surface (Phase 1)

- `paperboy watch` — runs the watcher in foreground
- `paperboy watch --help` — shows watcher usage

**Phase 2 (follow-up):**
- `paperboy watch install` — registers as a background OS service
- `paperboy watch uninstall` — removes the OS service
- `paperboy watch status` — shows whether the service is installed and running

## File System Watching

**Library:** chokidar v5. `awaitWriteFinish` with `stabilityThreshold` and `pollInterval` confirmed supported in v5.0.0 (verified 2026-03-31 against npm registry and README).

Node's built-in `fs.watch` has cross-platform inconsistencies (double-firing on Windows, missing events on macOS). Chokidar normalizes this.

**Watch behaviour:**

1. On startup, scan inbox for any existing `.md` files (handles files dropped while service was stopped)
2. Watch for new `.md` files via chokidar with explicit configuration:
   ```js
   chokidar.watch(inboxPath, {
     depth: 0,
     ignored: [path.join(inbox, 'sent'), path.join(inbox, 'error')],
     awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
   })
   ```
3. `awaitWriteFinish` waits for file size to stabilize for 2 seconds — prevents processing partially-written files
4. `ignored` explicitly excludes `sent/` and `error/` subdirectories — prevents infinite processing loops when files are moved into them
5. Event handler also filters by path as defense in depth: reject any file not directly in the inbox root and not ending in `.md`
6. Only react to `.md` files — ignore everything else

**Processing pipeline per file:**

```
New .md file detected
  → Read file contents (via injected readFile)
  → Call domain titleExtractor(content, filename) for title
  → Create Title, MarkdownContent, Author value objects
  → Call SendToKindleService.execute(title, content, author, device)
  → On success: move file to inbox/sent/ (via injected moveFile)
  → On transient SMTP failure: retry up to 3 times with exponential backoff
  → On permanent failure or retries exhausted: move to inbox/error/ + write .error.txt
```

**Concurrency:** Sequential — one file at a time. No parallel sends.

**Sent-but-not-moved protection:** After a successful send, if the move to `sent/` fails (e.g. file locked on Windows), track the file path in an in-memory Set so it is not re-processed. Log a warning. On next startup the Set is empty, but the file will be re-sent — this is an acceptable trade-off for simplicity.

## Dependency Injection (WatcherDeps)

Following the CLI adapter pattern (`CliDeps`), the watcher receives all I/O through an injected interface:

```typescript
interface WatcherDeps {
  service: SendToKindleService;
  devices: DeviceRegistry;
  defaultAuthor: Author;
  watchFolder: string;
  readFile: (path: string) => Promise<string>;
  moveFile: (src: string, dest: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  ensureDir: (path: string) => Promise<void>;
  listFiles: (dir: string, ext: string) => Promise<string[]>;
  extractTitle: (content: string, fallback: string) => Result<Title, ValidationError>;
  logger: WatcherLogger;
}
```

This makes the watcher fully testable without a real filesystem.

## Configuration

**New environment variable:**

```
WATCH_FOLDER=/path/to/kindle-inbox
```

Added to `Config` as an optional field: `watchFolder?: string`. The MCP and CLI entry points ignore it. The watcher composition root (`watch-entry.ts`) validates its presence after calling `loadConfig()` and fails with a clear message if not set.

**Folder structure managed by the watcher:**

```
/path/to/kindle-inbox/       ← user drops .md files here
  sent/                      ← auto-created, successful deliveries moved here
  error/                     ← auto-created, failed deliveries + .error.txt
```

The watcher creates `sent/` and `error/` on startup if they don't exist. The inbox folder must be on a single filesystem (cross-volume moves are not supported).

**Author and device:** Uses `DEFAULT_AUTHOR` and first device in `KINDLE_DEVICES` — same defaults as the CLI. No per-file override.

## OS Service Registration (Phase 1: Template Configs + Docs)

Phase 1 ships template service configs and documented one-liner install commands. The user copies and runs one command to register the watcher as a background service. Automated `paperboy watch install` is deferred to Phase 2.

### Template Configs

Shipped in `scripts/service-templates/`:

- `windows-task.xml` — Task Scheduler XML, user fills in absolute node/watch-entry paths
- `com.paperboy.watcher.plist` — macOS launchd plist
- `paperboy-watcher.service` — Linux systemd user unit

Each template includes inline comments explaining what to customize.

### Documented Install One-Liners

**Windows (Task Scheduler):**
```
schtasks /create /tn "PaperboyWatcher" /tr "\"C:\path\to\node.exe\" \"C:\path\to\watch-entry.js\"" /sc onlogon /rl limited
```

**macOS (launchd):**
```
cp scripts/service-templates/com.paperboy.watcher.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.paperboy.watcher.plist
```

**Linux (systemd):**
```
cp scripts/service-templates/paperboy-watcher.service ~/.config/systemd/user/
systemctl --user enable --now paperboy-watcher
```

### Logging

The watcher uses pino at "info" level (not silent like CLI mode), writing structured JSON to stdout. Service managers capture stdout:
- Windows: redirect to `~/.paperboy/watcher.log` in task config
- macOS: `StandardOutPath` in plist → `~/Library/Logs/paperboy-watcher.log`
- Linux: journalctl user journal

## OS Service Automation (Phase 2 — Future Feature)

Deferred to a follow-up feature. Would add:
- `paperboy watch install` — auto-detect OS, resolve absolute paths via `process.execPath`, generate and register service config with proper escaping
- `paperboy watch uninstall` — remove service registration
- `paperboy watch status` — query service state

See critique (#1) for rationale: cross-platform service installation is complex enough to warrant its own design/test cycle.

## Error Handling

### Retry Policy for SMTP Failures

- **Transient failures** (connection timeout, server busy): retry up to 3 times with exponential backoff (2s, 4s, 8s)
- **Permanent failures** (auth error, recipient rejection): move to `error/` immediately, no retry
- **Retries exhausted**: move to `error/`

The `DeliveryError.cause` field (`"auth"` | `"connection"` | `"rejection"`) determines whether a failure is transient (`"connection"`) or permanent (`"auth"`, `"rejection"`).

### File-Level Errors

| Scenario | Behaviour |
|----------|-----------|
| File too large (>25 MB) | Move to `error/`, write `.error.txt` |
| Empty file | Move to `error/`, write `.error.txt` |
| Title extraction fails | Move to `error/`, write `.error.txt` |
| SMTP transient failure | Retry up to 3x with backoff, then `error/` |
| SMTP permanent failure | Move to `error/` immediately |
| EPUB conversion failure | Move to `error/`, write `.error.txt` |
| File locked / unreadable | Log warning, skip, retry on next watch cycle |

**Error file format:** For `my-article.md` that fails:
- `error/my-article.md` (the original file)
- `error/my-article.error.txt` with content:
  ```
  Timestamp: 2026-03-31T14:30:00.000Z
  Error: delivery
  Message: SMTP connection timed out after 3 retries
  ```

### Watcher-Level Errors

| Scenario | Behaviour |
|----------|-----------|
| Watch folder deleted while running | Log error, exit non-zero (OS service restarts it) |
| Config invalid at startup | Exit code 4, service logs the error |
| Duplicate filename in `sent/` or `error/` | Append millisecond timestamp: `my-article-1711892400000.md` |

### Graceful Shutdown

Listens for `SIGINT` and `SIGTERM`. A `processing` flag tracks whether a file is being handled. The signal handler waits for the current file to complete (both send and move) before exiting.

### Known Limitations

- Error folder grows unbounded. Users should periodically clean `error/` manually.
- If the watcher is stopped and restarted, files that were sent but not moved (due to a move failure) will be re-sent.
- Inbox folder must be on a single filesystem (cross-volume moves not supported).

## Testing

### Unit Tests (domain/title-extractor.ts)

- H1 found → use it as title
- No H1 → fall back to filename
- Multiple H1s → use first
- Empty content → fall back to filename
- Filename sanitization (strip .md extension, trim)

### Unit Tests (application/watcher.ts)

- File processing: success moves to `sent/`, failure moves to `error/` with error file
- Retry logic: transient failure retries, permanent failure goes straight to `error/`
- Duplicate filename handling: millisecond timestamp suffix
- Skip non-`.md` files
- Graceful shutdown: waits for current file
- All via injected `WatcherDeps` — no real filesystem

### Integration Tests (Manual)

- Drop `.md` file → arrives on Kindle, moved to `sent/`
- Drop empty file → moved to `error/` with `.error.txt`
- Drop file while SMTP is unreachable → retries, then moves to `error/`
- `paperboy watch` starts and processes existing files in inbox
- `paperboy watch --help` shows watcher usage
- Graceful shutdown: Ctrl+C during processing waits for current file

## Dependencies

- `chokidar` v5 — file system watching (`awaitWriteFinish` confirmed supported)

No other new dependencies.
