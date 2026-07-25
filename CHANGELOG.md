# Changelog

## 0.1.1

Policy parity with the other agents. The gate matched rules on tool NAME alone, so
every argument rule was invisible here: a `Bash(rm:*)` deny you had written did
nothing, and `rm -rf` was auto-approved by a broad `Bash` allow. Cursor was
strictly less safe than Claude Code for the same dashboard policy.

- Argument rules now match: `Bash(git status)` exact, `Bash(npm test:*)` prefix,
  and path-style globs, with the same precedence the hook uses.
- The destructive ceiling applies: a command the classifier flags can no longer
  auto-approve through a general bare-tool or wildcard rule. An explicit rule you
  wrote still wins.
- Repo-scoped rules are honoured. Identity is the normalized git remote, read from
  `.git/config` as a file; credentials are stripped. `PUSHARY_REPO_KEY` pins it,
  `PUSHARY_REPO_KEY=off` disables scoping.
- Approvals now carry the command target and body, so the server can drop the
  one-tap Approve on a dangerous call and the audit trail records Cursor
  decisions at the same grain as every other agent.
- `scripts/pushary-gate.test.mjs` mirrors the monorepo's policy tests, since the
  matcher is vendored and cannot be imported.

Verified against the canonical matcher over 1512 resolutions: zero cases where
the gate is less safe. The remaining differences are all the safe-read-only
allowlist, which is deliberately not vendored because it only ever loosens a
decision.

## 0.1.0

Initial release.

- MCP server (`send_notification`, `ask_user`, `wait_for_answer`, `cancel_question`, `list_sessions`) wired via `mcp.json`, key supplied at runtime through `PUSHARY_API_KEY`.
- Always-on rule and full tool-reference skill so the agent uses Pushary proactively.
- `beforeShellExecution` gate (`scripts/pushary-gate.mjs`, zero-dependency) that evaluates risky commands against your Pushary dashboard policy — auto-approve, the four approval modes, timeout actions, live mode override, and kill switch, scoped to the Cursor conversation. Falls back to Cursor's own prompt when Pushary is unreachable, and is fail-closed: a broken gate blocks rather than allows.
- Commands: `/pushary-test`, `/notify-when-done`.
