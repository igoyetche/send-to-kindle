# PB-003 Critique: Multiple Kindle Addresses

Reviewed: docs/design-reviews/multiple-kindle-addresses/refined.md

## CRITICAL

### DeviceRegistry is domain logic misplaced in infrastructure

- **What's wrong:** `DeviceRegistry` is placed in `src/infrastructure/config/device-registry.ts` but it is not infrastructure. It is a domain concept -- a registry of Kindle devices that resolves a user-provided name to a `KindleDevice`. It contains pure logic (no I/O), operates on domain value objects (`KindleDevice`), enforces domain invariants (uniqueness, valid default), and is called at request time (not just startup). The design rationale says it "answers 'which device did the user configure?'" and calls it "configuration resolution logic" -- but resolving a named device from a collection is domain behavior, not configuration loading. Configuration is reading env vars and parsing strings. Once parsed, the registry is a domain collection with lookup semantics.
- **Why it matters:** SoC-001 Q5 applies: "Is it business logic specific to ONE feature?" Yes -- device resolution is specific to the send-to-kindle feature. SoC-011 test: "Would the creators of this external service recognize this code?" No external service creator would recognize `DeviceRegistry`. It is your abstraction, built from your domain types. Checklist item 4 from the critique checklist: "Custom abstractions pushed to infra: did this team build this abstraction? If yes, it's domain." This is exactly that violation. Additionally, `ToolHandler` (application layer) directly imports from `infrastructure/config/device-registry.ts` -- application importing infrastructure is permitted but in this case it means the application layer depends on infrastructure for what is actually domain logic.
- **Suggested fix:** Move `DeviceRegistry` to `src/domain/` (e.g., `src/domain/device-registry.ts` or `src/domain/values/device-registry.ts`). It is a pure, immutable, domain-level collection with validation. The config layer should construct it and pass it up. The `ToolHandler` would then import from domain, which is cleaner.

### ToolHandler imports infrastructure type directly

- **What's wrong:** The proposed `ToolHandler` has `import type { DeviceRegistry } from "../infrastructure/config/device-registry.js"`. While the SoC rules technically allow application to import infrastructure, this specific import is suspicious because `DeviceRegistry` is used for domain-level device resolution, not infrastructure concerns. The handler calls `devices.resolve()` which is a domain operation (mapping a user-provided name to a domain value object). This creates a dependency from the application's orchestration code to an infrastructure sub-folder for something that should be domain logic.
- **Why it matters:** If `DeviceRegistry` is correctly identified as domain (see finding above), this import becomes a clean `domain/` import. But if left as-is, the application layer is coupled to infrastructure for core feature logic, making it harder to test the handler without infrastructure module awareness.
- **Suggested fix:** Moving `DeviceRegistry` to domain resolves this automatically.

## HIGH

### KindleDevice name validation is too permissive

- **What's wrong:** `KindleDevice.create()` only validates that the name is non-empty after trimming and lowercasing. There is no validation for characters that would be problematic in the `KINDLE_DEVICES` env var format. A name containing `:` or `,` would break the `name:email` parsing format. For example, `KindleDevice.create("my:device", someEmail)` would succeed at the domain level but would be impossible to configure via environment variables.
- **Why it matters:** The domain value object accepts states that the infrastructure cannot represent. This is a mismatch between what the domain considers valid and what the system can actually handle. If devices are ever created from sources other than env var parsing (e.g., a config file, API), the inconsistency surfaces as subtle bugs.
- **Suggested fix:** Add character restrictions to `KindleDevice.create()` -- at minimum reject `:` and `,`. Consider restricting to alphanumeric plus hyphens/underscores, which would also make device names safe for use in URLs, filenames, and log entries.

### SENDER_EMAIL not upgraded to EmailAddress value object

