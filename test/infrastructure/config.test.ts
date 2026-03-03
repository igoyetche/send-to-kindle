import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";

function requiredEnv(): Record<string, string> {
  return {
    KINDLE_EMAIL: "user@kindle.com",
    SENDER_EMAIL: "sender@example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASS: "pass",
  };
}

describe("loadConfig", () => {
  beforeEach(() => {
    // Clear relevant env vars
    for (const key of Object.keys(requiredEnv())) {
      delete process.env[key];
    }
    delete process.env.DEFAULT_AUTHOR;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.LOG_LEVEL;
  });

  it("loads all required variables", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.kindle.email).toBe("user@kindle.com");
    expect(config.sender.email).toBe("sender@example.com");
    expect(config.smtp.host).toBe("smtp.example.com");
    expect(config.smtp.port).toBe(587);
    expect(config.smtp.user).toBe("user");
    expect(config.smtp.pass).toBe("pass");
  });

  it("throws when a required variable is missing", () => {
    const env = requiredEnv();
    delete env.KINDLE_EMAIL;
    Object.assign(process.env, env);
    expect(() => loadConfig()).toThrow("KINDLE_EMAIL");
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

  it("uses provided DEFAULT_AUTHOR", () => {
    Object.assign(process.env, { ...requiredEnv(), DEFAULT_AUTHOR: "Alice" });
    const config = loadConfig();
    expect(config.defaultAuthor).toBe("Alice");
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
    Object.assign(process.env, {
      ...requiredEnv(),
      MCP_HTTP_PORT: "3000",
    });
    expect(() => loadConfig()).toThrow("MCP_AUTH_TOKEN");
  });

  it("validates KINDLE_EMAIL format", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      KINDLE_EMAIL: "not-an-email",
    });
    expect(() => loadConfig()).toThrow("KINDLE_EMAIL");
  });

  it("validates SENDER_EMAIL format", () => {
    Object.assign(process.env, {
      ...requiredEnv(),
      SENDER_EMAIL: "bad-email",
    });
    expect(() => loadConfig()).toThrow("SENDER_EMAIL");
  });

  it("defaults LOG_LEVEL to 'info'", () => {
    Object.assign(process.env, requiredEnv());
    const config = loadConfig();
    expect(config.logLevel).toBe("info");
  });
});
