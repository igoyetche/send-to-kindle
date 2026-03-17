# PB-003: Multiple Kindle Addresses — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace single-device `KINDLE_EMAIL` config with a named multi-device system using `KINDLE_DEVICES=name:email,...` so users can target different Kindle devices per send.

**Architecture:** Three new domain types (`EmailAddress`, `KindleDevice`, `DeviceRegistry`) slot into the existing three-layer architecture. Ports are updated so `DocumentMailer.send()` receives a `KindleDevice` and `DeliveryLogger` logs the device name. Config parsing switches from a single `KINDLE_EMAIL` env var to `KINDLE_DEVICES=name:email,...` tuples. `ToolHandler` resolves the optional `device` parameter before calling the service.

**Tech Stack:** TypeScript (strict), Vitest, existing domain/infra/application layers. No new npm packages.

**ADR:** `docs/designs/multiple-kindle-addresses/adr.md`

---

## Task Status Legend

`[ ]` Todo | `[~]` In progress | `[x]` Done (date) | `[-]` Dropped | `[!]` Blocked

---

## Task 1: `EmailAddress` value object

**Files:**
- Create: `src/domain/values/email-address.ts`
- Create: `test/domain/values/email-address.test.ts`
- Modify: `src/domain/values/index.ts`

**Step 1: Write the failing tests**

Create `test/domain/values/email-address.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EmailAddress } from "../../../src/domain/values/email-address.js";

describe("EmailAddress", () => {
  it("creates an EmailAddress from a valid email", () => {
    const result = EmailAddress.create("user@kindle.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("user@kindle.com");
    }
  });

  it("trims whitespace before validating", () => {
    const result = EmailAddress.create("  user@kindle.com  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe("user@kindle.com");
    }
  });

  it("returns ValidationError for an address without @", () => {
    const result = EmailAddress.create("not-an-email");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.field).toBe("email");
    }
  });

  it("returns ValidationError for an address without domain", () => {
    const result = EmailAddress.create("user@");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("uses custom field name in the error when provided", () => {
    const result = EmailAddress.create("bad", "device.email");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("device.email");
    }
  });
});
```

**Step 2: Run to confirm tests fail**

```bash
npx vitest run test/domain/values/email-address.test.ts
```

Expected: FAIL — `EmailAddress` does not exist yet.

**Step 3: Implement `EmailAddress`**

Create `src/domain/values/email-address.ts`:

```typescript
import { ValidationError, type Result, ok, err } from "../errors.js";

export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(
    raw: string,
    field: string = "email",
  ): Result<EmailAddress, ValidationError> {
    const trimmed = raw.trim();
    // TODO: replace with RFC 5322 compliant validation in a future pass
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return err(
        new ValidationError(field, `Invalid email address: "${trimmed}".`),
      );
    }
    return ok(new EmailAddress(trimmed));
  }
}
```

**Step 4: Export from values index**

Edit `src/domain/values/index.ts` — add one line:

```typescript
export { EmailAddress } from "./email-address.js";
```

**Step 5: Run tests to confirm they pass**

```bash
npx vitest run test/domain/values/email-address.test.ts
```

Expected: 5 passing.

**Step 6: Commit**

```bash
git add src/domain/values/email-address.ts src/domain/values/index.ts test/domain/values/email-address.test.ts
git commit -m "feat: add EmailAddress value object"
```

---

## Task 2: `KindleDevice` value object

**Files:**
- Create: `src/domain/values/kindle-device.ts`
- Create: `test/domain/values/kindle-device.test.ts`
- Modify: `src/domain/values/index.ts`

**Step 1: Write the failing tests**

Create `test/domain/values/kindle-device.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { KindleDevice } from "../../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../../src/domain/values/email-address.js";

function makeEmail(raw = "user@kindle.com"): EmailAddress {
  const result = EmailAddress.create(raw);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

describe("KindleDevice", () => {
  it("creates a device from a valid name and EmailAddress", () => {
    const result = KindleDevice.create("personal", makeEmail());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("lowercases and trims the name", () => {
    const result = KindleDevice.create("  Personal  ", makeEmail());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("returns ValidationError for empty name", () => {
    const result = KindleDevice.create("", makeEmail());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.field).toBe("device.name");
    }
  });

  it("returns ValidationError for name containing ':'", () => {
    const result = KindleDevice.create("my:device", makeEmail());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns ValidationError for name containing ','", () => {
    const result = KindleDevice.create("a,b", makeEmail());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("accepts alphanumeric, hyphens, and underscores in name", () => {
    for (const name of ["personal", "my-kindle", "device_1", "abc123"]) {
      const result = KindleDevice.create(name, makeEmail());
      expect(result.ok).toBe(true);
    }
  });

  it("stores the email as the passed-in EmailAddress", () => {
    const email = makeEmail("partner@kindle.com");
    const result = KindleDevice.create("partner", email);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email.value).toBe("partner@kindle.com");
    }
  });
});
```

**Step 2: Run to confirm tests fail**

```bash
npx vitest run test/domain/values/kindle-device.test.ts
```

Expected: FAIL — `KindleDevice` does not exist yet.

