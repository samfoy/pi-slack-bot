# pi-slack-bot Implementation Plan

## Checklist

- [ ] Step 1: Project scaffold and config
- [ ] Step 2: Formatter and parser (pure logic)
- [ ] Step 3: Slack layer — bot skeleton with DM echo
- [ ] Step 4: Session manager and thread session
- [ ] Step 5: Pi SDK wiring — prompt and streaming
- [ ] Step 6: Streaming updater — throttle, mrkdwn, reactions
- [ ] Step 7: Message splitting
- [ ] Step 8: Inline tool details
- [ ] Step 9: cwd parsing and Block Kit buttons
- [ ] Step 10: Commands
- [ ] Step 11: Attach server and pi extension
- [ ] Step 12: System prompt and resource loading
- [ ] Step 13: Error handling and retry surfacing
- [ ] Step 14: Session persistence and idle timeout

---

## Step 1: Project scaffold and config

**Objective:** Runnable Node.js project with typed config loaded from `.env`.

**Implementation:**
- `package.json` — ESM, Node 22+, deps: `@slack/bolt`, `@mariozechner/pi-coding-agent`, `slackify-markdown`, `ws`, `dotenv`, `tsx` (dev)
- `tsconfig.json` — ESM, `NodeNext` modules, strict
- `src/config.ts` — load and validate all env vars, throw on missing required vars, export typed `Config`
- `.env.example` — all variables with defaults documented
- `src/index.ts` — entry point: load config, log startup info, exit cleanly on SIGINT

**Test requirements:**
- `src/config.test.ts` — throws on missing `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_ID`; applies all defaults correctly

**Demo:** `npx tsx src/index.ts` starts and logs loaded config (tokens redacted).

---

## Step 2: Formatter and parser (pure logic)

**Objective:** All pure transformation functions tested and working before any Slack or SDK wiring.

