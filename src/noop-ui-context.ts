/**
 * Noop UI context for extension binding in headless (Slack bot) mode.
 *
 * Provides a complete ExtensionUIContext implementation where all methods
 * are safe no-ops. Use `overrides` to customize specific methods (e.g., notify).
 *
 * Uses a Proxy to future-proof against new SDK methods — any method not
 * explicitly defined returns a no-op function, preventing runtime crashes
 * when the pi SDK adds new ExtensionUIContext members.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** A plain-text theme that passes strings through unchanged. */
const NOOP_THEME = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
  strikethrough: (t: string) => t,
};

/**
 * Create an ExtensionUIContext where all methods are safe no-ops.
 * Override individual methods via the `overrides` parameter.
 */
export function createNoopUiContext(
  overrides?: Partial<ExtensionUIContext>,
): ExtensionUIContext {
  const base: Record<string, unknown> = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    setEditorComponent: () => {},
    theme: NOOP_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Not supported in headless mode" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  // Apply overrides
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        base[key] = value;
      }
    }
  }

  // Use a Proxy to handle any future SDK methods we haven't listed.
  // Unknown property access returns a no-op function instead of undefined.
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      // Return a no-op function for any unknown method
      return () => {};
    },
  }) as unknown as ExtensionUIContext;
}
