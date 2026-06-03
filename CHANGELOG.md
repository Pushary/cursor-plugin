# Changelog

## 0.1.0

Initial release.

- MCP server (`send_notification`, `ask_user`, `wait_for_answer`, `cancel_question`) wired via `mcp.json`, key supplied at runtime through `PUSHARY_API_KEY`.
- Always-on rule and full tool-reference skill so the agent uses Pushary proactively.
- `beforeShellExecution` gate (`scripts/pushary-gate.mjs`, zero-dependency) that routes risky commands to a phone approval. Falls back to Cursor's own prompt when Pushary is unreachable, and is fail-closed: a broken gate blocks rather than allows.
- Commands: `/pushary-test`, `/notify-when-done`.
