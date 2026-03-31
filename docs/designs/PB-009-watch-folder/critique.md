# Critique for PB-009-watch-folder

Reviewed: docs/designs/PB-009-watch-folder/design.md

## CRITICAL

### 1. Service installer executes shell commands as infrastructure -- security and reliability risk
- **What's wrong:** `service-installer.ts` generates config files and shells out to OS commands (`schtasks`, `launchctl`, `systemctl`). This is a huge surface area: escaping paths with spaces, handling permission errors, detecting whether the commands exist, dealing with localized OS error messages. The design treats this as a simple infrastructure wrapper but it is effectively a cross-platform deployment tool.
- **Why it matters:** A single unescaped space in `WATCH_FOLDER` or the node binary path breaks the service registration silently. Windows Task Scheduler XML, macOS plist XML, and systemd unit files each have different escaping rules. Testing this with unit tests that "generate correct config" is insufficient -- the actual shell invocations are untested.
- **Suggested fix:** Consider whether service installation belongs in this project at all. A simpler alternative: document how to register the service manually (3 one-liners per OS), or provide a shell script. If you keep it, this needs integration tests per platform and explicit path-escaping logic, not just config generation tests.

### 2. `paperboy watch` overloads the CLI entry point with a fundamentally different runtime model
- **What's wrong:** The design adds `paperboy watch`, `paperboy watch install`, `paperboy watch uninstall`, `paperboy watch status` as subcommands. The current CLI (`cli-entry.ts`) is a one-shot process: parse args, do one thing, exit. Adding a long-running process and subcommand routing to this entry point violates the single-responsibility of the current design. The existing `parseArgs` function rejects any token that doesn't start with `--`, so `watch` as a positional subcommand will fail with "Unexpected argument: 'watch'".
- **Why it matters:** Either `cli-entry.ts` needs substantial refactoring to support subcommands (breaking changes), or `watch-entry.ts` is a totally separate entry point. The design says `watch-entry.ts` is the composition root but also says `paperboy watch` is the CLI surface. These contradict -- which binary runs `paperboy watch`?
- **Suggested fix:** Clarify the routing. Either: (a) `paperboy watch` is handled by `cli-entry.ts` which detects the `watch` subcommand early and delegates to `watch-entry.ts` logic (requires arg parser rewrite), or (b) `paperboy-watch` is a separate binary entry point (add to `package.json` `bin`). Option (b) is simpler and avoids modifying the stable CLI path.

### 3. `sent/` and `error/` folders inside the watched directory create a chokidar ignore problem
- **What's wrong:** The design says "Non-recursive -- only watch the inbox root" and that `sent/` and `error/` live inside the inbox. But chokidar's non-recursive mode (`depth: 0`) still fires events for files created in subdirectories on some platforms. The design does not specify the chokidar `ignored` option to explicitly exclude these subdirectories.
- **Why it matters:** When a file is moved to `sent/` or `error/`, chokidar may fire an `add` event for the moved file, causing an infinite processing loop: file added to `error/` -> detected as new -> processed -> fails -> moved to `error/` -> detected again.
- **Suggested fix:** Explicitly specify `ignored: [path.join(inbox, 'sent'), path.join(inbox, 'error')]` in the chokidar config. Also filter by path in the event handler as defense in depth. This must be in the design, not left as an implementation detail.

## HIGH

### 4. No file locking or atomic move strategy
- **What's wrong:** The design says "On success: move file to inbox/sent/". On Windows, `fs.rename` across volumes fails (the inbox and sent/ should be same volume, but no guarantee). More critically, there is no protection against a partially-written file being detected during the `awaitWriteFinish` stability window if another process (e.g., a text editor) holds a lock on it.
- **Why it matters:** Windows file locking is aggressive. If VS Code or another editor has the file open, `fs.readFile` may succeed but `fs.rename` will fail with EPERM. The design's "File locked / unreadable -> retry on next watch cycle" handles read failures but not move failures after successful processing (file sent to Kindle but not moved out of inbox, causing re-send on next cycle).
- **Suggested fix:** Add explicit handling for "sent successfully but move failed" -- track processed files in memory (Set of paths) so they aren't re-processed. Also document that inbox should be on a single filesystem.

