import { describe, it, expect, vi } from "vitest";
import { ToolHandler } from "../../src/application/tool-handler.js";
import {
  ok,
  err,
  ConversionError,
  DeliveryError,
  ValidationError,
  SizeLimitError,
} from "../../src/domain/errors.js";
import type { SendToKindleService } from "../../src/domain/send-to-kindle-service.js";

function fakeService(
  result = ok({ title: "Test", sizeBytes: 1024 }),
): SendToKindleService {
  return {
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as SendToKindleService;
}

describe("ToolHandler", () => {
  it("returns success response on happy path", async () => {
    const service = fakeService(ok({ title: "My Book", sizeBytes: 2048 }));
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "My Book",
      content: "# Hello",
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("My Book"),
        },
      ],
    });
  });

  it("uses default author when not provided", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "DefaultBot");

    await handler.handle({ title: "Test", content: "# Hi" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ value: "DefaultBot" }),
    );
  });

  it("uses provided author over default", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "DefaultBot");

    await handler.handle({ title: "Test", content: "# Hi", author: "Alice" });

    expect(service.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ value: "Alice" }),
    );
  });

  it("returns validation error for empty title", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({ title: "", content: "# Hi" });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
  });

  it("returns validation error for empty content", async () => {
    const service = fakeService();
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({ title: "Test", content: "" });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("VALIDATION_ERROR");
  });

  it("maps ConversionError to CONVERSION_ERROR", async () => {
    const service = fakeService(
      err(new ConversionError("EPUB gen failed")),
    );
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "Test",
      content: "# Hi",
    });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("CONVERSION_ERROR");
  });

  it("maps DeliveryError to SMTP_ERROR", async () => {
    const service = fakeService(
      err(new DeliveryError("auth", "Auth failed")),
    );
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "Test",
      content: "# Hi",
    });

    const text = (response.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("SMTP_ERROR");
  });

  it("sets isError true on failure responses", async () => {
    const service = fakeService(
      err(new ConversionError("fail")),
    );
    const handler = new ToolHandler(service, "Claude");

    const response = await handler.handle({
      title: "Test",
      content: "# Hi",
    });

    expect(response.isError).toBe(true);
  });
});
