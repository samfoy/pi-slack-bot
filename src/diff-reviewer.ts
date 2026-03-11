/**
 * Diff reviewer — generates git diffs and posts them for review.
 *
 * Handles three scenarios:
 * 1. Uncommitted changes → `git diff HEAD` + untracked files
 * 2. Agent committed during turn → `git diff <baseRef>` to capture committed + uncommitted
 * 3. No git repo → synthetic diffs from edit/write tool args
 *
 * Uses a PasteProvider (configurable) for syntax-highlighted links,
 * with Slack file upload as universal fallback.
 */
import { execSync } from "child_process";
import type { WebClient } from "@slack/web-api";
import type { ToolCallRecord } from "./formatter.js";
import type { PasteProvider } from "./paste-provider.js";
import { createLogger } from "./logger.js";

const log = createLogger("diff-reviewer");

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
 * Get the current git HEAD SHA for a directory.
 * Returns null if not in a git repo or no commits exist.
 */
export function getHeadRef(cwd: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a directory is inside a git repo.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface GenerateDiffOptions {
  baseRef?: string;
}

/**
 * Generate a git diff for the working directory.
 * Returns null if not in a git repo or no changes found.
 */
export function generateDiff(cwd: string, options?: GenerateDiffOptions): DiffResult | null {
  if (!isGitRepo(cwd)) return null;

  try {
    const baseRef = options?.baseRef;
    let diff: string;
    const diffCmd = baseRef ? `git diff ${baseRef}` : "git diff HEAD";
    try {
      diff = execSync(diffCmd, { cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
    } catch {
      diff = execSync("git diff --cached", { cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
    }

    diff = appendUntrackedDiffs(diff, cwd);

    if (!diff.trim()) return null;

    return buildDiffResult(diff);
  } catch (err) {
    log.error("Error generating diff", { error: err });
    return null;
  }
}

/**
 * Append diffs for untracked files (new files not yet `git add`-ed).
 */
function appendUntrackedDiffs(diff: string, cwd: string): string {
  const untracked = execSync("git ls-files --others --exclude-standard", {
    cwd,
    encoding: "utf-8",
  }).trim();

  if (!untracked) return diff;

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
      // Some files may not be diffable (binary, etc.), skip
    }
  }

  return diff;
}

/**
 * Generate a synthetic diff from edit/write tool records.
 * Used when the working directory is not a git repo.
 */
export function generateSyntheticDiff(records: ToolCallRecord[], _cwd: string): DiffResult | null {
  const parts: string[] = [];
  const seenWrites = new Set<string>();
  const reversed = [...records].reverse();
  const toProcess: ToolCallRecord[] = [];

  for (const r of reversed) {
    if (r.toolName === "write") {
      const args = r.args as Record<string, unknown> | null;
      const filePath = typeof args?.path === "string" ? args.path : null;
      if (!filePath || seenWrites.has(filePath)) continue;
      seenWrites.add(filePath);
      toProcess.unshift(r);
    } else if (r.toolName === "edit") {
      toProcess.unshift(r);
    }
  }

  for (const r of toProcess) {
    const args = r.args as Record<string, unknown> | null;
    if (!args) continue;
    const filePath = typeof args.path === "string" ? args.path : null;
    if (!filePath) continue;

    if (r.toolName === "edit") {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      if (oldText || newText) {
        parts.push(formatEditDiff(filePath, oldText, newText));
      }
    } else if (r.toolName === "write") {
      const content = typeof args.content === "string" ? args.content : "";
      parts.push(formatNewFileDiff(filePath, content));
    }
  }

  if (parts.length === 0) return null;

  const diff = parts.join("\n");
  return buildDiffResult(diff);
}

function formatEditDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const header = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ];
  return [...header, ...body].join("\n");
}

function formatNewFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const header = [
    `diff --git a/${path} b/${path}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  const body = lines.map((l) => `+${l}`);
  return [...header, ...body].join("\n");
}

function buildDiffResult(diff: string): DiffResult {
  const { fileCount, insertions, deletions } = computeDiffStats(diff);
  const statParts: string[] = [];
  statParts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
  if (insertions > 0) statParts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  if (deletions > 0) statParts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return { diff, fileCount, stats: statParts.join(", ") };
}

/**
 * Compute diff stats by parsing the unified diff content directly.
 */
export function computeDiffStats(diff: string): {
  fileCount: number;
  insertions: number;
  deletions: number;
} {
  const lines = diff.split("\n");
  let fileCount = 0;
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --no-index ")) {
      fileCount++;
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        insertions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
      }
    }
  }

  return { fileCount, insertions, deletions };
}

/**
 * Upload a diff via paste provider (preferred) or Slack file snippet (fallback).
 */
async function uploadAndPost(
  client: WebClient,
  channelId: string,
  threadTs: string,
  result: DiffResult,
  pasteProvider: PasteProvider,
): Promise<void> {
  const title = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"} changed`;

  // Try the configured paste provider first
  const paste = await pasteProvider.create(result.diff, title);
  if (paste) {
    const statsLine = result.stats ? `\n> ${result.stats}` : "";
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `📝 <${paste.url}|${title}>${statsLine}`,
      unfurl_links: false,
    });
    return;
  }

  // Fallback: upload as Slack file snippet
  await client.files.uploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    content: result.diff,
    filename: "changes.diff",
    title: `📝 ${title}`,
    initial_comment: result.stats ? `> ${result.stats}` : undefined,
  });
}

export interface PostDiffOptions {
  baseRef?: string | null;
  toolRecords?: ToolCallRecord[];
  pasteProvider?: PasteProvider;
}

/**
 * Post a diff review for the current working directory.
 * Returns true if a diff was posted, false if no changes found.
 */
export async function postDiffReview(
  client: WebClient,
  channelId: string,
  threadTs: string,
  cwd: string,
  options?: PostDiffOptions,
): Promise<boolean> {
  const baseRef = options?.baseRef ?? undefined;
  const toolRecords = options?.toolRecords;

  // Lazy-import to avoid circular dependency; default to NullPasteProvider
  const { NullPasteProvider } = await import("./paste-provider.js");
  const pasteProvider = options?.pasteProvider ?? new NullPasteProvider();

  const gitResult = generateDiff(cwd, { baseRef });
  if (gitResult) {
    await uploadAndPost(client, channelId, threadTs, gitResult, pasteProvider);
    return true;
  }

  if (toolRecords && toolRecords.length > 0) {
    const syntheticResult = generateSyntheticDiff(toolRecords, cwd);
    if (syntheticResult) {
      await uploadAndPost(client, channelId, threadTs, syntheticResult, pasteProvider);
      return true;
    }
  }

  return false;
}
