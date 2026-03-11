import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { writeFileSync } from "fs";
import path from "path";
import os from "os";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import { SessionRegistry } from "./session-registry.js";
import type { Config } from "./config.js";

const baseConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackUserId: "U123",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  maxSessions: 2,
  sessionIdleTimeoutSecs: 3600,
  sessionDir: "/tmp/test-sessions",
  streamThrottleMs: 3000,
  slackMsgLimit: 3900,
  workspaceDirs: [],
  pasteProvider: "none" as const,
};

function makeSession(threadTs: string, cwd = "/tmp", sessionPath = `/tmp/sessions/${threadTs}.jsonl`) {
  return {
    threadTs,
    channelId: "C1",
    cwd,
    sessionPath,
    lastActivity: new Date(),
    isStreaming: false,
    messageCount: 0,
    model: undefined,
    thinkingLevel: "off" as const,
    enqueue: vi.fn(),
    dispose: vi.fn(async () => {}),
    abort: vi.fn(),
    newSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

function makeManager(configOverrides: Partial<Config> = {}, registry?: SessionRegistry) {
  const config = { ...baseConfig, ...configOverrides };
  const client = {
    chat: {
      postMessage: vi.fn(async () => ({ ts: "msg-ts" })),
    },
  } as any;
  const sessions = new Map<string, ReturnType<typeof makeSession>>();

  const factory = vi.fn(async (params: any) => {
    const s = makeSession(
      params.threadTs,
      params.cwd,
      params.resumeSessionPath ?? `/tmp/sessions/${params.threadTs}.jsonl`,
    );
    sessions.set(params.threadTs, s);
    return s as any;
  });

  const mgr = new BotSessionManager(config, client, factory, registry);
  mgr.stopReaper(); // don't let the interval run during tests
  return { mgr, factory, sessions, client };
}

describe("BotSessionManager", () => {
  it("creates a new session and returns it", async () => {
    const { mgr, factory } = makeManager();
    const s = await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    assert.equal(s.threadTs, "ts1");
    assert.equal(factory.mock.calls.length, 1);
    mgr.disposeRegistry();
  });

  it("returns the same session for the same threadTs", async () => {
    const { mgr, factory } = makeManager();
    const s1 = await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    const s2 = await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    assert.equal(s1, s2);
    assert.equal(factory.mock.calls.length, 1);
    mgr.disposeRegistry();
  });

  it("throws SessionLimitError when at max capacity", async () => {
    const { mgr } = makeManager({ maxSessions: 2 });
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });
    await assert.rejects(
      () => mgr.getOrCreate({ threadTs: "ts3", channelId: "C1", cwd: "/tmp" }),
      SessionLimitError,
    );
    mgr.disposeRegistry();
  });

  it("dispose removes session from map and calls session.dispose", async () => {
    const { mgr, sessions } = makeManager();
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    assert.equal(mgr.count(), 1);

    await mgr.dispose("ts1");
    assert.equal(mgr.count(), 0);
    assert.equal(sessions.get("ts1")!.dispose.mock.calls.length, 1);
    mgr.disposeRegistry();
  });

  it("idle reaper disposes sessions past timeout", async () => {
    const { mgr, sessions } = makeManager({ sessionIdleTimeoutSecs: 1 });

    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    // Backdate lastActivity to simulate idle
    sessions.get("ts1")!.lastActivity = new Date(Date.now() - 2000);

    // Manually trigger reap via private method
    await (mgr as any)._reap();

    assert.equal(mgr.count(), 0);
    assert.equal(sessions.get("ts1")!.dispose.mock.calls.length, 1);
    mgr.disposeRegistry();
  });

  it("disposeAll disposes every session", async () => {
    const { mgr, sessions } = makeManager();
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });

    await mgr.disposeAll();
    assert.equal(mgr.count(), 0);
    assert.equal(sessions.get("ts1")!.dispose.mock.calls.length, 1);
    assert.equal(sessions.get("ts2")!.dispose.mock.calls.length, 1);
    mgr.disposeRegistry();
  });

  it("list returns info for all sessions", async () => {
    const { mgr } = makeManager();
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    const list = mgr.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].threadTs, "ts1");
    mgr.disposeRegistry();
  });
});

