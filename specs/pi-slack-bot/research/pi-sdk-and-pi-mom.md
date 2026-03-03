# pi SDK & pi-mom Research

## pi SDK (`@mariozechner/pi-coding-agent`)

### createAgentSession()

Factory function. Key options:
- `sessionManager`: `SessionManager.inMemory()`, `SessionManager.create(cwd)`, `SessionManager.open(path)`, `SessionManager.continueRecent(cwd)`
- `model`, `thinkingLevel`, `authStorage`, `modelRegistry`
- `tools`: `codingTools` (default), `readOnlyTools`, or pick individual. Use `createCodingTools(cwd)` for custom cwd.
- `customTools`: additional `ToolDefinition[]`
- `resourceLoader`: `DefaultResourceLoader` for extensions, skills, prompts, themes, context files
- `settingsManager`: `SettingsManager.create()` or `SettingsManager.inMemory()`
- `cwd`, `agentDir`

### AgentSession API

```typescript
// Prompting
session.prompt(text, options?)     // Send prompt, wait for completion
session.steer(text)                // Interrupt during streaming
session.followUp(text)             // Queue for after streaming

// Events (returns unsubscribe fn)
session.subscribe((event) => { ... })

// Event types:
// - message_update (text_delta, thinking_delta)
// - tool_execution_start, tool_execution_update, tool_execution_end
// - message_start, message_end
// - agent_start, agent_end
// - turn_start, turn_end
// - auto_compaction_start/end, auto_retry_start/end

// State
session.messages          // AgentMessage[]
session.isStreaming        // boolean
session.model              // Model | undefined
session.thinkingLevel      // ThinkingLevel
session.sessionId          // string

// Control
session.setModel(model)
session.setThinkingLevel(level)
session.abort()
session.dispose()
session.newSession()
session.compact()
```

### Key Insight: No built-in tool approval

The SDK does NOT have a built-in tool approval mechanism like AISlackBot's ACP protocol. Tools execute automatically. Tool approval would need to be implemented at the tool level — wrapping tools to pause execution and wait for Slack reactions before proceeding.

## pi-mom (`@mariozechner/pi-mom`)

### Architecture

pi-mom is the official pi Slack bot in the monorepo. Key differences from our planned design:

| Aspect | pi-mom | Our plan (OVERVIEW.md) |
|--------|--------|----------------------|
| Slack SDK | Raw `@slack/socket-mode` + `@slack/web-api` | `@slack/bolt` (higher-level) |
| Session model | One `AgentSession` per channel (keyed by channel ID) | One per thread (keyed by `thread_ts`) |
| Persistence | `context.jsonl` per channel + `log.jsonl` for history | JSON file per thread |
| Tool approval | None — all tools auto-execute | Emoji reactions (✅/🔁/❌) |
| Streaming | No streaming updates — posts final response | Progressive message updates |
| Concurrency | Per-channel queue (`ChannelQueue`) | Per-thread queue |
| Sandbox | Docker container or host | Host only |
| Multi-user | Multi-user (any channel member) | Single-user (`SLACK_USER_ID`) |
| Commands | Just "stop" | Full command set (!help, !new, !cancel, etc.) |
| Shortcuts | None | Template expansion |
| Working dir | Per-channel workspace dir | Per-message cwd parsing |

### pi-mom Session Persistence

- Uses `SessionManager.open(contextFile, channelDir)` with a fixed `context.jsonl` per channel
- On each run, syncs missed messages from `log.jsonl` → `SessionManager` via `syncLogToSessionManager()`
- Reloads messages from context.jsonl into agent via `agent.replaceMessages()`
- `log.jsonl` is human-readable history (no tool results); `context.jsonl` is structured LLM context

### pi-mom Slack Layer

- Uses raw `SocketModeClient` + `WebClient` (not Bolt)
- Per-channel `ChannelQueue` for sequential processing
- Backfills channel history on startup
- Logs all messages to `log.jsonl` (both user and bot)
- "stop" command aborts via `session.abort()`
- Accumulates response text, updates single Slack message (no streaming chunks)
- Posts tool details in thread, main response in channel

### pi-mom Agent Layer

- `AgentRunner` per channel, cached in `channelRunners` Map
- Creates `Agent` directly (lower-level than `createAgentSession`) + wraps in `AgentSession`
- Custom tools: bash, read, write, edit, attach (file upload to Slack)
- System prompt rebuilt each run with fresh memory, channels, users, skills
- Events subscription handles: tool_execution_start/end, message_start/end, auto_compaction, auto_retry
- No tool approval — everything auto-executes

## AISlackBot (Python, Amazon-internal)

### Architecture
- Python, `slack_bolt` with Socket Mode
- Single ACP session (not per-thread/channel)
- Communicates with `kiro-cli acp` via JSON-RPC subprocess
- No persistence — fully in-memory
- Tool approval via emoji reactions on posted messages
- Streaming updates with time-based throttling (3s)
- Global request queue (serialized)
- Commands: !help, !new, !cancel, !model, !status, !queue, !agent, !shortcuts
- Shortcuts: JSON-defined template expansion
- Rate limiting, input length limits
- Markdown → mrkdwn conversion

### Tool Approval Flow (AISlackBot)
1. `on_approval` callback receives tool call params
2. Check `AUTO_APPROVE_TOOL_KINDS` — auto-approve safe tools (read, search)
3. Post approval message with emoji legend (✅ allow / 🔁 always / ❌ deny)
4. Register in `pending_approvals` dict (keyed by message ts)
5. `threading.Event.wait(timeout=APPROVAL_TIMEOUT)`
6. `reaction_added` handler resolves the event
7. Return option_id to ACP

## Implications for pi-slack-bot

1. **Tool approval must be custom-built.** Neither pi SDK nor pi-mom has it. We need to wrap tool execution to intercept, post approval messages, wait for reactions, then proceed/deny.

2. **Streaming is straightforward.** Subscribe to `message_update` / `text_delta` events, throttle Slack updates.

3. **Session persistence via SessionManager.open()** — one JSONL file per thread, similar to pi-mom's per-channel approach.

4. **Per-thread queues** — adapt pi-mom's `ChannelQueue` pattern but keyed by `thread_ts`.

5. **Bolt vs raw SDK** — OVERVIEW.md specifies `@slack/bolt`. pi-mom uses raw clients. Bolt is higher-level and handles ack() automatically, which is simpler.

6. **pi-mom is NOT a fork target** — it's multi-user, channel-based, no streaming, no tool approval. Better to build fresh using the SDK directly, borrowing patterns from both pi-mom and AISlackBot.
