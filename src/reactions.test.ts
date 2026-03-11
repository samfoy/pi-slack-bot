import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { handleReaction, REACTION_MAP } from "./reactions.js";

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ok: true })),
    },
  } as any;
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    cwd: "/workspace/project",
    isStreaming: false,
    lastUserPrompt: null as string | null,
    abort: vi.fn(),
    enqueue: vi.fn((fn: () => Promise<void>) => fn()),
    prompt: vi.fn(async () => {}),
    pasteProvider: { create: async () => null },
    getContextUsage: vi.fn(() => ({ tokens: 45000, contextWindow: 200000, percent: 23 })),
    compact: vi.fn(async () => ({ summary: "compacted", firstKeptEntryId: "1", tokensBefore: 180000 })),
    ...overrides,
  } as any;
}

function getPosted(client: any): string[] {
  return client.chat.postMessage.mock.calls.map((c: any) => c[0].text);
}

describe("REACTION_MAP", () => {
  it("maps x to cancel", () => {
    assert.equal(REACTION_MAP["x"], "cancel");
  });

  it("maps arrows_counterclockwise to retry", () => {
    assert.equal(REACTION_MAP["arrows_counterclockwise"], "retry");
  });

  it("maps clipboard to diff", () => {
    assert.equal(REACTION_MAP["clipboard"], "diff");
  });

  it("maps clamp to compact", () => {
    assert.equal(REACTION_MAP["clamp"], "compact");
  });
});

describe("handleReaction", () => {
  it("returns false for unknown emoji", async () => {
    const client = makeClient();
    const session = makeSession();
    const result = await handleReaction("thumbsup", session, client, "C1", "ts1");
    assert.equal(result, false);
    assert.equal(client.chat.postMessage.mock.calls.length, 0);
  });

  it("cancel: aborts session and posts message", async () => {
    const client = makeClient();
    const session = makeSession();
    const result = await handleReaction("x", session, client, "C1", "ts1");
    assert.equal(result, true);
    assert.equal(session.abort.mock.calls.length, 1);
    assert.ok(getPosted(client)[0].includes("Cancelled"));
  });

  it("retry: retries last prompt", async () => {
    const client = makeClient();
    const session = makeSession({ lastUserPrompt: "explain this code" });
    const result = await handleReaction("arrows_counterclockwise", session, client, "C1", "ts1");
    assert.equal(result, true);
    assert.ok(getPosted(client)[0].includes("Retrying"));
    assert.ok(getPosted(client)[0].includes("explain this code"));
    assert.equal(session.enqueue.mock.calls.length, 1);
  });

  it("retry: posts message when no previous prompt", async () => {
    const client = makeClient();
    const session = makeSession({ lastUserPrompt: null });
    const result = await handleReaction("arrows_counterclockwise", session, client, "C1", "ts1");
    assert.equal(result, true);
    assert.ok(getPosted(client)[0].includes("No previous prompt"));
    assert.equal(session.enqueue.mock.calls.length, 0);
  });

  it("retry: truncates long prompts in confirmation message", async () => {
    const client = makeClient();
    const longPrompt = "x".repeat(200);
    const session = makeSession({ lastUserPrompt: longPrompt });
    await handleReaction("arrows_counterclockwise", session, client, "C1", "ts1");
    const msg = getPosted(client)[0];
    assert.ok(msg.length < 200, "confirmation should be truncated");
    assert.ok(msg.includes("…"), "should have ellipsis");
  });

  it("compact: compacts and reports tokens", async () => {
    const client = makeClient();
    const session = makeSession();
    const result = await handleReaction("clamp", session, client, "C1", "ts1");
    assert.equal(result, true);
    const msgs = getPosted(client);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].includes("Compacting"));
    assert.ok(msgs[1].includes("180K"));
    assert.ok(msgs[1].includes("45K"));
  });

  it("compact: rejects while streaming", async () => {
    const client = makeClient();
    const session = makeSession({ isStreaming: true });
    const result = await handleReaction("clamp", session, client, "C1", "ts1");
    assert.equal(result, true);
    assert.ok(getPosted(client)[0].includes("Can't compact while streaming"));
    assert.equal(session.compact.mock.calls.length, 0);
  });

  it("compact: handles failure", async () => {
    const client = makeClient();
    const session = makeSession({
      compact: vi.fn(async () => { throw new Error("compaction failed"); }),
    });
    const result = await handleReaction("clamp", session, client, "C1", "ts1");
    assert.equal(result, true);
    const msgs = getPosted(client);
    assert.ok(msgs[1].includes("Compaction failed"));
  });

  it("diff: posts no changes message when no diff", async () => {
    const client = makeClient();
    const session = makeSession({ cwd: "/tmp/nonexistent-repo-" + Date.now() });
    const result = await handleReaction("clipboard", session, client, "C1", "ts1");
    assert.equal(result, true);
    assert.ok(getPosted(client)[0].includes("No uncommitted changes"));
  });
});