describe("BotSessionManager — registry integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mgr-registry-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("getOrCreate persists to registry", async () => {
    const registry = new SessionRegistry(tmpDir, 0); // no debounce for test
    const sessionsDir = path.join(tmpDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const config = { ...baseConfig, sessionDir: tmpDir };
    const client = { chat: { postMessage: vi.fn(async () => ({ ts: "msg-ts" })) } } as any;
    const factory = vi.fn(async (params: any) => {
      // Create a real session file so load() finds it
      const sp = path.join(sessionsDir, `${params.threadTs}.jsonl`);
      writeFileSync(sp, "", "utf-8");
      return makeSession(params.threadTs, params.cwd, sp) as any;
    });
    const mgr = new BotSessionManager(config, client, factory, registry);
    mgr.stopReaper();

    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp/proj" });
    await mgr.flushRegistry();

    const entries = await registry.load();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].threadTs, "ts1");
    assert.equal(entries[0].cwd, "/tmp/proj");
    mgr.disposeRegistry();
  });

  it("dispose removes entry from registry", async () => {
    const registry = new SessionRegistry(tmpDir, 0);
    const sessionsDir = path.join(tmpDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const config = { ...baseConfig, sessionDir: tmpDir };
    const client = { chat: { postMessage: vi.fn(async () => ({ ts: "msg-ts" })) } } as any;
    const factory = vi.fn(async (params: any) => {
      const sp = path.join(sessionsDir, `${params.threadTs}.jsonl`);
      writeFileSync(sp, "", "utf-8");
      return makeSession(params.threadTs, params.cwd, sp) as any;
    });
    const mgr = new BotSessionManager(config, client, factory, registry);
    mgr.stopReaper();

    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });
    await mgr.flushRegistry();

    await mgr.dispose("ts1");
    await mgr.flushRegistry();

    const entries = await registry.load();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].threadTs, "ts2");
    mgr.disposeRegistry();
  });

  it("disposeAll clears the registry", async () => {
    const registry = new SessionRegistry(tmpDir, 0);
    const sessionsDir = path.join(tmpDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const config = { ...baseConfig, sessionDir: tmpDir };
    const client = { chat: { postMessage: vi.fn(async () => ({ ts: "msg-ts" })) } } as any;
    const factory = vi.fn(async (params: any) => {
      const sp = path.join(sessionsDir, `${params.threadTs}.jsonl`);
      writeFileSync(sp, "", "utf-8");
      return makeSession(params.threadTs, params.cwd, sp) as any;
    });
    const mgr = new BotSessionManager(config, client, factory, registry);
    mgr.stopReaper();

    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });
    await mgr.flushRegistry();

    await mgr.disposeAll();
    await mgr.flushRegistry();

    const entries = await registry.load();
    assert.equal(entries.length, 0);
    mgr.disposeRegistry();
  });
});

