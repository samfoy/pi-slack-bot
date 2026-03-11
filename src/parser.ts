import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, basename, join } from "path";
import { expandHome } from "./paths.js";
import { createLogger } from "./logger.js";

const log = createLogger("parser");

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
    log.error("Failed to read config file", { path: expandedConfigPath, error: err });
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
