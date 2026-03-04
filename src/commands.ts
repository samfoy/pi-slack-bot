import { resolve } from "path";
import { existsSync, statSync } from "fs";
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import type { BotSessionManager, ThreadSessionInfo } from "./session-manager.js";
import type { ThinkingLevel } from "./config.js";

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface CommandContext {
  channel: string;
  threadTs: string;
  client: WebClient;
  sessionManager: BotSessionManager;
  session: ThreadSession | undefined;
}

type CommandHandler = (ctx: CommandContext, args: string) => Promise<void>;

async function reply(ctx: CommandContext, text: string): Promise<void> {
  await ctx.client.chat.postMessage({
    channel: ctx.channel,
    thread_ts: ctx.threadTs,
    text,
  });
}

const handlers: Record<string, CommandHandler> = {
  async help(ctx) {
    const lines = [
      "*Commands:*",
      "`!help` — Show this list",
      "`!new` — Start a new session",
      "`!cancel` — Cancel the current stream",
      "`!status` — Show session info",
      "`!model <name>` — Switch model",
      "`!thinking <level>` — Set thinking level (off, minimal, low, medium, high, xhigh)",
      "`!sessions` — List active sessions",
      "`!cwd <path>` — Change working directory",
    ];
    await reply(ctx, lines.join("\n"));
  },

  async new(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await ctx.session.newSession();
    await reply(ctx, "🆕 New session started.");
  },

  async cancel(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    ctx.session.abort();
    await reply(ctx, "🛑 Cancelled.");
  },

  async status(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const s = ctx.session;
    const lines = [
      `*Model:* ${s.model?.id ?? "unknown"}`,
      `*Thinking:* ${s.thinkingLevel}`,
      `*Messages:* ${s.messageCount}`,
      `*CWD:* \`${s.cwd}\``,
      `*Last activity:* ${s.lastActivity.toISOString()}`,
    ];
    await reply(ctx, lines.join("\n"));
  },

  async model(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const modelName = args.trim();
    if (!modelName) {
      await reply(ctx, `Current model: ${ctx.session.model?.id ?? "unknown"}`);
      return;
    }
    try {
      await ctx.session.setModel(modelName);
      await reply(ctx, `✅ Model set to \`${modelName}\`.`);
    } catch (err) {
      await reply(ctx, `❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async thinking(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const level = args.trim() as ThinkingLevel;
    if (!VALID_THINKING_LEVELS.includes(level)) {
      await reply(ctx, `❌ Invalid level. Must be one of: ${VALID_THINKING_LEVELS.join(", ")}`);
      return;
    }
    ctx.session.setThinkingLevel(level);
    await reply(ctx, `✅ Thinking level set to \`${level}\`.`);
  },

  async sessions(ctx) {
    const list = ctx.sessionManager.list();
    if (list.length === 0) {
      await reply(ctx, "No active sessions.");
      return;
    }
    const rows = list.map((s: ThreadSessionInfo) =>
      `• \`${s.threadTs}\` — ${s.model} | ${s.messageCount} msgs | \`${s.cwd}\` | ${s.isStreaming ? "🔴 streaming" : "⚪ idle"}`
    );
    await reply(ctx, rows.join("\n"));
  },

  async cwd(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const target = args.trim();
    if (!target) {
      await reply(ctx, `Current cwd: \`${ctx.session.cwd}\``);
      return;
    }
    const resolved = resolve(target);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      await reply(ctx, `❌ Not a valid directory: \`${resolved}\``);
      return;
    }
    ctx.session.cwd = resolved;
    await reply(ctx, `📂 CWD set to \`${resolved}\`.`);
  },
};

/**
 * Parse a `!command args` string. Returns null if not a command.
 */
export function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1),
  };
}

/**
 * Dispatch a parsed command. Returns true if handled, false if unknown command.
 */
export async function dispatchCommand(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const handler = handlers[name];
  if (!handler) {
    await reply(ctx, `Unknown command: \`!${name}\`. Try \`!help\`.`);
    return false;
  }
  await handler(ctx, args);
  return true;
}
