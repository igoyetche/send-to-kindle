# PB-004 Critique: CLI Version + Claude Code Skill

Reviewed: docs/designs/cli-version/refined.md

## CRITICAL

### 1. The `run` function in cli.ts is NOT a thin entrypoint -- it orchestrates a write operation

- **What's wrong:** The `run` function in `cli.ts` does far more than translate between external and internal formats. It: parses args, resolves content source, reads content (via injected function), creates value objects, resolves devices, invokes the service, and maps results. Steps 3-6 (read content, create value objects, resolve device, call service) constitute orchestration of a write operation with side effects. This is a command (SoC-001 Q3), not just input translation (Q2). The entrypoint is doing the job of a command while being labeled as an entrypoint.
- **Why it matters:** SoC-006 says entrypoints are thin translation layers: "parse external input, invoke command/query, map result to external response. Nothing else." The `run` function is doing everything: I/O coordination, domain object construction, device resolution, service invocation. Compare with `tool-handler.ts` which has the same problem -- but the design explicitly models the CLI after it, so it inherits the violation rather than fixing it.
- **Suggested fix:** This is a judgment call. For a project this small (one feature, two entrypoints), the pragmatic answer is to accept it. But the design should acknowledge this is a known SoC-006 tension rather than marking it PASS. If a third entrypoint were added, the repeated value-object-creation + device-resolution + service-call sequence would warrant extracting a command. For now, document the trade-off honestly.

### 2. `cli.ts` entrypoint directly imports domain types -- SoC-002 violation

- **What's wrong:** The SoC-002 access rules table says entrypoint/ is forbidden from depending on domain/ and platform/domain/. The refined design's dependency graph shows `application/cli.ts` importing from `domain/values/`, `domain/device-registry.ts`, and `domain/errors.ts`. These are all domain imports. The self-audit marks SoC-002 as PASS.
- **Why it matters:** If the project follows the SoC framework, entrypoints should depend on commands/queries which depend on domain. The entrypoint should invoke a command, not construct domain objects directly. The audit claims PASS on a rule it is violating.
- **Suggested fix:** Either (a) acknowledge the deviation and explain why it is acceptable for this project size, or (b) extract the value-object-creation + service-invocation into a proper command that both entrypoints call. Option (a) is pragmatic; option (b) is pure. The worst option is claiming PASS when the rule is violated.

## HIGH

### 3. stdin hang risk -- no timeout on stdin reading

- **What's wrong:** When `isTTY` is false (piped input), the `readStream` function reads until EOF. If the upstream process hangs or never closes the pipe, the CLI will hang indefinitely with no feedback. There is no timeout and no progress indicator.
- **Why it matters:** In production, a user who accidentally runs `send-to-kindle --title "Test"` in a non-TTY context (e.g., inside a script where stdin is inherited but empty, or a CI environment) will see the process hang with no output. The `isTTY` heuristic is imperfect -- some environments report `isTTY === undefined` rather than `true`.
- **Suggested fix:** Add a configurable timeout (e.g., 30 seconds) to the stdin reader. After the timeout, emit a stderr message ("No input received on stdin after 30s. Did you mean to use --file?") and exit with code 1. This is a one-line `setTimeout` in the `readStream` function.

### 4. Empty stdin produces a confusing error path

- **What's wrong:** If stdin is piped but empty (e.g., `echo -n "" | send-to-kindle --title "Test"`), the content reader returns an empty string. This flows into `MarkdownContent.create("")` which returns a validation error. The user sees "The 'content' parameter is required and must be non-empty" -- a domain error message that does not mention stdin or files.
- **Why it matters:** The error is technically correct but confusing. The user piped something (or nothing) and gets a domain validation error. A better UX would detect empty content at the entrypoint level and emit a CLI-specific message ("No content received from stdin. Pipe markdown content or use --file.").
- **Suggested fix:** After `readContent` returns, check for empty string in the entrypoint before passing to `MarkdownContent.create`. Emit a CLI-friendly error message. This is a one-line check.

### 5. The skill file references features that do not exist

