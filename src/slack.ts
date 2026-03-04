import { App } from "@slack/bolt";
import { basename } from "path";
import { homedir } from "os";
import type { Config } from "./config.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import { parseMessage, scanProjects } from "./parser.js";
import { parseCommand, dispatchCommand } from "./commands.js";

export interface PendingCwd {
  threadTs: string;
  channelId: string;
  prompt: string;
}

export interface SlackApp {
  app: App;
  sessionManager: BotSessionManager;
  knownProjects: string[];
  pendingCwd: Map<string, PendingCwd>;
  refreshTimer: ReturnType<typeof setInterval>;
}

export function createApp(config: Config): SlackApp {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const sessionManager = new BotSessionManager(config, app.client);
  let knownProjects = scanProjects(config.workspaceDirs);
  const pendingCwd = new Map<string, PendingCwd>();

  const refreshTimer = setInterval(() => {
    knownProjects = scanProjects(config.workspaceDirs);
  }, 5 * 60 * 1000);

  app.event("message", async ({ event, client }) => {
    if (!("user" in event) || !("text" in event)) return;
    if (event.subtype === "bot_message") return;
    if (event.user !== config.slackUserId) return;

    const channel = event.channel;
    const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
    const text = event.text ?? "";

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

    // Thread replies skip cwd parsing — session already exists
    const isThreadReply = "thread_ts" in event && event.thread_ts !== undefined;
    if (isThreadReply) {
      const existing = sessionManager.get(threadTs);
      if (existing) {
        existing.enqueue(() => existing.prompt(text));
        return;
      }
      // Thread reply but no session — fall through to create with homedir
    }

    const parsed = parseMessage(text, knownProjects);

    try {
      if (parsed.cwd) {
        // Exact cwd resolved
        const session = await sessionManager.getOrCreate({
          threadTs,
          channelId: channel,
          cwd: parsed.cwd,
        });
        session.enqueue(() => session.prompt(parsed.prompt));
      } else if (parsed.candidates.length > 0) {
        // Fuzzy matches — post Block Kit buttons
        const buttons = parsed.candidates.map((candidate, i) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: basename(candidate) },
          action_id: `select_cwd_${i}`,
          value: candidate,
        }));

        const result = await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `Multiple projects match "${parsed.cwdToken}". Pick one:`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Multiple projects match \`${parsed.cwdToken}\`. Pick one:`,
              },
            },
            {
              type: "actions",
              elements: buttons,
            },
          ],
        });

        if (result.ts) {
          pendingCwd.set(result.ts, {
            threadTs,
            channelId: channel,
            prompt: parsed.prompt,
          });
        }
      } else {
        // No cwd, no candidates — use homedir
        const session = await sessionManager.getOrCreate({
          threadTs,
          channelId: channel,
          cwd: homedir(),
        });
        session.enqueue(() => session.prompt(text));
      }
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

  app.action(/^select_cwd_/, async ({ action, body, ack, client }) => {
    await ack();

    if (action.type !== "button" || !("value" in action)) return;
    if (body.type !== "block_actions") return;
    const messageTs = body.message?.ts;
    if (!messageTs) return;

    const pending = pendingCwd.get(messageTs);
    if (!pending) return;
    pendingCwd.delete(messageTs);

    const selectedCwd = action.value!;

    // Update button message to show selection
    await client.chat.update({
      channel: pending.channelId,
      ts: messageTs,
      text: `📂 Using \`${selectedCwd}\``,
      blocks: [],
    });

    try {
      const session = await sessionManager.getOrCreate({
        threadTs: pending.threadTs,
        channelId: pending.channelId,
        cwd: selectedCwd,
      });
      session.enqueue(() => session.prompt(pending.prompt));
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await client.chat.postMessage({
          channel: pending.channelId,
          thread_ts: pending.threadTs,
          text: "⚠️ Too many active sessions. Try again later.",
        });
      }
    }
  });

  return {
    app,
    sessionManager,
    get knownProjects() { return knownProjects; },
    set knownProjects(v: string[]) { knownProjects = v; },
    pendingCwd,
    refreshTimer,
  };
}
