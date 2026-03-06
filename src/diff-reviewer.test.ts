import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractModifiedFiles, hasFileModifications, generateDiff } from "./diff-reviewer.js";
import type { ToolCallRecord } from "./formatter.js";

describe("extractModifiedFiles", () => {
  it("returns empty array when no records", () => {
    assert.deepEqual(extractModifiedFiles([]), []);
  });

  it("extracts paths from edit and write tools", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: { path: "src/foo.ts" }, startTime: 0 },
      { toolName: "edit", args: { path: "src/bar.ts", oldText: "a", newText: "b" }, startTime: 1 },
      { toolName: "write", args: { path: "src/new.ts", content: "hello" }, startTime: 2 },
      { toolName: "bash", args: { command: "npm test" }, startTime: 3 },
    ];
    assert.deepEqual(extractModifiedFiles(records), ["src/bar.ts", "src/new.ts"]);
  });

  it("deduplicates paths", () => {
    const records: ToolCallRecord[] = [
      { toolName: "edit", args: { path: "src/foo.ts" }, startTime: 0 },
      { toolName: "edit", args: { path: "src/foo.ts" }, startTime: 1 },
      { toolName: "write", args: { path: "src/foo.ts" }, startTime: 2 },
    ];
    assert.deepEqual(extractModifiedFiles(records), ["src/foo.ts"]);
  });

  it("handles missing path gracefully", () => {
    const records: ToolCallRecord[] = [
      { toolName: "edit", args: null, startTime: 0 },
      { toolName: "write", args: { content: "no path" }, startTime: 1 },
    ];
    assert.deepEqual(extractModifiedFiles(records), []);
  });
});

describe("hasFileModifications", () => {
  it("returns false for empty records", () => {
    assert.equal(hasFileModifications([]), false);
  });

  it("returns false when only read/bash tools", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: { path: "src/foo.ts" }, startTime: 0 },
      { toolName: "bash", args: { command: "ls" }, startTime: 1 },
    ];
    assert.equal(hasFileModifications(records), false);
  });

  it("returns true when edit tool present", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: { path: "src/foo.ts" }, startTime: 0 },
      { toolName: "edit", args: { path: "src/foo.ts" }, startTime: 1 },
    ];
    assert.equal(hasFileModifications(records), true);
  });

  it("returns true when write tool present", () => {
    const records: ToolCallRecord[] = [
      { toolName: "write", args: { path: "src/new.ts" }, startTime: 0 },
    ];
    assert.equal(hasFileModifications(records), true);
  });
});

describe("generateDiff", () => {
  it("returns null for non-git directory", () => {
    const result = generateDiff("/tmp");
    assert.equal(result, null);
  });
});
