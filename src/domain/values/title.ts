import { ValidationError, type Result, ok, err } from "../errors.js";

export class Title {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<Title, ValidationError> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return err(
        new ValidationError(
          "title",
          "The 'title' parameter is required and must be non-empty.",
        ),
      );
    }
    return ok(new Title(trimmed));
  }
}
