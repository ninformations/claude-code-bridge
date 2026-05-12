import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { McpConfigFileSchema } from '../types.js';

/**
 * Validate that a caller-supplied `mcpConfigPath` is safe to hand to Claude Code.
 *
 * Rules, all must pass:
 *   1. Path must be absolute. (Relative paths are ambiguous and reject.)
 *   2. After resolution there must be no parent-traversal that escapes its base.
 *   3. The resolved path must be inside at least one of the configured allow-dirs.
 *   4. The file must exist and be a regular file (not a symlink to elsewhere
 *      we did not allow, not a device, not a directory).
 *   5. The file contents must parse as JSON matching the minimal MCP shape.
 *
 * Returns the canonical absolute path on success; throws a descriptive
 * error otherwise. Error messages are safe to surface to callers — they
 * do not leak the contents of allow-list directories or env vars.
 */
export async function validateMcpConfigPath(
  rawPath: string,
  allowedDirs: readonly string[],
): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('mcpConfigPath must be a non-empty string');
  }
  if (!path.isAbsolute(rawPath)) {
    throw new Error('mcpConfigPath must be an absolute path');
  }
  if (allowedDirs.length === 0) {
    throw new Error(
      'No mcp_config_path directories are configured on this bridge; ' +
        'set CLAUDE_BRIDGE_CONFIG_DIRS or rely on $HOME (default).',
    );
  }

  // Resolve symlinks via realpath so a symlink trick can't escape the allow-list.
  // realpath() also rejects nonexistent files, which is what we want.
  let realPath: string;
  try {
    realPath = await fs.realpath(rawPath);
  } catch {
    throw new Error('mcpConfigPath does not exist or is not readable');
  }

  // Belt-and-suspenders: re-resolve to remove any residual `..` and confirm
  // the realpath is still anchored under an allowed dir, comparing canonical
  // forms of both sides.
  const canonical = path.resolve(realPath);
  const insideAllowed = allowedDirs.some((dirRaw) => {
    const dir = path.resolve(dirRaw);
    const rel = path.relative(dir, canonical);
    return (
      rel === '' ||
      (!rel.startsWith('..') && !path.isAbsolute(rel))
    );
  });
  if (!insideAllowed) {
    throw new Error(
      'mcpConfigPath is not inside any allowed directory ' +
        '(see CLAUDE_BRIDGE_CONFIG_DIRS)',
    );
  }

  const stat = await fs.stat(canonical);
  if (!stat.isFile()) {
    throw new Error('mcpConfigPath must point to a regular file');
  }
  // Reject obviously-too-large files — MCP configs are typically <10KB.
  if (stat.size > 1_000_000) {
    throw new Error('mcpConfigPath is larger than 1MB; refusing to load');
  }

  let parsed: unknown;
  try {
    const raw = await fs.readFile(canonical, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('mcpConfigPath could not be parsed as JSON');
  }

  const validation = McpConfigFileSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      'mcpConfigPath does not match the expected { mcpServers: {...} } shape',
    );
  }

  return canonical;
}
