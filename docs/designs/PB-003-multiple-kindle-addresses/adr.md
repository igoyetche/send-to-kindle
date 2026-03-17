# PB-003 ADR: Multiple Kindle Addresses

**Status:** Proposed
**Date:** 2026-03-05

---

## Context

The system currently supports a single Kindle email address. Users with multiple Kindle devices (personal, partner, family) must reconfigure the server to switch targets. The feature adds support for named Kindle devices with an optional `device` parameter on the `send_to_kindle` tool.

Key constraints:
- Single-user personal tool — no active users, so breaking changes to config format are acceptable
- Email addresses must never appear in logs, error messages, or tool responses
- Backwards compatibility with `KINDLE_EMAIL` is explicitly dropped — `KINDLE_DEVICES` is the only config path
- Single device per call (no broadcast)

---

## Decision

### Configuration

`KINDLE_DEVICES` is the sole configuration path. Each entry is a `name:email` tuple. `KINDLE_EMAIL` is removed.

```
KINDLE_DEVICES=personal:me@kindle.com,partner:partner@kindle.com
KINDLE_DEFAULT_DEVICE=personal   # optional — defaults to first entry
```

**Device name restrictions:** alphanumeric, hyphens, underscores only. Names containing `:` or `,` are rejected — they cannot be represented in the env var format. Maximum 10 devices.

### New Domain Types

**`EmailAddress`** (`src/domain/values/email-address.ts`)
- Validates and wraps an email string
- Single source of email validation — replaces all duplicated regex in the codebase (Kindle devices and sender email)
- TODO: replace naive regex with RFC 5322 compliant validation in a future pass

**`KindleDevice`** (`src/domain/values/kindle-device.ts`)
- Holds `name: string` (normalized: trimmed, lowercased) and `email: EmailAddress`
- Validates name is non-empty and matches `[a-z0-9-_]+` pattern
- Constructed via `Result`-returning factory

**`DeviceRegistry`** (`src/domain/device-registry.ts`)
- Pure, immutable domain collection of `KindleDevice` objects
- Enforces uniqueness and valid default at construction (`create()`)
- Resolves user-provided name to a `KindleDevice` at request time (`resolve()`)
- Error messages list device **names only**, never emails
- Maximum 10 devices enforced at construction
- Lives in domain: it is a custom abstraction built from domain types with domain invariants, not infrastructure

### Updated Port

```typescript
export interface DocumentMailer {
  send(document: EpubDocument, device: KindleDevice): Promise<Result<void, DeliveryError>>;
}
```

Mailer becomes stateless with respect to destination — address is passed per call, not baked into config.

### Updated Logger Port

```typescript
export interface DeliveryLogger {
  deliveryAttempt(title: string, format: string, deviceName: string): void;
  deliverySuccess(title: string, format: string, sizeBytes: number, deviceName: string): void;
  deliveryFailure(title: string, errorKind: string, message: string, deviceName: string): void;
}
```

Device name added to all three methods for full operational visibility across multi-device setups.

### Updated Service

`SendToKindleService.execute()` gains a `device: KindleDevice` parameter. `DeliverySuccess` gains `deviceName: string` so the handler reads one result without tracking parallel state.

### Config Parsing

`parseDeviceEntries()` and `buildDeviceRegistry()` return `Result` types — structured error data is preserved through the chain. `loadConfig()` unwraps and throws only at the top level (fail-fast startup behavior preserved).

`SENDER_EMAIL` validation uses `EmailAddress.create()` — the old `validateEmail()` helper is removed.

### Application Layer

`ToolHandler` receives `DeviceRegistry` (domain type, clean import). Resolves `device` arg via `devices.resolve(args.device)`. Success message reads `result.value.deviceName` directly — no parallel state.

Tool description updated to mention device targeting:
> "Convert Markdown content to EPUB and send it to a Kindle device via email. Optionally specify a target device by name."

---

## Consequences

### Positive
- Single config format — no two-path logic, no magic fallback device names
- Email addresses never leave the infrastructure layer
- `EmailAddress` value object eliminates all duplicated email validation
- `DeviceRegistry` in domain — custom abstraction stays where it belongs
- Full operational visibility in logs (device name on every log entry)
- Structured `Result` types preserved through config parsing chain