**Step 3: Implement `KindleDevice`**

Create `src/domain/values/kindle-device.ts`:

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
    const trimmed = name.trim().toLowerCase();
    if (trimmed.length === 0) {
      return err(
        new ValidationError("device.name", "Device name must be non-empty."),
      );
    }
    if (!/^[a-z0-9_-]+$/.test(trimmed)) {
      return err(
        new ValidationError(
          "device.name",
          `Device name '${name}' contains invalid characters. Use alphanumeric, hyphens, and underscores only.`,
        ),
      );
    }
    return ok(new KindleDevice(trimmed, email));
  }
}
```

**Step 4: Export from values index**

Edit `src/domain/values/index.ts` — add one line:

```typescript
export { KindleDevice } from "./kindle-device.js";
```

**Step 5: Run tests**

```bash
npx vitest run test/domain/values/kindle-device.test.ts
```

Expected: 7 passing.

**Step 6: Commit**

```bash
git add src/domain/values/kindle-device.ts src/domain/values/index.ts test/domain/values/kindle-device.test.ts
git commit -m "feat: add KindleDevice value object"
```

---

## Task 3: `DeviceRegistry` domain type

**Files:**
- Create: `src/domain/device-registry.ts`
- Create: `test/domain/device-registry.test.ts`

**Step 1: Write the failing tests**

Create `test/domain/device-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";

function makeDevice(name: string, email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup: " + deviceResult.error.message);
  return deviceResult.value;
}

