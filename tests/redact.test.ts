import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactionRuleNames } from '../src/security/redact.js';

describe('redact', () => {
  it('redacts Anthropic api keys', () => {
    const out = redact('key=sk-ant-api03-abcdefghijklmnopqrstuvwx');
    assert.match(out, /sk-ant-\*\*\*/);
    assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwx/);
  });

  it('redacts OpenAI-style keys', () => {
    const out = redact('sk-abcdefghijklmnopqrstuvwx12345');
    assert.match(out, /sk-\*\*\*/);
  });

  it('redacts GitHub PATs', () => {
    const out = redact('token=ghp_abcdefghijklmnopqrstuvwx12345');
    assert.match(out, /ghp_\*\*\*/);
  });

  it('redacts Slack tokens', () => {
    const out = redact('xoxb-1234567890-abcdef');
    assert.match(out, /xox\*-\*\*\*/);
  });

  it('redacts AWS access key IDs', () => {
    const out = redact('AKIAIOSFODNN7EXAMPLE in body');
    assert.match(out, /AKIA\*\*\*/);
  });

  it('redacts HTTP Authorization headers', () => {
    const out = redact('Authorization: Bearer eyJhbcsomething');
    assert.match(out, /Bearer \*\*\*/);
  });

  it('redacts JWTs', () => {
    const out = redact(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF6yQT',
    );
    assert.match(out, /jwt:\*\*\*/);
  });

  it('redacts PEM private key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIICXQIBAAKBgQDdlatRjRjogo3WojgGHFHYLugd',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redact(pem);
    assert.match(out, /REDACTED/);
    assert.doesNotMatch(out, /MIICXQIBAAKBgQDdlatRjRjogo3WojgGHFHYLugd/);
  });

  it('passes through innocuous strings unchanged', () => {
    const s = 'just a normal sentence with no secrets';
    assert.equal(redact(s), s);
  });

  it('exposes the names of its rules', () => {
    const names = redactionRuleNames();
    assert.ok(names.length > 0);
    assert.ok(names.every((n) => typeof n === 'string'));
  });
});