describe("BotSessionManager — restoreAll", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mgr-restore-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("restores sessions from registry and posts reconnection message", async () => {
    const registry = new SessionRegistry(tmpDir);

    // Pre-populate registry with a session entry
    const sessionFile = path.join(tmpDir, "ts1.jsonl");
    writeFileSync(sessionFile, "", "utf-8");

    await registry.save([{
      threadTs: "ts1",
      channelId: "C1",
      cwd: "/tmp/project",
      sessionPath: sessionFile,
    }]);

    const { mgr, factory, client } = makeManager({ sessionDir: tmpDir }, registry);

    const restored = await mgr.restoreAll();

    assert.equal(restored, 1);
    assert.equal(mgr.count(), 1);
    assert.equal(factory.mock.calls.length, 1);

    // Verify resumeSessionPath was passed
    assert.equal(factory.mock.calls[0][0].resumeSessionPath, sessionFile);

    // Verify reconnection message was posted
    assert.equal(client.chat.postMessage.mock.calls.length, 1);
    const postCall = client.chat.postMessage.mock.calls[0][0];
    assert.equal(postCall.channel, "C1");
    assert.equal(postCall.thread_ts, "ts1");
    assert.ok(postCall.text.includes("restored"));

    mgr.disposeRegistry();
  });

  it("restores multiple sessions in parallel", async () => {
    const registry = new SessionRegistry(tmpDir);

    const f1 = path.join(tmpDir, "ts1.jsonl");
    const f2 = path.join(tmpDir, "ts2.jsonl");
    writeFileSync(f1, "", "utf-8");
    writeFileSync(f2, "", "utf-8");

    await registry.save([
      { threadTs: "ts1", channelId: "C1", cwd: "/tmp/p1", sessionPath: f1 },
      { threadTs: "ts2", channelId: "C2", cwd: "/tmp/p2", sessionPath: f2 },
    ]);

    const { mgr, client } = makeManager({ sessionDir: tmpDir }, registry);

    const restored = await mgr.restoreAll();

    assert.equal(restored, 2);
    assert.equal(mgr.count(), 2);
    assert.equal(client.chat.postMessage.mock.calls.length, 2);

    mgr.disposeRegistry();
  });

  it("returns 0 for empty registry", async () => {
    const registry = new SessionRegistry(tmpDir);
    const { mgr } = makeManager({ sessionDir: tmpDir }, registry);

    const restored = await mgr.restoreAll();

    assert.equal(restored, 0);
    assert.equal(mgr.count(), 0);

    mgr.disposeRegistry();
  });

  it("skips sessions that fail to create and continues", async () => {
    const registry = new SessionRegistry(tmpDir);

    const f1 = path.join(tmpDir, "ts1.jsonl");
    const f2 = path.join(tmpDir, "ts2.jsonl");
    writeFileSync(f1, "", "utf-8");
    writeFileSync(f2, "", "utf-8");

    await registry.save([
      { threadTs: "ts1", channelId: "C1", cwd: "/tmp/p1", sessionPath: f1 },
      { threadTs: "ts2", channelId: "C2", cwd: "/tmp/p2", sessionPath: f2 },
    ]);

    // Create manager with a factory that fails for ts1
    const config = { ...baseConfig, sessionDir: tmpDir };
    const client = {
      chat: { postMessage: vi.fn(async () => ({ ts: "msg-ts" })) },
    } as any;

    const factory = vi.fn(async (params: any) => {
      if (params.threadTs === "ts1") throw new Error("boom");
      return makeSession(params.threadTs, params.cwd, params.resumeSessionPath) as any;
    });

    const mgr = new BotSessionManager(config, client, factory, registry);
    mgr.stopReaper();

    const restored = await mgr.restoreAll();

    assert.equal(restored, 1);
    assert.equal(mgr.count(), 1);
    assert.ok(mgr.get("ts2"));
    assert.ok(!mgr.get("ts1"));

    // Only one reconnection message (for the successful one)
    assert.equal(client.chat.postMessage.mock.calls.length, 1);

    mgr.disposeRegistry();
  });

  it("skips sessions that are already active (race condition)", async () => {
    const registry = new SessionRegistry(tmpDir);

    const f1 = path.join(tmpDir, "ts1.jsonl");
    writeFileSync(f1, "", "utf-8");

    await registry.save([
      { threadTs: "ts1", channelId: "C1", cwd: "/tmp/p1", sessionPath: f1 },
    ]);

    const { mgr, factory } = makeManager({ sessionDir: tmpDir }, registry);

    // Simulate a message arriving first and creating the session
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp/p1" });
    assert.equal(factory.mock.calls.length, 1);

    // Now restore — should skip ts1 since it's already active
    const restored = await mgr.restoreAll();

    assert.equal(restored, 1); // counts as success (already active)
    assert.equal(factory.mock.calls.length, 1); // no additional factory call
    assert.equal(mgr.count(), 1);

    // restoreAll doesn't post reconnection for already-active sessions
    // (getOrCreate returns existing, so _restoreOne skips the Slack post)
    // Actually, _restoreOne checks _sessions.has() and returns true early

    mgr.disposeRegistry();
  });
});

describe("BotSessionManager — edge cases", () => {
  it("session limit reached then freed allows new session", async () => {
    const { mgr } = makeManager({ maxSessions: 1 });
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });

    // At limit
    await assert.rejects(
      () => mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" }),
      SessionLimitError,
    );

    // Free one
    await mgr.dispose("ts1");

    // Should succeed now
    const s = await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });
    assert.equal(s.threadTs, "ts2");
    mgr.disposeRegistry();
  });

  it("reaper skips sessions that are still active (not idle)", async () => {
    const { mgr, sessions } = makeManager({ sessionIdleTimeoutSecs: 1 });
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });

    // Make ts1 idle, keep ts2 active
    sessions.get("ts1")!.lastActivity = new Date(Date.now() - 2000);
    sessions.get("ts2")!.lastActivity = new Date();

    await (mgr as any)._reap();

    assert.equal(mgr.count(), 1);
    assert.ok(mgr.get("ts2"), "active session should survive reap");
    assert.ok(!mgr.get("ts1"), "idle session should be reaped");
    mgr.disposeRegistry();
  });

  it("dispose of non-existent session is a no-op", async () => {
    const { mgr } = makeManager();
    // Should not throw
    await mgr.dispose("nonexistent");
    assert.equal(mgr.count(), 0);
    mgr.disposeRegistry();
  });
});
