import path from "path";
import { mkdirSync, realpathSync } from "fs";
import { createAgentSession, createCodingTools, DefaultResourceLoader, SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener, CompactionResult, ContextUsage, PromptTemplate } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { WebClient } from "@slack/web-api";
import type { Config, ThinkingLevel } from "./config.js";
import { StreamingUpdater } from "./streaming-updater.js";
import { createFilePickerTool, type FilePickerContext } from "./file-picker.js";
import { createShareFileTool, type ShareFileContext } from "./file-sharing.js";
import { encodeCwd } from "./session-path.js";
import { hasFileModifications, postDiffReview, getHeadRef } from "./diff-reviewer.js";
import { createPasteProvider, type PasteProvider } from "./paste-provider.js";
import { createNoopUiContext } from "./noop-ui-context.js";
import { isRalphNotification, isRalphEndNotification } from "./ralph-notifications.js";
import { formatTokenCount, formatContextUsage, getContextWarningThreshold } from "./context-format.js";
import { createLogger } from "./logger.js";
import type { ToolCallRecord } from "./formatter.js";

const log = createLogger("thread-session");

export interface ThreadSessionCreateParams {
  threadTs: string;
  channelId: string;
  cwd: string;
  config: Config;
  client: WebClient;
  sessionDir: string;
  /** If set, resume from this existing session file instead of creating a new one. */
  resumeSessionPath?: string;
}

export class ThreadSession {
  readonly threadTs: string;
  readonly channelId: string;
  readonly sessionPath: string;
  cwd: string;
  lastActivity: Date;

  private _agentSession: AgentSession;
  private _resourceLoader: DefaultResourceLoader;
  private _client: WebClient;
  private _updater: StreamingUpdater;
  private _pasteProvider: PasteProvider;
  private _tasks: Array<() => Promise<void>> = [];
  private _processing = false;

  constructor(
    threadTs: string,
    channelId: string,
    cwd: string,
    sessionPath: string,
    client: WebClient,
    agentSession: AgentSession,
    resourceLoader: DefaultResourceLoader,
    updater: StreamingUpdater,
    pasteProvider: PasteProvider,
  ) {
    this.threadTs = threadTs;
    this.channelId = channelId;
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this._client = client;
    this._agentSession = agentSession;
    this._resourceLoader = resourceLoader;
    this._updater = updater;
    this._pasteProvider = pasteProvider;
    this.lastActivity = new Date();
  }

  /**
   * Dispose the persistent event subscriber.
   * Set during construction, cleaned up in dispose().
   */
  private _persistentUnsub: (() => void) | null = null;
  /**
   * Current streaming state for the active agent turn.
   * Managed by the persistent subscriber via agent_start / agent_end events.
   */
  private _activeStreamState: import("./streaming-updater.js").StreamingState | null = null;
  /**
   * Tool records for the current agent turn, used to detect file modifications.
   */
  private _turnToolRecords: ToolCallRecord[] = [];
  /**
   * Git HEAD SHA at the start of the current agent turn.
   * Used to detect commits made during the turn.
   */
  private _turnBaseRef: string | null = null;
  /**
   * Promise that resolves when the current agent turn finishes.
   * Used by prompt() to wait for the full turn (including extension-triggered follow-ups).
   */
  private _turnCompletePromise: Promise<void> | null = null;
  private _turnCompleteResolve: (() => void) | null = null;
  /**
   * When true, a ralph loop is running in the background.
   * The persistent subscriber skips streaming to Slack but still resolves turn promises.
   */
  private _ralphBackgroundActive = false;

  /**
   * Tracks the highest context warning threshold we've already warned about.
   * Reset to 0 on newSession(). Prevents repeated warnings at the same level.
   */
  private _lastContextWarningThreshold = 0;

  /**
   * The last user prompt sent to the agent. Used for retry via reaction.
   */
  private _lastUserPrompt: string | null = null;

