# PB-003: Multiple Kindle Addresses — Refined Design

> Feature spec: `docs/features/active/multiple-kindle-addresses.md`
> Reviewed against: Separation of Concerns (SoC-001 through SoC-015), Tactical DDD (principles 1 through 9)
> Refinements applied: R-SoC-1, R-SoC-2, R-SoC-3, R-DDD-1

---

## 1. Summary of Changes

The feature adds support for named Kindle devices so users can target different devices without reconfiguring the server. It introduces `KindleDevice` and `EmailAddress` value objects, updates the `DocumentMailer` port signature, adds a `DeviceRegistry` in the infrastructure config layer for device resolution, and extends configuration parsing -- all while preserving backwards compatibility with the existing single-address `KINDLE_EMAIL` setup.

---

## 2. Current Architecture Snapshot

```
src/
  domain/
    values/          Title, Author, MarkdownContent, EpubDocument
    ports.ts         ContentConverter, DocumentMailer, DeliveryLogger
    errors.ts        ValidationError, SizeLimitError, ConversionError, DeliveryError, Result<T,E>
    send-to-kindle-service.ts   SendToKindleService
  infrastructure/
    converter/       MarkdownEpubConverter
    mailer/          SmtpMailer (reads kindle.email from SmtpMailerConfig)
    config.ts        loadConfig() -- parses KINDLE_EMAIL, SMTP_*, etc.
    logger.ts        Pino-based DeliveryLogger
  application/
    tool-handler.ts  ToolHandler -- constructs value objects, calls service
  index.ts           Composition root
```

Key observation: the Kindle email address currently flows through `Config.kindle.email` into `SmtpMailerConfig`, where `SmtpMailer.send()` reads it as `this.config.kindle.email`. The domain layer has no awareness of the destination address -- `DocumentMailer.send(document)` takes only an `EpubDocument`.

---

## 3. Proposed Design

### 3.1 Domain Layer Changes

#### 3.1.1 New Value Object: `EmailAddress`

**File:** `src/domain/values/email-address.ts`

```typescript
import { ValidationError, type Result, ok, err } from "../errors.js";

export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(
    raw: string,
    field: string = "email",
  ): Result<EmailAddress, ValidationError> {
    const trimmed = raw.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return err(
        new ValidationError(
          field,
          `Invalid email address: "${trimmed}".`,
        ),
      );
    }
    return ok(new EmailAddress(trimmed));
  }
}
```

**Rationale:**
- Eliminates duplicated email validation regex between `KindleDevice` and `config.ts`.
- Makes the concept of "a validated email address" explicit as a named domain type (Tactical DDD principle 6, 8).
- Follows existing value object pattern (private constructor, static `create`, returns `Result`).
- The `field` parameter allows callers to provide context-specific field names in error messages.

**Export:** Add `export { EmailAddress } from "./email-address.js";` to `src/domain/values/index.ts`.

#### 3.1.2 New Value Object: `KindleDevice`

**File:** `src/domain/values/kindle-device.ts`

```typescript
import { ValidationError, type Result, ok, err } from "../errors.js";
import type { EmailAddress } from "./email-address.js";

export class KindleDevice {
  private constructor(
    readonly name: string,
    readonly email: EmailAddress,
  ) {}

  static create(
    name: string,
    email: EmailAddress,
  ): Result<KindleDevice, ValidationError> {
    const trimmedName = name.trim().toLowerCase();
    if (trimmedName.length === 0) {
      return err(
        new ValidationError(
          "device.name",
          "Device name must be non-empty.",
        ),
      );
    }
    return ok(new KindleDevice(trimmedName, email));
  }
}
```

**Rationale:**
- Follows existing value object pattern (private constructor, static `create`, returns `Result`).
- Name is lowercased and trimmed to normalize lookups.
- Email is an `EmailAddress` value object, not a raw string. Validation happens once at `EmailAddress.create()` time, so `KindleDevice` does not re-validate.
- Lives in `src/domain/values/` alongside `Title`, `Author`, etc. (SoC-010: co-locate by change).

**Export:** Add `export { KindleDevice } from "./kindle-device.js";` to `src/domain/values/index.ts`.

#### 3.1.3 Updated Port: `DocumentMailer`

**File:** `src/domain/ports.ts`

Current signature:
```typescript
export interface DocumentMailer {
  send(document: EpubDocument): Promise<Result<void, DeliveryError>>;
}
```

Updated signature:
```typescript
export interface DocumentMailer {
  send(
    document: EpubDocument,
    device: KindleDevice,
  ): Promise<Result<void, DeliveryError>>;
}
```

