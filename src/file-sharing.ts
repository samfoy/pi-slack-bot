/**
 * File sharing between Slack and the agent.
 *
 * Inbound:  When a user uploads/shares files in a thread, download them
 *           into the session's cwd and surface them to the agent.
 *
 * Outbound: A `share_file` tool lets the agent upload workspace files
 *           to the Slack thread (code, images, logs, etc.).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { Type, type Static } from "@sinclair/typebox";
import type { WebClient } from "@slack/web-api";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { createLogger } from "./logger.js";

const log = createLogger("file-sharing");

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Directory within session cwd where inbound files are saved. */
export const INBOUND_DIR = ".slack-files";

/** Max file size we'll download from Slack (10 MB). */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Max file size we'll upload to Slack (10 MB). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Max image size for vision (5 MB before base64 encoding). */
export const MAX_VISION_BYTES = 5 * 1024 * 1024;

/** Max number of images to send as vision content per message. */
export const MAX_IMAGES_PER_MESSAGE = 10;

/** Mimetypes we'll send as vision content. */
export const IMAGE_MIMETYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Check if a mimetype is a supported image for vision. */
export function isImageFile(mimetype?: string): boolean {
  return mimetype != null && IMAGE_MIMETYPES.has(mimetype);
}

/* ------------------------------------------------------------------ */
/*  Inbound: Download files shared by the user in Slack                */
/* ------------------------------------------------------------------ */

export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  size: number;
  urlPrivateDownload?: string;
  urlPrivate?: string;
}

export interface DownloadedFile {
  originalName: string;
  localPath: string;
  size: number;
  mimetype?: string;
}

/**
 * Download files from a Slack message into the session's working directory.
 *
 * Returns an array of downloaded file info. Skips files that are too large
 * or that fail to download (logs warnings but doesn't throw).
 */
export async function downloadSlackFiles(
  files: SlackFile[],
  cwd: string,
  botToken: string,
): Promise<DownloadedFile[]> {
  const destDir = join(cwd, INBOUND_DIR);
  mkdirSync(destDir, { recursive: true });

  const results: DownloadedFile[] = [];

  for (const file of files) {
    if (file.size > MAX_DOWNLOAD_BYTES) {
      log.warn("Skipping file: exceeds size limit", { fileName: file.name, size: file.size });
      continue;
    }

    const url = file.urlPrivateDownload ?? file.urlPrivate;
    if (!url) {
      log.warn("Skipping file: no download URL", { fileName: file.name });
      continue;
    }

    try {
      const localPath = uniquePath(destDir, file.name);
      await downloadFile(url, localPath, botToken);
      results.push({
        originalName: file.name,
        localPath,
        size: file.size,
        mimetype: file.mimetype,
      });
    } catch (err) {
      log.error("Failed to download file", { fileName: file.name, error: err });
    }
  }

  return results;
}

/**
 * Build a user-facing message describing downloaded files,
 * suitable for prepending to the user's text prompt.
 */
