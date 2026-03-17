# PB-004: CLI Version + Claude Code Skill — Refined Design

> Status: Draft (Refined)
> Feature: docs/features/backlog/cli-version.md
> Created: 2026-03-17
> Refined: 2026-03-17

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

The CLI feature adds parallel entry point, shell, and infrastructure components. The domain layer requires zero changes.

### 2.2 New Components and Their SoC Placement

| New file | SoC role | Rationale |
|---|---|---|
| `src/application/cli.ts` | `features/send-to-kindle/entrypoint/` | Translates CLI args to domain calls, maps results to exit codes/stderr output. Parallel to `tool-handler.ts`. |
| `src/infrastructure/cli/content-reader.ts` | `platform/infra/cli/` | CLI I/O utility: reads content from file path or stdin stream. Entrypoints do not perform I/O directly. |
| `src/cli-entry.ts` | `shell/` | Wires the same object graph as `index.ts` but routes through the CLI adapter instead of MCP. |
| `.claude/skills/send-to-kindle.md` | External artifact | Not application code. Documentation for Claude Code. |

### 2.3 Rule-by-Rule Audit of the CLI Design

| Rule | Verdict | Rationale |
|---|---|---|
| SoC-001: Code placement decision tree | PASS | `cli.ts` passes Q2 ("translates between external and internal formats"). `content-reader.ts` does not pass Q2 (it performs I/O, not translation) -- it passes Q7 as shared CLI infrastructure. `cli-entry.ts` passes Q1 ("wires things together at startup"). |
| SoC-002: Dependencies point inward | PASS | `cli.ts` (entrypoint) depends on domain values and the service via injected dependencies. `cli-entry.ts` (shell) depends on entrypoint and infra. Domain and infra are unchanged. |
| SoC-003: Features never cross-import | PASS | Single feature. MCP and CLI entry points share domain/infra but do not import each other. |
| SoC-004: Domain never does I/O | PASS | No domain changes. CLI I/O (file reading, stdin consumption) lives in `infrastructure/cli/`. |
| SoC-005: No business logic in commands | N/A | `SendToKindleService` (the command) is unchanged and already delegates to domain. |
| SoC-006: Entrypoints are thin translation layers | PASS | `cli.ts` parses args, delegates I/O to infra, creates value objects, invokes the service, maps errors to exit codes. No file I/O, no orchestration logic, no domain rules. |
| SoC-007: Commands own their inputs | PASS | The CLI adapter defines its own `CliArgs` and `ContentSource` types. Does not share `McpToolResponse` or any MCP types. |
| SoC-010: Co-locate by change, not kind | PASS | Both MCP and CLI adapters live in `src/application/` because they change with the same feature (send-to-kindle). They are two entry points for one feature, not two features. |
| SoC-012: Infra uses standard sub-folders | PASS | New `infrastructure/cli/content-reader.ts` follows the standard `cli/` sub-folder convention for CLI I/O utilities. No files at infra root. |
| SoC-013: Separate intent from execution | PASS | `cli-entry.ts` reads as: load env, load config, build dependencies, call run, set exit code. The `run` function reads as: parse args, resolve content source, read content, create value objects, resolve device, call service, map result. Each step is one call. |
| SoC-014: Separate functions by state | PASS | Arg parsing (depends on argv), content reading (depends on file system or stdin stream), error mapping (depends on DomainError) are separate functions in separate modules. |
| SoC-015: Related names | PASS | `cli.ts` functions: `parseArgs`, `resolveContentSource`, `mapErrorToExitCode`, `formatOutput` -- all CLI translation concerns. `content-reader.ts`: `readContent` -- CLI I/O concern. |

### 2.4 Tactical DDD Audit

| Principle | Verdict | Rationale |
|---|---|---|
| 1. Isolate domain logic | PASS | No domain changes. CLI adapter and content reader are infrastructure/entrypoint code. |
| 2. Use rich domain language | PASS | `ContentSource`, `CliArgs`, `DeviceRegistry.resolve` -- names reflect what they do, no generic jargon. |
| 3. Orchestrate with use cases | PASS | `SendToKindleService.execute` is the use case (menu test: "Send to Kindle"). The CLI entrypoint invokes it, does not replicate it. |
| 4. Avoid anemic domain model | PASS | Domain objects unchanged. `DeviceRegistry.resolve` contains device lookup logic. Value objects validate at construction. |
| 5. Separate generic concepts | PASS | Content reading (generic I/O) is in infrastructure, not in the entrypoint or domain. |
| 6. Make the implicit explicit | PASS | `ContentSource` discriminated union makes the file-vs-stdin branching explicit in the type system. Exit code handling is split into shell-level (config) and entrypoint-level (domain) error paths. |
| 7. Design aggregates around invariants | N/A | No new aggregates. `DeviceRegistry` is unchanged. |
| 8. Extract immutable value objects | PASS | No new value objects needed. Existing value objects (Title, Author, MarkdownContent) are reused. `ContentSource` is a CLI-specific type, not a domain value object. |
| 9. Repositories for full aggregates | N/A | No repositories in this feature. |

