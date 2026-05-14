import path from "path";
import { mkdirSync, realpathSync } from "fs";
import { createAgentSession, createCodingTools, DefaultResourceLoader, SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener, CompactionResult, ContextUsage, PromptTemplate } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { WebClient } from "@slack/web-api";
import type { Config, ThinkingLevel } from "./config.js";
import { StreamingUpdater } from "./streaming-updater.js";
import { createFilePickerTool, type FilePickerContext } from "./file-picker.js";
import { createShareFileTool, type ShareFileContext } from "./file-sharing.js";
import { createRestartBotTool, createSetModelTool, createSetThinkingLevelTool } from "./bot-tools.js";
import type { BotSessionManager } from "./session-manager.js";
import { encodeCwd } from "./session-path.js";
import { hasFileModifications, postDiffReview, getHeadRef } from "./diff-reviewer.js";
import { createPasteProvider, type PasteProvider } from "./paste-provider.js";
import { createNoopUiContext } from "./noop-ui-context.js";

import { formatTokenCount, formatContextUsage, getContextWarningThreshold } from "./context-format.js";
import { createLogger } from "./logger.js";
import type { ToolCallRecord } from "./formatter.js";
import { isExpiredTokenError, refreshAwsCredentials } from "./aws-creds.js";

const log = createLogger("thread-session");

export interface ThreadSessionCreateParams {
  threadTs: string;
  channelId: string;
  cwd: string;
  config: Config;
  client: WebClient;
  sessionDir: string;
  /** Session manager reference for bot-level tools (restart). */
  sessionManager?: BotSessionManager;
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
  // @ts-expect-error stored for potential future use
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
   * Promise for the in-flight begin() call. Allows agent_end to await it
   * when the API fails so fast that begin() hasn't resolved yet.
   */
  private _beginPromise: Promise<import("./streaming-updater.js").StreamingState> | null = null;
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
   * Tracks the highest context warning threshold we've already warned about.
   * Reset to 0 on newSession(). Prevents repeated warnings at the same level.
   */
  private _lastContextWarningThreshold = 0;

  /**
   * The last user prompt sent to the agent. Used for retry via reaction.
   */
  private _lastUserPrompt: string | null = null;

  /**
   * Set to true when credentials were auto-refreshed after an expired token error.
   * The prompt() method checks this after the turn completes and retries once.
   */
  private _pendingCredRetry = false;

  /** Tracks consecutive credential refresh attempts to prevent infinite retry loops. */
  private _credRetryCount = 0;
  private static readonly MAX_CRED_RETRIES = 1;

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

    // Bot control tools — let the agent restart, switch models, change thinking
    // Uses lazy getters since the ThreadSession instance doesn't exist yet.
    let threadSessionRef: ThreadSession | null = null;
    const botTools = [];

    if (params.sessionManager) {
      const sm = params.sessionManager;
      botTools.push(createRestartBotTool(() => ({ sessionManager: sm })));
    }
    botTools.push(createSetModelTool(() => threadSessionRef!));
    botTools.push(createSetThinkingLevelTool(() => threadSessionRef!));

    const { session } = await createAgentSession({
      cwd: params.cwd,
      sessionManager: piSessionManager,
      tools: createCodingTools(params.cwd),
      customTools: [filePickerTool, shareFileTool, ...botTools],
      resourceLoader,
    });

