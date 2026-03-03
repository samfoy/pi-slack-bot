import { App } from "@slack/bolt";
import type { Config } from "./config.js";

export function createApp(config: Config): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  app.event("message", async ({ event, client }) => {
    // Only handle plain message events (subtype undefined = user message)
    if (!("user" in event) || !("text" in event)) return;
    if (event.subtype === "bot_message") return;
    if (event.user !== config.slackUserId) return;

    const channel = event.channel;
    const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
    const text = event.text ?? "";

    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
    });
  });

  return app;
}
