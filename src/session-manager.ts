import fs from "fs/promises";
import type { WebClient } from "@slack/web-api";
import type { Config, ThinkingLevel } from "./config.js";
import { ThreadSession, type ThreadSessionCreateParams } from "./thread-session.js";
import { SessionRegistry, type SessionEntry } from "./session-registry.js";
import { createLogger } from "./logger.js";

const log = createLogger("session-manager");

export class SessionLimitError extends Error {
  constructor() {
    super("Too many active sessions");
    this.name = "SessionLimitError";
  }
}

export interface ThreadSessionInfo {
  threadTs: string;
  channelId: string;
  cwd: string;
  messageCount: number;
  model: string;
  thinkingLevel: ThinkingLevel;
  lastActivity: Date;
  isStreaming: boolean;
}

export interface GetOrCreateParams {
  threadTs: string;
  channelId: string;
  cwd: string;
  /** If set, resume from this existing session file instead of creating a new one. */
  resumeSessionPath?: string;
}

type SessionFactory = (params: ThreadSessionCreateParams) => Promise<ThreadSession>;

export class BotSessionManager {
  private _sessions = new Map<string, ThreadSession>();
  private _reaper: ReturnType<typeof setInterval>;
  private _registry: SessionRegistry;

  constructor(
    private _config: Config,
    private _client: WebClient,
    private _factory: SessionFactory = ThreadSession.create,
    registry?: SessionRegistry,
  ) {
    this._registry = registry ?? new SessionRegistry(_config.sessionDir);
    this._reaper = setInterval(() => void this._reap(), 60_000);
  }

  get(threadTs: string): ThreadSession | undefined {
    return this._sessions.get(threadTs);
  }

  async getOrCreate(params: GetOrCreateParams): Promise<ThreadSession> {
    const existing = this._sessions.get(params.threadTs);
    if (existing) return existing;

    if (this._sessions.size >= this._config.maxSessions) {
      throw new SessionLimitError();
    }

    await fs.mkdir(this._config.sessionDir, { recursive: true });

    const session = await this._factory({
      ...params,
      config: this._config,
      client: this._client,
      sessionDir: this._config.sessionDir,
    });

    this._sessions.set(params.threadTs, session);
    this._persistRegistry();
    return session;
  }

  async dispose(threadTs: string): Promise<void> {
    const session = this._sessions.get(threadTs);
    if (session) {
      this._sessions.delete(threadTs);
      await session.dispose();
      this._persistRegistry();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this._sessions.keys()].map((ts) => this.dispose(ts)));
  }

  /**
   * Restore sessions from the on-disk registry.
   * Called once on startup after the Slack app is connected.
   * Posts a reconnection message to each restored thread.
   *
   * Individual session failures are logged and skipped — never crashes the bot.
   * Returns the number of sessions successfully restored.
   */
  async restoreAll(): Promise<number> {
    const entries = await this._registry.load();
    if (entries.length === 0) return 0;

    log.info("Restoring sessions from registry", { count: entries.length });

    const results = await Promise.allSettled(
      entries.map((entry) => this._restoreOne(entry)),
    );

    let restored = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        restored++;
      }
    }

    // Re-persist to clean up any entries that failed to restore
    this._persistRegistry();

    log.info("Restored sessions", { restored, total: entries.length });
    return restored;
  }

  list(): ThreadSessionInfo[] {
    return [...this._sessions.values()].map((s) => ({
      threadTs: s.threadTs,
      channelId: s.channelId,
      cwd: s.cwd,
      messageCount: s.messageCount,
      model: s.model?.id ?? "unknown",
      thinkingLevel: s.thinkingLevel,
      lastActivity: s.lastActivity,
      isStreaming: s.isStreaming,
    }));
  }

  count(): number {
    return this._sessions.size;
  }

  get sessionDir(): string {
    return this._config.sessionDir;
  }

  stopReaper(): void {
    clearInterval(this._reaper);
  }

  /** Dispose the registry (cancel pending saves). Call on shutdown. */
  disposeRegistry(): void {
    this._registry.dispose();
  }

  /** Flush any pending registry writes. Useful for testing. */
  async flushRegistry(): Promise<void> {
    await this._registry.flush();
  }

  private async _restoreOne(entry: SessionEntry): Promise<boolean> {
    // Skip if a session for this thread was already created (e.g., by an incoming message)
    if (this._sessions.has(entry.threadTs)) {
      log.info("Skipping restore — already active", { threadTs: entry.threadTs });
      return true;
    }

    try {
      await this.getOrCreate({
        threadTs: entry.threadTs,
        channelId: entry.channelId,
        cwd: entry.cwd,
        resumeSessionPath: entry.sessionPath,
      });

      await this._client.chat.postMessage({
        channel: entry.channelId,
        thread_ts: entry.threadTs,
        text: "🔄 Session restored after restart.",
      });

      return true;
    } catch (err) {
      log.error("Failed to restore session", { threadTs: entry.threadTs, error: err });
      return false;
    }
  }

  /**
   * Build the current entries list from in-memory sessions and schedule a debounced save.
   */
  private _persistRegistry(): void {
    const entries: SessionEntry[] = [...this._sessions.values()].map((s) => ({
      threadTs: s.threadTs,
      channelId: s.channelId,
      cwd: s.cwd,
      sessionPath: s.sessionPath,
    }));
    this._registry.scheduleSave(entries);
  }

  private async _reap(): Promise<void> {
    const now = Date.now();
    const timeout = this._config.sessionIdleTimeoutSecs * 1000;
    for (const [ts, session] of this._sessions) {
      if (now - session.lastActivity.getTime() > timeout) {
        await this.dispose(ts);
      }
    }
  }
}
