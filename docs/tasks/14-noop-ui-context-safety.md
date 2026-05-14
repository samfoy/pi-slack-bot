# Harden noopUiContext Against SDK Changes

## Priority: Low (Code Quality)

## Problem
The `noopUiContext` in `thread-session.ts` is a hand-crafted object with `as any` cast. When pi updates `ExtensionUIContext` with new required methods, this silently breaks at runtime.

## Current Behavior
- ~40 lines of manual no-op method stubs
- Cast with `as any` bypasses type checking
- Ralph notification detection is mixed in with UI context creation
- New SDK methods silently become `undefined`, causing runtime crashes in extensions

## Proposed Solution
1. Check if pi SDK exports a `createNoopUiContext()` helper — if so, use it
2. If not, create a typed wrapper:
   ```ts
   import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
   
   function createSlackUiContext(overrides: Partial<ExtensionUIContext>): ExtensionUIContext {
     const base: ExtensionUIContext = { /* all methods as no-ops */ };
     return { ...base, ...overrides };
   }
   ```
3. Move the Ralph notification logic out of `notify` into a separate `RalphNotificationHandler`
4. Use `satisfies ExtensionUIContext` instead of `as any` to get compile-time safety
5. Add a test that verifies all required methods exist

## Files to Change
- `src/thread-session.ts` — extract and type the UI context
- `src/noop-ui-context.ts` — new module (optional, could be inline)
- `src/thread-session.test.ts` — add interface conformance test

## Risks
- The SDK type may include methods that genuinely need implementation for Slack
- `satisfies` check requires knowing the full interface shape
