/**
 * Shared utilities for Slack Block Kit picker UIs.
 */
import type { KnownBlock, Block, Button, SectionBlock, ActionsBlock } from "@slack/types";

/** Slack Block Kit block. */
export type SlackBlock = KnownBlock | Block;

/** Slack button element. */
export type SlackButton = Button;

/* ── Block builders ─────────────────────────────────────────────── */

/** Build a section block with mrkdwn text. */
export function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

/** Build an actions block with button elements. */
export function actions(elements: Button[]): ActionsBlock {
  return { type: "actions", elements };
}

/** Build a button element. */
export function button(text: string, actionId: string, value: string, style?: "primary" | "danger"): Button {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

/* ── Utilities ──────────────────────────────────────────────────── */

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

/** Maximum blocks Slack allows per message. */
export const MAX_SLACK_BLOCKS = 50;
