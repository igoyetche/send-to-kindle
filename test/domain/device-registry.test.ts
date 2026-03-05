import { describe, it, expect } from "vitest";
import { DeviceRegistry } from "../../src/domain/device-registry.js";
import { KindleDevice } from "../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../src/domain/values/email-address.js";

function makeDevice(name: string, email = "user@kindle.com"): KindleDevice {
  const emailResult = EmailAddress.create(email);
  if (!emailResult.ok) throw new Error("bad test setup");
  const deviceResult = KindleDevice.create(name, emailResult.value);
  if (!deviceResult.ok) throw new Error("bad test setup: " + deviceResult.error.message);
  return deviceResult.value;
}

describe("DeviceRegistry", () => {
  it("creates a registry with a single device using it as the default", () => {
    const result = DeviceRegistry.create([makeDevice("personal")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defaultDevice.name).toBe("personal");
    }
  });

  it("uses explicit default when KINDLE_DEFAULT_DEVICE is provided", () => {
    const devices = [makeDevice("personal"), makeDevice("partner", "partner@kindle.com")];
    const result = DeviceRegistry.create(devices, "partner");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defaultDevice.name).toBe("partner");
    }
  });

  it("returns ValidationError for empty device list", () => {
    const result = DeviceRegistry.create([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns ValidationError for duplicate device names", () => {
    const result = DeviceRegistry.create([
      makeDevice("personal"),
      makeDevice("personal"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("personal");
    }
  });

  it("returns ValidationError when default device name is unknown", () => {
    const result = DeviceRegistry.create([makeDevice("personal")], "unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns ValidationError when more than 10 devices are provided", () => {
    const devices = Array.from({ length: 11 }, (_, i) =>
      makeDevice(`device${i}`, `device${i}@kindle.com`),
    );
    const result = DeviceRegistry.create(devices);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("10");
    }
  });

  it("resolve(undefined) returns the default device", () => {
    const registry = DeviceRegistry.create([makeDevice("personal")]);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("resolve by name returns the named device", () => {
    const devices = [makeDevice("personal"), makeDevice("partner", "partner@kindle.com")];
    const registry = DeviceRegistry.create(devices);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve("partner");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("partner");
    }
  });

  it("resolve is case-insensitive", () => {
    const registry = DeviceRegistry.create([makeDevice("personal")]);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve("Personal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("resolve returns ValidationError for unknown name listing names only (no emails)", () => {
    const registry = DeviceRegistry.create([makeDevice("personal")]);
    if (!registry.ok) throw new Error("bad test setup");
    const result = registry.value.resolve("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toContain("personal");
      expect(result.error.message).not.toContain("@");
    }
  });

  it("names getter returns all registered device names", () => {
    const devices = [makeDevice("personal"), makeDevice("partner", "partner@kindle.com")];
    const registry = DeviceRegistry.create(devices);
    if (!registry.ok) throw new Error("bad test setup");
    expect(registry.value.names).toEqual(["personal", "partner"]);
  });
});