describe("DeviceRegistry", () => {
  it("creates a registry with a single device using it as the default", () => {
    const result = DeviceRegistry.create([makeDevice("personal")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defaultDevice.name).toBe("personal");
    }
  });

  it("uses explicit default when KINDLE_DEFAULT_DEVICE is provided", () => {
    const devices = [makeDevice("personal"), makeDevice("partner", "partner@kindle.com")];
    const result = DeviceRegistry.create(devices, "partner");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defaultDevice.name).toBe("partner");
    }
  });

  it("returns ValidationError for empty device list", () => {
    const result = DeviceRegistry.create([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns ValidationError for duplicate device names", () => {
    const result = DeviceRegistry.create([
      makeDevice("personal"),
      makeDevice("personal"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("personal");
    }
  });

  it("returns ValidationError when default device name is unknown", () => {
    const result = DeviceRegistry.create([makeDevice("personal")], "unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns ValidationError when more than 10 devices are provided", () => {
    const devices = Array.from({ length: 11 }, (_, i) =>
      makeDevice(`device${i}`, `device${i}@kindle.com`),
    );
    const result = DeviceRegistry.create(devices);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("10");
    }
  });

  it("resolve(undefined) returns the default device", () => {
    const registry = DeviceRegistry.create([makeDevice("personal")]);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("resolve by name returns the named device", () => {
    const devices = [makeDevice("personal"), makeDevice("partner", "partner@kindle.com")];
    const registry = DeviceRegistry.create(devices);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve("partner");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("partner");
    }
  });

  it("resolve is case-insensitive", () => {
    const registry = DeviceRegistry.create([makeDevice("personal")]);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve("Personal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("resolve returns ValidationError for unknown name listing names only (no emails)", () => {
    const registry = DeviceRegistry.create([makeDevice("personal")]);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toContain("personal");
      expect(result.error.message).not.toContain("@");
    }
  });

  it("names getter returns all registered device names", () => {
    const devices = [makeDevice("personal"), makeDevice("partner", "partner@kindle.com")];
    const registry = DeviceRegistry.create(devices);
    if (!registry.ok) throw new Error("bad test setup");
    expect(registry.value.names).toEqual(["personal", "partner"]);
  });
});
```

**Step 2: Run to confirm tests fail**

```bash
npx vitest run test/domain/device-registry.test.ts
```

Expected: FAIL — `DeviceRegistry` does not exist yet.

**Step 3: Implement `DeviceRegistry`**

Create `src/domain/device-registry.ts`:

```typescript
import type { KindleDevice } from "./values/kindle-device.js";
import { ValidationError, type Result, ok, err } from "./errors.js";

const MAX_DEVICES = 10;

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
    if (devices.length > MAX_DEVICES) {
      return err(
        new ValidationError(
          "devices",
          `Too many devices: ${devices.length}. Maximum is ${MAX_DEVICES}.`,
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

**Step 4: Run tests**

```bash
npx vitest run test/domain/device-registry.test.ts
```

Expected: 11 passing.

**Step 5: Commit**

```bash
git add src/domain/device-registry.ts test/domain/device-registry.test.ts
git commit -m "feat: add DeviceRegistry domain type"
```

---

## Task 4: Update `DocumentMailer` port + `SmtpMailer`

This task updates the port signature and fixes all downstream TypeScript errors in one step.

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/infrastructure/mailer/smtp-mailer.ts`
- Modify: `test/infrastructure/mailer/smtp-mailer.test.ts`

**Step 1: Update the port**

Edit `src/domain/ports.ts`. Change `DocumentMailer`:

```typescript
import type { Title, Author, MarkdownContent, EpubDocument, KindleDevice } from "./values/index.js";
import type { DeliveryError, ConversionError, Result } from "./errors.js";

export interface ContentConverter {
  toEpub(
    title: Title,
    content: MarkdownContent,
    author: Author,
  ): Promise<Result<EpubDocument, ConversionError>>;
}

export interface DocumentMailer {
  send(
    document: EpubDocument,
    device: KindleDevice,
  ): Promise<Result<void, DeliveryError>>;
}

export interface DeliveryLogger {
  deliveryAttempt(title: string, format: string): void;
  deliverySuccess(title: string, format: string, sizeBytes: number): void;
  deliveryFailure(title: string, errorKind: string, message: string): void;
}
```

(DeliveryLogger unchanged for now — that is Task 5.)

**Step 2: Run build to see TypeScript errors**

```bash
npm run build 2>&1 | head -30
```

Expected: errors in `smtp-mailer.ts` and `send-to-kindle-service.ts` about missing `device` argument.

**Step 3: Write updated failing test for SmtpMailer**

Edit `test/infrastructure/mailer/smtp-mailer.test.ts`. Replace the entire file:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmtpMailer, type SmtpMailerConfig } from "../../../src/infrastructure/mailer/smtp-mailer.js";
import { EpubDocument } from "../../../src/domain/values/epub-document.js";
import { KindleDevice } from "../../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../../src/domain/values/email-address.js";
import nodemailer from "nodemailer";

vi.mock("nodemailer");

const config: SmtpMailerConfig = {
  sender: { email: "sender@example.com" },
  smtp: { host: "smtp.example.com", port: 587, user: "user", pass: "pass" },
};

function makeDocument(): EpubDocument {
  return new EpubDocument("Test Book", Buffer.from("fake-epub"));
}

function makeDevice(email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create("personal", emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup");
  return deviceResult.value;
}

describe("SmtpMailer", () => {
  let mockSendMail: ReturnType<typeof vi.fn>;
  let mockTransporter: { sendMail: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail = vi.fn().mockResolvedValue({ messageId: "abc123" });
    mockTransporter = { sendMail: mockSendMail };
    vi.mocked(nodemailer.createTransport).mockReturnValue(
      mockTransporter as any,
    );
  });

  it("sends email with correct fields on success", async () => {
    const mailer = new SmtpMailer(config);
    const doc = makeDocument();
    const device = makeDevice("user@kindle.com");

    const result = await mailer.send(doc, device);

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        to: "user@kindle.com",
        subject: "Test Book",
        attachments: [
          expect.objectContaining({
            content: doc.buffer,
            contentType: "application/epub+zip",
          }),
        ],
      }),
    );
  });

  it("uses device.email.value as the to field", async () => {
    const mailer = new SmtpMailer(config);
    const device = makeDevice("partner@kindle.com");

    await mailer.send(makeDocument(), device);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "partner@kindle.com" }),
    );
  });

  it("returns auth DeliveryError on authentication failure", async () => {
    const authError = new Error("Invalid login");
    (authError as any).code = "EAUTH";
    mockSendMail.mockRejectedValue(authError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument(), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("auth");
    }
  });

  it("returns connection DeliveryError on connection failure", async () => {
    const connError = new Error("Connection refused");
    (connError as any).code = "ECONNECTION";
    mockSendMail.mockRejectedValue(connError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument(), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("connection");
    }
  });

  it("returns rejection DeliveryError on envelope rejection", async () => {
    const rejectError = new Error("550 Recipient rejected");
    (rejectError as any).responseCode = 550;
    mockSendMail.mockRejectedValue(rejectError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument(), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("rejection");
    }
  });
});
```

**Step 4: Update `SmtpMailer`**

Replace the contents of `src/infrastructure/mailer/smtp-mailer.ts`:

```typescript
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { DocumentMailer } from "../../domain/ports.js";
import type { EpubDocument } from "../../domain/values/index.js";
import type { KindleDevice } from "../../domain/values/index.js";
import { DeliveryError, type Result, ok, err } from "../../domain/errors.js";

export interface SmtpMailerConfig {
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 100);
  return `${slug || "document"}.epub`;
}

function categorizeError(
  error: unknown,
): { cause: "auth" | "connection" | "rejection"; message: string } {
  if (error instanceof Error) {
    const code = (error as any).code;
    const responseCode = (error as any).responseCode;

    if (code === "EAUTH") {
      return {
        cause: "auth",
        message:
          "SMTP authentication failed. Check SMTP_USER and SMTP_PASS configuration.",
      };
    }
    if (
      code === "ECONNECTION" ||
      code === "ESOCKET" ||
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED"
    ) {
      return {
        cause: "connection",
        message: `SMTP connection failed: ${error.message}`,
      };
    }
    if (responseCode && responseCode >= 500) {
      return {
        cause: "rejection",
        message: `Email rejected by server: ${error.message}`,
      };
    }
    return { cause: "connection", message: error.message };
  }
  return { cause: "connection", message: "Unknown SMTP error" };
}

export class SmtpMailer implements DocumentMailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpMailerConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(
    document: EpubDocument,
    device: KindleDevice,
  ): Promise<Result<void, DeliveryError>> {
    const filename = slugify(document.title);

    try {
      await this.transporter.sendMail({
        from: this.config.sender.email,
        to: device.email.value,
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

**Step 5: Fix `send-to-kindle-service.ts` TypeScript error (temporary stub)**

The service calls `this.mailer.send(document)` which is now missing the `device` argument. Add a placeholder — we'll fully update the service in Task 6. For now, pass `undefined as any` to unblock compilation:

Actually, do **not** use `as any`. Instead, leave this temporarily broken at the type level — the build will fail, but the test for SmtpMailer can still run because Vitest doesn't require the whole project to compile.

Skip this step — proceed to running just the mailer tests.

**Step 6: Run SmtpMailer tests**

```bash
npx vitest run test/infrastructure/mailer/smtp-mailer.test.ts
```

Expected: 5 passing.

**Step 7: Commit**

```bash
git add src/domain/ports.ts src/infrastructure/mailer/smtp-mailer.ts test/infrastructure/mailer/smtp-mailer.test.ts
git commit -m "feat: update DocumentMailer port and SmtpMailer to accept KindleDevice"
```

---

## Task 5: Update `DeliveryLogger` port + `logger.ts`

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/infrastructure/logger.ts`
- Modify: `test/infrastructure/logger.test.ts`

**Step 1: Read the existing logger test to understand what to update**

File: `test/infrastructure/logger.test.ts` — note the current `deliveryAttempt`, `deliverySuccess`, `deliveryFailure` call signatures.

**Step 2: Update the port**

Edit `src/domain/ports.ts`. Replace `DeliveryLogger`:

```typescript
export interface DeliveryLogger {
  deliveryAttempt(title: string, format: string, deviceName: string): void;
  deliverySuccess(title: string, format: string, sizeBytes: number, deviceName: string): void;
  deliveryFailure(title: string, errorKind: string, message: string, deviceName: string): void;
}
```

**Step 3: Update `logger.ts`**

Replace the contents of `src/infrastructure/logger.ts`:

```typescript
import pino from "pino";
import type { Logger } from "pino";
import type { DeliveryLogger } from "../domain/ports.js";

export function createPinoLogger(level: string): Logger {
  // Write to stderr — stdout is reserved for JSON-RPC when using stdio transport
  return pino({ level }, pino.destination(2));
}

export function createDeliveryLogger(logger: Logger): DeliveryLogger {
  return {
    deliveryAttempt(title: string, format: string, deviceName: string): void {
      logger.info({ title, format, deviceName }, "Delivery attempt started");
    },
    deliverySuccess(
      title: string,
      format: string,
      sizeBytes: number,
      deviceName: string,
    ): void {
      logger.info({ title, format, sizeBytes, deviceName }, "Delivery succeeded");
    },
    deliveryFailure(
      title: string,
      errorKind: string,
      errorMessage: string,
      deviceName: string,
    ): void {
      logger.error(
        { title, errorKind, errorMessage, deviceName },
        "Delivery failed",
      );
    },
  };
}
```

**Step 4: Update logger tests**

Read `test/infrastructure/logger.test.ts`. Update any assertions that call `deliveryAttempt`, `deliverySuccess`, or `deliveryFailure` to pass the new `deviceName` argument (e.g., `"personal"`).

**Step 5: Run logger tests**

```bash
npx vitest run test/infrastructure/logger.test.ts
```

Expected: all passing.

**Step 6: Commit**

```bash
git add src/domain/ports.ts src/infrastructure/logger.ts test/infrastructure/logger.test.ts
git commit -m "feat: update DeliveryLogger port to include deviceName in all log methods"
```

---

## Task 6: Update `SendToKindleService`

This task adds the `device: KindleDevice` parameter, updates `DeliverySuccess`, and updates all service tests.

**Files:**
- Modify: `src/domain/send-to-kindle-service.ts`
- Modify: `test/domain/send-to-kindle-service.test.ts`

**Step 1: Write updated failing tests**

Replace `test/domain/send-to-kindle-service.test.ts` with:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";
import { Title } from "../../src/domain/values/title.js";
import { Author } from "../../src/domain/values/author.js";
import { MarkdownContent } from "../../src/domain/values/markdown-content.js";
import { EpubDocument } from "../../src/domain/values/epub-document.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import {
  ConversionError,
  DeliveryError,
  ok,
  err,
} from "../../src/domain/errors.js";
import type {
  ContentConverter,
  DocumentMailer,
  DeliveryLogger,
} from "../../src/domain/ports.js";

function makeTitle(value: string) {
  const result = Title.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeAuthor(value: string) {
  const result = Author.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeContent(value: string) {
  const result = MarkdownContent.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeDevice(name = "personal"): KindleDevice {
  const emailResult = EmailAddress.create("user@kindle.com");
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup");
  return deviceResult.value;
}

function fakeLogger(): DeliveryLogger {
  return {
    deliveryAttempt: vi.fn(),
    deliverySuccess: vi.fn(),
    deliveryFailure: vi.fn(),
  };
}

describe("SendToKindleService", () => {
  it("converts then delivers on happy path", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);
    const device = makeDevice("personal");

    const result = await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), device);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Test");
      expect(result.value.sizeBytes).toBe(epub.sizeBytes);
      expect(result.value.deviceName).toBe("personal");
    }
    expect(mailer.send).toHaveBeenCalledWith(epub, device);
  });

  it("returns conversion error without calling mailer", async () => {
    const conversionError = new ConversionError("EPUB gen failed");
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(err(conversionError)),
    };
    const mailer: DocumentMailer = { send: vi.fn() };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const result = await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conversion");
    }
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("returns delivery error when mailer fails", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const deliveryError = new DeliveryError("auth", "SMTP auth failed");
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(err(deliveryError)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const result = await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("delivery");
    }
  });

  it("logs attempt and success with device name on happy path", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice("personal"));

    expect(logger.deliveryAttempt).toHaveBeenCalledWith("Test", "epub", "personal");
    expect(logger.deliverySuccess).toHaveBeenCalledWith("Test", "epub", epub.sizeBytes, "personal");
  });

  it("logs attempt and failure with device name on error", async () => {
    const conversionError = new ConversionError("EPUB gen failed");
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(err(conversionError)),
    };
    const mailer: DocumentMailer = { send: vi.fn() };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice("personal"));

    expect(logger.deliveryAttempt).toHaveBeenCalledWith("Test", "epub", "personal");
    expect(logger.deliveryFailure).toHaveBeenCalledWith("Test", "conversion", "EPUB gen failed", "personal");
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
npx vitest run test/domain/send-to-kindle-service.test.ts
```

Expected: FAIL — `execute()` doesn't accept a `device` argument yet.

**Step 3: Update the service**

Replace `src/domain/send-to-kindle-service.ts`:

```typescript
import type { Title, Author, MarkdownContent, KindleDevice } from "./values/index.js";
import type { ContentConverter, DocumentMailer, DeliveryLogger } from "./ports.js";
import type { DomainError, Result } from "./errors.js";
import { ok } from "./errors.js";

export interface DeliverySuccess {
  readonly title: string;
  readonly sizeBytes: number;
  readonly deviceName: string;
}

export class SendToKindleService {
  constructor(
    private readonly converter: ContentConverter,
    private readonly mailer: DocumentMailer,
    private readonly logger: DeliveryLogger,
  ) {}

  async execute(
    title: Title,
    content: MarkdownContent,
    author: Author,
    device: KindleDevice,
  ): Promise<Result<DeliverySuccess, DomainError>> {
    this.logger.deliveryAttempt(title.value, "epub", device.name);

    const convertResult = await this.converter.toEpub(title, content, author);
    if (!convertResult.ok) {
      this.logger.deliveryFailure(
        title.value,
        convertResult.error.kind,
        convertResult.error.message,
        device.name,
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
        device.name,
      );
      return sendResult;
    }

    this.logger.deliverySuccess(title.value, "epub", document.sizeBytes, device.name);

    return ok({
      title: title.value,
      sizeBytes: document.sizeBytes,
      deviceName: device.name,
    });
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run test/domain/send-to-kindle-service.test.ts
```

Expected: 5 passing.

**Step 5: Commit**

```bash
git add src/domain/send-to-kindle-service.ts test/domain/send-to-kindle-service.test.ts
git commit -m "feat: update SendToKindleService to accept KindleDevice and return deviceName"
```

---

## Task 7: Update `config.ts`

Replace `KINDLE_EMAIL` with `KINDLE_DEVICES` parsing. Uses `Result`-returning helpers internally.

**Files:**
- Modify: `src/infrastructure/config.ts`
- Modify: `test/infrastructure/config.test.ts`

**Step 1: Write updated failing config tests**

Replace `test/infrastructure/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";

function requiredEnv(): Record<string, string> {
  return {
    KINDLE_DEVICES: "personal:user@kindle.com",
    SENDER_EMAIL: "sender@example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASS: "pass",
  };
}

describe("loadConfig", () => {
  beforeEach(() => {
    for (const key of [
      "KINDLE_DEVICES",
      "KINDLE_DEFAULT_DEVICE",
      "SENDER_EMAIL",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "DEFAULT_AUTHOR",
      "MCP_HTTP_PORT",
      "MCP_AUTH_TOKEN",
      "LOG_LEVEL",
    ]) {
      delete process.env[key];
    }
  });

  it("loads a single device from KINDLE_DEVICES", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.devices.names).toEqual(["personal"]);
    expect(config.devices.defaultDevice.name).toBe("personal");
  });

  it("loads multiple devices from KINDLE_DEVICES", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:me@kindle.com,partner:partner@kindle.com",
    });
    const config = loadConfig();
    expect(config.devices.names).toEqual(["personal", "partner"]);
  });

  it("uses KINDLE_DEFAULT_DEVICE to set the default", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:me@kindle.com,partner:partner@kindle.com",
      KINDLE_DEFAULT_DEVICE: "partner",
    });
    const config = loadConfig();
    expect(config.devices.defaultDevice.name).toBe("partner");
  });

  it("throws when KINDLE_DEVICES is missing", () => {
    const env = requiredEnv();
    delete env.KINDLE_DEVICES;
    Object.assign(process.env, env);
    expect(() => loadConfig()).toThrow("KINDLE_DEVICES");
  });

  it("throws when a KINDLE_DEVICES entry has no colon", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal",
    });
    expect(() => loadConfig()).toThrow();
  });

  it("throws when a KINDLE_DEVICES email is invalid", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:not-an-email",
    });
    expect(() => loadConfig()).toThrow();
  });

  it("throws when KINDLE_DEVICES has duplicate device names", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:a@kindle.com,personal:b@kindle.com",
    });
    expect(() => loadConfig()).toThrow("personal");
  });

  it("throws when KINDLE_DEFAULT_DEVICE references unknown device", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEFAULT_DEVICE: "ghost",
    });
    expect(() => loadConfig()).toThrow();
  });

  it("throws when more than 10 devices are configured", () => {
    const entries = Array.from(
      { length: 11 },
      (_, i) => `device${i}:d${i}@kindle.com`,
    ).join(",");
    Object.assign(process.env, { ...requiredEnv(), KINDLE_DEVICES: entries });
    expect(() => loadConfig()).toThrow();
  });

  it("validates SENDER_EMAIL format", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      SENDER_EMAIL: "bad-email",
    });
    expect(() => loadConfig()).toThrow("SENDER_EMAIL");
  });

  it("coerces SMTP_PORT to number", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(typeof config.smtp.port).toBe("number");
  });

  it("defaults DEFAULT_AUTHOR to 'Claude'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.defaultAuthor).toBe("Claude");
  });

  it("sets http config when MCP_HTTP_PORT and MCP_AUTH_TOKEN are present", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_TOKEN: "secret",
    });
    const config = loadConfig();
    expect(config.http).toEqual({ port: 3000, authToken: "secret" });
  });

  it("throws when MCP_HTTP_PORT is set without MCP_AUTH_TOKEN", () => {
    Object.assign(process.env, { ...requiredEnv(), MCP_HTTP_PORT: "3000" });
    expect(() => loadConfig()).toThrow("MCP_AUTH_TOKEN");
  });

  it("defaults LOG_LEVEL to 'info'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.logLevel).toBe("info");
  });
});
```

**Step 2: Run to confirm tests fail**

```bash
npx vitest run test/infrastructure/config.test.ts
```

Expected: FAIL — config still reads `KINDLE_EMAIL`.

**Step 3: Update `config.ts`**

Replace the contents of `src/infrastructure/config.ts`:

```typescript
import { EmailAddress } from "../domain/values/email-address.js";
import { KindleDevice } from "../domain/values/kindle-device.js";
import { DeviceRegistry } from "../domain/device-registry.js";
import type { ValidationError, Result } from "../domain/errors.js";
import { ok, err } from "../domain/errors.js";

