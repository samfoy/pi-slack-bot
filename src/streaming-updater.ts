import type { WebClient } from "@slack/web-api";
import { markdownToMrkdwn, splitMrkdwn, formatToolStart, formatToolLog, type ToolCallRecord } from "./formatter.js";

export interface StreamingState {
  channelId: string;
  threadTs: string;
  initialMessageTs: string;
  currentMessageTs: string;
  rawMarkdown: string;
  toolLines: string[];
  toolRecords: ToolCallRecord[];
  completedCount: number;
  failedCount: number;
  postedMessageTs: string[];
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
}

export class StreamingUpdater {
  private _client: WebClient;
  private _throttleMs: number;
  private _msgLimit: number;

  constructor(client: WebClient, throttleMs = 3000, msgLimit = 3000) {
    this._client = client;
    this._throttleMs = throttleMs;
    this._msgLimit = msgLimit;
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
      initialMessageTs: res.ts!,
      currentMessageTs: res.ts!,
      rawMarkdown: "",
      toolLines: [],
      toolRecords: [],
      completedCount: 0,
      failedCount: 0,
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
    state.toolLines.push(formatToolStart(toolName, args));
    state.toolRecords.push({ toolName, args, startTime: Date.now() });
    this._immediateFlush(state);
  }

  appendToolEnd(state: StreamingState, toolName: string, isError: boolean): void {
    // Update the matching record with end time and status
    const record = [...state.toolRecords].reverse().find(
      (r) => r.toolName === toolName && r.endTime === undefined,
    );
    if (record) {
      record.endTime = Date.now();
      record.isError = isError;
    }

    // Remove the in-progress line and bump the counter
    const idx = state.toolLines.findIndex((l) => l.includes(`\`${toolName}\``) && l.includes("🔧"));
    if (idx !== -1) {
      state.toolLines.splice(idx, 1);
    }
    if (isError) {
      state.failedCount++;
    } else {
      state.completedCount++;
    }
    this._immediateFlush(state);
  }

  appendRetry(state: StreamingState, attempt: number): void {
    state.retryCount = attempt;
    state.rawMarkdown += `\n_↩️ Retrying (${attempt}/3)..._\n`;
    this._scheduleFlush(state);
  }

  async finalize(state: StreamingState): Promise<void> {
    this._cancelTimer(state);
    await this._flush(state, false);

    // Upload tool activity log as a collapsible snippet
    if (state.toolRecords.length > 0) {
      await this._uploadToolLog(state);
    }

    await this._client.reactions.remove({
      channel: state.channelId,
      timestamp: state.initialMessageTs,
      name: "hourglass_flowing_sand",
    });

    await this._client.reactions.add({
      channel: state.channelId,
      timestamp: state.initialMessageTs,
      name: "white_check_mark",
    });
  }

  async error(state: StreamingState, err: Error): Promise<void> {
    this._cancelTimer(state);

    // Truncate error message to avoid msg_too_long on the error post itself
    const maxErrLen = this._msgLimit - 20; // room for "❌ Error: " prefix
    const msg = err.message.length > maxErrLen
      ? err.message.slice(0, maxErrLen - 3) + "..."
      : err.message;

    await this._safePost(state.channelId, state.threadTs, `❌ Error: ${msg}`);

    try {
      await this._client.reactions.remove({
        channel: state.channelId,
        timestamp: state.initialMessageTs,
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
      this._flush(state, true).catch((err) => console.error("[StreamingUpdater] flush error:", err));
    }, this._throttleMs);
  }

  private _immediateFlush(state: StreamingState): void {
    this._cancelTimer(state);
    this._flush(state, true).catch((err) => console.error("[StreamingUpdater] flush error:", err));
  }

  private _cancelTimer(state: StreamingState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /**
   * Upload tool activity log as a collapsible Slack file snippet.
   */
  private async _uploadToolLog(state: StreamingState): Promise<void> {
    const logContent = formatToolLog(state.toolRecords);
    if (!logContent) return;

    try {
      await this._client.files.uploadV2({
        channel_id: state.channelId,
        thread_ts: state.threadTs,
        content: logContent,
        filename: "tool-activity.txt",
        title: `🔧 ${state.toolRecords.length} tool calls`,
      });
    } catch (err) {
      console.error("[StreamingUpdater] Failed to upload tool log:", err);
      // Non-fatal: the response text is already posted
    }
  }

  private async _flush(state: StreamingState, partial: boolean): Promise<void> {
    const body = state.rawMarkdown.trim();

    // Build tool status block: during streaming show active tools inline;
    // on finalize (partial=false), omit — the snippet will have the details.
    let toolBlock = "";
    if (partial) {
      const parts: string[] = [];
      const total = state.completedCount + state.failedCount;
      if (total > 0) {
        const summary = state.failedCount > 0
          ? `> ✅ ${total} tools ran (${state.failedCount} failed)`
          : `> ✅ ${total} tools ran`;
        parts.push(summary);
      }
      if (state.toolLines.length > 0) {
        parts.push(...state.toolLines);
      }
      toolBlock = parts.join("\n");
    }

    const combined = toolBlock ? `${body}\n\n${toolBlock}` : body;
    if (!combined) return;

    const mrkdwn = markdownToMrkdwn(combined, partial);
    await this._postChunked(state, mrkdwn, this._msgLimit);
  }

  /**
   * Split mrkdwn into chunks and post/update. Tracks all posted messages in
   * order and updates them in-place on subsequent flushes. Only posts new
   * messages when the chunk count exceeds the number of existing messages.
   * If any Slack call returns msg_too_long, retry with a reduced limit.
   */
  private async _postChunked(state: StreamingState, mrkdwn: string, limit: number): Promise<void> {
    const chunks = splitMrkdwn(mrkdwn, limit);

    // All messages in posting order: earlier continuations + current
    const allMessages = [...state.postedMessageTs, state.currentMessageTs];

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (i < allMessages.length) {
          // Update an existing message in-place
          await this._client.chat.update({
            channel: state.channelId,
            ts: allMessages[i],
            text: chunks[i],
          });
        } else {
          // Need a new continuation message
          const res = await this._client.chat.postMessage({
            channel: state.channelId,
            thread_ts: state.threadTs,
            text: chunks[i],
          });
          allMessages.push(res.ts!);
        }
      }

      // Rebuild tracking arrays: everything before the last is "posted",
      // the last one is "current".
      const used = allMessages.slice(0, chunks.length);
      state.postedMessageTs = used.slice(0, -1);
      state.currentMessageTs = used[used.length - 1];
    } catch (err: unknown) {
      const reduced = Math.floor(limit * 0.6);
      if (this._isMsgTooLong(err) && reduced >= 100) {
        console.warn(`[StreamingUpdater] msg_too_long at limit=${limit}, retrying at ${reduced}`);
        return this._postChunked(state, mrkdwn, reduced);
      }
      throw err;
    }
  }

  /**
   * Post a message safely, truncating if it still triggers msg_too_long.
   */
  private async _safePost(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this._client.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err: unknown) {
      if (this._isMsgTooLong(err)) {
        const truncated = text.slice(0, 1500) + "\n…_(truncated)_";
        await this._client.chat.postMessage({ channel, thread_ts: threadTs, text: truncated });
      } else {
        throw err;
      }
    }
  }

  private _isMsgTooLong(err: unknown): boolean {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { error?: string } }).data;
      if (data?.error === "msg_too_long") return true;
    }
    // Also check the message string as a fallback
    return err instanceof Error && err.message.includes("msg_too_long");
  }
}
