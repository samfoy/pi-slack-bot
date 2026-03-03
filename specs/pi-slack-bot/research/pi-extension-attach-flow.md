# Pi Extension for Attach Flow Research

## Extension Capabilities Relevant to Attach

From the pi SDK extensions docs and examples (especially `ssh.ts`, `event-bus.ts`):

### What extensions can do
- **Network I/O** — Full Node.js built-ins (`node:net`, `node:http`, `node:child_process`). The ssh.ts example spawns SSH processes; extensions can open WebSocket connections, HTTP servers, etc.
- **npm dependencies** — Extensions with a `package.json` can use any npm package (e.g., `ws` for WebSocket). Just `npm install` in the extension directory.
- **Register commands** — `pi.registerCommand('/attach', ...)` for user-initiated attach
- **Subscribe to all events** — `pi.on('agent_start' | 'message_update' | 'tool_execution_start' | 'agent_end' | ...)` to forward events to Slack
- **Inject messages** — `pi.sendUserMessage(text)` to deliver Slack replies back to the agent
- **Session lifecycle** — `pi.on('session_start', ...)` and `pi.on('session_shutdown', ...)` for setup/teardown
- **Status display** — `ctx.ui.setStatus('attach', 'Connected to Slack')` for TUI feedback
- **Persist state** — `pi.appendEntry('attach-state', { threadTs, channel })` survives restarts

### What extensions cannot do
- No direct access to `AgentSession` — must use `pi.sendUserMessage()` or `pi.sendMessage()` to communicate with the agent
- No `session.prompt()` — that's the SDK-level API, not available in extensions
- No `session.abort()` — but `ctx.abort()` is available in event handlers

## Attach Extension Design

### Architecture

```
┌─────────────────────┐         WebSocket          ┌──────────────────┐
│   pi (local dev)    │◄──────────────────────────►│  pi-slack-bot    │
│                     │                             │                  │
│  attach extension   │  agent events ──────────►  │  creates/updates │
│  - /attach command  │                             │  Slack DM thread │
│  - event forwarding │  ◄──────────── user msgs   │                  │
│  - msg injection    │                             │  forwards Slack  │
│                     │                             │  replies back    │
└─────────────────────┘                             └──────────────────┘
```

### Extension Structure

```
~/.pi/agent/extensions/
└── slack-attach/
    ├── package.json       # depends on "ws"
    ├── node_modules/
    └── index.ts           # extension entry point
```

### Extension Implementation Sketch

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import WebSocket from "ws";

export default function (pi: ExtensionAPI) {
  let ws: WebSocket | null = null;
  let connected = false;

  pi.registerCommand("attach", {
    description: "Attach this session to a Slack DM thread",
    handler: async (args, ctx) => {
      const botUrl = args.trim() || process.env.PI_SLACK_BOT_URL || "ws://localhost:3001";

      ws = new WebSocket(botUrl);

      ws.on("open", () => {
        connected = true;
        ctx.ui.setStatus("slack", ctx.ui.theme.fg("accent", "🔗 Slack attached"));
        ctx.ui.notify("Connected to Slack bot", "info");

        // Register this session with the bot
        ws.send(JSON.stringify({
          type: "register",
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "user_message") {
          // Slack user sent a reply → inject into pi session
          pi.sendUserMessage(msg.text);
        }
        if (msg.type === "thread_created") {
          // Bot created a Slack thread for us
          ctx.ui.notify(`Slack thread: ${msg.threadUrl}`, "info");
        }
      });

      ws.on("close", () => {
        connected = false;
        ctx.ui.setStatus("slack", "");
        ctx.ui.notify("Disconnected from Slack bot", "warning");
      });

      ws.on("error", (err) => {
        ctx.ui.notify(`Slack connection error: ${err.message}`, "error");
      });
    },
  });

  // Forward agent events to Slack
  pi.on("message_update", async (event) => {
    if (!connected || !ws) return;
    if (event.assistantMessageEvent.type === "text_delta") {
      ws.send(JSON.stringify({
        type: "text_delta",
        delta: event.assistantMessageEvent.delta,
      }));
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({
      type: "tool_start",
      toolName: event.toolName,
      args: event.args,
    }));
  });

  pi.on("tool_execution_end", async (event) => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({
      type: "tool_end",
      toolName: event.toolName,
      isError: event.isError,
    }));
  });

  pi.on("agent_start", async () => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({ type: "agent_start" }));
  });

  pi.on("agent_end", async (event) => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({
      type: "agent_end",
      messageCount: event.messages.length,
    }));
  });

  pi.on("auto_retry_start", async () => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({ type: "retry_start" }));
  });

  // Cleanup on session end
  pi.on("session_shutdown", async () => {
    if (ws) {
      ws.close();
      ws = null;
      connected = false;
    }
  });

  // Detach command
  pi.registerCommand("detach", {
    description: "Detach from Slack DM thread",
    handler: async (_args, ctx) => {
      if (ws) {
        ws.close();
        ws = null;
        connected = false;
        ctx.ui.setStatus("slack", "");
        ctx.ui.notify("Detached from Slack", "info");
      }
    },
  });
}
```

## Bot-Side WebSocket Server

The bot needs a WebSocket endpoint alongside the Bolt app:

```typescript
import { WebSocketServer } from "ws";

