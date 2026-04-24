import { ValidationError, type Result, ok, err } from "../errors.js";

/** Implements FR-1: EmailAddress value object with validation */
export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(
    raw: string,
    field: string = "email",
  ): Result<EmailAddress, ValidationError> {
    const trimmed = raw.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return err(
        new ValidationError(field, `Invalid email address: "${trimmed}".`),
      );
    }
    return ok(new EmailAddress(trimmed));
  }
}
