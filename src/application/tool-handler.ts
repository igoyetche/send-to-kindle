import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import type { DeviceRegistry } from "../domain/device-registry.js";
import type { FrontmatterParser } from "../domain/ports.js";
import { Author, MarkdownContent, MarkdownDocument } from "../domain/values/index.js";
import type { DomainError } from "../domain/errors.js";
import { resolveTitle } from "../domain/title-resolver.js";

// MCP SDK response type
interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function mapErrorToResponse(error: DomainError): McpToolResponse {
  let errorCode: string;
  switch (error.kind) {
    case "validation":
      errorCode = "VALIDATION_ERROR";
      break;
    case "size_limit":
      errorCode = "SIZE_ERROR";
      break;
    case "frontmatter":
      errorCode = "FRONTMATTER_ERROR";
      break;
    case "conversion":
      errorCode = "CONVERSION_ERROR";
      break;
    case "delivery":
      errorCode = "SMTP_ERROR";
      break;
    default: {
      const _exhaustive: never = error;
      errorCode = "UNKNOWN_ERROR";
      break;
    }
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          error: errorCode,
          details: error.message,
        }),
      },
    ],
    isError: true,
  };
}

/** Implements FR-3: MCP adapter that resolves device via DeviceRegistry before invoking service */
export class ToolHandler {
  constructor(
    private readonly service: Pick<SendToKindleService, "execute">,
    private readonly defaultAuthor: string,
    private readonly devices: DeviceRegistry,
    private readonly frontmatterParser: FrontmatterParser,
  ) {}

  async handle(args: {
    title?: string;
    content: string;
    author?: string;
    device?: string;
  }): Promise<McpToolResponse> {
    // Step 1: Resolve device first
    const deviceResult = this.devices.resolve(args.device);
    if (!deviceResult.ok) return mapErrorToResponse(deviceResult.error);

    // Step 2: Parse frontmatter
    const parseResult = this.frontmatterParser.parse(args.content);
    if (!parseResult.ok) return mapErrorToResponse(parseResult.error);
    const { metadata, body } = parseResult.value;

    // Step 3: Create MarkdownContent from stripped body
    const contentResult = MarkdownContent.create(body);
    if (!contentResult.ok) return mapErrorToResponse(contentResult.error);

    // Step 4: Resolve title from [explicit arg, metadata, or error]
    // Note: MCP has no filename fallback, so unresolvable is an error
    const titleCandidates = [args.title || undefined, metadata.title];
    const titleResult = resolveTitle(titleCandidates);
    if (!titleResult.ok) return mapErrorToResponse(titleResult.error);

    // Step 5: Create author
    const authorRaw = args.author?.trim() || this.defaultAuthor;
    const authorResult = Author.create(authorRaw);
    if (!authorResult.ok) return mapErrorToResponse(authorResult.error);

    // Step 6: Build document and execute service
    const document = MarkdownDocument.fromParts(contentResult.value, metadata);
    const result = await this.service.execute(
      titleResult.value,
      document,
      authorResult.value,
      deviceResult.value,
    );

    if (!result.ok) return mapErrorToResponse(result.error);

    const responseData: {
      success: boolean;
      message: string;
      sizeBytes: number;
      imageStats?: {
        total: number;
        downloaded: number;
        failed: number;
        skipped: number;
      };
    } = {
      success: true,
      message: `Document '${result.value.title}' sent to Kindle (${result.value.deviceName}) successfully.`,
      sizeBytes: result.value.sizeBytes,
    };

    if (result.value.imageStats) {
      responseData.imageStats = result.value.imageStats;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(responseData),
        },
      ],
    };
  }
}
