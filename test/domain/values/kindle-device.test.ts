import { describe, it, expect } from "vitest";
import { KindleDevice } from "../../../src/domain/values/kindle-device.js";
import { EmailAddress } from "../../../src/domain/values/email-address.js";

function makeEmail(raw = "user@kindle.com"): EmailAddress {
  const result = EmailAddress.create(raw);
  if (!result.ok) throw new Error("bad test setup");
  return result.value;
}

describe("KindleDevice", () => {
  it("creates a device from a valid name and EmailAddress", () => {
    const result = KindleDevice.create("personal", makeEmail());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("lowercases and trims the name", () => {
    const result = KindleDevice.create("  Personal  ", makeEmail());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("personal");
    }
  });

  it("returns ValidationError for empty name", () => {
    const result = KindleDevice.create("", makeEmail());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.field).toBe("device.name");
    }
  });

  it("returns ValidationError for name containing ':'", () => {
    const result = KindleDevice.create("my:device", makeEmail());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("returns ValidationError for name containing ','", () => {
    const result = KindleDevice.create("a,b", makeEmail());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("accepts alphanumeric, hyphens, and underscores in name", () => {
    for (const name of ["personal", "my-kindle", "device_1", "abc123"]) {
      const result = KindleDevice.create(name, makeEmail());
      expect(result.ok).toBe(true);
    }
  });

  it("stores the email as the passed-in EmailAddress", () => {
    const email = makeEmail("partner@kindle.com");
    const result = KindleDevice.create("partner", email);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email.value).toBe("partner@kindle.com");
    }
  });
});
