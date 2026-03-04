import { slackifyMarkdown } from "slackify-markdown";

/**
 * Convert markdown to Slack mrkdwn.
 * If partial=true, close any unclosed triple-backtick code blocks first
 * so slackify-markdown doesn't produce broken output mid-stream.
 */
export function markdownToMrkdwn(markdown: string, partial?: boolean): string {
  let md = markdown;
  if (partial) {
    const fenceCount = (md.match(/```/g) ?? []).length;
    if (fenceCount % 2 !== 0) md += "\n```";
  }
  md = convertMarkdownTables(md);
  return slackifyMarkdown(md);
}

/**
 * Convert markdown tables to code blocks so they render with monospace
 * alignment in Slack (which doesn't support tables in mrkdwn).
 *
 * Detects consecutive lines starting with `|` and wraps them in a
 * fenced code block. Skips tables already inside code blocks.
 */
export function convertMarkdownTables(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let tableBuffer: string[] = [];

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return;
    // Only convert if it looks like a real table (has separator row)
    const hasSeparator = tableBuffer.some((l) =>
      /^\|[\s:|-]+\|$/.test(l.trim())
    );
    if (hasSeparator && tableBuffer.length >= 3) {
      // Remove the separator row and reformat as aligned text in a code block
      const dataRows = tableBuffer.filter(
        (l) => !/^\|[\s:|-]+\|$/.test(l.trim())
      );
      const parsed = dataRows.map((row) =>
        row
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim())
      );
      // Calculate column widths
      const colCount = Math.max(...parsed.map((r) => r.length));
      const widths: number[] = [];
      for (let c = 0; c < colCount; c++) {
        widths.push(Math.max(...parsed.map((r) => (r[c] ?? "").length)));
      }
      // Format rows with padding
      const formatted = parsed.map((row) =>
        row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ")
      );
      // Add a separator after header
      const sep = widths.map((w) => "─".repeat(w)).join("──");
      result.push("```");
      result.push(formatted[0]);
      result.push(sep);
      for (let i = 1; i < formatted.length; i++) {
        result.push(formatted[i]);
      }
      result.push("```");
    } else {
      // Not a real table, pass through as-is
      result.push(...tableBuffer);
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      tableBuffer.push(line);
    } else {
      flushTable();
      result.push(line);
    }
  }

  flushTable();
  return result.join("\n");
}

/**
 * Split mrkdwn into chunks ≤ limit chars.
 * Split priority: paragraph break > line break > space > hard cut.
 * Never splits inside a code block (counts ``` pairs).
 */
export function splitMrkdwn(mrkdwn: string, limit = 3000): string[] {
  if (mrkdwn.length <= limit) return [mrkdwn];

  const chunks: string[] = [];
  let remaining = mrkdwn;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // Find a safe split point — not inside a code block
    const splitAt = findSplitPoint(window);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

function findSplitPoint(text: string): number {
  // Try paragraph break first, then line break, then space
  for (const sep of ["\n\n", "\n", " "]) {
    const idx = lastSafeSplit(text, sep);
    if (idx > 0) return idx + sep.length;
  }
  // Hard cut
  return text.length;
}

/**
 * Find the last occurrence of sep that is NOT inside a code block.
 * Returns the index of sep, or -1 if none found.
 */
function lastSafeSplit(text: string, sep: string): number {
  let best = -1;
  let inCode = false;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i)) {
      inCode = !inCode;
      i += 3;
      continue;
    }
    if (!inCode && text.startsWith(sep, i)) {
      best = i;
      i += sep.length;
      continue;
    }
    i++;
  }

  return best;
}

/**
 * Format a tool execution start line for inline streaming display.
 * → "> 🔧 `tool_name`(arg1, arg2)"
 */
export function formatToolStart(toolName: string, args: unknown): string {
  const argStr = formatToolArgs(toolName, args);
  return `> 🔧 \`${toolName}\`(${argStr})`;
}

/**
 * Format a tool execution end line.
 * → "> ✅ `tool_name`" or "> ❌ `tool_name`"
 */
export function formatToolEnd(toolName: string, isError: boolean): string {
  const icon = isError ? "❌" : "✅";
  return `> ${icon} \`${toolName}\``;
}

/**
 * A recorded tool call for the activity log.
 */
export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  startTime: number;
  endTime?: number;
  isError?: boolean;
}

/**
 * Format a tool activity log from recorded tool calls.
 * Produces a clean text summary suitable for a Slack file snippet.
 */
export function formatToolLog(records: ToolCallRecord[]): string {
  if (records.length === 0) return "";

  const lines: string[] = [];
  lines.push("─── Tool Activity ─────────────────────────────────────");

  let totalDuration = 0;
  let failCount = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const num = String(i + 1).padStart(2, " ");
    const icon = r.isError ? "✗" : "✓";
    const duration = r.endTime ? (r.endTime - r.startTime) / 1000 : 0;
    totalDuration += duration;
    if (r.isError) failCount++;

    const desc = describeToolCall(r.toolName, r.args);
    const durStr = duration >= 0.1 ? `${duration.toFixed(1)}s` : "<0.1s";
    lines.push(`${num}. ${icon} ${desc}  ${durStr}`);
  }

  lines.push("───────────────────────────────────────────────────────");
  const failStr = failCount > 0 ? ` (${failCount} failed)` : "";
  lines.push(`${records.length} tools ran${failStr} in ${totalDuration.toFixed(1)}s`);

  return lines.join("\n");
}

