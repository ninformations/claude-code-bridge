import type { Readable } from 'node:stream';
import { StreamChunkSchema, type StreamChunk } from '../types.js';

/**
 * Async-iterate parsed stream-json chunks from a Readable stream.
 *
 * Claude Code emits one JSON object per line on stdout. We buffer incomplete
 * lines until a newline is observed, parse each line, and yield the result.
 * Lines that fail to parse as JSON are skipped silently (Claude Code can
 * interleave non-JSON warnings; the bridge should not crash on those).
 */
export async function* readStreamJson(
  stream: Readable,
): AsyncGenerator<StreamChunk, void, void> {
  stream.setEncoding('utf8');
  let buf = '';

  for await (const chunk of stream as AsyncIterable<string>) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      const parsed = tryParseChunk(line);
      if (parsed !== null) yield parsed;
    }
  }

  // Flush any trailing partial line.
  const tail = buf.trim();
  if (tail.length > 0) {
    const parsed = tryParseChunk(tail);
    if (parsed !== null) yield parsed;
  }
}

function tryParseChunk(line: string): StreamChunk | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const v = StreamChunkSchema.safeParse(raw);
  return v.success ? v.data : null;
}

/**
 * Format a user-side message into the stream-json input format that
 * Claude Code's `--input-format=stream-json` expects.
 *
 * Wire shape:
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 */
export function formatUserMessage(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    }) + '\n'
  );
}

/**
 * Pull together the assistant-visible text out of a sequence of chunks for
 * a single turn. Stops at the first `result` chunk and returns the
 * accumulated text plus the result chunk itself (for status/cost/etc).
 *
 * Takes an `AsyncIterator` (not `AsyncIterable`) on purpose: persistent
 * sessions reuse one iterator across multiple turns, and `for await`-and-
 * `break` would call `iterator.return()` and destroy the iterator after the
 * first turn. Manual `.next()` lets us stop at the result chunk without
 * tearing down the underlying stream.
 *
 * If `signal` is aborted we stop and return whatever we have so far.
 */
export async function collectTurn(
  iterator: AsyncIterator<StreamChunk>,
  signal?: AbortSignal,
): Promise<{
  text: string;
  resultChunk: StreamChunk | null;
  systemInit: StreamChunk | null;
  chunkCount: number;
  isError: boolean;
}> {
  let text = '';
  let resultChunk: StreamChunk | null = null;
  let systemInit: StreamChunk | null = null;
  let chunkCount = 0;
  let isError = false;

  while (true) {
    if (signal?.aborted) break;

    let step: IteratorResult<StreamChunk>;
    try {
      step = await iterator.next();
    } catch {
      break;
    }
    if (step.done) break;
    const chunk = step.value;
    chunkCount += 1;

    if (chunk.type === 'system' && (chunk as { subtype?: string }).subtype === 'init') {
      systemInit = chunk;
      continue;
    }

    if (chunk.type === 'assistant') {
      const c = chunk as { message?: { content?: Array<{ type?: string; text?: string }> } };
      const content = c.message?.content ?? [];
      for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          text += part.text;
        }
      }
      continue;
    }

    if (chunk.type === 'result') {
      resultChunk = chunk;
      const c = chunk as { is_error?: boolean; subtype?: string };
      if (c.is_error === true || c.subtype === 'error') isError = true;
      break;
    }
  }

  return { text, resultChunk, systemInit, chunkCount, isError };
}
