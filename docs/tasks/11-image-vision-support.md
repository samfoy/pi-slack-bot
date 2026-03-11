# Image/Vision Support for Uploaded Files

## Priority: Medium (upgraded — straightforward with good UX payoff)

## Problem
When users upload images to a thread, they're saved to disk as files. Vision-capable models (Claude) could analyze them directly, but the bot doesn't pass images as vision inputs — it just tells the agent "a file was saved."

## Current Behavior
- `file-sharing.ts` downloads all uploaded files to `.slack-files/` in the cwd
- `enrichPromptWithFiles()` in `slack.ts` prepends text context about the files
- Images are described by filename/mimetype but **not sent as vision content**
- The agent can use the `read` tool to view images from disk, but only if it thinks to

## SDK Support (researched)

Pi's `AgentSession.prompt()` already supports images:

```typescript
interface PromptOptions {
  images?: ImageContent[];  // ← this is what we need
  expandPromptTemplates?: boolean;
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
}

interface ImageContent {
  type: "image";
  data: string;        // base64-encoded image data
  mimeType: string;    // e.g. "image/png", "image/jpeg"
}
```

Usage: `session.prompt(text, { images: [{ type: "image", data: base64, mimeType: "image/png" }] })`

## Proposed Solution

### 1. Image detection in `file-sharing.ts`

Add a constant for supported image mimetypes and a helper to check:

```typescript
const IMAGE_MIMETYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

export function isImageFile(mimetype?: string): boolean {
  return mimetype != null && IMAGE_MIMETYPES.has(mimetype);
}
```

### 2. Extend `enrichPromptWithFiles` to return images separately

Currently returns `string`. Change to return `{ text: string, images: ImageContent[] }`:

```typescript
export interface EnrichedPrompt {
  text: string;
  images: ImageContent[];
}

export async function enrichPromptWithFiles(
  files: SlackFile[],
  text: string,
  cwd: string,
  botToken: string,
): Promise<EnrichedPrompt>
```

For each downloaded file:
- If it's an image AND under the size limit (5MB for vision — base64 bloats it):
  - Read the file, base64-encode it
  - Add to `images` array with proper mimeType
  - Still mention it in the text context so the agent knows about it
- Non-image files: same behavior as today (text context only)

### 3. Thread `images` through to `prompt()`

**`src/thread-session.ts`**: Extend `prompt()` signature:
```typescript
async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>
```

Pass `images` to `this._agentSession.prompt(piText, { images })`.

**`src/slack.ts`**: Update all `enrichPromptWithFiles` call sites to destructure and pass images.

### 4. Size limit for vision

- Max 5MB per image (base64 of 5MB ≈ 6.7MB in the prompt)
- Max 10 images per message
- Images over the limit are still saved to disk (current behavior) but not sent as vision
- Log when images are skipped due to size

## Files to Change
- `src/file-sharing.ts` — `isImageFile()`, modify download+context to extract images, export `EnrichedPrompt`
- `src/file-sharing.test.ts` — test image detection, base64 encoding, size limits
- `src/slack.ts` — update `enrichPromptWithFiles` call sites to pass images
- `src/thread-session.ts` — accept `images` option in `prompt()`, pass through to AgentSession
- `src/thread-session.test.ts` — test images passed through

## Risks & Mitigations
- **Large images consume context tokens**: Mitigated by 5MB limit. Claude handles images efficiently via its vision model — they don't bloat the text context proportionally.
- **Base64 memory pressure**: Reading + encoding happens per-request, garbage collected after. Not a concern at bot scale.
- **Not all models support vision**: Claude 3+ all support it. If a non-vision model is configured, the API will error — but that's a user config issue, not a code issue.

## Effort
Small-medium. The SDK already supports images — we're just wiring the plumbing from Slack downloads through to the prompt call.