export function formatInboundFileContext(downloaded: DownloadedFile[]): string {
  if (downloaded.length === 0) return "";

  const lines = ["The user shared the following files (saved to your cwd):"];
  for (const f of downloaded) {
    lines.push(`- \`${f.localPath}\` (${formatBytes(f.size)}) — originally "${f.originalName}"`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Inbound: Enrich prompt with files + vision images                  */
/* ------------------------------------------------------------------ */

/** Result of enriching a prompt with uploaded files. */
export interface EnrichedPrompt {
  /** The text prompt (with file context prepended if files were shared). */
  text: string;
  /** Base64-encoded images extracted from uploaded image files for vision. */
  images: ImageContent[];
}

/**
 * Download files from a Slack message, build text context, and extract
 * images for vision. Images under the size limit are base64-encoded
 * and returned alongside the text prompt.
 */
export async function enrichPromptWithFiles(
  files: SlackFile[],
  text: string,
  cwd: string,
  botToken: string,
): Promise<EnrichedPrompt> {
  if (files.length === 0) return { text, images: [] };

  const downloaded = await downloadSlackFiles(files, cwd, botToken);
  const context = formatInboundFileContext(downloaded);
  const enrichedText = context
    ? (text ? `${context}\n\n${text}` : context)
    : text;

  // Extract images for vision
  const images: ImageContent[] = [];
  for (const file of downloaded) {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      log.info("Image cap reached, skipping remaining images", {
        cap: MAX_IMAGES_PER_MESSAGE,
        remaining: downloaded.length - images.length,
      });
      break;
    }

    if (!isImageFile(file.mimetype)) continue;

    if (file.size > MAX_VISION_BYTES) {
      log.info("Image too large for vision, skipping", {
        fileName: file.originalName,
        size: file.size,
        limit: MAX_VISION_BYTES,
      });
      continue;
    }

    try {
      const data = readFileSync(file.localPath);
      images.push({
        type: "image",
        data: data.toString("base64"),
        mimeType: file.mimetype!,
      });
      log.info("Image extracted for vision", {
        fileName: file.originalName,
        mimeType: file.mimetype,
        size: file.size,
      });
    } catch (err) {
      log.error("Failed to read image for vision", { fileName: file.originalName, error: err });
    }
  }

  return { text: enrichedText, images };
}

/* ------------------------------------------------------------------ */
/*  Outbound: share_file tool                                          */
/* ------------------------------------------------------------------ */

const ShareFileParams = Type.Object({
  path: Type.String({
    description:
      "Path to the file to share (absolute or relative to cwd). " +
      "The file will be uploaded to the current Slack thread.",
  }),
  comment: Type.Optional(
    Type.String({
      description:
        "Optional comment to post alongside the file. " +
        "Use this to explain what the file is or highlight important parts.",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Optional title for the uploaded file. Defaults to the filename.",
    }),
  ),
});

type ShareFileInput = Static<typeof ShareFileParams>;

export interface ShareFileContext {
  client: WebClient;
  channelId: string;
  threadTs: string;
}

/**
 * Create a share_file ToolDefinition bound to a Slack context.
 */
export function createShareFileTool(
  cwd: string,
  getContext: () => ShareFileContext,
): ToolDefinition {
  return {
    name: "share_file",
    label: "Share File",
    description:
      "Upload a file from the workspace to the Slack thread. " +
      "Use this to share code files, images, logs, diffs, or any artifact " +
      "with the user. The file appears as a Slack file attachment that can " +
      "be previewed inline. Prefer this over pasting large file contents " +
      "into your response text.",
    promptSnippet:
      "Upload a workspace file to the Slack thread. " +
      "Good for sharing code, images, diffs, logs. " +
      "Use instead of pasting large content inline.",
    parameters: ShareFileParams,
    async execute(_toolCallId, params: ShareFileInput) {
      const ctx = getContext();
      const filePath = resolve(cwd, params.path);

      // Prevent path traversal outside the workspace
      if (!filePath.startsWith(cwd + "/") && filePath !== cwd) {
        return {
          content: [{ type: "text", text: `Error: Path is outside the workspace: ${filePath}` }],
        };
      }

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
        };
      }

      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return {
          content: [{ type: "text", text: `Error: Not a regular file: ${filePath}` }],
        };
      }

      if (stat.size > MAX_UPLOAD_BYTES) {
        return {
          content: [{
            type: "text",
            text: `Error: File too large (${formatBytes(stat.size)}). Max is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
          }],
        };
      }

      const filename = basename(filePath);
      const title = params.title ?? filename;

      try {
        const content = readFileSync(filePath);

        await ctx.client.files.uploadV2({
          channel_id: ctx.channelId,
          thread_ts: ctx.threadTs,
          file: content,
          filename,
          title,
          initial_comment: params.comment,
        });

        return {
          content: [{ type: "text", text: `Shared \`${filename}\` (${formatBytes(stat.size)}) in the Slack thread.` }],
          details: { path: filePath, size: stat.size },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error uploading file: ${msg}` }],
        };
      }
    },
  } as ToolDefinition;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function downloadFile(url: string, destPath: string, botToken: string): Promise<void> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  const ws = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body as any), ws);
}

/**
 * Generate a unique path if the file already exists.
 * foo.ts → foo.ts, foo-1.ts, foo-2.ts, etc.
 */
function uniquePath(dir: string, name: string): string {
  const base = join(dir, name);
  if (!existsSync(base)) return base;

  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let counter = 1;
  let candidate: string;
  do {
    candidate = join(dir, `${stem}-${counter}${ext}`);
    counter++;
  } while (existsSync(candidate));

  return candidate;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
