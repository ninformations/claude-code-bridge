#!/usr/bin/env node
import { loadConfigFromEnv } from './config.js';
import { Logger } from './log.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const log = new Logger(config.debug);
  const server = createServer(config, log);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    server
      .shutdown()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`error during shutdown: ${msg}`);
      })
      .finally(() => {
        // Give a moment for buffered stderr to flush.
        setTimeout(() => process.exit(0), 50).unref();
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err: Error) => {
    log.error(`uncaughtException: ${err.stack ?? err.message}`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error(`unhandledRejection: ${msg}`);
  });

  try {
    await server.start();
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`failed to start: ${msg}`);
    process.exit(1);
  }
}

await main();