**Rationale:** The domain service must control which device receives the document. Passing `KindleDevice` into `send()` rather than baking the address into `SmtpMailer`'s constructor makes the mailer stateless with respect to the destination. This is the minimal port change -- one new parameter.

#### 3.1.4 Updated Service: `SendToKindleService`

**File:** `src/domain/send-to-kindle-service.ts`

The `DeliverySuccess` type gains `deviceName`:

```typescript
export interface DeliverySuccess {
  readonly title: string;
  readonly sizeBytes: number;
  readonly deviceName: string;
}
```

The service's `execute` method gains a `device: KindleDevice` parameter:

```typescript
async execute(
  title: Title,
  content: MarkdownContent,
  author: Author,
  device: KindleDevice,
): Promise<Result<DeliverySuccess, DomainError>> {
  this.logger.deliveryAttempt(title.value, "epub");

  const convertResult = await this.converter.toEpub(title, content, author);
  if (!convertResult.ok) {
    this.logger.deliveryFailure(
      title.value,
      convertResult.error.kind,
      convertResult.error.message,
    );
    return convertResult;
  }

  const document = convertResult.value;
  const sendResult = await this.mailer.send(document, device);
  if (!sendResult.ok) {
    this.logger.deliveryFailure(
      title.value,
      sendResult.error.kind,
      sendResult.error.message,
    );
    return sendResult;
  }

  this.logger.deliverySuccess(title.value, "epub", document.sizeBytes);

  return ok({
    title: title.value,
    sizeBytes: document.sizeBytes,
    deviceName: device.name,
  });
}
```

**Rationale:**
- The service orchestrates; it does not resolve which device to use. That responsibility belongs to the caller (ToolHandler).
- The service passes the resolved `KindleDevice` through to the mailer and includes the device name in the result. This keeps the service focused on the convert-then-deliver pipeline (SoC-013: separate intent from execution).
- `DeliverySuccess` includes `deviceName` so the handler can construct the response purely from the service result, without tracking parallel state (R-SoC-2).

#### 3.1.5 Error Handling: No New Error Types

No new error class is needed. The existing `ValidationError` with `field: "device"` is sufficient:

```typescript
new ValidationError(
  "device",
  `Unknown device 'foo'. Available devices: personal, partner, family.`,
)
```

This keeps the `DomainError` union unchanged. The error message lists device names only (never emails), satisfying the security constraint.

---

### 3.2 Infrastructure Layer Changes

#### 3.2.1 New Infrastructure Type: `DeviceRegistry`

**File:** `src/infrastructure/config/device-registry.ts`

```typescript
import type { KindleDevice } from "../../domain/values/index.js";
import { ValidationError, type Result, ok, err } from "../../domain/errors.js";

export class DeviceRegistry {
  private readonly devices: ReadonlyMap<string, KindleDevice>;
  readonly defaultDevice: KindleDevice;

  private constructor(
    devices: ReadonlyMap<string, KindleDevice>,
    defaultDevice: KindleDevice,
  ) {
    this.devices = devices;
    this.defaultDevice = defaultDevice;
  }

  static create(
    devices: ReadonlyArray<KindleDevice>,
    defaultDeviceName?: string,
  ): Result<DeviceRegistry, ValidationError> {
    if (devices.length === 0) {
      return err(
        new ValidationError(
          "devices",
          "At least one Kindle device must be configured.",
        ),
      );
    }

    const map = new Map<string, KindleDevice>();
    for (const device of devices) {
      if (map.has(device.name)) {
        return err(
          new ValidationError(
            "devices",
            `Duplicate device name: '${device.name}'.`,
          ),
        );
      }
      map.set(device.name, device);
    }

    const resolvedDefault = defaultDeviceName
      ? map.get(defaultDeviceName.trim().toLowerCase())
      : devices[0];

    if (!resolvedDefault) {
      return err(
        new ValidationError(
          "KINDLE_DEFAULT_DEVICE",
          `Default device '${defaultDeviceName}' not found. Available: ${[...map.keys()].join(", ")}.`,
        ),
      );
    }

    return ok(new DeviceRegistry(map, resolvedDefault));
  }

  resolve(name?: string): Result<KindleDevice, ValidationError> {
    if (!name) {
      return ok(this.defaultDevice);
    }
    const normalized = name.trim().toLowerCase();
    const device = this.devices.get(normalized);
    if (!device) {
      const available = [...this.devices.keys()].join(", ");
      return err(
        new ValidationError(
          "device",
          `Unknown device '${name}'. Available devices: ${available}.`,
        ),
      );
    }
    return ok(device);
  }

  get names(): ReadonlyArray<string> {
    return [...this.devices.keys()];
  }
}
```

