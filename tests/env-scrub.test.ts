import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubprocessEnv } from '../src/security/env-scrub.js';

describe('buildSubprocessEnv', () => {
  it('passes through PATH and HOME by default', () => {
    const out = buildSubprocessEnv({
      parentEnv: { PATH: '/usr/bin', HOME: '/home/me' },
      passthroughExtras: [],
    });
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.HOME, '/home/me');
  });

  it('drops arbitrary parent vars not on the whitelist', () => {
    const out = buildSubprocessEnv({
      parentEnv: {
        PATH: '/usr/bin',
        DATABASE_URL: 'postgres://user:pass@host/db',
        STRIPE_SECRET_KEY: 'sk_live_xxx',
      },
      passthroughExtras: [],
    });
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.DATABASE_URL, undefined);
    assert.equal(out.STRIPE_SECRET_KEY, undefined);
  });

  it('drops CLAUDE_BRIDGE_* vars (bridge-internal, not for subprocess)', () => {
    const out = buildSubprocessEnv({
      parentEnv: {
        CLAUDE_BRIDGE_ALLOW_BYPASS: '1',
        CLAUDE_BRIDGE_DEBUG: '1',
      },
      passthroughExtras: [],
    });
    assert.equal(out.CLAUDE_BRIDGE_ALLOW_BYPASS, undefined);
    assert.equal(out.CLAUDE_BRIDGE_DEBUG, undefined);
  });

  it('passes through CLAUDE_CODE_* vars', () => {
    const out = buildSubprocessEnv({
      parentEnv: { CLAUDE_CODE_PATH: '/usr/local/bin/claude' },
      passthroughExtras: [],
    });
    assert.equal(out.CLAUDE_CODE_PATH, '/usr/local/bin/claude');
  });

  it('passes through opt-in extras', () => {
    const out = buildSubprocessEnv({
      parentEnv: { GITHUB_TOKEN: 'ghp_xxx', SOMETHING_ELSE: 'x' },
      passthroughExtras: ['GITHUB_TOKEN'],
    });
    assert.equal(out.GITHUB_TOKEN, 'ghp_xxx');
    assert.equal(out.SOMETHING_ELSE, undefined);
  });

  it('still drops secret-shaped names from CLAUDE_CODE_ prefix unless opted in', () => {
    const out = buildSubprocessEnv({
      parentEnv: { CLAUDE_CODE_API_TOKEN: 'oops' },
      passthroughExtras: [],
    });
    assert.equal(out.CLAUDE_CODE_API_TOKEN, undefined);
  });

  it('allows explicit opt-in even for secret-shaped names', () => {
    const out = buildSubprocessEnv({
      parentEnv: { GITHUB_TOKEN: 'ghp_xxx' },
      passthroughExtras: ['GITHUB_TOKEN'],
    });
    assert.equal(out.GITHUB_TOKEN, 'ghp_xxx');
  });

  it('does not include undefined entries', () => {
    const out = buildSubprocessEnv({
      parentEnv: { PATH: '/usr/bin', X: undefined },
      passthroughExtras: ['X'],
    });
    assert.equal('X' in out, false);
  });
});
