/**
 * Integration tests for the bridge.
 *
 * These drive the real executor and session manager through a fake "claude"
 * binary (tests/fixtures/fake-claude.js) that speaks just enough of the
 * stream-json protocol to exercise the bridge end-to-end. They run as part
 * of `npm test` — no special env flag required — and depend only on Node
 * itself, not on the actual Claude Code CLI.
 *
 * For tests that hit the real Claude Code binary, write a separate file
 * gated on `process.env.RUN_LIVE_CLAUDE_TESTS === '1'`.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfigFromEnv } from '../src/config.js';
import { Logger } from '../src/log.js';
import { executeOneShot } from '../src/executor/one-shot.js';
import { SessionManager } from '../src/executor/session-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(__dirname, 'fixtures/fake-claude.js');

/**
 * Build a bridge config that points at fake-claude and whitelists the
 * FAKE_CLAUDE_* env vars so tests can drive fixture behavior through
 * the spawned subprocess.
 */
function testEnv(extras: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    CLAUDE_CODE_PATH: `node ${FAKE_CLAUDE}`,
    CLAUDE_BRIDGE_PASSTHROUGH_ENV:
      'FAKE_CLAUDE_HANG,FAKE_CLAUDE_DELAY_MS,FAKE_CLAUDE_EXIT_CODE,FAKE_CLAUDE_REPORT_ERROR,FAKE_CLAUDE_DUMP_ENV',
    CLAUDE_BRIDGE_EXECUTE_TIMEOUT: '10',
    CLAUDE_BRIDGE_SESSION_IDLE_TIMEOUT: '10',
    CLAUDE_BRIDGE_SESSION_MAX_LIFETIME: '30',
    ...extras,
  };
}

const SILENT_LOG = new Logger(false);

/**
 * Snapshot/restore process.env around each test so setting FAKE_CLAUDE_* in
 * one case does not bleed into the next.
 */
let envSnapshot: NodeJS.ProcessEnv;
beforeEach(() => {
  envSnapshot = { ...process.env };
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in envSnapshot)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v !== undefined) process.env[k] = v;
  }
});

/**
 * The spawner uses `spawn(claudeCodePath, args, ...)` with a single command
 * string. To run our fake via `node <path>`, the simplest trick is to make
 * CLAUDE_CODE_PATH point at `node` and inject the fixture path as the first
 * argv entry. But that complicates argv assertions. Instead, we shim by
 * writing a small wrapper shell script (or .cmd on Windows) at test time that
 * exec's `node <fake>`. On Linux/macOS this is reliable. On Windows, we fall
 * back to setting CLAUDE_CODE_PATH directly to a `.cmd` shim if needed.
 */