  static async create(params: ThreadSessionCreateParams): Promise<ThreadSession> {
    // Resolve symlinks so the cwd matches what pi TUI uses (realpath).
    // Without this, ~/workplace/Rosie stays as /home/samfp/workplace/Rosie
    // while pi resolves it to /workplace/samfp/Rosie, causing session dir mismatches.
    params = { ...params, cwd: realpathSync(params.cwd) };

    // Store sessions in pi's native directory structure so `pi /resume` finds them.
    // Encodes cwd the same way pi does: ~/.pi/agent/sessions/--<encoded-cwd>--/
    const cwdEncoded = encodeCwd(params.cwd);
    const nativeSessionDir = path.join(params.sessionDir, cwdEncoded);
    mkdirSync(nativeSessionDir, { recursive: true });

    // If resuming, use the existing session file; otherwise create a new one.
    const sessionFilePath = params.resumeSessionPath
      ?? path.join(nativeSessionDir, `${params.threadTs}.jsonl`);
    const piSessionManager = PiSessionManager.open(sessionFilePath, nativeSessionDir);

    // DefaultResourceLoader auto-discovers extensions and prompts from ~/.pi/agent/
    const resourceLoader = new DefaultResourceLoader({ cwd: params.cwd });
    await resourceLoader.reload();

    // File picker tool needs Slack context; create a getter that returns
    // the current channel/thread/client (stable for the lifetime of this session).
    const filePickerContext: FilePickerContext = {
      client: params.client,
      channelId: params.channelId,
      threadTs: params.threadTs,
    };
    const filePickerTool = createFilePickerTool(params.cwd, () => filePickerContext);

    // Share file tool — lets the agent upload files to the Slack thread
    const shareFileContext: ShareFileContext = {
      client: params.client,
      channelId: params.channelId,
      threadTs: params.threadTs,
    };
    const shareFileTool = createShareFileTool(params.cwd, () => shareFileContext);

    const { session } = await createAgentSession({
      cwd: params.cwd,
      sessionManager: piSessionManager,
      tools: createCodingTools(params.cwd),
      customTools: [filePickerTool, shareFileTool],
      resourceLoader,
    });

    // Bind extensions with a minimal UI context so session_start fires.
    // This is required for extensions like ralph that load state in session_start.
    const uiContext = createNoopUiContext({
      notify: (message: string, type?: "info" | "warning" | "error") => {
        log.info("Extension notification", { type: type ?? "info", message, threadTs: params.threadTs });
        // Detect ralph-related notifications and post to Slack.
        if (isRalphNotification(message)) {
          if (isRalphEndNotification(message)) {
            ts._ralphBackgroundActive = false;
          }
          ts._postToThread(`🎩 ${message}`).catch((err) => {
            log.error("Failed to post ralph notification", { threadTs: params.threadTs, error: err });
          });
        }
      },
    });
    await session.bindExtensions({
      uiContext,
      onError: (err) => {
        log.error("Extension error", { extensionPath: err.extensionPath, event: err.event, error: err.error, stack: err.stack ?? "" });
      },
    });

    // Find and set the model from config (provider/model from .env)
    const registry = session.modelRegistry;
    const allModels = registry.getAll();
    const model = allModels.find(
      (m) => m.provider === params.config.provider && m.id === params.config.model,
    ) ?? allModels.find(
      (m) => m.provider === params.config.provider,
    );
    if (model) {
      await session.setModel(model);
      session.setThinkingLevel(params.config.thinkingLevel);
    }

    const updater = new StreamingUpdater(params.client, params.config.streamThrottleMs);
    const pasteProvider = createPasteProvider(params.config.pasteProvider);

    const ts = new ThreadSession(
      params.threadTs,
      params.channelId,
      params.cwd,
      sessionFilePath,
      params.client,
      session,
      resourceLoader,
      updater,
      pasteProvider,
    );
    ts._setupPersistentSubscriber();
    return ts;
  }

