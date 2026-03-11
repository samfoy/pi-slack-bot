import { App } from "@slack/bolt";
import type { Config } from "./config.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import { loadProjects } from "./parser.js";
import { parseCommand, dispatchCommand } from "./commands.js";
import { handleFileSelect, handleFileNav, handleFilePickCancel, getPendingPick } from "./file-picker.js";
import {
  handleRalphPresetSelect,
  handlePromptSelect,
  tryConsumeRalphPrompt,
} from "./command-picker.js";
import {
  handleResumeProjectSelect,
  handleResumeSessionSelect,
} from "./session-picker.js";
import {
  enrichPromptWithFiles,
  type SlackFile,
} from "./file-sharing.js";
import {
  postCwdPicker,
  handleCwdSelect,
  handleCwdNav,
  handleCwdCancel,
  type PendingCwdPick,
} from "./cwd-picker.js";
import { handleReaction, REACTION_MAP } from "./reactions.js";
import { createLogger } from "./logger.js";

const log = createLogger("slack");

export interface SlackApp {
  app: App;
  sessionManager: BotSessionManager;
}

export function createApp(config: Config): SlackApp {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const sessionManager = new BotSessionManager(config, app.client);
  // loadProjects re-reads ~/.pi-slack-bot/projects.json on every call,
  // so edits take effect without restart.
  let projects = loadProjects(config.workspaceDirs);

  /** Refresh project list from disk. Called on every message so config changes take effect immediately. */
  function refreshProjects(): void {
    projects = loadProjects(config.workspaceDirs);
  }

  /**
   * Callback for when the user selects a directory in the cwd picker.
   * Creates a session with the selected cwd and enqueues the original prompt.
   */
  async function onCwdSelected(pick: PendingCwdPick, selectedDir: string): Promise<void> {
    try {
      const session = await sessionManager.getOrCreate({
        threadTs: pick.threadTs,
        channelId: pick.channelId,
        cwd: selectedDir,
      });
      const { text: prompt, images } = await enrichPromptWithFiles(pick.files, pick.prompt, session.cwd, config.slackBotToken);
      session.enqueue(() => session.prompt(prompt, { images }));
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await pick.client.chat.postMessage({
          channel: pick.channelId,
          thread_ts: pick.threadTs,
          text: "⚠️ Too many active sessions. Try again later.",
        });
      }
    }
  }

  app.event("message", async ({ event, client }) => {
    if (!("user" in event) || !("text" in event)) return;
    // Allow file_share subtype through — user uploaded a file.
    // bot_message is filtered out by the subtype check (it's not "file_share").
    if (event.subtype && event.subtype !== "file_share") return;
    if (event.user !== config.slackUserId) return;

    // Refresh project list so config changes take effect immediately
    refreshProjects();

    const channel = event.channel;
    const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
    const text = event.text ?? "";

    // Extract any files attached to this message
    const slackFiles: SlackFile[] = [];
    if ("files" in event && Array.isArray((event as any).files)) {
      for (const f of (event as any).files) {
        slackFiles.push({
          id: f.id,
          name: f.name ?? "unknown",
          mimetype: f.mimetype,
          size: f.size ?? 0,
          urlPrivateDownload: f.url_private_download,
          urlPrivate: f.url_private,
        });
      }
    }

    // Command detection — handle !commands before cwd parsing
    const cmd = parseCommand(text);
    if (cmd) {
      const session = sessionManager.get(threadTs);
      await dispatchCommand(cmd.name, cmd.args, {
        channel,
        threadTs,
        client,
        sessionManager,
        session,
      });
      return;
    }

    // Check for pending Ralph preset prompt follow-up
    const ralphFollow = tryConsumeRalphPrompt(threadTs, text);
    if (ralphFollow) {
      ralphFollow.session.enqueue(() => ralphFollow.session.prompt(ralphFollow.command));
      return;
    }

    // Thread replies skip cwd parsing — session already exists
    const isThreadReply = "thread_ts" in event && event.thread_ts !== undefined;
    if (isThreadReply) {
      const existing = sessionManager.get(threadTs);
      if (existing) {
        const { text: prompt, images } = await enrichPromptWithFiles(slackFiles, text, existing.cwd, config.slackBotToken);
        existing.enqueue(() => existing.prompt(prompt, { images }));
        return;
      }
      // Thread reply but no session — fall through to create with cwd picker
    }

    try {
      // Show directory browser for the user to pick a working directory
      await postCwdPicker({
        client,
        channel,
        threadTs,
        prompt: text,
        files: slackFiles,
        projects,
        onSelect: onCwdSelected,
      });
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "⚠️ Too many active sessions. Try again later.",
        });
        return;
      }
      throw err;
    }
  });

  /* ── Reaction handler ─────────────────────────────────────────── */

  app.event("reaction_added", async ({ event, client }) => {
    // Only handle reactions on messages
    if (event.item.type !== "message") return;
    // Only respond to the allowed user
    if (event.user !== config.slackUserId) return;

    const channel = event.item.channel;
    const messageTs = event.item.ts;
    const emoji = event.reaction;

    // Only handle mapped reactions
    if (!(emoji in REACTION_MAP)) return;

    // Find the thread this message belongs to. The reaction event gives us
    // the message ts but not the thread_ts. We need to look up the message
    // to find its thread. For simplicity, check if any session matches.
    // The message could be the thread parent or a reply — either way,
    // we need the thread_ts.
    let threadTs: string | undefined;
    try {
      const msgInfo = await client.conversations.replies({
        channel,
        ts: messageTs,
        limit: 1,
        inclusive: true,
      });
      const msg = msgInfo.messages?.[0];
      threadTs = msg?.thread_ts ?? msg?.ts;
    } catch {
      // Can't determine thread — ignore
      return;
    }

    if (!threadTs) return;
    const session = sessionManager.get(threadTs);
    if (!session) return;

    const handled = await handleReaction(emoji, session, client, channel, threadTs);
    if (handled) {
      // Remove the reaction to indicate it was processed
      try {
        await client.reactions.remove({
          channel,
          timestamp: messageTs,
          name: emoji,
        });
      } catch {
        // Reaction may already be removed or we lack permission
      }
    }
  });

  /* ── Action handler helper ─────────────────────────────────────── */

  /** Register a Slack button action handler with standard boilerplate. */
  function onButtonAction(
    actionId: string | RegExp,
    handler: (messageTs: string, value: string) => Promise<void>,
    opts?: { noValue?: boolean },
  ): void {
    app.action(actionId, async ({ action, body, ack }) => {
      await ack();
      if (!opts?.noValue && (action.type !== "button" || !("value" in action))) return;
      if (body.type !== "block_actions") return;
      const messageTs = body.message?.ts;
      if (!messageTs) return;
      const value = action.type === "button" && "value" in action ? action.value! : "";
      await handler(messageTs, value);
    });
  }

  /* ── CWD picker ──────────────────────────────────────────────────── */
  onButtonAction("cwd_pick_select", handleCwdSelect);
  onButtonAction(/^cwd_pick_nav_/, handleCwdNav);
  onButtonAction("cwd_pick_parent", handleCwdNav);
  onButtonAction(/^cwd_pick_pin_/, handleCwdNav);
  onButtonAction("cwd_pick_cancel", (ts) => handleCwdCancel(ts), { noValue: true });

  /* ── File picker ─────────────────────────────────────────────────── */
  onButtonAction(/^file_pick_select_/, handleFileSelect);
  onButtonAction(/^file_pick_nav_/, handleFileNav);
  onButtonAction("file_pick_nav_parent", handleFileNav);
  onButtonAction("file_pick_cancel", (ts) => handleFilePickCancel(ts), { noValue: true });

  /* ── Ralph preset picker ─────────────────────────────────────────── */
  onButtonAction(/^ralph_preset_/, handleRalphPresetSelect);

  /* ── Prompt template picker ──────────────────────────────────────── */
  onButtonAction(/^prompt_pick_/, handlePromptSelect);

  /* ── Session resume picker ──────────────────────────────────────── */
  onButtonAction(/^resume_project_/, handleResumeProjectSelect);
  onButtonAction(/^resume_session_/, handleResumeSessionSelect);

  return {
    app,
    sessionManager,
  };
}
