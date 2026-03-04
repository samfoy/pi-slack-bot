import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToMrkdwn, splitMrkdwn, formatToolStart, formatToolEnd, formatToolLog, formatToolArgs, convertMarkdownTables, type ToolCallRecord } from "./formatter.js";

describe("markdownToMrkdwn", () => {
  it("converts bold", () => {
    const result = markdownToMrkdwn("**hello**");
    assert.ok(result.includes("*hello*"), `got: ${result}`);
  });

  it("converts italic", () => {
    const result = markdownToMrkdwn("_hello_");
    assert.ok(result.includes("_hello_"), `got: ${result}`);
  });

  it("converts inline code", () => {
    const result = markdownToMrkdwn("`code`");
    assert.ok(result.includes("`code`"), `got: ${result}`);
  });

  it("converts links", () => {
    const result = markdownToMrkdwn("[text](https://example.com)");
    assert.ok(result.includes("<https://example.com|text>"), `got: ${result}`);
  });

  it("partial=true closes unclosed code block", () => {
    const partial = "some text\n```\ncode here";
    const result = markdownToMrkdwn(partial, true);
    // Should not throw and should produce valid output
    assert.ok(typeof result === "string");
    assert.ok(result.includes("code here"), `got: ${result}`);
  });

  it("partial=false leaves unclosed block as-is (may produce odd output but no crash)", () => {
    const partial = "text\n```\ncode";
    assert.doesNotThrow(() => markdownToMrkdwn(partial, false));
  });

  it("even fence count not modified by partial=true", () => {
    const md = "```\ncode\n```";
    const r1 = markdownToMrkdwn(md, false);
    const r2 = markdownToMrkdwn(md, true);
    assert.equal(r1, r2);
  });
});

describe("convertMarkdownTables", () => {
  it("converts a standard markdown table to a code block", () => {
    const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = convertMarkdownTables(md);
    assert.ok(result.includes("```"), "should wrap in code block");
    assert.ok(result.includes("Alice"), "should contain data");
    assert.ok(result.includes("Bob"), "should contain data");
    assert.ok(result.includes("─"), "should contain separator line");
    // Should NOT contain pipe characters
    assert.ok(!result.includes("|"), "should remove pipe characters");
  });

  it("preserves tables inside code blocks", () => {
    const md = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    const result = convertMarkdownTables(md);
    assert.ok(result.includes("|"), "pipes inside code block should be preserved");
  });

  it("leaves non-table pipe lines unchanged", () => {
    const md = "| just a line\n| another";
    const result = convertMarkdownTables(md);
    // No separator row → not a real table → pass through
    assert.equal(result, md);
  });

  it("handles tables with surrounding text", () => {
    const md = "Before\n\n| H1 | H2 |\n|---|---|\n| a | b |\n\nAfter";
    const result = convertMarkdownTables(md);
    assert.ok(result.startsWith("Before"), "text before preserved");
    assert.ok(result.endsWith("After"), "text after preserved");
    assert.ok(result.includes("```"), "table converted to code block");
  });

  it("aligns columns with padding", () => {
    const md = "| Short | LongerHeader |\n|---|---|\n| x | y |";
    const result = convertMarkdownTables(md);
    // Header should be padded to match widths
    const lines = result.split("\n");
    const headerLine = lines.find((l) => l.includes("Short"));
    assert.ok(headerLine, "should have header");
    assert.ok(headerLine!.includes("LongerHeader"), "should have second header");
  });

  it("integrates with markdownToMrkdwn", () => {
    const md = "# Review\n\n| Finding | Severity |\n|---|---|\n| Bug | High |\n| Typo | Low |";
    const result = markdownToMrkdwn(md);
    assert.ok(result.includes("```"), "table should be in code block");
    assert.ok(!result.includes("---|"), "separator row should be removed");
  });
});

