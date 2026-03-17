# pi-slack-bot — Agent Instructions

## Project Overview

Slack bot that exposes [pi](https://github.com/mariozechner/pi-coding-agent) as a conversational coding agent. TypeScript, Node.js >= 20, ESM modules.

## Code Standards

### Language & Style
- **TypeScript** with `strict: true` — no `any` unless absolutely necessary
- **ESM** (`"type": "module"`) — use `.js` extensions in imports (resolved from `.ts` by tsx)
- **Functional style** — prefer pure functions, avoid classes unless the domain demands it
- **Explicit types** on exported functions and public interfaces; infer locally
- **No default exports** — use named exports everywhere

### File Organization
- Source lives in `src/` — one module per concern (e.g., `parser.ts`, `formatter.ts`, `session-manager.ts`)
- Every module has a co-located test file: `foo.ts` → `foo.test.ts`
- Extensions live in `extensions/` (separate from core source)

### Commits
- **Conventional Commits**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Commit messages should be concise and describe *what* changed, not *how*
- **Commit all code** — never leave working changes uncommitted. After completing a task, stage and commit everything. Use `git add -A` to catch new files, deletions, and renames.
- Push to `origin` with `git push` (this is a personal GitHub repo, not Brazil)

### Testing
- **Every change must have tests** — if you add or modify a module, update its `.test.ts` file
- Test runner: Node.js built-in (`node --test`) via `npm test`
- Run tests before committing: `npm test`
- Run typecheck before committing: `npm run typecheck`
- Both must pass. Do not commit broken code.

### Quality Gates (run before committing)
```bash
npm run typecheck   # TypeScript strict mode
npm test            # All tests pass
npm run audit       # No critical vulnerabilities
```

### Error Handling
- Throw typed errors or return discriminated unions — never swallow errors silently
- Log errors with context (thread ID, session ID, etc.)
- Slack-facing errors should be user-friendly; log the full stack internally

### Secrets & Config
- **Never hardcode secrets** — all secrets go in `.env` (which is gitignored)
- Reference `.env.example` for the canonical list of env vars
- Use `config.ts` for all configuration access

## Architecture Notes

| Module | Purpose |
|---|---|
| `index.ts` | Entry point — wires Slack app + session manager |
| `slack.ts` | Slack Bolt app setup, message routing |
| `thread-session.ts` | One pi agent session per Slack thread |
| `session-manager.ts` | Lifecycle, limits, idle cleanup |
| `streaming-updater.ts` | Real-time Slack message updates with throttling |
| `formatter.ts` | Markdown → Slack mrkdwn conversion |
| `parser.ts` | Message parsing (commands, project refs) |
| `commands.ts` | `!model`, `!cwd`, `!cancel`, etc. |
| `command-picker.ts` | Interactive Slack button UIs for commands |
| `file-picker.ts` | Interactive file browser via Slack buttons |
| `attach-server.ts` | WebSocket server for external process streaming |
| `config.ts` | Env var loading and validation |

## Dependencies

- `@mariozechner/pi-coding-agent` — the pi SDK (core agent)
- `@slack/bolt` — Slack app framework (Socket Mode)
- `ws` — WebSocket server for attach functionality
- `slackify-markdown` — Markdown to Slack mrkdwn
- `dotenv` — env loading

Minimize new dependencies. Prefer Node.js built-ins and the existing stack.
