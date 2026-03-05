import { EmailAddress } from "../domain/values/email-address.js";
import { KindleDevice } from "../domain/values/kindle-device.js";
import { DeviceRegistry } from "../domain/device-registry.js";
import { ValidationError, type Result, ok, err } from "../domain/errors.js";

/** Implements FR-4: Config interface with DeviceRegistry replacing single KINDLE_EMAIL */
export interface Config {
  devices: DeviceRegistry;
  sender: { email: string };
  smtp: { host: string; port: number; user: string; pass: string };
  defaultAuthor: string;
  http?: { port: number; authToken: string };
  logLevel: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseDeviceEntries(
  raw: string,
): Result<Array<{ name: string; email: string }>, ValidationError> {
  const entries: Array<{ name: string; email: string }> = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      return err(
        new ValidationError(
          "KINDLE_DEVICES",
          `Invalid entry: "${trimmed}". Expected "name:email" format.`,
        ),
      );
    }
    entries.push({
      name: trimmed.slice(0, colonIndex),
      email: trimmed.slice(colonIndex + 1),
    });
  }
  return ok(entries);
}

function buildDeviceRegistry(
  entries: Array<{ name: string; email: string }>,
  defaultName?: string,
): Result<DeviceRegistry, ValidationError> {
  const devices: KindleDevice[] = [];
  for (const entry of entries) {
    const emailResult = EmailAddress.create(entry.email, "device.email");
    if (!emailResult.ok) return emailResult;
    const deviceResult = KindleDevice.create(entry.name, emailResult.value);
    if (!deviceResult.ok) return deviceResult;
    devices.push(deviceResult.value);
  }
  return DeviceRegistry.create(devices, defaultName);
}

function parseDevices(): DeviceRegistry {
  const raw = requireEnv("KINDLE_DEVICES");
  const entriesResult = parseDeviceEntries(raw);
  if (!entriesResult.ok) throw new Error(entriesResult.error.message);
  const defaultName = process.env.KINDLE_DEFAULT_DEVICE;
  const registryResult = buildDeviceRegistry(entriesResult.value, defaultName);
  if (!registryResult.ok) throw new Error(registryResult.error.message);
  return registryResult.value;
}

/** Implements FR-4: Loads and validates all configuration from environment variables */
export function loadConfig(): Config {
  const devices = parseDevices();

  const senderEmailResult = EmailAddress.create(
    requireEnv("SENDER_EMAIL"),
    "SENDER_EMAIL",
  );
  if (!senderEmailResult.ok) {
    throw new Error(
      `${senderEmailResult.error.field}: ${senderEmailResult.error.message}`,
    );
  }

  const smtpHost = requireEnv("SMTP_HOST");
  const smtpPort = Number(requireEnv("SMTP_PORT"));
  const smtpUser = requireEnv("SMTP_USER");
  const smtpPass = requireEnv("SMTP_PASS");

  const defaultAuthor = process.env.DEFAULT_AUTHOR || "Claude";
  const logLevel = process.env.LOG_LEVEL || "info";

  let http: Config["http"];
  const httpPort = process.env.MCP_HTTP_PORT;
  if (httpPort) {
    const authToken = process.env.MCP_AUTH_TOKEN;
    if (!authToken) {
      throw new Error("MCP_AUTH_TOKEN is required when MCP_HTTP_PORT is set");
    }
    http = { port: Number(httpPort), authToken };
  }

  return {
    devices,
    sender: { email: senderEmailResult.value.value },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
    defaultAuthor,
    http,
    logLevel,
  };
}
