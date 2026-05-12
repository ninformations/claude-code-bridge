import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildSubprocessEnv } from '../security/env-scrub.js';
import type { BridgeConfig } from '../config.js';
import type { PermissionMode } from '../types.js';

export interface BuildArgsInput {
  /** Path to MCP config, already validated. Undefined → no --mcp-config. */
  mcpConfigPath: string | undefined;
  permissionMode: PermissionMode | undefined;
  allowedTools: readonly string[] | undefined;
  disallowedTools: readonly string[] | undefined;
  /** If true, expect an interactive turn-by-turn stream on stdin. */
  persistent: boolean;
  /** Only used when persistent=false. Prompt becomes the trailing positional arg. */
  oneShotPrompt: string | undefined;
}

/**
 * Build the argv passed to the Claude Code CLI.
 *
 * Returns an array. Always pass this to spawn() with shell:false; never join
 * it into a string or feed it through a shell.
 */
export function buildClaudeCodeArgs(input: BuildArgsInput): string[] {
  const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json'];

  if (input.persistent) {
    args.push('--input-format', 'stream-json');
  }

  if (input.mcpConfigPath) {
    args.push('--mcp-config', input.mcpConfigPath);
  }

  if (input.permissionMode) {
    args.push('--permission-mode', input.permissionMode);
  }

  if (input.allowedTools && input.allowedTools.length > 0) {
    args.push('--allowed-tools', input.allowedTools.join(','));
  }
  if (input.disallowedTools && input.disallowedTools.length > 0) {
    args.push('--disallowed-tools', input.disallowedTools.join(','));
  }

  if (!input.persistent) {
    if (input.oneShotPrompt === undefined) {
      throw new Error('One-shot spawn requires a prompt');
    }
    // `--` ensures the prompt is never interpreted as a flag, even if it starts with -.
    args.push('--', input.oneShotPrompt);
  }

  return args;
}

export interface SpawnOptions {
  config: BridgeConfig;
  args: string[];
  cwd: string | undefined;
}

/**
 * Spawn a Claude Code subprocess with sandboxed environment, no shell, and
 * piped stdio. Caller is responsible for managing lifetime and cleanup.
 */
export function spawnClaudeCode(
  opts: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const env = buildSubprocessEnv({
    parentEnv: process.env,
    passthroughExtras: opts.config.passthroughEnv,
  });

  const child = spawn(opts.config.claudeCodePath, opts.args, {
    cwd: opts.cwd,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Allow the parent to exit cleanly even if a child somehow hangs.
    detached: false,
  });

  return child;
}

/**
 * Resolve `bypassPermissions` against the bridge policy.
 *
 * Returns the input mode if allowed, throws otherwise.
 */
export function enforceBypassPolicy(
  mode: PermissionMode | undefined,
  allowBypass: boolean,
): PermissionMode | undefined {
  if (mode !== 'bypassPermissions') return mode;
  if (!allowBypass) {
    throw new Error(
      'permissionMode=bypassPermissions is disabled on this bridge. ' +
        'Set CLAUDE_BRIDGE_ALLOW_BYPASS=1 to enable, after reviewing the ' +
        'security implications: spawned subprocesses will run filesystem ' +
        'and shell tools with no per-action approval.',
    );
  }
  return mode;
}
