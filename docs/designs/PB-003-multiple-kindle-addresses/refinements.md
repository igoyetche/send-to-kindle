# PB-003: Multiple Kindle Addresses — Refinements

> Reviewed against: Separation of Concerns (SoC-001 through SoC-015) and Tactical DDD (principles 1 through 9)

---

## Separation of Concerns Refinements

### R-SoC-1: `DeviceRegistry` is not a value object -- it is configuration state parsed in infrastructure

**Rule:** SoC-001 (code placement decision tree), SoC-010 (co-locate by change)

**Problem:** The design places `DeviceRegistry` in `src/domain/values/`. A value object is defined by its attributes and is typically small, immutable, and equality-comparable. `DeviceRegistry` is a lookup container for configuration state: it holds a map, resolves names, and reports available device names. It does not represent a single domain concept the way `Title` or `KindleDevice` does. It is closer to parsed configuration than to a domain value.

Furthermore, `DeviceRegistry` changes for infrastructure reasons (new environment variable format, new config source) not for domain reasons. Placing it in `domain/values/` couples the domain to configuration parsing decisions.

**Refinement:** Move `DeviceRegistry` to `src/infrastructure/config/`. The `resolve()` logic is configuration resolution -- it answers "which device did the user configure?" not "what are the business rules of delivery?". The domain service does not need to know about registries; it receives a resolved `KindleDevice` directly.

This also means the `ToolHandler` receives a `DeviceRegistry` from infrastructure (via the composition root), which is already the case in the design. The dependency direction is preserved: application imports infrastructure config types, which is permitted.

**Impact:** `DeviceRegistry` moves from `domain/values/` to `infrastructure/config/`. Domain layer stays free of configuration lookup concerns.

---

### R-SoC-2: The `ToolHandler` performs device resolution, which is correct but the success response leaks device awareness into the service result

**Rule:** SoC-006 (entrypoints are thin translation layers), SoC-013 (separate intent from execution)

**Problem:** The design's `ToolHandler` constructs the success message as:

```typescript
message: `Document '${result.value.title}' sent to Kindle (${deviceResult.value.name}) successfully.`
```

This requires the handler to hold onto `deviceResult.value` across the entire service execution just to include the device name in the response. The handler is doing its job (translation), but the `DeliverySuccess` type returned by the service could carry the device name, avoiding the need for the handler to track parallel state.

**Refinement:** Expand `DeliverySuccess` to include `deviceName: string`. The service already receives the `KindleDevice` and can include its name in the result. This keeps the handler purely translational -- it maps the service result directly to the MCP response without needing to correlate two separate results.

```typescript
export interface DeliverySuccess {
  readonly title: string;
  readonly sizeBytes: number;
  readonly deviceName: string;
}
```

**Impact:** `DeliverySuccess` gains one field. `SendToKindleService.execute()` populates it. `ToolHandler` reads it from the result instead of holding a separate reference.

---

### R-SoC-3: Config parsing for devices mixes format parsing with domain validation

**Rule:** SoC-013 (separate intent from execution), SoC-014 (separate functions that depend on different state)

**Problem:** The `parseDevices()` function in `config.ts` does three things in one function body:
1. Parses the `KINDLE_DEVICES` string format (splitting on commas and colons)
2. Creates `KindleDevice` value objects (domain validation)
3. Creates the `DeviceRegistry` (validates uniqueness, resolves defaults)

These depend on different state: (1) depends on the environment variable format, (2) depends on device validation rules, (3) depends on the collection as a whole. Mixing them makes the function harder to read and harder to test individual concerns.

**Refinement:** Extract format parsing into a dedicated helper that returns raw name-email pairs, keeping `parseDevices()` focused on assembling validated domain objects from those pairs. This is a small structural improvement, not a new file -- just a clearer separation within `config.ts`.

```typescript
function parseDeviceEntries(raw: string): Array<{ name: string; email: string }> {
  // Parse format, throw on malformed entries
}

function buildDeviceRegistry(
  entries: Array<{ name: string; email: string }>,
  defaultName?: string,
): DeviceRegistry {
  // Create KindleDevice objects, assemble registry
}
```

**Impact:** Two focused functions instead of one mixed-concern function. Easier to test format parsing separately from registry construction.

---

## Tactical DDD Refinements

### R-DDD-1: `KindleDevice.email` should be an `EmailAddress` value object, not a raw string

**Rule:** Principle 8 (extract immutable value objects liberally), Principle 6 (make the implicit explicit)