**Rationale:**
- `DeviceRegistry` is configuration resolution logic, not a domain value object. It answers "which device did the user configure?" -- a concern that changes for infrastructure reasons (new env var format, new config source), not domain reasons (R-SoC-1).
- Pure logic: no I/O. The registry is constructed from already-parsed data.
- Immutable after construction (private constructor, `ReadonlyMap`).
- `resolve()` returns `Result` -- no exceptions.
- `create()` is the construction-time validation boundary (enforces uniqueness, valid default). `resolve()` is the runtime query (maps user input to a device). These are distinct responsibilities documented by their different call sites: startup vs. per-request.
- Infrastructure can import domain types (`KindleDevice`, `ValidationError`) -- dependency direction is inward (SoC-002).

#### 3.2.2 Updated `SmtpMailer`

**File:** `src/infrastructure/mailer/smtp-mailer.ts`

The `SmtpMailerConfig` interface loses `kindle: { email: string }` -- the destination now comes from the `KindleDevice` parameter at call time.

```typescript
export interface SmtpMailerConfig {
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
}

export class SmtpMailer implements DocumentMailer {
  // ...constructor unchanged except config type narrows...

  async send(
    document: EpubDocument,
    device: KindleDevice,
  ): Promise<Result<void, DeliveryError>> {
    const filename = slugify(document.title);

    try {
      await this.transporter.sendMail({
        from: this.config.sender.email,
        to: device.email.value,    // <-- EmailAddress value object
        subject: document.title,
        text: "Sent via Send to Kindle MCP Server.",
        attachments: [
          {
            filename,
            content: document.buffer,
            contentType: "application/epub+zip",
          },
        ],
      });
      return ok(undefined);
    } catch (error) {
      const { cause, message } = categorizeError(error);
      return err(new DeliveryError(cause, message));
    }
  }
}
```

**Rationale:** The mailer reads `device.email.value` internally. The device name is never logged by the mailer -- logging happens at the service layer. The mailer's only job is SMTP delivery (SoC-014: separate functions that depend on different state).

#### 3.2.3 Updated `config.ts`

**File:** `src/infrastructure/config.ts`

The `Config` type changes:

```typescript
import type { DeviceRegistry } from "./config/device-registry.js";

export interface Config {
  devices: DeviceRegistry;          // replaces kindle: { email: string }
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}
```

The `loadConfig()` function uses two focused helpers for device parsing (R-SoC-3):

```typescript
function parseDeviceEntries(
  raw: string,
): Array<{ name: string; email: string }> {
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Invalid KINDLE_DEVICES entry: "${trimmed}". Expected "name:email" format.`,
      );
    }
    return {
      name: trimmed.slice(0, colonIndex),
      email: trimmed.slice(colonIndex + 1),
    };
  });
}

function buildDeviceRegistry(
  entries: Array<{ name: string; email: string }>,
  defaultName?: string,
): DeviceRegistry {
  const devices: KindleDevice[] = [];

  for (const entry of entries) {
    const emailResult = EmailAddress.create(entry.email, "device.email");
    if (!emailResult.ok) {
      throw new Error(
        `Invalid KINDLE_DEVICES entry: ${emailResult.error.message}`,
      );
    }
    const deviceResult = KindleDevice.create(entry.name, emailResult.value);
    if (!deviceResult.ok) {
      throw new Error(
        `Invalid KINDLE_DEVICES entry: ${deviceResult.error.message}`,
      );
    }
    devices.push(deviceResult.value);
  }

  const registryResult = DeviceRegistry.create(devices, defaultName);
  if (!registryResult.ok) {
    throw new Error(registryResult.error.message);
  }
  return registryResult.value;
}

