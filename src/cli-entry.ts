#!/usr/bin/env node

/**
 * CLI composition root.
 *
 * Wires all dependencies and delegates to `run()` from the CLI application
 * module. Handles dotenv loading (CWD first, then ~/.paperboy/.env fallback),
 * config validation (fail-fast, exit 4 on error), and process.exit.
 *
 * Implements FR-CLI-4: CLI entry point / composition root
 * ADR #9: Pino log level set to "silent" in CLI mode
 * ADR #10: process.stdin.isTTY coerced to boolean (undefined → false)
 * ADR #11: dotenv fallback warns on parse errors but not on ENOENT
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger, createImageProcessorLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { ImageProcessor } from "./infrastructure/converter/image-processor.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { readFromFile, readFromStdin } from "./infrastructure/cli/content-reader.js";
import { run, getUsageText } from "./application/cli.js";
import { loadDotenv } from "./infrastructure/dotenv-loader.js";
import { GrayMatterFrontmatterParser } from "./infrastructure/frontmatter/gray-matter-parser.js";

interface PackageJson {
  readonly version: string;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 0. Handle --help and --version before loading config (no env vars needed)
  // ---------------------------------------------------------------------------

  const rawArgs = process.argv.slice(2);

  // ---------------------------------------------------------------------------
  // 0a. Subcommand routing: "watch" delegates to watch-entry module
  // ---------------------------------------------------------------------------

  if (rawArgs[0] === "watch") {
    // Replace process.argv so watch-entry sees only the args after "watch"
    const [node, script] = process.argv;
    process.argv = [node ?? "node", script ?? "paperboy", ...rawArgs.slice(1)];
    // watch-entry sets up a long-running watcher with its own shutdown handlers.
    await import("./watch-entry.js");
    return;
  }

  if (rawArgs.includes("--help")) {
    process.stderr.write(getUsageText() + "\n");
    process.exit(0);
  }

  if (rawArgs.includes("--version")) {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkgJson = JSON.parse(readFileSync(pkgUrl, "utf-8")) as PackageJson;
    process.stderr.write(pkgJson.version + "\n");
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 1. Load .env files (shared logic with watch-entry.ts)
  // ---------------------------------------------------------------------------

  loadDotenv((msg) => process.stderr.write(msg + "\n"));

  // ---------------------------------------------------------------------------
  // 2. Read version from package.json
  //    Use URL + readFileSync so the path resolves correctly regardless of CWD.
  // ---------------------------------------------------------------------------

  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
  const version = pkg.version;

  // ---------------------------------------------------------------------------
  // 3. Load config (fail-fast) → wire dependencies → run CLI
  //    Config errors are the only expected failure path here; all other
  //    errors propagate through the Result types inside run().
  // ---------------------------------------------------------------------------

  try {
    const config = loadConfig();

    // ADR #9: Use "silent" log level so pino produces no output in CLI mode.
    // The CLI communicates with the user exclusively through stderr.
    const pinoLogger = createPinoLogger("silent");
    const deliveryLogger = createDeliveryLogger(pinoLogger);
    const imageProcessorLogger = createImageProcessorLogger(pinoLogger);

    const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
    const converter = new MarkdownEpubConverter(imageProcessor);
    const mailer = new SmtpMailer({ sender: config.sender, smtp: config.smtp });
    const service = new SendToKindleService(converter, mailer, deliveryLogger);
    const frontmatterParser = new GrayMatterFrontmatterParser();

    // ADR #10: Coerce process.stdin.isTTY to boolean — it is `undefined` when
    // stdin is redirected, which would be incorrectly truthy if not narrowed.
    const isTTY: boolean = process.stdin.isTTY === true;

    const exitCode = await run({
      service,
      devices: config.devices,
      defaultAuthor: config.defaultAuthor,
      frontmatterParser,
      argv: process.argv.slice(2),
      isTTY,
      readFromFile,
      readFromStdin,
      stdin: process.stdin,
      stderr: (msg: string) => process.stderr.write(msg + "\n"),
      version,
    });

    process.exit(exitCode);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Configuration error: ${message}\n`);
    process.exit(4);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