- **What's wrong:** Section 3.5 says the skill file should include a `--url` example and reference `--setup`. The feature doc also shows `--url` usage. But section 3.7 explicitly says both `--url` and `--setup` are out of scope. The skill file will reference capabilities that do not exist at launch.
- **Why it matters:** When Claude Code reads the skill and tries to invoke `--url` or `--setup`, it will fail. Claude Code does not distinguish between "documented but not yet built" and "available."
- **Suggested fix:** The skill file must only document what is implemented. Remove `--url` and `--setup` references from the skill design. Add them when those features ship.

### 6. npm package name mismatch

- **What's wrong:** The package.json currently has `"name": "send-to-kindle-mcp"`. The design proposes the `bin` field uses `"send-to-kindle"` as the command name, and the feature doc references `npx send-to-kindle-cli`. The design does not address whether the package is renamed, whether a separate package is published, or whether `npx send-to-kindle-mcp` would work. Three different names appear across the documents: `send-to-kindle-mcp` (current), `send-to-kindle-cli` (feature doc), and `send-to-kindle` (bin command).
- **Why it matters:** If the package stays named `send-to-kindle-mcp`, users must run `npx send-to-kindle-mcp` to get the binary. The skill file says `npx send-to-kindle-cli`. These will not work unless the package is renamed or a separate package is created. This is a real deployment blocker.
- **Suggested fix:** Decide on one package name. Document it explicitly in the design. If the CLI and MCP server ship in the same package, the npx command uses the current package name. If they ship separately, design the split.

## MEDIUM

### 7. `process.stdin.isTTY` is `boolean | undefined`, not `boolean`

- **What's wrong:** The `CliDeps` interface declares `isTTY: boolean`. But `process.stdin.isTTY` is `boolean | undefined` in Node.js typings. The shell code does `process.stdin.isTTY === true` which coerces correctly, but the type declaration hides the fact that `undefined` is a real runtime value that means "I don't know if this is a TTY."
- **Why it matters:** The design treats `isTTY === false` and `isTTY === undefined` identically (both mean "read stdin"). This is correct for most cases but could surprise in edge cases (e.g., a detached process where stdin is not connected at all). The type signature should reflect the actual values.
- **Suggested fix:** Either keep `isTTY: boolean` and document that `undefined` is coerced to `false` at the shell boundary (acceptable), or use `isTTY: boolean | undefined` and handle it explicitly in `resolveContentSource`. Minor issue, but the design should acknowledge it.

### 8. dotenv.config() error handling is absent

- **What's wrong:** The shell calls `dotenv.config()` twice. If the home directory `.env` file exists but has a syntax error, dotenv silently ignores it (returns `{ error: ... }` but does not throw). The design does not check the return value.
- **Why it matters:** A malformed `.env` file in `~/.send-to-kindle/.env` will silently produce missing variables, which will then fail at config loading with a confusing "Missing required environment variable" error. The user will not know their `.env` file has a syntax error.
- **Suggested fix:** Check the return value of the second `dotenv.config()` call. If it returns an error and the file exists, emit a warning to stderr. This is defensive but improves debuggability.

### 9. ContentSource type lives in the wrong module

- **What's wrong:** The refined design places `ContentSource` in `infrastructure/cli/content-reader.ts`. The `resolveContentSource` function in `application/cli.ts` returns a `ContentSource`. This means the entrypoint imports a type from infrastructure. SoC-012 access rules say entrypoint/ can access `cli/` infrastructure, so this is technically allowed. But it creates a coupling where the entrypoint's logic (resolving which source to use) is shaped by an infrastructure type.
- **Why it matters:** If the content reader changes its type (e.g., adds a "url" kind), the entrypoint must update its resolution logic. This coupling is acceptable for this project size but is worth noting.
- **Suggested fix:** No code change needed. Just acknowledge in the design that the entrypoint depends on this infrastructure type by design, and that this is an acceptable coupling for a thin CLI.

### 10. The design does not address SIGINT / SIGTERM handling

- **What's wrong:** The CLI may be interrupted mid-operation (Ctrl+C during EPUB conversion or SMTP delivery). The design does not mention signal handling. The SMTP connection may be left in an indeterminate state.
- **Why it matters:** For a CLI tool, graceful shutdown is expected. An interrupted SMTP connection could leave a partial email in the server queue (unlikely with modern SMTP but possible). More importantly, nodemailer may print unhandled promise rejection warnings on SIGINT.
- **Suggested fix:** Add a brief note in the risk assessment about signal handling. For MVP, letting Node.js default signal handling kill the process is fine. But the mailer's SMTP connection should ideally be closed on exit. Could be a follow-up.

