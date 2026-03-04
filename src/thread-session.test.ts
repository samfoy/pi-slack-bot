import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ThreadSession } from "./thread-session.js";

// Minimal mock AgentSession
function makeMockAgentSession() {
  return {
    subscribe: mock.fn(() => () => {}),
    prompt: mock.fn(async () => {}),
    abort: mock.fn(async () => {}),
    dispose: mock.fn(() => {}),
    newSession: mock.fn(async () => true),
    isStreaming: false,
    messages: [],
    model: undefined,
    thinkingLevel: "off" as const,
  };
}

function makeMockUpdater() {
  return {
    begin: mock.fn(async () => ({
      channelId: "C1",
      threadTs: "ts1",
      currentMessageTs: "msg-1",
      rawMarkdown: "",
      toolLines: [],
      postedMessageTs: [],
      timer: null,
      retryCount: 0,
    })),
    appendText: mock.fn(() => {}),
    finalize: mock.fn(async () => {}),
    error: mock.fn(async () => {}),
  };
}

function makeSession(agentSession = makeMockAgentSession(), updater = makeMockUpdater()) {
  const client = { chat: { postMessage: mock.fn(async () => ({ ts: "1" })) } } as any;
  return {
    session: new ThreadSession("ts1", "C1", "/tmp", client, agentSession as any, updater as any),
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
