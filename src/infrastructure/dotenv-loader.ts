/**
 * Shared dotenv loading logic used by cli-entry.ts and watch-entry.ts.
 *
 * Loads .env files in this order (first match wins):
 * 1. CWD/.env (current working directory)
 * 2. ~/.paperboy/.env (user home directory)
 * 3. dist/.env.example (shipped with package as reference)
 *
 * Values already set by earlier calls are NOT overwritten (dotenv never
 * overwrites existing vars).
 *
 * ADR #11: dotenv fallback warns on parse errors but not on ENOENT.
 */

import dotenv from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export function loadDotenv(
  warn: (message: string) => void = () => {},
): void {
  dotenv.config({ quiet: true }); // CWD/.env — silently skips if absent

  const fallbackPath = join(homedir(), ".paperboy", ".env");
  const fallbackResult = dotenv.config({ path: fallbackPath, quiet: true });

  if (fallbackResult.error) {
    const code: unknown = "code" in fallbackResult.error
      ? fallbackResult.error["code"]
      : undefined;
    if (code !== "ENOENT") {
      warn(
        `Warning: could not parse ${fallbackPath}: ${fallbackResult.error.message}`,
      );
    }
  }

  // Third fallback: dist/.env.example (shipped with package)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const distExamplePath = join(__dirname, "..", "..", "dist", ".env.example");
  const distExampleResult = dotenv.config({ path: distExamplePath, quiet: true });

  if (distExampleResult.error) {
    const code: unknown = "code" in distExampleResult.error
      ? distExampleResult.error["code"]
      : undefined;
    if (code !== "ENOENT") {
      warn(
        `Warning: could not parse ${distExamplePath}: ${distExampleResult.error.message}`,
      );
    }
  }
}
