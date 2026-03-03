import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

// Save and restore env around each test
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear all relevant vars
  for (const key of [
    "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_ID",
    "PROVIDER", "MODEL", "THINKING_LEVEL",
    "MAX_SESSIONS", "SESSION_IDLE_TIMEOUT", "SESSION_DIR",
    "STREAM_THROTTLE_MS", "SLACK_MSG_LIMIT", "WORKSPACE_DIRS", "ATTACH_PORT",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setRequired() {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_APP_TOKEN = "xapp-test";
  process.env.SLACK_USER_ID = "U123";
}

describe("loadConfig", () => {
  it("throws on missing SLACK_BOT_TOKEN", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_USER_ID = "U123";
    assert.throws(() => loadConfig(), /SLACK_BOT_TOKEN/);
  });

  it("throws on missing SLACK_APP_TOKEN", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_USER_ID = "U123";
    assert.throws(() => loadConfig(), /SLACK_APP_TOKEN/);
  });

  it("throws on missing SLACK_USER_ID", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    assert.throws(() => loadConfig(), /SLACK_USER_ID/);
  });

  it("applies all defaults correctly", () => {
    setRequired();
    const cfg = loadConfig();
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.model, "claude-sonnet-4-5");
    assert.equal(cfg.thinkingLevel, "off");
    assert.equal(cfg.maxSessions, 10);
    assert.equal(cfg.sessionIdleTimeoutSecs, 3600);
    assert.ok(cfg.sessionDir.includes(".pi-slack-bot/sessions"));
    assert.equal(cfg.streamThrottleMs, 3000);
    assert.equal(cfg.slackMsgLimit, 3900);
    assert.ok(cfg.workspaceDirs.length > 0);
    assert.equal(cfg.attachPort, 3001);
  });

  it("reads values from env", () => {
    setRequired();
    process.env.PROVIDER = "openai";
    process.env.MODEL = "gpt-4o";
    process.env.THINKING_LEVEL = "high";
    process.env.MAX_SESSIONS = "5";
    process.env.ATTACH_PORT = "4000";
    const cfg = loadConfig();
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.model, "gpt-4o");
    assert.equal(cfg.thinkingLevel, "high");
    assert.equal(cfg.maxSessions, 5);
    assert.equal(cfg.attachPort, 4000);
  });

  it("throws on invalid THINKING_LEVEL", () => {
    setRequired();
    process.env.THINKING_LEVEL = "turbo";
    assert.throws(() => loadConfig(), /THINKING_LEVEL/);
  });

  it("expands ~ in SESSION_DIR", () => {
    setRequired();
    process.env.SESSION_DIR = "~/my-sessions";
    const cfg = loadConfig();
    assert.ok(!cfg.sessionDir.startsWith("~"));
    assert.ok(cfg.sessionDir.includes("my-sessions"));
  });

  it("parses comma-separated WORKSPACE_DIRS", () => {
    setRequired();
    process.env.WORKSPACE_DIRS = "~/a,~/b,~/c";
    const cfg = loadConfig();
    assert.equal(cfg.workspaceDirs.length, 3);
    assert.ok(cfg.workspaceDirs.every((d) => !d.startsWith("~")));
  });
});
