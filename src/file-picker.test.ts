import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createFilePickerTool,
  handleFileSelect,
  handleFileNav,
  handleFilePickCancel,
  getPendingPick,
  type FilePickerContext,
} from "./file-picker.js";

function makeTmpDir(): string {
  const base = join(tmpdir(), `fp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "tests"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# Test");
  writeFileSync(join(base, "src", "index.ts"), "export {}");
  writeFileSync(join(base, "src", "utils.ts"), "export {}");
  return base;
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

function makeContext(client: any, channelId = "C1", threadTs = "T1"): FilePickerContext {
  return { client, channelId, threadTs };
}

describe("file-picker tool definition", () => {
  it("has correct name and description", () => {
    const client = makeMockClient();
    const tool = createFilePickerTool("/tmp", () => makeContext(client));
    assert.equal(tool.name, "file_picker");
    assert.equal(tool.label, "File Picker");
    assert.ok(tool.description.includes("interactive file picker"));
  });
});

describe("file-picker execute posts buttons", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("posts a picker message and resolves when file is selected", async () => {
    const client = makeMockClient();
    const ctx = makeContext(client);
    const tool = createFilePickerTool(tmpBase, () => ctx);

    // Start the tool in the background
    const resultPromise = tool.execute("call-1", {}, undefined, undefined, {} as any);

    // Wait for the postMessage call
    await new Promise((r) => setTimeout(r, 50));

    // Verify a message was posted with blocks
    assert.ok(client.posted.length > 0);
    const postedMsg = client.posted[0];
    assert.equal(postedMsg.channel, "C1");
    assert.equal(postedMsg.thread_ts, "T1");
    assert.ok(postedMsg.blocks.length > 0);

    // Verify the first block is a section with the directory path
    const sectionBlock = postedMsg.blocks[0];
    assert.equal(sectionBlock.type, "section");
    assert.ok(sectionBlock.text.text.includes(tmpBase));

    // Simulate user selecting a file
    const messageTs = postedMsg.ts;
    await handleFileSelect(messageTs, join(tmpBase, "README.md"));

    const result = await resultPromise;
    assert.equal((result.content[0] as any).text, join(tmpBase, "README.md"));
    assert.equal((result.details as any).selectedFile, join(tmpBase, "README.md"));
  });

  it("supports directory navigation before selection", async () => {
    const client = makeMockClient();
    const ctx = makeContext(client);
    const tool = createFilePickerTool(tmpBase, () => ctx);

    const resultPromise = tool.execute("call-2", {}, undefined, undefined, {} as any);

    await new Promise((r) => setTimeout(r, 50));

    const messageTs = client.posted[0].ts;

    // Navigate into src/
    await handleFileNav(messageTs, join(tmpBase, "src"));

    // Verify the message was updated
    assert.ok(client.updated.length > 0);
    const updateCall = client.updated[0];
    assert.ok(updateCall.text.includes("src"));
    assert.ok(updateCall.blocks.length > 0);

    // Now select a file
    await handleFileSelect(messageTs, join(tmpBase, "src", "index.ts"));

    const result = await resultPromise;
    assert.equal((result.content[0] as any).text, join(tmpBase, "src", "index.ts"));
  });

  it("rejects with error when cancelled", async () => {
    const client = makeMockClient();
    const ctx = makeContext(client);
    const tool = createFilePickerTool(tmpBase, () => ctx);

    const resultPromise = tool.execute("call-3", {}, undefined, undefined, {} as any);

    await new Promise((r) => setTimeout(r, 50));

    const messageTs = client.posted[0].ts;
    await handleFilePickCancel(messageTs);

    await assert.rejects(resultPromise, /cancelled/i);
  });

  it("uses startDir parameter when provided", async () => {
    const client = makeMockClient();
    const ctx = makeContext(client);
    const tool = createFilePickerTool(tmpBase, () => ctx);

    const resultPromise = tool.execute("call-4", { startDir: "src" }, undefined, undefined, {} as any);

    await new Promise((r) => setTimeout(r, 50));

    const postedMsg = client.posted[0];
    // Should show src directory contents
    assert.ok(postedMsg.text.includes("src"));

    // Select a file
    const messageTs = postedMsg.ts;
    await handleFileSelect(messageTs, join(tmpBase, "src", "utils.ts"));

    const result = await resultPromise;
    assert.equal((result.content[0] as any).text, join(tmpBase, "src", "utils.ts"));
  });
});

describe("file-picker pending registry", () => {
  it("returns undefined for unknown message ts", () => {
    assert.equal(getPendingPick("nonexistent"), undefined);
  });

  it("handleFileSelect ignores unknown message ts", async () => {
    // Should not throw
    await handleFileSelect("nonexistent", "/some/path");
  });

  it("handleFileNav ignores unknown message ts", async () => {
    await handleFileNav("nonexistent", "/some/dir");
  });

  it("handleFilePickCancel ignores unknown message ts", async () => {
    await handleFilePickCancel("nonexistent");
  });
});
