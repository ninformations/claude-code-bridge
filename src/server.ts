import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { BridgeConfig } from './config.js';
import type { Logger } from './log.js';
import { SessionManager } from './executor/session-manager.js';
import { buildTools } from './tools.js';
import { makeProgressReporter, type ProgressToken } from './progress.js';

const NAME = 'claude-code-bridge';
const VERSION = '0.2.0';

export interface ServerHandles {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Construct and wire up the MCP server. Does not start the transport — call
 * .start() for that. Returned handles are also used by the entry point to
 * implement graceful shutdown.
 */
export function createServer(config: BridgeConfig, log: Logger): ServerHandles {
  const sessions = new SessionManager(config, log);
  const tools = buildTools(config, log, sessions);

  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = tools.find((x) => x.name === req.params.name);
    if (!t) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      };
    }

    let input: unknown;
    try {
      input = t.parse(req.params.arguments ?? {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid arguments: ${msg}` }],
      };
    }

    // If the client opted into progress notifications by including
    // _meta.progressToken in the request, build a reporter so long-running
    // tool calls can periodically signal "still working" to keep the host's
    // per-call timeout from firing. Hosts that don't honor progress see
    // exactly the old behavior.
    const meta = (req.params as { _meta?: { progressToken?: ProgressToken } })
      ._meta;
    const reporter = makeProgressReporter({
      server,
      progressToken: meta?.progressToken,
      logger: log,
    });

    try {
      const out = await t.handle(input, reporter);
      return {
        ...(out.isError ? { isError: true } : {}),
        content: [{ type: 'text', text: out.text }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tool ${t.name} threw: ${msg}`);
      return {
        isError: true,
        content: [{ type: 'text', text: msg }],
      };
    } finally {
      reporter.stop();
    }
  });

  const transport = new StdioServerTransport();

  return {
    async start() {
      log.info(`${NAME} v${VERSION} starting on stdio`);
      await server.connect(transport);
      log.info(
        `ready. claudeCodePath=${config.claudeCodePath} ` +
          `allowedConfigDirs=${config.configAllowedDirs.length} ` +
          `allowBypass=${config.allowBypass}`,
      );
    },
    async shutdown() {
      log.info('shutting down');
      await sessions.shutdown();
      await server.close();
    },
  };
}
