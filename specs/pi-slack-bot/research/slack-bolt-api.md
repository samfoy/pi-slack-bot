# Slack Bolt API Research

## Socket Mode Setup

Minimal setup with `@slack/bolt`:

```typescript
import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,   // xoxb-...
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN, // xapp-...
});

await app.start();
```

No HTTP server needed. Socket Mode uses a WebSocket connection to Slack's servers. The `appToken` is an app-level token (not bot token) created under Basic Information → App-Level Tokens with `connections:write` scope.

For custom receiver configuration:

```typescript
import { App, SocketModeReceiver } from '@slack/bolt';

const receiver = new SocketModeReceiver({
  appToken: process.env.SLACK_APP_TOKEN,
});

const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
});
```

This is useful if we need to add a custom HTTP endpoint (e.g., WebSocket server for the attach flow) alongside the Bolt app.

## DM Message Events

Subscribe to `message.im` in the Slack app config. Event payload:

```json
{
  "type": "message",
  "channel": "D024BE91L",
  "user": "U2147483697",
  "text": "Hello hello can you hear me?",
  "ts": "1355517523.000005",
  "event_ts": "1355517523.000005",
  "channel_type": "im"
}
```

Thread replies include `thread_ts` pointing to the parent message:

```json
{
  "type": "message",
  "channel": "D024BE91L",
  "user": "U2147483697",
  "text": "This is a thread reply",
  "ts": "1355517525.000007",
  "thread_ts": "1355517523.000005",
  "channel_type": "im"
}
```

Listening in Bolt:

```typescript
// Listen to all messages
app.event('message', async ({ event, client }) => {
  if (event.channel_type !== 'im') return;  // DM only
  if (event.user !== SLACK_USER_ID) return;  // Single-user security

  const threadTs = event.thread_ts ?? event.ts; // Top-level = new session
  const isNewThread = !event.thread_ts;

  // ...
});

// Or use app.message() with pattern matching
app.message('hello', async ({ message, say }) => {
  await say(`Hey <@${message.user}>!`);
});
```

Key fields for our threading model:
- `ts` — unique message timestamp (ID)
- `thread_ts` — parent message ts (present only for thread replies)
- Top-level DM: `thread_ts` is absent → create new session keyed by `ts`
- Thread reply: `thread_ts` is present → look up session keyed by `thread_ts`

## Posting & Updating Messages

### chat.postMessage

```typescript
const result = await client.chat.postMessage({
  channel: event.channel,
  text: '⏳ Thinking...',           // Fallback for notifications
  thread_ts: threadTs,              // Reply in thread
  blocks: [                         // Rich layout (optional)
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '⏳ Thinking...' }
    }
  ],
});

const messageTs = result.ts; // Save for later updates
```

### chat.update (for streaming)

```typescript
await client.chat.update({
  channel: channelId,
  ts: messageTs,                    // Message to update
  text: accumulatedText,            // Updated content
  // When using blocks, the "edited" flag is NOT shown — good for streaming
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: accumulatedText }
    }
  ],
});
```

Key constraints:
- `text` field max: **4000 characters** (`msg_too_long` error)
- Only the bot's own messages can be updated
- Rate limit: Tier 3 (~50+ per minute per workspace) — 3s throttle is safe
- `streaming_state_conflict` error exists (Slack's own streaming feature) — shouldn't affect us since we're doing manual updates
- When using `blocks` without `text`, previous blocks are retained; to clear, pass empty `blocks: []`
- When `blocks` are used, the `edited` flag is suppressed — ideal for streaming updates

### Reactions

```typescript
// Add reaction
await client.reactions.add({
  channel: channelId,
  timestamp: messageTs,
  name: 'eyes',  // 👀
});

// Remove reaction
await client.reactions.remove({
  channel: channelId,
  timestamp: messageTs,
  name: 'eyes',
});
```

## Reaction Events

Subscribe to `reaction_added` in app config. Payload:

```json
{
  "type": "reaction_added",
  "user": "U123ABC456",
  "reaction": "thumbsup",
  "item_user": "U222222222",
  "item": {
    "type": "message",
    "channel": "C123ABC456",
    "ts": "1360782400.498405"
  },
  "event_ts": "1360782804.083113"
}
```

Listening in Bolt:

```typescript
app.event('reaction_added', async ({ event, client }) => {
  if (event.user !== SLACK_USER_ID) return;
  if (event.item.type !== 'message') return;

  const { channel, ts } = event.item;
  const reaction = event.reaction; // e.g., 'white_check_mark', 'x'

  // Look up pending approval by message ts
  // ...
});
```

## Block Kit Buttons (for cwd fuzzy matching)

Buttons go inside `actions` blocks:

```typescript
await client.chat.postMessage({
  channel: channelId,
  thread_ts: threadTs,
  text: 'Which project?',
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '📂 *Which project?*' }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '~/workplace/MyProject', emoji: true },
          action_id: 'select_cwd_0',
          value: '/home/user/workplace/MyProject',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '~/workplace/OtherProject', emoji: true },
          action_id: 'select_cwd_1',
          value: '/home/user/workplace/OtherProject',
        },
      ],
    },
  ],
});
```

Handling button clicks:

```typescript
app.action(/^select_cwd_/, async ({ action, ack, body, client }) => {
  await ack(); // Must acknowledge within 3 seconds

  const selectedCwd = action.value; // The full path
  const channelId = body.channel?.id;
  const threadTs = body.message?.thread_ts ?? body.message?.ts;

  // Update the message to show selection
  await client.chat.update({
    channel: channelId,
    ts: body.message.ts,
    text: `Selected: ${selectedCwd}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `📂 Selected: \`${selectedCwd}\`` }
      }
    ],
  });

  // Create session with selected cwd
  // ...
});
```

Button constraints:
- `text` max 75 characters
- `value` max 2000 characters (plenty for paths)
- Max 25 elements per `actions` block
- `action_id` max 255 characters
- Must `ack()` within 3 seconds

## Slack mrkdwn Formatting Reference

| Feature | Markdown | Slack mrkdwn |
|---------|----------|-------------|
| Bold | `**text**` | `*text*` |
| Italic | `*text*` or `_text_` | `_text_` |
| Strikethrough | `~~text~~` | `~text~` |
| Inline code | `` `code` `` | `` `code` `` (same) |
| Code block | ` ```lang\ncode\n``` ` | ` ```\ncode\n``` ` (no lang) |
| Link | `[text](url)` | `<url\|text>` |
| Image | `![alt](url)` | `<url\|alt>` (link only) |
| Heading | `# text` | `*text*` (just bold) |
| Blockquote | `> text` | `> text` (same) |
| Unordered list | `- item` | `• item` |
| Ordered list | `1. item` | `1. item` (same) |
| User mention | N/A | `<@U012AB3CD>` |
| Channel ref | N/A | `<#C012AB3CD>` |
| Escape `&` | N/A | `&amp;` |
| Escape `<` | N/A | `&lt;` |
| Escape `>` | N/A | `&gt;` |

## Required Slack App Configuration

### Bot Token Scopes
- `chat:write` — post and update messages
- `im:history` — read DM messages
- `im:read` — view DM metadata
- `im:write` — open DMs
- `reactions:read` — read reactions
- `reactions:write` — add/remove reactions

### Event Subscriptions
- `message.im` — DM messages
- `reaction_added` — emoji reactions

### Socket Mode
- Enabled (requires app-level token with `connections:write`)

### Interactivity
- Enabled (for Block Kit button actions — no request URL needed with Socket Mode)