    // Bind extensions with a minimal UI context so session_start fires.
    // This is required for extensions that load state in session_start.
    const uiContext = createNoopUiContext({
      notify: (message: string, type?: "info" | "warning" | "error") => {
        log.info("Extension notification", { type: type ?? "info", message, threadTs: params.threadTs });
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
    } else {
      log.error("Model not found", { provider: params.config.provider, model: params.config.model, availableProviders: [...new Set(allModels.map(m => m.provider))] });
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
    // Wire up the lazy ref so bot tools can access the ThreadSession
    threadSessionRef = ts;
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
   * including those triggered asynchronously by extensions.
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

        // A new agent turn is starting — create streaming state.
        // Store the promise so agent_end can await it if the API fails
        // before begin() resolves (race condition with fast errors).
        const beginPromise = this._updater.begin(this.channelId, this.threadTs);
        this._beginPromise = beginPromise;
        beginPromise.then((state) => {
          this._activeStreamState = state;
          flushPending();
        }).catch((err) => {
          log.error("Failed to begin streaming", { threadTs: this.threadTs, error: err });
        });
        return;
      }

      if (event.type === "agent_end") {
        // Agent turn finished — finalize the stream and resolve the turn promise.
        // If begin() hasn't resolved yet (fast API error), await it first.
        const doFinalize = async () => {
          let state = this._activeStreamState;
          if (!state && this._beginPromise) {
            try {
              state = await this._beginPromise;
            } catch {
              // begin() itself failed — nothing to finalize
            }
          }
          this._activeStreamState = null;
          this._beginPromise = null;
          stateReady = false;
          pendingEvents = [];

          // Check if the agent turn ended with an API error (e.g. expired credentials).
          // The last assistant message will have stopReason: "error" with an errorMessage.
          const messages = "messages" in event ? event.messages : [];
          const lastMsg = messages[messages.length - 1];
          const apiError = lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "error"
            ? ("errorMessage" in lastMsg ? (lastMsg.errorMessage as string) : "Unknown API error")
            : null;

          if (state) {
            if (apiError && !state.rawMarkdown.trim() && isExpiredTokenError(apiError)) {
              // Expired AWS credentials — try to auto-refresh and retry (once only)
              log.info("Detected expired token, attempting credential refresh", { threadTs: this.threadTs, retryCount: this._credRetryCount });
              await this._updater.finalize(state);
              if (this._credRetryCount >= ThreadSession.MAX_CRED_RETRIES) {
                log.warn("Max credential retries reached, not retrying", { threadTs: this.threadTs });
                await this._postToThread("❌ AWS credentials still expired after retry. Run: `ada credentials update --profile " + (process.env.AWS_PROFILE ?? "claude") + " --once`");
              } else {
                const refreshed = await refreshAwsCredentials();
                if (refreshed && this._lastUserPrompt) {
                  await this._postToThread("🔄 Credentials refreshed, retrying...");
                  this._pendingCredRetry = true;
                  this._credRetryCount++;
                } else if (!refreshed) {
                  await this._postToThread("❌ AWS credentials expired and auto-refresh failed. Run: `ada credentials update --profile " + (process.env.AWS_PROFILE ?? "claude") + " --once`");
                }
              }
            } else if (apiError && !state.rawMarkdown.trim()) {
              // API failed before producing any content — show the error
              await this._updater.error(state, new Error(apiError));
            } else {
              await this._updater.finalize(state);
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
            }
          } else {
            // No streaming state — still check context
            this._checkContextWarning();
          }
          // Resolve the turn-complete promise so prompt() can return
          if (this._turnCompleteResolve) {
            this._turnCompleteResolve();
            this._turnCompleteResolve = null;
            this._turnCompletePromise = null;
          }
        };

        const toolRecords = [...this._turnToolRecords];
        const baseRef = this._turnBaseRef;
        doFinalize().catch((err) => {
          log.error("Failed to finalize streaming", { threadTs: this.threadTs, error: err });
          // Still resolve the turn promise so prompt() doesn't hang
          if (this._turnCompleteResolve) {
            this._turnCompleteResolve();
            this._turnCompleteResolve = null;
            this._turnCompletePromise = null;
          }
        });
        return;
      }

      // Auto-compaction events
      if (event.type === "compaction_start" && event.reason !== "manual") {
        this._postToThread("🗜️ Auto-compacting conversation...").catch((err) => {
          log.error("Failed to post auto-compaction start", { threadTs: this.threadTs, error: err });
        });
        return;
      }

      if (event.type === "compaction_end" && event.reason !== "manual") {
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
    // Reset credential retry counter on fresh user messages (not retries)
    if (!this._pendingCredRetry) {
      this._credRetryCount = 0;
    }

    // Track last user prompt for retry via reaction
    this._lastUserPrompt = text;

    // Rewrite !command → /command for pi extension commands & prompt templates.
    // Bot-level commands (help, model, etc.) are intercepted before reaching here,
    // so only pi commands (pdd, review, etc.) arrive at this point.
    const piText = text.replace(/^!/, "/");

    // Create a turn-complete promise that will be resolved by the persistent subscriber
    // when agent_end fires. This ensures we wait for the full agent turn.
    this._turnCompletePromise = new Promise<void>((resolve) => {
      this._turnCompleteResolve = resolve;
    });

    try {
      await this._agentSession.prompt(piText, {
        images: options?.images,
      });
      // For extension commands that are "handled" immediately,
      // prompt() returns before the agent turn starts. Wait for the first turn to
      // complete, but don't block forever if no turn was started (pure commands).
      if (this._turnCompletePromise !== null) {
        await Promise.race([
          this._turnCompletePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
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
          void this._turnCompletePromise.then(resolve);
        });
      }
    } catch (err) {
      // If this is an expired token error, try to auto-refresh and retry (once only)
      if (isExpiredTokenError(err) && !this._pendingCredRetry && this._credRetryCount < ThreadSession.MAX_CRED_RETRIES) {
        log.info("Detected expired token in prompt catch, attempting credential refresh", { threadTs: this.threadTs, retryCount: this._credRetryCount });
        // Clean up any active stream state
        if (this._activeStreamState) {
          await this._updater.finalize(this._activeStreamState);
          this._activeStreamState = null;
          this._beginPromise = null;
        }
        const refreshed = await refreshAwsCredentials();
        if (refreshed && this._lastUserPrompt) {
          await this._postToThread("🔄 Credentials refreshed, retrying...");
          this._pendingCredRetry = true;
          this._credRetryCount++;
          // Fall through to the retry check below
          if (this._turnCompleteResolve) {
            this._turnCompleteResolve();
            this._turnCompleteResolve = null;
            this._turnCompletePromise = null;
          }
          // Retry handled after the catch block
          return this.prompt(this._lastUserPrompt, options).finally(() => {
            this._pendingCredRetry = false;
          });
        }
      }

      // If we have an active stream state, show the error there.
      // If begin() hasn't resolved yet (fast API error), await it first.
      let state = this._activeStreamState;
      if (!state && this._beginPromise) {
        try {
          state = await this._beginPromise;
        } catch {
          // begin() itself failed
        }
      }
      if (state) {
        this._activeStreamState = null;
        this._beginPromise = null;
        await this._updater.error(state, err instanceof Error ? err : new Error(String(err)));
      } else {
        log.error("prompt() failed with no active stream", { threadTs: this.threadTs, error: err instanceof Error ? { message: err.message, stack: err.stack } : err });
        await this._postToThread(`❌ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
      // Clean up turn promise
      if (this._turnCompleteResolve) {
        this._turnCompleteResolve();
        this._turnCompleteResolve = null;
        this._turnCompletePromise = null;
      }
    }

    // If credentials were auto-refreshed during this turn, retry the prompt once.
    if (this._pendingCredRetry && this._lastUserPrompt) {
      this._pendingCredRetry = false;
      log.info("Retrying prompt after credential refresh", { threadTs: this.threadTs });
      return this.prompt(this._lastUserPrompt, options);
    }
  }

  abort(): void {
    void this._agentSession.abort();
    // Resolve any pending turn promise so prompt() unblocks
    if (this._turnCompleteResolve) {
      this._turnCompleteResolve();
      this._turnCompleteResolve = null;
      this._turnCompletePromise = null;
    }
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
    await this._agentSession.compact("Start fresh. Summarize the conversation so far briefly.");
    this._lastContextWarningThreshold = 0;
  }

  async reload(): Promise<void> {
    // Full reload: re-discovers packages, extensions, skills, and prompts from
    // settings.json and disk. Uses AgentSession.reload() which tears down the
    // old extension runner, re-creates it with newly discovered extensions,
    // and emits session_shutdown → session_start lifecycle events.
    // Note: project-local .pi/ discovery is bound to the cwd set at session
    // creation. Use !new after !cwd to pick up a different project's .pi/.
    await this._agentSession.reload();
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
    if (usage?.percent === null || usage?.percent === undefined) return;

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

  get modelRegistry(): AgentSession["modelRegistry"] {
    return this._agentSession.modelRegistry;
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