describe("splitMrkdwn", () => {
  it("returns single chunk when under limit", () => {
    const chunks = splitMrkdwn("hello world", 3900);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "hello world");
  });

  it("splits at paragraph boundary", () => {
    const a = "a".repeat(2000);
    const b = "b".repeat(2000);
    const text = `${a}\n\n${b}`;
    const chunks = splitMrkdwn(text, 3900);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], a);
    assert.equal(chunks[1], b);
  });

  it("splits at line boundary when no paragraph", () => {
    const a = "a".repeat(2000);
    const b = "b".repeat(2000);
    const text = `${a}\n${b}`;
    const chunks = splitMrkdwn(text, 3900);
    assert.equal(chunks.length, 2);
  });

  it("hard cuts when no whitespace", () => {
    const text = "a".repeat(5000);
    const chunks = splitMrkdwn(text, 3900);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.length <= 3900);
  });

  it("never splits inside a code block that fits within limit", () => {
    // "before" paragraph + code block (fits in 3900) + "after" paragraph
    // Total > 3900 so a split is needed, but the code block itself fits
    const code = "x".repeat(500);
    const before = "b".repeat(2000);
    const after = "a".repeat(2000);
    const text = `${before}\n\n\`\`\`\n${code}\n\`\`\`\n\n${after}`;
    const chunks = splitMrkdwn(text, 3900);
    // Each chunk must have an even number of ``` fences
    for (const c of chunks) {
      const fences = (c.match(/```/g) ?? []).length;
      assert.equal(fences % 2, 0, `odd fences in chunk: ${c.slice(0, 100)}`);
    }
  });

  it("all chunks within limit", () => {
    const text = "word ".repeat(2000);
    const chunks = splitMrkdwn(text, 3900);
    for (const c of chunks) assert.ok(c.length <= 3900, `chunk too long: ${c.length}`);
  });
});

describe("formatToolStart", () => {
  it("formats tool name and args", () => {
    const result = formatToolStart("read", { path: "/foo/bar.ts" });
    assert.equal(result, "> 🔧 `read`(/foo/bar.ts)");
  });

  it("handles empty args", () => {
    const result = formatToolStart("list", {});
    assert.equal(result, "> 🔧 `list`()");
  });

  it("truncates long arg values", () => {
    const result = formatToolStart("bash", { command: "a".repeat(100) });
    assert.ok(result.includes("..."), `got: ${result}`);
  });
});

describe("formatToolEnd", () => {
  it("formats success", () => {
    assert.equal(formatToolEnd("read", false), "> ✅ `read`");
  });

  it("formats error", () => {
    assert.equal(formatToolEnd("read", true), "> ❌ `read`");
  });
});

describe("formatToolArgs", () => {
  it("shows path for read tool", () => {
    assert.equal(formatToolArgs("read", { path: "/src/foo.ts" }), "/src/foo.ts");
  });

  it("shows path for write tool", () => {
    assert.equal(formatToolArgs("write", { path: "/src/bar.ts" }), "/src/bar.ts");
  });

  it("shows path for edit tool", () => {
    assert.equal(formatToolArgs("edit", { path: "/src/baz.ts" }), "/src/baz.ts");
  });

  it("shows command for bash tool", () => {
    assert.equal(formatToolArgs("bash", { command: "npm test" }), "npm test");
  });

  it("shows query for web_search", () => {
    assert.equal(formatToolArgs("web_search", { query: "how to test" }), "how to test");
  });

  it("shows url for fetch_content", () => {
    assert.equal(formatToolArgs("fetch_content", { url: "https://example.com" }), "https://example.com");
  });

  it("truncates long args", () => {
    const result = formatToolArgs("bash", { command: "a".repeat(100) });
    assert.ok(result.length <= 60, `got length ${result.length}`);
    assert.ok(result.endsWith("..."));
  });

  it("handles generic tool with multiple args", () => {
    const result = formatToolArgs("custom_tool", { a: "one", b: "two", c: "three" });
    assert.ok(result.includes("one"));
    assert.ok(result.includes("two"));
    assert.ok(result.includes("three"));
  });

  it("handles null/undefined args", () => {
    assert.equal(formatToolArgs("read", null), "");
    assert.equal(formatToolArgs("read", undefined), "");
  });

  it("handles empty object", () => {
    assert.equal(formatToolArgs("custom", {}), "");
  });
});

describe("formatToolLog", () => {
  it("returns empty string for no records", () => {
    assert.equal(formatToolLog([]), "");
  });

  it("formats a single successful tool call", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: { path: "/foo.ts" }, startTime: 1000, endTime: 1200, isError: false },
    ];
    const log = formatToolLog(records);
    assert.ok(log.includes("Read"), "should include tool description");
    assert.ok(log.includes("foo.ts"), "should include file name");
    assert.ok(log.includes("✓"), "should include success mark");
    assert.ok(log.includes("0.2s"), "should include duration");
    assert.ok(log.includes("1 tools ran"), "should include summary");
  });

  it("formats multiple tool calls with failures", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: { path: "/a.ts" }, startTime: 1000, endTime: 1100, isError: false },
      { toolName: "bash", args: { command: "npm test" }, startTime: 1100, endTime: 4200, isError: true },
      { toolName: "edit", args: { path: "/b.ts" }, startTime: 4200, endTime: 4300, isError: false },
    ];
    const log = formatToolLog(records);
    assert.ok(log.includes("1 failed"), "should mention failures");
    assert.ok(log.includes("✗"), "should include failure mark");
    assert.ok(log.includes("3 tools ran"), "should include total count");
    assert.ok(log.includes("npm test"), "should include bash command");
  });

  it("formats records without end time", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: { path: "/x.ts" }, startTime: 1000 },
    ];
    const log = formatToolLog(records);
    assert.ok(log.includes("Read"), "should still include tool description");
    assert.ok(log.includes("<0.1s"), "should show minimal duration");
  });

  it("includes header and footer separators", () => {
    const records: ToolCallRecord[] = [
      { toolName: "read", args: {}, startTime: 1000, endTime: 1500, isError: false },
    ];
    const log = formatToolLog(records);
    const lines = log.split("\n");
    assert.ok(lines[0].includes("───"), "should have header separator");
    assert.ok(lines[lines.length - 2].includes("───"), "should have footer separator");
  });
});
