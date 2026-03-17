# PB-004 ADR: CLI Version + Claude Code Skill

**Status:** Accepted
**Date:** 2026-03-17

## Context

The send-to-kindle system currently exposes only an MCP server entry point. Users working in the terminal or through Claude Code have a simpler path available: a CLI tool invoked directly via shell commands. The domain and infrastructure layers are already transport-agnostic, so adding a CLI requires only a new adapter (entrypoint) and composition root (shell).

During the design review, the project was also renamed from `send-to-kindle-mcp` / `send-to-kindle-cli` to **`paperboy`** — reflecting the broader intent of delivering reading material in any format to any destination, not just EPUB to Kindle.

## Decision

Build the CLI as a thin adapter within the existing package, following the refined design with all accepted critique findings incorporated.

### Architecture

```
cli-entry.ts (shell)
  ├── dotenv (load .env from CWD + ~/.paperboy/.env)
  ├── infrastructure/config.ts (loadConfig, fail-fast)
  ├── infrastructure/logger.ts (silent in CLI mode)
  ├── infrastructure/converter/ (MarkdownEpubConverter)
  ├── infrastructure/mailer/ (SmtpMailer)
  ├── infrastructure/cli/content-reader.ts (readFromFile, readFromStdin)
  ├── domain/send-to-kindle-service.ts (SendToKindleService)
  └── application/cli.ts (run)

application/cli.ts (entrypoint)
  ├── Owns: CliArgs, ContentSource, parseArgs, resolveContentSource, mapErrorToExitCode, formatOutput
  ├── Depends on: domain/values/, domain/errors.ts, domain/device-registry.ts (types)
  └── All I/O injected via CliDeps (no direct imports of fs, process)
```

### Key Decisions

1. **Package name: `paperboy`** — format/target agnostic, captures the "deliver reading material" intent. Bin command is `paperboy`. npx invocation: `npx paperboy`.

2. **Content reader split into two primitive functions** — `readFromFile(path: string)` and `readFromStdin(stream: Readable)` in infrastructure. The entrypoint owns the `ContentSource` discriminated union locally and decides which to call. No cross-layer type dependency.

3. **Dependency-injected `run` function** — receives `CliDeps` with service, devices, readFromFile, readFromStdin, stdin, stderr all injected. Fully testable without module mocking.

4. **Manual argv parsing** — 6 flags (`--title`, `--file`, `--author`, `--device`, `--version`, `--help`). No dependency needed.

5. **Exit codes split by error source:**
   - Shell-level: config failure = 4
   - Entrypoint-level: validation/size = 1, conversion = 2, delivery = 3, success = 0

6. **Stdin timeout** — 30-second timeout on stdin reading. Emits a helpful message if no input received.

7. **Empty stdin guard** — check for empty content at the entrypoint level before hitting domain validation. CLI-friendly error message.

8. **File size guard** — check file size before reading into memory. Reject files > 25 MB with a CLI-friendly message.

9. **Pino suppressed in CLI mode** — log level set to "silent" by default. No log/output stream mixing.

10. **`isTTY` coercion** — `process.stdin.isTTY` (`boolean | undefined`) coerced to `boolean` at the shell boundary. Documented.

11. **dotenv error checking** — check return value of second `dotenv.config()` call. Warn on stderr if file exists but has parse errors.

12. **Skill file** — only documents implemented flags (`--title`, `--file`, `--author`, `--device`). No references to `--url` or `--setup`.

13. **Device resolution stays in entrypoints** — duplicated across MCP and CLI entrypoints. Keeps the service contract clean (accepts only validated domain types). Accepted trade-off.

### SoC Audit: Honest Assessment

| Rule | Verdict | Notes |
|---|---|---|
| SoC-002: Dependencies point inward | PASS* | *The entrypoint imports domain types directly. Acceptable for project size (one feature, two entrypoints). A third entrypoint would warrant extracting a command.* |
| SoC-006: Entrypoints are thin translation layers | PASS* | *The `run` function orchestrates beyond pure translation (creates value objects, resolves devices, invokes service). This is a known tension — pragmatically accepted.* |
| All other rules | PASS | No caveats. |

## Consequences

### Positive
- CLI enables terminal and Claude Code workflows without running an MCP server
- Zero domain/infrastructure changes — the architecture proves its transport-agnosticism
- `paperboy` name is memorable and future-proof for format/target expansion
- Full dependency injection makes the CLI adapter trivially testable
- Stdin timeout and empty content guard prevent confusing hang/error scenarios

### Negative
- SoC-002 and SoC-006 tensions — entrypoint does more than pure translation
- Device resolution duplicated across MCP and CLI entrypoints
- Pino suppressed in CLI mode means no debug logging by default

### Mitigations
- SoC tensions documented honestly; extraction warranted only if a third entrypoint appears
- Device resolution duplication is 2 lines per entrypoint — cost of keeping service contract clean
- Future `--verbose` flag can re-enable pino for debugging

## Tech Debt

| Item | Context | Priority |
|---|---|---|
| SIGINT/SIGTERM handling | Interrupted SMTP connections may leave partial state or print unhandled promise rejection warnings. Node.js default signal handling is acceptable for MVP. | Low |
| Structured CLI output (`--json`, `--quiet`, `--verbose`) | Scripts cannot parse CLI output. Pino and CLI messages would mix on stderr if logging is re-enabled. Add `--verbose` to re-enable pino, `--quiet` to suppress CLI output, `--json` for machine-readable output. | Low |

## Alternatives Considered

### Original Design (before refinement)
- `readContent` lived in the entrypoint (I/O in translation layer)
- Value object creation happened in the shell
- No `ContentSource` type — implicit branching
- Single `run` function without dependency injection

**Why refined:** extracting I/O to infrastructure, moving value object creation to the entrypoint, introducing `ContentSource`, and dependency-injecting the `run` function all improved testability and layer boundary clarity.

### Rejected Approaches

- **Move device resolution into `SendToKindleService`** — rejected because it would weaken the service contract from validated domain types to raw strings. Duplication is acceptable.
- **`ContentSource` in infrastructure** — rejected to avoid entrypoint importing types from infrastructure. Split into two primitive functions instead.
- **Full file streaming for large files** — rejected in favor of a file size check before reading. The 25 MB limit keeps memory bounded. Streaming would add complexity for a rare case.

## Open Issues

None. All critique findings resolved.

## Process Improvements

### Corrections Made
- **Architect self-audit too generous** — SoC-002 and SoC-006 marked PASS when they had real tensions. Future audits should use PASS* with footnotes for conscious trade-offs.
- **Skill file referenced unimplemented features** — the skill design included `--url` and `--setup` examples that are out of scope. Future designs should cross-check scope exclusions against all artifacts.
- **Package name inconsistency** — three different names across documents. Future designs should establish the canonical name early and use it consistently.

### Proposed Improvements
- **Architect agent:** when performing SoC audits, flag trade-offs as PASS* rather than clean PASS. An audit with zero caveats should trigger self-review.
- **Critique agent:** cross-reference scope exclusions against skill/documentation artifacts to catch references to unimplemented features.
