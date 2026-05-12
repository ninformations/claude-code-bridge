import { z } from 'zod';

/**
 * Permission modes accepted by the bridge.
 *
 * `bypassPermissions` is parsed for compatibility but rejected at runtime
 * unless `CLAUDE_BRIDGE_ALLOW_BYPASS=1` is set in the bridge's environment.
 */
export const PermissionModeSchema = z.enum([
  'plan',
  'acceptEdits',
  'default',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Minimal schema for an MCP servers config file (the JSON the bridge will hand
 * to Claude Code via `--mcp-config`). We validate the top-level shape only;
 * Claude Code is the authority on per-server semantics.
 */
export const McpConfigFileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});
export type McpConfigFile = z.infer<typeof McpConfigFileSchema>;

/**
 * Input schema for the one-shot `execute` tool.
 */
export const ExecuteInputSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  mcpConfigPath: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  allowedTools: z.array(z.string()).max(200).optional(),
  disallowedTools: z.array(z.string()).max(200).optional(),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
  cwd: z.string().optional(),
});
export type ExecuteInput = z.infer<typeof ExecuteInputSchema>;

/**
 * Input schema for starting a persistent Q&A session.
 */
export const SessionStartInputSchema = z.object({
  initialPrompt: z.string().min(1).max(100_000),
  mcpConfigPath: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  allowedTools: z.array(z.string()).max(200).optional(),
  disallowedTools: z.array(z.string()).max(200).optional(),
  cwd: z.string().optional(),
});
export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;

export const SessionSendInputSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(100_000),
});
export type SessionSendInput = z.infer<typeof SessionSendInputSchema>;

export const SessionIdInputSchema = z.object({
  sessionId: z.string().uuid(),
});
export type SessionIdInput = z.infer<typeof SessionIdInputSchema>;

/**
 * One JSON line emitted by Claude Code under `--output-format stream-json`.
 * The full set of subtypes is broad; we only assert the discriminator field.
 */
export const StreamChunkSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

/**
 * Aggregated result returned to MCP callers for one-shot execution.
 */
export interface ExecuteResult {
  /** Final assistant text, or null if Claude Code never produced one. */
  text: string | null;
  /** Underlying Claude Code session id (distinct from bridge session id). */
  claudeSessionId: string | null;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Number of stream-json chunks observed. */
  chunkCount: number;
  /** True if Claude Code exited non-zero or reported an error chunk. */
  isError: boolean;
  /** Sanitized error message if isError is true. */
  errorMessage?: string;
}

/**
 * Bridge-side session record for persistent Q&A.
 *
 * NOTE: This is intentionally distinct from the `claudeSessionId` that Claude
 * Code emits in its `system.init` chunk. The bridge id is what callers use;
 * the Claude id is exposed via session_get for debugging.
 */
export interface BridgeSession {
  bridgeSessionId: string;
  claudeSessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  status: 'starting' | 'idle' | 'busy' | 'closed' | 'errored';
  errorMessage?: string;
}
