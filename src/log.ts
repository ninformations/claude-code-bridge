import { redact } from './security/redact.js';

/**
 * Minimal stderr logger. The MCP protocol uses stdout for its JSON-RPC frame,
 * so any logging from the bridge MUST go to stderr only — anything we write
 * to stdout would corrupt the protocol.
 *
 * All log strings are passed through `redact()` to scrub well-known secret
 * shapes. Treat this as best-effort, not a guarantee.
 */
export class Logger {
  constructor(private readonly debugEnabled: boolean) {}

  info(msg: string): void {
    process.stderr.write(`[bridge] ${redact(msg)}\n`);
  }

  warn(msg: string): void {
    process.stderr.write(`[bridge:warn] ${redact(msg)}\n`);
  }

  error(msg: string): void {
    process.stderr.write(`[bridge:error] ${redact(msg)}\n`);
  }

  debug(msg: string): void {
    if (!this.debugEnabled) return;
    process.stderr.write(`[bridge:debug] ${redact(msg)}\n`);
  }
}
