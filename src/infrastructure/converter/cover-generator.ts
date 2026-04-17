/**
 * CoverGenerator — Implements FR-1, FR-37 (PB-008)
 *
 * Generates an HTML first-page chapter and a JPEG cover image for EPUB documents.
 * The HTML chapter is styled for Kindle rendering; the JPEG cover is used as the
 * Kindle library thumbnail.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escapes XML/HTML special characters so text can be safely embedded in HTML.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Extracts the hostname from a URL string.
 * Returns undefined when the URL is invalid or unparseable.
 */
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
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    const domain =
      sourceUrl !== undefined ? extractDomain(sourceUrl) : undefined;
    const sourceHtml =
      domain !== undefined
        ? `<p class="source">${escapeXml(domain)}</p>`
        : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(title)}</title>
<style type="text/css">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1e2e; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
  .cover { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 60px 40px; max-width: 500px; }
  .icon { width: 120px; height: 120px; margin-bottom: 36px; background-image: url('${iconDataUri}'); background-size: contain; background-repeat: no-repeat; background-position: center; }
  .title { color: #cdd6f4; font-size: 1.8em; font-weight: bold; line-height: 1.3; margin-bottom: 16px; }
  .author { color: #a6adc8; font-size: 1em; }
  .source { color: #6c7086; font-size: 0.8em; margin-top: 40px; }
</style>
</head>
<body>
<div class="cover">
  <div class="icon" role="img" aria-label="Paperboy"></div>
  <h1 class="title">${escapeXml(title)}</h1>
  <p class="author">${escapeXml(author)}</p>
  ${sourceHtml}
</div>
</body>
</html>`;
  }

  /**
   * Generates a 600×900 JPEG cover image for the Kindle library thumbnail.
   * SVG is rasterised to JPEG via sharp.
   *
   * Implements FR-37 (PB-008).
   */
  async generateImage(title: string, author: string): Promise<Buffer> {
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    const titleLines = wrapTitle(title);
    const titleStartY = 290;
    const lineSpacing = 46;

    const titleElements = titleLines
      .map(
        (line, i) =>
          `<text x="300" y="${titleStartY + i * lineSpacing}" font-family="sans-serif" font-size="32" font-weight="bold" fill="#cdd6f4" text-anchor="middle">${escapeXml(line)}</text>`,
      )
      .join("\n  ");

    const authorY = titleStartY + titleLines.length * lineSpacing + 28;

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="900" viewBox="0 0 600 900">
  <rect width="600" height="900" fill="#1e1e2e"/>
  <rect x="0" y="0" width="600" height="4" fill="#89b4fa"/>
  <image x="220" y="80" width="160" height="160" xlink:href="${iconDataUri}"/>
  ${titleElements}
  <text x="300" y="${authorY}" font-family="sans-serif" font-size="22" fill="#a6adc8" text-anchor="middle">${escapeXml(author)}</text>
</svg>`;

    return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }
}