function parseDevices(): DeviceRegistry {
  const devicesRaw = process.env.KINDLE_DEVICES;

  if (devicesRaw) {
    const entries = parseDeviceEntries(devicesRaw);
    const defaultName = process.env.KINDLE_DEFAULT_DEVICE;
    return buildDeviceRegistry(entries, defaultName);
  }

  // Backwards-compatible: single KINDLE_EMAIL
  const kindleEmail = requireEnv("KINDLE_EMAIL");
  return buildDeviceRegistry(
    [{ name: "default", email: kindleEmail }],
  );
}
```

**Rationale:**
- Fail-fast: all validation errors (duplicate names, unknown default, bad emails) surface at startup.
- Backwards compatible: if only `KINDLE_EMAIL` is set, a single device named "default" is created.
- `KINDLE_DEVICES` takes precedence when set.
- Config throws on invalid state -- consistent with existing `loadConfig()` behavior.
- Format parsing (`parseDeviceEntries`) is separated from domain object construction (`buildDeviceRegistry`) -- each function depends on different state (R-SoC-3, SoC-014).
- Config imports domain value objects (`KindleDevice`, `EmailAddress`) and infrastructure types (`DeviceRegistry`) -- both dependency directions are permitted (SoC-002).
- The `validateEmail()` helper in config can be replaced by `EmailAddress.create()`, eliminating the duplicated regex (R-DDD-1).

---

### 3.3 Application Layer Changes

#### 3.3.1 Updated `ToolHandler`

**File:** `src/application/tool-handler.ts`

The handler gains access to the `DeviceRegistry` and accepts an optional `device` argument:

```typescript
import type { DeviceRegistry } from "../infrastructure/config/device-registry.js";

export class ToolHandler {
  constructor(
    private readonly service: SendToKindleService,
    private readonly defaultAuthor: string,
    private readonly devices: DeviceRegistry,
  ) {}

