import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmtpMailer, generateEpubFilename, type SmtpMailerConfig } from "../../../src/infrastructure/mailer/smtp-mailer.js";
import { EpubDocument } from "../../../src/domain/values/epub-document.js";
import { KindleDevice } from "../../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../../src/domain/values/email-address.js";
import nodemailer from "nodemailer";

vi.mock("nodemailer");

const config: SmtpMailerConfig = {
  sender: { email: "sender@example.com" },
  smtp: { host: "smtp.example.com", port: 587, user: "user", pass: "pass" },
};

function makeDocument(): EpubDocument {
  return new EpubDocument("Test Book", Buffer.from("fake-epub"));
}

function makeDevice(email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create("personal", emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup");
  return deviceResult.value;
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
    const device = makeDevice("user@kindle.com");

    const result = await mailer.send(doc, device);

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

  it("uses device.email.value as the to field", async () => {
    const mailer = new SmtpMailer(config);
    const device = makeDevice("partner@kindle.com");

    await mailer.send(makeDocument(), device);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "partner@kindle.com" }),
    );
  });

  it("returns auth DeliveryError on authentication failure", async () => {
    const authError = new Error("Invalid login");
    (authError as any).code = "EAUTH";
    mockSendMail.mockRejectedValue(authError);

    const mailer = new SmtpMailer(config);
    const result = await mailer.send(makeDocument(), makeDevice());

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
    const result = await mailer.send(makeDocument(), makeDevice());

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
    const result = await mailer.send(makeDocument(), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBe("rejection");
    }
  });

  it("uses document author and date in attachment filename", async () => {
    const mailer = new SmtpMailer(config);
    const doc = new EpubDocument("My Article", Buffer.from("epub"), undefined, "Claude", "2024-01-15");

    await mailer.send(doc, makeDevice());

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ filename: "My Article - Claude - 2024-01-15.epub" }),
        ],
      }),
    );
  });

  it("omits author segment when document has no author", async () => {
    const mailer = new SmtpMailer(config);
    const doc = new EpubDocument("My Article", Buffer.from("epub"), undefined, undefined, "2024-01-15");

    await mailer.send(doc, makeDevice());

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ filename: "My Article - 2024-01-15.epub" }),
        ],
      }),
    );
  });

  it("uses custom generateFilename when provided in config", async () => {
    const customConfig: SmtpMailerConfig = {
      ...config,
      generateFilename: ({ title }) => `custom-${title}.epub`,
    };
    const mailer = new SmtpMailer(customConfig);
    const doc = new EpubDocument("My Article", Buffer.from("epub"), undefined, "Claude", "2024-01-15");

    await mailer.send(doc, makeDevice());

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ filename: "custom-My Article.epub" }),
        ],
      }),
    );
  });
});

describe("generateEpubFilename", () => {
  it("formats title, author, and date when all are present", () => {
    expect(generateEpubFilename({ title: "My Article", author: "Claude", date: "2024-01-15" }))
      .toBe("My Article - Claude - 2024-01-15.epub");
  });

  it("omits author segment when author is absent", () => {
    expect(generateEpubFilename({ title: "My Article", date: "2024-01-15" }))
      .toBe("My Article - 2024-01-15.epub");
  });

  it("omits date segment when date is absent", () => {
    expect(generateEpubFilename({ title: "My Article", author: "Claude" }))
      .toBe("My Article - Claude.epub");
  });

  it("returns only title when neither author nor date are present", () => {
    expect(generateEpubFilename({ title: "My Article" }))
      .toBe("My Article.epub");
  });

  it("falls back to 'document.epub' when title sanitizes to empty", () => {
    expect(generateEpubFilename({ title: ":::/\\||" }))
      .toBe("document.epub");
  });

  it("strips invalid filename characters from each segment", () => {
    expect(generateEpubFilename({ title: "AI: The Next?", author: "John/Doe", date: "2024-01-15" }))
      .toBe("AI The Next - JohnDoe - 2024-01-15.epub");
  });

  it("preserves spaces and readable characters in title", () => {
    expect(generateEpubFilename({ title: "How React 18 Breaks Your useEffect" }))
      .toBe("How React 18 Breaks Your useEffect.epub");
  });
});
