# PB-003: Multiple Kindle Addresses

> Status: Done
> Created: 2026-03-05
> Completed: 2026-03-05

## Problem

The system currently supports a single `KINDLE_EMAIL` address. Users with multiple Kindle devices (personal, partner, family) must reconfigure the server to switch targets.

## Proposed Solution

Support a list of named Kindle devices in configuration via `name:email` tuples, add an optional `device` parameter to the `send_to_kindle` tool to select the target, and allow configuring an explicit default device.

### Configuration

```
# Required: comma-separated name:email pairs (replaces KINDLE_EMAIL — breaking change)
KINDLE_DEVICES=personal:me@kindle.com,partner:partner@kindle.com,family:family@kindle.com

# Explicit default device (optional — if omitted, first entry is the default)
KINDLE_DEFAULT_DEVICE=personal
```

> **Breaking change:** `KINDLE_EMAIL` is no longer supported. Existing deployments must migrate to `KINDLE_DEVICES=default:your-kindle-address@kindle.com`.

Each entry in `KINDLE_DEVICES` is a `name:email` tuple. Names must be unique. The name is the alias used in the tool parameter and in error messages; the email is never exposed outside the mailer.

### KindleDevice Value Object

Introduce a `KindleDevice` value object in the domain layer:

```typescript
export class KindleDevice {
  private constructor(
    readonly name: string,
    readonly email: string,
  ) {}

  static create(name: string, email: string): Result<KindleDevice, ValidationError> {
    if (!name.trim()) return err(new ValidationError("device.name", "Device name must be non-empty."));
    if (!email.includes("@")) return err(new ValidationError("device.email", "Device email must be a valid address."));
    return ok(new KindleDevice(name.trim(), email.trim()));
  }
}
```

`DocumentMailer.send()` receives the resolved `KindleDevice` instead of a raw email string, keeping SMTP details in the infrastructure layer.

### Tool Parameter

Add an optional `device` parameter to `send_to_kindle`:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `device` | string | no | Device name. Defaults to `KINDLE_DEFAULT_DEVICE`, or the first configured device if not set. |

### Examples

```
send_to_kindle(title: "Article", content: "...", device: "partner")
send_to_kindle(title: "Article", content: "...")  // sends to default device
```

### Validation

- Unknown device name → error listing available device **names only** (never emails)
- Empty `KINDLE_DEVICES` entries → fail at startup
- Duplicate device names → fail at startup
- `KINDLE_DEFAULT_DEVICE` references an unknown name → fail at startup

## Changes Required

- **Config**: parse `KINDLE_DEVICES` as `name:email` tuples; parse optional `KINDLE_DEFAULT_DEVICE`; `KINDLE_EMAIL` removed (breaking change)
- **Domain**: introduce `KindleDevice` value object; update `DocumentMailer.send()` to accept `KindleDevice`
- **Infrastructure**: `SmtpMailer` reads `device.email` internally; alias never logged
- **ToolHandler**: resolve `device` parameter to a `KindleDevice`; default to configured default device
- **Validation**: reject unknown device names at call time with error listing names only; reject bad config at startup

## Scope

Small — config parsing, one new value object, one new optional parameter, updated mailer signature. No architectural changes.
