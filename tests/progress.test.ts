import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Logger } from '../src/log.js';
import { makeProgressReporter } from '../src/progress.js';

const SILENT = new Logger(false);

interface CapturedNotification {
  method: string;
  params: {
    progressToken: string | number;
    progress: number;
    message?: string;
  };
}

/**
 * Minimal Server stub that captures whatever notification() the reporter
 * sends. Avoids spinning up the full MCP transport for unit testing.
 */
function makeFakeServer(): {
  server: Server;
  notifications: CapturedNotification[];
} {
  const notifications: CapturedNotification[] = [];
  const server = {
    notification: async (notif: CapturedNotification) => {
      notifications.push(notif);
    },
  } as unknown as Server;
  return { server, notifications };
}

describe('makeProgressReporter', () => {
  it('returns a no-op when progressToken is undefined', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: undefined,
      logger: SILENT,
      heartbeatMs: 30,
    });
    r.report('would-be-message');
    await sleep(90); // would've been ~3 heartbeats if active
    r.stop();
    assert.equal(notifications.length, 0);
  });

  it('returns a no-op when progressToken is null', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: null as unknown as undefined,
      logger: SILENT,
    });
    r.report('test');
    r.stop();
    assert.equal(notifications.length, 0);
  });

  it('emits a notification with the progressToken on report()', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 'token-abc',
      logger: SILENT,
      heartbeatMs: 1_000_000,
    });
    r.report('first message');
    // Yield to let the async fake-server resolve its push.
    await Promise.resolve();
    r.stop();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].method, 'notifications/progress');
    assert.equal(notifications[0].params.progressToken, 'token-abc');
    assert.equal(notifications[0].params.message, 'first message');
    assert.equal(notifications[0].params.progress, 1);
  });

  it('accepts numeric progress tokens', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 42,
      logger: SILENT,
      heartbeatMs: 1_000_000,
    });
    r.report('test');
    await Promise.resolve();
    r.stop();
    assert.equal(notifications[0].params.progressToken, 42);
  });

  it('increments the progress counter on each report', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 'tok',
      logger: SILENT,
      heartbeatMs: 1_000_000,
    });
    r.report('a');
    r.report('b');
    r.report('c');
    await Promise.resolve();
    r.stop();
    assert.deepEqual(
      notifications.map((n) => n.params.progress),
      [1, 2, 3],
    );
    assert.deepEqual(
      notifications.map((n) => n.params.message),
      ['a', 'b', 'c'],
    );
  });

  it('fires heartbeat when no reports arrive', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 'hb',
      logger: SILENT,
      heartbeatMs: 50,
    });
    await sleep(180); // ~3 heartbeat windows
    r.stop();
    assert.ok(
      notifications.length >= 2,
      `expected at least 2 heartbeats in 180ms, got ${notifications.length}`,
    );
    // Heartbeat uses lastMessage which starts as 'working'.
    assert.equal(notifications[0].params.message, 'working');
  });

  it('debounces heartbeat: no heartbeat fires while reports flow', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 'd',
      logger: SILENT,
      heartbeatMs: 100,
    });
    // Six reports at 30ms intervals. Each report resets the heartbeat timer,
    // and the 30ms gap is well under the 100ms heartbeatMs, so no heartbeat
    // should ever fire during this window.
    for (let i = 0; i < 6; i++) {
      r.report(`busy ${i}`);
      await sleep(30);
    }
    const countDuringReports = notifications.length;
    r.stop();
    // Allow one settling notification for the last report's tick to land.
    await Promise.resolve();
    assert.equal(
      countDuringReports,
      6,
      `expected exactly 6 report notifications, got ${countDuringReports}`,
    );
  });

  it('uses the most recent message for heartbeat content', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 'm',
      logger: SILENT,
      heartbeatMs: 40,
    });
    r.report('latest message');
    await sleep(100); // let heartbeats fire
    r.stop();
    const heartbeats = notifications.slice(1); // first one was the explicit report
    assert.ok(heartbeats.length >= 1);
    for (const hb of heartbeats) {
      assert.equal(hb.params.message, 'latest message');
    }
  });

  it('stops emitting after .stop()', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 's',
      logger: SILENT,
      heartbeatMs: 30,
    });
    r.stop();
    await sleep(120);
    assert.equal(notifications.length, 0);
  });

  it('ignores reports after stop()', async () => {
    const { server, notifications } = makeFakeServer();
    const r = makeProgressReporter({
      server,
      progressToken: 's',
      logger: SILENT,
      heartbeatMs: 1_000_000,
    });
    r.report('before');
    await Promise.resolve();
    r.stop();
    r.report('after');
    await Promise.resolve();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].params.message, 'before');
  });
});
