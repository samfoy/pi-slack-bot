import { homedir } from "os";
import { resolve } from "path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Config {
  // Slack
  slackBotToken: string;
  slackAppToken: string;
  slackUserId: string;

  // LLM
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;

  // Sessions
  maxSessions: number;
  sessionIdleTimeoutSecs: number;
  sessionDir: string;

  // Streaming
  streamThrottleMs: number;
  slackMsgLimit: number;

  // cwd discovery
  workspaceDirs: string[];

  // Attach server
  attachPort: number;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, defaultVal: string): string {
  return process.env[name] ?? defaultVal;
}

function optionalInt(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (!val) return defaultVal;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${val}`);
  return n;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function parseThinkingLevel(val: string): ThinkingLevel {
  if (VALID_THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
  throw new Error(`Invalid THINKING_LEVEL: ${val}. Must be one of: ${VALID_THINKING_LEVELS.join(", ")}`);
}

export function loadConfig(): Config {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackUserId: required("SLACK_USER_ID"),

    provider: optional("PROVIDER", "anthropic"),
    model: optional("MODEL", "claude-sonnet-4-5"),
    thinkingLevel: parseThinkingLevel(optional("THINKING_LEVEL", "off")),

    maxSessions: optionalInt("MAX_SESSIONS", 10),
    sessionIdleTimeoutSecs: optionalInt("SESSION_IDLE_TIMEOUT", 3600),
    sessionDir: expandHome(optional("SESSION_DIR", "~/.pi-slack-bot/sessions")),

    streamThrottleMs: optionalInt("STREAM_THROTTLE_MS", 3000),
    slackMsgLimit: optionalInt("SLACK_MSG_LIMIT", 3000),

    workspaceDirs: optional("WORKSPACE_DIRS", "~/projects")
      .split(",")
      .map((d) => expandHome(d.trim()))
      .filter(Boolean),

    attachPort: optionalInt("ATTACH_PORT", 3001),
  };
}
