# CLI Version + Claude Code Skill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a CLI entry point to the existing send-to-kindle system so users can send markdown content to Kindle directly from the terminal via `paperboy --title "Title" --file notes.md`. Includes a Claude Code skill file for AI-assisted invocation.

**Architecture:** The domain and infrastructure layers are transport-agnostic and require zero changes. Two new infrastructure functions handle file/stdin reading. A new CLI adapter (`src/application/cli.ts`) translates argv into domain calls and maps results to exit codes. A new composition root (`src/cli-entry.ts`) wires dependencies and delegates to the adapter. The package is renamed from `send-to-kindle-mcp` to `paperboy`.

**Tech Stack:** TypeScript (strict), Vitest, existing domain/infra/application layers. No new npm packages.

**ADR:** `docs/designs/cli-version/adr.md`

---

## Task Status Legend

`[ ]` Todo | `[~]` In progress | `[x]` Done (date) | `[-]` Dropped | `[!]` Blocked

---

## Task 1: Add content reader infrastructure with file size guard `[x]` (2026-03-17)

### Deliverable: Two infrastructure functions that read content from a file path or stdin stream

### Context

The CLI adapter needs to read markdown content from either a file or stdin. Per the ADR (decision #2), these are two separate primitive functions in infrastructure — `readFromFile(path: string)` and `readFromStdin(stream: Readable)`. The entrypoint owns the `ContentSource` type and decides which to call.

Per ADR decision #6, stdin reading must have a 30-second timeout. Per ADR decision #8, file reading must reject files > 25 MB before reading into memory. The 25 MB limit matches `MarkdownContent.MAX_BYTES`.

### Key Decisions and Principles

- Two separate functions, not one function with a union parameter — avoids cross-layer type coupling (ADR decision #2)
- `readFromFile` checks file size via `fs.stat()` before reading — rejects files > 25 MB with a descriptive error (ADR decision #8)
- `readFromStdin` has a 30-second timeout — emits a helpful error if no input received (ADR decision #6)
- File read errors (ENOENT, EACCES) propagate as exceptions — the entrypoint catches and maps them
- Both functions return `Promise<string>` — plain strings, not domain types

### Delivers

`src/infrastructure/cli/content-reader.ts` with two exported functions that the CLI composition root can inject into the CLI adapter.

### Acceptance Criteria

- Given a valid file path with content "# Hello" When `readFromFile(path)` is called Then it returns the string "# Hello"
- Given a file path that does not exist When `readFromFile(path)` is called Then it throws an error with code ENOENT
- Given a file path with permission denied When `readFromFile(path)` is called Then it throws an error with code EACCES
- Given a file larger than 25 MB When `readFromFile(path)` is called Then it throws an error with message containing "25 MB"
- Given a file exactly 25 MB When `readFromFile(path)` is called Then it reads and returns the content successfully
- Given a readable stream that emits "# Hello" and ends When `readFromStdin(stream)` is called Then it returns "# Hello"
- Given a readable stream that emits nothing for 30 seconds When `readFromStdin(stream)` is called Then it rejects with a timeout error message mentioning "--file"
- Given a readable stream that emits data then ends before 30 seconds When `readFromStdin(stream)` is called Then it returns the data and clears the timeout

### Dependencies

None. This task has no dependencies on other tasks.

### Related Code

- `src/domain/values/markdown-content.ts` — `MarkdownContent.MAX_BYTES = 25 * 1024 * 1024` is the size limit to match
- `src/infrastructure/converter/markdown-epub-converter.ts` — example of infrastructure module pattern
- `test/infrastructure/converter/markdown-epub-converter.test.ts` — example of infrastructure test pattern

### Verification

```bash
npx vitest run test/infrastructure/cli/content-reader.test.ts
npx tsc --noEmit
```

### Files

- Create: `src/infrastructure/cli/content-reader.ts`
- Create: `test/infrastructure/cli/content-reader.test.ts`

---

## Task 2: Add CLI argument parser and exit code mapping `[x]` (2026-03-17)

### Deliverable: `parseArgs` function that converts argv into `CliArgs`, `resolveContentSource` that determines file vs stdin, and `mapErrorToExitCode` for domain error to exit code translation

### Context

The CLI adapter (`src/application/cli.ts`) needs to parse `process.argv` into a structured type and map domain errors to CLI exit codes. Per ADR decision #4, this is manual argv parsing for 6 flags: `--title`, `--file`, `--author`, `--device`, `--version`, `--help`. No external dependency needed.

Per ADR decision #5, exit codes are split by error source:
- Entrypoint-level: validation/size = 1, conversion = 2, delivery = 3, success = 0
- Shell-level (config) = 4 is handled in `cli-entry.ts`, not here

Per ADR decision #7, empty content after reading is caught at the entrypoint level with a CLI-friendly message before hitting domain validation.

### Key Decisions and Principles

- `parseArgs` takes `ReadonlyArray<string>` (already sliced, no `process.argv[0]`/`[1]`) — returns `CliArgs | ParseError`
- `ContentSource` is a discriminated union owned by this module: `{ kind: "file", path: string } | { kind: "stdin" }`
- `resolveContentSource(args, isTTY)` returns `ContentSource | "missing"` — "missing" triggers exit code 1 with usage message
- `mapErrorToExitCode` uses exhaustive switch on `DomainError.kind` with `never` default — matches `tool-handler.ts` pattern
- `formatOutput` produces stderr messages: success confirmation or error details
- `--help` prints usage text and returns exit code 0
- `--version` reads version from package.json and returns exit code 0
- Unknown flags produce exit code 1 with usage hint

### Delivers

Pure functions in `src/application/cli.ts` for argument parsing, content source resolution, exit code mapping, and output formatting. These are tested independently before wiring into the `run` function.

### Acceptance Criteria

**parseArgs:**
- Given `["--title", "Test", "--file", "notes.md"]` When parsed Then returns `{ title: "Test", filePath: "notes.md", author: undefined, device: undefined, help: false, version: false }`
- Given `["--title", "Test", "--author", "Team", "--device", "partner"]` When parsed Then returns all fields populated
- Given `["--help"]` When parsed Then returns `{ help: true, ... }`
- Given `["--version"]` When parsed Then returns `{ version: true, ... }`
- Given `[]` (empty argv) When parsed Then returns a ParseError with message about missing --title
- Given `["--title"]` (flag without value) When parsed Then returns a ParseError
- Given `["--unknown", "value"]` When parsed Then returns a ParseError mentioning unknown flag

**resolveContentSource:**
- Given `filePath: "notes.md"` When resolved Then returns `{ kind: "file", path: "notes.md" }`
- Given `filePath: undefined, isTTY: false` When resolved Then returns `{ kind: "stdin" }`
- Given `filePath: undefined, isTTY: true` When resolved Then returns `"missing"`

**mapErrorToExitCode:**
- Given ValidationError When mapped Then returns 1
- Given SizeLimitError When mapped Then returns 1
- Given ConversionError When mapped Then returns 2
- Given DeliveryError When mapped Then returns 3
- Given all DomainError kinds Then mapping is exhaustive (TypeScript enforces via never)

**formatOutput:**
- Given a successful result `{ title: "Test", sizeBytes: 1024, deviceName: "personal" }` When formatted Then returns string containing "Test", "personal", and "1024"
- Given a DomainError When formatted Then returns string starting with "Error:"

### Dependencies

None. These are pure functions with no I/O.

### Related Code

- `src/application/tool-handler.ts` — parallel adapter; `mapErrorToResponse` is the equivalent of `mapErrorToExitCode`
- `src/domain/errors.ts` — `DomainError` union type and `Result` helpers
- `test/application/tool-handler.test.ts` — test pattern for adapter tests

### Verification

```bash
npx vitest run test/application/cli.test.ts
npx tsc --noEmit
```

### Files

- Create: `src/application/cli.ts` (parseArgs, resolveContentSource, mapErrorToExitCode, formatOutput, types)
- Create: `test/application/cli.test.ts`

---

## Task 3: Add CLI `run` function with dependency injection `[x]` (2026-03-17)

### Deliverable: The `run` function that wires parsing, content reading, value object creation, device resolution, service invocation, and result mapping into a single orchestration flow

### Context

The `run` function is the core of the CLI adapter. Per ADR decision #3, it receives all dependencies via a `CliDeps` interface and returns an exit code. This makes it fully testable without module mocking — just pass fake deps.

Per ADR decisions #7 and #8, the `run` function checks for empty content after reading (CLI-friendly error) and delegates file size checking to the injected `readFromFile`.

### Key Decisions and Principles

- `run(deps: CliDeps): Promise<number>` — returns exit code, never calls `process.exit`
- `CliDeps` includes: service, devices, defaultAuthor, argv, isTTY, readFromFile, readFromStdin, stdin, stderr
- Orchestration order: parse args → check help/version → resolve content source → read content → check empty → create value objects → resolve device → call service → map result
- File I/O errors (ENOENT, EACCES, size limit) are caught and mapped to exit code 1 with CLI-friendly messages
- Empty content check happens before `MarkdownContent.create()` — produces "No content received" message
- Device resolution uses `devices.resolve(name)` — same pattern as `tool-handler.ts`
- All stderr output goes through the injected `stderr` function

### Delivers

The `run` function exported from `src/application/cli.ts` that can be called by the composition root.

### Acceptance Criteria

- Given valid args and a successful service result When `run` is called Then it returns 0 and writes success message to stderr
- Given `--help` flag When `run` is called Then it returns 0 and writes usage text to stderr
- Given `--version` flag When `run` is called Then it returns 0 and writes version to stderr
- Given missing `--title` When `run` is called Then it returns 1 and writes error to stderr
- Given `--file` pointing to nonexistent file When `run` is called Then it returns 1 and writes "not found" message to stderr
- Given `--file` pointing to file > 25 MB When `run` is called Then it returns 1 and writes size limit message to stderr
- Given empty stdin content When `run` is called Then it returns 1 and writes "No content received" to stderr (not the domain validation message)
- Given stdin with no `--file` and `isTTY: true` When `run` is called Then it returns 1 and writes message about using `--file` or piping
- Given a service that returns ConversionError When `run` is called Then it returns 2
- Given a service that returns DeliveryError When `run` is called Then it returns 3
- Given `--device partner` and device exists When `run` is called Then service is called with the resolved device
- Given `--device unknown` and device does not exist When `run` is called Then it returns 1 with error listing available devices
- Given no `--author` flag When `run` is called Then service is called with the default author from deps

### Dependencies

- Task 1 (content reader) — `readFromFile` and `readFromStdin` signatures must be defined
- Task 2 (parser and mapping) — `parseArgs`, `resolveContentSource`, `mapErrorToExitCode`, `formatOutput` must exist

### Related Code

- `src/application/tool-handler.ts:handle()` — parallel orchestration in MCP adapter; same sequence of validate → resolve device → call service → map result
- `src/domain/send-to-kindle-service.ts` — the service being invoked
- `test/application/tool-handler.test.ts` — test helpers (`fakeService`, `makeRegistry`, `makeDevice`)

### Verification

```bash
npx vitest run test/application/cli.test.ts
npx tsc --noEmit
```

### Files

- Modify: `src/application/cli.ts` (add `run` function, `CliDeps` interface)
- Modify: `test/application/cli.test.ts` (add `run` integration tests)

---

## Task 4: Add CLI composition root and dotenv fallback `[x]` (2026-03-17)

### Deliverable: `src/cli-entry.ts` — the shell that wires dependencies and calls `run`, with dual .env loading and silent pino

### Context

The CLI composition root mirrors `src/index.ts` but routes through the CLI adapter instead of MCP. Per ADR decision #9, pino is set to "silent" in CLI mode to prevent log/output mixing on stderr. Per ADR decision #11, the second `dotenv.config()` call checks for parse errors and warns on stderr.

Per ADR decision #10, `process.stdin.isTTY` is coerced to `boolean` at this boundary.

### Key Decisions and Principles

- Shebang line `#!/usr/bin/env node` required for bin field
- Load `.env` from CWD first, then `~/.paperboy/.env` as fallback (dotenv doesn't overwrite)
- Check return value of fallback `dotenv.config()` — warn on stderr if file exists but has errors
- Config errors caught at shell level → exit code 4
- Pino log level set to `"silent"` — no log output in CLI mode
- `process.stdin.isTTY === true` coerces `undefined` to `false`
- Shell calls `run()`, gets exit code, calls `process.exit(exitCode)`

### Delivers

A working CLI entry point that can be invoked with `node dist/cli-entry.js` or via the `bin` field.

### Acceptance Criteria

- Given valid .env in CWD and valid args When `cli-entry.ts` is executed Then it exits with the code returned by `run`
- Given missing required env vars When `cli-entry.ts` is executed Then it prints "Configuration error: ..." to stderr and exits with code 4
- Given `.env` in CWD missing SMTP_HOST but `~/.paperboy/.env` has it When executed Then config loads successfully (fallback works)
- Given `~/.paperboy/.env` has a syntax error When executed Then a warning is printed to stderr but execution continues
- Given the script is run When pino logger is created Then log level is "silent"
- Given `process.stdin.isTTY` is `undefined` When `isTTY` is passed to `run` Then it is `false`

### Dependencies

- Task 3 (`run` function must exist and accept `CliDeps`)

### Related Code

- `src/index.ts` — MCP composition root; same dependency wiring pattern
- `src/infrastructure/config.ts:loadConfig()` — config loading that throws on failure
- `src/infrastructure/logger.ts:createPinoLogger()` — accepts log level string

### Verification

```bash
npx tsc --noEmit
# Manual test:
npx tsx src/cli-entry.ts --help
npx tsx src/cli-entry.ts --version
```

### Files

- Create: `src/cli-entry.ts`

---

## Task 5: Rename package to `paperboy` and wire bin field `[x]` (2026-03-17)

### Deliverable: package.json updated with new name, bin field, and cli script

### Context

Per ADR decision #1, the package is renamed from `send-to-kindle-mcp` to `paperboy`. The `bin` field maps the `paperboy` command to `dist/cli-entry.js`. A `cli` script enables local dev via `npm run cli`.

### Key Decisions and Principles

- Package name: `paperboy`
- Bin command: `paperboy` → `./dist/cli-entry.js`
- New script: `"cli": "tsx src/cli-entry.ts"` for local dev
- Existing scripts unchanged
- Update any references to the old package name in code/docs

### Delivers

A package that can be installed globally (`npm install -g paperboy`) or run via `npx paperboy`.

### Acceptance Criteria

- Given `package.json` When read Then `name` is `"paperboy"`
- Given `package.json` When read Then `bin.paperboy` is `"./dist/cli-entry.js"`
- Given `npm run cli -- --help` When executed Then prints usage text
- Given `npm run build` followed by `node dist/cli-entry.js --help` When executed Then prints usage text
- Given the built package When `npm link` is run and `paperboy --help` is executed Then it prints usage text

### Dependencies

- Task 4 (`cli-entry.ts` must exist)

### Related Code

- `package.json` — current config
- `Dockerfile` — may reference package name (check)
- `docker-compose.yml` — may reference package name (check)
- `src/index.ts` — MCP server name string
- `CLAUDE.md` — project documentation

### Verification

```bash
npm run build
node dist/cli-entry.js --help
npm run cli -- --help
npx tsc --noEmit
```

### Files

- Modify: `package.json`
- Modify: any files referencing `send-to-kindle-mcp` as the package name

---

## Task 6: Add Claude Code skill file `[x]` (2026-03-17)

### Deliverable: `.claude/skills/paperboy/SKILL.md` that teaches Claude Code how to invoke the CLI

### Context

Per ADR decision #12, the skill file only documents implemented flags (`--title`, `--file`, `--author`, `--device`). No references to `--url` or `--setup`. The skill enables any Claude Code session to send content to Kindle without running an MCP server.

### Key Decisions and Principles

- Skill name: `paperboy`
- Only document implemented capabilities — no `--url`, no `--setup`
- Use `npx paperboy` for zero-install invocation
- Recommend writing content to a temp file (avoids shell escaping issues)
- Include prerequisites: `.env` file with SMTP and Kindle configuration
- Keep the skill concise — Claude Code works better with focused instructions

### Delivers

A skill file that Claude Code can read when the user asks to send content to Kindle.

### Acceptance Criteria

- Given the skill file When read by Claude Code Then it contains instructions for `--title`, `--file`, `--author`, `--device` flags only
- Given the skill file When searched for `--url` or `--setup` Then no matches are found
- Given the skill file When read Then it uses `npx paperboy` as the invocation command
- Given the skill file When read Then it includes a prerequisites section about .env configuration

### Dependencies

- Task 5 (package name must be finalized as `paperboy`)

### Related Code

- `.claude/skills/` — existing skill file patterns
- `docs/designs/cli-version/adr.md` — decision #12

### Verification

Visual inspection. The skill file is documentation, not code.

### Files

- Create: `.claude/skills/paperboy/SKILL.md`

---

## Task 7: Add bin integration test `[x]` (2026-03-17)

### Deliverable: An integration test that runs the CLI binary via `npm exec` to verify the bin wiring works end-to-end

### Context

Per accepted critique finding #13, the unit tests verify the `run` function but not the actual bin/shebang/package.json wiring. This test verifies the full path: `npm exec paperboy -- --help` works.

### Key Decisions and Principles

- Test runs the built binary as a child process
- Verifies exit code and stderr output
- Tests `--help` (no env vars needed), `--version`, and missing-title error
- Does NOT test actual SMTP delivery (that's covered by unit tests)

### Delivers

An integration test file that verifies the CLI binary works when invoked through npm's bin wiring.

### Acceptance Criteria

- Given the project is built When `node dist/cli-entry.js --help` is run as a child process Then exit code is 0 and stderr contains usage text
- Given the project is built When `node dist/cli-entry.js --version` is run as a child process Then exit code is 0 and stderr contains a version string
- Given the project is built and no env vars set When `node dist/cli-entry.js --title "Test" --file nonexistent.md` is run Then exit code is 4 (config error, no env vars)

### Dependencies

- Task 5 (package must be built with bin field)

### Related Code

- `test/` — existing test patterns
- `package.json` — bin field

### Verification

```bash
npm run build
npx vitest run test/integration/cli-binary.test.ts
```

### Files

- Create: `test/integration/cli-binary.test.ts`

---

## Task 8: Update specs and docs for CLI and rename `[x]` (2026-03-17)

### Deliverable: Updated main spec, STATUS.md, CHANGELOG.md, and CLAUDE.md reflecting the CLI addition and paperboy rename

### Context

Per the project's development workflow, specs must reflect what was actually built. The main spec needs a new section documenting the CLI as a second distribution path. STATUS.md needs to reflect completion. CHANGELOG.md needs entries for both the CLI addition and the rename.

### Key Decisions and Principles

- `docs/specs/main-spec.md` — add CLI section with flags, exit codes, .env resolution, skill reference
- `docs/STATUS.md` — mark CLI Version feature as complete
- `docs/CHANGELOG.md` — add entries for CLI feature and paperboy rename
- `CLAUDE.md` — update project name references, add CLI section
- Move feature doc from `features/backlog/` to `features/done/`
- Move plan from `plans/backlog/` (or `active/`) to `plans/done/`

### Delivers

All documentation reflects the system as it now exists, including the CLI entry point and the paperboy rename.

### Acceptance Criteria

- Given `docs/specs/main-spec.md` When read Then it documents CLI flags, exit codes, .env resolution order, and skill file
- Given `docs/STATUS.md` When read Then CLI Version is marked complete
- Given `docs/CHANGELOG.md` When read Then it has entries for CLI addition and paperboy rename with dates
- Given `docs/features/done/cli-version.md` When checked Then the feature doc has been moved from backlog
- Given `docs/plans/done/` When checked Then the plan has been moved from backlog/active
- Given `CLAUDE.md` When read Then project name references use "paperboy"

### Dependencies

- All previous tasks (docs reflect what was built)

### Related Code

- `docs/specs/main-spec.md` — current spec
- `docs/STATUS.md` — current status dashboard
- `docs/CHANGELOG.md` — current changelog
- `CLAUDE.md` — project documentation

### Verification

Visual inspection. Documentation task.

### Files

- Modify: `docs/specs/main-spec.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `CLAUDE.md`
- Move: `docs/features/backlog/cli-version.md` → `docs/features/done/cli-version.md`
- Move: `docs/plans/active/cli-version.md` → `docs/plans/done/cli-version.md`
