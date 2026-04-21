/**
 * CoverGenerator — Implements FR-1, FR-37 (PB-008)
 *
 * Generates an HTML first-page chapter and a JPEG cover image for EPUB documents.
 * Presentation strings (HTML, CSS, SVG) live in cover-templates.ts; this module
 * handles icon loading, text layout, and JPEG rasterisation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { buildHtmlChapter, buildCoverSvg } from "./cover-templates.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Word-wraps a title string into lines of at most `maxLineChars` characters,
 * breaking only at word boundaries. At most `maxLines` lines are produced.
 * If the title requires more lines, the last line is truncated with an ellipsis (…).
 *
 * A single word longer than `maxLineChars` is returned as-is on its own line.
 *
 * Implements FR-36 (PB-008): title wrapping for the cover image.
 */
export function wrapTitle(
  title: string,
  maxLineChars = 30,
  maxLines = 3,
): string[] {
  const words = title.split(" ");
  const lines: string[] = [];
  let current = "";
  // Set to true when we break early because a word doesn't fit on the last line.
  // This indicates content was truncated and "…" should be appended.
  let wasOverflowed = false;

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxLineChars) {
      current += " " + word;
    } else {
      if (lines.length >= maxLines - 1) {
        // A word doesn't fit and we're already on the last allowed line —
        // truncate current and mark overflow.
        const withEllipsis = current + "…";
        current =
          withEllipsis.length <= maxLineChars
            ? withEllipsis
            : current.slice(0, maxLineChars - 1) + "…";
        wasOverflowed = true;
        break;
      }
      // Word doesn't fit on current line, but we have room for another line.
      lines.push(current);
      current = word;
    }
  }

  // If we didn't break early due to overflow and have remaining content,
  // push it (whether or not we're on the last line).
  if (current.length > 0 && lines.length < maxLines && !wasOverflowed) {
    lines.push(current);
  } else if (current.length > 0 && wasOverflowed) {
    // Overflow case: current already has "…", just push it.
    lines.push(current);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// CoverGenerator
// ---------------------------------------------------------------------------

/**
 * Generates cover assets for EPUB documents:
 *  - `generateHtmlChapter`: styled XHTML first chapter (title page) for Kindle rendering
 *  - `generateImage`: 600×900 JPEG cover image for the Kindle library thumbnail
 *
 * Implements FR-1, FR-37 (PB-008).
 */
export class CoverGenerator {
  private readonly iconBase64: string;

  constructor() {
    const dir = dirname(fileURLToPath(import.meta.url));
    const iconPath = join(dir, "assets", "cover-icon.png");
    this.iconBase64 = readFileSync(iconPath).toString("base64");
  }

  /**
   * Generates a styled XHTML cover chapter with title, author, and optional source domain.
   * CSS is inlined because Kindle does not reliably load external stylesheets.
   *
   * Implements FR-36 (PB-008).
   */
  generateHtmlChapter(
    title: string,
    author: string,
    sourceUrl?: string,
  ): string {
    const domain =
      sourceUrl !== undefined ? extractDomain(sourceUrl) : undefined;
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    return buildHtmlChapter(title, author, domain, iconDataUri);
  }

  /**
   * Generates a 600×900 JPEG cover image for the Kindle library thumbnail.
   * SVG is rasterised to JPEG via sharp.
   *
   * Implements FR-37 (PB-008).
   */
  async generateImage(title: string, author: string): Promise<Buffer> {
    const titleLines = wrapTitle(title, 16, 4);
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    const svg = buildCoverSvg(titleLines, author, iconDataUri);
    return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }
}
