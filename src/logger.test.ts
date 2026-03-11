import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createLogger,
  setLogLevel,
  setLogFormat,
  setOutput,
  resetOutput,
} from "./logger.js";

describe("logger", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    setOutput(
      (s) => stdoutBuf.push(s),
      (s) => stderrBuf.push(s),
    );
    setLogLevel("debug");
    setLogFormat("json");
  });

  afterEach(() => {
    resetOutput();
    setLogLevel("info");
    setLogFormat("json");
  });

  // ── JSON format ──────────────────────────────────────────────

  it("outputs valid JSON with required fields", () => {
    const log = createLogger("test-module");
    log.info("hello world");

    assert.equal(stdoutBuf.length, 1);
    const entry = JSON.parse(stdoutBuf[0]);
    assert.equal(entry.level, "info");
    assert.equal(entry.module, "test-module");
    assert.equal(entry.msg, "hello world");
    assert.ok(entry.ts, "should have timestamp");
    // Verify ISO 8601 format
    assert.ok(!isNaN(Date.parse(entry.ts)), "ts should be valid ISO date");
  });

  it("includes context fields in JSON output", () => {
    const log = createLogger("test");
    log.info("session started", { threadTs: "1234", channelId: "C1" });

    const entry = JSON.parse(stdoutBuf[0]);
    assert.equal(entry.threadTs, "1234");
    assert.equal(entry.channelId, "C1");
  });

  it("serializes Error objects in context", () => {
    const log = createLogger("test");
    const err = new Error("something broke");
    log.error("task failed", { error: err });

    const entry = JSON.parse(stderrBuf[0]);
    assert.equal(entry.error.message, "something broke");
    assert.ok(entry.error.stack, "should include stack trace");
  });

  it("handles context with no Error objects", () => {
    const log = createLogger("test");
    log.info("count", { n: 42, name: "test" });

    const entry = JSON.parse(stdoutBuf[0]);
    assert.equal(entry.n, 42);
    assert.equal(entry.name, "test");
  });

  it("outputs without context", () => {
    const log = createLogger("test");
    log.info("simple message");

    const entry = JSON.parse(stdoutBuf[0]);
    assert.equal(entry.msg, "simple message");
    assert.equal(Object.keys(entry).length, 4); // ts, level, module, msg
  });

  // ── Pretty format ──────────────────────────────────────────────

  it("outputs human-readable format in pretty mode", () => {
    setLogFormat("pretty");
    const log = createLogger("my-mod");
    log.info("started");

    assert.equal(stdoutBuf.length, 1);
    const line = stdoutBuf[0];
    assert.ok(line.includes("INFO"), "should include level");
    assert.ok(line.includes("my-mod"), "should include module");
    assert.ok(line.includes("started"), "should include message");
    assert.ok(line.endsWith("\n"), "should end with newline");
  });

  it("includes context as key=value pairs in pretty mode", () => {
    setLogFormat("pretty");
    const log = createLogger("test");
    log.warn("limit reached", { count: 42, name: "sessions" });

    const line = stderrBuf[0];
    assert.ok(line.includes("count=42"), `should have count, got: ${line}`);
    assert.ok(line.includes("name=sessions"), `should have name, got: ${line}`);
  });

  // ── Level filtering ──────────────────────────────────────────────

  it("suppresses debug at info level", () => {
    setLogLevel("info");
    const log = createLogger("test");
    log.debug("should not appear");
    log.info("should appear");

    assert.equal(stdoutBuf.length, 1);
    assert.ok(stdoutBuf[0].includes("should appear"));
  });

  it("suppresses info and debug at warn level", () => {
    setLogLevel("warn");
    const log = createLogger("test");
    log.debug("no");
    log.info("no");
    log.warn("yes");
    log.error("yes");

    assert.equal(stdoutBuf.length, 0);
    assert.equal(stderrBuf.length, 2);
  });

  it("shows everything at debug level", () => {
    setLogLevel("debug");
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    assert.equal(stdoutBuf.length, 2); // debug + info
    assert.equal(stderrBuf.length, 2); // warn + error
  });

  it("error level only shows errors", () => {
    setLogLevel("error");
    const log = createLogger("test");
    log.debug("no");
    log.info("no");
    log.warn("no");
    log.error("yes");

    assert.equal(stdoutBuf.length, 0);
    assert.equal(stderrBuf.length, 1);
  });

  // ── Output routing ──────────────────────────────────────────────

  it("routes info to stdout", () => {
    const log = createLogger("test");
    log.info("msg");
    assert.equal(stdoutBuf.length, 1);
    assert.equal(stderrBuf.length, 0);
  });

  it("routes debug to stdout", () => {
    const log = createLogger("test");
    log.debug("msg");
    assert.equal(stdoutBuf.length, 1);
    assert.equal(stderrBuf.length, 0);
  });

  it("routes warn to stderr", () => {
    const log = createLogger("test");
    log.warn("msg");
    assert.equal(stdoutBuf.length, 0);
    assert.equal(stderrBuf.length, 1);
  });

  it("routes error to stderr", () => {
    const log = createLogger("test");
    log.error("msg");
    assert.equal(stdoutBuf.length, 0);
    assert.equal(stderrBuf.length, 1);
  });

  // ── Multiple loggers ──────────────────────────────────────────────

  it("different modules produce different module fields", () => {
    const log1 = createLogger("mod-a");
    const log2 = createLogger("mod-b");
    log1.info("from a");
    log2.info("from b");

    const entry1 = JSON.parse(stdoutBuf[0]);
    const entry2 = JSON.parse(stdoutBuf[1]);
    assert.equal(entry1.module, "mod-a");
    assert.equal(entry2.module, "mod-b");
  });
});
