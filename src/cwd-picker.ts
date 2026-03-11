/**
 * Interactive directory browser for picking a working directory in Slack.
 *
 * When a user sends a first message without a valid cwd path, we post
 * Slack buttons showing directories starting from home. The user can
 * navigate into subdirectories, jump to pinned projects, go up to parent,
 * or select the current directory as the session cwd.
 */
import { readdirSync, statSync } from "fs";
import { resolve, join, dirname } from "path";
import { homedir } from "os";
import type { WebClient } from "@slack/web-api";
import type { Project } from "./parser.js";
import type { SlackFile } from "./file-sharing.js";
import { truncLabel, chunk, section, actions, button, MAX_SLACK_BLOCKS, type SlackBlock } from "./picker-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PendingCwdPick {
  threadTs: string;
  channelId: string;
  /** The user's original message text, sent as the prompt once a dir is selected. */
  prompt: string;
  /** Files the user shared with this message, pending download after cwd is selected. */
  files: SlackFile[];
  /** The message TS of the picker so we can update it on navigation / selection. */
  pickerMessageTs: string;
  /** Slack client for follow-up API calls. */
  client: WebClient;
  /** Current directory being displayed. */
  currentDir: string;
  /** Timer for auto-timeout. */
  timer: ReturnType<typeof setTimeout>;
  /** Pinned project shortcuts for quick-jump buttons. */
  projects: Project[];
  /** Callback invoked when a directory is selected. */
  onSelect: (pick: PendingCwdPick, selectedDir: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Registry — maps Slack message TS → pending pick                    */
/* ------------------------------------------------------------------ */

const pending = new Map<string, PendingCwdPick>();

/** Look up a pending cwd pick by the picker message TS. */
export function getPendingCwdPick(messageTs: string): PendingCwdPick | undefined {
  return pending.get(messageTs);
}

/** Remove a pending cwd pick (called after selection, cancel, or timeout). */
export function removePendingCwdPick(messageTs: string): void {
  const p = pending.get(messageTs);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(messageTs);
  }
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_DIR_BUTTONS = 20; // leave room for nav/control buttons in the 25-element limit
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PIN_BUTTONS = 10; // max pinned shortcuts per block

/* ------------------------------------------------------------------ */
/*  List directories only                                              */
/* ------------------------------------------------------------------ */

interface DirEntry {
  name: string;
  fullPath: string;
}

export function listDirs(dir: string): DirEntry[] {
  try {
    const entries = readdirSync(dir);
    const results: DirEntry[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue; // skip hidden
      const fullPath = join(dir, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push({ name, fullPath });
        }
      } catch {
        // skip unreadable entries
      }
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Build Slack blocks for the directory browser                       */
/* ------------------------------------------------------------------ */

export function buildCwdPickerBlocks(
  dir: string,
  projects: Project[],
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Header with current path
  blocks.push(section(`📂 *\`${dir}\`*\nSelect this directory or navigate into a folder:`));

  // Control buttons: Select, Parent, Cancel
  const controlBtns = [
    button("✅ Select this directory", "cwd_pick_select", dir, "primary"),
  ];

  const resolvedDir = resolve(dir);
  if (resolvedDir !== "/") {
    controlBtns.push(button("⬆️ Parent", "cwd_pick_parent", dirname(dir)));
  }

  controlBtns.push(button("❌ Cancel", "cwd_pick_cancel", "cancel", "danger"));

  blocks.push(actions(controlBtns));

  // Pinned project shortcuts (if any, and not already in the current dir listing)
  if (projects.length > 0) {
    const pinChunks = chunk(projects.slice(0, MAX_PIN_BUTTONS * 2), MAX_PIN_BUTTONS);
    for (const group of pinChunks) {
      blocks.push(actions(group.map((p, i) =>
        button(`📌 ${truncLabel(p.label)}`, `cwd_pick_pin_${blocks.length}_${i}`, p.path)
      )));
    }
  }

  // Directory listing
  const dirs = listDirs(dir);

  if (dirs.length > 0) {
    const dirChunks = chunk(dirs, MAX_DIR_BUTTONS);
    for (const group of dirChunks) {
      blocks.push(actions(group.map((entry, i) =>
        button(`📁 ${truncLabel(entry.name)}`, `cwd_pick_nav_${blocks.length}_${i}`, entry.fullPath)
      )));
    }
  } else {
    blocks.push(section("_No subdirectories_"));
  }

  // Slack has a 50-block limit; truncate if needed
  if (blocks.length > MAX_SLACK_BLOCKS) {
    blocks.length = MAX_SLACK_BLOCKS - 1;
    blocks.push(section("_…too many entries to display._"));
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Post the cwd picker                                                */
/* ------------------------------------------------------------------ */

export interface PostCwdPickerParams {
  client: WebClient;
  channel: string;
  threadTs: string;
  prompt: string;
  files: SlackFile[];
  projects: Project[];
  startDir?: string;
  onSelect: (pick: PendingCwdPick, selectedDir: string) => void;
}

export async function postCwdPicker(params: PostCwdPickerParams): Promise<void> {
  const startDir = params.startDir ?? homedir();
  const blocks = buildCwdPickerBlocks(startDir, params.projects);

  const result = await params.client.chat.postMessage({
    channel: params.channel,
    thread_ts: params.threadTs,
    text: `📂 Browsing \`${startDir}\``,
    blocks: blocks,
  });

  if (!result.ts) return;

  const messageTs = result.ts;

  const timer = setTimeout(async () => {
    removePendingCwdPick(messageTs);
    await params.client.chat.update({
      channel: params.channel,
      ts: messageTs,
      text: "⏰ Directory picker timed out.",
      blocks: [],
    }).catch(() => {});
  }, TIMEOUT_MS);

  pending.set(messageTs, {
    threadTs: params.threadTs,
    channelId: params.channel,
    prompt: params.prompt,
    files: params.files,
    pickerMessageTs: messageTs,
    client: params.client,
    currentDir: startDir,
    timer,
    projects: params.projects,
    onSelect: params.onSelect,
  });
}

/* ------------------------------------------------------------------ */
/*  Action handlers (called from slack.ts)                             */
/* ------------------------------------------------------------------ */

/**
 * Handle selecting the current directory as cwd.
 */
export async function handleCwdSelect(messageTs: string, selectedDir: string): Promise<void> {
  const pick = pending.get(messageTs);
  if (!pick) return;

  removePendingCwdPick(messageTs);

  // Update the picker message to show selection
  await pick.client.chat.update({
    channel: pick.channelId,
    ts: pick.pickerMessageTs,
    text: `📂 Using \`${selectedDir}\``,
    blocks: [],
  });

  pick.onSelect(pick, selectedDir);
}

/**
 * Handle navigating into a directory (or jumping to a pinned project).
 */
export async function handleCwdNav(messageTs: string, dir: string): Promise<void> {
  const pick = pending.get(messageTs);
  if (!pick) return;

  pick.currentDir = dir;

  const blocks = buildCwdPickerBlocks(dir, pick.projects);
  await pick.client.chat.update({
    channel: pick.channelId,
    ts: pick.pickerMessageTs,
    text: `📂 Browsing \`${dir}\``,
    blocks: blocks,
  });
}

/**
 * Handle cancel action.
 */
export async function handleCwdCancel(messageTs: string): Promise<void> {
  const pick = pending.get(messageTs);
  if (!pick) return;

  removePendingCwdPick(messageTs);

  await pick.client.chat.update({
    channel: pick.channelId,
    ts: pick.pickerMessageTs,
    text: "❌ Directory picker cancelled.",
    blocks: [],
  });
}