- **What's wrong:** The design introduces `EmailAddress` as a domain value object to eliminate duplicated email validation, and replaces the Kindle email validation with it. But `SENDER_EMAIL` in `config.ts` continues to use the old `validateEmail()` helper (or is left unaddressed). The design says the `validateEmail()` helper "can be replaced by `EmailAddress.create()`" (section 3.2.3) but does not actually specify this change.
- **Why it matters:** The stated rationale for `EmailAddress` is "eliminates duplicated email validation regex." If `SENDER_EMAIL` still uses the old regex, the duplication is only reduced, not eliminated. This is an incomplete application of the design's own principle.
- **Suggested fix:** Explicitly specify that `SENDER_EMAIL` validation also uses `EmailAddress.create()` in `loadConfig()`. Either the `Config` type should carry `sender: { email: EmailAddress }` or the validation should use `EmailAddress.create()` and then extract `.value` for the config.

### DeliveryLogger not updated for device context

- **What's wrong:** The `DeliveryLogger` port signature remains unchanged: `deliveryAttempt(title: string, format: string)`, `deliverySuccess(title: string, format: string, sizeBytes: number)`, `deliveryFailure(title: string, errorKind: string, message: string)`. None of these methods include the device name. The service now knows which device is being targeted but cannot log it through the port.
- **Why it matters:** Operational visibility. When multiple devices are configured, operators need to know which device a delivery attempt targeted. Without the device name in logs, debugging delivery failures requires correlating timestamps across log entries. The whole point of multiple devices is that different deliveries go to different places -- the logs should reflect this.
- **Suggested fix:** Add `deviceName: string` to at least `deliveryAttempt` and `deliverySuccess` signatures. Consider whether `deliveryFailure` also needs it.

## MEDIUM

### EmailAddress regex is naive

- **What's wrong:** The regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` used in `EmailAddress.create()` is the same one already in `config.ts`. It rejects valid emails like `user@localhost` (no dot in domain) and accepts invalid ones like `user@.com` or `user@domain..com`. For Kindle addresses specifically, the format is predictable (`*@kindle.com`, `*@free.kindle.com`), but the value object is generic.
- **Why it matters:** Low practical risk since Kindle emails follow a simple pattern, but calling something `EmailAddress` implies general-purpose email validation. If the object is reused for sender email validation (as suggested above), the weak regex could reject valid SMTP sender addresses.
- **Suggested fix:** Document that the regex is intentionally simple (not RFC 5322 compliant) and sufficient for the Kindle use case. Alternatively, name it `KindleEmailAddress` if it is not meant to be general-purpose -- but that seems over-specific.

### No maximum device count

- **What's wrong:** `DeviceRegistry.create()` accepts any number of devices with no upper bound. While this is a single-user tool, a malformed `KINDLE_DEVICES` string (e.g., a very long value with hundreds of entries) would be silently accepted.
- **Why it matters:** Low risk for a single-user tool, but a reasonable defensive check. The error message in `resolve()` lists all device names, which could produce an unwieldy error message with many devices.
- **Suggested fix:** Consider a reasonable maximum (e.g., 20 devices) with a clear error message. This is optional but cheap to add.

### Config parsing throws instead of returning Result

- **What's wrong:** The `parseDeviceEntries` and `buildDeviceRegistry` functions throw errors on invalid input, while the domain value objects they call return `Result` types. The config layer unwraps `Result` values and re-throws, losing the structured error information. This is inconsistent with the project's stated principle of "Result types, not exceptions."
- **Why it matters:** The existing `loadConfig()` already throws, so this is consistent with the current codebase. But the design explicitly wraps domain `Result` errors in thrown `Error` objects with string messages, discarding the structured `ValidationError` data. If config validation is ever surfaced to a user (not just startup logs), the structured data would be valuable.
- **Suggested fix:** This is acceptable as-is given the fail-fast startup context. Note it as a known inconsistency rather than requiring a fix. The existing pattern is throwing at config load time.

### Device name "default" is a magic string

