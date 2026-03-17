# PB-003: Multiple Kindle Addresses — Design

> Feature spec: `docs/features/active/multiple-kindle-addresses.md`
> Reviewed against: Separation of Concerns (SoC-001 through SoC-015)

---

## 1. Summary of Changes

The feature adds support for named Kindle devices so users can target different devices without reconfiguring the server. It introduces a `KindleDevice` value object, updates the `DocumentMailer` port signature, adds device resolution logic, and extends configuration parsing -- all while preserving backwards compatibility with the existing single-address `KINDLE_EMAIL` setup.

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

#### 3.1.1 New Value Object: `KindleDevice`

**File:** `src/domain/values/kindle-device.ts`

```typescript
import { ValidationError, type Result, ok, err } from "../errors.js";

export class KindleDevice {
  private constructor(
    readonly name: string,
    readonly email: string,
  ) {}

  static create(
    name: string,
    email: string,
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
    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return err(
        new ValidationError(
          "device.email",
          `Device email must be a valid address.`,
        ),
      );
    }
    return ok(new KindleDevice(trimmedName, trimmedEmail));
  }
}
```

**Rationale:**
- Follows existing value object pattern (private constructor, static `create`, returns `Result`).
- Name is lowercased and trimmed to normalize lookups.
- Email validation reuses the same regex pattern already in `config.ts`.
- Lives in `src/domain/values/` alongside `Title`, `Author`, etc. (SoC-010: co-locate by change).

**Export:** Add `export { KindleDevice } from "./kindle-device.js";` to `src/domain/values/index.ts`.

#### 3.1.2 Updated Port: `DocumentMailer`

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

#### 3.1.3 Updated Service: `SendToKindleService`

**File:** `src/domain/send-to-kindle-service.ts`

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
  });
}
```

**Rationale:** The service orchestrates; it does not resolve which device to use. That responsibility belongs to the caller (ToolHandler). The service just passes the resolved `KindleDevice` through to the mailer. This keeps the service focused on the convert-then-deliver pipeline (SoC-013: separate intent from execution).

#### 3.1.4 New Error Case: `UnknownDeviceError`

No new error class is needed. The existing `ValidationError` with `field: "device"` is sufficient:

```typescript
new ValidationError(
  "device",
  `Unknown device 'foo'. Available devices: personal, partner, family.`,
)
```

This keeps the `DomainError` union unchanged. The error message lists device names only (never emails), satisfying the security constraint.

#### 3.1.5 New Domain Type: `DeviceRegistry` (read-only lookup)

**File:** `src/domain/values/device-registry.ts`

```typescript
import type { KindleDevice } from "./kindle-device.js";
import { ValidationError, type Result, ok, err } from "../errors.js";

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
- Pure domain logic: validates uniqueness, resolves names, enforces the "names only in errors" rule.
- No I/O (SoC-004). The registry is constructed from already-parsed data.
- Immutable after construction (private constructor, `ReadonlyMap`).
- `resolve()` returns `Result` -- no exceptions.
- Lives in `src/domain/values/` because it is an immutable value container for validated configuration state.

**Export:** Add to `src/domain/values/index.ts`.

---

### 3.2 Infrastructure Layer Changes

#### 3.2.1 Updated `SmtpMailer`

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
        to: device.email,    // <-- was this.config.kindle.email
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

**Rationale:** The mailer reads `device.email` internally. The device name is never logged by the mailer -- logging happens at the service layer. The mailer's only job is SMTP delivery (SoC-014: separate functions that depend on different state).

#### 3.2.2 Updated `config.ts`

**File:** `src/infrastructure/config.ts`

The `Config` type changes:

```typescript
export interface Config {
  devices: DeviceRegistry;          // replaces kindle: { email: string }
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}
```

The `loadConfig()` function gains device parsing logic:

```typescript
function parseDevices(): DeviceRegistry {
  const devicesRaw = process.env.KINDLE_DEVICES;

  if (devicesRaw) {
    // New multi-device format: "name:email,name:email"
    const entries = devicesRaw.split(",").map((entry) => entry.trim());
    const devices: KindleDevice[] = [];

    for (const entry of entries) {
      const colonIndex = entry.indexOf(":");
      if (colonIndex === -1) {
        throw new Error(
          `Invalid KINDLE_DEVICES entry: "${entry}". Expected "name:email" format.`,
        );
      }
      const name = entry.slice(0, colonIndex);
      const email = entry.slice(colonIndex + 1);
      const result = KindleDevice.create(name, email);
      if (!result.ok) {
        throw new Error(
          `Invalid KINDLE_DEVICES entry: ${result.error.message}`,
        );
      }
      devices.push(result.value);
    }

    const defaultName = process.env.KINDLE_DEFAULT_DEVICE;
    const registryResult = DeviceRegistry.create(devices, defaultName);
    if (!registryResult.ok) {
      throw new Error(registryResult.error.message);
    }
    return registryResult.value;
  }

  // Backwards-compatible: single KINDLE_EMAIL
  const kindleEmail = validateEmail(
    requireEnv("KINDLE_EMAIL"),
    "KINDLE_EMAIL",
  );
  const device = KindleDevice.create("default", kindleEmail);
  if (!device.ok) {
    throw new Error(device.error.message);
  }
  const registryResult = DeviceRegistry.create([device.value]);
  if (!registryResult.ok) {
    throw new Error(registryResult.error.message);
  }
  return registryResult.value;
}
```

**Rationale:**
- Fail-fast: all validation errors (duplicate names, unknown default, bad emails) surface at startup.
- Backwards compatible: if only `KINDLE_EMAIL` is set, a single device named "default" is created.
- `KINDLE_DEVICES` takes precedence when set.
- Config throws on invalid state -- consistent with existing `loadConfig()` behavior.
- Config imports domain value objects (`KindleDevice`, `DeviceRegistry`) -- this is allowed since infrastructure can depend on domain (SoC-002).

