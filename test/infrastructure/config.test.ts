import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";

function requiredEnv(): Record<string, string> {
  return {
    KINDLE_DEVICES: "personal:user@kindle.com",
    SENDER_EMAIL: "sender@example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASS: "pass",
  };
}

describe("loadConfig", () => {
  beforeEach(() => {
    for (const key of [
      "KINDLE_DEVICES",
      "KINDLE_DEFAULT_DEVICE",
      "SENDER_EMAIL",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "DEFAULT_AUTHOR",
      "MCP_HTTP_PORT",
      "MCP_AUTH_TOKEN",
      "LOG_LEVEL",
    ]) {
      delete process.env[key];
    }
  });

  it("loads a single device from KINDLE_DEVICES", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.devices.names).toEqual(["personal"]);
    expect(config.devices.defaultDevice.name).toBe("personal");
  });

  it("loads multiple devices from KINDLE_DEVICES", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:me@kindle.com,partner:partner@kindle.com",
    });
    const config = loadConfig();
    expect(config.devices.names).toEqual(["personal", "partner"]);
  });

  it("uses KINDLE_DEFAULT_DEVICE to set the default", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:me@kindle.com,partner:partner@kindle.com",
      KINDLE_DEFAULT_DEVICE: "partner",
    });
    const config = loadConfig();
    expect(config.devices.defaultDevice.name).toBe("partner");
  });

  it("throws when KINDLE_DEVICES is missing", () => {
    const env = requiredEnv();
    delete env.KINDLE_DEVICES;
    Object.assign(process.env, env);
    expect(() => loadConfig()).toThrow("KINDLE_DEVICES");
  });

  it("throws when a KINDLE_DEVICES entry has no colon", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal",
    });
    expect(() => loadConfig()).toThrow();
  });

  it("throws when a KINDLE_DEVICES email is invalid", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:not-an-email",
    });
    expect(() => loadConfig()).toThrow();
  });

  it("throws when KINDLE_DEVICES has duplicate device names", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEVICES: "personal:a@kindle.com,personal:b@kindle.com",
    });
    expect(() => loadConfig()).toThrow("personal");
  });

  it("throws when KINDLE_DEFAULT_DEVICE references unknown device", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_DEFAULT_DEVICE: "ghost",
    });
    expect(() => loadConfig()).toThrow();
  });

  it("throws when more than 10 devices are configured", () => {
    const entries = Array.from(
      { length: 11 },
      (_, i) => `device${i}:d${i}@kindle.com`,
    ).join(",");
    Object.assign(process.env, { ...requiredEnv(), KINDLE_DEVICES: entries });
    expect(() => loadConfig()).toThrow();
  });

  it("validates SENDER_EMAIL format", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      SENDER_EMAIL: "bad-email",
    });
    expect(() => loadConfig()).toThrow("SENDER_EMAIL");
  });

  it("coerces SMTP_PORT to number", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(typeof config.smtp.port).toBe("number");
  });

  it("defaults DEFAULT_AUTHOR to 'Claude'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.defaultAuthor).toBe("Claude");
  });

  it("sets http config when MCP_HTTP_PORT and MCP_AUTH_TOKEN are present", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      MCP_HTTP_PORT: "3000",
      MCP_AUTH_TOKEN: "secret",
    });
    const config = loadConfig();
    expect(config.http).toEqual({ port: 3000, authToken: "secret" });
  });

  it("throws when MCP_HTTP_PORT is set without MCP_AUTH_TOKEN", () => {
    Object.assign(process.env, { ...requiredEnv(), MCP_HTTP_PORT: "3000" });
    expect(() => loadConfig()).toThrow("MCP_AUTH_TOKEN");
  });

  it("defaults LOG_LEVEL to 'info'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.logLevel).toBe("info");
  });
});