// Alongside the Bolt app
const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "register") {
      // Create a DM thread for this attached session
      // Store ws ↔ threadTs mapping
    }

    if (msg.type === "text_delta") {
      // Accumulate + throttle → chat.update in the thread
    }

    if (msg.type === "agent_start") {
      // Post "⏳ Thinking..." in thread
    }

    if (msg.type === "agent_end") {
      // Finalize message, swap reactions
    }
  });
});
```

## WebSocket Protocol

### Extension → Bot (agent events)

```typescript
// Session registration
{ type: "register", sessionId: string, cwd: string }

// Streaming text
{ type: "text_delta", delta: string }

// Tool lifecycle
{ type: "tool_start", toolName: string, args: Record<string, any> }
{ type: "tool_end", toolName: string, isError: boolean }

// Agent lifecycle
{ type: "agent_start" }
{ type: "agent_end", messageCount: number }

// Retry
{ type: "retry_start" }

// Disconnect
{ type: "detach" }
```

### Bot → Extension (Slack events)

```typescript
// Thread created
{ type: "thread_created", threadTs: string, threadUrl: string }

// User replied in Slack thread
{ type: "user_message", text: string, ts: string }

// User reacted (for future tool approval)
{ type: "reaction", reaction: string, messageTs: string }

// Cancel request
{ type: "cancel" }
```

## Key Design Decisions

1. **WebSocket over HTTP** — Persistent bidirectional connection. Natural fit for streaming. Extension pushes events, bot pushes Slack replies. No polling.

2. **Extension registers with bot, not vice versa** — The extension initiates the connection. The bot doesn't need to know about running pi sessions until they connect. Simpler discovery.

3. **Bot creates the DM thread** — On `register`, the bot posts an initial message in the DM (e.g., "🔗 Session attached from `/path/to/project`") and sends back the `thread_created` event with the thread URL.

4. **Same streaming pipeline** — Attached sessions use the same streaming/throttle/split logic as bot-initiated sessions. The only difference is the event source (WebSocket vs. `session.subscribe()`).

5. **Graceful disconnect** — On `session_shutdown` or `/detach`, the extension closes the WebSocket. The bot posts a final message ("Session detached") and cleans up the session mapping. If the WebSocket drops unexpectedly, the bot detects via `ws.on('close')` and posts a disconnect notice.

6. **No session persistence for attached sessions** — The pi session already has its own persistence. The bot just needs to track the WebSocket ↔ threadTs mapping in memory. If the bot restarts, attached sessions need to reconnect (the extension could auto-reconnect).

## Patterns from Existing Extensions

### From ssh.ts
- Lazy initialization: resolve config on `session_start`, not during factory
- Status display: `ctx.ui.setStatus("ssh", ...)` for persistent TUI indicator
- System prompt modification: `pi.on("before_agent_start", ...)` to add context
- Cleanup: handle disconnect gracefully

### From event-bus.ts
- Store `ctx` reference from `session_start` for use in async callbacks
- `pi.events` for inter-extension communication (could be useful if attach is split across files)

### From send-user-message.ts
- `pi.sendUserMessage(text)` to inject user messages into the agent
- Must specify `deliverAs: "steer"` or `"followUp"` if agent is currently streaming
