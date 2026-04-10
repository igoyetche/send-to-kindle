import { describe, it, expect, vi } from "vitest";
import { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";
import { Title } from "../../src/domain/values/title.js";
import { Author } from "../../src/domain/values/author.js";
import { MarkdownContent } from "../../src/domain/values/markdown-content.js";
import { MarkdownDocument } from "../../src/domain/values/markdown-document.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";
import { EpubDocument } from "../../src/domain/values/epub-document.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import {
  ConversionError,
  DeliveryError,
  ok,
  err,
} from "../../src/domain/errors.js";
import type {
  ContentConverter,
  DocumentMailer,
  DeliveryLogger,
} from "../../src/domain/ports.js";

function makeTitle(value: string) {
  const result = Title.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeAuthor(value: string) {
  const result = Author.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeContent(value: string) {
  const result = MarkdownContent.create(value);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function makeDocument(value: string) {
  const content = makeContent(value);
  const metadata = DocumentMetadata.empty();
  return MarkdownDocument.fromParts(content, metadata);
}

function makeDevice(name = "personal"): KindleDevice {
  const emailResult = EmailAddress.create("user@kindle.com");
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup");
  return deviceResult.value;
}

function fakeLogger(): DeliveryLogger {
  return {
    deliveryAttempt: vi.fn(),
    deliverySuccess: vi.fn(),
    deliveryFailure: vi.fn(),
  };
}

describe("SendToKindleService", () => {
  it("converts then delivers on happy path", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);
    const device = makeDevice("personal");

    const result = await service.execute(makeTitle("Test"), makeDocument("# Hello"), makeAuthor("Claude"), device);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Test");
      expect(result.value.sizeBytes).toBe(epub.sizeBytes);
      expect(result.value.deviceName).toBe("personal");
    }
    expect(mailer.send).toHaveBeenCalledWith(epub, device);
  });

  it("returns conversion error without calling mailer", async () => {
    const conversionError = new ConversionError("EPUB gen failed");
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(err(conversionError)),
    };
    const mailer: DocumentMailer = { send: vi.fn() };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const result = await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conversion");
    }
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("returns delivery error when mailer fails", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const deliveryError = new DeliveryError("auth", "SMTP auth failed");
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(err(deliveryError)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    const result = await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("delivery");
    }
  });

  it("logs attempt and success with device name on happy path", async () => {
    const epub = new EpubDocument("Test", Buffer.from("epub-data"));
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(ok(epub)),
    };
    const mailer: DocumentMailer = {
      send: vi.fn().mockResolvedValue(ok(undefined)),
    };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice("personal"));

    expect(logger.deliveryAttempt).toHaveBeenCalledWith("Test", "epub", "personal");
    expect(logger.deliverySuccess).toHaveBeenCalledWith("Test", "epub", epub.sizeBytes, "personal");
  });

  it("logs attempt and failure with device name on error", async () => {
    const conversionError = new ConversionError("EPUB gen failed");
    const converter: ContentConverter = {
      toEpub: vi.fn().mockResolvedValue(err(conversionError)),
    };
    const mailer: DocumentMailer = { send: vi.fn() };
    const logger = fakeLogger();
    const service = new SendToKindleService(converter, mailer, logger);

    await service.execute(makeTitle("Test"), makeContent("# Hello"), makeAuthor("Claude"), makeDevice("personal"));

    expect(logger.deliveryAttempt).toHaveBeenCalledWith("Test", "epub", "personal");
    expect(logger.deliveryFailure).toHaveBeenCalledWith("Test", "conversion", "EPUB gen failed", "personal");
  });
});
