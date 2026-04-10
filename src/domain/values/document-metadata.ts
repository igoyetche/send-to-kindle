/**
 * Document metadata extracted from YAML frontmatter.
 *
 * All fields are optional because frontmatter may be absent or partial.
 * Metadata is parsed from YAML and passed through the conversion pipeline
 * as document context.
 */
export class DocumentMetadata {
  private constructor(
    readonly title: string | undefined,
    readonly url: string | undefined,
    readonly date: string | undefined,
  ) {}

  /**
   * Creates an empty metadata object (no frontmatter found).
   */
  static empty(): DocumentMetadata {
    return new DocumentMetadata(undefined, undefined, undefined);
  }

  /**
   * Builds a DocumentMetadata from a parsed frontmatter object.
   *
   * Permissive parsing:
   * - Unknown fields are ignored
   * - Non-string values are dropped
   * - Empty/whitespace strings are normalized to undefined
   */
  static fromRecord(raw: Record<string, unknown>): DocumentMetadata {
    return new DocumentMetadata(
      normalizeString(raw["title"]),
      normalizeString(raw["url"]),
      normalizeString(raw["date"]),
    );
  }

  /**
   * Returns true if all fields are undefined.
   */
  get isEmpty(): boolean {
    return (
      this.title === undefined &&
      this.url === undefined &&
      this.date === undefined
    );
  }
}

/**
 * Normalizes a value to a string or undefined.
 * Non-string values are dropped; empty/whitespace strings become undefined.
 */
function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
