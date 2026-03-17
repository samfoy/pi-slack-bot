import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parseCommand, dispatchCommand, type CommandContext } from "./commands.js";
import { PinStore } from "./pin-store.js";

// --- parseCommand ---

describe("parseCommand", () => {
  it("returns null for non-command text", () => {
    assert.equal(parseCommand("hello world"), null);
    assert.equal(parseCommand(""), null);
    assert.equal(parseCommand("  no command"), null);
  });

  it("parses command with no args", () => {
    const result = parseCommand("!help");
    assert.deepEqual(result, { name: "help", args: "" });
  });

  it("parses command with args", () => {
    const result = parseCommand("!model claude-sonnet-4-5");
    assert.deepEqual(result, { name: "model", args: "claude-sonnet-4-5" });
  });

  it("lowercases command name", () => {
    const result = parseCommand("!HELP");
    assert.deepEqual(result, { name: "help", args: "" });
  });

  it("preserves args casing", () => {
    const result = parseCommand("!cwd /Workspace/MyProject");
    assert.deepEqual(result, { name: "cwd", args: "/Workspace/MyProject" });
  });

  it("handles leading whitespace", () => {
    const result = parseCommand("  !status");
    assert.deepEqual(result, { name: "status", args: "" });
  });
});

// --- helpers ---

