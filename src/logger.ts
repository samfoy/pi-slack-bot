/**
 * Structured logger for pi-slack-bot.
 *
 * No external dependencies — outputs JSON lines or pretty-printed text.
 * Reads LOG_LEVEL and LOG_FORMAT from environment variables directly
 * (not from config.ts) to avoid circular imports and work before config loads.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);
const VALID_FORMATS = new Set<string>(["json", "pretty"]);

// Module-level state — read from env on first use, overridable for tests.
let _logLevel: LogLevel = parseLogLevel(process.env.LOG_LEVEL);
let _logFormat: LogFormat = parseLogFormat(process.env.LOG_FORMAT);
let _stdout: (s: string) => void = (s) => process.stdout.write(s);
let _stderr: (s: string) => void = (s) => process.stderr.write(s);

function parseLogLevel(val: string | undefined): LogLevel {
  if (val && VALID_LEVELS.has(val.toLowerCase())) return val.toLowerCase() as LogLevel;
  return "info";
}

function parseLogFormat(val: string | undefined): LogFormat {
  if (val && VALID_FORMATS.has(val.toLowerCase())) return val.toLowerCase() as LogFormat;
  return "json";
}

/** Override log level at runtime (primarily for tests). */
export function setLogLevel(level: LogLevel): void {
  _logLevel = level;
}

/** Override log format at runtime (primarily for tests). */
export function setLogFormat(format: LogFormat): void {
  _logFormat = format;
}

/** Override output streams (primarily for tests). */
export function setOutput(
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): void {
  _stdout = stdout;
  _stderr = stderr;
}

/** Reset output to default process streams. */
export function resetOutput(): void {
  _stdout = (s) => process.stdout.write(s);
  _stderr = (s) => process.stderr.write(s);
}

/**
 * Serialize context values for safe JSON output.
 * Handles Error objects (which JSON.stringify produces `{}` for).
 */
function serializeCtx(ctx: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(ctx)) {
    if (val instanceof Error) {
      result[key] = { message: val.message, stack: val.stack };
    } else {
      result[key] = val;
    }
  }
  return result;
}

function formatJson(
  level: LogLevel,
  module: string,
  msg: string,
  ctx?: Record<string, unknown>,
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
  };
  if (ctx) {
    Object.assign(entry, serializeCtx(ctx));
  }
  return JSON.stringify(entry) + "\n";
}

function formatPretty(
  level: LogLevel,
  module: string,
  msg: string,
  ctx?: Record<string, unknown>,
): string {
  const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const lvl = level.toUpperCase().padEnd(5);
  let line = `[${time}] ${lvl} ${module}: ${msg}`;
  if (ctx && Object.keys(ctx).length > 0) {
    const serialized = serializeCtx(ctx);
    // Compact inline representation
    const pairs = Object.entries(serialized)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    line += ` | ${pairs}`;
  }
  return line + "\n";
}

function emit(level: LogLevel, module: string, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_logLevel]) return;

  const formatted = _logFormat === "json"
    ? formatJson(level, module, msg, ctx)
    : formatPretty(level, module, msg, ctx);

  if (level === "warn" || level === "error") {
    _stderr(formatted);
  } else {
    _stdout(formatted);
  }
}

/**
 * Create a logger for a specific module.
 *
 * @param module — Module name (e.g. "thread-session", "streaming-updater")
 */
export function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx?) => emit("debug", module, msg, ctx),
    info: (msg, ctx?) => emit("info", module, msg, ctx),
    warn: (msg, ctx?) => emit("warn", module, msg, ctx),
    error: (msg, ctx?) => emit("error", module, msg, ctx),
  };
}
