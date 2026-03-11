/**
 * Session picker for browsing and resuming local pi TUI sessions in Slack.
 *
 * Provides:
 * - `!resume` — Browse local pi sessions grouped by project, pick one to resume in Slack
 * - `!to-tui` — Get a `pi --session <path>` command for the current Slack session
 *
 * Uses pi's SessionManager.listAll() to discover sessions from ~/.pi/agent/sessions/.
 */
import { basename } from "path";
import { SessionManager as PiSessionManager, type SessionInfo } from "@mariozechner/pi-coding-agent";
import type { WebClient } from "@slack/web-api";
import type { ThreadSession } from "./thread-session.js";
import type { BotSessionManager } from "./session-manager.js";
import { encodeCwd } from "./session-path.js";
import { asBlocks } from "./picker-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PendingResume {
  threadTs: string;
  channelId: string;
  client: WebClient;
  sessionManager: BotSessionManager;
  pickerMessageTs: string;
  /** The sessions available (indexed by button value) */
  sessions: SessionInfo[];
  /** If set, we're showing sessions for a specific project dir */
  projectDir?: string;
}

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

const pendingResumes = new Map<string, PendingResume>();

export function getPendingResume(messageTs: string): PendingResume | undefined {
  return pendingResumes.get(messageTs);
}
export function removePendingResume(messageTs: string): void {
  pendingResumes.delete(messageTs);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Truncate text to maxLen with ellipsis. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/** Format a date as relative time (e.g., "2h ago", "3d ago"). */
function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Slack limits: max 25 buttons per actions block, max 5 actions blocks per message. */
const MAX_BUTTONS_PER_BLOCK = 25;
const MAX_ACTIONS_BLOCKS = 5;
const MAX_TOTAL_BUTTONS = MAX_BUTTONS_PER_BLOCK * MAX_ACTIONS_BLOCKS;

/* ------------------------------------------------------------------ */
/*  Project directory picker (step 1)                                  */
/* ------------------------------------------------------------------ */

/**
 * Post a picker showing all project directories that have sessions.
 * User picks a project → then sees sessions for that project.
 */
export async function postProjectSessionPicker(
  client: WebClient,
  channel: string,
  threadTs: string,
  sessionManager: BotSessionManager,
): Promise<void> {
  // List all sessions to find unique project directories
  const allSessions = (await PiSessionManager.listAll())
    .filter((s) => !s.firstMessage?.startsWith("[Ralph Loop"));

  if (allSessions.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "📭 No local pi sessions found.",
    });
    return;
  }

  // Group by cwd (project directory)
  const byProject = new Map<string, SessionInfo[]>();
  for (const s of allSessions) {
    const cwd = s.cwd || "unknown";
    if (!byProject.has(cwd)) byProject.set(cwd, []);
    byProject.get(cwd)!.push(s);
  }

  // Sort projects by most recent session
  const projects = [...byProject.entries()]
    .map(([cwd, sessions]) => ({
      cwd,
      sessions,
      lastModified: Math.max(...sessions.map((s) => s.modified.getTime())),
      count: sessions.length,
    }))
    .sort((a, b) => b.lastModified - a.lastModified);

  // If only one project, skip straight to session list
  if (projects.length === 1) {
    await postSessionList(client, channel, threadTs, sessionManager, projects[0].cwd, projects[0].sessions);
    return;
  }

  // Build project buttons
  const choices = projects.slice(0, MAX_TOTAL_BUTTONS).map((p, i) => {
    const label = basename(p.cwd) || p.cwd;
    return {
      label: truncate(`${label} (${p.count})`, 75),
      value: p.cwd,
      index: i,
    };
  });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: "📂 *Pick a project to browse sessions:*" },
    },
  ];

  for (let i = 0; i < choices.length; i += MAX_BUTTONS_PER_BLOCK) {
    const chunk = choices.slice(i, i + MAX_BUTTONS_PER_BLOCK);
    blocks.push({
      type: "actions",
      elements: chunk.map((c) => ({
        type: "button",
        text: { type: "plain_text", text: c.label },
        action_id: `resume_project_${c.index}`,
        value: c.value,
      })),
    });
  }

  // Add descriptions
  const descLines = projects.slice(0, 15).map((p) =>
    `\`${p.cwd}\` — ${p.count} session${p.count > 1 ? "s" : ""}, last ${relativeTime(new Date(p.lastModified))}`
  ).join("\n");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: descLines },
  });

  if (blocks.length > 50) blocks.length = 50;

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "📂 Pick a project to browse sessions",
    blocks: asBlocks(blocks),
  });

  if (result.ts) {
    pendingResumes.set(result.ts, {
      threadTs,
      channelId: channel,
      client,
      sessionManager,
      pickerMessageTs: result.ts,
      sessions: allSessions,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Session list picker (step 2)                                       */
/* ------------------------------------------------------------------ */

async function postSessionList(
  client: WebClient,
  channel: string,
  threadTs: string,
  sessionManager: BotSessionManager,
  projectDir: string,
  sessions: SessionInfo[],
): Promise<void> {
  // Sort by modified descending (most recent first)
  const sorted = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const capped = sorted.slice(0, MAX_TOTAL_BUTTONS);

  const projectLabel = basename(projectDir) || projectDir;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `📋 *Sessions in \`${projectLabel}\`:*` },
    },
  ];

  const choices = capped.map((s, i) => {
    const name = s.name || truncate(s.firstMessage || s.id, 60);
    const time = relativeTime(s.modified);
    return {
      label: truncate(`${name} (${time})`, 75),
      path: s.path,
      index: i,
    };
  });

  for (let i = 0; i < choices.length; i += MAX_BUTTONS_PER_BLOCK) {
    const chunk = choices.slice(i, i + MAX_BUTTONS_PER_BLOCK);
    blocks.push({
      type: "actions",
      elements: chunk.map((c) => ({
        type: "button",
        text: { type: "plain_text", text: c.label },
        action_id: `resume_session_${c.index}`,
        value: c.path,
      })),
    });
  }

  // Descriptions
  const descLines = capped.slice(0, 10).map((s) => {
    const name = s.name ? `*${s.name}*` : "_unnamed_";
    const msg = truncate(s.firstMessage || "—", 80);
    return `${name} — ${msg} (${s.messageCount} msgs, ${relativeTime(s.modified)})`;
  }).join("\n");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: descLines },
  });

  if (blocks.length > 50) blocks.length = 50;

  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `📋 Sessions in ${projectLabel}`,
    blocks: asBlocks(blocks),
  });

  if (result.ts) {
    pendingResumes.set(result.ts, {
      threadTs,
      channelId: channel,
      client,
      sessionManager,
      pickerMessageTs: result.ts,
      sessions: capped,
      projectDir,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Action handlers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Handle project directory selection → show sessions for that project.
 */
export async function handleResumeProjectSelect(
  messageTs: string,
  projectDir: string,
): Promise<void> {
  const pending = pendingResumes.get(messageTs);
  if (!pending) return;
  pendingResumes.delete(messageTs);

  // Update picker message
  await pending.client.chat.update({
    channel: pending.channelId,
    ts: messageTs,
    text: `📂 Browsing sessions in \`${projectDir}\``,
    blocks: [],
  });

  // Filter sessions for this project and show session list
  const projectSessions = pending.sessions.filter((s) => s.cwd === projectDir);
  await postSessionList(
    pending.client,
    pending.channelId,
    pending.threadTs,
    pending.sessionManager,
    projectDir,
    projectSessions,
  );
}

/**
 * Handle session selection → resume it in the Slack thread.
 */
export async function handleResumeSessionSelect(
  messageTs: string,
  sessionPath: string,
): Promise<void> {
  const pending = pendingResumes.get(messageTs);
  if (!pending) return;
  pendingResumes.delete(messageTs);

  const selectedSession = pending.sessions.find((s) => s.path === sessionPath);
  const sessionName = selectedSession?.name || truncate(selectedSession?.firstMessage || sessionPath, 60);

  // Update picker message
  await pending.client.chat.update({
    channel: pending.channelId,
    ts: messageTs,
    text: `✅ Resuming: ${sessionName}`,
    blocks: [],
  });

  const cwd = selectedSession?.cwd || process.cwd();

  try {
    // Dispose existing session in this thread if any
    const existing = pending.sessionManager.get(pending.threadTs);
    if (existing) {
      await pending.sessionManager.dispose(pending.threadTs);
    }

    // Resume the selected session file — the agent will have full history
    await pending.sessionManager.getOrCreate({
      threadTs: pending.threadTs,
      channelId: pending.channelId,
      cwd,
      resumeSessionPath: sessionPath,
    });

    await pending.client.chat.postMessage({
      channel: pending.channelId,
      thread_ts: pending.threadTs,
      text: [
        `🔗 *Resumed session:* ${sessionName}`,
        `📂 CWD: \`${cwd}\``,
        `💬 ${selectedSession?.messageCount ?? "?"} messages loaded`,
        "",
        `To also open in your terminal:\n\`\`\`pi --session ${sessionPath}\`\`\``,
      ].join("\n"),
    });
  } catch (err) {
    await pending.client.chat.postMessage({
      channel: pending.channelId,
      thread_ts: pending.threadTs,
      text: `❌ Failed to resume: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  to-tui helper                                                      */
/* ------------------------------------------------------------------ */

/**
 * Post the `pi --session <path>` command for the current Slack session.
 */
export async function postToTuiCommand(
  client: WebClient,
  channel: string,
  threadTs: string,
  session: ThreadSession | undefined,
  sessionDir: string,
): Promise<void> {
  if (!session) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "No active session.",
    });
    return;
  }

  const cwdEncoded = encodeCwd(session.cwd);
  const sessionFile = `${sessionDir}/${cwdEncoded}/${threadTs}.jsonl`;

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: [
      "🖥️ *Open this session in your terminal:*",
      "```",
      `pi --session ${sessionFile}`,
      "```",
      `📂 CWD: \`${session.cwd}\``,
      `💬 ${session.messageCount} messages`,
    ].join("\n"),
  });
}