  enqueue(task: () => Promise<void>): void {
    this.lastActivity = new Date();
    this._tasks.push(task);
    if (!this._processing) void this._drain();
  }

  private async _drain(): Promise<void> {
    this._processing = true;
    while (this._tasks.length > 0) {
      const task = this._tasks.shift()!;
      try {
        await task();
      } catch (err) {
        log.error("Task error", { threadTs: this.threadTs, error: err });
      }
    }
    this._processing = false;
  }

  /**
   * Set up a persistent event subscriber that handles all agent turns,
   * including those triggered asynchronously by extensions (e.g., ralph loops).
   */
  private _setupPersistentSubscriber(): void {
    // Buffer events that arrive before streaming state is ready
    let pendingEvents: AgentSessionEvent[] = [];
    let stateReady = false;

    const flushPending = () => {
      stateReady = true;
      const state = this._activeStreamState;
      if (!state) return;
      for (const event of pendingEvents) {
        this._dispatchStreamEvent(event, state);
      }
      pendingEvents = [];
    };

    this._persistentUnsub = this._agentSession.subscribe((event) => {
      if (event.type === "agent_start") {
        stateReady = false;
        pendingEvents = [];
        this._turnToolRecords = [];
        this._turnBaseRef = getHeadRef(this.cwd);

        // If ralph loop is running in background, skip Slack streaming
        // but still track turn lifecycle for promise resolution.
        if (this._ralphBackgroundActive) return;

        // A new agent turn is starting — create streaming state
        this._updater.begin(this.channelId, this.threadTs).then((state) => {
          this._activeStreamState = state;
          flushPending();
        }).catch((err) => {
          log.error("Failed to begin streaming", { threadTs: this.threadTs, error: err });
        });
        return;
      }

      if (event.type === "agent_end") {
        // Agent turn finished — finalize the stream and resolve the turn promise
        const state = this._activeStreamState;
        const toolRecords = [...this._turnToolRecords];
        const baseRef = this._turnBaseRef;
        this._activeStreamState = null;
        stateReady = false;
        pendingEvents = [];
        if (state) {
          this._updater.finalize(state).then(async () => {
            // Auto-post diff if files were modified
            if (hasFileModifications(toolRecords)) {
              try {
                await postDiffReview(this._client, this.channelId, this.threadTs, this.cwd, {
                  baseRef,
                  toolRecords,
                  pasteProvider: this._pasteProvider,
                });
              } catch (err) {
                log.error("Failed to post diff review", { threadTs: this.threadTs, error: err });
              }
            }
            // Check context usage and warn if approaching limits
            this._checkContextWarning();
          }).catch((err) => {
            log.error("Failed to finalize streaming", { threadTs: this.threadTs, error: err });
          });
        } else {
          // No streaming state (e.g. ralph background) — still check context
          this._checkContextWarning();
        }
        // Resolve the turn-complete promise so prompt() can return
        if (this._turnCompleteResolve) {
          this._turnCompleteResolve();
          this._turnCompleteResolve = null;
          this._turnCompletePromise = null;
        }
        return;
      }

      // Auto-compaction events
      if (event.type === "auto_compaction_start") {
        this._postToThread("🗜️ Auto-compacting conversation...").catch((err) => {
          log.error("Failed to post auto-compaction start", { threadTs: this.threadTs, error: err });
        });
        return;
      }

      if (event.type === "auto_compaction_end") {
        const result = event.result;
        if (result) {
          const after = this.getContextUsage();
          const beforeStr = formatTokenCount(result.tokensBefore);
          const afterStr = after?.tokens != null ? formatTokenCount(after.tokens) : "unknown";
          this._postToThread(`🗜️ Auto-compacted: ${beforeStr} → ${afterStr} tokens`).catch((err) => {
            log.error("Failed to post auto-compaction end", { threadTs: this.threadTs, error: err });
          });
          // Reset warning threshold since context was freed
          this._lastContextWarningThreshold = 0;
        }
        return;
      }

      // If ralph background mode, skip streaming events
      if (this._ralphBackgroundActive) return;

      // Track tool records for diff review (before state-ready check)
      if (event.type === "tool_execution_start") {
        this._turnToolRecords.push({
          toolName: event.toolName,
          args: event.args,
          startTime: Date.now(),
        });
      } else if (event.type === "tool_execution_end") {
        const record = [...this._turnToolRecords].reverse().find(
          (r) => r.toolName === event.toolName && r.endTime === undefined,
        );
        if (record) {
          record.endTime = Date.now();
          record.isError = event.isError;
        }
      }

      // If state isn't ready yet, buffer the event
      if (!stateReady) {
        pendingEvents.push(event);
        return;
      }

      const state = this._activeStreamState;
      if (!state) return;
      this._dispatchStreamEvent(event, state);
    });
  }

