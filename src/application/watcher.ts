import { basename } from "node:path";
import type { DeliverySuccess, SendToKindleService } from "../domain/send-to-kindle-service.js";
import type { DeviceRegistry } from "../domain/device-registry.js";
import type { Author } from "../domain/values/author.js";
import type { DeliveryError, DomainError, Result } from "../domain/errors.js";
import type { FrontmatterParser } from "../domain/ports.js";
import { EpubDocument, MarkdownContent, MarkdownDocument } from "../domain/values/index.js";
import { resolveTitle } from "../domain/title-resolver.js";
import { findFirstH1 } from "../domain/find-first-h1.js";
import type { EpubReadResult } from "../infrastructure/cli/epub-reader.js";

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
  service: Pick<SendToKindleService, "execute" | "sendEpub">;
  devices: DeviceRegistry;
  defaultAuthor: Author;
  frontmatterParser: FrontmatterParser;
  watchFolder: string;
  readFile: (path: string) => Promise<string>;
  readEpubFile: (path: string) => Promise<EpubReadResult>;
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
 * Sends a document with exponential-backoff retry for transient SMTP failures.
 * Handles success/failure logging and file movement.
 */
async function sendWithRetry(
  filename: string,
  filePath: string,
  send: () => Promise<Result<DeliverySuccess, DomainError>>,
  deps: WatcherDeps,
): Promise<void> {
  deps.logger.info(`Processing ${filename}...`);

  let lastError: { kind: string; message: string } | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      deps.logger.info(`Retry ${attempt}/${MAX_RETRIES} for ${filename} in ${backoff}ms`);
      await delay(backoff);
    }

    const result = await send();

    if (result.ok) {
      deps.logger.info(`Sent ${filename} (${result.value.sizeBytes} bytes)`);
      await deps.moveToSent(filePath);
      return;
    }

    lastError = { kind: result.error.kind, message: result.error.message };

    if (result.error.kind !== "delivery") break;
    if (!isTransient(result.error.cause)) break;
  }

  deps.logger.error(`Failed to process ${filename}: ${lastError?.message ?? "unknown"}`);
  await deps.moveToError(
    filePath,
    lastError?.kind ?? "unknown",
    lastError?.message ?? "Unknown error",
  );
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
  let rawContent: string;
  try {
    rawContent = await deps.readFile(filePath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown read error";
    deps.logger.warn(`Could not read ${filename}: ${message}`);
    return;
  }

  // Step 2: Validate not empty
  if (rawContent.length === 0) {
    deps.logger.error(`File ${filename} is empty`);
    await deps.moveToError(filePath, "validation", `File '${filename}' is empty`);
    return;
  }

  // Step 3: Parse frontmatter
  const parseResult = deps.frontmatterParser.parse(rawContent);
  if (!parseResult.ok) {
    deps.logger.error(`File ${filename}: ${parseResult.error.message}`);
    await deps.moveToError(filePath, "frontmatter", parseResult.error.message);
    return;
  }
  const { metadata, body } = parseResult.value;

  // Step 4: Create MarkdownContent from stripped body (validates size)
  const contentResult = MarkdownContent.create(body);
  if (!contentResult.ok) {
    deps.logger.error(`File ${filename}: ${contentResult.error.message}`);
    await deps.moveToError(filePath, contentResult.error.kind, contentResult.error.message);
    return;
  }

  // Step 5: Resolve title from multiple sources
  // Priority: frontmatter title → H1 from body → filename stem
  const h1Text = findFirstH1(body);
  const filenameStem = filename.replace(/\.md$/i, "");
  const titleCandidates = [metadata.title, h1Text, filenameStem];

  const titleResult = resolveTitle(titleCandidates);
  if (!titleResult.ok) {
    deps.logger.error(`File ${filename}: title resolution failed — ${titleResult.error.message}`);
    await deps.moveToError(filePath, "validation", titleResult.error.message);
    return;
  }

  // Step 6: Resolve device (use default)
  const deviceResult = deps.devices.resolve();
  if (!deviceResult.ok) {
    deps.logger.error(`No device configured: ${deviceResult.error.message}`);
    await deps.moveToError(filePath, "validation", deviceResult.error.message);
    return;
  }

  // Step 7: Send with retry for transient failures
  const document = MarkdownDocument.fromParts(contentResult.value, metadata);
  await sendWithRetry(
    filename,
    filePath,
    () => deps.service.execute(titleResult.value, document, deps.defaultAuthor, deviceResult.value),
    deps,
  );
}

/**
 * Orchestrates the EPUB passthrough pipeline for a single watched EPUB file.
 *
 * Implements PB-012: read EPUB → resolve title from metadata → resolve device → send with retry → move.
 *
 * Retry policy mirrors processFile(): transient SMTP connection errors are retried up to MAX_RETRIES.
 */
export async function processEpubFile(
  filePath: string,
  deps: WatcherDeps,
): Promise<void> {
  const filename = basename(filePath);

  // Step 1: Read EPUB file
  let epubResult: EpubReadResult;
  try {
    epubResult = await deps.readEpubFile(filePath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown read error";
    deps.logger.warn(`Could not read ${filename}: ${message}`);
    return;
  }

  // Step 2: Resolve title (metadata or filename stem — always resolves)
  const titleResult = resolveTitle([epubResult.suggestedTitle]);
  if (!titleResult.ok) {
    deps.logger.error(`File ${filename}: title resolution failed — ${titleResult.error.message}`);
    await deps.moveToError(filePath, "validation", titleResult.error.message);
    return;
  }

  // Step 3: Resolve device (use default)
  const deviceResult = deps.devices.resolve();
  if (!deviceResult.ok) {
    deps.logger.error(`No device configured: ${deviceResult.error.message}`);
    await deps.moveToError(filePath, "validation", deviceResult.error.message);
    return;
  }

  // Step 4: Send with retry for transient failures
  const epub = new EpubDocument(titleResult.value.value, epubResult.buffer);
  await sendWithRetry(
    filename,
    filePath,
    () => deps.service.sendEpub(epub, deviceResult.value),
    deps,
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
      if (next.toLowerCase().endsWith(".epub")) {
        await processEpubFile(next, wrappedDeps);
      } else {
        await processFile(next, wrappedDeps);
      }
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

  const existingMd = await deps.listFiles(deps.watchFolder, ".md");
  const existingEpub = await deps.listFiles(deps.watchFolder, ".epub");
  for (const file of [...existingMd, ...existingEpub]) {
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