### Negative
- Breaking change: existing `KINDLE_EMAIL` users must migrate to `KINDLE_DEVICES` format
- `DeliveryLogger` port signature change requires updating the Pino logger implementation and all existing tests that mock the logger

### Mitigations
- No active users — breaking config change is acceptable
- Compile-time errors will surface all test signature mismatches immediately
- Migration path is mechanical: `KINDLE_EMAIL=x@kindle.com` → `KINDLE_DEVICES=kindle:x@kindle.com`

---

## Alternatives Considered

### Original Design: `DeviceRegistry` in `domain/values/`
The architect placed `DeviceRegistry` in `domain/values/`. The refiner moved it to `infrastructure/config/` arguing it changes for infrastructure reasons. The critique correctly identified this as wrong — `DeviceRegistry` is a custom abstraction built entirely from domain types with domain invariants. **Decision: keep in domain.**

### Refined Design: `DeviceRegistry` in `infrastructure/config/`
Rejected. See above.

### Keep `KINDLE_EMAIL` as Backwards-Compatible Fallback
Rejected. Creates a two-path config system with a magic device name ("default") that users never configured. With no active users, the clean break is preferable.

### Rejected Critique Findings
- **Max device count (Finding 7):** Accepted at 10 (not rejected)
- **Config throws vs Result (Finding 8):** Changed to Result types
- **SoC-012 for `config.ts` and `logger.ts` (Findings 10, 13):** Deferred — known technical debt, out of scope for this feature

---

## Open Issues

- **SoC-012 cleanup (Deferred):** `config.ts` and `logger.ts` live at `src/infrastructure/` root, violating SoC-012. Address in a future cleanup task separate from this feature.
- **EmailAddress regex (TODO in code):** Current regex is naive (not RFC 5322 compliant). Sufficient for Kindle use case but should be replaced in a future pass.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/domain/values/email-address.ts` | **New** — `EmailAddress` value object |
| `src/domain/values/kindle-device.ts` | **New** — `KindleDevice` value object; name restricted to `[a-z0-9-_]+` |
| `src/domain/values/index.ts` | Export `EmailAddress`, `KindleDevice` |
| `src/domain/device-registry.ts` | **New** — `DeviceRegistry` (domain, not infrastructure) |
| `src/domain/ports.ts` | `DocumentMailer.send()` gains `device: KindleDevice`; `DeliveryLogger` gains `deviceName` on all methods |
| `src/domain/send-to-kindle-service.ts` | `execute()` gains `device: KindleDevice`; `DeliverySuccess` gains `deviceName` |
| `src/infrastructure/config.ts` | Parse `KINDLE_DEVICES` only; remove `KINDLE_EMAIL`; `Result`-returning helpers; `EmailAddress` for sender |
| `src/infrastructure/mailer/smtp-mailer.ts` | `send()` reads `device.email.value`; drop `kindle` from config |
| `src/infrastructure/logger.ts` | Update Pino logger to match new `DeliveryLogger` port signatures |
| `src/application/tool-handler.ts` | Resolve `device` via `DeviceRegistry`; read `deviceName` from result |
| `src/index.ts` | Wire `config.devices` into `ToolHandler`; update tool description and schema |

---

## Test Coverage Notes

- **`EmailAddress`:** valid email, invalid email, whitespace trimming, custom field name in error
- **`KindleDevice`:** valid construction, empty name, restricted characters (`:`, `,`), name normalization
- **`DeviceRegistry`:** single/multiple devices, explicit default, duplicate names, unknown default, `resolve(undefined)`, `resolve("name")`, `resolve("Unknown")` (case-insensitive), error lists names only (assert no `@` in message), `names` getter, max 10 devices
- **Config parsing:** `KINDLE_DEVICES` parsed correctly, `KINDLE_DEFAULT_DEVICE` validated, duplicate names fail, malformed entries fail, invalid email fails, max 10 enforced
- **Updated existing tests:** `SendToKindleService`, `SmtpMailer`, `ToolHandler` — add `KindleDevice` parameter; verify `deviceName` in results and logs