**Problem:** The `KindleDevice` value object validates the email format internally using a regex, but stores the result as a plain `string`. Meanwhile, `config.ts` has its own `validateEmail()` function with the same regex. The concept of "a validated email address" is implicit -- it exists as scattered validation logic, not as a named type.

**Refinement:** Extract an `EmailAddress` value object that encapsulates email validation once. Both `KindleDevice` and the sender email in config can use it. This eliminates the duplicated regex and makes the domain concept explicit.

```typescript
export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<EmailAddress, ValidationError> {
    const trimmed = raw.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return err(new ValidationError("email", "Must be a valid email address."));
    }
    return ok(new EmailAddress(trimmed));
  }
}
```

`KindleDevice` then holds `readonly email: EmailAddress` instead of `readonly email: string`. The `SmtpMailer` reads `device.email.value` when composing the SMTP message.

**Impact:** New `EmailAddress` value object in `domain/values/`. `KindleDevice` uses it instead of raw string. `config.ts` `validateEmail()` can delegate to `EmailAddress.create()`. Eliminates duplicated validation regex.

---

### R-DDD-2: `DeviceRegistry` conflates two responsibilities -- validation and resolution are separate domain concepts

**Rule:** Principle 7 (design aggregates around invariants), Principle 6 (make the implicit explicit)

**Problem:** `DeviceRegistry.create()` validates the device collection (no duplicates, valid default) AND provides runtime resolution via `resolve()`. These are distinct concerns:
- Validation happens once at startup -- it enforces configuration invariants.
- Resolution happens per request -- it maps a user-provided name to a device.

Merging them into one class obscures the fact that resolution is a distinct operation that could be expressed more explicitly.

**Refinement:** This is a minor concern given the project's scale. The `DeviceRegistry` class is small and cohesive enough that splitting it would add complexity without proportional benefit. However, the design should acknowledge that `create()` is a construction-time validation boundary and `resolve()` is a runtime query. The current design already does this implicitly through the `Result` return types. No structural change is needed, but the refined design should document this distinction clearly.

**Impact:** Documentation only. No structural change.

---

### R-DDD-3: The domain service passes `KindleDevice` through without using it -- consider whether device belongs in the service signature

**Rule:** Principle 4 (avoid anemic domain model), Principle 3 (orchestrate with use cases)

**Problem:** In the proposed design, `SendToKindleService.execute()` receives a `KindleDevice` parameter and passes it directly to `this.mailer.send(document, device)`. The service does not inspect, validate, or make decisions based on the device. It is a pass-through parameter.

This is not inherently wrong -- the service orchestrates, and the device is part of the delivery pipeline. However, it raises a design question: should device resolution happen before the service (in the handler) or should the service own the concept of "deliver to a device"?

**Refinement:** The current design's choice is correct. Device resolution is a configuration concern (which device did the user mean?), not a domain concern (how do we deliver?). The handler resolves the device, the service orchestrates delivery. The service accepts a resolved `KindleDevice` because the mailer port needs it. This is the thinnest possible threading of the parameter.

The only improvement is to make the `DeliverySuccess` result include `deviceName` (see R-SoC-2 above), so the service acknowledges which device was targeted in its result, giving the device parameter a second use beyond pass-through.

**Impact:** Already addressed in R-SoC-2.

---

### R-DDD-4: Reuse of `ValidationError` for unknown device names is correct but field naming should be precise

**Rule:** Principle 6 (make the implicit explicit)

**Problem:** The design reuses `ValidationError` with `field: "device"` for unknown device names. This is pragmatic and avoids expanding the `DomainError` union unnecessarily. However, the error message construction in `DeviceRegistry.resolve()` embeds presentation concerns (formatting the available devices list).

**Refinement:** This is acceptable at the current scale. The `ValidationError` already includes a `message` field for human-readable context, and listing available device names is useful for the MCP tool response. No change needed. The refined design should keep this as-is.

**Impact:** None. Confirmed as acceptable.

---

## Summary of Actionable Refinements

| ID | Change | Scope |
|----|--------|-------|
| R-SoC-1 | Move `DeviceRegistry` from `domain/values/` to `infrastructure/config/` | File location |
| R-SoC-2 | Add `deviceName` to `DeliverySuccess` | Domain type, service, handler |
| R-SoC-3 | Split `parseDevices()` into format parsing and registry construction | Infrastructure config |
| R-DDD-1 | Extract `EmailAddress` value object, use in `KindleDevice` and config | New domain value object |
| R-DDD-2 | No structural change; document the validation vs. resolution distinction | Documentation |
| R-DDD-3 | No structural change; addressed by R-SoC-2 | N/A |
| R-DDD-4 | No change needed; confirmed acceptable | N/A |
