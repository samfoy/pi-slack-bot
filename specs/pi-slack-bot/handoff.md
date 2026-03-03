# PDD Handoff — pi-slack-bot

## Status
Research complete. Next step: **Step 6 (Create Detailed Design)** — user confirmed ready to proceed to design.

## Project Directory
`specs/pi-slack-bot/`

## Artifacts
- `rough-idea.md` — references `specs/OVERVIEW.md`
- `requirements.md` — 18 Q&A pairs covering all major design decisions
- `research/pi-sdk-and-pi-mom.md` — deep analysis of pi SDK API, pi-mom, AISlackBot, and PiSlackRemote
- `research/slack-bolt-api.md` — Slack Bolt Socket Mode, message/reaction events, chat.update, Block Kit buttons, mrkdwn formatting reference
- `research/markdown-to-mrkdwn.md` — slackify-markdown library analysis, message splitting algorithm, streaming conversion strategy
- `research/pi-extension-attach-flow.md` — extension architecture, WebSocket protocol, implementation sketch, patterns from existing extensions

## Key Decisions Summary

| Topic | Decision |
|-------|----------|
| Scope | Full feature set, no phasing |
| Build approach | Fresh build, borrow patterns from pi-mom + AISlackBot |
| Slack interaction | DM only, single user |
| Threading | Top-level DM = new session, thread replies continue it |
| Session persistence | JSON file per thread via SessionManager.open() |
| Concurrency | Per-thread queues, parallel across threads, bounded by MAX_SESSIONS |
| Streaming | 3s throttle, 3900 char limit, block-boundary splitting |
| Tool approval | Skipped for now — all tools auto-execute |
| Tool details | Inline in streaming message |
| System prompt | Default pi prompt + Slack mrkdwn formatting additions |
| Extensions/skills | Load from cwd via DefaultResourceLoader |
| cwd parsing | First token as path, fuzzy match against ~/workplace/ with Block Kit buttons |
| pi → Slack attach | Pi extension connects to bot via WebSocket, bidirectional streaming |
| Shortcuts | Not in scope |
| Error handling | Pi auto-retry + surface failures to Slack |
| Session timeout | Configurable, default 3600s |
| Compaction | Pi's built-in auto-compaction |
| Cancel | session.abort() per thread |

## Prior Art Researched
1. **pi SDK** (`@mariozechner/pi-coding-agent`) — createAgentSession, AgentSession, SessionManager, events, tools
2. **pi-mom** (`packages/mom` in pi-mono) — official pi Slack bot. Per-channel sessions, no streaming, no tool approval. Good reference for SDK wiring and persistence.
3. **AISlackBot** (Amazon-internal, Python) — slack_bolt + ACP subprocess. Streaming, tool approval, commands, shortcuts. Good reference for Slack UX patterns.
4. **PiSlackRemote** (Amazon-internal, TS) — pi extension that bridges local session to Slack DM thread via webhook + MCP polling. Reference for the "attach" flow.

## Source Code Locations
- pi-mono: `/tmp/pi-github-repos/badlogic/pi-mono/` (cloned)
- pi SDK docs: `packages/coding-agent/docs/sdk.md`
- pi-mom: `packages/mom/src/` (agent.ts, main.ts, slack.ts, context.ts, store.ts)
- AISlackBot: `https://code.amazon.com/packages/AISlackBot/trees/mainline`
- PiSlackRemote: `https://code.amazon.com/packages/PiSlackRemote/trees/mainline`

## Next Steps
1. Iteration checkpoint (confirm ready for design)
2. Create design.md — architecture, components, interfaces, data models, acceptance criteria
3. Create plan.md — incremental implementation steps
