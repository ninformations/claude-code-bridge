# Changelog

## 0.1.0 — initial release

- `execute` tool for one-shot Claude Code delegation.
- `session_start` / `session_send` / `session_end` / `session_get` / `session_list` tools for persistent Q&A sessions over stream-json.
- Path allow-listing for `mcpConfigPath` (absolute + realpath + size cap + shape validation).
- Whitelist-based environment scrubbing for spawned subprocesses.
- Best-effort secret redaction in debug logs.
- Default-safe permission model: `bypassPermissions` requires `CLAUDE_BRIDGE_ALLOW_BYPASS=1`.
- Idle + hard-lifetime timeouts on persistent sessions.
- Tests for security modules, argument builder, config parser, and stream parser.
- CI on Node 20 + 22.