---

### 3.3 Application Layer Changes

#### 3.3.1 Updated `ToolHandler`

**File:** `src/application/tool-handler.ts`

The handler gains access to the `DeviceRegistry` and accepts an optional `device` argument:

```typescript
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
            message: `Document '${result.value.title}' sent to Kindle (${deviceResult.value.name}) successfully.`,
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
- Device name (not email) appears in the success message.

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
| `src/domain/values/kindle-device.ts` | **New** | `KindleDevice` value object |
| `src/domain/values/device-registry.ts` | **New** | `DeviceRegistry` lookup with validation |
| `src/domain/values/index.ts` | Modified | Export `KindleDevice` and `DeviceRegistry` |
| `src/domain/ports.ts` | Modified | `DocumentMailer.send()` gains `device: KindleDevice` parameter |
| `src/domain/send-to-kindle-service.ts` | Modified | `execute()` gains `device: KindleDevice` parameter, passes to mailer |
| `src/infrastructure/config.ts` | Modified | Parse `KINDLE_DEVICES`, `KINDLE_DEFAULT_DEVICE`, fallback to `KINDLE_EMAIL` |
| `src/infrastructure/mailer/smtp-mailer.ts` | Modified | `send()` reads `device.email`; `SmtpMailerConfig` drops `kindle` |
| `src/application/tool-handler.ts` | Modified | Resolve `device` arg via `DeviceRegistry`, pass to service |
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
  |
  +-- SmtpMailer(smtpConfig)
        |
        +-- send(document, device) --> uses device.email for "to" field
```

Domain depends on nothing external. Infrastructure implements domain ports. Application orchestrates. Composition root wires everything. No circular dependencies.

---

## 6. SoC Audit

| Code | Rule | Verdict | Notes |
|------|------|---------|-------|
| SoC-001 | Code placement decision tree | **PASS** | `KindleDevice` and `DeviceRegistry` are domain value objects (Q5). Config parsing is infrastructure (Q7). Device resolution in ToolHandler is thin translation (Q2). |
| SoC-002 | Dependencies point inward | **PASS** | Domain gains no new imports. Infrastructure imports domain value objects (`KindleDevice`). Application imports domain types. |
| SoC-003 | Features never cross-import | **N/A** | Single-feature project. |
| SoC-004 | Domain never does I/O | **PASS** | `KindleDevice` and `DeviceRegistry` are pure. No env access, no file system, no network. |
| SoC-005 | No business logic in commands | **N/A** | No commands layer in this project (MCP tool handler is an entrypoint). |
| SoC-006 | Entrypoints are thin translation layers | **PASS** | `ToolHandler.handle()` does parse-resolve-delegate only. `devices.resolve()` is a one-line call. No business logic added. |
| SoC-007 | Commands own their inputs | **N/A** | No commands layer. |
| SoC-008 | Queries read, never write | **N/A** | No queries layer. |
| SoC-009 | No helpers in commands or queries | **N/A** | No commands/queries layer. |
| SoC-010 | Co-locate by change, not kind | **PASS** | `KindleDevice` and `DeviceRegistry` live in `domain/values/` with the other value objects they are used alongside. No `types/` or `interfaces/` folder created. |
| SoC-011 | External wrappers in platform/infra | **PASS** | No new external service. `SmtpMailer` remains the only SMTP wrapper. |
| SoC-012 | Infra uses standard sub-folders | **PASS** | No new infra sub-folders. Changes to `config.ts` (config/) and `smtp-mailer.ts` (mailer/) stay in existing locations. |
| SoC-013 | Separate intent from execution | **PASS** | `SendToKindleService.execute()` remains a clear pipeline: convert then deliver. Device resolution happens before the service is called, not inside it. |
| SoC-014 | Separate functions that depend on different state | **PASS** | Device resolution (`DeviceRegistry`) is separate from SMTP delivery (`SmtpMailer`). The mailer only depends on SMTP config plus the passed-in device. |
| SoC-015 | Separate functions that don't have related names | **PASS** | `DeviceRegistry` has a focused API: `create`, `resolve`, `names`. All related to device lookup. |

---

## 7. Backwards Compatibility

The design preserves full backwards compatibility:

1. **No `KINDLE_DEVICES` set:** `loadConfig()` falls back to `KINDLE_EMAIL`, creates a single device named "default".
2. **No `device` parameter in tool call:** `DeviceRegistry.resolve(undefined)` returns the default device.
3. **Existing tests:** Tests that mock `DocumentMailer.send(document)` need a second argument added. This is a compile-time breakage that tests will catch immediately.

---

## 8. Security Constraints

- `DeviceRegistry.resolve()` error messages list device **names only**, never emails.
- `SmtpMailer` reads `device.email` internally but never logs it.
- The MCP tool response includes the device **name** in the success message, never the email.
- Configuration validation errors at startup may mention email format issues but this is acceptable for operator-facing startup logs.

---

## 9. Test Strategy

### New Tests

**`KindleDevice` value object tests:**
- Valid name and email produce a device.
- Empty name returns `ValidationError`.
- Invalid email returns `ValidationError`.
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

**Updated existing tests:**
- `SendToKindleService` tests pass a `KindleDevice` to `execute()`.
- `SmtpMailer` tests pass a `KindleDevice` to `send()` and verify the email is used in `sendMail`.
- `ToolHandler` tests verify device resolution and the new `device` parameter.

### Estimated Test Count

Approximately 15-20 new tests across `KindleDevice`, `DeviceRegistry`, and config parsing. Approximately 10-15 existing tests require a minor signature update (adding the `device` parameter).
