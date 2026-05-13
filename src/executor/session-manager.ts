import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { validateMcpConfigPath } from '../security/path-allow-list.js';
import {
  buildClaudeCodeArgs,
  enforceBypassPolicy,
  spawnClaudeCode,
} from './spawner.js';
import { collectTurn, formatUserMessage, readStreamJson } from './stream.js';
import type { BridgeConfig } from '../config.js';
import type {
  BridgeSession,
  PermissionMode,
  SessionStartInput,
} from '../types.js';
import type { Logger } from '../log.js';
import type { ProgressReporter } from '../progress.js';

interface InternalSession extends BridgeSession {
  child: ChildProcessWithoutNullStreams;
  /** Async iterator over the subprocess stdout, reused across turns. */
  chunkIterator: AsyncIterator<import('../types.js').StreamChunk, void, void>;
  /** Promise that resolves when the child exits, with the exit code. */
  exitPromise: Promise<number | null>;
  idleTimer: NodeJS.Timeout;
  hardTimer: NodeJS.Timeout;
}

/**
 * Manages persistent Claude Code sessions.
 *
 * Each session is one long-lived subprocess running with
 * `--input-format=stream-json --output-format=stream-json`. The bridge writes
 * user messages as JSON lines to stdin and reads assistant/result chunks back
 * from stdout. The conversation is owned by Claude Code itself; we are
 * only ferrying frames.
 *
 * Lifetime is bounded by two timers:
 *  - idle: reset on every send; expires after sessionIdleTimeoutMs of silence
 *  - hard: set once on creation; expires after sessionMaxLifetimeMs absolute
 */
