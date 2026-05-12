import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeCodeArgs,
  enforceBypassPolicy,
} from '../src/executor/spawner.js';

describe('buildClaudeCodeArgs', () => {
  it('builds a minimal one-shot args list', () => {
    const args = buildClaudeCodeArgs({
      mcpConfigPath: undefined,
      permissionMode: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      persistent: false,
      oneShotPrompt: 'hello',
    });
    assert.deepEqual(args, [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--',
      'hello',
    ]);
  });

  it('adds --input-format=stream-json in persistent mode and omits the prompt', () => {
    const args = buildClaudeCodeArgs({
      mcpConfigPath: undefined,
      permissionMode: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      persistent: true,
      oneShotPrompt: undefined,
    });
    assert.ok(args.includes('--input-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(!args.includes('--'));
  });

  it('includes mcp config and permission mode when supplied', () => {
    const args = buildClaudeCodeArgs({
      mcpConfigPath: '/tmp/cfg.json',
      permissionMode: 'plan',
      allowedTools: ['Read', 'Grep'],
      disallowedTools: ['Write'],
      persistent: false,
      oneShotPrompt: 'do it',
    });
    assert.ok(args.includes('--mcp-config'));
    assert.ok(args.includes('/tmp/cfg.json'));
    assert.ok(args.includes('--permission-mode'));
    assert.ok(args.includes('plan'));
    assert.ok(args.includes('--allowed-tools'));
    assert.ok(args.includes('Read,Grep'));
    assert.ok(args.includes('--disallowed-tools'));
    assert.ok(args.includes('Write'));
  });

  it('throws if one-shot mode is requested without a prompt', () => {
    assert.throws(
      () =>
        buildClaudeCodeArgs({
          mcpConfigPath: undefined,
          permissionMode: undefined,
          allowedTools: undefined,
          disallowedTools: undefined,
          persistent: false,
          oneShotPrompt: undefined,
        }),
      /requires a prompt/,
    );
  });

  it('treats prompts that look like flags as positional args via --', () => {
    const args = buildClaudeCodeArgs({
      mcpConfigPath: undefined,
      permissionMode: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      persistent: false,
      oneShotPrompt: '--rm -rf /',
    });
    // The prompt must appear AFTER `--` so it cannot be reinterpreted as a flag.
    const dashIdx = args.lastIndexOf('--');
    const promptIdx = args.lastIndexOf('--rm -rf /');
    assert.ok(dashIdx >= 0);
    assert.ok(promptIdx > dashIdx);
  });
});

describe('enforceBypassPolicy', () => {
  it('returns the input mode unchanged for non-bypass values', () => {
    assert.equal(enforceBypassPolicy('plan', false), 'plan');
    assert.equal(enforceBypassPolicy('default', true), 'default');
    assert.equal(enforceBypassPolicy(undefined, false), undefined);
  });

  it('throws when bypassPermissions is requested and not allowed', () => {
    assert.throws(
      () => enforceBypassPolicy('bypassPermissions', false),
      /CLAUDE_BRIDGE_ALLOW_BYPASS/,
    );
  });

  it('allows bypassPermissions when the env opt-in is set', () => {
    assert.equal(
      enforceBypassPolicy('bypassPermissions', true),
      'bypassPermissions',
    );
  });
});