export interface Config {
  devices: DeviceRegistry;
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseDeviceEntries(
  raw: string,
): Result<Array<{ name: string; email: string }>, ValidationError> {
  const entries: Array<{ name: string; email: string }> = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      return err({
        kind: "validation" as const,
        field: "KINDLE_DEVICES",
        message: `Invalid entry: "${trimmed}". Expected "name:email" format.`,
      });
    }
    entries.push({
      name: trimmed.slice(0, colonIndex),
      email: trimmed.slice(colonIndex + 1),
    });
  }
  return ok(entries);
}

function buildDeviceRegistry(
  entries: Array<{ name: string; email: string }>,
  defaultName?: string,
): Result<DeviceRegistry, ValidationError> {
  const devices: KindleDevice[] = [];
  for (const entry of entries) {
    const emailResult = EmailAddress.create(entry.email, "device.email");
    if (!emailResult.ok) return emailResult;
    const deviceResult = KindleDevice.create(entry.name, emailResult.value);
    if (!deviceResult.ok) return deviceResult;
    devices.push(deviceResult.value);
  }
  return DeviceRegistry.create(devices, defaultName);
}

function parseDevices(): DeviceRegistry {
  const raw = requireEnv("KINDLE_DEVICES");
  const entriesResult = parseDeviceEntries(raw);
  if (!entriesResult.ok) throw new Error(entriesResult.error.message);
  const defaultName = process.env.KINDLE_DEFAULT_DEVICE;
  const registryResult = buildDeviceRegistry(entriesResult.value, defaultName);
  if (!registryResult.ok) throw new Error(registryResult.error.message);
  return registryResult.value;
}