### 5. `application/watcher.ts` mixes orchestration with file system operations
- **What's wrong:** Per the design, `application/watcher.ts` does: detect new files, read file contents, derive title from H1, call service, move files, write error files. This is application-layer code doing I/O (reading files, moving files, writing error files). The existing `cli.ts` avoids this by injecting `readFromFile` and `readFromStdin` as dependencies.
- **Why it matters:** Violates the project's own pattern. The CLI adapter (`cli.ts`) receives all I/O through `CliDeps` and is fully testable. The watcher design doesn't define an equivalent dependency injection interface, making it harder to test without a real filesystem.
- **Suggested fix:** Define a `WatcherDeps` interface (similar to `CliDeps`) that injects: `readFile`, `moveFile`, `writeFile`, `watchFolder` functions. The watcher orchestrates through these injected dependencies. The design's "All tests use injected dependencies -- no actual file system" claim requires this but doesn't describe how.

### 6. Title extraction from H1 is domain logic placed in the application layer
- **What's wrong:** "Extract title from first H1 (fall back to filename)" is business logic -- it determines the document title from content. The design places this in `application/watcher.ts`. By the project's own layering rules, the application layer should not contain business logic; it should delegate to the domain.
- **Why it matters:** This logic will likely need to be shared (e.g., a future `paperboy send --auto-title` flag for CLI). Burying it in the watcher application layer means duplication.
- **Suggested fix:** Create a domain function like `extractTitle(content: string, fallback: string): Title` in the domain layer. The watcher and CLI both call it.

### 7. No retry strategy for transient SMTP failures
- **What's wrong:** The design moves files to `error/` on any SMTP failure. But SMTP failures are often transient (connection timeout, server busy). A single failure permanently moves the file to `error/`, requiring manual intervention.
- **Why it matters:** For a "install once and forget" service, requiring the user to manually move files back from `error/` to inbox on every transient network blip defeats the purpose.
- **Suggested fix:** Add a retry policy: retry transient failures (connection, timeout) N times with backoff. Only move to `error/` on permanent failures (auth, rejection) or after retries exhausted. Alternatively, leave failed files in inbox and track failure count in a sidecar file.

## MEDIUM

### 8. `infrastructure/cli/` is becoming a dumping ground for non-CLI infrastructure
- **What's wrong:** `folder-watcher.ts` and `service-installer.ts` are placed under `infrastructure/cli/`. The folder watcher and OS service installer have nothing to do with CLI I/O. They are being placed there because the existing `cli/` folder exists and "it's kind of related to the command line."
- **Why it matters:** Violates SoC-010 (co-locate by change) and SoC-015 (related names). A folder watcher does not change when CLI argument parsing changes. The `cli/` name no longer describes what the folder contains.
- **Suggested fix:** Place `folder-watcher.ts` in `infrastructure/watcher/` or `infrastructure/filesystem/`. Place `service-installer.ts` in `infrastructure/os-service/`. Keep `infrastructure/cli/` for CLI-specific I/O (content-reader.ts).

### 9. Duplicate filename collision strategy is underspecified
- **What's wrong:** "Append timestamp suffix: `my-article-2026-03-31T10-48.md`" -- this timestamp has minute precision. If two files with the same name are sent within the same minute, collision still occurs. Also, the design doesn't specify what happens if the timestamped name also collides.
- **Why it matters:** Edge case, but the whole point of specifying collision handling is to be robust. Minute-precision timestamps aren't unique.
- **Suggested fix:** Use ISO timestamp with seconds or milliseconds. Or use a counter suffix (my-article-1.md, my-article-2.md). Define behavior for the case where even the suffixed name exists.

### 10. No maximum error folder size or cleanup strategy
- **What's wrong:** Failed files accumulate in `error/` forever. Each failure produces two files (the original + an error.txt). Over months of unattended operation, this could grow large.
- **Why it matters:** For a "set and forget" service, unbounded disk growth in a watched folder is a real operational concern.
- **Suggested fix:** At minimum, document this as a known limitation. Optionally, add a configurable retention policy (delete error files older than N days) or a maximum count.

### 11. Graceful shutdown race condition
- **What's wrong:** "Listens for SIGINT and SIGTERM, finishes processing current file, then exits cleanly." But what if the signal arrives between "SendToKindleService.execute() returns success" and "move file to sent/"? The file was sent but not moved, so on restart it will be re-sent.
- **Why it matters:** Duplicate Kindle deliveries are annoying for users. The window is small but real, especially if the filesystem is slow (network drive).
- **Suggested fix:** Make the move-to-sent operation part of the "current file processing" that must complete before shutdown. Use a processing flag that the signal handler checks, and only exit after both send and move complete.

