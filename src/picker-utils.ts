/**
 * Shared utilities for Slack Block Kit picker UIs.
 */

/** Truncate a label for Slack button text. */
export function truncLabel(name: string, max = 60): string {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

/** Split an array into chunks of a given size. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/** Slack Block Kit block (untyped — Slack's types are too complex for our builders). */
export type SlackBlock = Record<string, unknown>;

/**
 * Cast our SlackBlock[] to the type Slack's API expects.
 * This avoids `as any` at every call site while keeping our block builders simple.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asBlocks(blocks: SlackBlock[]): any[] {
  return blocks;
}

/** Maximum blocks Slack allows per message. */
export const MAX_SLACK_BLOCKS = 50;
