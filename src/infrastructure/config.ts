export interface Config {
  kindle: { email: string };
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

function validateEmail(value: string, name: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(
      `Invalid email format for ${name}: "${value}"`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const kindleEmail = validateEmail(
    requireEnv("KINDLE_EMAIL"),
    "KINDLE_EMAIL",
  );
  const senderEmail = validateEmail(
    requireEnv("SENDER_EMAIL"),
    "SENDER_EMAIL",
  );
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
      throw new Error(
        "MCP_AUTH_TOKEN is required when MCP_HTTP_PORT is set",
      );
    }
    http = { port: Number(httpPort), authToken };
  }

  return {
    kindle: { email: kindleEmail },
    sender: { email: senderEmail },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
    defaultAuthor,
    http,
    logLevel,
  };
}
