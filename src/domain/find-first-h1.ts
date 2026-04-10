/**
 * Extracts the text of the first ATX-style H1 heading from Markdown content.
 *
 * Matches the pattern: `# Title` at the start of a line.
 * Trailing whitespace is trimmed from the result.
 * Returns undefined if no H1 is found.
 *
 * @param body - Markdown content to search
 * @returns The H1 text (without the `#`, trailing whitespace trimmed) or undefined
 */
export function findFirstH1(body: string): string | undefined {
  const h1Match = /^#\s+(.+)$/m.exec(body);
  return h1Match?.[1]?.trimEnd();
}
