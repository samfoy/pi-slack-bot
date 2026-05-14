/**
 * Context window formatting utilities.
 *
 * Provides human-readable formatting for token counts, context usage,
 * and visual progress bars for Slack display.
 */
import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/**
 * Format a token count as a human-readable string.
 * - < 1000: "750"
 * - 1000–999999: "45.2K"
 * - >= 1000000: "1.2M"
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    // Use one decimal for small K values, round for larger ones
    const rounded = Math.round(k * 10) / 10;
    return rounded < 10 ? `${rounded.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  const m = n / 1_000_000;
  const roundedM = Math.round(m * 10) / 10;
  return roundedM < 10 ? `${roundedM.toFixed(1)}M` : `${Math.round(m)}M`;
}

/**
 * Format a ContextUsage object as a single-line summary.
 * e.g. "45.2K / 200K tokens (23%)"
 */
export function formatContextUsage(usage: ContextUsage): string {
  const window = formatTokenCount(usage.contextWindow);
  if (usage.tokens === null || usage.percent === null) {
    return `unknown / ${window} tokens`;
  }
  const used = formatTokenCount(usage.tokens);
  return `${used} / ${window} tokens (${Math.round(usage.percent)}%)`;
}

/**
 * Generate a visual progress bar for context usage.
 * e.g. "[████████░░░░░░░░] 50%"
 *
 * @param percent — 0–100
 * @param width — number of bar characters (default 16)
 */
export function formatContextBar(percent: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${Math.round(clamped)}%`;
}

/** Warning thresholds for context usage (ascending order). */
export const CONTEXT_WARNING_THRESHOLDS = [80, 90] as const;

/**
 * Determine if a context warning should be posted.
 * Returns the threshold that was crossed, or null if no warning needed.
 *
 * @param percent — current context usage percentage
 * @param lastWarningThreshold — the last threshold we warned about (0 if never warned)
 */
export function getContextWarningThreshold(
  percent: number,
  lastWarningThreshold: number,
): number | null {
  // Walk thresholds in descending order so we return the highest crossed threshold
  for (let i = CONTEXT_WARNING_THRESHOLDS.length - 1; i >= 0; i--) {
    const threshold = CONTEXT_WARNING_THRESHOLDS[i];
    if (percent >= threshold && lastWarningThreshold < threshold) {
      return threshold;
    }
  }
  return null;
}
