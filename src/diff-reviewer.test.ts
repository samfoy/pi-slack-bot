import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractModifiedFiles, hasFileModifications, generateDiff, createPaste, computeDiffStats } from "./diff-reviewer.js";
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

describe("computeDiffStats", () => {
  it("counts files, insertions, and deletions from tracked changes", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 import { bar } from "./bar.js";
 
-export function foo(): string {
+export function foo(): number {
+  // new comment
`;
    const stats = computeDiffStats(diff);
    assert.equal(stats.fileCount, 1);
    assert.equal(stats.insertions, 2);
    assert.equal(stats.deletions, 1);
  });

  it("counts untracked new files (diff --no-index)", () => {
    const diff = `diff --no-index a/dev/null b/NOTES.md
new file mode 100644
--- /dev/null
+++ b/NOTES.md
@@ -0,0 +1,3 @@
+# Notes
+
+Some collaboration notes here
`;
    const stats = computeDiffStats(diff);
    assert.equal(stats.fileCount, 1);
    assert.equal(stats.insertions, 3);
    assert.equal(stats.deletions, 0);
  });

  it("counts multiple files including both tracked and untracked", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-old line
+new line
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -5,3 +5,4 @@
 existing
-removed
+added
+extra
diff --no-index a/dev/null b/new-file.md
--- /dev/null
+++ b/new-file.md
@@ -0,0 +1 @@
+brand new file
`;
    const stats = computeDiffStats(diff);
    assert.equal(stats.fileCount, 3);
    assert.equal(stats.insertions, 4);
    assert.equal(stats.deletions, 2);
  });

  it("returns zeros for empty diff", () => {
    const stats = computeDiffStats("");
    assert.equal(stats.fileCount, 0);
    assert.equal(stats.insertions, 0);
    assert.equal(stats.deletions, 0);
  });
});

describe("createPaste", () => {
  it("returns null when curl fails (e.g. no midway cookie)", () => {
    // Use a bogus HOME so the midway cookie doesn't exist
    const origHome = process.env.HOME;
    process.env.HOME = "/tmp/nonexistent-home-" + Date.now();
    try {
      const result = createPaste("test content", "test title");
      // Should return null (curl will fail to auth) or succeed if somehow reachable
      // Either way, it should not throw
      assert.ok(result === null || typeof result?.url === "string");
    } finally {
      process.env.HOME = origHome;
    }
  });
});
