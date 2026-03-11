/**
 * Reaction-based interactions — map emoji reactions to bot commands.
 *
 * Users can react to messages in a bot thread to trigger actions
 * without typing commands. The reaction is removed after handling
 * to provide visual feedback.
 */
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import { postDiffReview } from "./diff-reviewer.js";
import { formatTokenCount } from "./context-format.js";
import { createLogger } from "./logger.js";

const log = createLogger("reactions");

/** Map of Slack emoji names to action identifiers. */
export const REACTION_MAP: Record<string, string> = {
  x: "cancel",
  arrows_counterclockwise: "retry",
  clipboard: "diff",
  clamp: "compact",
};

async function postReply(client: WebClient, channel: string, threadTs: string, text: string): Promise<void> {
  await client.chat.postMessage({ channel, thread_ts: threadTs, text });
}

/**
 * Handle a reaction on a message in a bot thread.
 *
 * @returns true if the reaction was handled, false if the emoji is not mapped.
 */
export async function handleReaction(
  emoji: string,
  session: ThreadSession,
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  const action = REACTION_MAP[emoji];
  if (!action) return false;

  log.info("Handling reaction", { emoji, action, threadTs });

  switch (action) {
    case "cancel":
      session.abort();
      await postReply(client, channel, threadTs, "🛑 Cancelled.");
      break;

    case "retry": {
      const lastPrompt = session.lastUserPrompt;
      if (!lastPrompt) {
        await postReply(client, channel, threadTs, "No previous prompt to retry.");
        return true;
      }
      await postReply(client, channel, threadTs, `🔄 Retrying: ${lastPrompt.length > 100 ? lastPrompt.slice(0, 100) + "…" : lastPrompt}`);
      session.enqueue(() => session.prompt(lastPrompt));
      break;
    }

    case "diff": {
      const posted = await postDiffReview(client, channel, threadTs, session.cwd, {
        pasteProvider: session.pasteProvider,
      });
      if (!posted) {
        await postReply(client, channel, threadTs, "No uncommitted changes found (or not a git repo).");
      }
      break;
    }

    case "compact": {
      if (session.isStreaming) {
        await postReply(client, channel, threadTs, "❌ Can't compact while streaming. Wait for the current turn to finish.");
        return true;
      }
      await postReply(client, channel, threadTs, "🗜️ Compacting conversation...");
      try {
        const result = await session.compact();
        const afterUsage = session.getContextUsage();
        const beforeStr = formatTokenCount(result.tokensBefore);
        const afterStr = afterUsage?.tokens != null ? formatTokenCount(afterUsage.tokens) : "unknown";
        await postReply(client, channel, threadTs, `🗜️ Compacted: ${beforeStr} → ${afterStr} tokens`);
      } catch (err) {
        await postReply(client, channel, threadTs, `❌ Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }
  }

  return true;
}
