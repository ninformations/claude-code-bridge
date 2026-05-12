# claude-code-bridge

A small, hardened MCP server that bridges an MCP client (Claude Desktop, Cowork, Cursor, anything that speaks MCP) to the [Claude Code](https://docs.claude.com/claude-code) CLI. It supports both one-shot execution and persistent Q&A sessions over Claude Code's stream-json protocol, and ships with sandboxing, secret-aware logging, and tests.

This is a clean-room rewrite of the ferry pattern popularized by community wrappers, with the rough edges filed off: no hardcoded paths, no permission-bypass by default, no temp files committed to the repo, no shell-quoted command construction.

## Why use it

If your MCP client is good at planning and your terminal Claude Code is good at coding, this bridge lets one drive the other:

- **One-shot delegation** — your client tool plans, then calls `execute` with a self-contained prompt; Claude Code runs to completion and returns the result.
- **Persistent Q&A** — your client tool calls `session_start`, then `session_send` repeatedly. Claude Code keeps the same conversation context across turns, so it can ask clarifying questions and your client can answer them.
- **MCP-agnostic** — the bridge does not know what MCPs your subprocess will load; it just hands a config path through to `claude --mcp-config`. Add new MCPs without changing the bridge.

## Install

```bash
npm install -g claude-code-bridge
```

Or run without installing:

```bash
npx claude-code-bridge
```

You need Node.js 20+ and the Claude Code CLI on your PATH (or pointed at via `CLAUDE_CODE_PATH`).

## Configure your MCP client

Add the bridge to your MCP client's config. For Claude Desktop, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "claude-code-bridge": {
      "command": "npx",
      "args": ["claude-code-bridge"],
      "env": {
        "CLAUDE_CODE_PATH": "claude"
      }
    }
  }
}
```

Restart your client. You should see six tools exposed: `execute`, `session_start`, `session_send`, `session_end`, `session_get`, `session_list`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_CODE_PATH` | `claude` | Path to the Claude Code CLI binary. |
| `CLAUDE_BRIDGE_CONFIG_DIRS` | `$HOME` | Colon-separated (`;`-separated on Windows) directories from which `mcpConfigPath` may be loaded. Absolute paths only; `..`-escapes and symlink targets outside these dirs are rejected. |
| `CLAUDE_BRIDGE_DEFAULT_CWD` | (per-call tempdir) | Default working directory for spawned subprocesses. |
| `CLAUDE_BRIDGE_ALLOW_BYPASS` | `0` | Set to `1` to allow callers to pass `permissionMode=bypassPermissions`. Off by default — see [Security model](#security-model). |
| `CLAUDE_BRIDGE_SESSION_IDLE_TIMEOUT` | `300` | Seconds of inactivity before a persistent session is auto-closed. |
| `CLAUDE_BRIDGE_SESSION_MAX_LIFETIME` | `3600` | Hard maximum session lifetime, in seconds. |
| `CLAUDE_BRIDGE_EXECUTE_TIMEOUT` | `300` | Per-call timeout for `execute`, in seconds. |
| `CLAUDE_BRIDGE_PASSTHROUGH_ENV` | (empty) | Comma-separated env var names to additionally pass through to subprocesses. Use sparingly. |
| `CLAUDE_BRIDGE_DEBUG` | `0` | Verbose stderr logging (redacted for known secret patterns). |

The bridge **never** reads `process.env` outside `loadConfigFromEnv()`. Everything is plumbed through explicit config, which makes the security surface auditable.

## Tools

### `execute`

Run a single Claude Code task to completion.

Parameters:

- `prompt` (string, required) — the task to run
- `mcpConfigPath` (string, optional) — absolute path to an `{ mcpServers: {...} }` JSON file; must live inside `CLAUDE_BRIDGE_CONFIG_DIRS`
- `permissionMode` (`plan` | `acceptEdits` | `default` | `bypassPermissions`, optional)
- `allowedTools`, `disallowedTools` (string arrays, optional)
- `timeoutSeconds` (integer, optional) — overrides `CLAUDE_BRIDGE_EXECUTE_TIMEOUT`
- `cwd` (string, optional)

Returns: `{ text, claudeSessionId, durationMs, chunkCount, isError, errorMessage? }`.

### `session_start`, `session_send`, `session_end`, `session_get`, `session_list`

The Q&A loop. `session_start` returns a `bridgeSessionId`; pass that to `session_send` to send follow-up messages. Each `session_send` returns the assistant text for that turn only. Sessions auto-close after idle/lifetime timeouts or explicit `session_end`.

## Security model

This bridge is built on the assumption that the prompts reaching it are not trusted — an MCP client driven by an LLM is just one prompt-injection away from issuing tool calls you did not intend. The defaults reflect that:

- **`bypassPermissions` is off**. Callers asking for it are rejected unless `CLAUDE_BRIDGE_ALLOW_BYPASS=1` is set. The Claude Code subprocess will surface its normal approval prompts otherwise.
- **`mcpConfigPath` is validated**: must be absolute, must resolve (via `realpath`) inside one of the configured allow-dirs, must be a regular file under 1 MB, must parse as `{ mcpServers: {...} }`.
- **Environment is whitelisted**. Only a small set of process essentials and `CLAUDE_CODE_*` vars pass through to spawned subprocesses. Operator can extend via `CLAUDE_BRIDGE_PASSTHROUGH_ENV`. The bridge's own secrets, your MCP host's secrets, anything else — all dropped.
- **No shell**. Every subprocess is spawned with `shell: false` and arguments as an array. Prompts cannot inject shell metacharacters.
- **Debug logs are redacted**. When `CLAUDE_BRIDGE_DEBUG=1`, stderr passes through a regex pass that masks known secret patterns (Anthropic, OpenAI, GitHub, Slack, AWS, Bearer tokens, JWTs, PEM blocks). This is best-effort and the MCP response itself is not redacted — that's the actual product.

It also intentionally does **not** do a few things:

- It does not run as root, escalate privileges, or invoke `sudo` anywhere. The repo has no install script.
- It does not phone home, write to user-config files outside what your MCP client controls, or maintain its own credential store.
- It does not auto-detect intent from prompts (e.g., regex-matching "hubspot" → preloading a HubSpot MCP). Configs are explicit.

## Development

```bash
git clone <this repo>
cd claude-code-bridge
npm install
npm test        # node:test + tsx, no extra runner
npm run lint    # tsc --noEmit
npm run build   # tsc → ./build
```

## License

MIT