function makePinStore(): PinStore {
  const dir = join(tmpdir(), `pin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return new PinStore(dir);
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const posted: Array<{ channel: string; thread_ts: string; text: string }> = [];
  const client = {
    chat: {
      postMessage: vi.fn(async (msg: any) => {
        posted.push(msg);
        return { ok: true };
      }),
      getPermalink: vi.fn(async () => ({ permalink: "https://slack.com/archives/C1/p123" })),
    },
    auth: {
      test: vi.fn(async () => ({ user_id: "BOT123" })),
    },
    conversations: {
      replies: vi.fn(async () => ({
        messages: [
          { ts: "1000", user: "USER1", text: "hello" },
          { ts: "1001", user: "BOT123", text: "Here is my response to your question" },
          { ts: "1002", user: "USER1", text: "!pin" },
        ],
      })),
    },
  } as any;

  const sessionManager = {
    list: vi.fn(() => []),
    dispose: vi.fn(async () => {}),
    getOrCreate: vi.fn(async () => makeSession()),
  } as any;

  return {
    channel: "C1",
    threadTs: "ts1",
    client,
    sessionManager,
    pinStore: makePinStore(),
    session: undefined,
    ...overrides,
    _posted: posted,
  } as any;
}

function getPosted(ctx: CommandContext): string[] {
  return (ctx as any)._posted.map((m: any) => m.text);
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    cwd: "/workspace/project",
    lastActivity: new Date("2026-03-04T00:00:00Z"),
    isStreaming: false,
    messageCount: 5,
    model: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    thinkingLevel: "off",
    abort: vi.fn(),
    newSession: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(),
    enqueue: vi.fn((fn: () => Promise<void>) => fn()),
    prompt: vi.fn(async () => {}),
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(async () => ({ summary: "compacted", firstKeptEntryId: "1", tokensBefore: 180000 })),
    modelRegistry: {
      getAvailable: () => [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: false, contextWindow: 200000 },
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
      ],
    },
    ...overrides,
  } as any;
}

// --- dispatchCommand ---

describe("!help", () => {
  it("posts command list", async () => {
    const ctx = makeCtx();
    await dispatchCommand("help", "", ctx);
    const msgs = getPosted(ctx);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].includes("!help"));
    assert.ok(msgs[0].includes("!cancel"));
    assert.ok(msgs[0].includes("!model"));
  });
});

describe("!new", () => {
  it("starts new session", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("new", "", ctx);
    assert.equal(session.newSession.mock.calls.length, 1);
    assert.ok(getPosted(ctx)[0].includes("New session started"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("new", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

describe("!cancel", () => {
  it("aborts active session", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("cancel", "", ctx);
    assert.equal(session.abort.mock.calls.length, 1);
    assert.ok(getPosted(ctx)[0].includes("Cancelled"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("cancel", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

describe("!status", () => {
  it("posts session info", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("status", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("claude-sonnet-4-5"));
    assert.ok(msg.includes("off"));
    assert.ok(msg.includes("5"));
    assert.ok(msg.includes("/workspace/project"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("status", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

describe("!model", () => {
  it("sets model on session", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("model", "gpt-4o", ctx);
    assert.equal(session.setModel.mock.calls.length, 1);
    assert.equal(session.setModel.mock.calls[0][0], "gpt-4o");
    assert.ok(getPosted(ctx)[0].includes("gpt-4o"));
  });

  it("shows model picker when no args", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("model", "", ctx);
    assert.equal(session.setModel.mock.calls.length, 0);
    // Should post a picker message with blocks (not just a text reply)
    const posted = (ctx as any)._posted;
    assert.ok(posted.length > 0);
    assert.ok(posted[0].text.includes("Pick a model"));
  });

  it("reports error for unknown model", async () => {
    const session = makeSession({
      setModel: vi.fn(async () => {
        throw new Error("Unknown model: nope");
      }),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("model", "nope", ctx);
    assert.ok(getPosted(ctx)[0].includes("Unknown model: nope"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("model", "gpt-4o", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

describe("!thinking", () => {
  it("sets valid thinking level", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("thinking", "high", ctx);
    assert.equal(session.setThinkingLevel.mock.calls.length, 1);
    assert.equal(session.setThinkingLevel.mock.calls[0][0], "high");
    assert.ok(getPosted(ctx)[0].includes("high"));
  });

  it("rejects invalid thinking level", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("thinking", "turbo", ctx);
    assert.equal(session.setThinkingLevel.mock.calls.length, 0);
    assert.ok(getPosted(ctx)[0].includes("Invalid level"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("thinking", "high", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

describe("!sessions", () => {
  it("lists active sessions", async () => {
    const sessionManager = {
      list: vi.fn(() => [
        {
          threadTs: "ts1",
          channelId: "C1",
          cwd: "/workspace/a",
          messageCount: 3,
          model: "claude-sonnet-4-5",
          thinkingLevel: "off",
          lastActivity: new Date(),
          isStreaming: true,
        },
        {
          threadTs: "ts2",
          channelId: "C1",
          cwd: "/workspace/b",
          messageCount: 1,
          model: "gpt-4o",
          thinkingLevel: "high",
          lastActivity: new Date(),
          isStreaming: false,
        },
      ]),
    } as any;
    const ctx = makeCtx({ sessionManager });
    await dispatchCommand("sessions", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("ts1"));
    assert.ok(msg.includes("ts2"));
    assert.ok(msg.includes("streaming"));
    assert.ok(msg.includes("idle"));
  });

  it("reports no active sessions when empty", async () => {
    const ctx = makeCtx();
    await dispatchCommand("sessions", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active sessions"));
  });
});

describe("!restart", () => {
  it("posts restart message and flushes registry", async () => {
    const sessionManager = {
      list: vi.fn(() => []),
      flushRegistry: vi.fn(async () => {}),
    } as any;
    const ctx = makeCtx({ sessionManager });

    // Mock process.exit to prevent actually exiting
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    vi.useFakeTimers();

    try {
      await dispatchCommand("restart", "", ctx);

      const msg = getPosted(ctx)[0];
      assert.ok(msg.includes("Restarting"));
      assert.equal(sessionManager.flushRegistry.mock.calls.length, 1);

      // Advance timers to trigger the delayed process.exit
      vi.advanceTimersByTime(600);
      assert.equal(exitSpy.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0][0], 75);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("!cwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cmd-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it("changes cwd by creating new session", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("cwd", tmpDir, ctx);
    assert.ok(getPosted(ctx)[0].includes("New session"));
    assert.ok(getPosted(ctx)[0].includes(tmpDir));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows current cwd when no args", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("cwd", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("/workspace/project"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects invalid path", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("cwd", "/nonexistent/path/xyz", ctx);
    assert.ok(getPosted(ctx)[0].includes("Not a valid directory"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows current cwd when no session and no args", async () => {
    const ctx = makeCtx();
    await dispatchCommand("cwd", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates session even with no prior session", async () => {
    const ctx = makeCtx();
    await dispatchCommand("cwd", tmpDir, ctx);
    assert.ok(getPosted(ctx)[0].includes("New session"));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("unknown command", () => {
  it("forwards unknown command to session when session exists", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    const result = await dispatchCommand("foobar", "some args", ctx);
    assert.equal(result, true);
    // Should have enqueued a prompt
    assert.equal(session.enqueue.mock.calls.length, 1);
  });

  it("replies no active session when no session exists", async () => {
    const ctx = makeCtx();
    const result = await dispatchCommand("foobar", "", ctx);
    assert.equal(result, false);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

// ── Context management commands ──────────────────────────────────

describe("!status with context", () => {
  it("includes context usage when available", async () => {
    const session = makeSession({
      getContextUsage: vi.fn(() => ({ tokens: 45200, contextWindow: 200000, percent: 23 })),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("status", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("Context:"), "should include context label");
    assert.ok(msg.includes("45K"), "should include formatted token count");
    assert.ok(msg.includes("200K"), "should include window size");
    assert.ok(msg.includes("23%"), "should include percentage");
  });

  it("omits context line when usage is undefined", async () => {
    const session = makeSession({
      getContextUsage: vi.fn(() => undefined),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("status", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(!msg.includes("Context:"), "should not include context when undefined");
  });
});

describe("!compact", () => {
  it("compacts and reports before/after tokens", async () => {
    const session = makeSession({
      getContextUsage: vi.fn(() => ({ tokens: 45000, contextWindow: 200000, percent: 23 })),
      compact: vi.fn(async () => ({
        summary: "compacted",
        firstKeptEntryId: "1",
        tokensBefore: 180000,
      })),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("compact", "", ctx);
    const msgs = getPosted(ctx);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].includes("Compacting"), "first message should say compacting");
    assert.ok(msgs[1].includes("180K"), "should include before tokens");
    assert.ok(msgs[1].includes("45K"), "should include after tokens");
  });

  it("rejects when streaming", async () => {
    const session = makeSession({ isStreaming: true });
    const ctx = makeCtx({ session });
    await dispatchCommand("compact", "", ctx);
    const msgs = getPosted(ctx);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].includes("Can't compact while streaming"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("compact", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });

  it("handles compact failure", async () => {
    const session = makeSession({
      compact: vi.fn(async () => { throw new Error("compaction failed"); }),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("compact", "", ctx);
    const msgs = getPosted(ctx);
    assert.ok(msgs[1].includes("Compaction failed"));
    assert.ok(msgs[1].includes("compaction failed"));
  });
});

describe("!context", () => {
  it("shows detailed context info", async () => {
    const session = makeSession({
      getContextUsage: vi.fn(() => ({ tokens: 100000, contextWindow: 200000, percent: 50 })),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("context", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("Context Window"), "should include header");
    assert.ok(msg.includes("█"), "should include bar");
    assert.ok(msg.includes("░"), "should include empty bar");
    assert.ok(msg.includes("50%"), "should include percentage");
    assert.ok(msg.includes("100K"), "should include token count");
    assert.ok(msg.includes("200K"), "should include window size");
    assert.ok(msg.includes("!compact"), "should mention compact command");
  });

  it("handles no usage available", async () => {
    const session = makeSession({
      getContextUsage: vi.fn(() => undefined),
    });
    const ctx = makeCtx({ session });
    await dispatchCommand("context", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("not available"));
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("context", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
  });
});

describe("!help includes new commands", () => {
  it("lists compact and context commands", async () => {
    const ctx = makeCtx();
    await dispatchCommand("help", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("!compact"), "should include !compact");
    assert.ok(msg.includes("!context"), "should include !context");
  });

  it("lists pin commands", async () => {
    const ctx = makeCtx();
    await dispatchCommand("help", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("!pin"), "should include !pin");
    assert.ok(msg.includes("!pins"), "should include !pins");
  });
});

// ── Pin commands ─────────────────────────────────────────────────

describe("!pin", () => {
  it("pins the bot's most recent message", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("pin", "", ctx);
    const msgs = getPosted(ctx);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].includes("📌 Pinned"));
    assert.ok(msgs[0].includes("Here is my response to your question"));
    const pins = ctx.pinStore.all;
    assert.equal(pins.length, 1);
    assert.equal(pins[0].preview, "Here is my response to your question");
    assert.equal(pins[0].permalink, "https://slack.com/archives/C1/p123");
    assert.ok(pins[0].timestamp);
    assert.equal(pins[0].channelId, "C1");
    assert.equal(pins[0].threadTs, "ts1");
  });

  it("truncates long messages to 150 chars", async () => {
    const longText = "b".repeat(200);
    const session = makeSession();
    const ctx = makeCtx({ session });
    // Override conversations.replies to return a long bot message
    (ctx.client as any).conversations.replies = vi.fn(async () => ({
      messages: [{ ts: "1001", user: "BOT123", text: longText }],
    }));
    await dispatchCommand("pin", "", ctx);
    const pin = ctx.pinStore.all[0];
    assert.equal(pin.preview.length, 151); // 150 + "…"
    assert.ok(pin.preview.endsWith("…"));
  });

  it("reports when no bot message found", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    // Only user messages, no bot messages
    (ctx.client as any).conversations.replies = vi.fn(async () => ({
      messages: [{ ts: "1000", user: "USER1", text: "hello" }],
    }));
    await dispatchCommand("pin", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No bot message found"));
    assert.equal(ctx.pinStore.all.length, 0);
  });

  it("handles API errors gracefully", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    (ctx.client as any).auth.test = vi.fn(async () => { throw new Error("auth_failed"); });
    await dispatchCommand("pin", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("Failed to pin"));
    assert.ok(getPosted(ctx)[0].includes("auth_failed"));
  });

  it("works without an active session", async () => {
    const ctx = makeCtx();
    await dispatchCommand("pin", "", ctx);
    // Should still pin — no session required
    assert.ok(getPosted(ctx)[0].includes("📌 Pinned"));
    assert.equal(ctx.pinStore.all.length, 1);
  });
});

describe("!pins", () => {
  it("lists pinned messages", async () => {
    const ctx = makeCtx();
    ctx.pinStore.add({ timestamp: "2026-03-12T20:00:00.000Z", preview: "First pinned message", permalink: "https://slack.com/p1", channelId: "C1", threadTs: "ts1" });
    ctx.pinStore.add({ timestamp: "2026-03-12T20:05:00.000Z", preview: "Second pinned message", permalink: "https://slack.com/p2", channelId: "C1", threadTs: "ts1" });
    await dispatchCommand("pins", "", ctx);
    const msg = getPosted(ctx)[0];
    assert.ok(msg.includes("📌 Pinned messages (2)"));
    assert.ok(msg.includes("First pinned message"));
    assert.ok(msg.includes("Second pinned message"));
    assert.ok(msg.includes("https://slack.com/p1"));
    assert.ok(msg.includes("https://slack.com/p2"));
  });

  it("reports no pins when empty", async () => {
    const ctx = makeCtx();
    await dispatchCommand("pins", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("No pinned messages"));
  });

  it("does not require an active session", async () => {
    const ctx = makeCtx(); // no session
    ctx.pinStore.add({ timestamp: "2026-03-12T20:00:00.000Z", preview: "A pin", permalink: "https://slack.com/p1", channelId: "C1", threadTs: "ts1" });
    await dispatchCommand("pins", "", ctx);
    assert.ok(getPosted(ctx)[0].includes("📌 Pinned messages (1)"));
  });
});
