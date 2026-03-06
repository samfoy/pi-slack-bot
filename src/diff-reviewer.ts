/**
 * Diff reviewer — generates and uploads git diffs for files modified by the agent.
 *
 * After each agent turn, if edit/write tools were used, this uploads the
 * git diff as a Slack file snippet so users can review changes inline.
 * Also provides an on-demand `!diff` command.
 */
import { execSync } from "child_process";
import type { WebClient } from "@slack/web-api";
import type { ToolCallRecord } from "./formatter.js";

/** Tool names that modify files on disk. */
const FILE_MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Extract the list of file paths modified by edit/write tool calls.
 * Returns deduplicated paths in call order.
 */
export function extractModifiedFiles(records: ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const r of records) {
    if (!FILE_MUTATING_TOOLS.has(r.toolName)) continue;
    const args = r.args as Record<string, unknown> | null;
    const filePath = args?.path;
    if (typeof filePath !== "string") continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }

  return paths;
}

/**
 * Check whether any tool records include file-mutating operations.
 */
export function hasFileModifications(records: ToolCallRecord[]): boolean {
  return records.some((r) => FILE_MUTATING_TOOLS.has(r.toolName));
}

export interface DiffResult {
  /** The raw unified diff output */
  diff: string;
  /** Number of files with changes */
  fileCount: number;
  /** Summary stats: insertions, deletions */
  stats: string;
}

/**
 * Generate a git diff for the working directory.
 * Includes both staged and unstaged changes.
 * Returns null if not in a git repo or no changes found.
 */
export function generateDiff(cwd: string): DiffResult | null {
  try {
    // Check if we're in a git repo
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
  } catch {
    return null;
  }

  try {
    // Get diff of all changes (staged + unstaged) including new files.
    // `git diff HEAD` shows staged+unstaged vs last commit.
    // For brand new repos with no commits, fall back to `git diff --cached`.
    let diff: string;
    try {
      diff = execSync("git diff HEAD", { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 });
    } catch {
      diff = execSync("git diff --cached", { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 });
    }

    // Also pick up untracked new files by diffing them against /dev/null
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd,
      encoding: "utf-8",
    }).trim();

    if (untracked) {
      for (const file of untracked.split("\n").filter(Boolean)) {
        try {
          const fileDiff = execSync(`git diff --no-index /dev/null "${file}" || true`, {
            cwd,
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
          });
          if (fileDiff.trim()) {
            diff += "\n" + fileDiff;
          }
        } catch {
          // Some files may not be diffable, skip
        }
      }
    }

    if (!diff.trim()) return null;

    // Count files and get stats
    let stats: string;
    try {
      const statOut = execSync("git diff HEAD --stat", { cwd, encoding: "utf-8" });
      const lastLine = statOut.trim().split("\n").pop() ?? "";
      stats = lastLine.trim();
    } catch {
      stats = "";
    }

    const fileCount = (diff.match(/^diff --git/gm) ?? []).length
      + (diff.match(/^diff --no-index/gm) ?? []).length;

    return { diff, fileCount, stats };
  } catch (err) {
    console.error("[DiffReviewer] Error generating diff:", err);
    return null;
  }
}

/**
 * Upload a diff as a Slack file snippet in the thread.
 */
export async function uploadDiff(
  client: WebClient,
  channelId: string,
  threadTs: string,
  diff: DiffResult,
): Promise<void> {
  const title = `📝 ${diff.fileCount} file${diff.fileCount === 1 ? "" : "s"} changed`;
  const comment = diff.stats ? `> ${diff.stats}` : undefined;

  await client.files.uploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    content: diff.diff,
    filename: "changes.diff",
    title,
    initial_comment: comment,
  });
}

/**
 * Post a diff review for the current working directory.
 * Called after agent turns (auto) or on-demand via !diff.
 * Returns true if a diff was posted, false if no changes found.
 */
export async function postDiffReview(
  client: WebClient,
  channelId: string,
  threadTs: string,
  cwd: string,
): Promise<boolean> {
  const result = generateDiff(cwd);
  if (!result) return false;

  await uploadDiff(client, channelId, threadTs, result);
  return true;
}
