import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmtpMailer, type SmtpMailerConfig } from "../../../src/infrastructure/mailer/smtp-mailer.js";
import { EpubDocument } from "../../../src/domain/values/epub-document.js";
import nodemailer from "nodemailer";

vi.mock("nodemailer");

const config: SmtpMailerConfig = {
  kindle: { email: "user@kindle.com" },
  sender: { email: "sender@example.com" },
  smtp: { host: "smtp.example.com", port: 587, user: "user", pass: "pass" },
};

function makeDocument(): EpubDocument {
  return new EpubDocument("Test Book", Buffer.from("fake-epub"));
}

describe("SmtpMailer", () => {
  let mockSendMail: ReturnType<typeof vi.fn>;
  let mockTransporter: { sendMail: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail = vi.fn().mockResolvedValue({ messageId: "abc123" });
    mockTransporter = { sendMail: mockSendMail };
    vi.mocked(nodemailer.createTransport).mockReturnValue(
      mockTransporter as any,
    );
  });

  it("sends email with correct fields on success", async () => {
    const mailer = new SmtpMailer(config);
    const doc = makeDocument();

    const result = await mailer.send(doc);

    expect(result.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        to: "user@kindle.com",
        subject: "Test Book",
        attachments: [
          expect.objectContaining({
            content: doc.buffer,
            contentType: "application/epub+zip",
          }),
        ],
      }),
    );
  });

  it("returns auth DeliveryError on authentication failure", async () => {
    const authError = new Error("Invalid login");
    (authError as any).code = "EAUTH";
    mockSendMail.mockRejectedValue(authError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("auth");
    }
  });

  it("returns connection DeliveryError on connection failure", async () => {
    const connError = new Error("Connection refused");
    (connError as any).code = "ECONNECTION";
    mockSendMail.mockRejectedValue(connError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("connection");
    }
  });

  it("returns rejection DeliveryError on envelope rejection", async () => {
    const rejectError = new Error("550 Recipient rejected");
    (rejectError as any).responseCode = 550;
    mockSendMail.mockRejectedValue(rejectError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("rejection");
    }
  });
});
