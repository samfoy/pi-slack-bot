import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  getAvailableModels,
  postModelPicker,
  handleModelSelect,
  getPendingModelPick,
  removePendingModelPick,
  _setPendingModelPick,
} from "./model-picker.js";

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

function makeModel(provider: string, id: string, opts?: { reasoning?: boolean; contextWindow?: number }) {
  return {
    id,
    name: id,
    provider,
    reasoning: opts?.reasoning ?? false,
    contextWindow: opts?.contextWindow ?? 200_000,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 8192,
    api: "anthropic",
    baseUrl: "https://api.example.com",
  };
}

function makeMockSession(models: any[], currentModel?: any) {
  return {
    cwd: "/tmp",
    model: currentModel ?? models[0] ?? null,
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
    },
    setModel: vi.fn(async (modelName: string) => {
      const found = models.find((m: any) => m.id === modelName);
      if (!found) throw new Error(`Unknown model: ${modelName}`);
    }),
    promptTemplates: [],
    enqueue: vi.fn(),
    prompt: vi.fn(),
  } as any;
}

/* ------------------------------------------------------------------ */
/*  getAvailableModels                                                 */
/* ------------------------------------------------------------------ */

describe("getAvailableModels", () => {
  it("groups models by provider", () => {
    const models = [
      makeModel("anthropic", "claude-sonnet-4-5"),
      makeModel("anthropic", "claude-haiku-3-5"),
      makeModel("google", "gemini-2.5-pro"),
    ];
    const session = makeMockSession(models);
    const grouped = getAvailableModels(session);

    assert.equal(grouped.size, 2);
    assert.equal(grouped.get("anthropic")!.length, 2);
    assert.equal(grouped.get("google")!.length, 1);
  });

  it("sorts models within provider by name", () => {
    const models = [
      makeModel("anthropic", "claude-sonnet-4-5"),
      makeModel("anthropic", "claude-haiku-3-5"),
    ];
    const session = makeMockSession(models);
    const grouped = getAvailableModels(session);
    const anthropic = grouped.get("anthropic")!;

    assert.equal(anthropic[0].id, "claude-haiku-3-5");
    assert.equal(anthropic[1].id, "claude-sonnet-4-5");
  });

  it("returns empty map when no models available", () => {
    const session = makeMockSession([]);
    const grouped = getAvailableModels(session);
    assert.equal(grouped.size, 0);
  });

  it("preserves reasoning flag", () => {
    const models = [
      makeModel("anthropic", "claude-sonnet-4-5", { reasoning: true }),
    ];
    const session = makeMockSession(models);
    const grouped = getAvailableModels(session);
    assert.equal(grouped.get("anthropic")![0].reasoning, true);
  });

  it("filters models by allowlist substrings", () => {
    const models = [
      makeModel("anthropic", "claude-opus-4-6-1m"),
      makeModel("anthropic", "claude-sonnet-4-5"),
      makeModel("anthropic", "claude-haiku-3-5"),
      makeModel("google", "gemini-2.5-pro"),
    ];
    const session = makeMockSession(models);
    const grouped = getAvailableModels(session, ["opus", "sonnet"]);

    assert.equal(grouped.size, 1); // only anthropic
    assert.equal(grouped.get("anthropic")!.length, 2);
    assert.equal(grouped.has("google"), false);
  });

  it("shows all models when allowlist is empty", () => {
    const models = [
      makeModel("anthropic", "claude-opus-4-6-1m"),
      makeModel("google", "gemini-2.5-pro"),
    ];
    const session = makeMockSession(models);
    const grouped = getAvailableModels(session, []);
    assert.equal(grouped.size, 2);
  });
});

/* ------------------------------------------------------------------ */
/*  postModelPicker                                                    */
/* ------------------------------------------------------------------ */

