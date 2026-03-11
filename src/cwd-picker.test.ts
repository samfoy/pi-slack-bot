import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildCwdPickerBlocks,
  listDirs,
  postCwdPicker,
  handleCwdSelect,
  handleCwdNav,
  handleCwdCancel,
  getPendingCwdPick,
  removePendingCwdPick,
} from "./cwd-picker.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeTmpDir(): string {
  const base = join(tmpdir(), `cwd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(base, "alpha"), { recursive: true });
  mkdirSync(join(base, "beta"), { recursive: true });
  mkdirSync(join(base, ".hidden"), { recursive: true });
  // Create a file (should not show in cwd picker)
  writeFileSync(join(base, "readme.txt"), "hello");
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

/* ------------------------------------------------------------------ */
/*  listDirs                                                           */
/* ------------------------------------------------------------------ */

describe("listDirs", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("lists only directories, excludes hidden and files", () => {
    const dirs = listDirs(tmpBase);
    const names = dirs.map((d) => d.name);
    assert.deepEqual(names, ["alpha", "beta"]);
  });

  it("returns full paths", () => {
    const dirs = listDirs(tmpBase);
    assert.ok(dirs[0].fullPath.endsWith("/alpha"));
  });

  it("sorts alphabetically", () => {
    // Create dirs in reverse order
    const base = join(tmpdir(), `cwd-sort-${Date.now()}`);
    mkdirSync(join(base, "zulu"), { recursive: true });
    mkdirSync(join(base, "alpha"), { recursive: true });
    mkdirSync(join(base, "mike"), { recursive: true });
    const dirs = listDirs(base);
    assert.deepEqual(dirs.map((d) => d.name), ["alpha", "mike", "zulu"]);
    rmSync(base, { recursive: true, force: true });
  });

  it("returns empty array for nonexistent dir", () => {
    const dirs = listDirs("/nonexistent-path-xyz");
    assert.deepEqual(dirs, []);
  });
});

/* ------------------------------------------------------------------ */
/*  buildCwdPickerBlocks                                               */
/* ------------------------------------------------------------------ */

describe("buildCwdPickerBlocks", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("includes a header section with the current path", () => {
    const blocks = buildCwdPickerBlocks(tmpBase, []);
    const header = blocks[0] as any;
    assert.equal(header.type, "section");
    assert.ok(header.text.text.includes(tmpBase));
  });

  it("includes Select, Parent, and Cancel buttons", () => {
    const blocks = buildCwdPickerBlocks(tmpBase, []);
    const controls = blocks[1] as any;
    assert.equal(controls.type, "actions");
    const actionIds = controls.elements.map((e: any) => e.action_id);
    assert.ok(actionIds.includes("cwd_pick_select"));
    assert.ok(actionIds.includes("cwd_pick_parent"));
    assert.ok(actionIds.includes("cwd_pick_cancel"));
  });

  it("Select button has primary style", () => {
    const blocks = buildCwdPickerBlocks(tmpBase, []);
    const controls = blocks[1] as any;
    const selectBtn = controls.elements.find((e: any) => e.action_id === "cwd_pick_select");
    assert.equal(selectBtn.style, "primary");
  });

  it("Cancel button has danger style", () => {
    const blocks = buildCwdPickerBlocks(tmpBase, []);
    const controls = blocks[1] as any;
    const cancelBtn = controls.elements.find((e: any) => e.action_id === "cwd_pick_cancel");
    assert.equal(cancelBtn.style, "danger");
  });

  it("hides Parent button at root /", () => {
    const blocks = buildCwdPickerBlocks("/", []);
    const controls = blocks[1] as any;
    const actionIds = controls.elements.map((e: any) => e.action_id);
    assert.ok(!actionIds.includes("cwd_pick_parent"));
  });

  it("shows directory entries as nav buttons", () => {
    const blocks = buildCwdPickerBlocks(tmpBase, []);
    // Find blocks with cwd_pick_nav_ action IDs
    const navBlocks = blocks.filter((b: any) =>
      b.type === "actions" && b.elements?.some((e: any) => e.action_id.startsWith("cwd_pick_nav_"))
    );
    assert.ok(navBlocks.length > 0);
    const allNavButtons = navBlocks.flatMap((b: any) => b.elements);
    const labels = allNavButtons.map((e: any) => e.text.text);
    assert.ok(labels.some((l: string) => l.includes("alpha")));
    assert.ok(labels.some((l: string) => l.includes("beta")));
    // Files should NOT appear
    assert.ok(!labels.some((l: string) => l.includes("readme")));
  });

  it("shows pinned projects when provided", () => {
    const projects = [
      { path: "/fake/project1", label: "Project One" },
      { path: "/fake/project2", label: "Project Two" },
    ];
    const blocks = buildCwdPickerBlocks(tmpBase, projects);
    const pinBlocks = blocks.filter((b: any) =>
      b.type === "actions" && b.elements?.some((e: any) => e.action_id.startsWith("cwd_pick_pin_"))
    );
    assert.ok(pinBlocks.length > 0);
    const allPinButtons = pinBlocks.flatMap((b: any) => b.elements);
    assert.ok(allPinButtons.some((e: any) => e.text.text.includes("Project One")));
    assert.ok(allPinButtons.some((e: any) => e.text.text.includes("Project Two")));
  });

  it("shows 'No subdirectories' for empty dir", () => {
    const emptyDir = join(tmpBase, "alpha"); // alpha has no children
    const blocks = buildCwdPickerBlocks(emptyDir, []);
    const emptyBlock = blocks.find((b: any) =>
      b.type === "section" && b.text?.text?.includes("No subdirectories")
    );
    assert.ok(emptyBlock);
  });
});

/* ------------------------------------------------------------------ */
/*  postCwdPicker                                                      */
/* ------------------------------------------------------------------ */

describe("postCwdPicker", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    // Clean up any pending picks
    for (let i = 0; i < 10; i++) {
      removePendingCwdPick(`msg-${i}`);
    }
  });

  it("posts a message and registers a pending pick", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "hello",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    assert.equal(client.posted.length, 1);
    const msg = client.posted[0];
    assert.equal(msg.channel, "C1");
    assert.equal(msg.thread_ts, "T1");
    assert.ok(msg.blocks.length > 0);

    // Pending pick should be registered
    const pick = getPendingCwdPick(msg.ts);
    assert.ok(pick);
    assert.equal(pick!.prompt, "hello");
    assert.equal(pick!.currentDir, tmpBase);

    // Clean up
    removePendingCwdPick(msg.ts);
  });

  it("defaults to homedir when no startDir", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();
    const { homedir } = await import("os");

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "hello",
      files: [],
      projects: [],
      onSelect,
    });

    const pick = getPendingCwdPick(client.posted[0].ts);
    assert.equal(pick!.currentDir, homedir());
    removePendingCwdPick(client.posted[0].ts);
  });
});

/* ------------------------------------------------------------------ */
/*  handleCwdSelect                                                    */
/* ------------------------------------------------------------------ */

describe("handleCwdSelect", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("calls onSelect with the selected directory", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "do stuff",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdSelect(messageTs, join(tmpBase, "alpha"));

    assert.equal(onSelect.mock.calls.length, 1);
    const [pick, selectedDir] = onSelect.mock.calls[0];
    assert.equal(selectedDir, join(tmpBase, "alpha"));
    assert.equal(pick.prompt, "do stuff");
  });

  it("updates the picker message to show selection", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdSelect(messageTs, tmpBase);

    assert.equal(client.updated.length, 1);
    assert.ok(client.updated[0].text.includes(tmpBase));
    assert.deepEqual(client.updated[0].blocks, []);
  });

  it("removes the pending pick after selection", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdSelect(messageTs, tmpBase);

    assert.equal(getPendingCwdPick(messageTs), undefined);
  });

  it("ignores unknown message ts", async () => {
    // Should not throw
    await handleCwdSelect("nonexistent", "/some/dir");
  });
});

/* ------------------------------------------------------------------ */
/*  handleCwdNav                                                       */
/* ------------------------------------------------------------------ */

describe("handleCwdNav", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("updates the picker message with the new directory listing", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdNav(messageTs, join(tmpBase, "alpha"));

    assert.equal(client.updated.length, 1);
    assert.ok(client.updated[0].text.includes("alpha"));
    assert.ok(client.updated[0].blocks.length > 0);
  });

  it("updates currentDir on the pending pick", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    const newDir = join(tmpBase, "beta");
    await handleCwdNav(messageTs, newDir);

    const pick = getPendingCwdPick(messageTs);
    assert.equal(pick!.currentDir, newDir);

    // Clean up
    removePendingCwdPick(messageTs);
  });

  it("ignores unknown message ts", async () => {
    await handleCwdNav("nonexistent", "/some/dir");
  });
});

/* ------------------------------------------------------------------ */
/*  handleCwdCancel                                                    */
/* ------------------------------------------------------------------ */

describe("handleCwdCancel", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("updates the picker message to show cancellation", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdCancel(messageTs);

    assert.equal(client.updated.length, 1);
    assert.ok(client.updated[0].text.includes("cancelled"));
    assert.deepEqual(client.updated[0].blocks, []);
  });

  it("removes the pending pick after cancellation", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdCancel(messageTs);

    assert.equal(getPendingCwdPick(messageTs), undefined);
  });

  it("does not call onSelect", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "test",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;
    await handleCwdCancel(messageTs);

    assert.equal(onSelect.mock.calls.length, 0);
  });

  it("ignores unknown message ts", async () => {
    await handleCwdCancel("nonexistent");
  });
});

/* ------------------------------------------------------------------ */
/*  Pending registry                                                   */
/* ------------------------------------------------------------------ */

describe("pending cwd pick registry", () => {
  it("returns undefined for unknown message ts", () => {
    assert.equal(getPendingCwdPick("nonexistent"), undefined);
  });

  it("removePendingCwdPick is safe for unknown ts", () => {
    // Should not throw
    removePendingCwdPick("nonexistent");
  });
});

/* ------------------------------------------------------------------ */
/*  Full navigation flow                                               */
/* ------------------------------------------------------------------ */

describe("full navigation flow", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    // Create nested structure
    mkdirSync(join(tmpBase, "alpha", "inner"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("navigate down, then select", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "my task",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;

    // Navigate into alpha
    await handleCwdNav(messageTs, join(tmpBase, "alpha"));
    assert.equal(client.updated.length, 1);

    // Navigate into alpha/inner
    await handleCwdNav(messageTs, join(tmpBase, "alpha", "inner"));
    assert.equal(client.updated.length, 2);

    // Select current directory
    await handleCwdSelect(messageTs, join(tmpBase, "alpha", "inner"));

    assert.equal(onSelect.mock.calls.length, 1);
    const [pick, dir] = onSelect.mock.calls[0];
    assert.equal(dir, join(tmpBase, "alpha", "inner"));
    assert.equal(pick.prompt, "my task");
  });

  it("navigate down, then back to parent, then select", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();
    const { dirname } = await import("path");

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "my task",
      files: [],
      projects: [],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;

    // Navigate into alpha
    await handleCwdNav(messageTs, join(tmpBase, "alpha"));

    // Navigate back to parent
    await handleCwdNav(messageTs, dirname(join(tmpBase, "alpha")));

    // Verify we're back at tmpBase
    const pick = getPendingCwdPick(messageTs);
    assert.equal(pick!.currentDir, tmpBase);

    // Select
    await handleCwdSelect(messageTs, tmpBase);
    assert.equal(onSelect.mock.calls[0][1], tmpBase);
  });

  it("jump to pinned project via nav", async () => {
    const client = makeMockClient();
    const onSelect = vi.fn();
    const pinnedDir = join(tmpBase, "beta");

    await postCwdPicker({
      client,
      channel: "C1",
      threadTs: "T1",
      prompt: "my task",
      files: [],
      projects: [{ path: pinnedDir, label: "Beta" }],
      startDir: tmpBase,
      onSelect,
    });

    const messageTs = client.posted[0].ts;

    // Jump to pinned project (uses the same handleCwdNav)
    await handleCwdNav(messageTs, pinnedDir);

    const pick = getPendingCwdPick(messageTs);
    assert.equal(pick!.currentDir, pinnedDir);

    // Select it
    await handleCwdSelect(messageTs, pinnedDir);
    assert.equal(onSelect.mock.calls[0][1], pinnedDir);
  });
});
