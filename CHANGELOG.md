# Changelog

## 0.2.0

- **MCP progress notifications.** Long-running `execute` and `session_*` calls
  now emit `notifications/progress` frames while Claude Code works, so MCP
  hosts that honor them (Anthropic Desktop, Cursor, others) reset their
  per-tool-call timeout and don't kill the request after 30–60 s of silence.
  Heartbeat fires every 15 s of silence by default; chunk-driven reports
  (`connected`, `calling tool: <name>`, `got tool result`, `assistant: N chars`,
  `finished`) debounce the heartbeat so it only fills genuine gaps.
- Backward compatible: clients that do not include `_meta.progressToken` in
  the request see exactly the v0.1 behavior. No tool API changes.
- `CLAUDE_CONFIG_DIR` (from v0.1.1 in main) now passes through to the spawned
  Claude Code subprocess by default — point at different config dirs to switch
  between work and personal accounts without `CLAUDE_BRIDGE_PASSTHROUGH_ENV`.

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
