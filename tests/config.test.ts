import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfigFromEnv } from '../src/config.js';

describe('loadConfigFromEnv', () => {
  it('uses safe defaults when env is empty', () => {
    const cfg = loadConfigFromEnv({});
    assert.equal(cfg.claudeCodePath, 'claude');
    assert.equal(cfg.allowBypass, false);
    assert.equal(cfg.debug, false);
    assert.equal(cfg.executeTimeoutMs, 300_000);
    assert.equal(cfg.sessionIdleTimeoutMs, 300_000);
    assert.equal(cfg.sessionMaxLifetimeMs, 3_600_000);
    assert.deepEqual(cfg.configAllowedDirs, [path.resolve(os.homedir())]);
    assert.equal(cfg.defaultCwd, undefined);
    assert.deepEqual(cfg.passthroughEnv, []);
  });

  it('parses CLAUDE_BRIDGE_CONFIG_DIRS as a path-list', () => {
    const cfg = loadConfigFromEnv({
      CLAUDE_BRIDGE_CONFIG_DIRS: ['/tmp/a', '/tmp/b'].join(path.delimiter),
    });
    assert.deepEqual(cfg.configAllowedDirs, ['/tmp/a', '/tmp/b']);
  });

  it('parses allowBypass from boolean-ish strings', () => {
    for (const truthy of ['1', 'true', 'yes', 'on', 'TRUE']) {
      const cfg = loadConfigFromEnv({ CLAUDE_BRIDGE_ALLOW_BYPASS: truthy });
      assert.equal(cfg.allowBypass, true, `expected truthy for "${truthy}"`);
    }
    for (const falsy of ['0', 'false', 'no', 'off', '']) {
      const cfg = loadConfigFromEnv({ CLAUDE_BRIDGE_ALLOW_BYPASS: falsy });
      assert.equal(cfg.allowBypass, false, `expected falsy for "${falsy}"`);
    }
  });

  it('parses timeouts as seconds → ms', () => {
    const cfg = loadConfigFromEnv({
      CLAUDE_BRIDGE_EXECUTE_TIMEOUT: '10',
      CLAUDE_BRIDGE_SESSION_IDLE_TIMEOUT: '120',
      CLAUDE_BRIDGE_SESSION_MAX_LIFETIME: '7200',
    });
    assert.equal(cfg.executeTimeoutMs, 10_000);
    assert.equal(cfg.sessionIdleTimeoutMs, 120_000);
    assert.equal(cfg.sessionMaxLifetimeMs, 7_200_000);
  });

  it('falls back to defaults when timeouts are malformed', () => {
    const cfg = loadConfigFromEnv({
      CLAUDE_BRIDGE_EXECUTE_TIMEOUT: 'banana',
      CLAUDE_BRIDGE_SESSION_IDLE_TIMEOUT: '-1',
      CLAUDE_BRIDGE_SESSION_MAX_LIFETIME: '0',
    });
    assert.equal(cfg.executeTimeoutMs, 300_000);
    assert.equal(cfg.sessionIdleTimeoutMs, 300_000);
    assert.equal(cfg.sessionMaxLifetimeMs, 3_600_000);
  });

  it('parses CLAUDE_BRIDGE_PASSTHROUGH_ENV as csv', () => {
    const cfg = loadConfigFromEnv({
      CLAUDE_BRIDGE_PASSTHROUGH_ENV: 'GITHUB_TOKEN, DATABASE_URL ,  ',
    });
    assert.deepEqual(cfg.passthroughEnv, ['GITHUB_TOKEN', 'DATABASE_URL']);
  });
});
