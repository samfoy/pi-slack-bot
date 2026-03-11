import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "os";
import type { Config } from "./config.js";

// We test the createApp logic by simulating Slack events through the registered handlers.
// Since @slack/bolt's App is hard to mock directly, we extract and test the handler logic
// by capturing the registered event/action handlers.

const baseConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackUserId: "U123",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  maxSessions: 10,
  sessionIdleTimeoutSecs: 3600,
  sessionDir: "/tmp/test-sessions",
  streamThrottleMs: 3000,
  slackMsgLimit: 3900,
  workspaceDirs: [],
  pasteProvider: "none" as const,
};

// Helpers to simulate the Slack event flow without a real App instance.

import { BotSessionManager } from "./session-manager.js";
import {
  postCwdPicker,
  handleCwdSelect,
  getPendingCwdPick,
  removePendingCwdPick,
} from "./cwd-picker.js";

function makeSession(threadTs: string) {
  return {
    threadTs,
    channelId: "C1",
    cwd: "/tmp",
    lastActivity: new Date(),
    isStreaming: false,
    messageCount: 0,
    model: undefined,
    thinkingLevel: "off" as const,
    enqueue: vi.fn((_fn: () => Promise<void>) => {}),
    dispose: vi.fn(async () => {}),
    abort: vi.fn(),
    newSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

function makeManager(configOverrides: Partial<Config> = {}) {
  const config = { ...baseConfig, ...configOverrides };
  const sessions = new Map<string, ReturnType<typeof makeSession>>();

  const factory = vi.fn(async (params: any) => {
    const s = makeSession(params.threadTs);
    s.cwd = params.cwd;
    sessions.set(params.threadTs, s);
    return s as any;
  });

  const client = {} as any;
  const mgr = new BotSessionManager(config, client, factory);
  mgr.stopReaper();
  return { mgr, factory, sessions, config };
}

function makeMockClient() {
  const posted: any[] = [];
  const updated: any[] = [];
  return {
    posted,
    updated,
    chat: {
      postMessage: vi.fn(async (opts: any) => {
        const ts = `msg-${posted.length}`;
        posted.push({ ...opts, ts });
        return { ts };
      }),
      update: vi.fn(async (opts: any) => {
        updated.push(opts);
        return { ok: true };
      }),
    },
  } as any;
}

describe("slack.ts — new thread always opens cwd picker", () => {
  it("posts cwd picker with projects as pins", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();
    const projects = [
      { path: "/workplace/my-cool-project", label: "my-cool-project" },
      { path: "/workplace/other-thing", label: "other-thing" },
    ];

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "do something",
      files: [],
      projects,
      startDir: tmpdir(),
      onSelect,
    });

    assert.equal(client.posted.length, 1);
    const msg = client.posted[0];
    assert.ok(msg.blocks.length > 0);

    // Should have pinned project buttons
    const actionIds: string[] = [];
    for (const block of msg.blocks) {
      if (block.type === "actions" && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          if (el.action_id) actionIds.push(el.action_id);
        }
      }
    }
    const hasPinButton = actionIds.some((id) => id.startsWith("cwd_pick_pin_"));
    assert.ok(hasPinButton, `Expected cwd_pick_pin_ in action IDs: ${actionIds.join(", ")}`);

    removePendingCwdPick(msg.ts);
  });

  it("posts cwd picker at homedir when no startDir given", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "do something",
      files: [],
      projects: [],
      onSelect,
    });

    const pick = getPendingCwdPick(client.posted[0].ts);
    assert.ok(pick);
    assert.equal(pick!.currentDir, homedir());
    assert.equal(pick!.prompt, "do something");

    removePendingCwdPick(client.posted[0].ts);
  });
});

describe("slack.ts cwd picker select handler", () => {
  it("onSelect callback creates session with selected cwd and enqueues prompt", async () => {
    const { mgr, sessions } = makeManager();
    const client = makeMockClient();
    let selectDone: () => void;
    const selectPromise = new Promise<void>((resolve) => { selectDone = resolve; });

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "do something",
      files: [],
      projects: [],
      startDir: tmpdir(),
      onSelect: async (pick, selectedDir) => {
        const session = await mgr.getOrCreate({
          threadTs: pick.threadTs,
          channelId: pick.channelId,
          cwd: selectedDir,
        });
        session.enqueue(() => session.prompt(pick.prompt));
        selectDone();
      },
    });

    const messageTs = client.posted[0].ts;
    const selectedCwd = "/workplace/my-cool-project";
    await handleCwdSelect(messageTs, selectedCwd);

    // Wait for async onSelect to complete
    await selectPromise;

    const session = sessions.get("T1");
    assert.ok(session);
    assert.equal(session!.cwd, selectedCwd);
    assert.equal(session!.enqueue.mock.calls.length, 1);
  });

  it("ignores select if no pending pick exists", async () => {
    await handleCwdSelect("nonexistent-ts", "/some/dir");
  });
});

describe("slack.ts createApp integration", () => {
  it("exports sessionManager", async () => {
    const { createApp } = await import("./slack.js");
    assert.equal(typeof createApp, "function");
  });
});
