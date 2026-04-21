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

    // epub-gen-memory strips <head>/<style> and embeds only the body fragment.
    // A <style> block placed at the top of the content survives fixHTML intact
    // and is applied by Kindle's parser even when inside <body>.
    return `<style type="text/css">
body { background: #f5efe4; margin: 0; padding: 0; font-family: Georgia, serif; }
.cover { background: #f5efe4; text-align: center; padding: 60px 20px; }
.kicker { color: #a03020; font-size: 0.75em; font-weight: bold; letter-spacing: 0.4em; text-transform: uppercase; margin-bottom: 24px; }
.title { color: #1a1a1a; font-size: 2.2em; font-weight: bold; line-height: 1.25; margin-bottom: 20px; }
.rule { width: 100px; height: 2px; background: #a03020; margin: 0 auto 20px; }
.author { color: #4a4a4a; font-size: 1.4em; font-style: italic; }
.icon { width: 240px; height: 240px; margin: 48px auto 0; background-image: url('${iconDataUri}'); background-size: contain; background-repeat: no-repeat; background-position: center; }
.source { color: #8a7a5a; font-size: 1em; margin-top: 24px; letter-spacing: 0.2em; text-transform: uppercase; }
</style>
<div class="cover">
  <p class="kicker">Paperboy</p>
  <h1 class="title">${escapeXml(title)}</h1>
  <div class="rule"></div>
  <p class="author">by ${escapeXml(author)}</p>
  <div class="icon" role="img" aria-label="Paperboy"></div>
  ${sourceHtml}
</div>`;
  }

  /**
   * Generates a 600×900 JPEG cover image for the Kindle library thumbnail.
   * SVG is rasterised to JPEG via sharp.
   *
   * Implements FR-37 (PB-008).
   */
  async generateImage(title: string, author: string): Promise<Buffer> {
    const iconDataUri = `data:image/png;base64,${this.iconBase64}`;
    const titleLines = wrapTitle(title, 16, 4);
    const titleStartY = 155;
    const lineSpacing = 76;

    const titleElements = titleLines
      .map(
        (line, i) =>
          `<text x="300" y="${titleStartY + i * lineSpacing}" font-family="Georgia, serif" font-size="68" font-weight="700" fill="#1a1a1a" text-anchor="middle">${escapeXml(line)}</text>`,
      )
      .join("\n  ");

    const ruleY = titleStartY + titleLines.length * lineSpacing + 20;
    const authorY = ruleY + 50;

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="900" viewBox="0 0 600 900">
  <rect width="600" height="900" fill="#f5efe4"/>
  <text x="300" y="90" font-family="Georgia, serif" font-size="18" font-weight="700" fill="#a03020" text-anchor="middle" letter-spacing="6">PAPERBOY</text>
  ${titleElements}
  <line x1="230" y1="${ruleY}" x2="370" y2="${ruleY}" stroke="#a03020" stroke-width="2"/>
  <text x="300" y="${authorY}" font-family="Georgia, serif" font-size="28" font-style="italic" fill="#4a4a4a" text-anchor="middle">${escapeXml(`by ${author}`)}</text>
  <image x="110" y="525" width="380" height="320" xlink:href="${iconDataUri}"/>
</svg>`;

    return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }
}
