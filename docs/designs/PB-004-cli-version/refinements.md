# PB-004: CLI Version — Refinements

> Reviewed against: separation-of-concerns, tactical-ddd
> Date: 2026-03-17

---

## 1. I/O in the entrypoint: file reading and stdin consumption

**Issue (SoC-006, SoC-012):** The design places `fs.readFile` and stdin stream consumption directly inside `cli.ts` (the entrypoint). SoC-006 says entrypoints are thin translation layers that parse input, invoke commands, and format output. Reading a file from disk or consuming a stream is I/O, not argument translation. The entrypoint should receive content as a string, not perform I/O to obtain it.

SoC-012 assigns CLI I/O utilities (stdin readers, terminal formatting, TTY detection) to `platform/infra/cli/`. File reading is a standard `platform/infra/cli/` concern.

**Refinement:** Extract `readContent` (file reading + stdin consumption) into a platform/infra utility. The entrypoint calls it to obtain a string, then proceeds with its translation duties. This keeps the entrypoint focused on: parse args, call infra to get content string, create value objects, invoke service, map result.

In the current project structure (which does not use the `platform/features` layout literally), this means a new module under `src/infrastructure/` rather than embedding I/O in `src/application/cli.ts`.

**Specific change:** Move the `readContent` function from `src/application/cli.ts` to `src/infrastructure/cli/content-reader.ts`. The entrypoint imports and calls it but does not own the I/O logic.

---

## 2. Value object creation belongs in the entrypoint, not the shell

**Issue (SoC-001 Q1 vs Q2, SoC-006):** The design's `cli-entry.ts` (shell) pseudocode lists step 6 as "Create value objects (Title, Author, MarkdownContent)". Creating value objects from parsed arguments is input translation -- it converts raw strings into domain types. That is entrypoint work (Q2: "translates between external and internal formats"), not shell work (Q1: "wires things together at startup").

The existing MCP path confirms this: `tool-handler.ts` (entrypoint) creates Title, Author, and MarkdownContent from raw args. The shell (`index.ts`) never touches value objects.

**Refinement:** The CLI entrypoint (`cli.ts`) should own the full sequence: parse args, read content, create value objects, resolve device, call service, map result. The shell (`cli-entry.ts`) should only: load env, load config, wire dependencies, call the CLI entrypoint's run function, and set the exit code.

This means the CLI entrypoint exposes a single `run` function that accepts the wired dependencies (service, device registry, default author) and returns an exit code. The shell calls it.

---

## 3. Device resolution is duplicated across entrypoints

**Issue (DDD-4 anemic model, DDD-3 orchestration):** Both `tool-handler.ts` and the proposed `cli.ts` will independently call `devices.resolve(name)`, then pass the result to `service.execute()`. The device resolution step is part of the use case's orchestration -- it is the same "resolve device, then send" sequence regardless of transport.

This is not a business rule leak (it is orchestration, not invariant enforcement), but it is duplicated orchestration. Every new entrypoint must remember to resolve the device before calling the service.

**Refinement:** Absorb device resolution into `SendToKindleService.execute()` by accepting an optional device name (string) and the `DeviceRegistry` as a constructor dependency. The service resolves the device internally. Entrypoints pass the raw device name string (or undefined for default) and no longer need to know about `DeviceRegistry`.

However, this would change the existing service interface and is a broader refactoring. A less invasive alternative: keep the current design but document explicitly that device resolution is an entrypoint responsibility, and accept the duplication as the cost of keeping the service signature clean (accepting only validated domain types). Both approaches are valid. The refined design documents this trade-off and keeps the current approach (entrypoints resolve devices), matching the existing MCP pattern.

---

## 4. Missing explicit domain concept: ContentSource

**Issue (DDD-6 make implicit explicit):** The design describes content resolution as "content comes from exactly one of two sources: --file or stdin." This is a domain-adjacent concept that the code will represent as scattered conditionals in the entrypoint. The two sources have different error modes (file: ENOENT/EACCES; stdin: TTY detection) and different reading strategies.

