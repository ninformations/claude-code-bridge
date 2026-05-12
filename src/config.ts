import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Bridge configuration, derived entirely from environment variables.
 *
 * All callers should resolve config exactly once at startup and pass the
 * resulting object down — never read process.env from inside business logic,
 * so tests can construct alternate configs without env juggling.
 */
export interface BridgeConfig {
  /** Path to the Claude Code CLI binary. */
  claudeCodePath: string;
  /** Absolute, resolved directories from which mcp_config_path is allowed to be read. */
  configAllowedDirs: string[];
  /** Default working directory for spawned subprocesses. Undefined → fresh tempdir per call. */
  defaultCwd: string | undefined;
  /** Whether `permissionMode=bypassPermissions` is permitted at all. */
  allowBypass: boolean;
  /** Idle timeout (ms) for persistent sessions. */
  sessionIdleTimeoutMs: number;
  /** Hard maximum lifetime (ms) for persistent sessions. */
  sessionMaxLifetimeMs: number;
  /** Per-call timeout (ms) for one-shot execute. */
  executeTimeoutMs: number;
  /** Verbose debug logging on stderr (redacted). */
  debug: boolean;
  /** Extra env var names to pass through to spawned subprocesses. */
  passthroughEnv: string[];
}

function parsePositiveInt(
  raw: string | undefined,
  fallbackSeconds: number,
): number {
  if (raw === undefined || raw === '') return fallbackSeconds * 1000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallbackSeconds * 1000;
  return n * 1000;
}

function parseBool(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseDirList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => path.resolve(s));
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const homeDir = os.homedir();
  const configuredDirs = parseDirList(env.CLAUDE_BRIDGE_CONFIG_DIRS);
  const configAllowedDirs =
    configuredDirs.length > 0 ? configuredDirs : [path.resolve(homeDir)];

  return {
    claudeCodePath: env.CLAUDE_CODE_PATH?.trim() || 'claude',
    configAllowedDirs,
    defaultCwd: env.CLAUDE_BRIDGE_DEFAULT_CWD?.trim() || undefined,
    allowBypass: parseBool(env.CLAUDE_BRIDGE_ALLOW_BYPASS),
    sessionIdleTimeoutMs: parsePositiveInt(
      env.CLAUDE_BRIDGE_SESSION_IDLE_TIMEOUT,
      300,
    ),
    sessionMaxLifetimeMs: parsePositiveInt(
      env.CLAUDE_BRIDGE_SESSION_MAX_LIFETIME,
      3600,
    ),
    executeTimeoutMs: parsePositiveInt(env.CLAUDE_BRIDGE_EXECUTE_TIMEOUT, 300),
    debug: parseBool(env.CLAUDE_BRIDGE_DEBUG),
    passthroughEnv: parseCsv(env.CLAUDE_BRIDGE_PASSTHROUGH_ENV),
  };
}