- **What's wrong:** When falling back to single `KINDLE_EMAIL` mode, the config creates a device named `"default"`. This name is a magic string that appears nowhere else in the design. If a user later adds `KINDLE_DEVICES` with a device named `"default"`, the behavior changes silently.
- **Why it matters:** The name `"default"` is an implementation choice that leaks through to the user. When the tool responds with `sent to Kindle (default)`, the user sees a name they never configured. If they later switch to `KINDLE_DEVICES`, the behavior around the name `"default"` could be confusing.
- **Suggested fix:** Consider using `"kindle"` or deriving a name from the email prefix. Alternatively, document this explicitly in the feature spec so it is an intentional choice, not an accidental one.

### SoC-012 audit is incorrect for config.ts

- **What's wrong:** The SoC audit claims SoC-012 passes with "No files at infra root." But `config.ts` currently lives at `src/infrastructure/config.ts` (infra root), and the design adds `src/infrastructure/config/device-registry.ts` (a sub-folder). The design does not specify moving `config.ts` into the `config/` sub-folder. This means infra has both a root-level `config.ts` AND a `config/` sub-folder, which is inconsistent.
- **Why it matters:** SoC-012 says "No files at infra/ root. Everything must be in a sub-folder." The existing `config.ts` at infra root is already a violation, and the design neither addresses it nor acknowledges it.
- **Suggested fix:** Either move `config.ts` into `src/infrastructure/config/config.ts` (or `index.ts`) alongside `device-registry.ts`, or acknowledge the existing violation and scope it out of this feature.

## LOW

### Tool description does not mention device parameter

- **What's wrong:** The MCP tool registration description says "Convert Markdown content to EPUB and send it to a Kindle device via email." This does not mention the ability to target a specific device, which is the entire point of this feature.
- **Why it matters:** MCP tool descriptions are used by LLMs to understand tool capabilities. If the description does not mention device targeting, Claude may not know to use the parameter.
- **Suggested fix:** Update to something like "Convert Markdown content to EPUB and send it to a Kindle device via email. Optionally specify a target device by name."

### Test strategy does not cover edge cases in device name handling

- **What's wrong:** The test strategy lists "Name is trimmed and lowercased" for `KindleDevice` but does not cover: names with special characters, names that are purely whitespace after trimming (covered by empty check), or very long names. For `DeviceRegistry`, there is no test for case-insensitive resolution (e.g., resolving `"Personal"` when the device was registered as `"personal"`).
- **Why it matters:** Case normalization happens in both `KindleDevice.create()` (lowercases at construction) and `DeviceRegistry.resolve()` (lowercases at lookup). This double-normalization should be tested to ensure they agree. If `resolve()` receives a mixed-case name, the test should verify it matches the lowercased stored name.
- **Suggested fix:** Add tests for case-insensitive resolution in `DeviceRegistry` and consider testing special character handling in device names.

### logger.ts also lives at infra root

- **What's wrong:** Similar to `config.ts`, `logger.ts` lives at `src/infrastructure/logger.ts` (infra root). The design does not address this.
- **Why it matters:** Same SoC-012 concern as `config.ts`. Out of scope for this feature, but worth noting for completeness.
- **Suggested fix:** Out of scope. Note for future cleanup.

## Summary

The most important issues to address are:

1. **DeviceRegistry placement (CRITICAL):** This is domain logic, not infrastructure. It is a pure, immutable collection of domain value objects with lookup semantics. The team built this abstraction from domain types -- it belongs in domain. Moving it also cleans up the `ToolHandler` import from infrastructure.

2. **KindleDevice name validation (HIGH):** Names containing `:` or `,` are valid according to the domain but impossible to represent in the `KINDLE_DEVICES` env var format. The domain should reject names that the system cannot round-trip.

3. **DeliveryLogger missing device context (HIGH):** With multiple devices, logs must identify which device was targeted. The logger port needs updating.

4. **SENDER_EMAIL validation inconsistency (HIGH):** The design introduces `EmailAddress` to eliminate duplicated validation but does not apply it to `SENDER_EMAIL`, leaving the duplication partially intact.

5. **SoC-012 infra root files (MEDIUM):** The audit claims compliance but `config.ts` and `logger.ts` live at the infra root. The design adds a `config/` sub-folder without moving the existing `config.ts` into it.
