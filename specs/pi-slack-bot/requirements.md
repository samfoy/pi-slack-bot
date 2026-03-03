# Requirements

Q&A record from requirements clarification.

---

## Q1

**What's the MVP scope?** The overview lists a lot of features (streaming, tool approval, commands, shortcuts, session persistence, rate limiting, message splitting, etc.). For the first working version, which of these are must-haves vs. nice-to-haves? For example, is session persistence across restarts needed in v1, or is in-memory fine?

**A:** Everything listed in the overview is required. No phased rollout — full feature set from the start.

## Q2

**How should session persistence work?** The overview mentions sessions "can be in-memory or persisted to disk for resumability." Since persistence is required, what should be persisted — the full conversation history, the AgentSession state, or both? And where — a JSON file per thread, a SQLite DB, or something else?

**A:** JSON file per thread, aligned with pi's existing JSONL session format. AISlackBot (the predecessor) has no persistence at all — it's entirely in-memory with a single ACP session, no per-thread sessions, and no resumability. This is a new capability.

## Q3

**How should streaming updates be throttled?** AISlackBot uses a `STREAM_UPDATE_INTERVAL` (default 3s) to batch text deltas before updating the Slack message, and handles message splitting when content exceeds `SLACK_MSG_LIMIT` (3900 chars). Should we follow the same approach — time-based throttling with automatic message splitting at block boundaries? Any changes to the intervals or limits?

**A:** Yes, follow AISlackBot's approach: time-based throttling (3s default) with automatic message splitting at block boundaries (3900 char limit). Same intervals and limits.

## Q4

**How should the bot handle multiple concurrent threads?** The overview says "one AgentSession per Slack thread" with a `MAX_SESSIONS` limit. When a user sends messages in different threads simultaneously, should requests across threads be fully serialized (single global queue like AISlackBot), or should each thread have its own queue allowing parallel processing across threads?

**A:** Each thread gets its own queue. Requests within a thread are serialized, but different threads can process in parallel. Bounded by `MAX_SESSIONS`.

## Q5

**What does the pi SDK's `createAgentSession` API look like?** Before I ask more design questions, I should understand the SDK surface. Do you have a link to the pi SDK docs or a usage example, or should I look at the pi-mono source to figure out the `AgentSession` API (subscribe events, tool approval hooks, session save/restore, etc.)?

**A:** Researched pi-mono source. Key findings documented in research/pi-sdk-and-pi-mom.md.

## Q6

**Should we fork pi-mom or build fresh?** pi-mom covers ~40% of requirements (SDK wiring, persistence, queues, Socket Mode) but is missing streaming updates, tool approval, per-thread sessions, commands, shortcuts, rate limiting, cwd parsing, mrkdwn conversion, message splitting, and single-user security.

**A:** Build fresh, borrowing patterns from pi-mom (SDK wiring, SessionManager, queue pattern) and AISlackBot (streaming, tool approval, commands, shortcuts, formatting).

## Q7

**How should tool approval work at the SDK level?** The pi SDK has no built-in tool approval — tools auto-execute. AISlackBot gets approval via ACP's `session/request_permission` JSON-RPC method, which doesn't exist in the SDK. We need to build this ourselves. Two approaches:

1. **Wrap each tool's `execute` function** — intercept before execution, post approval message, wait for reaction, then proceed or reject.
2. **Use a custom tool execution hook** — if the SDK supports intercepting tool calls before execution.

Which approach, and should the approval UX match AISlackBot exactly (✅ allow once / 🔁 allow always / ❌ deny)?

**A:** Skip tool approval for now. All tools auto-execute (like pi-mom). Can be added later.

## Q8

**How should the bot handle DMs vs channel mentions?** The overview says "User sends message in DM (or @mentions bot in a channel)." Should both be fully supported from the start? And in channels, should the bot only respond to @mentions, or also track non-mention messages as context (like pi-mom logs all channel chatter)?

**A:** DM only for now. Single user. No channel mentions, no channel chatter tracking.

## Q9

**What's the threading model for DMs?** In Slack DMs, messages can be top-level or threaded. Should every top-level DM create a new session, and replies within a thread continue that session? Or should all DMs share a single session (like AISlackBot)?

**A:** Every top-level DM creates a separate session. Thread replies continue that session. Additionally, existing pi sessions (running on a dev box) should be able to attach to a DM thread — similar to PiSlackRemote, which is a pi extension that bridges a local session to a Slack thread (posts agent output, polls for user replies). Our bot should support both directions:
1. Slack → pi: user sends DM, bot creates session
2. pi → Slack: running pi session creates/attaches to a DM thread

## Q10

