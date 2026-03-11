/**
 * Session registry — persists active session mappings to disk so the bot
 * can auto-restore them on restart.
 *
 * Stores `active-sessions.json` in the session directory with an atomic
 * write strategy (write to .tmp, rename) to prevent corruption.
 */
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("session-registry");

export interface SessionEntry {
  threadTs: string;
  channelId: string;
  cwd: string;
  sessionPath: string;
}

interface RegistryFile {
  sessions: SessionEntry[];
}

const REGISTRY_FILENAME = "active-sessions.json";

export class SessionRegistry {
  private _dir: string;
  private _filePath: string;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingEntries: SessionEntry[] | null = null;
  private _debounceMs: number;

  constructor(sessionDir: string, debounceMs = 1000) {
    this._dir = sessionDir;
    this._filePath = path.join(sessionDir, REGISTRY_FILENAME);
    this._debounceMs = debounceMs;
  }

  /** The path to the registry file. */
  get filePath(): string {
    return this._filePath;
  }

  /**
   * Load session entries from disk.
   * Filters out entries whose session files no longer exist.
   * Returns an empty array on missing file, corrupt JSON, or I/O errors.
   */
  async load(): Promise<SessionEntry[]> {
    try {
      const raw = await fs.readFile(this._filePath, "utf-8");
      const data: RegistryFile = JSON.parse(raw);

      if (!Array.isArray(data?.sessions)) return [];

      // Filter out stale entries where the session file was deleted
      return data.sessions.filter((entry) =>
        typeof entry.threadTs === "string" &&
        typeof entry.channelId === "string" &&
        typeof entry.cwd === "string" &&
        typeof entry.sessionPath === "string" &&
        existsSync(entry.sessionPath),
      );
    } catch {
      // Missing file, corrupt JSON, or I/O error — start fresh
      return [];
    }
  }

  /**
   * Save session entries to disk atomically.
   * Writes to a temp file first, then renames to avoid corruption.
   * Errors are logged but not thrown — persistence is best-effort.
   */
  async save(entries: SessionEntry[]): Promise<void> {
    const data: RegistryFile = { sessions: entries };
    const tmpPath = this._filePath + ".tmp";

    try {
      await fs.mkdir(this._dir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmpPath, this._filePath);
    } catch (err) {
      log.error("Failed to save session registry", { error: err });
      // Clean up temp file on failure
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * Schedule a debounced save. Multiple rapid calls coalesce into one write.
   * The entries passed to the most recent call win.
   */
  scheduleSave(entries: SessionEntry[]): void {
    this._pendingEntries = entries;

    if (this._debounceTimer !== null) return;

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      const toSave = this._pendingEntries;
      this._pendingEntries = null;
      if (toSave) {
        void this.save(toSave);
      }
    }, this._debounceMs);
  }

  /**
   * Flush any pending debounced save immediately.
   * Returns once the save completes. No-op if nothing is pending.
   */
  async flush(): Promise<void> {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._pendingEntries) {
      const toSave = this._pendingEntries;
      this._pendingEntries = null;
      await this.save(toSave);
    }
  }

  /**
   * Cancel any pending debounced save and clean up.
   */
  dispose(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingEntries = null;
  }
}
