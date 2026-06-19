# Changelog

## 0.1.0

Initial release.

- MCP server (`send_notification`, `ask_user`, `wait_for_answer`, `cancel_question`, `list_sessions`) wired via `mcp.json`, key supplied at runtime through `PUSHARY_API_KEY`.
- Always-on rule and full tool-reference skill so the agent uses Pushary proactively.
- `beforeShellExecution` gate (`scripts/pushary-gate.mjs`, zero-dependency) that evaluates risky commands against your Pushary dashboard policy — auto-approve, the four approval modes, timeout actions, live mode override, and kill switch, scoped to the Cursor conversation. Falls back to Cursor's own prompt when Pushary is unreachable, and is fail-closed: a broken gate blocks rather than allows.
- Commands: `/pushary-test`, `/notify-when-done`.
