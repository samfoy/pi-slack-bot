/**
 * Button-based file picker tool for the Slack bot.
 *
 * When the agent calls `file_picker`, we post Slack buttons showing the
 * contents of a directory.  The user can navigate into subdirectories or
 * select a file.  The tool blocks until a file is selected (or the
 * request is cancelled / times out).
 */
import { readdirSync, statSync } from "fs";
import { resolve, join, dirname } from "path";
import { Type, type Static } from "@sinclair/typebox";
import type { WebClient } from "@slack/web-api";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncLabel, chunk, section, actions, button, MAX_SLACK_BLOCKS, type SlackBlock } from "./picker-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FilePickerContext {
  client: WebClient;
  channelId: string;
  threadTs: string;
}

export interface PendingPick {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  /** The message TS of the picker so we can update it on navigation / selection. */
  pickerMessageTs: string;
  /** Context needed for follow-up Slack API calls. */
  ctx: FilePickerContext;
  /** Current directory being displayed. */
  currentDir: string;
  /** Timer for auto-timeout. */
  timer: ReturnType<typeof setTimeout>;
  /** The cwd that was passed to the tool (for "go up" boundary). */
  rootCwd: string;
}

/* ------------------------------------------------------------------ */
/*  Registry — maps Slack message TS → pending pick promise            */
/* ------------------------------------------------------------------ */

const pending = new Map<string, PendingPick>();

/** Look up a pending pick by the picker message TS. */
export function getPendingPick(messageTs: string): PendingPick | undefined {
  return pending.get(messageTs);
}

/** Remove a pending pick (called after selection or timeout). */
export function removePendingPick(messageTs: string): void {
  const p = pending.get(messageTs);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(messageTs);
  }
}

/* ------------------------------------------------------------------ */
/*  Slack action handlers (called from slack.ts)                       */
/* ------------------------------------------------------------------ */

const MAX_BUTTONS = 20; // leave room for nav buttons in the 25-element limit
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Handle a file_pick_select action (user clicked a file).
 */
export async function handleFileSelect(messageTs: string, value: string): Promise<void> {
  const pick = pending.get(messageTs);
  if (!pick) return;

  removePendingPick(messageTs);

  // Update the picker message to show selection
  await pick.ctx.client.chat.update({
    channel: pick.ctx.channelId,
    ts: pick.pickerMessageTs,
    text: `📄 Selected: \`${value}\``,
    blocks: [],
  });

  pick.resolve(value);
}

/**
 * Handle a file_pick_nav action (user clicked a directory to navigate into).
 */
export async function handleFileNav(messageTs: string, dir: string): Promise<void> {
  const pick = pending.get(messageTs);
  if (!pick) return;

  pick.currentDir = dir;

  // Rebuild picker in the same message
  const blocks = buildPickerBlocks(dir, pick.rootCwd);
  await pick.ctx.client.chat.update({
    channel: pick.ctx.channelId,
    ts: pick.pickerMessageTs,
    text: `📂 Browsing \`${dir}\``,
    blocks: blocks,
  });
}

/**
 * Handle cancel action.
 */
export async function handleFilePickCancel(messageTs: string): Promise<void> {
  const pick = pending.get(messageTs);
  if (!pick) return;

  removePendingPick(messageTs);

  await pick.ctx.client.chat.update({
    channel: pick.ctx.channelId,
    ts: pick.pickerMessageTs,
    text: "❌ File picker cancelled.",
    blocks: [],
  });

  pick.reject(new Error("File picker cancelled by user."));
}

/* ------------------------------------------------------------------ */
/*  Build Slack blocks for a directory listing                         */
/* ------------------------------------------------------------------ */

interface DirEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
}

function listDir(dir: string): DirEntry[] {
  try {
    const entries = readdirSync(dir);
    const results: DirEntry[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue; // skip hidden files
      const fullPath = join(dir, name);
      try {
        const stat = statSync(fullPath);
        results.push({ name, isDir: stat.isDirectory(), fullPath });
      } catch {
        // skip unreadable entries
      }
    }
    // Sort: directories first, then alphabetical
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return results;
  } catch {
    return [];
  }
}