export function loadConfig(): Config {
  const devices = parseDevices();

  const senderEmailResult = EmailAddress.create(
    requireEnv("SENDER_EMAIL"),
    "SENDER_EMAIL",
  );
  if (!senderEmailResult.ok) {
    throw new Error(senderEmailResult.error.message);
  }

  const smtpHost = requireEnv("SMTP_HOST");
  const smtpPort = Number(requireEnv("SMTP_PORT"));
  const smtpUser = requireEnv("SMTP_USER");
  const smtpPass = requireEnv("SMTP_PASS");

  const defaultAuthor = process.env.DEFAULT_AUTHOR || "Claude";
  const logLevel = process.env.LOG_LEVEL || "info";

  let http: Config["http"];
  const httpPort = process.env.MCP_HTTP_PORT;
  if (httpPort) {
    const authToken = process.env.MCP_AUTH_TOKEN;
    if (!authToken) {
      throw new Error("MCP_AUTH_TOKEN is required when MCP_HTTP_PORT is set");
    }
    http = { port: Number(httpPort), authToken };
  }

  return {
    devices,
    sender: { email: senderEmailResult.value.value },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
    defaultAuthor,
    http,
    logLevel,
  };
}
```

**Step 4: Run config tests**

```bash
npx vitest run test/infrastructure/config.test.ts
```

Expected: all passing.

**Step 5: Commit**

```bash
git add src/infrastructure/config.ts test/infrastructure/config.test.ts
git commit -m "feat: replace KINDLE_EMAIL with KINDLE_DEVICES tuple parsing in config"
```

---

## Task 8: Update `ToolHandler`

**Files:**
- Modify: `src/application/tool-handler.ts`
- Modify: `test/application/tool-handler.test.ts`

**Step 1: Write updated failing tests**

Replace `test/application/tool-handler.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ToolHandler } from "../../src/application/tool-handler.js";
import {
  ok,
  err,
  ConversionError,
  DeliveryError,
} from "../../src/domain/errors.js";
import type { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";

function makeDevice(name: string, email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup");
  return deviceResult.value;
}

function makeRegistry(...names: string[]): DeviceRegistry {
  const devices = names.map((n, i) => makeDevice(n, `d${i}@kindle.com`));
  const result = DeviceRegistry.create(devices);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function fakeService(
  result = ok({ title: "Test", sizeBytes: 1024, deviceName: "personal" }),
): SendToKindleService {
  return {
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as SendToKindleService;
}

describe("ToolHandler", () => {
  it("returns success response including device name on happy path", async () => {
    const service = fakeService(ok({ title: "My Book", sizeBytes: 2048, deviceName: "personal" }));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"));

    const response = await handler.handle({ title: "My Book", content: "# Hello" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain("My Book");
    expect(parsed.message).toContain("personal");
  });

  it("uses default author when not provided", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "DefaultBot", makeRegistry("personal"));

    await handler.handle({ title: "Test", content: "# Hi" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ value: "DefaultBot" }),
      expect.anything(),
    );
  });

  it("resolves the default device when no device arg provided", async () => {
    const service = fakeService();
    const registry = makeRegistry("personal");
    const handler = new ToolHandler(service, "Claude", registry);

    await handler.handle({ title: "Test", content: "# Hi" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ name: "personal" }),
    );
  });

  it("resolves a named device when device arg is provided", async () => {
    const service = fakeService();
    const registry = makeRegistry("personal", "partner");
    const handler = new ToolHandler(service, "Claude", registry);

    await handler.handle({ title: "Test", content: "# Hi", device: "partner" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ name: "partner" }),
    );
  });

  it("returns validation error for unknown device name", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"));

    const response = await handler.handle({ title: "Test", content: "# Hi", device: "ghost" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
    expect(parsed.details).not.toContain("@");
  });

  it("returns validation error for empty title", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"));

    const response = await handler.handle({ title: "", content: "# Hi" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
  });

  it("maps ConversionError to CONVERSION_ERROR", async () => {
    const service = fakeService(err(new ConversionError("fail")));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"));

    const response = await handler.handle({ title: "Test", content: "# Hi" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.error).toBe("CONVERSION_ERROR");
  });

  it("maps DeliveryError to SMTP_ERROR", async () => {
    const service = fakeService(err(new DeliveryError("auth", "fail")));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"));

    const response = await handler.handle({ title: "Test", content: "# Hi" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.error).toBe("SMTP_ERROR");
  });

  it("sets isError true on failure responses", async () => {
    const service = fakeService(err(new ConversionError("fail")));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"));

    const response = await handler.handle({ title: "Test", content: "# Hi" });

    expect(response.isError).toBe(true);
  });
});
```

**Step 2: Run to confirm tests fail**

```bash
npx vitest run test/application/tool-handler.test.ts
```

Expected: FAIL — `ToolHandler` constructor doesn't accept a registry yet.

**Step 3: Update `ToolHandler`**

Replace `src/application/tool-handler.ts`:

```typescript
import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import type { DeviceRegistry } from "../domain/device-registry.js";
import { Title, Author, MarkdownContent } from "../domain/values/index.js";
import type { DomainError } from "../domain/errors.js";

// MCP SDK response type
interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function mapErrorToResponse(error: DomainError): McpToolResponse {
  let errorCode: string;
  switch (error.kind) {
    case "validation":
      errorCode = "VALIDATION_ERROR";
      break;
    case "size_limit":
      errorCode = "SIZE_ERROR";
      break;
    case "conversion":
      errorCode = "CONVERSION_ERROR";
      break;
    case "delivery":
      errorCode = "SMTP_ERROR";
      break;
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          error: errorCode,
          details: error.message,
        }),
      },
    ],
    isError: true,
  };
}

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

    const titleResult = Title.create(args.title);
    if (!titleResult.ok) return mapErrorToResponse(titleResult.error);

    const contentResult = MarkdownContent.create(args.content);
    if (!contentResult.ok) return mapErrorToResponse(contentResult.error);

    const authorRaw = args.author?.trim() || this.defaultAuthor;
    const authorResult = Author.create(authorRaw);
    if (!authorResult.ok) return mapErrorToResponse(authorResult.error);

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