---

## 3. Detailed Design

### 3.1 Content Reader: `src/infrastructure/cli/content-reader.ts`

This module handles CLI-specific I/O: reading content from a file path or from a stdin stream. It is infrastructure, not entrypoint logic.

```typescript
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";

export type ContentSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

export async function readContent(
  source: ContentSource,
  stdin: Readable,
): Promise<string> {
  switch (source.kind) {
    case "file":
      return readFile(source.path, "utf-8");
    case "stdin":
      return readStream(stdin);
  }
}

function readStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}
```

File read errors (ENOENT, EACCES) propagate as exceptions. The entrypoint catches them and maps to exit code 1.

### 3.2 CLI Adapter: `src/application/cli.ts`

This module is a pure translation layer. It owns three responsibilities:

1. **Parse arguments** from an argv array into a dedicated `CliArgs` type
2. **Resolve content source** from parsed args and TTY state into a `ContentSource`
3. **Map results** to exit codes and stderr messages

It does NOT perform I/O. Content reading is delegated to the injected `readContent` function.

```
argv --> parseArgs() --> CliArgs
                            |
                            v
       resolveContentSource(args, isTTY) --> ContentSource
                            |
                            v
           readContent(source) --> string   (injected, from infra)
                            |
                            v
           Title.create(), Author.create(), MarkdownContent.create()
           devices.resolve()
                            |
                            v
           service.execute() --> Result<DeliverySuccess, DomainError>
                            |
                            v
           mapErrorToExitCode() --> exit code (0-3)
           formatOutput()       --> stderr message
```

#### Input Types

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

#### Content Source Resolution

After parsing args, the entrypoint resolves which content source was selected:

```typescript
function resolveContentSource(
  args: CliArgs,
  isTTY: boolean,
): ContentSource | "missing" {
  if (args.filePath !== undefined) {
    return { kind: "file", path: args.filePath };
  }
  if (!isTTY) {
    return { kind: "stdin" };
  }
  return "missing";
}
```

If the result is `"missing"`, the entrypoint exits with code 1 and a usage message. The `ContentSource` type makes the file-vs-stdin branching explicit in the type system rather than scattering it as conditionals.

#### Run Function

The entrypoint exports a single `run` function that receives all dependencies:

```typescript
interface CliDeps {
  readonly service: Pick<SendToKindleService, "execute">;
  readonly devices: DeviceRegistry;
  readonly defaultAuthor: string;
  readonly argv: ReadonlyArray<string>;
  readonly isTTY: boolean;
  readonly readContent: (source: ContentSource, stdin: Readable) => Promise<string>;
  readonly stdin: Readable;
  readonly stderr: (message: string) => void;
}

async function run(deps: CliDeps): Promise<number>  // returns exit code
```

This makes the entrypoint fully testable without mocking modules or global state. The shell constructs these dependencies and passes them in.

#### Argument Parsing

Manual `process.argv` parsing. The CLI has only five flags (`--title`, `--file`, `--author`, `--device`, `--help`). No subcommands, no positional arguments, no complex parsing needed. Adding a dependency like `commander` for five flags violates proportionality.

Parsing errors (missing `--title`, unknown flags) produce exit code 1 with a usage message on stderr.

#### Exit Code Mapping (Entrypoint-Level)

These are domain errors returned by `service.execute()` as `Result` values:

| DomainError.kind | Exit code | Meaning |
|---|---|---|
| `validation` | 1 | Invalid input (missing title, empty content, unknown device) |
| `size_limit` | 1 | Content exceeds size limit |
| `conversion` | 2 | EPUB generation failed |
| `delivery` | 3 | SMTP auth, connection, or rejection failure |

The mapping function is exhaustive via a `switch` on `error.kind` with a `never` default, matching the pattern in `tool-handler.ts`.

File I/O errors (ENOENT, EACCES from `readContent`) are caught and mapped to exit code 1, since they represent invalid user input.

#### Output

All output goes to stderr. Stdout is not used. This is intentional: it matches the existing logger convention (pino writes to fd 2) and keeps the CLI composable in pipelines.

- Success: `"Sent '<title>' to Kindle (<device>) -- <size> bytes"`
- Failure: `"Error: <message>"`
- Help: usage text

### 3.3 CLI Composition Root: `src/cli-entry.ts`

This file is pure shell. It wires dependencies and delegates to the CLI entrypoint's `run` function. It contains zero business logic, zero input translation, and zero output formatting.

