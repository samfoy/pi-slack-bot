import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StreamingUpdater } from "./streaming-updater.js";
import type { StreamingState } from "./streaming-updater.js";

function makeClient() {
  return {
    chat: {
      postMessage: mock.fn(async () => ({ ts: "msg-1" })),
      update: mock.fn(async () => ({})),
    },
    reactions: {
      add: mock.fn(async () => ({})),
      remove: mock.fn(async () => ({})),
    },
    files: {
      uploadV2: mock.fn(async () => ({})),
    },
  } as any;
}

describe("StreamingUpdater", () => {
  let realSetTimeout: typeof globalThis.setTimeout;
  let realClearTimeout: typeof globalThis.clearTimeout;
  let timers: Array<{ cb: () => void; delay: number; id: number }>;
  let nextId: number;

  beforeEach(() => {
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
    timers = [];
    nextId = 1;

    // @ts-ignore — fake timers
    globalThis.setTimeout = (cb: () => void, delay: number) => {
      const id = nextId++;
      timers.push({ cb, delay, id });
      return id;
    };
    // @ts-ignore
    globalThis.clearTimeout = (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    };
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  function flushTimers() {
    while (timers.length > 0) {
      const t = timers.shift()!;
      t.cb();
    }
  }

  it("begin posts thinking message and adds reaction", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);

    const state = await updater.begin("C1", "ts1");

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    assert.deepEqual(client.chat.postMessage.mock.calls[0].arguments[0], {
      channel: "C1",
      thread_ts: "ts1",
      text: "⏳ Thinking...",
    });
    assert.equal(client.reactions.add.mock.callCount(), 1);
    assert.equal(state.currentMessageTs, "msg-1");
    assert.equal(state.rawMarkdown, "");
  });

  it("multiple deltas within one throttle window produce single chat.update", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Hello ");
    updater.appendText(state, "world");
    updater.appendText(state, "!");

    // Only one timer should be scheduled
    assert.equal(timers.length, 1);

    // Fire the timer
    flushTimers();

    // Wait for the async flush
    await new Promise((r) => realSetTimeout(r, 10));

    assert.equal(client.chat.update.mock.callCount(), 1);
    const updateCall = client.chat.update.mock.calls[0].arguments[0];
    assert.equal(updateCall.ts, "msg-1");
    assert.ok(updateCall.text.includes("Hello world!"));
  });

  it("deltas across two throttle windows produce two chat.update calls", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    // First window
    updater.appendText(state, "First");
    assert.equal(timers.length, 1);
    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    assert.equal(client.chat.update.mock.callCount(), 1);

    // Second window
    updater.appendText(state, " Second");
    assert.equal(timers.length, 1);
    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    assert.equal(client.chat.update.mock.callCount(), 2);
  });

  it("finalize does final flush and swaps reactions", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Done");
    // Timer is pending but finalize should cancel it and flush
    assert.equal(timers.length, 1);

    await updater.finalize(state);

    // Timer should be cancelled
    assert.equal(timers.length, 0);

    // Final flush happened
    assert.equal(client.chat.update.mock.callCount(), 1);

    // Reactions swapped: hourglass removed, checkmark added
    assert.equal(client.reactions.remove.mock.callCount(), 1);
    assert.equal(
      client.reactions.remove.mock.calls[0].arguments[0].name,
      "hourglass_flowing_sand",
    );
    assert.equal(client.reactions.add.mock.callCount(), 2); // 1 from begin + 1 from finalize
    assert.equal(
      client.reactions.add.mock.calls[1].arguments[0].name,
      "white_check_mark",
    );
  });

  it("error posts error message and removes hourglass", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    await updater.error(state, new Error("something broke"));

    assert.equal(client.chat.postMessage.mock.callCount(), 2); // begin + error
    const errCall = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(errCall.text, "❌ Error: something broke");
    assert.equal(errCall.thread_ts, "ts1");

    assert.equal(client.reactions.remove.mock.callCount(), 1);
  });

  it("appendToolStart and appendToolEnd appear in flushed output", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Working...");
    updater.appendToolStart(state, "read_file", { path: "/foo.ts" });

    // Tool start triggers immediate flush (no timer needed)
    await new Promise((r) => realSetTimeout(r, 10));

    const text1 = client.chat.update.mock.calls[0].arguments[0].text;
    assert.ok(text1.includes("🔧"), "should contain tool start icon");
    assert.ok(text1.includes("read_file"), "should contain tool name");

    updater.appendToolEnd(state, "read_file", false);
    await new Promise((r) => realSetTimeout(r, 10));

    const text2 = client.chat.update.mock.calls[1].arguments[0].text;
    assert.ok(text2.includes("✅"), "should contain success summary");
    assert.ok(!text2.includes("🔧"), "wrench should be gone");
    assert.ok(!text2.includes("read_file"), "individual tool name should be collapsed into summary");
  });

  it("tool records are tracked with timing", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendToolStart(state, "read", { path: "/foo.ts" });
    assert.equal(state.toolRecords.length, 1);
    assert.equal(state.toolRecords[0].toolName, "read");
    assert.ok(state.toolRecords[0].startTime > 0);
    assert.equal(state.toolRecords[0].endTime, undefined);

    updater.appendToolEnd(state, "read", false);
    assert.ok(state.toolRecords[0].endTime !== undefined);
    assert.equal(state.toolRecords[0].isError, false);
  });

  it("finalize uploads tool log as file snippet when tools were used", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Done");
    updater.appendToolStart(state, "read", { path: "/a.ts" });
    await new Promise((r) => realSetTimeout(r, 10));
    updater.appendToolEnd(state, "read", false);
    await new Promise((r) => realSetTimeout(r, 10));

    await updater.finalize(state);

    // Should upload a file snippet
    assert.equal(client.files.uploadV2.mock.callCount(), 1);
    const uploadCall = client.files.uploadV2.mock.calls[0].arguments[0];
    assert.equal(uploadCall.channel_id, "C1");
    assert.equal(uploadCall.thread_ts, "ts1");
    assert.equal(uploadCall.filename, "tool-activity.txt");
    assert.ok(uploadCall.title.includes("1 tool call"));
    assert.ok(uploadCall.content.includes("read"));
    assert.ok(uploadCall.content.includes("/a.ts"));
  });

  it("finalize does not upload snippet when no tools were used", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Just text, no tools");
    await updater.finalize(state);

    assert.equal(client.files.uploadV2.mock.callCount(), 0);
  });

  it("finalize removes tool status from final message text", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Result text");
    updater.appendToolStart(state, "bash", { command: "ls" });
    await new Promise((r) => realSetTimeout(r, 10));
    updater.appendToolEnd(state, "bash", false);
    await new Promise((r) => realSetTimeout(r, 10));

    await updater.finalize(state);

    // Get the final chat.update call (last one)
    const updateCalls = client.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1].arguments[0];
    assert.ok(!finalUpdate.text.includes("✅"), "final message should not have tool summary");
    assert.ok(!finalUpdate.text.includes("🔧"), "final message should not have tool wrench");
    assert.ok(finalUpdate.text.includes("Result text"), "final message should have response text");
  });

  it("snippet upload failure does not break finalize", async () => {
    const client = makeClient();
    client.files.uploadV2 = mock.fn(async () => { throw new Error("upload failed"); });
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Done");
    updater.appendToolStart(state, "read", { path: "/x.ts" });
    await new Promise((r) => realSetTimeout(r, 10));
    updater.appendToolEnd(state, "read", false);
    await new Promise((r) => realSetTimeout(r, 10));

    // Should not throw
    await updater.finalize(state);

    // Reactions should still be updated
    assert.equal(client.reactions.remove.mock.callCount(), 1);
    assert.equal(client.reactions.add.mock.callCount(), 2);
  });

  it("tool start triggers immediate flush bypassing throttle timer", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Some text");
    // appendText schedules a throttled timer
    assert.equal(timers.length, 1);

    updater.appendToolStart(state, "bash", { command: "ls" });
    // Immediate flush should cancel the pending timer
    assert.equal(timers.length, 0);

    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(client.chat.update.mock.callCount(), 1);
    const text = client.chat.update.mock.calls[0].arguments[0].text;
    assert.ok(text.includes("Some text"), "should include text content");
    assert.ok(text.includes("bash"), "should include tool name");
  });

  it("tool end triggers immediate flush bypassing throttle timer", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendToolStart(state, "read_file", { path: "/a.ts" });
    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(client.chat.update.mock.callCount(), 1);

    // Append text to schedule a throttle timer
    updater.appendText(state, "reading...");
    assert.equal(timers.length, 1);

    updater.appendToolEnd(state, "read_file", true);
    // Timer cancelled by immediate flush
    assert.equal(timers.length, 0);

    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(client.chat.update.mock.callCount(), 2);
    const text = client.chat.update.mock.calls[1].arguments[0].text;
    assert.ok(text.includes("failed"), "should mention failed tools");
    assert.ok(!text.includes("🔧"), "wrench should be gone");
  });

  it("tool lines appear after text content in flushed output", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Here is some text");
    updater.appendToolStart(state, "write_file", { path: "/b.ts" });

    await new Promise((r) => realSetTimeout(r, 10));

    const text = client.chat.update.mock.calls[0].arguments[0].text;
    const textIdx = text.indexOf("Here is some text");
    const toolIdx = text.indexOf("write_file");
    assert.ok(textIdx >= 0, "text content should be present");
    assert.ok(toolIdx >= 0, "tool line should be present");
    assert.ok(textIdx < toolIdx, "text content should appear before tool lines");
  });

  it("empty content does not trigger chat.update", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    // Schedule a flush with empty content
    state.timer = null;
    await updater.finalize(state);

    assert.equal(client.chat.update.mock.callCount(), 0);
  });

  it("content exceeding msgLimit triggers split and posts overflow as new messages", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    // Use a small limit to easily trigger splitting
    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    // Generate content that exceeds 100 chars — two paragraphs
    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);

    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    // First chunk via chat.update on the original message
    assert.equal(client.chat.update.mock.callCount(), 1);
    assert.equal(client.chat.update.mock.calls[0].arguments[0].ts, "msg-1");

    // Overflow chunk(s) posted as new thread replies
    // postMessage: 1 from begin + at least 1 overflow
    assert.ok(client.chat.postMessage.mock.callCount() >= 2, "should post overflow chunk(s)");

    // The overflow postMessage should be in the same thread
    const overflowCall = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(overflowCall.thread_ts, "ts1");
  });

  it("currentMessageTs updated to last overflow message ts", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    assert.equal(state.currentMessageTs, "msg-1");

    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);

    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    // currentMessageTs should have moved to the last posted overflow
    assert.notEqual(state.currentMessageTs, "msg-1");
    // postedMessageTs should track the previous message(s)
    assert.ok(state.postedMessageTs.includes("msg-1"), "original ts should be in postedMessageTs");
  });

  it("finalize reactions target initialMessageTs even after split", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);

    await updater.finalize(state);

    // Reactions should target the initial message (msg-1), not the overflow
    const removeCall = client.reactions.remove.mock.calls[0].arguments[0];
    assert.equal(removeCall.timestamp, "msg-1");

    const addCalls = client.reactions.add.mock.calls;
    const checkmarkCall = addCalls[addCalls.length - 1].arguments[0];
    assert.equal(checkmarkCall.timestamp, "msg-1");
    assert.equal(checkmarkCall.name, "white_check_mark");
  });

  it("retries with lower limit on msg_too_long from chat.update", async () => {
    const client = makeClient();
    let updateAttempt = 0;
    client.chat.update = mock.fn(async (args: any) => {
      updateAttempt++;
      // Fail on first attempt, succeed on retry
      if (updateAttempt === 1) {
        const err = new Error("An API error occurred: msg_too_long");
        (err as any).data = { error: "msg_too_long" };
        throw err;
      }
      return {};
    });

    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    const updater = new StreamingUpdater(client, 3000, 200);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "A".repeat(150));

    await updater.finalize(state);

    // Should have retried with a smaller limit
    assert.ok(updateAttempt >= 2, `expected retry, got ${updateAttempt} attempts`);
  });

  it("subsequent flushes after split update in-place instead of posting new messages", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    // First flush: content exceeds limit, splits into 2 chunks
    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);
    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    const postCountAfterFirst = client.chat.postMessage.mock.callCount();
    const updateCountAfterFirst = client.chat.update.mock.callCount();

    // Second flush: append more text, still splits into 2 chunks
    updater.appendText(state, " more");
    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    // Should have used chat.update for BOTH existing messages, no new postMessage
    assert.equal(
      client.chat.postMessage.mock.callCount(),
      postCountAfterFirst,
      "should NOT post new messages on subsequent flush — should update in place",
    );
    assert.ok(
      client.chat.update.mock.callCount() > updateCountAfterFirst,
      "should update existing messages",
    );

    // Verify both messages are updated (msg-1 and msg-2)
    const updateCalls = client.chat.update.mock.calls;
    const lastTwoUpdates = updateCalls.slice(-2);
    const updatedTimestamps = lastTwoUpdates.map((c: any) => c.arguments[0].ts);
    assert.ok(updatedTimestamps.includes("msg-1"), "should update the initial message");
    assert.ok(updatedTimestamps.includes("msg-2"), "should update the continuation message");
  });

  it("error() truncates very long error messages", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    const longMsg = "X".repeat(5000);
    await updater.error(state, new Error(longMsg));

    const errCall = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.ok(errCall.text.length < 200, `error text should be truncated, got ${errCall.text.length}`);
    assert.ok(errCall.text.endsWith("..."), "should end with ...");
  });
});