function buildPickerBlocks(dir: string, rootCwd: string): SlackBlock[] {
  const entries = listDir(dir);
  const blocks: SlackBlock[] = [];

  blocks.push(section(`📂 *\`${dir}\`*\nSelect a file or navigate into a folder:`));

  // Navigation buttons: Up (if not at rootCwd)
  const navBtns = [];
  const resolvedDir = resolve(dir);
  const resolvedRoot = resolve(rootCwd);
  if (resolvedDir !== resolvedRoot) {
    navBtns.push(button("⬆️ Parent", "file_pick_nav_parent", dirname(dir)));
  }
  navBtns.push(button("❌ Cancel", "file_pick_cancel", "cancel", "danger"));

  blocks.push(actions(navBtns));

  // Directory buttons
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  // Show directories as navigation buttons
  if (dirs.length > 0) {
    const dirChunks = chunk(dirs, MAX_BUTTONS);
    for (const group of dirChunks) {
      blocks.push(actions(group.map((entry, i) =>
        button(`📁 ${truncLabel(entry.name)}`, `file_pick_nav_${blocks.length}_${i}`, entry.fullPath)
      )));
    }
  }

  // Show files as select buttons
  if (files.length > 0) {
    const fileChunks = chunk(files, MAX_BUTTONS);
    for (const group of fileChunks) {
      blocks.push(actions(group.map((entry, i) =>
        button(`📄 ${truncLabel(entry.name)}`, `file_pick_select_${blocks.length}_${i}`, entry.fullPath)
      )));
    }
  }

  if (dirs.length === 0 && files.length === 0) {
    blocks.push(section("_Empty directory_"));
  }

  // Slack has a 50-block limit; truncate if needed
  if (blocks.length > MAX_SLACK_BLOCKS) {
    blocks.length = MAX_SLACK_BLOCKS - 1;
    blocks.push(section("_…too many entries to display. Use a more specific startDir._"));
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Tool definition factory                                            */
/* ------------------------------------------------------------------ */

const FilePickerParams = Type.Object({
  startDir: Type.Optional(
    Type.String({
      description:
        "Directory to start browsing from. Defaults to the session's working directory. Can be absolute or relative to cwd.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Optional message to display to the user explaining what file to pick.",
    }),
  ),
});

type FilePickerInput = Static<typeof FilePickerParams>;

/**
 * Create a file_picker ToolDefinition bound to a Slack context.
 *
 * The `getContext` callback is called at tool-execution time to get the
 * current Slack channel/thread (these may change if the session moves).
 */
export function createFilePickerTool(
  cwd: string,
  getContext: () => FilePickerContext,
): ToolDefinition {
  return {
    name: "file_picker",
    label: "File Picker",
    description:
      "Show an interactive file picker to the user in Slack. " +
      "The user can browse directories and select a file using buttons. " +
      "Returns the absolute path of the selected file. " +
      "Use this when you need the user to choose a specific file and you don't know the exact path.",
    promptSnippet:
      "Show an interactive file browser in Slack. User navigates with buttons and selects a file. Returns the absolute path.",
    parameters: FilePickerParams,
    async execute(_toolCallId, params: FilePickerInput, signal) {
      const ctx = getContext();
      const startDir = params.startDir
        ? resolve(cwd, params.startDir)
        : cwd;

      const headerMsg = params.message
        ? `🗂️ *${params.message}*\n\n`
        : "";

      // Post the picker
      const blocks = buildPickerBlocks(startDir, cwd);
      if (headerMsg) {
        // Prepend the user message to the first section block
        const firstSection = blocks[0] as { text?: { text?: string } };
        if (firstSection?.text?.text) {
          firstSection.text.text = headerMsg + firstSection.text.text;
        }
      }

      const result = await ctx.client.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: ctx.threadTs,
        text: `📂 Browsing \`${startDir}\``,
        blocks: blocks,
      });

      const messageTs = result.ts!;

      // Create a promise that resolves when the user picks a file
      const selectedFile = await new Promise<string>((res, rej) => {
        const timer = setTimeout(() => {
          removePendingPick(messageTs);
          // Update the message to show timeout
          ctx.client.chat.update({
            channel: ctx.channelId,
            ts: messageTs,
            text: "⏰ File picker timed out.",
            blocks: [],
          }).catch(() => {});
          rej(new Error("File picker timed out after 5 minutes."));
        }, TIMEOUT_MS);

        pending.set(messageTs, {
          resolve: res,
          reject: rej,
          pickerMessageTs: messageTs,
          ctx,
          currentDir: startDir,
          timer,
          rootCwd: cwd,
        });

        // Handle abort signal
        signal?.addEventListener("abort", () => {
          const p = pending.get(messageTs);
          if (p) {
            removePendingPick(messageTs);
            ctx.client.chat.update({
              channel: ctx.channelId,
              ts: messageTs,
              text: "🛑 File picker aborted.",
              blocks: [],
            }).catch(() => {});
            rej(new Error("File picker aborted."));
          }
        });
      });

      return {
        content: [{ type: "text", text: selectedFile }],
        details: { selectedFile },
      };
    },
  } as ToolDefinition;
}
