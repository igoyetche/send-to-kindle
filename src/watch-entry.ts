#!/usr/bin/env node

/**
 * Watcher composition root.
 *
 * Wires all dependencies and delegates to `startWatcher()` from the watcher
 * application module. Handles dotenv loading (CWD first, then ~/.paperboy/.env
 * fallback), config validation (fail-fast, exit 4 on error), watch folder
 * validation, and graceful shutdown on SIGINT/SIGTERM.
 *
 * Implements FR-009: watch folder composition root / entry point.
 * Follows the same dotenv loading pattern as cli-entry.ts (ADR #11).
 */

import dotenv from "dotenv";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, rename, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { watch } from "chokidar";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { Author } from "./domain/values/author.js";
import { createFileMover } from "./infrastructure/watcher/file-mover.js";
import { createFolderWatcher } from "./infrastructure/watcher/folder-watcher.js";
import { startWatcher } from "./application/watcher.js";
import type { WatcherLogger } from "./application/watcher.js";

// ---------------------------------------------------------------------------
// 0. Handle --help before loading config (no env vars needed)
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help")) {
  process.stderr.write(
    [
      "paperboy watch — Watch a folder for .md files and send them to Kindle",
      "",
      "USAGE",
      "  paperboy watch [--help]",
      "",
      "The watcher monitors WATCH_FOLDER for new .md files, converts each to EPUB,",
      "and emails it to your configured Kindle device.",
      "",
      "Processed files are moved to WATCH_FOLDER/sent/.",
      "Failed files are moved to WATCH_FOLDER/error/ with an .error.txt file.",
      "",
      "CONFIGURATION",
      "  Set WATCH_FOLDER in your .env file or environment:",
      "    WATCH_FOLDER=/path/to/kindle-inbox",
      "",
      "  All other configuration (SMTP, devices, author) uses the same env vars",
      "  as the CLI and MCP server.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Load .env files
//    CWD/.env is loaded first (dotenv default behaviour).
//    ~/.paperboy/.env is loaded as a fallback — values already set by the
//    first call are NOT overwritten (dotenv never overwrites existing vars).
// ---------------------------------------------------------------------------

dotenv.config(); // CWD/.env — silently skips if absent

const fallbackPath = join(homedir(), ".paperboy", ".env");
const fallbackResult = dotenv.config({ path: fallbackPath });

// Warn only when the file exists but could not be parsed.
// ENOENT means the file simply isn't there — that is expected and silent.
if (fallbackResult.error) {
  const nodeError = fallbackResult.error as NodeJS.ErrnoException;
  if (nodeError.code !== "ENOENT") {
    process.stderr.write(
      `Warning: could not parse ${fallbackPath}: ${fallbackResult.error.message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Load config (fail-fast), validate watch folder, wire deps, start watcher
// ---------------------------------------------------------------------------

try {
  const config = loadConfig();

  // Validate WATCH_FOLDER is configured
  if (!config.watchFolder) {
    process.stderr.write(
      "Configuration error: WATCH_FOLDER is required. Set it in your .env file or environment.\n",
    );
    process.exit(4);
  }

  const watchFolder = resolve(config.watchFolder);

  // Validate watch folder exists on disk
  if (!existsSync(watchFolder)) {
    process.stderr.write(
      `Configuration error: WATCH_FOLDER does not exist: ${watchFolder}\n`,
    );
    process.exit(4);
  }

  // Wire dependencies
  const pinoLogger = createPinoLogger(config.logLevel);
  const deliveryLogger = createDeliveryLogger(pinoLogger);

  const converter = new MarkdownEpubConverter();
  const mailer = new SmtpMailer({ sender: config.sender, smtp: config.smtp });
  const service = new SendToKindleService(converter, mailer, deliveryLogger);

  const authorResult = Author.create(config.defaultAuthor);
  if (!authorResult.ok) {
    process.stderr.write(
      `Configuration error: invalid DEFAULT_AUTHOR: ${authorResult.error.message}\n`,
    );
    process.exit(4);
  }

  const fileMover = createFileMover(watchFolder, {
    rename: async (src, dest) => { await rename(src, dest); },
    writeFile: async (path, content) => { await writeFile(path, content, "utf-8"); },
    mkdir: async (path) => { await mkdir(path, { recursive: true }); },
    exists: async (path) => {
      try { await stat(path); return true; } catch { return false; }
    },
  });

  const logger: WatcherLogger = {
    info: (msg) => pinoLogger.info(msg),
    error: (msg) => pinoLogger.error(msg),
    warn: (msg) => pinoLogger.warn(msg),
  };

  logger.info(`Starting paperboy watcher on ${watchFolder}`);

  const handle = await startWatcher({
    service,
    devices: config.devices,
    defaultAuthor: authorResult.value,
    watchFolder,
    readFile: (path) => readFile(path, "utf-8"),
    moveToSent: (fp) => fileMover.moveToSent(fp),
    moveToError: (fp, k, m) => fileMover.moveToError(fp, k, m),
    logger,
    listFiles: async (dir, ext) => {
      const entries = await readdir(dir);
      return entries.filter((e) => e.endsWith(ext)).map((e) => join(dir, e));
    },
    createWatcher: (opts) => createFolderWatcher({
      inboxPath: opts.inboxPath,
      onFile: opts.onFile,
      watch: (path, options) => watch(path, options),
    }),
  });

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down watcher...");
    await handle.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Configuration error: ${message}\n`);
  process.exit(4);
}
