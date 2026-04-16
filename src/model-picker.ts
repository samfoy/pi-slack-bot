/**
 * Button-based model picker for Slack bot.
 *
 * Shows available models grouped by provider as interactive Slack buttons.
 * The user clicks a model to switch to it immediately.
 */
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import { section, safeSections, actions, button, chunk, MAX_SLACK_BLOCKS, type SlackBlock } from "./picker-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
}

export interface PendingModelPick {
  threadTs: string;
  channelId: string;
  client: WebClient;
  session: ThreadSession;
  pickerMessageTs: string;
  /** Flat list of models in the order they were rendered as buttons. */
  models: ModelInfo[];
}

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

const pendingModelPick = new Map<string, PendingModelPick>();

export function getPendingModelPick(messageTs: string): PendingModelPick | undefined {
  return pendingModelPick.get(messageTs);
}

export function removePendingModelPick(messageTs: string): void {
  pendingModelPick.delete(messageTs);
}

/* ------------------------------------------------------------------ */
/*  Model discovery                                                    */
/* ------------------------------------------------------------------ */

/** Get available models from the session's model registry, grouped by provider. */
export function getAvailableModels(session: ThreadSession, allowlist: string[] = []): Map<string, ModelInfo[]> {
  const registry = session.modelRegistry;
  let models = registry.getAvailable();

  if (allowlist.length > 0) {
    models = models.filter((m) => allowlist.some((pattern) => m.id.toLowerCase().includes(pattern)));  
  }

  const grouped = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const info: ModelInfo = {
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
    };
    const list = grouped.get(m.provider) ?? [];
    list.push(info);
    grouped.set(m.provider, list);
  }

  // Sort models within each provider by name
  for (const list of grouped.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  return grouped;
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

function modelLabel(model: ModelInfo): string {
  return model.id;
}

function modelDescription(model: ModelInfo, isCurrentModel: boolean): string {
  const parts: string[] = [];
  if (isCurrentModel) parts.push("✅ *current*");
  if (model.reasoning) parts.push("🧠 reasoning");
  parts.push(`${formatContextWindow(model.contextWindow)} ctx`);
  return `\`${model.id}\` — ${parts.join(" · ")}`;
}

/* ------------------------------------------------------------------ */
/*  Model picker                                                       */
/* ------------------------------------------------------------------ */

export async function postModelPicker(
  client: WebClient,
  channel: string,
  threadTs: string,
  session: ThreadSession,
  modelAllowlist: string[] = [],
): Promise<void> {
  const grouped = getAvailableModels(session, modelAllowlist);

  if (grouped.size === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "❌ No models available. Configure API keys in pi settings.",
    });
    return;
  }

  const currentModelId = session.model?.id;
  const blocks: SlackBlock[] = [
    section("🤖 *Pick a model:*"),
  ];

  // Flatten for index tracking
  const allModels: ModelInfo[] = [];

  // Sort providers alphabetically
  const sortedProviders = [...grouped.keys()].sort();

  for (const provider of sortedProviders) {
    const models = grouped.get(provider)!;

    // Provider header
    blocks.push(section(`*${provider}*`));

    // Buttons for this provider (max 5 per actions block per Slack rules)
    const MAX_BUTTONS_PER_BLOCK = 5;
    for (const btnChunk of chunk(models, MAX_BUTTONS_PER_BLOCK)) {
      const buttons = btnChunk.map((m) => {
        const idx = allModels.length;
        allModels.push(m);
        const isCurrent = m.id === currentModelId && m.provider === session.model?.provider;
        const label = isCurrent ? `✅ ${modelLabel(m)}` : modelLabel(m);
        return button(label, `model_pick_${idx}`, String(idx));
      });
      blocks.push(actions(buttons));
    }

    // Description lines for this provider's models
    const descLines = models.map((m) => {
      const isCurrent = m.id === currentModelId && m.provider === session.model?.provider;
      return modelDescription(m, isCurrent);
    }).join("\n");
    blocks.push(...safeSections(descLines));
  }

  // Cap at Slack's block limit
  if (blocks.length > MAX_SLACK_BLOCKS) blocks.length = MAX_SLACK_BLOCKS;

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "🤖 Pick a model",
    blocks,
  });

  if (result.ts) {
    pendingModelPick.set(result.ts, {
      threadTs,
      channelId: channel,
      client,
      session,
      pickerMessageTs: result.ts,
      models: allModels,
    });
  }
}

/**
 * Handle model selection — switch the session model immediately.
 */
export async function handleModelSelect(
  messageTs: string,
  value: string,
): Promise<void> {
  const pending = pendingModelPick.get(messageTs);
  if (!pending) return;

  const idx = parseInt(value, 10);
  if (isNaN(idx) || idx < 0 || idx >= pending.models.length) return;

  const selected = pending.models[idx];
  removePendingModelPick(messageTs);

  try {
    await pending.session.setModel(selected.id);

    // Update picker to show selection
    await pending.client.chat.update({
      channel: pending.channelId,
      ts: messageTs,
      text: `🤖 Model set to \`${selected.id}\``,
      blocks: [
        section(`🤖 Model set to \`${selected.id}\` (${selected.provider})`),
      ],
    });
  } catch (err) {
    await pending.client.chat.update({
      channel: pending.channelId,
      ts: messageTs,
      text: `❌ Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
      blocks: [],
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

/** @internal — for tests only */
export function _setPendingModelPick(key: string, value: PendingModelPick): void {
  pendingModelPick.set(key, value);
}