**Step 4: Run tests**

```bash
npx vitest run test/application/tool-handler.test.ts
```

Expected: all passing.

**Step 5: Commit**

```bash
git add src/application/tool-handler.ts test/application/tool-handler.test.ts
git commit -m "feat: update ToolHandler to resolve device via DeviceRegistry"
```

---

## Task 9: Wire composition root + update `.env.example`

**Files:**
- Modify: `src/index.ts`
- Modify: `.env.example`

**Step 1: Update `src/index.ts`**

Replace the relevant parts of `src/index.ts`:

```typescript
import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { ToolHandler } from "./application/tool-handler.js";

const config = loadConfig();
const pinoLogger = createPinoLogger(config.logLevel);
const deliveryLogger = createDeliveryLogger(pinoLogger);

const converter = new MarkdownEpubConverter();
const mailer = new SmtpMailer({
  sender: config.sender,
  smtp: config.smtp,
});
const service = new SendToKindleService(converter, mailer, deliveryLogger);
const toolHandler = new ToolHandler(service, config.defaultAuthor, config.devices);

const TOOL_DESCRIPTION =
  "Convert Markdown content to EPUB and send it to a Kindle device via email. " +
  "Optionally specify a target device by name.";

const server = new McpServer({
  name: "send-to-kindle",
  version: "1.0.0",
});

server.tool(
  "send_to_kindle",
  TOOL_DESCRIPTION,
  {
    title: z.string().describe("Document title that will appear in the Kindle library"),
    content: z.string().describe("Document content in Markdown format"),
    author: z
      .string()
      .optional()
      .describe("Author name for document metadata (defaults to configured value)"),
    device: z
      .string()
      .optional()
      .describe(
        `Target device name. Available devices: ${config.devices.names.join(", ")}. Omit to use the default device.`,
      ),
  },
  async (args) => toolHandler.handle(args),
);

// stdio transport (always active)
const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

pinoLogger.info("Send to Kindle MCP server started (stdio)");

// HTTP/SSE transport (if configured)
if (config.http) {
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const app = express();
  app.use(express.json());

  app.use("/mcp", (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${config.http!.authToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const httpServer = new McpServer({
      name: "send-to-kindle",
      version: "1.0.0",
    });

    httpServer.tool(
      "send_to_kindle",
      TOOL_DESCRIPTION,
      {
        title: z.string().describe("Document title"),
        content: z.string().describe("Document content in Markdown format"),
        author: z.string().optional().describe("Author name"),
        device: z.string().optional().describe("Target device name"),
      },
      async (args) => toolHandler.handle(args),
    );

    await httpServer.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => { res.status(405).end(); });
  app.delete("/mcp", (_req, res) => { res.status(405).end(); });

  app.listen(config.http.port, () => {
    pinoLogger.info(
      { port: config.http!.port, url: `http://localhost:${config.http!.port}/mcp` },
      "Send to Kindle MCP server started (HTTP)",
    );
  });
}
```

**Step 2: Update `.env.example`**

Replace `.env.example`:

```
# Required — define Kindle devices as name:email tuples
# Single device:
KINDLE_DEVICES=personal:your-kindle@kindle.com

