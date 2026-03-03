import { config as loadDotenv } from "dotenv";
loadDotenv();

import { loadConfig } from "./config.js";
import { createApp } from "./slack.js";

const config = loadConfig();

console.log("pi-slack-bot starting...");
console.log({
  slackBotToken: config.slackBotToken.slice(0, 10) + "...",
  slackAppToken: config.slackAppToken.slice(0, 10) + "...",
  slackUserId: config.slackUserId,
  provider: config.provider,
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  maxSessions: config.maxSessions,
  sessionIdleTimeoutSecs: config.sessionIdleTimeoutSecs,
  sessionDir: config.sessionDir,
  streamThrottleMs: config.streamThrottleMs,
  slackMsgLimit: config.slackMsgLimit,
  workspaceDirs: config.workspaceDirs,
  attachPort: config.attachPort,
});

const app = createApp(config);

await app.start();
console.log("Bot running");

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await app.stop();
  process.exit(0);
});
