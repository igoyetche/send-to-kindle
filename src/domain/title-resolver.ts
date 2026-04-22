import { Title } from "./values/title.js";
import { type Result, ValidationError, err } from "./errors.js";

/**
 * Resolves a Title by trying candidates in order until one produces a valid Title.
 *
 * First non-empty candidate wins. Empty/whitespace candidates are skipped.
 * Returns a ValidationError if no candidate yields a valid title.
 *
 * @param candidates - Array of candidate title strings or undefined. Tried in order.
 * @returns Result containing a valid Title or a ValidationError
 */
export function resolveTitle(
  candidates: ReadonlyArray<string | undefined>,
): Result<Title, ValidationError> {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const result = Title.create(trimmed);
    if (result.ok) return result;
  }
  return err(
    new ValidationError(
      "title",
      "No title could be resolved from the provided sources.",
    ),
  );
}