  private _dispatchStreamEvent(event: AgentSessionEvent, state: import("./streaming-updater.js").StreamingState): void {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      this._updater.appendText(state, event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      this._updater.appendToolStart(state, event.toolName, event.args);
    } else if (event.type === "tool_execution_end") {
      this._updater.appendToolEnd(state, event.toolName, event.isError);
    }
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    // Track last user prompt for retry via reaction
    this._lastUserPrompt = text;

    // Rewrite !command → /command for pi extension commands & prompt templates.
    // Bot-level commands (help, model, etc.) are intercepted before reaching here,
    // so only pi commands (pdd, ralph, review, etc.) arrive at this point.
    const piText = text.replace(/^!/, "/");

    // Detect ralph loop commands that should run in background.
    // /ralph <preset> <prompt> starts a loop; /ralph stop|status are instant.
    const isRalphLoopStart = /^\/(ralph)\s+(?!stop\b|status\b|list\b|help\b|pause\b|resume\b|steer\b|presets\b|history\b|loops\b)\S+/i.test(piText);
    if (isRalphLoopStart) {
      this._ralphBackgroundActive = true;
      await this._postToThread("🎩 Starting Ralph loop in background...");
    }

    // Create a turn-complete promise that will be resolved by the persistent subscriber
    // when agent_end fires. This ensures we wait for the full agent turn, including
    // turns triggered asynchronously by extensions (e.g., ralph loops via sendUserMessage).
    this._turnCompletePromise = new Promise<void>((resolve) => {
      this._turnCompleteResolve = resolve;
    });

    try {
      await this._agentSession.prompt(piText, {
        images: options?.images,
      });
      // For extension commands that are "handled" immediately (like /ralph),
      // prompt() returns before the agent turn starts. Wait for the first turn to
      // complete, but don't block forever if no turn was started (pure commands).
      if (this._turnCompletePromise) {
        await Promise.race([
          this._turnCompletePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
      }

      // If a ralph loop is running in background, don't wait for it.
      // The loop will post its own status messages to the thread.
      if (this._ralphBackgroundActive) {
        return;
      }

      // If the agent is still streaming (extension triggered another turn),
      // wait for it to finish so we don't dequeue the next task prematurely.
      while (true) {
        if (!this._agentSession.isStreaming) {
          // Give extensions a moment to trigger the next turn
          await new Promise((r) => setTimeout(r, 200));
          if (!this._agentSession.isStreaming) break;
        }
        await new Promise<void>((resolve) => {
          this._turnCompletePromise = new Promise<void>((r) => {
            this._turnCompleteResolve = r;
          });
          this._turnCompletePromise.then(resolve);
        });
      }
    } catch (err) {
      // If we have an active stream state, show the error there
      const state = this._activeStreamState;
      if (state) {
        this._activeStreamState = null;
        await this._updater.error(state, err instanceof Error ? err : new Error(String(err)));
      }
      // Clean up turn promise
      if (this._turnCompleteResolve) {
        this._turnCompleteResolve();
        this._turnCompleteResolve = null;
        this._turnCompletePromise = null;
      }
    }
  }

  abort(): void {
    void this._agentSession.abort();
    this._ralphBackgroundActive = false;
    // Resolve any pending turn promise so prompt() unblocks
    if (this._turnCompleteResolve) {
      this._turnCompleteResolve();
      this._turnCompleteResolve = null;
      this._turnCompletePromise = null;
    }
  }

  /** Whether a ralph loop is currently running in the background. */
  get ralphBackgroundActive(): boolean {
    return this._ralphBackgroundActive;
  }

  /** Post a plain text message to the Slack thread (not streamed, just a single message). */
  private async _postToThread(text: string): Promise<void> {
    await this._client.chat.postMessage({
      channel: this.channelId,
      thread_ts: this.threadTs,
      text,
    });
  }

  async dispose(): Promise<void> {
    if (this._persistentUnsub) {
      this._persistentUnsub();
      this._persistentUnsub = null;
    }
    this._agentSession.dispose();
  }

  async newSession(): Promise<void> {
    await this._agentSession.newSession();
    this._lastContextWarningThreshold = 0;
  }

  async reload(): Promise<void> {
    // Re-discovers extensions and prompts from disk at the original cwd.
    // Note: project-local .pi/ discovery is bound to the cwd set at session
    // creation. Use !new after !cwd to pick up a different project's .pi/.
    await this._resourceLoader.reload();
  }

  get isStreaming(): boolean {
    return this._agentSession.isStreaming;
  }

  get messageCount(): number {
    return this._agentSession.messages.length;
  }

  /** Get current context window usage (tokens, window size, percentage). */
  getContextUsage(): ContextUsage | undefined {
    return this._agentSession.getContextUsage();
  }

  /** Compact the conversation to free context space. Returns the compaction result. */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    return this._agentSession.compact(customInstructions);
  }

  /**
   * Check context usage after a turn and post a warning if thresholds are crossed.
   * Only warns once per threshold (80%, 90%) to avoid spam.
   */
  private _checkContextWarning(): void {
    const usage = this.getContextUsage();
    if (!usage || usage.percent === null) return;

    const threshold = getContextWarningThreshold(usage.percent, this._lastContextWarningThreshold);
    if (threshold !== null) {
      this._lastContextWarningThreshold = threshold;
      const usageStr = formatContextUsage(usage);
      this._postToThread(
        `⚠️ Context is ${Math.round(usage.percent)}% full (${usageStr}). Use \`!compact\` to summarize or \`!new\` for a fresh session.`,
      ).catch((err) => {
        log.error("Failed to post context warning", { threadTs: this.threadTs, error: err });
      });
    }
  }

  get model(): AgentSession["model"] {
    return this._agentSession.model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._agentSession.thinkingLevel as ThinkingLevel;
  }

  async setModel(modelName: string): Promise<void> {
    const registry = this._agentSession.modelRegistry;
    const all = registry.getAll();
    const match = all.find(
      (m) => m.id === modelName || m.name.toLowerCase() === modelName.toLowerCase(),
    );
    if (!match) {
      throw new Error(`Unknown model: ${modelName}. Available: ${all.map((m) => m.id).join(", ")}`);
    }
    await this._agentSession.setModel(match);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this._agentSession.setThinkingLevel(level);
  }

  subscribe(handler: AgentSessionEventListener): () => void {
    return this._agentSession.subscribe(handler);
  }

  /** Available file-based prompt templates (e.g. /review, /test, /explain). */
  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this._agentSession.promptTemplates;
  }

  /** The configured paste provider for diff uploads. */
  get pasteProvider(): PasteProvider {
    return this._pasteProvider;
  }

  /** The last user prompt sent to the agent (for retry). */
  get lastUserPrompt(): string | null {
    return this._lastUserPrompt;
  }
}
