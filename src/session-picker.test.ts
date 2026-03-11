import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  getPendingResume,
  removePendingResume,
  handleResumeProjectSelect,
  handleResumeSessionSelect,
  postToTuiCommand,
} from "./session-picker.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fakeClient() {
  const posted: any[] = [];
  const updated: any[] = [];
  return {
    chat: {
      postMessage: vi.fn(async (args: any) => {
        posted.push(args);
        return { ts: `msg_${posted.length}` };
      }),
      update: vi.fn(async (args: any) => {
        updated.push(args);
      }),
    },
    posted,
    updated,
  };
}

/* ------------------------------------------------------------------ */
/*  postToTuiCommand                                                   */
/* ------------------------------------------------------------------ */

describe("postToTuiCommand", () => {
  it("posts session path when session exists", async () => {
    const client = fakeClient();
    const session = {
      cwd: "/home/test/project",
      messageCount: 5,
    } as any;

    await postToTuiCommand(client as any, "C123", "T456", session, "/tmp/sessions");

    assert.equal(client.posted.length, 1);
    const text = client.posted[0].text;
    // Path includes cwd-encoded subdirectory
    assert.ok(text.includes("pi --session /tmp/sessions/--home-test-project--/T456.jsonl"));
    assert.ok(text.includes("/home/test/project"));
  });

  it("posts error when no session", async () => {
    const client = fakeClient();
    await postToTuiCommand(client as any, "C123", "T456", undefined, "/tmp/sessions");

    assert.equal(client.posted.length, 1);
    assert.ok(client.posted[0].text.includes("No active session"));
  });
});

/* ------------------------------------------------------------------ */
/*  Pending resume registry                                            */
/* ------------------------------------------------------------------ */

describe("pending resume registry", () => {
  it("get/remove work", () => {
    assert.equal(getPendingResume("nonexistent"), undefined);
    // removePendingResume on nonexistent should not throw
    removePendingResume("nonexistent");
  });
});

/* ------------------------------------------------------------------ */
/*  handleResumeSessionSelect                                          */
/* ------------------------------------------------------------------ */

describe("handleResumeSessionSelect", () => {
  it("ignores unknown messageTs", async () => {
    // Should not throw
    await handleResumeSessionSelect("unknown_ts", "/some/path.jsonl");
  });
});

describe("handleResumeProjectSelect", () => {
  it("ignores unknown messageTs", async () => {
    // Should not throw
    await handleResumeProjectSelect("unknown_ts", "/some/dir");
  });
});
