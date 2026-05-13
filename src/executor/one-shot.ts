import { validateMcpConfigPath } from '../security/path-allow-list.js';
import { collectTurn, readStreamJson } from './stream.js';
import {
  buildClaudeCodeArgs,
  enforceBypassPolicy,
  spawnClaudeCode,
} from './spawner.js';
import type { BridgeConfig } from '../config.js';
import type { ExecuteInput, ExecuteResult } from '../types.js';
import type { Logger } from '../log.js';
import type { ProgressReporter } from '../progress.js';

export async function executeOneShot(
  input: ExecuteInput,
  config: BridgeConfig,
  log: Logger,
  reporter?: ProgressReporter,
): Promise<ExecuteResult> {
  const start = Date.now();

  const permissionMode = enforceBypassPolicy(
    input.permissionMode,
    config.allowBypass,
  );

  let mcpConfigPath: string | undefined;
  if (input.mcpConfigPath !== undefined) {
    mcpConfigPath = await validateMcpConfigPath(
      input.mcpConfigPath,
      config.configAllowedDirs,
    );
  }

  const args = buildClaudeCodeArgs({
    mcpConfigPath,
    permissionMode,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    persistent: false,
    oneShotPrompt: input.prompt,
  });

  const timeoutMs = input.timeoutSeconds
    ? input.timeoutSeconds * 1000
    : config.executeTimeoutMs;

  log.debug(`spawning claude one-shot: ${config.claudeCodePath} ${args.length} args`);
  reporter?.report('spawning claude code subprocess');

  const child = spawnClaudeCode({
    config,
    args,
    cwd: input.cwd ?? config.defaultCwd,
  });

  // Claude Code's --print mode waits for stdin to close before producing output.
  child.stdin.end();

  // Stderr is read-only for debug. We never echo it to MCP callers, because it
  // is not part of the protocol and frequently contains diagnostic noise.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    log.debug(`stderr: ${chunk.trimEnd()}`);
  });

  const ac = new AbortController();
  const timer = setTimeout(() => {
    log.warn(`one-shot execute timed out after ${timeoutMs}ms; killing subprocess`);
    ac.abort();
    child.kill('SIGTERM');
    // Hard backstop: SIGKILL if SIGTERM isn't honored within 5s.
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000).unref();
  }, timeoutMs);
  timer.unref();

  let collected: Awaited<ReturnType<typeof collectTurn>>;
  try {
    const iterator = readStreamJson(child.stdout)[Symbol.asyncIterator]();
    collected = await collectTurn(iterator, ac.signal, reporter);
  } finally {
    clearTimeout(timer);
  }

  // Wait for process to actually exit so we can read exit code.
  const exitCode: number | null = await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('close', (code) => resolve(code ?? null));
  });

  const aborted = ac.signal.aborted;
  const isError =
    aborted ||
    collected.isError ||
    (exitCode !== null && exitCode !== 0);

  const claudeSessionId =
    (collected.systemInit as { session_id?: unknown } | null)?.session_id ?? null;

  return {
    text: collected.text || null,
    claudeSessionId: typeof claudeSessionId === 'string' ? claudeSessionId : null,
    durationMs: Date.now() - start,
    chunkCount: collected.chunkCount,
    isError,
    errorMessage: isError
      ? aborted
        ? `Timed out after ${timeoutMs}ms`
        : exitCode !== null && exitCode !== 0
          ? `Claude Code exited with code ${exitCode}`
          : 'Claude Code reported an error'
      : undefined,
  };
}
