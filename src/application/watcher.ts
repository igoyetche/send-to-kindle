import { basename } from "node:path";
import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import type { DeviceRegistry } from "../domain/device-registry.js";
import type { Author } from "../domain/values/author.js";
import type { DeliveryError } from "../domain/errors.js";
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

function isTransient(cause: DeliveryError["cause"]): boolean {
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

/**
 * Dependencies for startWatcher, extending WatcherDeps with filesystem and watcher factory.
 * Implements FR-009: watch folder startup with existing file processing and graceful shutdown.
 */
export interface StartWatcherDeps extends WatcherDeps {
  listFiles: (dir: string, ext: string) => Promise<string[]>;
  createWatcher: (opts: { inboxPath: string; onFile: (path: string) => void }) => { close: () => Promise<void> };
}

/**
 * Handle returned by startWatcher for lifecycle management.
 * Implements FR-009: graceful shutdown waits for in-flight processing to complete.
 */
export interface WatcherHandle {
  shutdown: () => Promise<void>;
}

/**
 * Starts the watch folder orchestrator: processes existing files then watches for new ones.
 *
 * Implements FR-009:
 * - Deduplicates files using sentPaths set
 * - Queues files for serial processing
 * - Tolerates moveToSent failures by marking file as sent in-memory
 * - Graceful shutdown: drains queue and closes watcher
 */
export async function startWatcher(deps: StartWatcherDeps): Promise<WatcherHandle> {
  const sentPaths = new Set<string>();
  let processing = false;
  let shutdownRequested = false;
  const queue: string[] = [];

  const wrappedDeps: WatcherDeps = {
    ...deps,
    moveToSent: async (filePath: string) => {
      try {
        const result = await deps.moveToSent(filePath);
        sentPaths.add(filePath);
        return result;
      } catch (e: unknown) {
        sentPaths.add(filePath);
        const msg = e instanceof Error ? e.message : "unknown";
        deps.logger.warn(`Sent but could not move ${basename(filePath)}: ${msg}`);
        return filePath;
      }
    },
    moveToError: async (filePath: string, errorKind: string, errorMessage: string) => {
      try {
        const result = await deps.moveToError(filePath, errorKind, errorMessage);
        sentPaths.add(filePath);
        return result;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "unknown";
        deps.logger.warn(`Could not move ${basename(filePath)} to error/: ${msg}`);
        return filePath;
      }
    },
  };

  async function processNext(): Promise<void> {
    if (processing) return;
    while (queue.length > 0 && !shutdownRequested) {
      const next = queue.shift();
      if (next === undefined) break;
      if (sentPaths.has(next)) {
        deps.logger.warn(`Skipping already-sent file: ${basename(next)}`);
        continue;
      }
      processing = true;
      await processFile(next, wrappedDeps);
      processing = false;
    }
  }

  function enqueue(filePath: string): void {
    if (sentPaths.has(filePath)) return;
    queue.push(filePath);
    void processNext();
  }

  const watcher = deps.createWatcher({
    inboxPath: deps.watchFolder,
    onFile: enqueue,
  });

  const existing = await deps.listFiles(deps.watchFolder, ".md");
  for (const file of existing) {
    enqueue(file);
  }

  return {
    shutdown: async () => {
      shutdownRequested = true;
      while (processing) {
        await delay(100);
      }
      await watcher.close();
    },
  };
}
