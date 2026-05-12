import { z } from 'zod';
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
 * A subset of JSON Schema sufficient for advertising MCP tool inputs.
 * Hand-written here rather than generated from zod, to avoid pulling in
 * a third-party converter for what amounts to a few dozen lines of JSON.
 * Runtime validation still goes through the zod schemas in types.ts; this
 * shape is only the protocol-level "what arguments do you accept" hint.
 */
type JsonSchema = Record<string, unknown>;

/**
 * MCP tool descriptor + handler pair.
 */
export interface ToolDef<I> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  parse: (raw: unknown) => I;
  handle: (input: I) => Promise<{ text: string; isError?: boolean }>;
}

const PERMISSION_MODE_VALUES = ['plan', 'acceptEdits', 'default', 'bypassPermissions'] as const;

const COMMON_OPTIONAL_PROPS: JsonSchema = {
  mcpConfigPath: {
    type: 'string',
    description:
      'Absolute path to an { mcpServers: {...} } JSON file. Must be inside CLAUDE_BRIDGE_CONFIG_DIRS.',
  },
  permissionMode: {
    type: 'string',
    enum: [...PERMISSION_MODE_VALUES],
    description:
      'Permission policy for spawned tools. bypassPermissions is rejected unless CLAUDE_BRIDGE_ALLOW_BYPASS=1.',
  },
  allowedTools: {
    type: 'array',
    items: { type: 'string' },
    description: 'Allowlist of tool names to expose to Claude Code.',
  },
  disallowedTools: {
    type: 'array',
    items: { type: 'string' },
    description: 'Blocklist of tool names to hide from Claude Code.',
  },
  cwd: { type: 'string', description: 'Working directory for the subprocess.' },
};

const EXECUTE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, description: 'The task to execute.' },
    ...COMMON_OPTIONAL_PROPS,
    timeoutSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 3600,
      description: 'Per-call timeout, overrides CLAUDE_BRIDGE_EXECUTE_TIMEOUT.',
    },
  },
};

const SESSION_START_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['initialPrompt'],
  properties: {
    initialPrompt: { type: 'string', minLength: 1, description: 'First user message of the session.' },
    ...COMMON_OPTIONAL_PROPS,
  },
};

const SESSION_SEND_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'message'],
  properties: {
    sessionId: { type: 'string', format: 'uuid', description: 'bridgeSessionId from session_start.' },
    message: { type: 'string', minLength: 1, description: 'Next user message to send.' },
  },
};

const SESSION_ID_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId'],
  properties: {
    sessionId: { type: 'string', format: 'uuid', description: 'bridgeSessionId from session_start.' },
  },
};

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

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
    inputSchema: EXECUTE_SCHEMA,
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
    inputSchema: SESSION_START_SCHEMA,
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
    inputSchema: SESSION_SEND_SCHEMA,
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
    inputSchema: SESSION_ID_SCHEMA,
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
    inputSchema: SESSION_ID_SCHEMA,
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
    inputSchema: EMPTY_SCHEMA,
    parse: parser(z.object({})) as (raw: unknown) => unknown,
    handle: async () => {
      const list = sessions.list();
      return { text: JSON.stringify({ sessions: list }, null, 2) };
    },
  });

  return tools;
}
