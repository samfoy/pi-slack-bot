/**
 * Button-based pickers for Slack bot commands.
 *
 * Provides interactive Slack button flows for:
 * - Ralph presets: pick a preset, then enter a prompt
 * - Prompt templates: pick a template to run
 *
 * These are posted as Slack Block Kit messages and resolved via action handlers.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import { asBlocks } from "./picker-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RalphPresetInfo {
  name: string;
  hats: string[];
  description: string;
}

export interface PendingRalph {
  threadTs: string;
  channelId: string;
  client: WebClient;
  session: ThreadSession;
  pickerMessageTs: string;
  /** Set after preset is selected, waiting for prompt input. */
  selectedPreset?: string;
}

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

const pendingRalph = new Map<string, PendingRalph>();
const pendingPromptPick = new Map<string, PendingPrompt>();

export function getPendingRalph(messageTs: string): PendingRalph | undefined {
  return pendingRalph.get(messageTs);
}
export function removePendingRalph(messageTs: string): void {
  pendingRalph.delete(messageTs);
}
export function getPendingPromptPick(messageTs: string): PendingPrompt | undefined {
  return pendingPromptPick.get(messageTs);
}
export function removePendingPromptPick(messageTs: string): void {
  pendingPromptPick.delete(messageTs);
}

/* ------------------------------------------------------------------ */
/*  Ralph preset discovery                                             */
/* ------------------------------------------------------------------ */

function resolveBuiltinPresetsDir(): string {
  return join(homedir(), ".pi", "agent", "extensions", "ralph", "presets");
}

function scanPresetsDir(dir: string): RalphPresetInfo[] {
  if (!existsSync(dir)) return [];
  const results: RalphPresetInfo[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
      try {
        const content = readFileSync(join(dir, entry), "utf-8");
        // Quick validation: must have both hats: and event_loop: sections
        if (!content.includes("hats:") || !content.includes("event_loop:")) continue;

        const name = entry.replace(/\.ya?ml$/, "");
        // Extract hat names from "name:" fields under hats section
        const hatNames: string[] = [];
        const nameMatches = content.matchAll(/^\s+name:\s*"?([^"\n]+)"?\s*$/gm);
        for (const m of nameMatches) {
          hatNames.push(m[1].trim());
        }

        results.push({
          name,
          hats: hatNames,
          description: hatNames.length > 0 ? hatNames.join(" → ") : name,
        });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return results;
}

export function discoverRalphPresets(cwd: string): RalphPresetInfo[] {
  const builtinDir = resolveBuiltinPresetsDir();
  const userDir = join(homedir(), ".pi", "agent", "ralph", "presets");
  const projectDir = join(cwd, ".pi", "ralph", "presets");

  const seen = new Map<string, RalphPresetInfo>();

  // Built-in → user → project (project overrides)
  for (const dir of [builtinDir, userDir, projectDir]) {
    for (const preset of scanPresetsDir(dir)) {
      seen.set(preset.name, preset);
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/*  Ralph preset picker                                                */
/* ------------------------------------------------------------------ */

export async function postRalphPicker(
  client: WebClient,
  channel: string,
  threadTs: string,
  session: ThreadSession,
): Promise<void> {
  const presets = discoverRalphPresets(session.cwd);

  if (presets.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "❌ No Ralph presets found. Add `.yml` files to `~/.pi/agent/ralph/presets/` or `~/.pi/agent/extensions/ralph/presets/`.",
    });
    return;
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: "🎩 *Pick a Ralph preset:*" },
    },
    {
      type: "actions",
      elements: presets.map((p, i) => ({
        type: "button",
        text: { type: "plain_text", text: `${p.name}` },
        action_id: `ralph_preset_${i}`,
        value: p.name,
      })),
    },
  ];

  // Add descriptions as context
  const descLines = presets.map((p) => `*${p.name}:* ${p.description}`).join("\n");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: descLines },
  });

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "🎩 Pick a Ralph preset",
    blocks: asBlocks(blocks),
  });

  if (result.ts) {
    pendingRalph.set(result.ts, {
      threadTs,
      channelId: channel,
      client,
      session,
      pickerMessageTs: result.ts,
    });
  }
}

/**
 * Handle preset selection — update message to show selection and ask for prompt.
 */
export async function handleRalphPresetSelect(
  messageTs: string,
  presetName: string,
): Promise<void> {
  const pending = pendingRalph.get(messageTs);
  if (!pending) return;

  // Update the picker to show selected preset and prompt for task
  pending.selectedPreset = presetName;

  await pending.client.chat.update({
    channel: pending.channelId,
    ts: messageTs,
    text: `🎩 Ralph preset: *${presetName}*\nType your task prompt as a reply in this thread.`,
    blocks: asBlocks([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🎩 Selected: *${presetName}*\n\n_Send your task prompt as the next message in this thread._`,
        },
      },
    ]),
  });
}

/**
 * Check if a message in a thread is a pending Ralph prompt.
 * Returns true if the message was consumed as a Ralph prompt.
 */
export function tryConsumeRalphPrompt(
  threadTs: string,
  text: string,
): { session: ThreadSession; command: string } | null {
  // Find any pending ralph entry for this thread
  for (const [msgTs, pending] of pendingRalph) {
    if (pending.threadTs === threadTs && pending.selectedPreset) {
      pendingRalph.delete(msgTs);
      const command = `/ralph ${pending.selectedPreset} ${text}`;
      return { session: pending.session, command };
    }
  }
  return null;
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

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: "📝 *Pick a prompt template:*" },
    },
  ];

  // Split into action blocks (max 25 buttons each)
  const MAX_PER_BLOCK = 25;
  for (let i = 0; i < templates.length; i += MAX_PER_BLOCK) {
    const chunk = templates.slice(i, i + MAX_PER_BLOCK);
    blocks.push({
      type: "actions",
      elements: chunk.map((t, j) => ({
        type: "button",
        text: { type: "plain_text", text: `/${t.name}` },
        action_id: `prompt_pick_${i + j}`,
        value: t.name,
      })),
    });
  }

  // Add descriptions
  const descLines = templates
    .map((t) => `\`/${t.name}\` — ${t.description || "_no description_"}`)
    .join("\n");
  if (descLines) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: descLines },
    });
  }

  // Cap at 50 blocks
  if (blocks.length > 50) blocks.length = 50;

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "📝 Pick a prompt template",
    blocks: asBlocks(blocks),
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
export function _setPendingRalph(key: string, value: PendingRalph): void {
  pendingRalph.set(key, value);
}

/** @internal — for tests only */
export function _setPendingPromptPick(key: string, value: PendingPrompt): void {
  pendingPromptPick.set(key, value);
}
