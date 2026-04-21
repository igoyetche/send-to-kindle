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
import { buildHtmlChapter, buildCoverCss, buildCoverSvg } from "./cover-templates.js";

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

  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;

    if (candidate.length <= maxLineChars) {
      current = candidate;
      continue;
    }

    if (lines.length >= maxLines - 1) {
      const withEllipsis = `${current}…`;
      lines.push(
        withEllipsis.length <= maxLineChars
          ? withEllipsis
          : `${current.slice(0, maxLineChars - 1)}…`,
      );
      return lines;
    }

    lines.push(current);
    current = word;
  }

  if (current.length > 0) {
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
  private coverCssCache?: string;

  constructor() {
    const dir = dirname(fileURLToPath(import.meta.url));
    const iconPath = join(dir, "assets", "cover-icon.png");
    this.iconBase64 = readFileSync(iconPath).toString("base64");
  }

  /**
   * Returns the CSS string for the EPUB stylesheet.
   * Pass this to epub-gen-memory's `css` option so styles land in <head>, not <body>.
   *
   * The icon is resized to ≤480 px before base64-encoding so the CSS file
   * stays small (source PNG is 1.44 MB; resized output is ~20–50 KB).
   * Result is cached — resize only runs once per CoverGenerator instance.
   *
   * Implements FR-36 (PB-008).
   */
  async generateCoverCss(): Promise<string> {
    if (this.coverCssCache !== undefined) return this.coverCssCache;
    const resized = await sharp(Buffer.from(this.iconBase64, "base64"))
      .resize(480, 480, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const iconDataUri = `data:image/png;base64,${resized.toString("base64")}`;
    this.coverCssCache = buildCoverCss(iconDataUri);
    return this.coverCssCache;
  }

  /**
   * Generates a styled XHTML cover chapter (title page) with title, author,
   * and optional source domain. No inline styles — CSS comes from generateCoverCss().
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
    return buildHtmlChapter(title, author, domain);
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
