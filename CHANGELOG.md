# Changelog

## 0.2.3

- Updates and Terminal hand an approval back to Cursor promptly. The gate no longer waits for a phone answer that Updates never asks for, and it withdraws the phone question before Cursor decides. An answer that arrives in that moment still counts.
- A file change that goes back to the agent's own permissions is refused with the reason, because Cursor file hooks cannot show a local approval. Choose Every time for file changes you want to approve from your phone.
- With no phone or other notification channel connected, a file change is refused with a message that says so. Shell commands and MCP calls still open Cursor's own prompt with "No device connected, approve here."
- Approval questions carry the repository and the tool name the gate judged, so routing and repository rules apply to the question as they did to the gate. A file change is asked about with its full path, so path rules and routing match it. A path longer than 80 characters falls back to the file type instead of making the question fail.

## 0.2.2

- Allow file edits when the server explicitly says the action is not gated.
- Keep unresolved file checks denied with an accurate retry message, while shell/MCP hooks retain the native prompt.

## 0.2.0

The gate stopped carrying its own copy of the policy engine.

Pattern matching, glob compilation, the destructive-command list and policy
resolution all lived in this file, roughly two hundred and fifty lines of it,
kept in step with the real engine by hand. That is how 0.1.1 happened: the copy
matched on tool name alone, so every argument rule was invisible here. It also
never gained the safe read-only allowlist, so `git status` reached your phone
from Cursor and from nowhere else.

The gate now asks the server, which runs the same engine as every other client
over the same policy and mode state. There is nothing left to keep in step.

- The safe read-only allowlist applies here now: ordinary read-only commands
  stop reaching your phone.
- A policy change takes effect immediately. The five-minute on-disk policy cache
  is gone, along with the stale-cache fallback.
- An unreachable Pushary hands the command to Cursor's own prompt, as before.
  Nothing is ever denied because we could not reach the server.

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
