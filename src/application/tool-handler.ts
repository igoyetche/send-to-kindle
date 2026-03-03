import type { SendToKindleService } from "../domain/send-to-kindle-service.js";
import { Title, Author, MarkdownContent } from "../domain/values/index.js";
import type { DomainError } from "../domain/errors.js";

interface McpToolResponse {
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
    case "conversion":
      errorCode = "CONVERSION_ERROR";
      break;
    case "delivery":
      errorCode = "SMTP_ERROR";
      break;
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

export class ToolHandler {
  constructor(
    private readonly service: SendToKindleService,
    private readonly defaultAuthor: string,
  ) {}

  async handle(args: {
    title: string;
    content: string;
    author?: string;
  }): Promise<McpToolResponse> {
    // Construct value objects
    const titleResult = Title.create(args.title);
    if (!titleResult.ok) return mapErrorToResponse(titleResult.error);

    const contentResult = MarkdownContent.create(args.content);
    if (!contentResult.ok) return mapErrorToResponse(contentResult.error);

    const authorRaw = args.author?.trim() || this.defaultAuthor;
    const authorResult = Author.create(authorRaw);
    if (!authorResult.ok) return mapErrorToResponse(authorResult.error);

    // Execute domain service
    const result = await this.service.execute(
      titleResult.value,
      contentResult.value,
      authorResult.value,
    );

    if (!result.ok) return mapErrorToResponse(result.error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Document '${result.value.title}' sent to Kindle successfully.`,
            sizeBytes: result.value.sizeBytes,
          }),
        },
      ],
    };
  }
}
