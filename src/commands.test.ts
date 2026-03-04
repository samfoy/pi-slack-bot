import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parseCommand, dispatchCommand, type CommandContext } from "./commands.js";

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

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const posted: Array<{ channel: string; thread_ts: string; text: string }> = [];
  const client = {
    chat: {
      postMessage: mock.fn(async (msg: any) => {
        posted.push(msg);
        return { ok: true };
      }),
    },
  } as any;

  const sessionManager = {
    list: mock.fn(() => []),
  } as any;

  return {
    channel: "C1",
    threadTs: "ts1",
    client,
    sessionManager,
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
    model: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    thinkingLevel: "off",
    abort: mock.fn(),
    newSession: mock.fn(async () => {}),
    setModel: mock.fn(async () => {}),
    setThinkingLevel: mock.fn(),
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
    assert.equal(session.newSession.mock.callCount(), 1);
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
    assert.equal(session.abort.mock.callCount(), 1);
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
    assert.equal(session.setModel.mock.callCount(), 1);
    assert.equal(session.setModel.mock.calls[0].arguments[0], "gpt-4o");
    assert.ok(getPosted(ctx)[0].includes("gpt-4o"));
  });

  it("shows current model when no args", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("model", "", ctx);
    assert.equal(session.setModel.mock.callCount(), 0);
    assert.ok(getPosted(ctx)[0].includes("claude-sonnet-4-5"));
  });

  it("reports error for unknown model", async () => {
    const session = makeSession({
      setModel: mock.fn(async () => {
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
    assert.equal(session.setThinkingLevel.mock.callCount(), 1);
    assert.equal(session.setThinkingLevel.mock.calls[0].arguments[0], "high");
    assert.ok(getPosted(ctx)[0].includes("high"));
  });

  it("rejects invalid thinking level", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("thinking", "turbo", ctx);
    assert.equal(session.setThinkingLevel.mock.callCount(), 0);
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
      list: mock.fn(() => [
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

describe("!cwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cmd-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it("changes cwd to valid directory", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session });
    await dispatchCommand("cwd", tmpDir, ctx);
    assert.equal(session.cwd, tmpDir);
    assert.ok(getPosted(ctx)[0].includes("CWD set to"));
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
    assert.equal(session.cwd, "/workspace/project"); // unchanged
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replies no active session when none exists", async () => {
    const ctx = makeCtx();
    await dispatchCommand("cwd", tmpDir, ctx);
    assert.ok(getPosted(ctx)[0].includes("No active session"));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("unknown command", () => {
  it("replies with unknown command message", async () => {
    const ctx = makeCtx();
    const result = await dispatchCommand("foobar", "", ctx);
    assert.equal(result, false);
    assert.ok(getPosted(ctx)[0].includes("Unknown command"));
    assert.ok(getPosted(ctx)[0].includes("!help"));
  });
});