let claudeShim: string;
before(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccb-int-'));
  claudeShim = path.join(
    tmp,
    process.platform === 'win32' ? 'claude.cmd' : 'claude.sh',
  );
  if (process.platform === 'win32') {
    await fs.writeFile(claudeShim, `@echo off\r\nnode "${FAKE_CLAUDE}" %*\r\n`);
  } else {
    await fs.writeFile(
      claudeShim,
      `#!/usr/bin/env bash\nexec node "${FAKE_CLAUDE}" "$@"\n`,
      { mode: 0o755 },
    );
  }
});
after(async () => {
  try {
    await fs.rm(path.dirname(claudeShim), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function shimEnv(extras: Record<string, string> = {}): NodeJS.ProcessEnv {
  return testEnv({ CLAUDE_CODE_PATH: claudeShim, ...extras });
}

describe('integration: executeOneShot', () => {
  it('runs a happy-path one-shot and returns the assistant text', async () => {
    Object.assign(process.env, shimEnv());
    const config = loadConfigFromEnv(process.env);
    const res = await executeOneShot(
      { prompt: 'hello world' },
      config,
      SILENT_LOG,
    );
    assert.equal(res.isError, false);
    assert.ok(res.text);
    assert.match(res.text!, /hello world/);
    assert.ok(res.claudeSessionId, 'expected a claude session id from system.init');
    assert.ok(res.chunkCount >= 2);
  });

  it('passes --mcp-config and --permission-mode through to the subprocess argv', async () => {
    Object.assign(process.env, shimEnv());
    // Drop a valid MCP config in $HOME so the path validator accepts it.
    const cfgPath = path.join(os.homedir(), `.ccb-int-${Date.now()}.json`);
    await fs.writeFile(
      cfgPath,
      JSON.stringify({ mcpServers: { x: { command: 'echo' } } }),
    );
    try {
      const config = loadConfigFromEnv(process.env);
      const res = await executeOneShot(
        {
          prompt: 'do thing',
          mcpConfigPath: cfgPath,
          permissionMode: 'plan',
          allowedTools: ['Read'],
          disallowedTools: ['Write'],
        },
        config,
        SILENT_LOG,
      );
      assert.equal(res.isError, false);
      assert.ok(res.text);
      assert.match(res.text!, /--mcp-config/);
      assert.match(res.text!, /--permission-mode/);
      assert.match(res.text!, /plan/);
      assert.match(res.text!, /--allowed-tools/);
      assert.match(res.text!, /Read/);
      assert.match(res.text!, /--disallowed-tools/);
      assert.match(res.text!, /Write/);
    } finally {
      await fs.rm(cfgPath, { force: true });
    }
  });

  it('rejects mcpConfigPath outside the allow-list', async () => {
    // Pin the allow-list to one specific dir, then write the bad file in a
    // different dir. Avoids fragility around sandbox layouts where $TMPDIR
    // can live inside $HOME.
    const allowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccb-allow-'));
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccb-other-'));
    Object.assign(
      process.env,
      shimEnv({ CLAUDE_BRIDGE_CONFIG_DIRS: allowDir }),
    );
    const cfgPath = path.join(otherDir, 'outside.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({ mcpServers: { x: { command: 'echo' } } }),
    );
    try {
      const config = loadConfigFromEnv(process.env);
      await assert.rejects(
        executeOneShot(
          { prompt: 'x', mcpConfigPath: cfgPath },
          config,
          SILENT_LOG,
        ),
        /not inside any allowed directory/,
      );
    } finally {
      await fs.rm(allowDir, { recursive: true, force: true });
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it('rejects permissionMode=bypassPermissions when CLAUDE_BRIDGE_ALLOW_BYPASS is off', async () => {
    Object.assign(process.env, shimEnv());
    const config = loadConfigFromEnv(process.env);
    await assert.rejects(
      executeOneShot(
        { prompt: 'x', permissionMode: 'bypassPermissions' },
        config,
        SILENT_LOG,
      ),
      /CLAUDE_BRIDGE_ALLOW_BYPASS/,
    );
  });

  it('allows permissionMode=bypassPermissions when the env opt-in is set', async () => {
    Object.assign(process.env, shimEnv({ CLAUDE_BRIDGE_ALLOW_BYPASS: '1' }));
    const config = loadConfigFromEnv(process.env);
    const res = await executeOneShot(
      { prompt: 'x', permissionMode: 'bypassPermissions' },
      config,
      SILENT_LOG,
    );
    assert.equal(res.isError, false);
    assert.match(res.text!, /bypassPermissions/);
  });

  it('reports timeout when the subprocess hangs longer than the timeout', async () => {
    Object.assign(process.env, shimEnv({ FAKE_CLAUDE_HANG: '1' }));
    const config = loadConfigFromEnv(process.env);
    const res = await executeOneShot(
      { prompt: 'x', timeoutSeconds: 1 },
      config,
      SILENT_LOG,
    );
    assert.equal(res.isError, true);
    assert.match(res.errorMessage ?? '', /Timed out/);
  });

  it('flags isError when the result chunk reports it', async () => {
    Object.assign(process.env, shimEnv({ FAKE_CLAUDE_REPORT_ERROR: '1' }));
    const config = loadConfigFromEnv(process.env);
    const res = await executeOneShot({ prompt: 'x' }, config, SILENT_LOG);
    assert.equal(res.isError, true);
  });

  it('does not leak parent process env to the subprocess', async () => {
    Object.assign(
      process.env,
      shimEnv({
        FAKE_CLAUDE_DUMP_ENV: '1',
        SHOULD_NOT_LEAK: 'this-is-a-secret-value',
        ANOTHER_SECRET: 'leak-me-please',
      }),
    );
    const config = loadConfigFromEnv(process.env);
    const res = await executeOneShot({ prompt: 'x' }, config, SILENT_LOG);
    assert.equal(res.isError, false);
    assert.ok(res.text, 'expected env dump in assistant text');
    assert.doesNotMatch(
      res.text!,
      /this-is-a-secret-value/,
      'subprocess received a non-whitelisted env var; env scrubbing is broken',
    );
    assert.doesNotMatch(res.text!, /leak-me-please/);
  });
});

describe('integration: SessionManager', () => {
  it('starts a session, exchanges turns, and ends cleanly', async () => {
    Object.assign(process.env, shimEnv());
    const config = loadConfigFromEnv(process.env);
    const mgr = new SessionManager(config, SILENT_LOG);

    const { session, initialText } = await mgr.start({
      initialPrompt: 'hello',
    });
    try {
      assert.equal(session.status, 'idle');
      assert.match(initialText, /echo: hello/);

      assert.equal(mgr.list().length, 1);
      const got = mgr.get(session.bridgeSessionId);
      assert.ok(got);
      assert.equal(got!.bridgeSessionId, session.bridgeSessionId);

      const turn = await mgr.send(session.bridgeSessionId, 'second message');
      assert.equal(turn.session.status, 'idle');
      assert.match(turn.text, /echo: second message/);

      const ended = await mgr.end(session.bridgeSessionId);
      assert.equal(ended.status, 'closed');
      assert.equal(mgr.get(session.bridgeSessionId), null);
    } finally {
      await mgr.shutdown();
    }
  });

  it('rejects send on an unknown session id', async () => {
    Object.assign(process.env, shimEnv());
    const config = loadConfigFromEnv(process.env);
    const mgr = new SessionManager(config, SILENT_LOG);
    try {
      await assert.rejects(
        mgr.send('00000000-0000-0000-0000-000000000000', 'hi'),
        /Unknown sessionId/,
      );
    } finally {
      await mgr.shutdown();
    }
  });

  it('shutdown closes all active sessions', async () => {
    Object.assign(process.env, shimEnv());
    const config = loadConfigFromEnv(process.env);
    const mgr = new SessionManager(config, SILENT_LOG);
    const { session: s1 } = await mgr.start({ initialPrompt: 'a' });
    const { session: s2 } = await mgr.start({ initialPrompt: 'b' });
    assert.equal(mgr.list().length, 2);
    await mgr.shutdown();
    assert.equal(mgr.get(s1.bridgeSessionId), null);
    assert.equal(mgr.get(s2.bridgeSessionId), null);
  });
});
