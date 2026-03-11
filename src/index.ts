import { config as loadDotenv } from "dotenv";
loadDotenv();

import { loadConfig } from "./config.js";
import { createApp } from "./slack.js";
import { createLogger } from "./logger.js";

const log = createLogger("main");
const config = loadConfig();

log.info("pi-slack-bot starting", {
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
});

const slackApp = createApp(config);

await slackApp.app.start();
log.info("Bot running");

// Restore sessions from the on-disk registry (non-blocking — failures are logged)
slackApp.sessionManager.restoreAll().then((count) => {
  if (count > 0) log.info("Restored sessions from previous run", { count });
}).catch((err) => {
  log.error("Failed to restore sessions", { error: err });
});

process.on("SIGINT", async () => {
  log.info("Shutting down");
  await slackApp.sessionManager.disposeAll();
  await slackApp.sessionManager.flushRegistry();
  slackApp.sessionManager.disposeRegistry();
  await slackApp.app.stop();
  process.exit(0);
});
