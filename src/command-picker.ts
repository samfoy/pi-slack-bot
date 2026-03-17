/**
 * Button-based pickers for Slack bot commands.
 *
 * Provides interactive Slack button flows for:
 * - Prompt templates: pick a template to run
 *
 * These are posted as Slack Block Kit messages and resolved via action handlers.
 */
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import { section, safeSections, actions, button, type SlackBlock } from "./picker-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PendingPrompt {
  threadTs: string;
  channelId: string;
  client: WebClient;
  session: ThreadSession;
  pickerMessageTs: string;
}

/* ------------------------------------------------------------------ */
/*  Registries                                                         */
/* ------------------------------------------------------------------ */

const pendingPromptPick = new Map<string, PendingPrompt>();

export function getPendingPromptPick(messageTs: string): PendingPrompt | undefined {
  return pendingPromptPick.get(messageTs);
}
export function removePendingPromptPick(messageTs: string): void {
  pendingPromptPick.delete(messageTs);
}

/* ------------------------------------------------------------------ */
/*  Prompt template picker                                             */
/* ------------------------------------------------------------------ */

export async function postPromptPicker(
  client: WebClient,
  channel: string,
  threadTs: string,
  session: ThreadSession,
): Promise<void> {
  const templates = session.promptTemplates;

  if (templates.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "❌ No prompt templates found. Add `.md` files to `~/.pi/agent/prompts/`.",
    });
    return;
  }

  const blocks: SlackBlock[] = [
    section("📝 *Pick a prompt template:*"),
  ];

  // Split into action blocks (max 25 buttons each)
  const MAX_PER_BLOCK = 25;
  for (let i = 0; i < templates.length; i += MAX_PER_BLOCK) {
    const tmplChunk = templates.slice(i, i + MAX_PER_BLOCK);
    blocks.push(actions(tmplChunk.map((t, j) => button(`/${t.name}`, `prompt_pick_${i + j}`, t.name))));
  }

  // Add descriptions
  const descLines = templates
    .map((t) => `\`/${t.name}\` — ${t.description || "_no description_"}`)
    .join("\n");
  if (descLines) {
    blocks.push(...safeSections(descLines));
  }

  // Cap at 50 blocks
  if (blocks.length > 50) blocks.length = 50;

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "📝 Pick a prompt template",
    blocks: blocks,
  });

  if (result.ts) {
    pendingPromptPick.set(result.ts, {
      threadTs,
      channelId: channel,
      client,
      session,
      pickerMessageTs: result.ts,
    });
  }
}

/**
 * Handle prompt template selection — run it immediately via the session.
 */
export async function handlePromptSelect(
  messageTs: string,
  templateName: string,
): Promise<void> {
  const pending = pendingPromptPick.get(messageTs);
  if (!pending) return;

  removePendingPromptPick(messageTs);

  // Update picker to show selection
  await pending.client.chat.update({
    channel: pending.channelId,
    ts: messageTs,
    text: `📝 Running \`/${templateName}\``,
    blocks: [],
  });

  // Enqueue the prompt template command
  const command = `/${templateName}`;
  pending.session.enqueue(() => pending.session.prompt(command));
}

/* ------------------------------------------------------------------ */
/*  Test helpers — expose internal maps for testing                    */
/* ------------------------------------------------------------------ */

/** @internal — for tests only */
export function _setPendingPromptPick(key: string, value: PendingPrompt): void {
  pendingPromptPick.set(key, value);
}
