# PB-004: CLI Version + Claude Code Skill — Design

> Status: Draft
> Feature: docs/features/backlog/cli-version.md
> Created: 2026-03-17

---

## 1. Context

The send-to-kindle system currently exposes a single entry point: an MCP server (`src/index.ts`). The domain layer (`SendToKindleService`, value objects, ports) and the infrastructure layer (EPUB converter, SMTP mailer, config, logger) are transport-agnostic. Adding a CLI entry point requires only a new adapter that translates command-line arguments into domain calls and maps domain results back to exit codes and stderr messages.

---

## 2. Separation of Concerns Analysis

### 2.1 Existing Architecture Mapped to SoC Concepts

The current codebase maps cleanly to the SoC model:

| Current location | SoC role | Notes |
|---|---|---|
| `src/domain/values/` | `platform/domain/` | Shared value objects (Title, Author, MarkdownContent, etc.) |
| `src/domain/errors.ts` | `platform/domain/` | Discriminated union error types, Result type |
| `src/domain/ports.ts` | `platform/domain/` | Port interfaces (ContentConverter, DocumentMailer, DeliveryLogger) |
| `src/domain/device-registry.ts` | `platform/domain/` | Domain abstraction enforcing uniqueness/lookup invariants |
| `src/domain/send-to-kindle-service.ts` | `features/send-to-kindle/commands/` | Orchestrates convert-then-deliver (write operation with side effect) |
| `src/infrastructure/config.ts` | `platform/infra/config/` | Environment-based configuration loading |
| `src/infrastructure/logger.ts` | `platform/infra/logging/` | Pino-based structured logger |
| `src/infrastructure/converter/` | `platform/infra/external-clients/` | Wraps marked + sanitize-html + epub-gen-memory |
| `src/infrastructure/mailer/` | `platform/infra/external-clients/` | Wraps nodemailer |
| `src/application/tool-handler.ts` | `features/send-to-kindle/entrypoint/` | MCP adapter: parses MCP args, maps errors to MCP responses |
| `src/index.ts` | `shell/` | Wires MCP server, registers tools, starts transports |

The CLI feature adds parallel entry point and shell components. The domain and infrastructure layers require zero changes.

### 2.2 New Components and Their SoC Placement

| New file | SoC role | Rationale |
|---|---|---|
| `src/application/cli.ts` | `features/send-to-kindle/entrypoint/` | Translates CLI args to domain calls, maps results to exit codes/stderr output. Parallel to `tool-handler.ts`. |
| `src/cli-entry.ts` | `shell/` | Wires the same object graph as `index.ts` but routes through the CLI adapter instead of MCP. |
| `.claude/skills/send-to-kindle.md` | External artifact | Not application code. Documentation for Claude Code. |

### 2.3 Rule-by-Rule Audit of the CLI Design

| Rule | Verdict | Rationale |
|---|---|---|
| SoC-001: Code placement decision tree | PASS | `cli.ts` passes the Q2 test ("translates between external and internal formats"). `cli-entry.ts` passes Q1 ("wires things together at startup"). |
| SoC-002: Dependencies point inward | PASS | `cli.ts` (entrypoint) depends on domain values and the service. `cli-entry.ts` (shell) depends on entrypoint and infra. Domain and infra are unchanged. |
| SoC-003: Features never cross-import | PASS | Single feature. MCP and CLI entry points share domain/infra but do not import each other. |
| SoC-004: Domain never does I/O | PASS | No domain changes. CLI does I/O (stdin, stderr) exclusively in `cli.ts` (entrypoint) and `cli-entry.ts` (shell). |
| SoC-005: No business logic in commands | N/A | `SendToKindleService` (the command) is unchanged and already delegates to domain. |
| SoC-006: Entrypoints are thin translation layers | PASS | `cli.ts` only parses args, reads stdin, invokes the service, maps errors to exit codes. No orchestration, no domain rules, no data fetching. |
| SoC-007: Commands own their inputs | PASS | The CLI adapter defines its own `CliArgs` input type. Does not share `McpToolResponse` or any MCP types. |
| SoC-010: Co-locate by change, not kind | PASS | Both MCP and CLI adapters live in `src/application/` because they change with the same feature (send-to-kindle). They are two entry points for one feature, not two features. |
| SoC-012: Infra uses standard sub-folders | PASS | No new infra. Existing infra already organized in sub-folders. |
| SoC-013: Separate intent from execution | PASS | `cli-entry.ts` reads as: load config, build dependencies, parse args, run, handle result. Each step is one call. |
| SoC-014: Separate functions by state | PASS | Arg parsing (depends on process.argv), stdin reading (depends on process.stdin), error mapping (depends on DomainError) are separate functions. |
| SoC-015: Related names | PASS | `cli.ts` functions: `parseArgs`, `readStdin`, `mapErrorToExitCode`, `formatOutput` -- all CLI concerns. |