# Multiple devices:
# KINDLE_DEVICES=personal:me@kindle.com,partner:partner@kindle.com,family:family@kindle.com

# Optional — set the default device (must match a name in KINDLE_DEVICES)
# If omitted, the first device is the default
# KINDLE_DEFAULT_DEVICE=personal

# Required — your sending email account
SENDER_EMAIL=your-email@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password

# Optional
DEFAULT_AUTHOR=Claude
MCP_HTTP_PORT=3000
MCP_AUTH_TOKEN=your-secret-token
LOG_LEVEL=info
```

**Step 3: Build to confirm no TypeScript errors**

```bash
npm run build
```

Expected: clean build, no errors.

**Step 4: Run the full test suite**

```bash
npm test
```

Expected: all tests passing (existing 55 + new ~28 = ~83 total).

**Step 5: Commit**

```bash
git add src/index.ts .env.example
git commit -m "feat: wire multi-device composition root, update tool description and .env.example"
```

---

## Traceability

| ADR Requirement | Tasks |
|---|---|
| `EmailAddress` value object | Task 1 |
| `KindleDevice` value object | Task 2 |
| `DeviceRegistry` domain type (max 10, case-insensitive) | Task 3 |
| `DocumentMailer.send(doc, device)` | Task 4 |
| `DeliveryLogger` gains `deviceName` | Task 5 |
| `SendToKindleService.execute(..., device)` + `DeliverySuccess.deviceName` | Task 6 |
| `config.ts` parses `KINDLE_DEVICES`, removes `KINDLE_EMAIL` | Task 7 |
| `ToolHandler` resolves device, passes to service | Task 8 |
| Composition root wired, tool description updated, `.env.example` updated | Task 9 |