**Implementation:**
- `src/formatter.ts` — `markdownToMrkdwn(md, partial?)`, `splitMrkdwn(mrkdwn, limit?)`, `formatToolStart(name, args)`, `formatToolEnd(name, isError)`
  - `markdownToMrkdwn`: call `slackifyMarkdown`, if `partial` close unclosed triple-backtick pairs first
  - `splitMrkdwn`: split at `\n\n` > `\n` > ` ` > hard cut; never split inside a code block (count ` ``` ` pairs)
- `src/parser.ts` — `parseMessage(text, knownProjects)`, `fuzzyMatch(token, projects)`, `scanProjects(dirs)`
  - `parseMessage`: take first token, expand `~`, `fs.existsSync` + `isDirectory`; if not, fuzzy match
  - `fuzzyMatch`: match against basename and last two path segments, case-insensitive, return up to 5

**Test requirements:**
- `src/formatter.test.ts` — bold/italic/code/links, partial code block closure, split at paragraph, split at line, hard cut, never split inside code block, tool line formatting
- `src/parser.test.ts` — valid path, `~` expansion, no-match, fuzzy match (partial, case-insensitive), no candidates

**Demo:** All tests pass (`npm test`).

---

## Step 3: Slack layer — bot skeleton with DM echo

**Objective:** Bot connects to Slack, receives DMs from the authorized user, and echoes them back. Proves Socket Mode wiring works end-to-end.

**Implementation:**
- `src/slack.ts` — create Bolt `App` with Socket Mode, register `app.event('message')` handler
  - Auth check: ignore if `event.user !== config.slackUserId` or `event.subtype === 'bot_message'`
  - Echo: `client.chat.postMessage({ channel, thread_ts: threadTs, text: event.text })`
- `src/index.ts` — call `app.start()`, log "Bot running"

**Test requirements:** Manual — send a DM, verify echo reply in thread.

**Demo:** DM the bot "hello", receive "hello" back in a thread reply.

---

## Step 4: Session manager and thread session

**Objective:** Per-thread session lifecycle — create, get, queue, dispose, MAX_SESSIONS limit.

**Implementation:**
- `src/session-manager.ts` — `SessionManager` class implementing `ISessionManager`
  - `getOrCreate`: check limit, create `ThreadSession`, store in `Map<threadTs, ThreadSession>`
  - Idle reaper: `setInterval` every 60s, dispose sessions past `sessionIdleTimeoutSecs`
- `src/thread-session.ts` — `ThreadSession` class
  - Queue: `tasks: Array<() => Promise<void>>`, `processing: boolean`
  - `enqueue`: push task, call `_drain()` if not processing
  - `_drain`: pop and run tasks sequentially; catch errors per-task
  - `abort`, `dispose`, `newSession` stubs (wired to real `AgentSession` in Step 5)
  - `lastActivity` updated on each `enqueue`

**Test requirements:**
- `src/session-manager.test.ts` — create session, get same session, MAX_SESSIONS throws `SessionLimitError`, dispose removes from map, idle reaper disposes stale sessions (mock timers)
- `src/thread-session.test.ts` — queue serializes tasks, error in one task doesn't stop queue

**Demo:** Unit tests pass.

---

## Step 5: Pi SDK wiring — prompt and streaming

**Objective:** Bot creates real `AgentSession` per thread, sends user messages, receives streamed responses, posts raw text to Slack (no formatting yet).

**Implementation:**
- `src/thread-session.ts` — wire `AgentSession` via `createAgentSession`:
  - `sessionManager: SessionManager.open(sessionFilePath)` — JSONL at `{sessionDir}/{threadTs}.jsonl`
  - `tools: codingTools` with `cwd`
  - Subscribe to events: `text_delta` → accumulate, `agent_end` → post accumulated text
- `src/session-manager.ts` — pass `config` to `ThreadSession` constructor; ensure `sessionDir` exists
- `src/slack.ts` — replace echo with `sessionManager.getOrCreate(...)`, then `session.enqueue(() => session.prompt(text))`

**Test requirements:** Manual — send a DM, receive a real pi response (raw markdown, no conversion yet).

**Demo:** DM "what files are in the current directory?", receive a real agent response.

---

## Step 6: Streaming updater — throttle, mrkdwn, reactions

**Objective:** Responses stream progressively with throttled `chat.update`, mrkdwn conversion, and ⏳/✅ reactions.

**Implementation:**
- `src/streaming-updater.ts` — `StreamingUpdater` class
  - `begin`: post "⏳ Thinking...", add ⏳ reaction, return `StreamingState`
  - `appendText`: accumulate `rawMarkdown`, schedule `setTimeout(flush, throttleMs)` if no timer
  - `flush`: `markdownToMrkdwn(rawMarkdown, true)`, `chat.update` with mrkdwn content
  - `finalize`: cancel timer, final flush, remove ⏳ reaction, add ✅
  - `error`: cancel timer, post `❌ Error: {message}` as new message
- `src/thread-session.ts` — replace raw text accumulation with `StreamingUpdater`; wire `agent_start` → `begin`, `text_delta` → `appendText`, `agent_end` → `finalize`

**Test requirements:**
- `src/streaming-updater.test.ts` — multiple deltas within throttle window → single `chat.update`; deltas across two windows → two updates; finalize posts final content and swaps reactions (mock Slack client + fake timers)

**Demo:** Send a prompt requiring a long response; watch the Slack message update progressively every ~3s, then show ✅ on completion.

---

## Step 7: Message splitting

**Objective:** Responses exceeding `SLACK_MSG_LIMIT` are split into multiple thread messages.

**Implementation:**
- `src/streaming-updater.ts` — update `flush`:
  - After `markdownToMrkdwn`, call `splitMrkdwn(mrkdwn, config.slackMsgLimit)`
  - If one chunk: `chat.update` current message
  - If multiple chunks: `chat.update` current message with first chunk; for each remaining chunk, `chat.postMessage` as new thread reply; update `state.currentMessageTs` to last posted ts; track all ts in `state.postedMessageTs`

**Test requirements:**
- `src/formatter.test.ts` — already covers `splitMrkdwn`
- `src/streaming-updater.test.ts` — add: content > limit triggers split; second chunk posted as new message; `currentMessageTs` updated

**Demo:** Prompt the agent to produce a very long response (e.g., "list 200 items"); verify it splits into multiple thread messages.

---

## Step 8: Inline tool details

**Objective:** Tool execution start/end appears inline in the streaming message.

**Implementation:**
- `src/streaming-updater.ts` — implement `appendToolStart` and `appendToolEnd`:
  - `appendToolStart`: push `formatToolStart(name, args)` to `state.toolLines`; trigger immediate flush (bypass throttle timer)
  - `appendToolEnd`: find and replace the matching tool line with `formatToolEnd(name, isError)`; trigger immediate flush
  - `flush`: build final mrkdwn as `markdownToMrkdwn(rawMarkdown, true) + '\n' + toolLines.join('\n')`
- `src/thread-session.ts` — wire `tool_execution_start` → `appendToolStart`, `tool_execution_end` → `appendToolEnd`

**Test requirements:**
- `src/streaming-updater.test.ts` — tool start appends line and flushes immediately; tool end replaces start line; tool lines appear after text content

**Demo:** Ask the agent to read a file; see `> 🔧 \`read\`(path)` appear inline, then update to `> ✅ \`read\`` on completion.

---

## Step 9: cwd parsing and Block Kit buttons

**Objective:** First message token parsed as cwd; fuzzy match posts Block Kit buttons; button selection starts session.

**Implementation:**
- `src/slack.ts` — in `handleMessage`:
  - Call `parseMessage(text, knownProjects)` (knownProjects scanned at startup via `scanProjects`)
  - If `cwd` resolved: `getOrCreate({ threadTs, channelId, cwd })`, enqueue prompt
  - If `candidates.length > 0`: post Block Kit buttons message, store `{ threadTs, channelId, prompt }` in pending map keyed by button message ts
  - If no cwd and no candidates: `getOrCreate` with home dir, notify user, enqueue prompt
- `src/slack.ts` — register `app.action(/^select_cwd_/)`:
  - `ack()`
  - Resolve `threadTs` and `prompt` from pending map
  - `chat.update` button message to show selection
  - `getOrCreate({ threadTs, channelId, cwd: action.value })`, enqueue prompt
- `src/index.ts` — call `scanProjects(config.workspaceDirs)` at startup, refresh every 5 minutes

**Test requirements:**
- `src/parser.test.ts` — already covers parsing logic
- Manual: send `myproj do something` where `myproj` fuzzy-matches a known project; verify buttons appear and selection works

**Demo:** Send `myproj list the files` on mobile; tap the correct project button; see the agent respond with that project's cwd.

---

## Step 10: Commands

**Objective:** All `!` commands work correctly.

**Implementation:**
- `src/commands.ts` — implement all handlers:
  - `help`: post formatted command list
  - `new`: `session.newSession()`, post `🆕 New session started.`
  - `cancel`: `session.abort()`, post `🛑 Cancelled.`; if no session, post `No active session.`
  - `status`: post model, thinking level, message count, cwd, last activity
  - `model`: `session.setModel(args)`, post confirmation; catch unknown model error
  - `thinking`: validate level, `session.setThinkingLevel(level)`, post confirmation
  - `sessions`: post table of all active sessions from `sessionManager.list()`
  - `cwd`: resolve path, `session.cwd = resolved`, post confirmation; error if not found
- `src/slack.ts` — in `handleMessage`, detect `text.startsWith('!')`, parse command name + args, dispatch to `commands[name]`

**Test requirements:**
- `src/commands.test.ts` — each command with mock `CommandContext`; `!cancel` with no session; `!model` with unknown model; `!cwd` with invalid path

**Demo:** Send `!status` in an active thread; receive model, cwd, message count. Send `!cancel` mid-stream; verify stream stops.

---

## Step 11: Attach server and pi extension

**Objective:** A local pi session can attach to a Slack DM thread via WebSocket; bidirectional streaming works.

**Implementation:**
- `src/attach-server.ts` — `AttachServer` class:
  - `start()`: create `WebSocketServer({ port: config.attachPort })`
  - On `connection`: wait for `register` message; call `client.conversations.open` to get DM channel; post `🔗 Session attached from {cwd}`; send `thread_created`; store `AttachSession`
  - On `text_delta`, `tool_start`, `tool_end`, `agent_start`, `agent_end`, `retry_start`: delegate to `StreamingUpdater` (same pipeline as bot-initiated sessions)
  - On `detach` or `close`: post `🔌 Session detached`, clean up
  - `sendUserMessage(threadTs, text)`: find session, send `{ type: "user_message", text, ts }`
  - `hasSession(threadTs)`: check map
- `src/slack.ts` — in `handleMessage`: if `attachServer.hasSession(threadTs)`, call `attachServer.sendUserMessage(threadTs, text)` instead of routing to `SessionManager`
- `src/index.ts` — create and start `AttachServer`
- `extensions/slack-attach/` — pi extension (separate directory, not part of bot src):
  - `package.json` with `ws` dep
  - `index.ts` — `/attach` command, event forwarding, `/detach` command (see research sketch)

**Test requirements:**
- `src/attach-server.test.ts` — register flow creates thread and sends `thread_created`; `text_delta` triggers streaming update; `sendUserMessage` sends to correct WebSocket; disconnect posts notice (mock WebSocket + Slack client)
- Manual: run pi locally, `/attach`, send a prompt, verify Slack thread updates; reply in Slack, verify pi receives it

**Demo:** Run pi in a terminal, `/attach ws://localhost:3001`, ask it to list files; watch the Slack DM thread update in real time; reply in Slack; see pi respond.

---

## Step 12: System prompt and resource loading

**Objective:** Sessions load extensions/skills/AGENTS.md from cwd; system prompt includes Slack mrkdwn formatting rules.

**Implementation:**
- `src/thread-session.ts` — update `createAgentSession` call:
  - `resourceLoader: new DefaultResourceLoader(cwd)` — loads extensions, skills, AGENTS.md
  - `systemPromptSuffix` (or equivalent): append Slack formatting rules block:
    ```
    When responding in Slack, use mrkdwn formatting:
    - Bold: *text* (not **text**)
    - Italic: _text_
    - Code: `code` or ```code block```
    - Links: <url|text> (not [text](url))
    - No markdown headings — use *bold* for emphasis instead
    ```
- Verify `DefaultResourceLoader` API from pi SDK docs; adjust if the suffix injection mechanism differs

**Test requirements:** Manual — create a test project with `.pi/AGENTS.md` containing a custom instruction; send a DM with that project as cwd; verify the agent follows the instruction.

**Demo:** Project with `AGENTS.md` saying "always respond in haiku"; send a prompt; receive a haiku.

---

## Step 13: Error handling and retry surfacing

**Objective:** All error scenarios handled gracefully; LLM retries visible in Slack.

**Implementation:**
- `src/thread-session.ts` — wire `auto_retry_start` event → `streamingUpdater.appendRetry(state, attempt)`
- `src/streaming-updater.ts` — implement `appendRetry`: append `_↩️ Retrying (N/3)..._` to tool lines, immediate flush
- `src/thread-session.ts` — wrap `session.prompt()` in try/catch; on error call `streamingUpdater.error(state, err)`
- `src/slack.ts` — handle `SessionLimitError` from `getOrCreate`: post `⚠️ Too many active sessions.`
- `src/commands.ts` — wrap all handlers in try/catch; post error message on failure
- `src/attach-server.ts` — handle `conversations.open` failure: send error via WebSocket, close connection

**Test requirements:**
- `src/streaming-updater.test.ts` — `appendRetry` appends retry line and flushes; `error` posts error message
- `src/session-manager.test.ts` — `SessionLimitError` thrown at limit (already covered in Step 4)

**Demo:** Temporarily set an invalid API key; send a prompt; watch retry messages appear; see final error posted.

---

## Step 14: Session persistence and idle timeout

**Objective:** Sessions survive bot restarts; idle sessions are cleaned up automatically.

**Implementation:**
- `src/thread-session.ts` — confirm `SessionManager.open(filePath)` is used (from Step 5); verify session restores on `getOrCreate` when file exists
- `src/session-manager.ts` — confirm idle reaper is running (from Step 4); verify `dispose` calls `session.dispose()` which flushes JSONL
- `src/index.ts` — on `SIGINT`/`SIGTERM`: call `sessionManager.disposeAll()` before exit to flush all sessions cleanly
- Manual verification: check that `{sessionDir}/*.jsonl` files persist across restarts and sessions resume correctly

**Test requirements:**
- `src/session-manager.test.ts` — `disposeAll` calls dispose on all sessions; idle reaper fires after timeout (mock timers, already partially covered in Step 4)
- Manual: start bot, send messages, restart bot, send thread reply, verify conversation continues

**Demo:** Send several messages in a thread, restart the bot, reply in the same thread, verify the agent remembers the prior conversation.
