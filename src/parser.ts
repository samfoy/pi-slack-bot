import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { resolve, basename, join } from "path";

export interface ParseResult {
  cwd: string | null;
  cwdToken: string | null;
  prompt: string;
  candidates: string[];
}

export interface Project {
  path: string;
  label: string;
}

/**
 * projects.json schema:
 * {
 *   "scanDirs": ["~/projects"],        // dirs to scan one level deep (like WORKSPACE_DIRS)
 *   "pin": ["~/scratch/pi-slack-bot"],  // always included, even if not under scanDirs
 *   "exclude": ["CR-*"],               // glob-style basename patterns to hide
 *   "labels": { "Rosie": "🌹 Rosie", "R2": "🤖 R2" }  // friendly button labels
 * }
 */
interface ProjectsConfig {
  scanDirs?: string[];
  pin?: string[];
  exclude?: string[];
  labels?: Record<string, string>;
}

/**
 * Parse raw message text into cwd + prompt.
 * Rules:
 * 1. Take first whitespace-delimited token, expand ~
 * 2. fs.existsSync + isDirectory → resolved cwd, rest is prompt
 * 3. Else → fuzzyMatch(token, knownProjects)
 * 4. Matches → cwd=null, candidates=matches, prompt=full text
 * 5. No matches → cwd=null, candidates=[], prompt=full text
 */
export function parseMessage(text: string, knownProjects: string[]): ParseResult {
  const parts = text.trim().split(/\s+/);
  const token = parts[0] ?? "";
  const rest = parts.slice(1).join(" ");

  if (!token) {
    return { cwd: null, cwdToken: null, prompt: text, candidates: [] };
  }

  const expanded = expandHome(token);

  try {
    if (existsSync(expanded) && statSync(expanded).isDirectory()) {
      return {
        cwd: resolve(expanded),
        cwdToken: token,
        prompt: rest,
        candidates: [],
      };
    }
  } catch {
    // ignore stat errors
  }

  const candidates = fuzzyMatch(token, knownProjects);
  return {
    cwd: null,
    cwdToken: token,
    prompt: text,
    candidates,
  };
}

/**
 * Fuzzy match token against project basenames and last two path segments.
 * Case-insensitive, returns up to 5 results.
 */
export function fuzzyMatch(token: string, projects: string[]): string[] {
  const lower = token.toLowerCase();
  const results: string[] = [];

  for (const p of projects) {
    const base = basename(p).toLowerCase();
    const parts = p.split("/").filter(Boolean);
    const lastTwo = parts.slice(-2).join("/").toLowerCase();

    if (base.includes(lower) || lastTwo.includes(lower)) {
      results.push(p);
      if (results.length >= 5) break;
    }
  }

  return results;
}

const DEFAULT_CONFIG_PATH = "~/.pi-slack-bot/projects.json";

/**
 * Load project list. Re-reads config file on every call so edits take effect immediately.
 * Falls back to scanning workspaceDirs if no config file exists.
 */
export function loadProjects(workspaceDirs: string[], configPath = DEFAULT_CONFIG_PATH): Project[] {
  const expandedConfigPath = expandHome(configPath);
  let config: ProjectsConfig = {};

  try {
    if (existsSync(expandedConfigPath)) {
      config = JSON.parse(readFileSync(expandedConfigPath, "utf-8"));
    }
  } catch (err) {
    console.error(`[projects] Failed to read ${expandedConfigPath}:`, err);
  }

  const scanDirs = config.scanDirs?.map(expandHome) ?? workspaceDirs;
  const pinned = (config.pin ?? []).map(expandHome);
  const excludePatterns = config.exclude ?? [];
  const labels = config.labels ?? {};

  // Scan directories one level deep
  const scanned = scanDirectories(scanDirs);

  // Merge pinned paths (deduplicate)
  const seen = new Set(scanned);
  for (const p of pinned) {
    const resolved = resolve(p);
    if (!seen.has(resolved) && existsSync(resolved)) {
      scanned.push(resolved);
      seen.add(resolved);
    }
  }

  // Apply excludes
  const filtered = scanned.filter((p) => {
    const base = basename(p);
    return !excludePatterns.some((pattern) => globMatch(pattern, base));
  });

  // Sort alphabetically by label
  return filtered
    .map((p) => ({ path: p, label: labels[basename(p)] ?? basename(p) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Extract just the paths (for fuzzyMatch and parseMessage compatibility). */
export function projectPaths(projects: Project[]): string[] {
  return projects.map((p) => p.path);
}

function scanDirectories(dirs: string[]): string[] {
  const projects: string[] = [];
  for (const dir of dirs) {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) projects.push(full);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return projects;
}

/** Simple glob matching: supports * and ? */
function globMatch(pattern: string, text: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i",
  );
  return regex.test(text);
}

/** @deprecated Use loadProjects() instead. Kept for backward compatibility / tests. */
export function scanProjects(workspaceDirs: string[]): string[] {
  return scanDirectories(workspaceDirs.map(expandHome));
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}
