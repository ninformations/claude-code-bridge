import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';
import {
  ExecuteInputSchema,
  SessionIdInputSchema,
  SessionSendInputSchema,
  SessionStartInputSchema,
} from './types.js';
import type { BridgeConfig } from './config.js';
import type { Logger } from './log.js';
import type { SessionManager } from './executor/session-manager.js';
import { executeOneShot } from './executor/one-shot.js';

/**
 * MCP tool descriptor + handler pair.
 */
export interface ToolDef<I> {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  parse: (raw: unknown) => I;
  handle: (input: I) => Promise<{ text: string; isError?: boolean }>;
}

function describe<T extends z.ZodTypeAny>(schema: T) {
  // The MCP SDK wants a JSONSchema-shaped object for inputSchema.
  return zodToJsonSchema(schema, { $refStrategy: 'none' });
}

function parser<T extends z.ZodTypeAny>(
  schema: T,
): (raw: unknown) => z.infer<T> {
  return (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join('.') || '(root)';
      throw new Error(`Invalid input at ${where}: ${issue?.message ?? 'unknown'}`);
    }
    return parsed.data;
  };
}

export function buildTools(
  config: BridgeConfig,
  log: Logger,
  sessions: SessionManager,
): ToolDef<unknown>[] {
  const tools: ToolDef<unknown>[] = [];

  tools.push({
    name: 'execute',
    description:
      'Run a single Claude Code task to completion and return the final ' +
      'assistant text. Use this for one-shot work that does not need ' +
      'follow-up clarifying questions. For interactive Q&A, prefer the ' +
      'session_* tools.',
    inputSchema: describe(ExecuteInputSchema),
    parse: parser(ExecuteInputSchema) as (raw: unknown) => unknown,
    handle: async (raw) => {
      const input = raw as z.infer<typeof ExecuteInputSchema>;
      const result = await executeOneShot(input, config, log);
      const summary = JSON.stringify(
        {
          text: result.text,
          claudeSessionId: result.claudeSessionId,
          durationMs: result.durationMs,
          chunkCount: result.chunkCount,
          isError: result.isError,
          errorMessage: result.errorMessage,
        },
        null,
        2,
      );
      return { text: summary, isError: result.isError };
    },
  });

  tools.push({
    name: 'session_start',
    description:
      'Start a persistent Claude Code session. Returns a bridgeSessionId ' +
      'plus the assistant text from the initial turn. The session stays ' +
      'alive across multiple send/receive cycles until session_end is ' +
      'called, the idle timeout elapses, or the bridge hits its max ' +
      'session lifetime.',
    inputSchema: describe(SessionStartInputSchema),
    parse: parser(SessionStartInputSchema) as (raw: unknown) => unknown,
    handle: async (raw) => {
      const input = raw as z.infer<typeof SessionStartInputSchema>;
      const { session, initialText } = await sessions.start(input);
      return {
        text: JSON.stringify(
          {
            session,
            initialText,
          },
          null,
          2,
        ),
        isError: session.status === 'errored',
      };
    },
  });

  tools.push({
    name: 'session_send',
    description:
      'Send a follow-up user message to an existing session and wait for ' +
      'the assistant turn to complete. Returns the assistant text for that ' +
      'turn only. The session remains open for further send_* calls.',
    inputSchema: describe(SessionSendInputSchema),
    parse: parser(SessionSendInputSchema) as (raw: unknown) => unknown,
    handle: async (raw) => {
      const input = raw as z.infer<typeof SessionSendInputSchema>;
      const { session, text } = await sessions.send(input.sessionId, input.message);
      return {
        text: JSON.stringify({ session, text }, null, 2),
        isError: session.status === 'errored',
      };
    },
  });

  tools.push({
    name: 'session_end',
    description:
      'Close a persistent session and free its subprocess. Returns the ' +
      'final session record. Safe to call on an already-closed session ' +
      'only if you keep the id; otherwise expect an error.',
    inputSchema: describe(SessionIdInputSchema),
    parse: parser(SessionIdInputSchema) as (raw: unknown) => unknown,
    handle: async (raw) => {
      const input = raw as z.infer<typeof SessionIdInputSchema>;
      const session = await sessions.end(input.sessionId);
      return { text: JSON.stringify({ session }, null, 2) };
    },
  });

  tools.push({
    name: 'session_get',
    description:
      'Look up the current status of one session by its bridgeSessionId.',
    inputSchema: describe(SessionIdInputSchema),
    parse: parser(SessionIdInputSchema) as (raw: unknown) => unknown,
    handle: async (raw) => {
      const input = raw as z.infer<typeof SessionIdInputSchema>;
      const session = sessions.get(input.sessionId);
      if (session === null) {
        return {
          text: JSON.stringify({ session: null }, null, 2),
          isError: true,
        };
      }
      return { text: JSON.stringify({ session }, null, 2) };
    },
  });

  tools.push({
    name: 'session_list',
    description:
      'List all sessions currently held open by this bridge instance, ' +
      'including their status and ages.',
    inputSchema: describe(z.object({})),
    parse: parser(z.object({})) as (raw: unknown) => unknown,
    handle: async () => {
      const list = sessions.list();
      return { text: JSON.stringify({ sessions: list }, null, 2) };
    },
  });

  return tools;
}