---

## 3. Detailed Design

### 3.1 CLI Adapter: `src/application/cli.ts`

This module is a pure translation layer. It owns three responsibilities:

1. **Parse arguments** from `process.argv` into a dedicated `CliArgs` type
2. **Read content** from `--file` or stdin
3. **Map results** to exit codes and stderr messages

```
process.argv --> parseArgs() --> CliArgs
                                   |
                                   v
              readContent(args) --> { title, content, author, device }
                                   |
                                   v
               service.execute() --> Result<DeliverySuccess, DomainError>
                                   |
                                   v
              mapErrorToExitCode() --> exit code (0-4)
              formatOutput()       --> stderr message
```

#### Input Type

```typescript
interface CliArgs {
  readonly title: string;
  readonly filePath: string | undefined;
  readonly author: string | undefined;
  readonly device: string | undefined;
  readonly help: boolean;
}
```

This type is owned entirely by the CLI adapter. It does not reuse any MCP types.

#### Argument Parsing

Manual `process.argv` parsing. The CLI has only five flags (`--title`, `--file`, `--author`, `--device`, `--help`). No subcommands, no positional arguments, no complex parsing needed. Adding a dependency like `commander` for five flags violates proportionality.

Parsing errors (missing `--title`, unknown flags) produce a validation exit code (1) with a usage message on stderr.

#### Content Resolution

Content comes from exactly one of two sources:
- `--file <path>` -- read the file from disk (fs.readFile)
- stdin -- detected via `!process.stdin.isTTY`, read until EOF

If neither is provided and stdin is a TTY, exit with code 1 and a message explaining that content must come from `--file` or stdin.

File read errors (ENOENT, EACCES) map to exit code 1 (validation) since they represent invalid user input, not a system failure.

#### Exit Code Mapping

| DomainError.kind | Exit code |
|---|---|
| `validation` | 1 |
| `size_limit` | 1 |
| `conversion` | 2 |
| `delivery` | 3 |
| Config error (thrown) | 4 |

The mapping function is exhaustive via a `switch` on `error.kind` with a `never` default, matching the pattern in `tool-handler.ts`.

#### Output

All output goes to stderr. Stdout is not used. This is intentional: it matches the existing logger convention (pino writes to fd 2) and keeps the CLI composable in pipelines.

- Success: `"Sent '<title>' to Kindle (<device>) -- <size> bytes"`
- Failure: `"Error: <message>"`
- Help: usage text

### 3.2 CLI Composition Root: `src/cli-entry.ts`

This file mirrors `src/index.ts` but routes through the CLI adapter instead of the MCP server. It is the `bin` entry point.

```typescript
#!/usr/bin/env node

// 1. Load .env (with multi-path resolution)
// 2. Load config (fail-fast, catch -> exit 4)
// 3. Wire dependencies (converter, mailer, logger, service)
// 4. Parse CLI args
// 5. Read content (file or stdin)
// 6. Create value objects (Title, Author, MarkdownContent)
// 7. Resolve device via DeviceRegistry
// 8. Call service.execute()
// 9. Map result to exit code + stderr message
```

The shebang line (`#!/usr/bin/env node`) is required for the `bin` field in package.json to work on Unix systems.

#### .env Resolution

The feature doc specifies two .env locations:
1. `.env` in the current working directory (existing behavior via `dotenv`)
2. `~/.send-to-kindle/.env` (new, for global CLI use)

Resolution order: CWD `.env` takes precedence (already loaded by `dotenv/config`). If a variable is still missing, load from `~/.send-to-kindle/.env` as a fallback. This is handled by calling `dotenv.config()` twice with different paths -- dotenv does not overwrite existing values by default.

Implementation:
```typescript
import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';

dotenv.config(); // CWD/.env
dotenv.config({ path: join(homedir(), '.send-to-kindle', '.env') }); // fallback
```

