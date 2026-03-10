import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { scanProjects } from "./parser.js";

describe("scanProjects", () => {
  it("returns subdirectories of workspace dirs", () => {
    const base = join(tmpdir(), `scan-test-${Date.now()}`);
    mkdirSync(join(base, "proj-a"), { recursive: true });
    mkdirSync(join(base, "proj-b"), { recursive: true });

    try {
      const results = scanProjects([base]);
      assert.ok(results.some((p) => p.endsWith("proj-a")));
      assert.ok(results.some((p) => p.endsWith("proj-b")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips non-existent dirs without throwing", () => {
    assert.doesNotThrow(() => scanProjects(["/nonexistent/path/xyz"]));
  });

  it("returns empty array for empty workspace dir", () => {
    const base = join(tmpdir(), `scan-empty-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    try {
      const results = scanProjects([base]);
      assert.deepEqual(results, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
