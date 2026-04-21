import { describe, it, expect, vi } from "vitest";
import { ToolHandler } from "../../src/application/tool-handler.js";
import {
  ok,
  err,
  ConversionError,
  DeliveryError,
  FrontmatterError,
} from "../../src/domain/errors.js";
import type { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";
import type { FrontmatterParser } from "../../src/domain/ports.js";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";
import { DocumentMetadata } from "../../src/domain/values/document-metadata.js";

function makeDevice(name: string, email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup");
  return deviceResult.value;
}

function makeRegistry(...names: string[]): DeviceRegistry {
  const devices = names.map((n, i) => makeDevice(n, `d${i}@kindle.com`));
  const result = DeviceRegistry.create(devices);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

function fakeService(
  result = ok({ title: "Test", sizeBytes: 1024, deviceName: "personal" }),
): Pick<SendToKindleService, "execute"> {
  return {
    execute: vi.fn().mockResolvedValue(result),
  };
}

function fakeFrontmatterParser(): FrontmatterParser {
  return {
    parse: vi.fn((raw: string) => {
      // Return the raw content as body with empty metadata
      return ok({
        metadata: DocumentMetadata.empty(),
        body: raw,
      });
    }),
  };
}

describe("ToolHandler", () => {
  it("returns success response including device name on happy path", async () => {
    const service = fakeService(ok({ title: "My Book", sizeBytes: 2048, deviceName: "personal" }));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), fakeFrontmatterParser());

    const response = await handler.handle({ title: "My Book", content: "# Hello" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain("My Book");
    expect(parsed.message).toContain("personal");
    expect(parsed.message).not.toContain("@");
    expect(response.isError).toBeUndefined();
  });

  it("uses default author when not provided", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "DefaultBot", makeRegistry("personal"), fakeFrontmatterParser());

    await handler.handle({ title: "Test", content: "# Hi" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ value: "DefaultBot" }),
      expect.anything(),
    );
  });

  it("resolves the default device when no device arg provided", async () => {
    const service = fakeService();
    const registry = makeRegistry("personal");
    const handler = new ToolHandler(service, "Claude", registry, fakeFrontmatterParser());

    await handler.handle({ title: "Test", content: "# Hi" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ name: "personal" }),
    );
  });

  it("resolves a named device when device arg is provided", async () => {
    const service = fakeService();
    const registry = makeRegistry("personal", "partner");
    const handler = new ToolHandler(service, "Claude", registry, fakeFrontmatterParser());

    await handler.handle({ title: "Test", content: "# Hi", device: "partner" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ name: "partner" }),
    );
  });

  it("returns validation error for unknown device name", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), fakeFrontmatterParser());

    const response = await handler.handle({ title: "Test", content: "# Hi", device: "ghost" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
    expect(parsed.details).not.toContain("@");
  });

  it("returns validation error for empty title", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), fakeFrontmatterParser());

    const response = await handler.handle({ title: "", content: "# Hi" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
  });

  it("maps ConversionError to CONVERSION_ERROR", async () => {
    const service = fakeService(err(new ConversionError("fail")));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), fakeFrontmatterParser());

    const response = await handler.handle({ title: "Test", content: "# Hi" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.error).toBe("CONVERSION_ERROR");
  });

  it("maps DeliveryError to SMTP_ERROR", async () => {
    const service = fakeService(err(new DeliveryError("auth", "fail")));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), fakeFrontmatterParser());

    const response = await handler.handle({ title: "Test", content: "# Hi" });

    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.error).toBe("SMTP_ERROR");
  });

  it("sets isError true on failure responses", async () => {
    const service = fakeService(err(new ConversionError("fail")));
    const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), fakeFrontmatterParser());

    const response = await handler.handle({ title: "Test", content: "# Hi" });

    expect(response.isError).toBe(true);
  });

  describe("FR-MCP-1: frontmatter title resolution", () => {
    it("uses metadata title when title arg omitted and frontmatter present", async () => {
      const service = fakeService(
        ok({ title: "Metadata Title", sizeBytes: 1024, deviceName: "personal" }),
      );
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.fromRecord({
              title: "Metadata Title",
            }),
            body: "# Body content",
          }),
        ),
      } as unknown as FrontmatterParser;

      const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), frontmatterParser);

      const response = await handler.handle({ content: "---\ntitle: Metadata Title\n---\n# Body" });

      const parsed = JSON.parse((response.content[0] as { text: string }).text);
      expect(parsed.success).toBe(true);
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining({ value: "Metadata Title" }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("explicit title wins over metadata when both present", async () => {
      const service = fakeService(
        ok({ title: "Explicit Title", sizeBytes: 1024, deviceName: "personal" }),
      );
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.fromRecord({
              title: "Metadata Title",
            }),
            body: "# Body content",
          }),
        ),
      } as unknown as FrontmatterParser;

      const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), frontmatterParser);

      const response = await handler.handle({
        title: "Explicit Title",
        content: "---\ntitle: Metadata Title\n---\n# Body",
      });

      const parsed = JSON.parse((response.content[0] as { text: string }).text);
      expect(parsed.success).toBe(true);
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining({ value: "Explicit Title" }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("returns validation error when title omitted and no frontmatter metadata", async () => {
      const service = fakeService();
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          ok({
            metadata: DocumentMetadata.empty(),
            body: "# No frontmatter, no title arg",
          }),
        ),
      } as unknown as FrontmatterParser;

      const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), frontmatterParser);

      const response = await handler.handle({ content: "# No frontmatter, no title arg" });

      const parsed = JSON.parse((response.content[0] as { text: string }).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("VALIDATION_ERROR");
      expect(parsed.details).toMatch(/title/i);
    });

    it("returns FRONTMATTER_ERROR when frontmatter parsing fails", async () => {
      const service = fakeService();
      const frontmatterParser = {
        parse: vi.fn().mockReturnValue(
          err(new FrontmatterError("Invalid YAML in frontmatter")),
        ),
      } as unknown as FrontmatterParser;

      const handler = new ToolHandler(service, "Claude", makeRegistry("personal"), frontmatterParser);

      const response = await handler.handle({
        title: "Test",
        content: "---\ninvalid: yaml: here:\n---\n# Body",
      });

      const parsed = JSON.parse((response.content[0] as { text: string }).text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("FRONTMATTER_ERROR");
      expect(response.isError).toBe(true);
    });
  });
});