This is two lines in the shell, not a new module.

### 3.3 Package.json Changes

```json
{
  "bin": {
    "send-to-kindle": "./dist/cli-entry.js"
  },
  "scripts": {
    "cli": "tsx src/cli-entry.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

The `bin` field makes `send-to-kindle` available as a command after `npm install -g` or via `npx`. The `cli` script enables local development without building first.

No `files` field change is needed initially. The package already excludes `node_modules` and `test` via `.npmignore` / tsconfig. If the npm package size becomes a concern, add `"files": ["dist", "package.json"]` later.

### 3.4 Claude Code Skill: `.claude/skills/send-to-kindle.md`

The skill file teaches Claude Code how to invoke the CLI. It is a markdown file with frontmatter that Claude Code reads when the user mentions "send to kindle".

Key design decisions:
- Use `npx send-to-kindle-cli` (not a global install) for zero-setup invocation
- Write content to a temp file rather than piping (avoids shell escaping issues with markdown)
- Include prerequisites section pointing to `--setup` or manual `.env` creation
- Keep the skill concise -- Claude Code works better with focused instructions

### 3.5 What Is Explicitly Out of Scope

The feature doc mentions `--setup` (interactive config wizard) and `--url` (URL fetching). These are separate features that depend on other work:

- **`--setup`**: Interactive prompts require a different I/O model (readline). Design and implement as a follow-up.
- **`--url`**: Depends on a URL-to-markdown feature that does not exist yet. The CLI arg parser should not include `--url` until that feature lands.

The CLI adapter should be designed so adding these flags later is trivial (just add cases to `parseArgs`), but should not include dead code paths.

---

## 4. Dependency Graph

```
cli-entry.ts (shell)
  |
  +--> dotenv (load .env)
  +--> infrastructure/config.ts (loadConfig)
  +--> infrastructure/logger.ts (createPinoLogger, createDeliveryLogger)
  +--> infrastructure/converter/ (MarkdownEpubConverter)
  +--> infrastructure/mailer/ (SmtpMailer)
  +--> domain/send-to-kindle-service.ts (SendToKindleService)
  +--> application/cli.ts (parseArgs, readContent, mapErrorToExitCode, formatOutput)
       |
       +--> domain/values/ (Title, Author, MarkdownContent)
       +--> domain/device-registry.ts (DeviceRegistry)
       +--> domain/errors.ts (DomainError)
       +--> node:fs/promises (readFile -- for --file)
       +--> node:process (argv, stdin, stderr, exit)
```

No circular dependencies. Domain remains pure. Infrastructure remains unchanged.

---

## 5. Testing Strategy

### 5.1 CLI Adapter Unit Tests

Test `cli.ts` the same way `tool-handler.test.ts` tests the MCP adapter:

- **parseArgs**: Test flag combinations, missing required flags, unknown flags, help flag
- **mapErrorToExitCode**: Test each DomainError kind maps to the correct exit code
- **readContent with --file**: Mock `fs.readFile`, test success and ENOENT/EACCES errors
- **readContent with stdin**: Provide a readable stream, verify content is read to completion

The service is mocked. These tests verify the translation layer only.

### 5.2 Integration Test

Run the built CLI binary as a child process with a mocked SMTP server (or with the service mocked at the config level). Verify:
- Exit code 0 on success
- Exit code 1 on missing `--title`
- Exit code 4 on missing env vars
- Stderr contains expected messages

---

## 6. Affected Specs

| Spec | Change needed |
|---|---|
| `docs/specs/main-spec.md` | Add CLI as a second distribution path. Document CLI flags, exit codes, .env resolution. |

No other specs are affected. The domain, infrastructure, and MCP entry point are unchanged.

---

## 7. Risk Assessment

| Risk | Mitigation |
|---|---|
| stdin detection unreliable on Windows | `process.stdin.isTTY` works on Windows with Node 22. Fall back to requiring `--file` if stdin detection fails. |
| dotenv double-load has side effects | dotenv.config() does not overwrite by default. Safe to call twice. Verified in dotenv documentation. |
| npm package name collision | `send-to-kindle-cli` may be taken on npm. Check availability before publishing. Not a blocker for implementation. |
| Shebang line on Windows | Node handles `#!/usr/bin/env node` correctly on Windows when run via npm/npx. Direct execution on Windows requires the `.cmd` wrapper that npm generates. |
