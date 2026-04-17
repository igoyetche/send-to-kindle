import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger, createImageProcessorLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { ImageProcessor } from "./infrastructure/converter/image-processor.js";
import { CoverGenerator } from "./infrastructure/converter/cover-generator.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { ToolHandler } from "./application/tool-handler.js";
import { GrayMatterFrontmatterParser } from "./infrastructure/frontmatter/gray-matter-parser.js";

const config = loadConfig();
const pinoLogger = createPinoLogger(config.logLevel);
const deliveryLogger = createDeliveryLogger(pinoLogger);
const imageProcessorLogger = createImageProcessorLogger(pinoLogger);

const imageProcessor = new ImageProcessor(config.image, imageProcessorLogger);
const coverGenerator = new CoverGenerator();
const converter = new MarkdownEpubConverter(imageProcessor, coverGenerator);
const mailer = new SmtpMailer({
  sender: config.sender,
  smtp: config.smtp,
});
const service = new SendToKindleService(converter, mailer, deliveryLogger);
const frontmatterParser = new GrayMatterFrontmatterParser();
const toolHandler = new ToolHandler(service, config.defaultAuthor, config.devices, frontmatterParser);

function registerTools(s: McpServer, handler: ToolHandler): void {
  s.registerTool(
    "send_to_kindle",
    {
      description:
        "Convert Markdown content to EPUB and send it to a Kindle device via email. " +
        "Title can be provided via --title parameter, frontmatter 'title' field, or will error if unresolvable. " +
        "Content should be Markdown with optional YAML frontmatter (---\\ntitle: ...\\nurl: ...\\ndate: ...\\n---)",
      inputSchema: {
        title: z
          .string()
          .optional()
          .describe(
            "Document title (optional). If omitted, resolved from: (1) YAML frontmatter 'title' field, or (2) hard error if unresolvable.",
          ),
        content: z.string().describe("Document content in Markdown format with optional YAML frontmatter"),
        author: z
          .string()
          .optional()
          .describe("Author name for document metadata (defaults to configured value)"),
        device: z
          .string()
          .optional()
          .describe("Name of the Kindle device to send to. Omit to use the default device."),
      },
    },
    async (args) => handler.handle(args),
  );
}

const server = new McpServer({
  name: "paperboy",
  version: "1.0.0",
});

registerTools(server, toolHandler);

// stdio transport (always active)
const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

pinoLogger.info("Paperboy MCP server started (stdio)");

// HTTP/SSE transport (if configured)
if (config.http) {
  const httpConfig = config.http;
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const app = express();
  app.use(express.json());

  // Bearer token auth middleware
  app.use("/mcp", (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${httpConfig.authToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const httpServer = new McpServer({
      name: "paperboy",
      version: "1.0.0",
    });

    registerTools(httpServer, toolHandler);

    await httpServer.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => { res.status(405).end(); });
  app.delete("/mcp", (_req, res) => { res.status(405).end(); });

  app.listen(httpConfig.port, () => {
    pinoLogger.info(
      { port: httpConfig.port, url: `http://localhost:${httpConfig.port}/mcp` },
      "Paperboy MCP server started (HTTP)",
    );
  });
}
