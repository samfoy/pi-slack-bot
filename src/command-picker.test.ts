import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  postPromptPicker,
  handlePromptSelect,
  getPendingPromptPick,
  removePendingPromptPick,
  _setPendingPromptPick,
} from "./command-picker.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

function makeMockSession(cwd: string, templates: any[] = []) {
  return {
    cwd,
    promptTemplates: templates,
    enqueue: vi.fn((fn: () => Promise<void>) => fn()),
    prompt: vi.fn(async (_text: string) => {}),
  } as any;
}

/* ------------------------------------------------------------------ */
/*  Prompt template picker                                             */
/* ------------------------------------------------------------------ */

describe("postPromptPicker", () => {
  it("posts buttons for available templates", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp", [
      { name: "review", description: "Code review", content: "", source: "", filePath: "" },
      { name: "test", description: "Generate tests", content: "", source: "", filePath: "" },
    ]);

    await postPromptPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    const msg = client.posted[0];
    assert.ok(msg.blocks.length > 0);

    // Find the actions block with buttons
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions");
    assert.ok(actionsBlock);
    assert.equal(actionsBlock.elements.length, 2);
    assert.equal(actionsBlock.elements[0].text.text, "/review");
    assert.equal(actionsBlock.elements[0].value, "review");
    assert.equal(actionsBlock.elements[1].text.text, "/test");
    assert.equal(actionsBlock.elements[1].value, "test");
  });

  it("posts error when no templates available", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp", []);

    await postPromptPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    assert.ok(client.posted[0].text.includes("No prompt templates"));
  });

  it("stores pending entry keyed by message ts", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp", [
      { name: "review", description: "Code review", content: "", source: "", filePath: "" },
    ]);

    await postPromptPicker(client, "C1", "T1", session);

    const messageTs = client.posted[0]?.ts;
    if (messageTs) {
      const pending = getPendingPromptPick(messageTs);
      assert.ok(pending);
      assert.equal(pending.threadTs, "T1");
      removePendingPromptPick(messageTs);
    }
  });
});

describe("handlePromptSelect", () => {
  it("updates message and enqueues the template command", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp");
    const messageTs = "prompt-test-1";

    _setPendingPromptPick(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client,
      session,
      pickerMessageTs: messageTs,
    });

    await handlePromptSelect(messageTs, "review");

    // Should be consumed
    assert.equal(getPendingPromptPick(messageTs), undefined);

    // Should have updated the message
    assert.ok(client.updated.length > 0);
    assert.ok(client.updated[0].text.includes("/review"));

    // Should have called prompt via enqueue
    assert.equal(session.prompt.mock.calls.length, 1);
    assert.equal(session.prompt.mock.calls[0][0], "/review");
  });

  it("ignores unknown message ts", async () => {
    await handlePromptSelect("nonexistent", "review");
    // Should not throw
  });
});
