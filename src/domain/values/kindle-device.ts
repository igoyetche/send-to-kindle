import { ValidationError, type Result, ok, err } from "../errors.js";
import type { EmailAddress } from "./email-address.js";

/** Implements FR-2: KindleDevice value object wrapping a validated name and EmailAddress */
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