```typescript
#!/usr/bin/env node

import dotenv from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { readContent } from "./infrastructure/cli/content-reader.js";
import { run } from "./application/cli.js";

// 1. Load .env (CWD first, then user home fallback)
dotenv.config();
dotenv.config({ path: join(homedir(), ".send-to-kindle", ".env") });

try {
  // 2. Load config (fail-fast)
  const config = loadConfig();
  const pinoLogger = createPinoLogger(config.logLevel);
  const deliveryLogger = createDeliveryLogger(pinoLogger);

  // 3. Wire dependencies
  const converter = new MarkdownEpubConverter();
  const mailer = new SmtpMailer({ sender: config.sender, smtp: config.smtp });
  const service = new SendToKindleService(converter, mailer, deliveryLogger);

  // 4. Delegate to entrypoint
  const exitCode = await run({
    service,
    devices: config.devices,
    defaultAuthor: config.defaultAuthor,
    argv: process.argv.slice(2),
    isTTY: process.stdin.isTTY === true,
    readContent,
    stdin: process.stdin,
    stderr: (msg) => process.stderr.write(msg + "\n"),
  });

  process.exit(exitCode);
} catch (error) {
  // 5. Shell-level errors (config failures)
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Configuration error: ${message}\n`);
  process.exit(4);
}
```

**Shell-level exit codes:**

| Error source | Exit code | Meaning |
|---|---|---|
| Config loading failure (missing env vars, invalid values) | 4 | Configuration error |

These errors never reach the entrypoint. They are caught and handled entirely in the shell.

The shebang line (`#!/usr/bin/env node`) is required for the `bin` field in package.json to work on Unix systems.

#### .env Resolution

The feature doc specifies two .env locations:
1. `.env` in the current working directory (existing behavior via `dotenv`)
2. `~/.send-to-kindle/.env` (new, for global CLI use)

Resolution order: CWD `.env` takes precedence (already loaded by `dotenv/config`). If a variable is still missing, load from `~/.send-to-kindle/.env` as a fallback. This is handled by calling `dotenv.config()` twice with different paths -- dotenv does not overwrite existing values by default.

### 3.4 Package.json Changes

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

### 3.5 Claude Code Skill: `.claude/skills/send-to-kindle.md`

The skill file teaches Claude Code how to invoke the CLI. It is a markdown file with frontmatter that Claude Code reads when the user mentions "send to kindle".

Key design decisions:
- Use `npx send-to-kindle-cli` (not a global install) for zero-setup invocation
- Write content to a temp file rather than piping (avoids shell escaping issues with markdown)
- Include prerequisites section pointing to `--setup` or manual `.env` creation
- Keep the skill concise -- Claude Code works better with focused instructions

### 3.6 Device Resolution: Trade-off Documentation

Both the MCP entrypoint (`tool-handler.ts`) and the CLI entrypoint (`cli.ts`) independently call `devices.resolve(name)` before passing the result to `service.execute()`. This is duplicated orchestration.

**Alternative considered:** Move device resolution into `SendToKindleService` by accepting a raw device name string and injecting `DeviceRegistry` as a constructor dependency. This would eliminate the duplication but would change the service interface: `execute` would accept a raw string instead of a validated `KindleDevice` value object, weakening the type contract.

**Decision:** Keep device resolution in the entrypoints. The duplication is two lines of code in each entrypoint and follows the established pattern. The service maintains its clean contract of accepting only validated domain types. Each entrypoint owns its own input-to-domain translation, which is consistent with SoC-006 (entrypoints translate external input to domain types).

### 3.7 What Is Explicitly Out of Scope

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
  +--> infrastructure/cli/content-reader.ts (readContent)
  +--> domain/send-to-kindle-service.ts (SendToKindleService)
  +--> application/cli.ts (run)

application/cli.ts (entrypoint)
  |
  +--> domain/values/ (Title, Author, MarkdownContent)
  +--> domain/device-registry.ts (DeviceRegistry) -- type only, instance injected
  +--> domain/errors.ts (DomainError)
  +--> No I/O imports (fs, process) -- all injected via CliDeps

infrastructure/cli/content-reader.ts (platform/infra/cli)
  |
  +--> node:fs/promises (readFile)
  +--> node:stream (Readable)
```

No circular dependencies. Domain remains pure. Infrastructure remains unchanged. The entrypoint has no direct I/O dependencies -- all I/O is injected.

---

## 5. Testing Strategy

### 5.1 CLI Adapter Unit Tests

Test `cli.ts` by passing fake dependencies via the `CliDeps` interface. No module mocking required.

- **parseArgs**: Test flag combinations, missing required flags, unknown flags, help flag
- **resolveContentSource**: Test file path present, stdin detected (isTTY=false), neither available (isTTY=true, no file)
- **mapErrorToExitCode**: Test each DomainError kind maps to the correct exit code (exhaustive)
- **run (integration)**: Pass a fake service, fake readContent, and verify end-to-end: args in, exit code + stderr message out

### 5.2 Content Reader Unit Tests

Test `content-reader.ts` independently:

- **readContent with file source**: Read a real temp file, verify content returned
- **readContent with stdin source**: Provide a readable stream with known data, verify content returned
- **readContent with missing file**: Verify ENOENT error propagates

### 5.3 CLI Integration Test

Run the built CLI binary as a child process with a mocked SMTP server (or with the service mocked at the config level). Verify:
- Exit code 0 on success
- Exit code 1 on missing `--title`
- Exit code 1 on missing content (no file, TTY stdin)
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
