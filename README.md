# pi-slack-bot

A Slack bot that exposes [pi](https://github.com/mariozechner/pi-coding-agent) as a conversational coding agent. Chat with pi in Slack DMs — it streams responses, runs tools, manages sessions per thread, and lets you switch models, thinking levels, and working directories on the fly.

## Features

- **Threaded sessions** — each Slack thread gets its own pi agent session with full conversation history
- **Streaming responses** — real-time updates with tool execution indicators, auto-split for long messages
- **Project picker** — fuzzy-matches project names or shows buttons to pick a working directory
- **Interactive file picker** — browse and select files via Slack buttons when the agent needs user input
- **Commands** — `!model`, `!thinking`, `!cwd`, `!cancel`, `!new`, `!sessions`, and more
- **Ralph loops** — run multi-agent Ralph presets via `!ralph` with an interactive preset picker
- **Prompt templates** — run file-based prompt templates via `!prompt` with a picker UI
- **Attach server** — external processes can connect via WebSocket and stream to Slack threads
- **Session management** — configurable limits, idle timeout, automatic cleanup

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- A Slack app with Socket Mode enabled (see [Slack App Setup](#slack-app-setup))
- [pi](https://github.com/mariozechner/pi-coding-agent) installed and configured
- An LLM provider (Anthropic, AWS Bedrock, etc.) with credentials configured

## Installation

```bash
git clone https://github.com/samfoy/pi-slack-bot.git
cd pi-slack-bot
npm install
```

## Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | — | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | ✅ | — | App-level token (`xapp-...`) for Socket Mode |
| `SLACK_USER_ID` | ✅ | — | Your Slack user ID (bot only responds to you) |
| `PROVIDER` | | `anthropic` | LLM provider name |
| `MODEL` | | `claude-sonnet-4-5` | Model ID |
| `THINKING_LEVEL` | | `off` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `MAX_SESSIONS` | | `10` | Max concurrent sessions |
| `SESSION_IDLE_TIMEOUT` | | `3600` | Idle session timeout in seconds |
| `SESSION_DIR` | | `~/.pi-slack-bot/sessions` | Session persistence directory |
| `STREAM_THROTTLE_MS` | | `3000` | Min interval between Slack message updates |
| `SLACK_MSG_LIMIT` | | `3900` | Max chars per Slack message before splitting |
| `WORKSPACE_DIRS` | | `~/projects` | Comma-separated dirs to scan for projects |
| `ATTACH_PORT` | | `3001` | WebSocket port for the attach server |

### Project Discovery

The bot discovers projects by scanning `WORKSPACE_DIRS` one level deep. For finer control, create `~/.pi-slack-bot/projects.json`:

```json
{
  "scanDirs": ["~/projects", "~/work"],
  "pin": ["~/dotfiles"],
  "exclude": ["node_modules", "CR-*"],
  "labels": {
    "my-app": "🚀 My App",
    "dotfiles": "⚙️ Dotfiles"
  }
}
```

## Usage

```bash
npm start
```

Then DM your bot in Slack. The first message starts a session:

- **With a path:** `~/projects/my-app fix the login bug` → starts in that directory
- **With a fuzzy name:** `my-app fix the login bug` → matches against known projects
- **Plain message:** `hello` → shows a project picker with buttons

### Commands

| Command | Description |
|---|---|
| `!help` | Show available commands |
| `!new` | Start a fresh session (same thread) |
| `!cancel` | Cancel the current stream |
| `!status` | Show session info (model, cwd, message count) |
| `!model <name>` | Switch model |
| `!thinking <level>` | Set thinking level |
| `!sessions` | List all active sessions |
| `!cwd <path>` | Change working directory (creates a new session) |
| `!reload` | Reload extensions and prompt templates |
| `!ralph [preset] [prompt]` | Run a Ralph multi-agent loop |
| `!plan <idea>` | Start a PDD planning session |
| `!prompt [name]` | Run a prompt template |

Any unrecognized `!command` is forwarded to pi as `/command` (for extensions and prompt templates).

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Enable **Socket Mode** under Settings → Socket Mode and generate an app-level token (`xapp-...`)
3. Under **OAuth & Permissions**, add these bot token scopes:
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `reactions:read`
   - `reactions:write`
4. Under **Event Subscriptions**, enable events and subscribe to:
   - `message.im`
5. Install the app to your workspace and copy the bot token (`xoxb-...`)
6. Find your Slack user ID (click your profile → "..." → "Copy member ID")

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Test coverage
npm run coverage

# Check code duplication
npm run duplication
```

## Architecture

```
src/
├── index.ts              # Entry point — boots Slack app + attach server
├── config.ts             # Environment variable parsing
├── slack.ts              # Slack Bolt app, event routing, project picker
├── session-manager.ts    # Session lifecycle, limits, idle reaping
├── thread-session.ts     # Per-thread pi AgentSession wrapper
├── streaming-updater.ts  # Streams agent output to Slack with throttling
├── formatter.ts          # Markdown → Slack mrkdwn conversion, splitting
├── parser.ts             # Message parsing, project discovery, fuzzy match
├── commands.ts           # !command dispatch
├── command-picker.ts     # Ralph preset & prompt template button pickers
├── file-picker.ts        # Interactive file browser via Slack buttons
└── attach-server.ts      # WebSocket server for external session attachment
```

## License

[MIT](LICENSE)
