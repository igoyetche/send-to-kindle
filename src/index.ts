import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./infrastructure/config.js";
import { createPinoLogger, createDeliveryLogger } from "./infrastructure/logger.js";
import { MarkdownEpubConverter } from "./infrastructure/converter/markdown-epub-converter.js";
import { SmtpMailer } from "./infrastructure/mailer/smtp-mailer.js";
import { SendToKindleService } from "./domain/send-to-kindle-service.js";
import { ToolHandler } from "./application/tool-handler.js";

const config = loadConfig();
const pinoLogger = createPinoLogger(config.logLevel);
const deliveryLogger = createDeliveryLogger(pinoLogger);

const converter = new MarkdownEpubConverter();
const mailer = new SmtpMailer({
  kindle: config.kindle,
  sender: config.sender,
  smtp: config.smtp,
});
const service = new SendToKindleService(converter, mailer, deliveryLogger);
const toolHandler = new ToolHandler(service, config.defaultAuthor);

const server = new McpServer({
  name: "send-to-kindle",
  version: "1.0.0",
});

server.tool(
  "send_to_kindle",
  "Convert Markdown content to EPUB and send it to a Kindle device via email. " +
    "Accepts a title, markdown content, and optional author name.",
  {
    title: z.string().describe("Document title that will appear in the Kindle library"),
    content: z.string().describe("Document content in Markdown format"),
    author: z
      .string()
      .optional()
      .describe("Author name for document metadata (defaults to configured value)"),
  },
  async (args) => toolHandler.handle(args),
);

// stdio transport (always active)
const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

pinoLogger.info("Send to Kindle MCP server started (stdio)");

// HTTP/SSE transport (if configured)
if (config.http) {
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const app = express();
  app.use(express.json());

  // Bearer token auth middleware
  app.use("/mcp", (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${config.http!.authToken}`) {
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
      name: "send-to-kindle",
      version: "1.0.0",
    });

    httpServer.tool(
      "send_to_kindle",
      "Convert Markdown content to EPUB and send it to a Kindle device via email.",
      {
        title: z.string().describe("Document title"),
        content: z.string().describe("Document content in Markdown format"),
        author: z.string().optional().describe("Author name"),
      },
      async (args) => toolHandler.handle(args),
    );

    await httpServer.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => { res.status(405).end(); });
  app.delete("/mcp", (_req, res) => { res.status(405).end(); });

  app.listen(config.http.port, () => {
    pinoLogger.info(
      { port: config.http!.port },
      "Send to Kindle MCP server started (HTTP)",
    );
  });
}
