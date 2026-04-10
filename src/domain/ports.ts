import type { Title, Author, MarkdownDocument, EpubDocument, KindleDevice, DocumentMetadata } from "./values/index.js";
import type { DeliveryError, ConversionError, FrontmatterError, Result } from "./errors.js";

export interface ContentConverter {
  toEpub(
    title: Title,
    document: MarkdownDocument,
    author: Author,
  ): Promise<Result<EpubDocument, ConversionError>>;
}

export interface DocumentMailer {
  send(
    document: EpubDocument,
    device: KindleDevice,
  ): Promise<Result<void, DeliveryError>>;
}

export interface DeliveryLogger {
  deliveryAttempt(title: string, format: string, deviceName: string): void;
  deliverySuccess(title: string, format: string, sizeBytes: number, deviceName: string): void;
  deliveryFailure(title: string, errorKind: string, message: string, deviceName: string): void;
}

export interface FrontmatterParser {
  /**
   * Splits a raw markdown string into its frontmatter block and body content.
   *
   * - No frontmatter → ok({ metadata: empty, body: raw })
   * - Well-formed frontmatter → ok({ metadata: parsed, body: content after closing '---' })
   * - Malformed frontmatter → err(FrontmatterError)
   */
  parse(
    raw: string,
  ): Result<{ metadata: DocumentMetadata; body: string }, FrontmatterError>;
}
