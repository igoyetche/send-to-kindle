import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { DocumentMailer } from "../../domain/ports.js";
import type { EpubDocument } from "../../domain/values/index.js";
import type { KindleDevice } from "../../domain/values/index.js";
import { DeliveryError, type Result, ok, err } from "../../domain/errors.js";

export interface EpubFilenameOptions {
  title: string;
  author?: string;
  date?: string;
}

export interface SmtpMailerConfig {
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  /** Override the default filename generator. Receives document metadata, must return a filename ending in ".epub". */
  generateFilename?: (opts: EpubFilenameOptions) => string;
}

/** Removes characters that are invalid in filenames on Windows and Unix. */
function sanitizeComponent(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 80);
}

/**
 * Generates an EPUB attachment filename from document metadata.
 *
 * Format:
 *   - With author:    "Title - Author - Date.epub"
 *   - Without author: "Title - Date.epub"
 *   - Date absent:    "Title - Author.epub" / "Title.epub"
 *
 * Each segment is sanitized to remove characters invalid in filenames.
 * Falls back to "document.epub" when the title sanitizes to empty.
 */
export function generateEpubFilename(opts: EpubFilenameOptions): string {
  const title = sanitizeComponent(opts.title) || "document";
  const parts: string[] = [title];

  if (opts.author) {
    const clean = sanitizeComponent(opts.author);
    if (clean) parts.push(clean);
  }

  if (opts.date) {
    const clean = sanitizeComponent(opts.date);
    if (clean) parts.push(clean);
  }

  return parts.join(" - ") + ".epub";
}

function categorizeError(
  error: unknown,
): { cause: "auth" | "connection" | "rejection"; message: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const responseCode = (error as { responseCode?: number }).responseCode;

    if (code === "EAUTH") {
      return {
        cause: "auth",
        message:
          "SMTP authentication failed. Check SMTP_USER and SMTP_PASS configuration.",
      };
    }
    if (
      code === "ECONNECTION" ||
      code === "ESOCKET" ||
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED"
    ) {
      return {
        cause: "connection",
        message: `SMTP connection failed: ${error.message}`,
      };
    }
    if (responseCode !== undefined && responseCode >= 500) {
      return {
        cause: "rejection",
        message: `Email rejected by server: ${error.message}`,
      };
    }
    return { cause: "connection", message: error.message };
  }
  return { cause: "connection", message: "Unknown SMTP error" };
}

export class SmtpMailer implements DocumentMailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpMailerConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(
    document: EpubDocument,
    device: KindleDevice,
  ): Promise<Result<void, DeliveryError>> {
    const filenameGen = this.config.generateFilename ?? generateEpubFilename;
    const filename = filenameGen({
      title: document.title,
      author: document.author,
      date: document.date,
    });

    try {
      await this.transporter.sendMail({
        from: this.config.sender.email,
        to: device.email.value,
        subject: document.title,
        text: "Sent via Paperboy.",
        attachments: [
          {
            filename,
            content: document.buffer,
            contentType: "application/epub+zip",
          },
        ],
      });
      return ok(undefined);
    } catch (error) {
      const { cause, message } = categorizeError(error);
      return err(new DeliveryError(cause, message));
    }
  }
}
