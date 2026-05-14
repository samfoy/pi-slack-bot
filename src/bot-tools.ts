/**
 * Bot control tools — give the Pi agent direct control over bot-level
 * operations like restarting, switching models, and changing thinking level.
 *
 * Without these, the agent edits config files and tells the user to restart
 * manually. With these, it can handle "restart yourself" or "switch to opus"
 * naturally through conversation.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BotSessionManager } from "./session-manager.js";
import type { ThreadSession } from "./thread-session.js";
import { type ThinkingLevel, VALID_THINKING_LEVELS } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("bot-tools");

/* ------------------------------------------------------------------ */
/*  restart_bot                                                        */
/* ------------------------------------------------------------------ */

export interface RestartBotContext {
  sessionManager: BotSessionManager;
}

export function createRestartBotTool(
  getContext: () => RestartBotContext,
): ToolDefinition {
  return {
    name: "restart_bot",
    label: "Restart Bot",
    description:
      "Restart the Slack bot process. Sessions are persisted and auto-restore after restart. " +
      "Use this when the user asks you to restart, reboot, or refresh the bot.",
    promptSnippet:
      "Restart the bot process. Sessions auto-restore. " +
      "Use when the user asks to restart/reboot.",
    parameters: Type.Object({}),
    async execute() {
      const ctx = getContext();
      log.info("restart_bot tool called — graceful shutdown and restart");
      // Mirror the SIGINT handler's graceful shutdown sequence
      ctx.sessionManager.stopReaper();
      await ctx.sessionManager.disposeAll();
      await ctx.sessionManager.flushRegistry();
      ctx.sessionManager.disposeRegistry();
      // Exit with code 75 after a short delay so the tool response gets sent first.
      // run.sh interprets exit 75 as "restart requested".
      setTimeout(() => process.exit(75), 500);
      return {
        content: [{ type: "text", text: "♻️ Restarting bot... sessions will auto-restore." }],
        details: undefined,
      };
    },
  } as ToolDefinition;
}

/* ------------------------------------------------------------------ */
/*  set_model                                                          */
/* ------------------------------------------------------------------ */

const SetModelParams = Type.Object({
  model: Type.String({ description: "Model name or ID (e.g. 'claude-sonnet-4-6', 'claude-opus-4-6-1m')" }),
});
type SetModelInput = Static<typeof SetModelParams>;

export function createSetModelTool(
  getSession: () => ThreadSession,
): ToolDefinition {
  return {
    name: "set_model",
    label: "Set Model",
    description:
      "Change the LLM model for this session. Takes effect immediately — no restart needed. " +
      "Use this when the user asks to switch, change, or use a different model. " +
      "Call this tool instead of editing any config or settings files.",
    promptSnippet:
      "Switch the LLM model live. No restart needed. " +
      "Use instead of editing config files.",
    parameters: SetModelParams,
    async execute(_toolCallId, params: SetModelInput) {
      const session = getSession();
      try {
        await session.setModel(params.model);
        return {
          content: [{ type: "text", text: `✅ Model set to \`${params.model}\`. Active immediately.` }],
          details: undefined,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ ${msg}` }],
          details: undefined,
        };
      }
    },
  } as ToolDefinition;
}

/* ------------------------------------------------------------------ */
/*  set_thinking_level                                                 */
/* ------------------------------------------------------------------ */

const SetThinkingParams = Type.Object({
  level: Type.String({ description: `Thinking level: ${VALID_THINKING_LEVELS.join(", ")}` }),
});
type SetThinkingInput = Static<typeof SetThinkingParams>;

export function createSetThinkingLevelTool(
  getSession: () => ThreadSession,
): ToolDefinition {
  return {
    name: "set_thinking_level",
    label: "Set Thinking Level",
    description:
      "Change the thinking/effort level for this session. Takes effect immediately. " +
      `Valid levels: ${VALID_THINKING_LEVELS.join(", ")}. ` +
      "Use this when the user asks to change thinking level, effort, or reasoning depth. " +
      "Call this tool instead of editing any config or settings files.",
    promptSnippet:
      "Change thinking/effort level live. " +
      `Levels: ${VALID_THINKING_LEVELS.join(", ")}. ` +
      "Use instead of editing config files.",
    parameters: SetThinkingParams,
    async execute(_toolCallId, params: SetThinkingInput) {
      const session = getSession();
      const level = params.level.toLowerCase() as ThinkingLevel;
      if (!VALID_THINKING_LEVELS.includes(level)) {
        return {
          content: [{ type: "text", text: `❌ Invalid level "${params.level}". Must be one of: ${VALID_THINKING_LEVELS.join(", ")}` }],
          details: undefined,
        };
      }
      session.setThinkingLevel(level);
      return {
        content: [{ type: "text", text: `✅ Thinking level set to \`${level}\`. Active immediately.` }],
        details: undefined,
      };
    },
  } as ToolDefinition;
}