**Refinement:** Name this concept explicitly as a discriminated union type in the CLI adapter:

```typescript
type ContentSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };
```

The arg parser produces a `ContentSource`, and the content reader consumes it. This makes the branching explicit in the type system rather than implicit in conditional logic.

This type belongs in the CLI adapter (it is CLI-specific, not domain), not in the domain layer.

---

## 5. CliArgs should separate parsed flags from resolved content source

**Issue (SoC-007, DDD-6):** The design's `CliArgs` type has `filePath: string | undefined` as a raw optional. The actual semantics are richer: if filePath is present, read from file; if absent and stdin is not a TTY, read from stdin; if absent and stdin is a TTY, error. Encoding this as `filePath: string | undefined` loses the "stdin" case in the type.

**Refinement:** After parsing, resolve the content source into the `ContentSource` union described above. The `CliArgs` type can remain as the raw parse result, but the entrypoint's `run` function should convert it into a resolved `ContentSource` before proceeding. This separates "what the user typed" from "what content source was selected."

---

## 6. Exit code mapping needs the config error case formalized

**Issue (SoC-006, DDD-6):** The exit code table maps `DomainError.kind` values to exit codes 1-3, and lists "Config error (thrown)" as exit code 4. But config errors are thrown exceptions, not `DomainError` values. The design's `mapErrorToExitCode` function handles only `DomainError`, while config errors are caught separately in the shell.

This is actually correct separation (config errors are shell-level failures, not domain errors), but the design conflates them in one table without making the separation explicit.

**Refinement:** The refined design clearly separates two error-handling paths:
1. **Shell-level errors** (config loading failures): caught in `cli-entry.ts`, mapped to exit code 4. These never reach the entrypoint.
2. **Domain errors** (validation, conversion, delivery): returned as `Result` from the service, mapped by `mapErrorToExitCode` in the entrypoint.

The exit code table should be split into two tables reflecting these distinct error paths.

---

## 7. The run function signature should use dependency injection

**Issue (SoC-002, DDD-1):** The design's dependency graph shows `cli.ts` importing from domain values, device registry, errors, fs, and process. This is a lot of direct imports for a translation layer. The entrypoint should receive its dependencies (service, device registry, default author) via function parameters, not construct or import them.

**Refinement:** The CLI entrypoint exports a single `run` function:

```typescript
async function run(deps: {
  service: Pick<SendToKindleService, "execute">;
  devices: DeviceRegistry;
  defaultAuthor: string;
  argv: ReadonlyArray<string>;
  readContent: (source: ContentSource) => Promise<string>;
}): Promise<number>  // returns exit code
```

The shell constructs these dependencies and passes them in. The entrypoint is fully testable without mocking modules -- just pass fake deps.

---

## 8. SoC audit update for entrypoint layer boundary

**Issue (SoC-012):** The original audit marks SoC-012 as PASS with "No new infra." But the refinement in item 1 introduces `infrastructure/cli/content-reader.ts`, which is new infra. The audit should reflect this.

**Refinement:** The SoC-012 verdict is updated to PASS with the note that `content-reader.ts` lives in `infrastructure/cli/`, following the standard sub-folder convention for CLI I/O utilities.

---

## Summary of changes to the design

| # | Change | Rationale |
|---|---|---|
| 1 | Extract `readContent` to `infrastructure/cli/content-reader.ts` | SoC-006: entrypoints do not perform I/O |
| 2 | Move value object creation from shell to entrypoint | SoC-001: translation is entrypoint work, not shell work |
| 3 | Document device resolution trade-off (keep in entrypoint) | DDD-3: accept duplication over coupling |
| 4 | Introduce `ContentSource` discriminated union in CLI adapter | DDD-6: make implicit branching explicit |
| 5 | Separate raw `CliArgs` from resolved `ContentSource` | SoC-007: clean input type progression |
| 6 | Split exit code table into shell vs entrypoint error paths | DDD-6: make error handling paths explicit |
| 7 | Use dependency-injected `run` function for entrypoint | SoC-002, testability |
| 8 | Update SoC audit for new infra module | SoC-012 accuracy |
