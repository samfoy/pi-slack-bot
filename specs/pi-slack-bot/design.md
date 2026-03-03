# pi-slack-bot Design

## Overview

pi-slack-bot is a single-process Node.js application that exposes pi as a conversational coding agent via Slack DMs. It connects to Slack via Socket Mode (WebSocket) using `@slack/bolt` and manages per-thread `AgentSession` instances via pi's TypeScript SDK (`@mariozechner/pi-coding-agent`).

The bot is single-user — it only responds to one configured Slack user. Each top-level DM creates a new agent session; thread replies continue that session. Sessions are persisted as JSONL files (pi's native format) and survive bot restarts. Responses stream progressively to Slack with time-based throttling and automatic message splitting.

A secondary WebSocket server allows running pi sessions on a dev box to attach to Slack DM threads, enabling bidirectional communication between a local pi instance and Slack.

### Scope

In scope:
- DM-only interaction, single user
- Per-thread agent sessions with JSONL persistence
- Streaming responses with 3s throttle and 3900-char message splitting
- Markdown → Slack mrkdwn conversion via `slackify-markdown`
- Inline tool execution details in streaming messages
- Per-thread request queues, parallel across threads, bounded by `MAX_SESSIONS`
- Commands: `!help`, `!new`, `!cancel`, `!status`, `!model`, `!thinking`, `!sessions`, `!cwd`
- cwd parsing from first message token with fuzzy matching and Block Kit buttons
- Extension/skill/AGENTS.md loading from cwd via `DefaultResourceLoader`
- Pi-to-Slack attach flow via WebSocket (pi extension connects to bot)
- Session idle timeout with configurable cleanup
- Pi's built-in auto-retry and auto-compaction
- Configurable LLM provider/model via env vars or commands

Out of scope:
- Channel mentions / multi-user
- Tool approval via emoji reactions (all tools auto-execute)
- Shortcuts / prompt templates
- Injection protection (single-user, not needed)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      pi-slack-bot                           │
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌───────────────────────┐  │
│  │  Slack    │    │ Message  │    │   Session Manager     │  │
│  │  Layer    │───►│ Router   │───►│                       │  │
│  │ (Bolt)   │    │          │    │  ┌─────────────────┐  │  │
│  │          │    │ - parse  │    │  │ Thread Session  │  │  │
│  │ - events │    │ - auth   │    │  │ - AgentSession  │  │  │
│  │ - actions│    │ - route  │    │  │ - queue         │  │  │
│  │ - react  │    │          │    │  │ - streaming     │  │  │
│  └──────────┘    └──────────┘    │  │ - persistence   │  │  │
│       ▲                          │  └─────────────────┘  │  │
│       │                          │  ┌─────────────────┐  │  │
│       │    ┌──────────┐          │  │ Thread Session  │  │  │
│       └────│ Streaming│◄─────────│  │ (per thread)    │  │  │
│            │ Updater  │          │  └─────────────────┘  │  │
│            │          │          │         ...            │  │
│            │ - throttle│         └───────────────────────┘  │
│            │ - convert │                                    │
│            │ - split   │         ┌───────────────────────┐  │
│            └──────────┘          │   Attach Server       │  │
│                                  │   (WebSocket :3001)   │  │
│                                  │                       │  │
│                                  │  pi ext ◄──► thread   │  │
│                                  └───────────────────────┘  │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Commands │  │ Formatter│  │  Parser  │  │   Config   │  │
│  │          │  │ (mrkdwn) │  │ (cwd)   │  │  (.env)    │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   Slack API                     pi SDK / LLM
   (Socket Mode)                 (Anthropic, etc.)
```

### Component Summary

| Component | Responsibility |
|-----------|---------------|
| **Config** | Load and validate env vars, build known-projects list |
| **Slack Layer** | Bolt app setup, Socket Mode, event/action handlers |
| **Message Router** | Auth check, parse message, route to command or session |
| **Session Manager** | Create/get/dispose thread sessions, enforce `MAX_SESSIONS`, idle timeout |
| **Thread Session** | Wraps one `AgentSession` + per-thread request queue + streaming state |
| **Streaming Updater** | Throttled `chat.update` calls, mrkdwn conversion, message splitting |
| **Formatter** | Markdown → mrkdwn via `slackify-markdown`, partial-render handling |
| **Parser** | Extract cwd + prompt from message text, fuzzy match projects |
| **Commands** | Handle `!help`, `!new`, `!cancel`, `!status`, `!model`, `!thinking`, `!sessions`, `!cwd` |
| **Attach Server** | WebSocket server for pi extension ↔ Slack thread bridging |

### Data Flow: Slack → Pi → Slack

```
1. User sends DM          →  Bolt message event
2. Message Router          →  auth check, parse cwd + prompt
3. Session Manager         →  get or create ThreadSession for thread_ts
4. ThreadSession.enqueue() →  add to per-thread queue
5. Queue processes          →  session.prompt(text)
6. AgentSession streams    →  subscribe() fires text_delta, tool_* events
7. Streaming Updater       →  accumulate, throttle (3s), convert to mrkdwn
8. chat.update()           →  progressive Slack message update
9. agent_end               →  final update, swap 👀 → ✅
```

### Data Flow: Pi Extension → Slack (Attach)

```
1. User runs /attach in pi  →  extension opens WebSocket to bot:3001
2. Extension sends register →  bot creates DM thread, sends thread_created
3. Agent streams            →  extension forwards text_delta, tool_* via WS
4. Bot receives events      →  same Streaming Updater pipeline
5. User replies in Slack    →  bot sends user_message via WS
6. Extension receives       →  pi.sendUserMessage(text)
7. /detach or disconnect    →  cleanup, post notice in thread
```

### Technology Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Slack SDK | `@slack/bolt` (Socket Mode) | Higher-level than raw SDK, handles ack() automatically |
| Pi SDK | `@mariozechner/pi-coding-agent` | In-process, type-safe, native TS |
| mrkdwn conversion | `slackify-markdown` | Battle-tested, Unified/Remark-based, handles edge cases |
| Attach protocol | `ws` (WebSocket) | Bidirectional streaming, persistent connection |
| Session persistence | Pi's JSONL via `SessionManager.open()` | Native format, tree structure, compaction support |
| Runtime | Node.js 22+ | Required by `slackify-markdown` v5 (ESM-only) |
| Config | `dotenv` | Standard `.env` file support |

---

## Detailed Requirements

### Functional Requirements

**FR-1: Single-user DM interaction**
- Responds only to DMs from the configured `SLACK_USER_ID`; all others silently ignored
- DM-only; no channel mentions

**FR-2: Per-thread sessions**
- Top-level DM → new `AgentSession` keyed by `event.ts`
- Thread reply → continues session keyed by `event.thread_ts`
- Sessions persisted as JSONL files; survive bot restarts

**FR-3: Streaming responses**
- Agent text deltas accumulated and pushed to Slack every `STREAM_THROTTLE_MS` (default 3s)
- Initial "⏳ Thinking..." message posted, then updated progressively via `chat.update`
- On completion: ⏳ reaction removed, ✅ added

**FR-4: Message splitting**
- Messages exceeding `SLACK_MSG_LIMIT` (default 3900 chars) split at block boundaries
- Never splits inside a code block
- Overflow posted as new thread reply; process repeats if needed

**FR-5: Markdown → mrkdwn conversion**
- All agent output converted via `slackify-markdown`
- During streaming, unclosed code blocks are temporarily closed before conversion

**FR-6: Inline tool details**
- Tool start: append `\n> 🔧 \`tool_name\`(args...)` to streaming message
- Tool end: replace with `> ✅ \`tool_name\`` or `> ❌ \`tool_name\``

**FR-7: cwd parsing**
- First whitespace-delimited token checked as a potential cwd path (`~` expanded)
- Resolves → use as session cwd; remainder is the prompt
- Doesn't resolve → fuzzy-match against known projects
  - Matches found → post Block Kit buttons; queue prompt pending selection
  - No matches → proceed with home dir, notify user

**FR-8: Extension/skill loading**
- Sessions load extensions, skills, and AGENTS.md from cwd via `DefaultResourceLoader`

**FR-9: Commands**

| Command | Behavior |
|---------|----------|
| `!help` | Post command list |
| `!new` | Start fresh session in current thread |
| `!cancel` | Abort active request via `session.abort()` |
| `!status` | Show model, thinking level, message count, cwd |
| `!model <name>` | Switch model for current session |
| `!thinking <off\|low\|medium\|high>` | Set thinking level |
| `!sessions` | List all active sessions |
| `!cwd <path>` | Change cwd, reload resources |

**FR-10: Per-thread request queues**
- Requests within a thread are serialized; different threads process in parallel
- Bounded by `MAX_SESSIONS` (default 10)

**FR-11: Session idle timeout**
- Sessions inactive for `SESSION_IDLE_TIMEOUT` seconds (default 3600) are disposed
- JSONL files retained for future resumability

**FR-12: Error handling**
- Pi's `auto_retry` handles transient LLM failures
- Retry attempts surfaced to Slack: `_↩️ Retrying (N/3)..._`
- Final failures posted as error messages in thread

**FR-13: Pi → Slack attach flow**
- Pi extension (`slack-attach`) connects to bot via WebSocket on `ATTACH_PORT` (default 3001)
- On `register`: bot opens DM thread, sends back `thread_created` with thread URL
- Agent events (text deltas, tool lifecycle) flow extension → bot → Slack via same streaming pipeline
- User Slack replies flow bot → extension → `pi.sendUserMessage()`
- On disconnect: bot posts notice in thread, cleans up

**FR-14: System prompt**
- Default pi system prompt via `DefaultResourceLoader`
- Appended with Slack mrkdwn formatting rules (bold = `*`, italic = `_`, no markdown links, etc.)

### Non-Functional Requirements

- **NFR-1:** Single Node.js process — no subprocesses, no polling, no tmux
- **NFR-2:** Node.js 22+ (required by `slackify-markdown` v5, ESM-only)
- **NFR-3:** Socket Mode — no public HTTP endpoint required
- **NFR-4:** All config via `.env` / environment variables

---

## Components and Interfaces

### Config

```typescript
interface Config {
  // Slack
  slackBotToken: string;          // SLACK_BOT_TOKEN
  slackAppToken: string;          // SLACK_APP_TOKEN
  slackUserId: string;            // SLACK_USER_ID

  // LLM
  provider: string;               // PROVIDER (default: "anthropic")
  model: string;                  // MODEL (default: "claude-sonnet-4-5")
  thinkingLevel: ThinkingLevel;   // THINKING_LEVEL (default: "none")

  // Sessions
  maxSessions: number;            // MAX_SESSIONS (default: 10)
  sessionIdleTimeoutSecs: number; // SESSION_IDLE_TIMEOUT (default: 3600)
  sessionDir: string;             // SESSION_DIR (default: ~/.pi-slack-bot/sessions)

  // Streaming
  streamThrottleMs: number;       // STREAM_THROTTLE_MS (default: 3000)
  slackMsgLimit: number;          // SLACK_MSG_LIMIT (default: 3900)

  // cwd discovery
  workspaceDirs: string[];        // WORKSPACE_DIRS (comma-separated, default: "~/workplace")

  // Attach server
  attachPort: number;             // ATTACH_PORT (default: 3001)
}
```

### Message Router

Not a class — a set of Bolt event handlers. Entry point for all incoming Slack events.

```
handleMessage(event, client):
  1. Ignore if event.user !== config.slackUserId
  2. Ignore bot messages (event.subtype === 'bot_message')
  3. threadTs = event.thread_ts ?? event.ts
  4. If text starts with '!' → dispatch to Commands
  5. If threadTs has an AttachSession → forward to AttachServer
  6. Otherwise → parse cwd + prompt, route to SessionManager

handleCwdSelection(action, body, client):
  1. ack()
  2. Resolve selected path from action.value
  3. Update button message to show selection
  4. Resume queued prompt with resolved cwd
```

### Session Manager

```typescript
interface ISessionManager {
  get(threadTs: string): ThreadSession | undefined;
  getOrCreate(params: {
    threadTs: string;
    channelId: string;
    cwd: string;
  }): Promise<ThreadSession>;
  dispose(threadTs: string): Promise<void>;
  disposeAll(): Promise<void>;
  list(): ThreadSessionInfo[];
  count(): number;
}

interface ThreadSessionInfo {
  threadTs: string;
  channelId: string;
  cwd: string;
  messageCount: number;
  model: string;
  thinkingLevel: ThinkingLevel;
  lastActivity: Date;
  isStreaming: boolean;
}
```

Idle reaper: `setInterval` every 60s, disposes sessions where `Date.now() - lastActivity > sessionIdleTimeoutSecs * 1000`.

`getOrCreate` throws `SessionLimitError` if `count() >= maxSessions`.

### Thread Session

```typescript
class ThreadSession {
  readonly threadTs: string;
  readonly channelId: string;
  cwd: string;
  lastActivity: Date;

  // Queue
  enqueue(task: () => Promise<void>): void;

  // Control
  abort(): void;
  dispose(): Promise<void>;
  newSession(): Promise<void>;  // !new — calls session.newSession()

  // Delegated to AgentSession
  get isStreaming(): boolean;
  get messageCount(): number;
  get model(): Model | undefined;
  get thinkingLevel(): ThinkingLevel;
  setModel(model: Model): void;
  setThinkingLevel(level: ThinkingLevel): void;
  subscribe(handler: (event: AgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
}
```

Queue: simple array of `() => Promise<void>`. After each task resolves, the next is dequeued. Errors are caught and surfaced to Slack without stopping the queue.

Session file: `{sessionDir}/{threadTs}.jsonl`, opened via `SessionManager.open(filePath)`.

### Streaming Updater

```typescript
interface StreamingState {
  channelId: string;
  threadTs: string;
  currentMessageTs: string;   // ts of the Slack message being updated
  rawMarkdown: string;        // accumulated text_delta content
  toolLines: string[];        // current inline tool status lines
  postedMessageTs: string[];  // ts of all finalized split messages
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
}

interface IStreamingUpdater {
  begin(channelId: string, threadTs: string): Promise<StreamingState>;
  appendText(state: StreamingState, delta: string): void;
  appendToolStart(state: StreamingState, toolName: string, args: unknown): void;
  appendToolEnd(state: StreamingState, toolName: string, isError: boolean): void;
  appendRetry(state: StreamingState, attempt: number): void;
  finalize(state: StreamingState): Promise<void>;
  error(state: StreamingState, err: Error): Promise<void>;
}
```

`appendText` schedules a `setTimeout(flush, throttleMs)` if no timer is running. `flush` converts accumulated markdown + tool lines to mrkdwn, splits if needed, calls `chat.update`. `finalize` does a final flush then swaps reactions.

### Formatter

Pure functions, no side effects.

```typescript
// Convert markdown to mrkdwn. partial=true closes unclosed code blocks first.
function markdownToMrkdwn(markdown: string, partial?: boolean): string;

// Split mrkdwn into chunks ≤ limit chars.
// Split priority: paragraph break > line break > space > hard cut.
// Never splits inside a code block.
function splitMrkdwn(mrkdwn: string, limit?: number): string[];

// Inline tool formatting
function formatToolStart(toolName: string, args: unknown): string;
// → "> 🔧 `tool_name`(arg1, arg2...)"

function formatToolEnd(toolName: string, isError: boolean): string;
// → "> ✅ `tool_name`" or "> ❌ `tool_name`"
```

### Parser

```typescript
interface ParseResult {
  cwd: string | null;       // resolved absolute path, or null
  cwdToken: string | null;  // raw token that was tried as cwd
  prompt: string;           // remaining text (full text if cwd unresolved)
  candidates: string[];     // fuzzy-matched project paths (empty if cwd resolved)
}

// Parse raw message text into cwd + prompt
function parseMessage(text: string, knownProjects: string[]): ParseResult;

// Fuzzy match token against project basenames and partial paths, up to 5 results
function fuzzyMatch(token: string, projects: string[]): string[];

// Scan workspace dirs one level deep for project directories
function scanProjects(workspaceDirs: string[]): string[];
```

Parsing rules:
1. Take first whitespace-delimited token, expand `~`
2. `fs.existsSync` + `isDirectory()` → resolved cwd, rest is prompt
3. Else → `fuzzyMatch(token, knownProjects)`
4. Matches → `cwd = null`, `candidates = matches`, `prompt = full text`
5. No matches → `cwd = null`, `candidates = []`, `prompt = full text`

### Commands

```typescript
interface CommandContext {
  channelId: string;
  threadTs: string;
  client: WebClient;
  sessionManager: ISessionManager;
  config: Config;
}

type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;

const commands: Record<string, CommandHandler>;
```

### Attach Server

```typescript
interface AttachSession {
  ws: WebSocket;
  threadTs: string;
  channelId: string;
  cwd: string;
  streamingState: StreamingState | null;
  connectedAt: Date;
}

interface IAttachServer {
  start(): void;
  stop(): void;
  // Called by message router when a Slack reply arrives in an attached thread
  sendUserMessage(threadTs: string, text: string): void;
  // Called by !cancel
  sendCancel(threadTs: string): void;
  // Check if a thread has an active attach session
  hasSession(threadTs: string): boolean;
}
```

Maintains `Map<threadTs, AttachSession>`. On `register`, calls `client.conversations.open` to get the DM channel, posts initial message, sends `thread_created` back. Uses the same `IStreamingUpdater` as bot-initiated sessions.

---

## Data Models

### Session Files

```
{sessionDir}/
  1709500000.123456.jsonl   # one file per thread, named by thread_ts
  1709500001.456789.jsonl
  ...
```

Created by `SessionManager.open(filePath)` on first use. Pi's native JSONL format — auto-compacted by pi's built-in compaction.

### Attach WebSocket Protocol

**Extension → Bot:**

```typescript
type ExtensionMessage =
  | { type: "register"; sessionId: string; cwd: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end"; messageCount: number }
  | { type: "retry_start"; attempt: number }
  | { type: "detach" };
```

**Bot → Extension:**

```typescript
type BotMessage =
  | { type: "thread_created"; threadTs: string; threadUrl: string }
  | { type: "user_message"; text: string; ts: string }
  | { type: "cancel" };
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | required | Bot OAuth token (xoxb-...) |
| `SLACK_APP_TOKEN` | required | App-level token (xapp-...) |
| `SLACK_USER_ID` | required | Slack user ID to respond to |
| `PROVIDER` | `anthropic` | LLM provider |
| `MODEL` | `claude-sonnet-4-5` | Default model |
| `THINKING_LEVEL` | `none` | Default thinking level |
| `MAX_SESSIONS` | `10` | Max concurrent thread sessions |
| `SESSION_IDLE_TIMEOUT` | `3600` | Seconds before idle session disposal |
| `SESSION_DIR` | `~/.pi-slack-bot/sessions` | JSONL storage directory |
| `STREAM_THROTTLE_MS` | `3000` | Streaming update interval (ms) |
| `SLACK_MSG_LIMIT` | `3900` | Max chars per Slack message |
| `WORKSPACE_DIRS` | `~/workplace` | Comma-separated dirs to scan for projects |
| `ATTACH_PORT` | `3001` | WebSocket port for pi extension attach |

---

## Error Handling

| Scenario | Detection | Response |
|----------|-----------|----------|
| Non-authorized user | `event.user !== slackUserId` | Silently ignore |
| Bot's own message | `event.subtype === 'bot_message'` | Silently ignore |
| MAX_SESSIONS exceeded | `count() >= maxSessions` | Post `⚠️ Too many active sessions. Use !cancel in another thread.` |
| cwd not found, no fuzzy matches | `cwd === null && candidates.length === 0` | Post `⚠️ Path not found. Starting in home directory.`, use `~` |
| cwd not found, fuzzy matches | `cwd === null && candidates.length > 0` | Post Block Kit buttons; queue prompt pending selection |
| LLM transient error | `auto_retry_start` event | Append `_↩️ Retrying (N/3)..._` to streaming message |
| LLM final failure | `agent_end` with error | Post `❌ Error: {message}` to thread |
| Slack rate limit | Bolt auto-retries 429s | Transparent to user |
| `msg_too_long` | `chat.update` error | Split and retry (prevented by 3900-char limit, but caught as fallback) |
| Thread reply, session not found | `sessionManager.get()` returns undefined | Create new session (treat as new top-level) |
| Attach WebSocket disconnect | `ws.on('close')` | Post `🔌 Session detached (connection lost)` to thread, clean up |
| `!cancel` with no active session | `session === undefined` | Post `No active session in this thread.` |
| `!model` with unknown model | `setModel` throws | Post `⚠️ Unknown model: {name}` |
| `!cwd` with invalid path | `fs.existsSync` fails | Post `⚠️ Path not found: {path}` |

---

## Acceptance Criteria

### AC-1: Single-user security
**Given** a DM arrives from a user other than `SLACK_USER_ID`  
**When** the message event fires  
**Then** the bot does not respond and no session is created

### AC-2: New session on top-level DM
**Given** the authorized user sends a top-level DM  
**When** the message is processed  
**Then** a new `ThreadSession` is created keyed by `event.ts`, a JSONL file is created at `{sessionDir}/{ts}.jsonl`, and the bot posts `⏳ Thinking...` in the thread

### AC-3: Thread reply continues session
**Given** an existing session for `thread_ts`  
**When** the authorized user sends a thread reply  
**Then** the message is enqueued to the existing session's queue and no new session is created

### AC-4: Session persistence across restart
**Given** a session JSONL file exists at `{sessionDir}/{threadTs}.jsonl`  
**When** the bot restarts and the user sends a thread reply  
**Then** the session is restored from the JSONL file and the conversation continues

### AC-5: Streaming throttle
**Given** an active agent turn producing rapid text deltas  
**When** deltas arrive faster than `STREAM_THROTTLE_MS`  
**Then** `chat.update` is called at most once per `STREAM_THROTTLE_MS` interval

### AC-6: Streaming completion
**Given** an agent turn completes  
**When** `agent_end` fires  
**Then** a final `chat.update` is posted, ⏳ reaction is removed, and ✅ is added to the response message

### AC-7: Message splitting
**Given** accumulated response exceeds `SLACK_MSG_LIMIT` characters  
**When** the streaming updater flushes  
**Then** the current message is finalized and a new thread reply is posted for the overflow, split at a paragraph or line boundary and never inside a code block

### AC-8: cwd from direct path
**Given** the user sends `~/workplace/MyProject fix the tests`  
**When** `~/workplace/MyProject` resolves to an existing directory  
**Then** the session is created with `cwd = ~/workplace/MyProject` and the prompt is `fix the tests`

### AC-9: cwd fuzzy match
**Given** the user sends `myproj fix the tests` and `~/workplace/MyProject` is a known project  
**When** `myproj` does not resolve as a path but fuzzy-matches `MyProject`  
**Then** the bot posts Block Kit buttons with the candidate paths and queues the prompt pending selection

### AC-10: cwd button selection
**Given** Block Kit buttons are posted for cwd selection  
**When** the user taps a button  
**Then** the button message is updated to show the selection, the session is created with the selected cwd, and the queued prompt is processed

### AC-11: !cancel
**Given** an active agent turn is in progress  
**When** the user sends `!cancel`  
**Then** `session.abort()` is called and the bot posts `🛑 Cancelled.` in the thread

### AC-12: !new
**Given** an existing session in a thread  
**When** the user sends `!new`  
**Then** `session.newSession()` is called and the bot posts `🆕 New session started.`

### AC-13: !status
**Given** an active session  
**When** the user sends `!status`  
**Then** the bot posts the current model, thinking level, message count, cwd, and last activity time

### AC-14: !model
**Given** an active session  
**When** the user sends `!model claude-opus-4-5`  
**Then** `session.setModel()` is called and the bot confirms the change

### AC-15: Session idle timeout
**Given** a session has had no activity for `SESSION_IDLE_TIMEOUT` seconds  
**When** the idle reaper runs  
**Then** the session is disposed and removed from the session map (JSONL file retained)

### AC-16: MAX_SESSIONS limit
**Given** `MAX_SESSIONS` sessions are active  
**When** the user sends a new top-level DM  
**Then** the bot posts `⚠️ Too many active sessions.` and no new session is created

### AC-17: LLM retry surfacing
**Given** a transient LLM error occurs during a turn  
**When** pi's auto-retry fires  
**Then** `_↩️ Retrying (N/3)..._` is appended to the streaming message

### AC-18: Attach — register
**Given** a pi extension connects to the bot's WebSocket and sends `{ type: "register", cwd: "/path" }`  
**When** the registration is processed  
**Then** the bot opens a DM, posts `🔗 Session attached from /path`, and sends `{ type: "thread_created", threadTs, threadUrl }` back

### AC-19: Attach — streaming
**Given** an attached session is active  
**When** the extension sends `text_delta` events  
**Then** the bot updates the Slack thread message using the same throttle/split/mrkdwn pipeline as bot-initiated sessions

### AC-20: Attach — user reply
**Given** an attached session is active  
**When** the authorized user replies in the Slack thread  
**Then** the bot sends `{ type: "user_message", text, ts }` to the extension via WebSocket

### AC-21: Attach — disconnect
**Given** an attached session's WebSocket closes  
**When** `ws.on('close')` fires  
**Then** the bot posts `🔌 Session detached (connection lost)` in the thread and removes the attach session

---

## Testing Strategy

### Unit Tests

| Module | What to test |
|--------|-------------|
| `formatter` | `markdownToMrkdwn` — bold, italic, code blocks, links, tables; `splitMrkdwn` — exact limit, paragraph split, code block boundary, hard cut; `formatToolStart/End` |
| `parser` | `parseMessage` — valid path, `~` expansion, no-match, fuzzy match; `fuzzyMatch` — exact, partial, case-insensitive, no match |
| `commands` | Each command handler with mock `CommandContext` |

### Integration Tests

| Module | What to test |
|--------|-------------|
| `session-manager` | Create, get, dispose, MAX_SESSIONS error, idle timeout reaper |
| `streaming-updater` | Throttle batching (mock timers), split trigger, finalize reactions (mock Slack client) |
| `attach-server` | Register flow, text_delta forwarding, user_message forwarding, disconnect cleanup (mock WebSocket + Slack client) |

### Manual / E2E

- Full DM flow with a test Slack workspace
- Attach flow: run pi locally with `slack-attach` extension, verify bidirectional streaming
- Restart persistence: send messages, restart bot, verify thread continues
- cwd fuzzy match: send partial project name, verify buttons appear and selection works

---

## Appendices

### A. Technology Choices

| Choice | Alternatives Considered | Why This |
|--------|------------------------|----------|
| `@slack/bolt` | Raw `@slack/socket-mode` + `@slack/web-api` (used by pi-mom) | Bolt handles `ack()` automatically, cleaner event handler API, less boilerplate |
| `slackify-markdown` v5 | `@tryfabric/mack` (Block Kit), custom converter | Battle-tested, Unified/Remark-based, handles all edge cases including in-word formatting via zero-width-space |
| `ws` for attach | HTTP + SSE, long-polling | Persistent bidirectional connection is the natural fit for streaming; no polling overhead |
| Pi JSONL via `SessionManager.open()` | SQLite, custom JSON | Native pi format; gets compaction, tree structure, and future SDK compatibility for free |
| Socket Mode | HTTP Events API | No public endpoint required; works on dev boxes behind NAT |

### B. Research Findings Summary

**Pi SDK:** `createAgentSession` is the primary entry point. `AgentSession.subscribe()` provides all events needed for streaming (text_delta, tool_execution_*, agent_start/end, auto_retry_start). No built-in tool approval — tools auto-execute. `SessionManager.open(path)` handles JSONL persistence. `DefaultResourceLoader` handles extension/skill/AGENTS.md discovery from cwd.

**Pi-mom:** Official pi Slack bot. Per-channel (not per-thread) sessions, no streaming, no tool approval, raw Slack SDK. Good reference for SDK wiring and `ChannelQueue` pattern. Not a fork target.

**AISlackBot:** Python bot with streaming, tool approval, commands, shortcuts. Good reference for Slack UX patterns (streaming throttle, message splitting, command handling). Tool approval via ACP protocol — not applicable here.

**PiSlackRemote:** Pi extension bridging local session to Slack via webhook + MCP polling (Amazon-internal deps). Informed the attach flow design; our approach uses WebSocket instead for portability.

**slackify-markdown:** Uses zero-width-space around formatting markers to handle in-word formatting. Preserves `<@U123>` and `<#C123>` mentions. Handles all standard Markdown → mrkdwn conversions. Partial streaming handled by detecting and closing unclosed code blocks before conversion.

### C. Alternative Approaches

**Per-channel sessions (like pi-mom):** Simpler session management but loses thread isolation — all DMs share one context. Rejected in favor of per-thread for better UX and resumability.

**Tool approval via emoji reactions:** Researched and designed (wrap tool `execute`, post approval message, wait for reaction). Deferred — all tools auto-execute for now. Can be added by wrapping tools in `createAgentSession`'s `tools` option.

**Shortcuts / prompt templates:** AISlackBot-style `shortcuts.json` with template expansion. Deferred — not in scope for v1.

**Block Kit for responses:** `@tryfabric/mack` converts Markdown to Block Kit blocks. Richer formatting but significantly more complex streaming state management (block arrays vs. text string). Plain mrkdwn is sufficient and simpler.
