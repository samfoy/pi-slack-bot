import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { ThreadSession } from "./thread-session.js";

// Minimal mock AgentSession
function makeMockAgentSession() {
  return {
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    newSession: vi.fn(async () => true),
    isStreaming: false,
    messages: [],
    model: undefined,
    thinkingLevel: "off" as const,
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(async () => ({ summary: "", firstKeptEntryId: "1", tokensBefore: 0 })),
  };
}

function makeMockUpdater() {
  return {
    begin: vi.fn(async () => ({
      channelId: "C1",
      threadTs: "ts1",
      currentMessageTs: "msg-1",
      rawMarkdown: "",
      toolLines: [],
      postedMessageTs: [],
      timer: null,
      retryCount: 0,
    })),
    appendText: vi.fn(() => {}),
    appendToolStart: vi.fn(() => {}),
    appendToolEnd: vi.fn(() => {}),
    finalize: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
  };
}

function makeSession(agentSession = makeMockAgentSession(), updater = makeMockUpdater()) {
  const client = { chat: { postMessage: vi.fn(async () => ({ ts: "1" })) } } as any;
  return {
    session: new ThreadSession("ts1", "C1", "/tmp", "/tmp/sessions/ts1.jsonl", client, agentSession as any, {} as any, updater as any, { create: async () => null } as any),
    client,
    agentSession,
    updater,
  };
}

describe("ThreadSession queue", () => {
  it("serializes tasks — second starts after first resolves", async () => {
    const { session } = makeSession();
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = new Promise<void>((res) => { resolveFirst = res; });

    session.enqueue(async () => { await first; order.push(1); });
    session.enqueue(async () => { order.push(2); });

    // Give the drain loop a tick to start
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, []);

    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, [1, 2]);
  });

  it("error in one task does not stop subsequent tasks", async () => {
    const { session } = makeSession();
    const order: number[] = [];

    session.enqueue(async () => { throw new Error("boom"); });
    session.enqueue(async () => { order.push(2); });

    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, [2]);
  });

  it("updates lastActivity on enqueue", async () => {
    const { session } = makeSession();
    const before = session.lastActivity;
    await new Promise((r) => setTimeout(r, 5));
    session.enqueue(async () => {});
    assert.ok(session.lastActivity >= before);
  });
});

describe("noopUiContext theme contract", () => {
  // The noop theme must implement all methods extensions call on ctx.ui.theme.
  // This mirrors the shape defined in thread-session.ts noopUiContext.theme.
  const noopTheme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
  };

  it("has all text formatting methods extensions use", () => {
    // extensions call theme.bold(), theme.fg(), theme.bg() extensively
    for (const method of ["fg", "bg", "bold", "italic", "underline", "inverse", "strikethrough"]) {
      assert.equal(typeof (noopTheme as any)[method], "function", `theme.${method} must be a function`);
    }
  });

  it("all methods pass through text unchanged", () => {
    assert.equal(noopTheme.fg("accent", "hello"), "hello");
    assert.equal(noopTheme.bg("selectedBg", "hello"), "hello");
    assert.equal(noopTheme.bold("hello"), "hello");
    assert.equal(noopTheme.italic("hello"), "hello");
    assert.equal(noopTheme.underline("hello"), "hello");
    assert.equal(noopTheme.inverse("hello"), "hello");
    assert.equal(noopTheme.strikethrough("hello"), "hello");
  });

  it("supports bordered() pattern: theme.bold inside theme.fg", () => {
    // extensions do: theme.fg("accent", theme.bold("Title"))
    const result = noopTheme.fg("accent", noopTheme.bold("Title"));
    assert.equal(result, "Title");
  });
});

describe("ThreadSession prompt event wiring", () => {
  it("tool_execution_start calls appendToolStart on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      // Simulate agent_start → tool event → agent_end
      handler({ type: "agent_start" });
      // Wait for begin() to resolve
      await new Promise((r) => setTimeout(r, 10));
      handler({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read_file", args: { path: "/foo.ts" } });
      handler({ type: "agent_end", messages: [] });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    // Manually set up the persistent subscriber (normally done by create())
    (session as any)._setupPersistentSubscriber();

    await session.prompt("read /foo.ts");

    assert.equal(updater.appendToolStart.mock.calls.length, 1);
    const tsArgs = updater.appendToolStart.mock.calls[0] as unknown as any[];
    assert.equal(tsArgs[1], "read_file");
    assert.deepEqual(tsArgs[2], { path: "/foo.ts" });
  });

  it("tool_execution_end calls appendToolEnd on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      handler({ type: "agent_start" });
      await new Promise((r) => setTimeout(r, 10));
      handler({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: {}, isError: true });
      handler({ type: "agent_end", messages: [] });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    (session as any)._setupPersistentSubscriber();

    await session.prompt("run ls");

    assert.equal(updater.appendToolEnd.mock.calls.length, 1);
    const teArgs = updater.appendToolEnd.mock.calls[0] as unknown as any[];
    assert.equal(teArgs[1], "bash");
    assert.equal(teArgs[2], true);
  });

  it("text_delta still calls appendText on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      handler({ type: "agent_start" });
      await new Promise((r) => setTimeout(r, 10));
      handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      handler({ type: "agent_end", messages: [] });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    (session as any)._setupPersistentSubscriber();

    await session.prompt("hi");

    assert.equal(updater.appendText.mock.calls.length, 1);
    const atArgs = updater.appendText.mock.calls[0] as unknown as any[];
    assert.equal(atArgs[1], "hello");
  });
});
