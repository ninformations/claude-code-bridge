/**
 * Build the environment passed to spawned Claude Code subprocesses.
 *
 * Default behavior: whitelist-only. We pass through a small set of vars
 * the subprocess legitimately needs, plus anything the operator has
 * explicitly opted into via CLAUDE_BRIDGE_PASSTHROUGH_ENV. Everything
 * else — including the bridge's own configuration vars and any secrets
 * loaded into the bridge's process environment — is dropped.
 *
 * Rationale: if the MCP host (Claude Desktop, Cowork, etc.) has database
 * credentials, API keys, or session tokens in its env, we do NOT want
 * those silently inherited by a subprocess that an LLM is steering.
 */

/**
 * Variables we always pass through. These are well-known process-runtime
 * essentials with no secret content under normal conditions.
 */
const ALWAYS_PASSTHROUGH = new Set<string>([
  'PATH',
  'HOME',
  'USER',
  'USERNAME', // Windows
  'USERPROFILE', // Windows
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP', // Windows
  'TEMP', // Windows
  'SHELL',
  'PWD',
  'SYSTEMROOT', // Windows
  'COMSPEC', // Windows
  'APPDATA', // Windows
  'LOCALAPPDATA', // Windows
  'PROGRAMDATA', // Windows
  'PROGRAMFILES', // Windows
  'PROGRAMFILES(X86)', // Windows
]);

/**
 * Claude Code's documented CLAUDE_CODE_* env knobs. We pass these through
 * because Claude Code itself reads them. We intentionally do NOT pass any
 * generic `CLAUDE_*` (e.g. CLAUDE_BRIDGE_*) — those belong to the bridge.
 */
const CLAUDE_CODE_PREFIX = 'CLAUDE_CODE_';

/**
 * Pattern of var names that look secret-ish. Used only as belt-and-suspenders;
 * the primary protection is the whitelist itself, but if a future change
 * accidentally widens the whitelist we want one more line of defense.
 */
const SECRETY_NAME = /(?:token|secret|password|api[_-]?key|credential|auth)/i;

export interface BuildSubprocessEnvOptions {
  parentEnv: NodeJS.ProcessEnv;
  passthroughExtras: readonly string[];
}

export function buildSubprocessEnv(
  opts: BuildSubprocessEnvOptions,
): Record<string, string> {
  const { parentEnv, passthroughExtras } = opts;
  const allowedExtras = new Set(passthroughExtras);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;

    const allowed =
      ALWAYS_PASSTHROUGH.has(key) ||
      key.startsWith(CLAUDE_CODE_PREFIX) ||
      allowedExtras.has(key);

    if (!allowed) continue;

    // Belt-and-suspenders: even if explicitly allow-listed, if the variable
    // name looks like a secret AND wasn't an extra opt-in, drop it. This
    // prevents an accidental future "CLAUDE_CODE_API_TOKEN" from leaking
    // without explicit operator decision.
    if (
      !allowedExtras.has(key) &&
      SECRETY_NAME.test(key) &&
      !ALWAYS_PASSTHROUGH.has(key)
    ) {
      continue;
    }

    out[key] = value;
  }

  return out;
}
