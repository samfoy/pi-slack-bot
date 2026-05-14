# pi-slack-bot

A Slack bot that exposes [pi](https://github.com/badlogic/pi-mono) as a conversational coding agent, directly from Slack. No Amazon internals, no tmux, no polling — just pi's SDK + Slack's Bolt SDK over Socket Mode.

## Prior Art

This project draws heavily from two predecessors:

- **[AISlackBot](https://code.amazon.com/packages/AISlackBot)** — A Python Slack bot that talks to `kiro-cli acp` (Agent Communication Protocol) over JSON-RPC. Provides streaming responses, tool approval via emoji reactions, request queuing, commands, and shortcuts. Uses `slack_bolt` with Socket Mode. Amazon-internal.
- **[pi-slack-daemon](../pi-slack-daemon/)** — A TypeScript daemon that polls Slack via MCP (`workplace-chat-mcp`), parses messages, and spawns `pi` processes in tmux windows. Each message gets its own pi process. Amazon-internal (Midway-dependent).

This project combines the best of both: AISlackBot's architecture (single process, streaming, real-time Slack events, tool approval) with pi's TypeScript SDK (in-process, no subprocess management).

## Architecture

```
Slack (Socket Mode / WebSocket)
  ↕
@slack/bolt (event handling, API)
  ↕
pi-slack-bot (request queue, streaming, commands)
  ↕
pi SDK (createAgentSession, tools, extensions)
  ↕
LLM provider (Anthropic, OpenAI, Gemini, Bedrock, etc.)
```

Single Node.js process. No subprocesses, no polling, no tmux.

## Core Dependencies

- `@slack/bolt` — Slack SDK with Socket Mode (real-time WebSocket events)
- `@earendil-works/pi-coding-agent` — pi's SDK for programmatic agent sessions

## Key Features

### From AISlackBot
- Real-time Slack events via Socket Mode (no polling)
- Streaming responses — progressive message updates with "⏳ thinking..." indicator
- Tool approval via emoji reactions (✅ allow / 🔁 allow always / ❌ deny)
- Request queue — serialized processing, no race conditions
- Commands (`!help`, `!new`, `!cancel`, `!status`, `!model`, etc.)
- Shortcuts — templated commands that expand into prompts
- Rate limiting
- Markdown → Slack mrkdwn conversion with code block handling
- Long message splitting at block boundaries

### From pi-slack-daemon
- Per-message working directory (`~/project fix the tests`)
- Message parsing (first token as path if it starts with `/`, `~/`, `./`)

### New / Improved
- In-process pi SDK — no subprocess management, no JSON-RPC, no process restarts
- Per-thread sessions — each Slack thread gets its own `AgentSession` with `createCodingTools(cwd)`
- Session persistence — threads can be resumed across bot restarts
- Native TypeScript — same language as pi, type-safe throughout
- Portable — works anywhere pi works, no Amazon-internal dependencies
- Configurable LLM provider/model via env vars or commands

## Message Flow

1. User sends message in DM (or @mentions bot in a channel)
2. `@slack/bolt` receives event via Socket Mode WebSocket
3. Bot parses message: extract optional cwd + prompt
4. Request enters queue (serialized processing)
5. Bot reacts with 👀, posts "⏳ Thinking..."
6. `session.prompt(text)` called on the thread's `AgentSession`
7. `subscribe()` streams `text_delta` events → progressive Slack message updates
8. On `tool_execution_start` → post approval message, wait for emoji reaction
9. On `agent_end` → final message update, swap 👀 for ✅
10. If user reacts ❌ on any message → `session.abort()`

## Session Management

- One `AgentSession` per Slack thread (keyed by `thread_ts`)
- Sessions created on first message, reused for thread replies
- `createCodingTools(cwd)` scopes file operations to the requested directory
- Sessions can be in-memory or persisted to disk for resumability
- Idle sessions cleaned up after configurable timeout

## Configuration

All via environment variables (with `.env` support):

```
# Required
SLACK_BOT_TOKEN=xoxb-...        # Bot token from OAuth & Permissions
SLACK_APP_TOKEN=xapp-...        # App-level token for Socket Mode
SLACK_USER_ID=U0123456789       # Your Slack user ID (security: only respond to you)

# Optional
PI_MODEL=claude-sonnet-4-20250514          # Default model
PI_PROVIDER=anthropic            # Default provider
PI_THINKING_LEVEL=medium         # off, minimal, low, medium, high, xhigh
DEFAULT_CWD=~/projects           # Default working directory
MAX_SESSIONS=10                  # Max concurrent thread sessions
SESSION_IDLE_TIMEOUT=3600        # Seconds before idle session cleanup
AUTO_APPROVE_TOOLS=read,search   # Tool kinds to auto-approve
REQUEST_TIMEOUT=300              # Seconds before request timeout
RATE_LIMIT_SECONDS=5             # Min seconds between requests
```

## Commands

| Command | Description |
|---------|-------------|
| `!help` | Show available commands |
| `!new` | Start fresh session in current thread |
| `!cancel` | Cancel in-progress request |
| `!cancel all` | Cancel + clear queue |
| `!status` | Show bot status, active sessions, queue depth |
| `!model <name>` | Switch model |
| `!thinking <level>` | Set thinking level |
| `!sessions` | List active thread sessions |
| `!shortcuts` | List available shortcuts |

## Security

- Only responds to messages from `SLACK_USER_ID` (single-user bot)
- System prompt wraps user input with injection protection
- Tool approval required for write/execute operations by default
- Auto-approve configurable only for safe tool kinds (read, search)
- No secrets in code — all config via env vars

## Slack App Setup

Create a Slack app with this manifest (or configure manually):

### Required Bot Scopes
- `app_mentions:read`
- `channels:history`
- `chat:write`
- `im:history`, `im:read`, `im:write`
- `reactions:read`, `reactions:write`

### Required Event Subscriptions
- `app_mention`
- `message.channels`
- `message.im`
- `reaction_added`

### Socket Mode
- Enabled (requires app-level token)

## File Structure (Planned)

```
pi-slack-bot/
├── src/
│   ├── index.ts          # Entry point, app wiring
│   ├── config.ts         # Env var loading, validation
│   ├── slack.ts          # Slack app setup, event handlers
│   ├── sessions.ts       # AgentSession lifecycle (create, get, cleanup)
│   ├── queue.ts          # Request queue (serial processing)
│   ├── streaming.ts      # Streaming state, progressive Slack updates
│   ├── commands.ts       # !help, !new, !cancel, etc.
│   ├── approval.ts       # Tool approval via emoji reactions
│   ├── formatting.ts     # Markdown → mrkdwn, message splitting
│   ├── parser.ts         # Message parsing (cwd + prompt extraction)
│   └── shortcuts.ts      # Shortcut expansion
├── specs/
│   └── OVERVIEW.md       # This file
├── .env.example
├── slack-app-manifest.json
├── package.json
├── tsconfig.json
└── README.md
```
