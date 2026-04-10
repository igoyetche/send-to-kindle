import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import type { FrontmatterParser } from "../../domain/ports.js";
import type { Result } from "../../domain/errors.js";
import { FrontmatterError, err, ok } from "../../domain/errors.js";
import { DocumentMetadata } from "../../domain/values/document-metadata.js";

/**
 * Parses YAML frontmatter from Markdown content using gray-matter.
 *
 * Handles:
 * - Files without frontmatter (returns empty metadata, raw content as body)
 * - Well-formed YAML frontmatter (parses and strips, returns body after `---` closing fence)
 * - Malformed YAML (returns FrontmatterError)
 *
 * Uses the yaml library configured to NOT automatically parse dates, so that
 * date strings like "2026-04-10" remain as strings rather than being converted
 * to Date objects.
 */
export class GrayMatterFrontmatterParser implements FrontmatterParser {
  parse(
    raw: string,
  ): Result<{ metadata: DocumentMetadata; body: string }, FrontmatterError> {
    try {
      const parsed = matter(raw, {
        engines: {
          yaml: {
            parse: (content: string) =>
              parseYaml(content, { schema: "core" }) as Record<string, unknown>,
          },
        },
      });
      const metadata = DocumentMetadata.fromRecord(parsed.data);
      return ok({
        metadata,
        body: parsed.content,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to parse frontmatter";
      return err(new FrontmatterError(message));
    }
  }
}
