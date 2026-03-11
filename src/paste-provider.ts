/**
 * Paste providers — abstraction for uploading diffs to paste services.
 *
 * Decouples diff-reviewer.ts from any specific paste service.
 * Configure via PASTE_PROVIDER env var: "amazon", "gist", "none" (default).
 */
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { createLogger } from "./logger.js";

const log = createLogger("paste-provider");

export interface PasteResult {
  /** The paste URL */
  url: string;
}

/**
 * Interface for paste service providers.
 * Implementations upload content and return a URL, or null on failure.
 */
export interface PasteProvider {
  create(content: string, title: string, language?: string): Promise<PasteResult | null>;
}

/**
 * Null provider — always returns null, falling back to Slack file upload.
 */
export class NullPasteProvider implements PasteProvider {
  async create(_content: string, _title: string, _language?: string): Promise<PasteResult | null> {
    return null;
  }
}

/**
 * Amazon paste.amazon.com provider.
 * Uses Midway cookie auth (must have valid midway session).
 */
export class AmazonPasteProvider implements PasteProvider {
  async create(content: string, title: string, language = "diff"): Promise<PasteResult | null> {
    const cookieFile = `${process.env.HOME}/.midway/cookie`;

    try {
      // Step 1: GET the page to obtain a CSRF authenticity token
      const pageHtml = execSync(
        `curl -s --anyauth --location-trusted --negotiate -u : ` +
        `--cookie "${cookieFile}" --cookie-jar "${cookieFile}" ` +
        `"https://paste.amazon.com/"`,
        { encoding: "utf-8", timeout: 15000 },
      );

      const tokenMatch = pageHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
      if (!tokenMatch) {
        log.error("Could not extract CSRF token from paste.amazon.com");
        return null;
      }
      const token = tokenMatch[1];

      // Step 2: POST the paste content via temp file to avoid shell escaping issues.
      const tmpFile = `/tmp/pi-diff-paste-${Date.now()}.txt`;
      writeFileSync(tmpFile, content, "utf-8");

      try {
        const headers = execSync(
          `curl -s --anyauth --location-trusted --negotiate -u : ` +
          `--cookie "${cookieFile}" --cookie-jar "${cookieFile}" ` +
          `-X POST "https://paste.amazon.com/create" ` +
          `--data-urlencode "authenticity_token=${token}" ` +
          `--data-urlencode "text@${tmpFile}" ` +
          `--data-urlencode "language=${language}" ` +
          `--data-urlencode "title=${title}" ` +
          `--data-urlencode "numbers=1" ` +
          `-D - -o /dev/null`,
          { encoding: "utf-8", timeout: 30000 },
        );

        const locationMatch = headers.match(/^location:\s*(.+)$/mi);
        if (!locationMatch) {
          log.error("No redirect location from paste.amazon.com create");
          return null;
        }

        return { url: locationMatch[1].trim() };
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    } catch (err) {
      log.error("Failed to create paste", { provider: "amazon", error: err });
      return null;
    }
  }
}

/**
 * GitHub Gist provider.
 * Creates secret gists via the GitHub API. Requires GITHUB_TOKEN.
 */
export class GistPasteProvider implements PasteProvider {
  private _token: string;

  constructor(token?: string) {
    this._token = token ?? process.env.GITHUB_TOKEN ?? "";
  }

  async create(content: string, title: string, language = "diff"): Promise<PasteResult | null> {
    if (!this._token) {
      log.error("No GITHUB_TOKEN configured", { provider: "gist" });
      return null;
    }

    const ext = language === "diff" ? ".diff" : `.${language}`;
    const filename = `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}${ext}`;

    const payload = JSON.stringify({
      description: title,
      public: false,
      files: {
        [filename]: { content },
      },
    });

    try {
      const response = execSync(
        `curl -s -X POST "https://api.github.com/gists" ` +
        `-H "Authorization: token ${this._token}" ` +
        `-H "Accept: application/vnd.github.v3+json" ` +
        `-H "Content-Type: application/json" ` +
        `--data-binary @-`,
        {
          encoding: "utf-8",
          timeout: 30000,
          input: payload,
        },
      );

      const data = JSON.parse(response);
      if (data.html_url) {
        return { url: data.html_url };
      }

      log.error("No html_url in gist response", { provider: "gist", apiMessage: data.message ?? "unknown error" });
      return null;
    } catch (err) {
      log.error("Failed to create gist", { provider: "gist", error: err });
      return null;
    }
  }
}

export type PasteProviderType = "amazon" | "gist" | "none";

const VALID_PASTE_PROVIDERS: PasteProviderType[] = ["amazon", "gist", "none"];

/**
 * Parse a paste provider type string.
 */
export function parsePasteProviderType(val: string): PasteProviderType {
  if (VALID_PASTE_PROVIDERS.includes(val as PasteProviderType)) {
    return val as PasteProviderType;
  }
  throw new Error(`Invalid PASTE_PROVIDER: ${val}. Must be one of: ${VALID_PASTE_PROVIDERS.join(", ")}`);
}

/**
 * Create a PasteProvider instance from a type string.
 */
export function createPasteProvider(type: PasteProviderType): PasteProvider {
  switch (type) {
    case "amazon": return new AmazonPasteProvider();
    case "gist": return new GistPasteProvider();
    case "none": return new NullPasteProvider();
  }
}
