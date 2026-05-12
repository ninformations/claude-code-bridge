import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  collectTurn,
  formatUserMessage,
  readStreamJson,
} from '../src/executor/stream.js';

function streamFromLines(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n'));
}

describe('readStreamJson', () => {
  it('yields parsed chunks one per line', async () => {
    const stream = streamFromLines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result' }),
    ]);
    const out: unknown[] = [];
    for await (const c of readStreamJson(stream)) out.push(c);
    assert.equal(out.length, 3);
    assert.equal((out[0] as { type: string }).type, 'system');
    assert.equal((out[2] as { type: string }).type, 'result');
  });

  it('skips malformed JSON lines silently', async () => {
    const stream = streamFromLines([
      'not json at all',
      JSON.stringify({ type: 'result' }),
    ]);
    const out: unknown[] = [];
    for await (const c of readStreamJson(stream)) out.push(c);
    assert.equal(out.length, 1);
  });

  it('handles a final line with no trailing newline', async () => {
    const stream = Readable.from([
      JSON.stringify({ type: 'a' }) + '\n' + JSON.stringify({ type: 'b' }),
    ]);
    const out: unknown[] = [];
    for await (const c of readStreamJson(stream)) out.push(c);
    assert.equal(out.length, 2);
  });

  it('handles chunked input that splits a JSON object mid-stream', async () => {
    const json = JSON.stringify({ type: 'assistant', x: 'hello world' });
    const mid = Math.floor(json.length / 2);
    const stream = Readable.from([json.slice(0, mid), json.slice(mid) + '\n']);
    const out: unknown[] = [];
    for await (const c of readStreamJson(stream)) out.push(c);
    assert.equal(out.length, 1);
    assert.equal((out[0] as { type: string }).type, 'assistant');
  });
});

describe('collectTurn', () => {
  it('accumulates assistant text and stops at result', async () => {
    const stream = streamFromLines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      }),
      JSON.stringify({ type: 'result' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }] } }),
    ]);
    const it = readStreamJson(stream)[Symbol.asyncIterator]();
    const got = await collectTurn(it);
    assert.equal(got.text, 'hello world');
    assert.equal(got.isError, false);
    assert.equal((got.systemInit as { session_id?: string } | null)?.session_id, 'sid');
    assert.ok(got.resultChunk);
  });

  it('flags isError when the result reports it', async () => {
    const stream = streamFromLines([
      JSON.stringify({ type: 'result', is_error: true }),
    ]);
    const it = readStreamJson(stream)[Symbol.asyncIterator]();
    const got = await collectTurn(it);
    assert.equal(got.isError, true);
  });

  it('can be called multiple times on the same iterator across turns', async () => {
    const stream = streamFromLines([
      // Turn 1
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first' }] },
      }),
      JSON.stringify({ type: 'result' }),
      // Turn 2
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second' }] },
      }),
      JSON.stringify({ type: 'result' }),
    ]);
    const it = readStreamJson(stream)[Symbol.asyncIterator]();
    const turn1 = await collectTurn(it);
    assert.equal(turn1.text, 'first');
    const turn2 = await collectTurn(it);
    assert.equal(turn2.text, 'second');
  });
});

describe('formatUserMessage', () => {
  it('wraps text in the stream-json user shape', () => {
    const line = formatUserMessage('hi there');
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.type, 'user');
    assert.equal(parsed.message.role, 'user');
    assert.equal(parsed.message.content[0].text, 'hi there');
    assert.equal(line.endsWith('\n'), true);
  });
});