describe("postModelPicker", () => {
  it("posts a message with model buttons", async () => {
    const client = makeMockClient();
    const models = [
      makeModel("anthropic", "claude-sonnet-4-5"),
      makeModel("google", "gemini-2.5-pro"),
    ];
    const session = makeMockSession(models);

    await postModelPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    const msg = client.posted[0];
    assert.equal(msg.channel, "C1");
    assert.equal(msg.thread_ts, "T1");
    assert.ok(msg.blocks.length > 0);

    // Should have actions blocks with buttons
    const actionsBlocks = msg.blocks.filter((b: any) => b.type === "actions");
    assert.ok(actionsBlocks.length > 0, "should have actions blocks");
  });

  it("stores pending entry keyed by message ts", async () => {
    const client = makeMockClient();
    const models = [makeModel("anthropic", "claude-sonnet-4-5")];
    const session = makeMockSession(models);

    await postModelPicker(client, "C1", "T1", session);

    const messageTs = client.posted[0]?.ts;
    assert.ok(messageTs);
    const pending = getPendingModelPick(messageTs);
    assert.ok(pending);
    assert.equal(pending.threadTs, "T1");
    assert.equal(pending.channelId, "C1");
    assert.equal(pending.models.length, 1);
    assert.equal(pending.models[0].id, "claude-sonnet-4-5");

    removePendingModelPick(messageTs);
  });

  it("posts error when no models available", async () => {
    const client = makeMockClient();
    const session = makeMockSession([]);

    await postModelPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    assert.ok(client.posted[0].text.includes("No models available"));
  });

  it("marks current model with checkmark", async () => {
    const client = makeMockClient();
    const current = makeModel("anthropic", "claude-sonnet-4-5");
    const models = [current, makeModel("anthropic", "claude-haiku-3-5")];
    const session = makeMockSession(models, current);

    await postModelPicker(client, "C1", "T1", session);

    const msg = client.posted[0];
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions");
    // One of the buttons should have the ✅ prefix
    const hasCheckmark = actionsBlock.elements.some((el: any) => el.text.text.includes("✅"));
    assert.ok(hasCheckmark, "current model should have checkmark");
  });
});

/* ------------------------------------------------------------------ */
/*  handleModelSelect                                                  */
/* ------------------------------------------------------------------ */

describe("handleModelSelect", () => {
  it("sets the model and updates the picker message", async () => {
    const client = makeMockClient();
    const models = [
      makeModel("anthropic", "claude-sonnet-4-5"),
      makeModel("google", "gemini-2.5-pro"),
    ];
    const session = makeMockSession(models);
    const messageTs = "model-test-1";

    _setPendingModelPick(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client,
      session,
      pickerMessageTs: messageTs,
      models: [
        { id: "claude-sonnet-4-5", name: "claude-sonnet-4-5", provider: "anthropic", reasoning: false, contextWindow: 200_000 },
        { id: "gemini-2.5-pro", name: "gemini-2.5-pro", provider: "google", reasoning: false, contextWindow: 1_000_000 },
      ],
    });

    await handleModelSelect(messageTs, "1");

    // Should be consumed
    assert.equal(getPendingModelPick(messageTs), undefined);

    // Should have called setModel with the selected model
    assert.equal(session.setModel.mock.calls.length, 1);
    assert.equal(session.setModel.mock.calls[0][0], "gemini-2.5-pro");

    // Should have updated the message
    assert.ok(client.updated.length > 0);
    assert.ok(client.updated[0].text.includes("gemini-2.5-pro"));
  });

  it("ignores unknown message ts", async () => {
    await handleModelSelect("nonexistent", "0");
    // Should not throw
  });

  it("ignores invalid index", async () => {
    const client = makeMockClient();
    const session = makeMockSession([makeModel("anthropic", "claude-sonnet-4-5")]);
    const messageTs = "model-test-2";

    _setPendingModelPick(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client,
      session,
      pickerMessageTs: messageTs,
      models: [
        { id: "claude-sonnet-4-5", name: "claude-sonnet-4-5", provider: "anthropic", reasoning: false, contextWindow: 200_000 },
      ],
    });

    await handleModelSelect(messageTs, "99");

    // Should still be pending (not consumed)
    assert.ok(getPendingModelPick(messageTs));
    removePendingModelPick(messageTs);
  });

  it("shows error when setModel fails", async () => {
    const client = makeMockClient();
    const session = makeMockSession([]);
    session.setModel = vi.fn(async () => { throw new Error("Model not found"); });
    const messageTs = "model-test-3";

    _setPendingModelPick(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client,
      session,
      pickerMessageTs: messageTs,
      models: [
        { id: "bad-model", name: "bad-model", provider: "unknown", reasoning: false, contextWindow: 100_000 },
      ],
    });

    await handleModelSelect(messageTs, "0");

    // Should be consumed even on error
    assert.equal(getPendingModelPick(messageTs), undefined);

    // Should show error message
    assert.ok(client.updated.length > 0);
    assert.ok(client.updated[0].text.includes("Failed to set model"));
  });
});
