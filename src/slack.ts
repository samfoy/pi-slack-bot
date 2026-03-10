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
  downloadSlackFiles,
  formatInboundFileContext,
  type SlackFile,
} from "./file-sharing.js";
import {
  postCwdPicker,
  handleCwdSelect,
  handleCwdNav,
  handleCwdCancel,
  type PendingCwdPick,
} from "./cwd-picker.js";

/**
 * If the message has attached files, download them into the cwd and
 * prepend context about them to the prompt text.
 */
async function enrichPromptWithFiles(
  files: SlackFile[],
  text: string,
  cwd: string,
  botToken: string,
): Promise<string> {
  if (files.length === 0) return text;

  const downloaded = await downloadSlackFiles(files, cwd, botToken);
  const context = formatInboundFileContext(downloaded);
  if (!context) return text;

  return text ? `${context}\n\n${text}` : context;
}

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
      const prompt = await enrichPromptWithFiles(pick.files, pick.prompt, session.cwd, config.slackBotToken);
      session.enqueue(() => session.prompt(prompt));
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
        const prompt = await enrichPromptWithFiles(slackFiles, text, existing.cwd, config.slackBotToken);
        existing.enqueue(() => existing.prompt(prompt));
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

  /* ── CWD picker action handlers ──────────────────────────────────── */

  // Select current directory as cwd
  app.action("cwd_pick_select", async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleCwdSelect(messageTs, action.value!);
  });

  // Navigate into a subdirectory
  app.action(/^cwd_pick_nav_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleCwdNav(messageTs, action.value!);
  });

  // Navigate to parent directory
  app.action("cwd_pick_parent", async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleCwdNav(messageTs, action.value!);
  });

  // Jump to a pinned project
  app.action(/^cwd_pick_pin_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleCwdNav(messageTs, action.value!);
  });

  // Cancel the cwd picker
  app.action("cwd_pick_cancel", async ({ action, body, ack }) => {
    await ack();
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleCwdCancel(messageTs);
  });

  /* ── File picker action handlers ─────────────────────────────────── */

  // File selected
  app.action(/^file_pick_select_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFileSelect(messageTs, action.value!);
  });

  // Navigate into a directory
  app.action(/^file_pick_nav_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFileNav(messageTs, action.value!);
  });

  // Navigate to parent directory
  app.action("file_pick_nav_parent", async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFileNav(messageTs, action.value!);
  });

  // Cancel file picker
  app.action("file_pick_cancel", async ({ action, body, ack }) => {
    await ack();
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleFilePickCancel(messageTs);
  });

  /* ── Ralph preset picker action handlers ─────────────────────────── */

  app.action(/^ralph_preset_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleRalphPresetSelect(messageTs, action.value!);
  });

  /* ── Prompt template picker action handlers ──────────────────────── */

  app.action(/^prompt_pick_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handlePromptSelect(messageTs, action.value!);
  });

  /* ── Session resume picker action handlers ──────────────────────── */

  app.action(/^resume_project_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleResumeProjectSelect(messageTs, action.value!);
  });

  app.action(/^resume_session_/, async ({ action, body, ack }) => {
    await ack();
    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;
    await handleResumeSessionSelect(messageTs, action.value!);
  });

  return {
    app,
    sessionManager,
  };
}
