import { basename } from "node:path";
import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import type { DeviceRegistry } from "../domain/device-registry.js";
import type { Author } from "../domain/values/author.js";
import { MarkdownContent } from "../domain/values/markdown-content.js";
import { extractTitle } from "../domain/title-extractor.js";

/**
 * Logger interface for the watcher orchestrator.
 * Implements FR-009: watch folder processing with structured logging.
 */
export interface WatcherLogger {
  info: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Dependencies injected into the watcher orchestrator.
 * Implements FR-009: processFile receives all side-effectful deps via injection.
 */
export interface WatcherDeps {
  service: Pick<SendToKindleService, "execute">;
  devices: DeviceRegistry;
  defaultAuthor: Author;
  watchFolder: string;
  readFile: (path: string) => Promise<string>;
  moveToSent: (filePath: string) => Promise<string>;
  moveToError: (filePath: string, errorKind: string, errorMessage: string) => Promise<string>;
  logger: WatcherLogger;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function isTransient(cause: string): boolean {
  return cause === "connection";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates the full processing pipeline for a single watched file.
 *
 * Implements FR-009: read → validate → extract title → resolve device → send with retry → move.
 *
 * Retry policy:
 * - Transient delivery errors (connection): up to MAX_RETRIES retries with exponential backoff
 * - Permanent delivery errors (auth, rejection): no retry
 * - Non-delivery errors (conversion, validation, size_limit): no retry
 * - File read errors: log warning, do not move file
 */
export async function processFile(
  filePath: string,
  deps: WatcherDeps,
): Promise<void> {
  const filename = basename(filePath);

  // Step 1: Read file
  let content: string;
  try {
    content = await deps.readFile(filePath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown read error";
    deps.logger.warn(`Could not read ${filename}: ${message}`);
    return;
  }

  // Step 2: Validate not empty
  if (content.length === 0) {
    deps.logger.error(`File ${filename} is empty`);
    await deps.moveToError(filePath, "validation", `File '${filename}' is empty`);
    return;
  }

  // Step 3: Create MarkdownContent (validates size)
  const contentResult = MarkdownContent.create(content);
  if (!contentResult.ok) {
    deps.logger.error(`File ${filename}: ${contentResult.error.message}`);
    await deps.moveToError(filePath, contentResult.error.kind, contentResult.error.message);
    return;
  }

  // Step 4: Extract title from H1 or filename fallback
  const titleResult = extractTitle(content, filename);
  if (!titleResult.ok) {
    deps.logger.error(`File ${filename}: title extraction failed — ${titleResult.error.message}`);
    await deps.moveToError(filePath, "validation", titleResult.error.message);
    return;
  }

  // Step 5: Resolve device (use default)
  const deviceResult = deps.devices.resolve();
  if (!deviceResult.ok) {
    deps.logger.error(`No device configured: ${deviceResult.error.message}`);
    await deps.moveToError(filePath, "validation", deviceResult.error.message);
    return;
  }

  // Step 6: Send with retry for transient failures
  deps.logger.info(`Processing ${filename}...`);

  let lastError: { kind: string; message: string } | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      deps.logger.info(`Retry ${attempt}/${MAX_RETRIES} for ${filename} in ${backoff}ms`);
      await delay(backoff);
    }

    const result = await deps.service.execute(
      titleResult.value,
      contentResult.value,
      deps.defaultAuthor,
      deviceResult.value,
    );

    if (result.ok) {
      deps.logger.info(`Sent ${filename} (${result.value.sizeBytes} bytes)`);
      await deps.moveToSent(filePath);
      return;
    }

    lastError = { kind: result.error.kind, message: result.error.message };

    // Non-delivery errors: no retry
    if (result.error.kind !== "delivery") {
      break;
    }

    // Permanent delivery errors: no retry
    if (!isTransient(result.error.cause)) {
      break;
    }
  }

  deps.logger.error(`Failed to process ${filename}: ${lastError?.message ?? "unknown"}`);
  await deps.moveToError(
    filePath,
    lastError?.kind ?? "unknown",
    lastError?.message ?? "Unknown error",
  );
}