  async handle(args: {
    title: string;
    content: string;
    author?: string;
    device?: string;
  }): Promise<McpToolResponse> {
    // Resolve device first
    const deviceResult = this.devices.resolve(args.device);
    if (!deviceResult.ok) return mapErrorToResponse(deviceResult.error);

    // Construct value objects (unchanged)
    const titleResult = Title.create(args.title);
    if (!titleResult.ok) return mapErrorToResponse(titleResult.error);

    const contentResult = MarkdownContent.create(args.content);
    if (!contentResult.ok) return mapErrorToResponse(contentResult.error);

    const authorRaw = args.author?.trim() || this.defaultAuthor;
    const authorResult = Author.create(authorRaw);
    if (!authorResult.ok) return mapErrorToResponse(authorResult.error);

    // Execute domain service with resolved device
    const result = await this.service.execute(
      titleResult.value,
      contentResult.value,
      authorResult.value,
      deviceResult.value,
    );

    if (!result.ok) return mapErrorToResponse(result.error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Document '${result.value.title}' sent to Kindle (${result.value.deviceName}) successfully.`,
            sizeBytes: result.value.sizeBytes,
          }),
        },
      ],
    };
  }
}
```

**Rationale:**
- Device resolution is thin: call `devices.resolve(args.device)` and handle the `Result`.
- The handler is a translation layer between MCP input and domain types (SoC-006).
- Device name in the success message comes from `result.value.deviceName` -- the handler reads the service result directly without tracking parallel state (R-SoC-2).

#### 3.3.2 Updated Composition Root

**File:** `src/index.ts`

```typescript
const config = loadConfig();

// ...logger creation unchanged...

const converter = new MarkdownEpubConverter();
const mailer = new SmtpMailer({
  sender: config.sender,
  smtp: config.smtp,
});
const service = new SendToKindleService(converter, mailer, deliveryLogger);
const toolHandler = new ToolHandler(service, config.defaultAuthor, config.devices);
```

The MCP tool registration adds the `device` parameter:

```typescript
server.tool(
  "send_to_kindle",
  "Convert Markdown content to EPUB and send it to a Kindle device via email.",
  {
    title: z.string().describe("Document title"),
    content: z.string().describe("Document content in Markdown format"),
    author: z.string().optional().describe("Author name"),
    device: z.string().optional().describe("Target device name (omit for default)"),
  },
  async (args) => toolHandler.handle(args),
);
```

---

## 4. File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/domain/values/email-address.ts` | **New** | `EmailAddress` value object (R-DDD-1) |
| `src/domain/values/kindle-device.ts` | **New** | `KindleDevice` value object using `EmailAddress` |
| `src/domain/values/index.ts` | Modified | Export `EmailAddress` and `KindleDevice` |
| `src/domain/ports.ts` | Modified | `DocumentMailer.send()` gains `device: KindleDevice` parameter |
| `src/domain/send-to-kindle-service.ts` | Modified | `execute()` gains `device: KindleDevice` parameter; `DeliverySuccess` gains `deviceName` |
| `src/infrastructure/config/device-registry.ts` | **New** | `DeviceRegistry` lookup with validation (R-SoC-1) |
| `src/infrastructure/config.ts` | Modified | Parse `KINDLE_DEVICES`, `KINDLE_DEFAULT_DEVICE`, fallback to `KINDLE_EMAIL`; uses `EmailAddress` |
| `src/infrastructure/mailer/smtp-mailer.ts` | Modified | `send()` reads `device.email.value`; `SmtpMailerConfig` drops `kindle` |
| `src/application/tool-handler.ts` | Modified | Resolve `device` arg via `DeviceRegistry`, pass to service, read `deviceName` from result |
| `src/index.ts` | Modified | Wire `config.devices` into `ToolHandler`, add `device` to tool schema |

---

## 5. Dependency Flow

```
index.ts (composition root)
  |
  +-- loadConfig() --> Config { devices: DeviceRegistry, ... }
  |
  +-- ToolHandler(service, defaultAuthor, devices: DeviceRegistry)
  |     |
  |     +-- devices.resolve(args.device) --> Result<KindleDevice, ValidationError>
  |     +-- service.execute(title, content, author, device)
  |
  +-- SendToKindleService(converter, mailer, logger)
  |     |
  |     +-- converter.toEpub(title, content, author)
  |     +-- mailer.send(document, device)
  |     +-- returns DeliverySuccess { title, sizeBytes, deviceName }
  |
  +-- SmtpMailer(smtpConfig)
        |
        +-- send(document, device) --> uses device.email.value for "to" field
```

Domain depends on nothing external. Infrastructure implements domain ports and provides configuration resolution. Application orchestrates. Composition root wires everything. No circular dependencies.

---

## 6. SoC Audit

| Code | Rule | Verdict | Notes |
|------|------|---------|-------|
| SoC-001 | Code placement decision tree | **PASS** | `KindleDevice` and `EmailAddress` are domain value objects (Q5). `DeviceRegistry` is infrastructure config (Q7 -- shared config resolution). Config parsing is infrastructure. Device resolution in ToolHandler is thin translation (Q2). |
| SoC-002 | Dependencies point inward | **PASS** | Domain gains no infrastructure imports. Infrastructure imports domain value objects (`KindleDevice`, `EmailAddress`). Application imports domain and infrastructure types. |
| SoC-003 | Features never cross-import | **N/A** | Single-feature project. |
| SoC-004 | Domain never does I/O | **PASS** | `KindleDevice`, `EmailAddress` are pure. `DeviceRegistry` is pure (now in infrastructure but still no I/O). No env access, no file system, no network in domain. |
| SoC-005 | No business logic in commands | **N/A** | No commands layer in this project (MCP tool handler is an entrypoint). |
| SoC-006 | Entrypoints are thin translation layers | **PASS** | `ToolHandler.handle()` does parse-resolve-delegate only. `devices.resolve()` is a one-line call. Success message reads from `result.value.deviceName` directly. No business logic added. |
| SoC-007 | Commands own their inputs | **N/A** | No commands layer. |
| SoC-008 | Queries read, never write | **N/A** | No queries layer. |
| SoC-009 | No helpers in commands or queries | **N/A** | No commands/queries layer. |
| SoC-010 | Co-locate by change, not kind | **PASS** | `KindleDevice` and `EmailAddress` live in `domain/values/` with the other value objects. `DeviceRegistry` lives in `infrastructure/config/` with the config loader. No `types/` or `interfaces/` folder created. |
| SoC-011 | External wrappers in platform/infra | **PASS** | No new external service. `SmtpMailer` remains the only SMTP wrapper. |
| SoC-012 | Infra uses standard sub-folders | **PASS** | `DeviceRegistry` lives in `infrastructure/config/` (standard sub-folder). No files at infra root. |
| SoC-013 | Separate intent from execution | **PASS** | `SendToKindleService.execute()` remains a clear pipeline: convert then deliver. Device resolution happens before the service is called, not inside it. `DeliverySuccess` carries `deviceName` so the handler reads one result, not two. |
| SoC-014 | Separate functions that depend on different state | **PASS** | Device resolution (`DeviceRegistry`) is separate from SMTP delivery (`SmtpMailer`). Format parsing (`parseDeviceEntries`) is separate from registry construction (`buildDeviceRegistry`). The mailer only depends on SMTP config plus the passed-in device. |
| SoC-015 | Separate functions that don't have related names | **PASS** | `DeviceRegistry` has a focused API: `create`, `resolve`, `names`. All related to device lookup. `EmailAddress` has a focused API: `create`, `value`. |

## 7. Tactical DDD Checklist

| # | Check | Verdict | Notes |
|---|-------|---------|-------|
| 1 | Domain isolated from infrastructure | **PASS** | `KindleDevice`, `EmailAddress`, `SendToKindleService` have no infrastructure imports. `DeviceRegistry` moved to infrastructure. |
| 2 | Rich domain language | **PASS** | `KindleDevice`, `EmailAddress`, `DeviceRegistry`, `DeliverySuccess` -- all domain-expert recognizable names. No generic Manager/Handler/Processor in domain. |
| 3 | Orchestrate with use cases | **PASS** | `SendToKindleService.execute()` is the single use case (send to kindle). Device resolution is pre-processing in the entrypoint, not a separate use case. |
| 4 | Avoid anemic domain model | **PASS** | `KindleDevice` and `EmailAddress` validate at construction. The service orchestrates but does not contain business rules that belong in domain objects. |
| 5 | Separate generic concepts | **PASS** | Email regex validation is generic but wrapped in domain-named `EmailAddress`. No generic retry or utility logic mixed into domain. |
| 6 | Make the implicit explicit | **PASS** | `EmailAddress` makes "validated email" explicit instead of scattered regex. `DeviceRegistry` makes "device lookup" explicit. `DeliverySuccess.deviceName` makes "which device was targeted" explicit. |
| 7 | Design aggregates around invariants | **N/A** | No aggregates in this system (stateless request-response). `DeviceRegistry` enforces collection invariants (uniqueness, valid default) at construction time. |
| 8 | Extract immutable value objects liberally | **PASS** | `EmailAddress` extracted from raw string. `KindleDevice` composes `EmailAddress`. Both are immutable. |
| 9 | Repositories for full aggregates | **N/A** | No persistence in this system. |

---

## 8. Backwards Compatibility

The design preserves full backwards compatibility:

1. **No `KINDLE_DEVICES` set:** `loadConfig()` falls back to `KINDLE_EMAIL`, creates a single device named "default".
2. **No `device` parameter in tool call:** `DeviceRegistry.resolve(undefined)` returns the default device.
3. **Existing tests:** Tests that mock `DocumentMailer.send(document)` need a second argument added. This is a compile-time breakage that tests will catch immediately.

---

## 9. Security Constraints

- `DeviceRegistry.resolve()` error messages list device **names only**, never emails.
- `SmtpMailer` reads `device.email.value` internally but never logs it.
- The MCP tool response includes the device **name** in the success message, never the email.
- `DeliverySuccess.deviceName` carries the name, not the `EmailAddress`.
- Configuration validation errors at startup may mention email format issues but this is acceptable for operator-facing startup logs.

---

## 10. Test Strategy

### New Tests

**`EmailAddress` value object tests:**
- Valid email produces an `EmailAddress`.
- Invalid email returns `ValidationError`.
- Whitespace is trimmed.
- Custom field name appears in error.

**`KindleDevice` value object tests:**
- Valid name and `EmailAddress` produce a device.
- Empty name returns `ValidationError`.
- Name is trimmed and lowercased.

**`DeviceRegistry` tests:**
- Single device with no explicit default uses first entry.
- Multiple devices with explicit default resolves correctly.
- Duplicate names return error at creation.
- Unknown default name returns error at creation.
- `resolve(undefined)` returns default.
- `resolve("partner")` returns the named device.
- `resolve("unknown")` returns error listing names only (verify no emails in message).
- `names` returns all registered device names.

**Config parsing tests:**
- `KINDLE_DEVICES` parsed into devices correctly.
- Fallback to `KINDLE_EMAIL` when `KINDLE_DEVICES` is not set.
- `KINDLE_DEFAULT_DEVICE` validated against device list.
- Duplicate names in `KINDLE_DEVICES` fail at startup.
- Malformed entries (missing colon) fail at startup.
- Invalid email in `KINDLE_DEVICES` fails at startup with `EmailAddress` validation.

**Updated existing tests:**
- `SendToKindleService` tests pass a `KindleDevice` to `execute()` and verify `deviceName` in `DeliverySuccess`.
- `SmtpMailer` tests pass a `KindleDevice` to `send()` and verify `device.email.value` is used in `sendMail`.
- `ToolHandler` tests verify device resolution and the new `device` parameter.

### Estimated Test Count

Approximately 18-22 new tests across `EmailAddress`, `KindleDevice`, `DeviceRegistry`, and config parsing. Approximately 10-15 existing tests require a minor signature update (adding the `device` parameter).
