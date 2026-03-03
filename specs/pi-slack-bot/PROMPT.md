# pi-slack-bot

## Objective

Build a single-process Node.js Slack bot that exposes pi as a conversational coding agent via Slack DMs. Uses `@slack/bolt` (Socket Mode) and pi's TypeScript SDK (`createAgentSession`). No subprocesses, no polling, no tmux.

## Key Requirements

- DM-only, single authorized user (`SLACK_USER_ID`)
- One `AgentSession` per Slack thread, keyed by `thread_ts`; top-level DM creates new session, thread reply continues it
- Sessions persisted as JSONL files via `SessionManager.open()` — survive bot restarts
- Streaming responses: accumulate text deltas, throttled `chat.update` every 3s, ⏳ → ✅ reactions
- Markdown → Slack mrkdwn via `slackify-markdown`; message splitting at block boundaries at 3900 chars
- Inline tool execution details in streaming message (`> 🔧 tool_name` → `> ✅ tool_name`)
- cwd parsed from first message token; fuzzy match against `~/workplace/` with Block Kit buttons
- Extensions/skills/AGENTS.md loaded from cwd via `DefaultResourceLoader`
- Commands: `!help`, `!new`, `!cancel`, `!status`, `!model`, `!thinking`, `!sessions`, `!cwd`
- Per-thread request queues; parallel across threads; bounded by `MAX_SESSIONS`
- Session idle timeout (default 3600s); pi's built-in auto-retry + compaction
- Pi → Slack attach flow: pi extension connects via WebSocket, bidirectional streaming
- All config via `.env`; Node.js 22+, ESM

## Acceptance Criteria

**Given** a DM from a non-authorized user **When** processed **Then** bot does not respond

**Given** authorized user sends top-level DM **When** processed **Then** new `ThreadSession` created, JSONL file at `{SESSION_DIR}/{ts}.jsonl`, bot posts ⏳ Thinking...

**Given** thread reply arrives **When** processed **Then** enqueued to existing session, no new session created

**Given** bot restarts with existing JSONL **When** user sends thread reply **Then** session restored and conversation continues

**Given** rapid text deltas **When** streaming **Then** `chat.update` called at most once per `STREAM_THROTTLE_MS`

**Given** response exceeds 3900 chars **When** flushed **Then** split at paragraph/line boundary, never inside code block, overflow posted as new thread reply

**Given** `MAX_SESSIONS` active **When** new top-level DM arrives **Then** bot posts ⚠️ Too many active sessions

**Given** pi extension sends `register` **When** processed **Then** bot opens DM, posts 🔗 Session attached, sends `thread_created` back

**Given** attached session active **When** user replies in Slack **Then** bot sends `user_message` to extension via WebSocket

## Reference

All design details, component interfaces, data models, error handling, and the full implementation plan are in `specs/pi-slack-bot/`:

- `design.md` — architecture, TypeScript interfaces, data models, error handling, acceptance criteria
- `plan.md` — 14 incremental steps with test requirements and demo descriptions
- `requirements.md` — full Q&A record
- `research/` — pi SDK, Slack Bolt, slackify-markdown, attach flow

Follow `plan.md` step by step. Each step ends with working, demoable functionality. Run tests after each step before proceeding.
