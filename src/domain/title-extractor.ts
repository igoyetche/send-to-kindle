import { Title } from "./values/title.js";
import type { Result } from "./errors.js";
import type { ValidationError } from "./errors.js";

/**
 * Extracts a Title from Markdown content or falls back to the filename.
 *
 * Implements FR-009: automatic title resolution for watch-folder delivery.
 *
 * Strategy:
 * 1. Look for the first ATX-style H1 heading (`# Title`) anywhere in the content.
 * 2. If none found, strip the `.md` extension (case-insensitive) from the filename.
 * 3. Pass the candidate string through Title.create for validation/trimming.
 */
export function extractTitle(
  content: string,
  filename: string,
): Result<Title, ValidationError> {
  const h1Match = /^#\s+(.+)$/m.exec(content);
  if (h1Match?.[1] !== undefined) {
    return Title.create(h1Match[1]);
  }
  const fallback = filename.replace(/\.md$/i, "");
  return Title.create(fallback);
}
