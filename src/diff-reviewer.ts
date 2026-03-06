/**
 * Diff reviewer — generates git diffs and uploads them to paste.amazon.com
 * for syntax-highlighted review, posting the link to Slack.
 *
 * After each agent turn, if edit/write tools were used, this creates a paste
 * with the unified diff and posts a clickable link to the Slack thread.
 * Also provides an on-demand `!diff` command.
 */
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
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

    // Compute stats from the diff content itself (not git diff --stat)
    // so that untracked files are included in the summary.
    const { fileCount, insertions, deletions } = computeDiffStats(diff);

    const statParts: string[] = [];
    statParts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
    if (insertions > 0) statParts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
    if (deletions > 0) statParts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
    const stats = statParts.join(", ");

    return { diff, fileCount, stats };
  } catch (err) {
    console.error("[DiffReviewer] Error generating diff:", err);
    return null;
  }
}

/**
 * Compute diff stats by parsing the unified diff content directly.
 * This correctly counts untracked files (which `git diff HEAD --stat` misses).
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

export interface PasteResult {
  /** The paste URL (e.g. https://paste.amazon.com/show/samfp/1234567890) */
  url: string;
}

/**
 * Create a paste on paste.amazon.com with the given content.
 * Returns the paste URL, or null if the upload fails.
 *
 * Uses midway cookie auth (must have valid midway session).
 */
export function createPaste(content: string, title: string, language = "diff"): PasteResult | null {
  const cookieFile = `${process.env.HOME}/.midway/cookie`;

  try {
    // Step 1: GET the page to obtain a CSRF authenticity token
    const pageHtml = execSync(
      `curl -s --anyauth --location-trusted --negotiate -u : ` +
      `--cookie "${cookieFile}" --cookie-jar "${cookieFile}" ` +
      `"https://paste.amazon.com/"`,
      { encoding: "utf-8", timeout: 15000 },
    );

    const tokenMatch = pageHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
    if (!tokenMatch) {
      console.error("[DiffReviewer] Could not extract CSRF token from paste.amazon.com");
      return null;
    }
    const token = tokenMatch[1];

    // Step 2: POST the paste content. Write content to a temp file to avoid
    // shell escaping issues with large diffs.
    const tmpFile = `/tmp/pi-diff-paste-${Date.now()}.txt`;
    writeFileSync(tmpFile, content, "utf-8");

    try {
      const headers = execSync(
        `curl -s --anyauth --location-trusted --negotiate -u : ` +
        `--cookie "${cookieFile}" --cookie-jar "${cookieFile}" ` +
        `-X POST "https://paste.amazon.com/create" ` +
        `--data-urlencode "authenticity_token=${token}" ` +
        `--data-urlencode "text@${tmpFile}" ` +
        `--data-urlencode "language=${language}" ` +
        `--data-urlencode "title=${title}" ` +
        `--data-urlencode "numbers=1" ` +
        `-D - -o /dev/null`,
        { encoding: "utf-8", timeout: 30000 },
      );

      const locationMatch = headers.match(/^location:\s*(.+)$/mi);
      if (!locationMatch) {
        console.error("[DiffReviewer] No redirect location from paste.amazon.com create");
        return null;
      }

      return { url: locationMatch[1].trim() };
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error("[DiffReviewer] Failed to create paste:", err);
    return null;
  }
}

/**
 * Post a diff review for the current working directory.
 * Creates a syntax-highlighted paste on paste.amazon.com and posts the link.
 * Falls back to a Slack file snippet if paste creation fails.
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

  const title = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"} changed`;

  // Try paste.amazon.com first for nice syntax-highlighted rendering
  const paste = createPaste(result.diff, title);
  if (paste) {
    const statsLine = result.stats ? `\n> ${result.stats}` : "";
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `📝 <${paste.url}|${title}>${statsLine}`,
      unfurl_links: false,
    });
    return true;
  }

  // Fallback: upload as Slack file snippet
  console.warn("[DiffReviewer] paste.amazon.com failed, falling back to Slack file snippet");
  await client.files.uploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    content: result.diff,
    filename: "changes.diff",
    title: `📝 ${title}`,
    initial_comment: result.stats ? `> ${result.stats}` : undefined,
  });
  return true;
}