### 11. No `--version` flag

- **What's wrong:** The CLI defines `--title`, `--file`, `--author`, `--device`, `--help` but no `--version`. Every CLI tool should support `--version`.
- **Why it matters:** Users and scripts need to check which version is installed. This is a standard CLI convention.
- **Suggested fix:** Add `--version` to the arg parser. Read version from package.json at build time or hardcode it. Trivial addition.

## LOW

### 12. Self-audit is too generous -- multiple rules marked PASS that deserve PASS-WITH-CAVEATS

- **What's wrong:** The SoC and DDD audits mark everything PASS or N/A. No caveats, no tensions, no trade-offs documented in the audit tables themselves. The device resolution trade-off is documented separately (section 3.6) but the audit table for DDD-3 just says "PASS."
- **Why it matters:** A self-audit that finds zero issues is either perfect or not thorough enough. Given the findings above (SoC-002 violation, SoC-006 tension), the audit is not accurate.
- **Suggested fix:** Add a "PASS*" status with footnotes for rules where the design makes a conscious trade-off. This makes the audit honest rather than performative.

### 13. Testing strategy does not cover the shebang / bin integration

- **What's wrong:** The integration test section says "Run the built CLI binary as a child process." But it does not specify testing the `npm link` or `npx` path, which involves the `bin` field in package.json, the shebang line, and the `dist/` output. These are the actual deployment mechanism.
- **Why it matters:** The bin/shebang integration is a common source of bugs, especially cross-platform. A test that runs `node dist/cli-entry.js` is not the same as testing `npx send-to-kindle-cli`.
- **Suggested fix:** Add one integration test that runs the CLI via `npm exec` or `npx` to verify the bin wiring works end-to-end.

### 14. The design says "all output to stderr" but does not discuss structured output

- **What's wrong:** Section 3.2 says "All output goes to stderr. Stdout is not used." This is fine for human consumption, but the design does not address whether the CLI should support `--json` or `--quiet` flags for machine consumption. The pino logger also writes to stderr, meaning CLI output and log output are intermixed on the same stream.
- **Why it matters:** If a script invokes the CLI and needs to parse the result, it cannot distinguish between CLI output ("Sent 'Title' to Kindle...") and pino log lines (`{"level":30,...}`). The streams are mixed.
- **Suggested fix:** For MVP, this is fine. But document that log output and CLI output share stderr, and that a `--quiet` or `--json` flag may be needed in future. Alternatively, suppress pino output in CLI mode (set log level to "silent" unless `--verbose` is passed).

### 15. Missing consideration: large file streaming

- **What's wrong:** The `readContent` function reads the entire file into memory as a string. `MarkdownContent.MAX_BYTES` is 25 MB. For a 25 MB markdown file, Node.js will allocate at least 50 MB (UTF-16 internal representation) plus the EPUB buffer. This is fine for typical use but the design does not mention memory.
- **Why it matters:** Low risk. 25 MB markdown files are rare. But the design should at least acknowledge the memory profile.
- **Suggested fix:** Add a one-line note in the risk assessment: "Content is read fully into memory. The 25 MB limit keeps memory usage bounded."

## Summary

The most important issues to address before implementation:

1. **Be honest about the SoC-002 and SoC-006 tensions** (Critical #1, #2). The entrypoint does more than translate -- it orchestrates. And it imports domain types directly. The design can keep this approach (it is pragmatic for the project size) but must not claim these audit rules PASS cleanly. Mark them as conscious trade-offs.

2. **Fix the npm package name confusion** (High #6). Three different names across three documents is a deployment blocker. Pick one.

3. **Remove non-existent features from the skill file design** (High #5). The skill file must only reference implemented capabilities.

4. **Add stdin timeout** (High #3). A hanging CLI with no output is a bad user experience. One `setTimeout` fixes it.

5. **Add `--version`** (Medium #11). Standard CLI convention, trivial to implement.

6. **Address log/output stream mixing** (Low #14). Pino and CLI messages sharing stderr will confuse scripts. Consider suppressing logs in CLI mode.
