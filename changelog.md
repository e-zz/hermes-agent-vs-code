# Changelog

## 0.2.53 - 2026-09-16

### Session continuity

- Added a standalone Node.js background host so active Auto-mode tasks can continue after VS Code closes.
- Restored structured Thinking, Actions, and final responses when the same workspace is reopened.
- Added theme-aware History indicators for running sessions and completed sessions that have not yet been viewed.
- Cleared the completed indicator only after the user explicitly opens the finished session.
- Documented the standalone Node.js requirement and the operating-system shutdown boundary for background sessions.

### Workspace and session experience

- Restored the last session associated with a workspace, including the Editor Session and Agent workspace layout.
- Preserved the existing session rename interaction while removing the visible `Edited` label.
- Improved scrolling stability while structured Thinking and task output stream into an active session.

### Model and reasoning controls

- Added per-model reasoning-effort support and a compact `Mode + Model + Effort` summary below the composer.
- Added concise effort labels, including `Med` for Medium and `XHigh` for Extra High.
- Simplified model labels by removing redundant provider prefixes from the picker and summary.
- Applied the extension-wide last selected model and effort to newly created sessions.
- Preserved the complete runtime model list across refreshes and new sessions, preventing usable models from being incorrectly shown as unavailable.
- Made Model and Effort option lists consistently open above their controls.