export class SessionManager {
  private readonly sessions = new Map<string, InternalSession>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly log: Logger,
  ) {}

  async start(
    input: SessionStartInput,
    reporter?: ProgressReporter,
  ): Promise<{
    session: BridgeSession;
    initialText: string;
  }> {
    const permissionMode: PermissionMode | undefined = enforceBypassPolicy(
      input.permissionMode,
      this.config.allowBypass,
    );

    let mcpConfigPath: string | undefined;
    if (input.mcpConfigPath !== undefined) {
      mcpConfigPath = await validateMcpConfigPath(
        input.mcpConfigPath,
        this.config.configAllowedDirs,
      );
    }

    const args = buildClaudeCodeArgs({
      mcpConfigPath,
      permissionMode,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      persistent: true,
      oneShotPrompt: undefined,
    });

    const bridgeSessionId = randomUUID();
    this.log.debug(`starting session ${bridgeSessionId}`);
    reporter?.report('spawning claude code session');

    const child = spawnClaudeCode({
      config: this.config,
      args,
      cwd: input.cwd ?? this.config.defaultCwd,
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.log.debug(`session ${bridgeSessionId} stderr: ${chunk.trimEnd()}`);
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code ?? null));
    });
    exitPromise.then((code) => {
      this.log.debug(`session ${bridgeSessionId} child exited code=${code}`);
      this.removeInternal(bridgeSessionId, 'closed');
    });

    const chunkIterator = readStreamJson(child.stdout)[Symbol.asyncIterator]();

    const now = Date.now();
    const internal: InternalSession = {
      bridgeSessionId,
      claudeSessionId: null,
      createdAt: now,
      lastActivityAt: now,
      status: 'starting',
      child,
      chunkIterator,
      exitPromise,
      idleTimer: this.makeIdleTimer(bridgeSessionId),
      hardTimer: this.makeHardTimer(bridgeSessionId),
    };
    this.sessions.set(bridgeSessionId, internal);

    // Send the initial user message.
    child.stdin.write(formatUserMessage(input.initialPrompt));

    const collected = await collectTurn(chunkIterator, undefined, reporter);
    if (collected.systemInit) {
      const sid = (collected.systemInit as { session_id?: unknown }).session_id;
      if (typeof sid === 'string') internal.claudeSessionId = sid;
    }
    internal.status = collected.isError ? 'errored' : 'idle';
    if (collected.isError) {
      internal.errorMessage = 'Claude Code reported an error during start';
    }
    internal.lastActivityAt = Date.now();
    this.resetIdle(internal);

    return {
      session: this.toPublic(internal),
      initialText: collected.text,
    };
  }

  async send(
    sessionId: string,
    message: string,
    reporter?: ProgressReporter,
  ): Promise<{ session: BridgeSession; text: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Unknown sessionId');
    if (s.status === 'closed' || s.status === 'errored') {
      throw new Error(`Session is ${s.status}`);
    }
    if (s.status === 'busy') {
      throw new Error('Session is busy with a prior message; wait for it to complete');
    }

    s.status = 'busy';
    s.lastActivityAt = Date.now();
    this.resetIdle(s);

    try {
      reporter?.report('sending message to session');
      s.child.stdin.write(formatUserMessage(message));
      const collected = await collectTurn(s.chunkIterator, undefined, reporter);
      s.lastActivityAt = Date.now();
      s.status = collected.isError ? 'errored' : 'idle';
      if (collected.isError) {
        s.errorMessage = 'Claude Code reported an error during turn';
      }
      this.resetIdle(s);
      return { session: this.toPublic(s), text: collected.text };
    } catch (err: unknown) {
      s.status = 'errored';
      s.errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async end(sessionId: string): Promise<BridgeSession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Unknown sessionId');
    const snapshot = this.toPublic(s);
    await this.killSession(s, 'closed');
    return { ...snapshot, status: 'closed' };
  }

  get(sessionId: string): BridgeSession | null {
    const s = this.sessions.get(sessionId);
    return s ? this.toPublic(s) : null;
  }

  list(): BridgeSession[] {
    return [...this.sessions.values()].map((s) => this.toPublic(s));
  }

  async shutdown(): Promise<void> {
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => this.killSession(s, 'closed')));
  }

  // --- internal helpers ---

  private toPublic(s: InternalSession): BridgeSession {
    return {
      bridgeSessionId: s.bridgeSessionId,
      claudeSessionId: s.claudeSessionId,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      status: s.status,
      ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
    };
  }

  private resetIdle(s: InternalSession): void {
    clearTimeout(s.idleTimer);
    s.idleTimer = this.makeIdleTimer(s.bridgeSessionId);
  }

  private makeIdleTimer(sessionId: string): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.log.info(
        `session ${sessionId} idle for ${this.config.sessionIdleTimeoutMs}ms; closing`,
      );
      const s = this.sessions.get(sessionId);
      if (s) void this.killSession(s, 'closed');
    }, this.config.sessionIdleTimeoutMs);
    t.unref();
    return t;
  }

  private makeHardTimer(sessionId: string): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.log.info(
        `session ${sessionId} hit max lifetime ${this.config.sessionMaxLifetimeMs}ms; closing`,
      );
      const s = this.sessions.get(sessionId);
      if (s) void this.killSession(s, 'closed');
    }, this.config.sessionMaxLifetimeMs);
    t.unref();
    return t;
  }

  private async killSession(
    s: InternalSession,
    finalStatus: BridgeSession['status'],
  ): Promise<void> {
    clearTimeout(s.idleTimer);
    clearTimeout(s.hardTimer);
    if (!s.child.killed) {
      try {
        s.child.stdin.end();
      } catch {
        /* ignore */
      }
      s.child.kill('SIGTERM');
      const sigkillTimer = setTimeout(() => {
        if (!s.child.killed) s.child.kill('SIGKILL');
      }, 5000);
      sigkillTimer.unref();
    }
    try {
      await s.exitPromise;
    } catch {
      /* ignore */
    }
    s.status = finalStatus;
    this.sessions.delete(s.bridgeSessionId);
  }

  private removeInternal(
    sessionId: string,
    finalStatus: BridgeSession['status'],
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    clearTimeout(s.idleTimer);
    clearTimeout(s.hardTimer);
    s.status = finalStatus;
    this.sessions.delete(sessionId);
  }
}