### 12. `loadConfig()` modification for optional `WATCH_FOLDER` is underspecified
- **What's wrong:** The design says WATCH_FOLDER is added to `loadConfig()` and is optional. But `loadConfig()` currently throws on missing required vars and returns a `Config` object. Adding an optional field is fine, but the design doesn't show the type change to `Config` or how the watcher composition root validates that WATCH_FOLDER is present (it's required for the watcher, optional globally).
- **Why it matters:** The watcher needs WATCH_FOLDER but MCP/CLI don't. The validation is context-dependent. `loadConfig()` currently has no concept of "required for this entry point but not that one."
- **Suggested fix:** Either: (a) add `watchFolder?: string` to `Config` and let `watch-entry.ts` validate its presence after calling `loadConfig()`, or (b) create a `loadWatchConfig()` that extends `loadConfig()`. Option (a) is simpler. Make it explicit in the design.

## LOW

### 13. chokidar v4 is a new major version with breaking changes
- **What's wrong:** The design specifies chokidar v4. Chokidar v4 dropped polling support and changed its API significantly from v3. The `awaitWriteFinish` option behavior may differ. The design doesn't acknowledge this.
- **Why it matters:** If the implementation hits a v4 API difference, it may require fallback to v3 or a different approach to write-finish detection.
- **Suggested fix:** Verify that `awaitWriteFinish` with `stabilityThreshold` and `pollInterval` works as described in chokidar v4. Add a note about the version choice.

### 14. Windows Task Scheduler: "no admin elevation needed" may be incorrect
- **What's wrong:** The design claims `schtasks /create` runs under the current user with no admin elevation. This is true for basic tasks, but some configurations (e.g., `RunAtLogon` trigger type) may require elevated privileges depending on Windows security policy and group policy settings.
- **Why it matters:** On corporate/managed Windows machines, task creation may fail silently or require UAC elevation.
- **Suggested fix:** Add a note that enterprise Windows environments may require admin rights. Consider using `SCHTASKS /CREATE /SC ONLOGON` vs other trigger types and document the privilege requirements.

### 15. No validation that node binary path is resolvable from service context
- **What's wrong:** The service installer runs `node /path/to/watch-entry.js`. But the service runs in a different context than the user's shell -- PATH may not include the node binary. On macOS launchd and Linux systemd, the environment is minimal.
- **Why it matters:** The service will fail to start with "node: command not found" and the user will have no idea why.
- **Suggested fix:** Resolve the absolute path to the node binary at install time (e.g., `process.execPath`) and embed it in the service configuration. Do not rely on PATH.

### 16. Error file content format is unspecified
- **What's wrong:** The design says "write `.error.txt` with failure reason and timestamp" but doesn't specify the format. Is it plain text? JSON? What fields?
- **Why it matters:** Minor, but users need to understand the error to fix it. A consistent format also enables programmatic parsing if needed later.
- **Suggested fix:** Specify the format: e.g., `Timestamp: ISO8601\nError: kind\nMessage: details\n`.

## Summary

The three most important issues to address before implementation:

1. **Subcommand routing (CRITICAL #2):** The design contradicts itself on whether `paperboy watch` routes through the existing CLI entry point or a separate one. The current arg parser will reject `watch` as an unknown argument. This architectural decision must be resolved first.

2. **Infinite loop risk from watched subdirectories (CRITICAL #3):** Without explicit chokidar ignore patterns for `sent/` and `error/`, moving files into subdirectories of the watched folder can trigger re-processing loops. This is a correctness bug waiting to happen.

3. **Service installer scope creep (CRITICAL #1):** Cross-platform OS service installation is a project unto itself. The design underestimates the complexity (path escaping, permissions, environment variables in service context, node binary resolution). Either scope it down to documentation/scripts or budget significant testing effort.

Secondary concerns: the watcher application layer does too much I/O directly (HIGH #5), title extraction is misplaced domain logic (HIGH #6), and the lack of retry for transient SMTP failures undermines the "install and forget" value proposition (HIGH #7).
