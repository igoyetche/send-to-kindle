/**
 * Cover presentation templates for EPUB documents.
 *
 * Owns all HTML, CSS, and SVG strings for the two cover assets:
 *  - buildHtmlChapter  — styled body fragment for the Kindle first-page chapter
 *  - buildCoverSvg     — 600×900 SVG for the Kindle library thumbnail
 *
 * All layout constants (sizes, colours, positions) live here so changes to
 * the cover design never touch cover-generator.ts.
 */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Returns a styled body fragment for the EPUB cover chapter.
 *
 * epub-gen-memory strips <head>/<style> and embeds only the body fragment.
 * A <style> block at the top of the content survives fixHTML intact and is
 * applied by Kindle's parser even when inside <body>.
 *
 * @param domain  Optional source hostname (already extracted, will be escaped here).
 */
export function buildHtmlChapter(
  title: string,
  author: string,
  domain: string | undefined,
  iconDataUri: string,
): string {
  const sourceHtml =
    domain !== undefined
      ? `<p class="source">${escapeXml(domain)}</p>`
      : "";

  const style = `<style type="text/css">
body { background: #f5efe4; margin: 0; padding: 0; font-family: Georgia, serif; }
.cover { background: #f5efe4; text-align: center; padding: 60px 20px; }
.kicker { color: #a03020; font-size: 0.75em; font-weight: bold; letter-spacing: 0.4em; text-transform: uppercase; margin-bottom: 24px; }
.title { color: #1a1a1a; font-size: 2.2em; font-weight: bold; line-height: 1.25; margin-bottom: 20px; }
.rule { width: 100px; height: 2px; background: #a03020; margin: 0 auto 20px; }
.author { color: #4a4a4a; font-size: 1.4em; font-style: italic; }
.icon { width: 240px; height: 240px; margin: 48px auto 0; background-image: url('${iconDataUri}'); background-size: contain; background-repeat: no-repeat; background-position: center; }
.source { color: #8a7a5a; font-size: 1em; margin-top: 24px; letter-spacing: 0.2em; text-transform: uppercase; }
</style>`;

  const markup = `<div class="cover">
  <p class="kicker">Paperboy</p>
  <h1 class="title">${escapeXml(title)}</h1>
  <div class="rule"></div>
  <p class="author">by ${escapeXml(author)}</p>
  <div class="icon" role="img" aria-label="Paperboy"></div>
  ${sourceHtml}
</div>`;

  return `${style}\n${markup}`;
}

/**
 * Returns a 600×900 SVG string for the Kindle library thumbnail.
 * Layout constants (font sizes, positions) are defined here.
 */
export function buildCoverSvg(
  titleLines: string[],
  author: string,
  iconDataUri: string,
): string {
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="900" viewBox="0 0 600 900">
  <rect width="600" height="900" fill="#f5efe4"/>
  <text x="300" y="90" font-family="Georgia, serif" font-size="18" font-weight="700" fill="#a03020" text-anchor="middle" letter-spacing="6">PAPERBOY</text>
  ${titleElements}
  <line x1="230" y1="${ruleY}" x2="370" y2="${ruleY}" stroke="#a03020" stroke-width="2"/>
  <text x="300" y="${authorY}" font-family="Georgia, serif" font-size="28" font-style="italic" fill="#4a4a4a" text-anchor="middle">${escapeXml(`by ${author}`)}</text>
  <image x="110" y="525" width="380" height="320" xlink:href="${iconDataUri}"/>
</svg>`;
}
