import type { WebClient } from "@slack/web-api";
import { markdownToMrkdwn } from "./formatter.js";

export interface StreamingState {
  channelId: string;
  threadTs: string;
  currentMessageTs: string;
  rawMarkdown: string;
  toolLines: string[];
  postedMessageTs: string[];
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
}

export class StreamingUpdater {
  private _client: WebClient;
  private _throttleMs: number;

  constructor(client: WebClient, throttleMs = 3000) {
    this._client = client;
    this._throttleMs = throttleMs;
  }

  async begin(channelId: string, threadTs: string): Promise<StreamingState> {
    const res = await this._client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "⏳ Thinking...",
    });

    await this._client.reactions.add({
      channel: channelId,
      timestamp: res.ts!,
      name: "hourglass_flowing_sand",
    });

    return {
      channelId,
      threadTs,
      currentMessageTs: res.ts!,
      rawMarkdown: "",
      toolLines: [],
      postedMessageTs: [],
      timer: null,
      retryCount: 0,
    };
  }

  appendText(state: StreamingState, delta: string): void {
    state.rawMarkdown += delta;
    this._scheduleFlush(state);
  }

  appendToolStart(state: StreamingState, toolName: string, args: unknown): void {
    const argStr = formatArgs(args);
    state.toolLines.push(`> 🔧 \`${toolName}\`(${argStr})`);
    this._scheduleFlush(state);
  }

  appendToolEnd(state: StreamingState, toolName: string, isError: boolean): void {
    const icon = isError ? "❌" : "✅";
    // Replace the matching 🔧 line with the result icon
    const idx = state.toolLines.findIndex((l) => l.includes(`\`${toolName}\``) && l.includes("🔧"));
    if (idx !== -1) {
      state.toolLines[idx] = `> ${icon} \`${toolName}\``;
    } else {
      state.toolLines.push(`> ${icon} \`${toolName}\``);
    }
    this._scheduleFlush(state);
  }

  appendRetry(state: StreamingState, attempt: number): void {
    state.retryCount = attempt;
    state.rawMarkdown += `\n_↩️ Retrying (${attempt}/3)..._\n`;
    this._scheduleFlush(state);
  }

  async finalize(state: StreamingState): Promise<void> {
    this._cancelTimer(state);
    await this._flush(state, false);

    await this._client.reactions.remove({
      channel: state.channelId,
      timestamp: state.currentMessageTs,
      name: "hourglass_flowing_sand",
    });

    await this._client.reactions.add({
      channel: state.channelId,
      timestamp: state.currentMessageTs,
      name: "white_check_mark",
    });
  }

  async error(state: StreamingState, err: Error): Promise<void> {
    this._cancelTimer(state);
    await this._client.chat.postMessage({
      channel: state.channelId,
      thread_ts: state.threadTs,
      text: `❌ Error: ${err.message}`,
    });

    try {
      await this._client.reactions.remove({
        channel: state.channelId,
        timestamp: state.currentMessageTs,
        name: "hourglass_flowing_sand",
      });
    } catch {
      // reaction may already be removed
    }
  }

  private _scheduleFlush(state: StreamingState): void {
    if (state.timer !== null) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this._flush(state, true);
    }, this._throttleMs);
  }

  private _cancelTimer(state: StreamingState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private async _flush(state: StreamingState, partial: boolean): Promise<void> {
    const body = state.rawMarkdown.trim();
    const toolBlock = state.toolLines.join("\n");
    const combined = toolBlock ? `${body}\n\n${toolBlock}` : body;
    if (!combined) return;

    const mrkdwn = markdownToMrkdwn(combined, partial);

    await this._client.chat.update({
      channel: state.channelId,
      ts: state.currentMessageTs,
      text: mrkdwn,
    });
  }
}

function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > 40 ? s.slice(0, 37) + "..." : s;
    })
    .join(", ");
}