**How should the "pi → Slack" attach flow work?** PiSlackRemote uses a webhook + MCP polling approach (Amazon-internal deps). For our portable bot, should the attach flow be:
1. A pi extension that connects to the bot via WebSocket/HTTP and registers the session
2. The bot exposes an API endpoint that pi sessions can call to create a thread and stream to it
3. Something simpler — just a convention where the bot watches for a special message format

What's your thinking here?

**A:** Pi extension connects to the bot. The bot exposes a WebSocket/HTTP endpoint. The extension registers the local session, bot creates a DM thread, and they communicate bidirectionally — agent output flows to Slack, user replies flow back to the session.

## Q11

**What protocol should the extension↔bot connection use?** Two options:
1. **WebSocket** — persistent connection, real-time bidirectional streaming. Extension connects, bot pushes Slack replies, extension pushes agent events. Natural fit for streaming.
2. **HTTP** — extension POSTs events to bot, polls or uses SSE for Slack replies. Simpler but less real-time.

WebSocket seems like the obvious choice given the streaming requirement. Sound right?

**A:** WebSocket. Persistent bidirectional connection.

## Q12

**What's the system prompt strategy?** AISlackBot wraps user input with injection protection. pi-mom builds a detailed system prompt with workspace layout, memory, skills, Slack formatting rules, etc. For our bot, should we:
1. Use pi's default system prompt (from DefaultResourceLoader) — the session behaves like a normal pi coding session
2. Add a Slack-specific wrapper (formatting rules, injection protection)
3. Something else

**A:** Default pi system prompt plus Slack-specific formatting additions (mrkdwn rules: `*bold*` not `**bold**`, `_italic_`, no markdown links, code blocks, etc.). No injection protection needed since it's single-user.

## Q13

**Should the bot load extensions and skills from the cwd?** pi's DefaultResourceLoader discovers extensions from `.pi/extensions/`, skills from `.pi/skills/`, and AGENTS.md walking up from cwd. When a user sends `~/myproject fix the tests`, should the session load that project's extensions/skills/AGENTS.md? Or keep it simple with no resource loading?

**A:** Yes, load extensions/skills/AGENTS.md from the cwd. Also need fuzzy matching or a way to update cwd mid-session, since the remote user (e.g., on phone) may get the path wrong. Could be a `!cwd <path>` command, or fuzzy-match against known project directories.

## Q14

**How should cwd fuzzy matching work?** A few options:
1. **Known projects list** — scan a configurable set of directories (e.g., `~/projects`, `/workplace/$USER`) at startup, match partial names
2. **Tab-complete style** — bot suggests matches when path doesn't resolve
3. **Just a `!cwd` command** — user corrects manually, no fuzzy logic

**A:** Buttons approach. Scan `~/workplace/` (and configurable additional dirs) at startup to build a known projects list. When a path doesn't resolve, fuzzy-match against the list and post Block Kit buttons ("📂 Which project?"). User taps the right one, session starts with that cwd. Phone-friendly — fat tap targets, no typing. Also support a `!cwd` command for manual override.

## Q15

**How should shortcuts work?** AISlackBot uses a `shortcuts.json` file with templates like `{"review": {"template": "Review this code: {args}", "new_session": true, "agent": "reviewer"}}`. The user types `/review PR-123` and it expands. Should we follow the same pattern? And since we don't have agents/modes, should shortcuts just be prompt templates?

**A:** Not in scope for now.

## Q16

**What's the error handling strategy?** When things go wrong (LLM API errors, rate limits, tool failures), should the bot:
1. Post the error to the thread and let the user retry manually
2. Auto-retry with backoff (like pi's built-in `auto_retry`)
3. Both — let pi handle retries, surface final failures to Slack

**A:** Both. Let pi's built-in auto_retry handle transient failures with backoff. Surface retry attempts to Slack (like pi-mom does: "_Retrying (1/3)..._"). If retries exhaust, post the final error to the thread.

## Q17

**How should tool execution details surface in Slack?** pi-mom posts tool details in the thread (separate from the main response). AISlackBot shows them inline in the streaming message. Options:
1. **Inline** — tool labels/status appear in the main streaming message
2. **Thread** — tool details posted as thread replies (like pi-mom)
3. **Both** — inline summary + thread details

**A:** Inline. Tool execution details appear in the main streaming message.

## Q18 — Remaining defaults

**Session idle timeout:** Configurable `SESSION_IDLE_TIMEOUT` (default 3600s from overview). Dispose sessions after that.

**Compaction:** Let pi's built-in auto-compaction handle it via SettingsManager.

**`!cancel`:** Call `session.abort()` on the active session for the thread.

**A:** All reasonable. Accepted as defaults.

---

*Requirements clarification complete.*