/**
 * Format tool arguments with tool-specific intelligence.
 * Shows the most relevant arg(s) per tool type.
 */
export function formatToolArgs(toolName: string, args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncateStr(String(args), 60);

  const obj = args as Record<string, unknown>;

  // Tool-specific formatting: show the most relevant argument
  switch (toolName) {
    case "read":
    case "write":
      return truncateStr(String(obj.path ?? ""), 60);
    case "edit":
      return truncateStr(String(obj.path ?? ""), 60);
    case "bash":
      return truncateStr(String(obj.command ?? ""), 60);
    case "web_search":
      return truncateStr(String(obj.query ?? obj.queries ?? ""), 60);
    case "fetch_content":
      return truncateStr(String(obj.url ?? obj.urls ?? ""), 60);
    case "file_picker":
      return truncateStr(String(obj.startDir ?? obj.message ?? ""), 60);
    case "share_file":
      return truncateStr(String(obj.path ?? ""), 60);
    default:
      return formatGenericArgs(obj);
  }
}

function formatGenericArgs(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";

  return entries
    .slice(0, 3)
    .map(([, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return truncateStr(s, 40);
    })
    .join(", ");
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/**
 * Shorten a file path for display — last 2 components.
 */
export function shortPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return parts.slice(-2).join("/");
}

/**
 * Human-readable one-liner describing a tool call.
 * Used for inline streaming display and the tool log.
 */
export function describeToolCall(toolName: string, args: unknown, opts?: { mrkdwn?: boolean }): string {
  const bt = opts?.mrkdwn ? "`" : "";
  if (!args || typeof args !== "object") return `${bt}${toolName}${bt}`;
  const obj = args as Record<string, unknown>;

  switch (toolName) {
    case "read": {
      const p = shortPath(String(obj.path ?? ""));
      return `Read ${bt}${p}${bt}`;
    }
    case "write": {
      const p = shortPath(String(obj.path ?? ""));
      return `Wrote ${bt}${p}${bt}`;
    }
    case "edit": {
      const p = shortPath(String(obj.path ?? ""));
      return `Edited ${bt}${p}${bt}`;
    }
    case "bash": {
      const cmd = String(obj.command ?? "").split("\n")[0];
      return `Ran ${bt}${truncateStr(cmd, 50)}${bt}`;
    }
    case "web_search": {
      const q = String(obj.query ?? obj.queries ?? "");
      return `Searched "${truncateStr(q, 40)}"`;
    }
    case "fetch_content": {
      const u = String(obj.url ?? obj.urls ?? "");
      return `Fetched ${bt}${truncateStr(u, 50)}${bt}`;
    }
    case "file_picker":
      return "File picker";
    case "share_file": {
      const p = shortPath(String(obj.path ?? ""));
      return `Shared ${bt}${p}${bt}`;
    }
    default: {
      const argStr = formatToolArgs(toolName, args);
      return `${bt}${toolName}${bt}(${argStr})`;
    }
  }
}

/**
 * Format a completed tool record for inline Slack display.
 * → "> ✓ Read `formatter.ts`" or "> ✗ Ran `npm test` _(3.1s)_"
 */
export function formatToolCompleted(record: ToolCallRecord): string {
  const icon = record.isError ? "✗" : "✓";
  const desc = describeToolCall(record.toolName, record.args, { mrkdwn: true });
  const duration = record.endTime ? record.endTime - record.startTime : 0;
  const durStr = duration >= 1000 ? ` _(${(duration / 1000).toFixed(1)}s)_` : "";
  return `> ${icon} ${desc}${durStr}`;
}

/**
 * One-line summary of tool activity for the final message.
 * → "> 📋 8 tool calls (3.2s): read ×3, edit ×3, command ×2"
 */
export function formatToolSummaryLine(records: ToolCallRecord[]): string {
  if (records.length === 0) return "";

  const counts: Record<string, number> = {};
  for (const r of records) {
    const label = toolActionLabel(r.toolName);
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const parts = Object.entries(counts).map(([label, count]) =>
    count > 1 ? `${label} ×${count}` : label,
  );

  const totalMs = records.reduce((sum, r) => sum + (r.endTime ? r.endTime - r.startTime : 0), 0);
  const timeStr = totalMs >= 1000 ? ` (${(totalMs / 1000).toFixed(1)}s)` : "";

  return `> 📋 ${records.length} tool calls${timeStr}: ${parts.join(", ")}`;
}

function toolActionLabel(toolName: string): string {
  switch (toolName) {
    case "read": return "read";
    case "write": return "write";
    case "edit": return "edit";
    case "bash": return "command";
    case "web_search": return "search";
    case "fetch_content": return "fetch";
    case "file_picker": return "file picker";
    case "share_file": return "share";
    default: return toolName;
  }
}
