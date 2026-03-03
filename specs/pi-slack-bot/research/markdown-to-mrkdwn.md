# Markdown → Slack mrkdwn Conversion Research

## Library Options

### slackify-markdown (recommended)

- **Package:** `slackify-markdown` v5.0.0
- **Source:** https://github.com/jsarafajr/slackify-markdown
- **License:** MIT
- **Dependencies:** 7 (Unified/Remark ecosystem)
- **Dependents:** 57
- **Node:** 22+ (v5 ESM-only; v4.x for CJS)

Built on Unified/Remark — parses Markdown AST and serializes to mrkdwn with custom handlers. Well-tested, actively maintained.

**Conversions handled:**
| Markdown | mrkdwn output |
|----------|--------------|
| `# Heading` | `*Heading*` |
| `**bold**` | `*bold*` (with zero-width-space for in-word) |
| `*italic*` | `_italic_` (with zero-width-space) |
| `~~strike~~` | `~strike~` (with zero-width-space) |
| `[text](url)` | `<url\|text>` |
| `![alt](url)` | `<url\|alt>` |
| `` ```lang\ncode\n``` `` | `` ```\ncode\n``` `` (lang stripped) |
| `> blockquote` | `> blockquote` |
| `* item` | `• item` |
| `1. item` | `1. item` |
| `<!-- comment -->` | (stripped) |
| `&`, `<`, `>` | `&amp;`, `&lt;`, `&gt;` |
| Reference-style links | Resolved to `<url\|text>` |

**Key implementation detail:** Uses zero-width-space (`\u200b`) around formatting markers to handle in-word formatting (e.g., `he**l**lo` → `he​*l*​lo`). This is necessary because Slack's mrkdwn parser requires whitespace boundaries for formatting, but zero-width-space tricks it.

**Passthrough:** Slack-native syntax like `<@U123>` user mentions and `<#C123>` channel refs are preserved (they look like HTML to the Markdown parser and get escaped, but the library's custom text handler only escapes `&`, `<` not followed by `@` or `#`, and `>`).

Actually, looking at the source more carefully:

```typescript
const escapeSpecials = (text: string): string => {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/<([^@#]|$)/g, (_, m) => `&lt;${m}`)  // preserves <@ and <#
    .replace(/^(.*)>/g, (_, m) => {
      const isEndOfMention = Boolean(m.match(/<[@#][A-Z0-9]+$/));
      if (isEndOfMention) return `${m}>`;  // preserves mention closing >
      return `${m}&gt;`;
    });
  return escaped;
};
```

This preserves `<@U123>` and `<#C123>` mentions. However, it may not handle all edge cases (e.g., `<url|text>` Slack link syntax in raw input). For our use case this is fine — the LLM outputs standard Markdown, not Slack-native syntax.

### @tryfabric/mack (alternative)

- **Package:** `@tryfabric/mack` v1.2.1
- **Last published:** 4 years ago
- **Purpose:** Converts Markdown to Block Kit blocks (not mrkdwn text)

Different use case — produces structured `KnownBlock[]` arrays for Block Kit layouts. Could be useful for rich formatting but:
- Adds complexity (we'd need to manage blocks arrays)
- Block Kit has its own size limits per block
- `chat.update` with blocks suppresses the "edited" flag (good), but managing block arrays during streaming is more complex than updating a text string
- Not actively maintained

**Verdict:** Not recommended for our streaming use case. Plain mrkdwn text via `slackify-markdown` is simpler and sufficient.

## Recommendation

Use `slackify-markdown` as the core converter with a thin wrapper:

```typescript
import { slackifyMarkdown } from 'slackify-markdown';

function markdownToMrkdwn(markdown: string): string {
  return slackifyMarkdown(markdown).trimEnd();
}
```

### Custom additions needed

1. **Message splitting** — `slackify-markdown` doesn't handle Slack's 4000-char limit. We need a splitter that:
   - Splits at block boundaries (between paragraphs, after code blocks)
   - Never splits inside a code block
   - Posts continuation as new messages in the thread
   - AISlackBot uses 3900 chars as the threshold (buffer for formatting overhead)

2. **Streaming-aware conversion** — During streaming, we receive partial Markdown. The converter needs to handle:
   - Incomplete code blocks (don't close them prematurely)
   - Partial formatting markers (`**` without closing)
   - Approach: convert what we have, append "..." or "⏳" indicator

3. **LLM output quirks** — Claude/GPT sometimes output:
   - Nested bold+italic (`***text***`) — handled by slackify-markdown
   - Tables — not supported in mrkdwn, need to convert to code blocks or plain text
   - Horizontal rules (`---`) — convert to a visual separator or strip

### Message Splitting Algorithm

Based on AISlackBot's approach:

```
SLACK_MSG_LIMIT = 3900

function splitMessage(mrkdwn: string): string[] {
  if (mrkdwn.length <= SLACK_MSG_LIMIT) return [mrkdwn];

  const messages = [];
  let remaining = mrkdwn;

  while (remaining.length > SLACK_MSG_LIMIT) {
    // Find best split point before limit
    let splitAt = findBlockBoundary(remaining, SLACK_MSG_LIMIT);
    messages.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) messages.push(remaining);
  return messages;
}

function findBlockBoundary(text: string, maxLen: number): number {
  // Priority: paragraph break > line break > space > hard cut
  const chunk = text.slice(0, maxLen);

  // Don't split inside code blocks
  const codeBlockPositions = findCodeBlockRanges(chunk);

  // Try paragraph break (\n\n)
  let pos = chunk.lastIndexOf('\n\n');
  if (pos > 0 && !insideCodeBlock(pos, codeBlockPositions)) return pos + 2;

  // Try line break
  pos = chunk.lastIndexOf('\n');
  if (pos > 0 && !insideCodeBlock(pos, codeBlockPositions)) return pos + 1;

  // Try space
  pos = chunk.lastIndexOf(' ');
  if (pos > 0) return pos + 1;

  // Hard cut
  return maxLen;
}
```

## Streaming Conversion Strategy

During streaming, we accumulate `text_delta` events and periodically convert + update:

1. Accumulate raw Markdown deltas into a buffer
2. Every 3s (throttle interval):
   a. Convert buffer to mrkdwn via `slackifyMarkdown()`
   b. Append streaming indicator (e.g., ` ⏳`)
   c. If length > 3900, split: post current as final, start new message
   d. Call `chat.update()` on the current message

Edge case: incomplete code blocks during streaming. If the buffer ends mid-code-block, we could:
- Detect unclosed triple-backticks and append closing ``` before conversion
- Strip the appended closing after conversion
- This ensures the code block renders properly during streaming

```typescript
function convertPartialMarkdown(partial: string): string {
  let md = partial;
  // Close unclosed code blocks for rendering
  const backtickCount = (md.match(/```/g) || []).length;
  if (backtickCount % 2 !== 0) {
    md += '\n```';
  }
  return slackifyMarkdown(md).trimEnd();
}
```
