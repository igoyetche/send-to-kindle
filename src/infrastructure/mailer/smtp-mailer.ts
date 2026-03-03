import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { DocumentMailer } from "../../domain/ports.js";
import type { EpubDocument } from "../../domain/values/index.js";
import { DeliveryError, type Result, ok, err } from "../../domain/errors.js";

export interface SmtpMailerConfig {
  kindle: { email: string };
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 100);
  return `${slug || "document"}.epub`;
}

function categorizeError(
  error: unknown,
): { cause: "auth" | "connection" | "rejection"; message: string } {
  if (error instanceof Error) {
    const code = (error as any).code;
    const responseCode = (error as any).responseCode;

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
    if (responseCode && responseCode >= 500) {
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

  async send(document: EpubDocument): Promise<Result<void, DeliveryError>> {
    const filename = slugify(document.title);

    try {
      await this.transporter.sendMail({
        from: this.config.sender.email,
        to: this.config.kindle.email,
        subject: document.title,
        text: "Sent via Send to Kindle MCP Server.",
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
