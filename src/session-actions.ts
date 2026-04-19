/**
 * Shared session actions used by both !commands and emoji reactions.
 *
 * Each action takes a session and a reply function, keeping them
 * independent of the Slack API surface (commands.ts provides `reply(ctx, ...)`,
 * reactions.ts provides `client.chat.postMessage(...)`).
 */
import type { ThreadSession } from "./thread-session.js";
import { postDiffReview } from "./diff-reviewer.js";
import { formatTokenCount } from "./context-format.js";
import type { WebClient } from "@slack/web-api";
import { createLogger } from "./logger.js";

const log = createLogger("session-actions");

/* ------------------------------------------------------------------ */
/*  Active session tracking & graceful shutdown                        */
/* ------------------------------------------------------------------ */

interface TrackedSession {
  session: ThreadSession;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

/** Map of threadTs → tracked session info (sessions + inactivity timers). */
const activeSessions = new Map<string, TrackedSession>();

/** Register a session for shutdown tracking. */
export function trackSession(threadTs: string, session: ThreadSession): void {
  activeSessions.set(threadTs, { session, inactivityTimer: null });
}

/** Unregister a session from shutdown tracking. */
export function untrackSession(threadTs: string): void {
  const tracked = activeSessions.get(threadTs);
  if (tracked?.inactivityTimer) {
    clearTimeout(tracked.inactivityTimer);
  }
  activeSessions.delete(threadTs);
}

/** Set an inactivity timer for a tracked session. */
export function setInactivityTimer(
  threadTs: string,
  timer: ReturnType<typeof setTimeout>,
): void {
  const tracked = activeSessions.get(threadTs);
  if (tracked) {
    if (tracked.inactivityTimer) clearTimeout(tracked.inactivityTimer);
    tracked.inactivityTimer = timer;
  }
}

/** Clear all inactivity timers and kill all tracked sessions. */
export async function cleanupAllSessions(): Promise<void> {
  log.info("Cleaning up all tracked sessions", { count: activeSessions.size });
  const disposePromises: Promise<void>[] = [];
  for (const [threadTs, tracked] of activeSessions) {
    if (tracked.inactivityTimer) {
      clearTimeout(tracked.inactivityTimer);
      tracked.inactivityTimer = null;
    }
    try {
      disposePromises.push(tracked.session.dispose());
    } catch (err) {
      log.error("Error disposing session during cleanup", { threadTs, error: err });
    }
  }
  await Promise.allSettled(disposePromises);
  activeSessions.clear();
}

/** Install SIGTERM/SIGINT handlers for graceful session cleanup. */
export function installShutdownHandlers(): void {
  const handler = () => {
    log.info("Shutdown signal received, cleaning up sessions");
    cleanupAllSessions().catch((err) => {
      log.error("Error during shutdown cleanup", { error: err });
    });
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

/** A function that posts a message to the thread. */
export type ReplyFn = (text: string) => Promise<void>;

/**
 * Cancel the current agent stream.
 */
export function cancelSession(session: ThreadSession, reply: ReplyFn): Promise<void> {
  session.abort();
  return reply("🛑 Cancelled.");
}

/**
 * Show a git diff review for the session's working directory.
 */
export async function showDiff(
  session: ThreadSession,
  reply: ReplyFn,
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<void> {
  const posted = await postDiffReview(client, channel, threadTs, session.cwd, {
    pasteProvider: session.pasteProvider,
  });
  if (!posted) {
    await reply("No uncommitted changes found (or not a git repo).");
  }
}

/**
 * Compact the conversation context window.
 */
export async function compactSession(session: ThreadSession, reply: ReplyFn): Promise<void> {
  if (session.isStreaming) {
    await reply("❌ Can't compact while streaming. Wait for the current turn to finish.");
    return;
  }
  await reply("🗜️ Compacting conversation...");
  try {
    const result = await session.compact();
    const afterUsage = session.getContextUsage();
    const beforeStr = formatTokenCount(result.tokensBefore);
    const afterStr = afterUsage?.tokens != null ? formatTokenCount(afterUsage.tokens) : "unknown";
    await reply(`🗜️ Compacted: ${beforeStr} → ${afterStr} tokens`);
  } catch (err) {
    await reply(`❌ Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
