import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Logger } from './log.js';

/**
 * MCP progress reporter for long-running tool calls.
 *
 * MCP hosts impose a per-tool-call timeout at the transport layer. For
 * `execute` / `session_*` calls that delegate to Claude Code subprocesses,
 * the work can easily exceed that ceiling. The protocol's answer is
 * `notifications/progress` — server→client notifications that hosts which
 * honor them (Anthropic Desktop, Cursor, etc.) use to reset their timeout.
 *
 * Lifecycle:
 *   - constructed at the start of a tool call from req.params._meta.progressToken
 *   - .report(msg) is called for each meaningful chunk arriving from Claude Code
 *   - a heartbeat re-emits the last message after `heartbeatMs` of silence,
 *     so a long "thinking" pause without chunks doesn't go quiet on the wire
 *   - .stop() is called from the request handler's finally block
 *
 * If the client did not include a progressToken (i.e. didn't opt in), the
 * factory returns a no-op reporter and no notifications are sent.
 */
export interface ProgressReporter {
  report(message: string): void;
  stop(): void;
}

const NOOP_REPORTER: ProgressReporter = {
  report: () => {
    /* no-op */
  },
  stop: () => {
    /* no-op */
  },
};

/**
 * Token type per the MCP spec: a string or number identifying which request
 * the progress applies to.
 */
export type ProgressToken = string | number;

export interface MakeProgressReporterOptions {
  server: Server;
  progressToken: ProgressToken | undefined;
  logger: Logger;
  /** Heartbeat interval in milliseconds. Default 15000. */
  heartbeatMs?: number;
}

export function makeProgressReporter(
  opts: MakeProgressReporterOptions,
): ProgressReporter {
  const { server, progressToken, logger } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  if (progressToken === undefined || progressToken === null) {
    return NOOP_REPORTER;
  }

  let counter = 0;
  let lastMessage = 'working';
  let heartbeat: NodeJS.Timeout | null = null;
  let stopped = false;

  const send = (message: string): void => {
    if (stopped) return;
    counter += 1;
    // Fire-and-forget: notification() is async but we don't gate the work on it,
    // and any send error gets logged rather than crashing the call.
    server
      .notification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: counter,
          message,
        },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`progress notification failed: ${msg}`);
      });
  };

  const resetHeartbeat = (): void => {
    if (heartbeat !== null) clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      send(lastMessage);
      resetHeartbeat();
    }, heartbeatMs);
    heartbeat.unref();
  };

  resetHeartbeat();

  return {
    report(message: string): void {
      if (stopped) return;
      lastMessage = message;
      send(message);
      // Debounce: only fire heartbeats when no real chunks have arrived recently.
      resetHeartbeat();
    },
    stop(): void {
      stopped = true;
      if (heartbeat !== null) {
        clearTimeout(heartbeat);
        heartbeat = null;
      }
    },
  };
}
