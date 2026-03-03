# Rough Idea

See [../OVERVIEW.md](../OVERVIEW.md) for the full project overview.

**Summary:** A Slack bot that exposes pi as a conversational coding agent via Slack. Built with `@slack/bolt` (Socket Mode) and pi's TypeScript SDK (`createAgentSession`). Single Node.js process — no subprocesses, no polling, no tmux. Features streaming responses, tool approval via emoji reactions, per-thread sessions, request queuing, and commands.
