#!/usr/bin/env node
/**
 * fake-claude: a minimal stand-in for the Claude Code CLI, used by integration
 * tests. Honors just enough of the real CLI to drive the bridge end-to-end:
 *
 *   --print --verbose --output-format stream-json [--input-format stream-json]
 *   [--mcp-config <path>] [--permission-mode <mode>]
 *   [--allowed-tools <csv>] [--disallowed-tools <csv>]
 *   [-- <prompt>]   (one-shot mode)
 *
 * Behavior:
 *   One-shot: emit system.init, then an assistant chunk whose text echoes the
 *     prompt and the full argv (so tests can assert on flags), then a result.
 *   Persistent: emit system.init, then for each line of stream-json on stdin
 *     emit an assistant chunk echoing the received text + a result. Loop until
 *     stdin closes.
 *
 * Behavior knobs via env (read at startup):
 *   FAKE_CLAUDE_DELAY_MS       — sleep before first chunk
 *   FAKE_CLAUDE_HANG           — never emit anything; used to test timeouts
 *   FAKE_CLAUDE_EXIT_CODE      — process exit code (default 0)
 *   FAKE_CLAUDE_REPORT_ERROR   — set is_error=true on the result chunk
 *   FAKE_CLAUDE_DUMP_ENV       — JSON-dump received env as the assistant text
 */
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';

const argv = process.argv.slice(2);
const persistent = argv.includes('--input-format');
const hang = process.env.FAKE_CLAUDE_HANG === '1';
const delayMs = Number.parseInt(process.env.FAKE_CLAUDE_DELAY_MS ?? '0', 10);
const reportError = process.env.FAKE_CLAUDE_REPORT_ERROR === '1';
const dumpEnv = process.env.FAKE_CLAUDE_DUMP_ENV === '1';
const exitCode = Number.parseInt(process.env.FAKE_CLAUDE_EXIT_CODE ?? '0', 10);

function findPromptFromArgv() {
  const dashIdx = argv.lastIndexOf('--');
  if (dashIdx === -1) return null;
  return argv.slice(dashIdx + 1).join(' ');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeAssistantText(text) {
  if (dumpEnv) return JSON.stringify(process.env);
  return text;
}

async function runOneShot() {
  if (hang) {
    // Sit forever so the bridge has to time us out. Use a long setInterval
    // to keep the event loop alive; otherwise Node would exit immediately
    // with code 13 (Unfinished Top-Level Await).
    const keepAlive = setInterval(() => {}, 1_000_000);
    process.on('SIGTERM', () => {
      clearInterval(keepAlive);
      process.exit(143);
    });
    await new Promise(() => {});
    return;
  }
  if (delayMs > 0) await sleep(delayMs);

  const sessionId = randomUUID();
  emit({ type: 'system', subtype: 'init', session_id: sessionId });

  const prompt = findPromptFromArgv() ?? '';
  const echoed = `argv=${JSON.stringify(argv)} prompt=${JSON.stringify(prompt)}`;

  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: makeAssistantText(echoed) }],
    },
  });

  emit({
    type: 'result',
    subtype: reportError ? 'error' : 'success',
    is_error: reportError,
    session_id: sessionId,
  });

  process.exit(exitCode);
}

async function runPersistent() {
  if (hang) {
    await new Promise(() => {});
    return;
  }

  const sessionId = randomUUID();
  emit({ type: 'system', subtype: 'init', session_id: sessionId });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    let userText = '';
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'user') {
        const content = parsed?.message?.content ?? [];
        for (const part of content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            userText += part.text;
          }
        }
      }
    } catch {
      // Ignore malformed lines.
    }
    if (delayMs > 0) {
      setTimeout(() => emitTurn(userText), delayMs);
    } else {
      emitTurn(userText);
    }
  });

  rl.on('close', () => process.exit(exitCode));

  function emitTurn(userText) {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: makeAssistantText(`echo: ${userText}`) }],
      },
    });
    emit({
      type: 'result',
      subtype: reportError ? 'error' : 'success',
      is_error: reportError,
      session_id: sessionId,
    });
  }
}

if (persistent) {
  await runPersistent();
} else {
  await runOneShot();
}
