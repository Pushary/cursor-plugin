<p align="center">
  <img src="assets/logo.png" alt="Pushary" width="72" height="72" />
</p>

<h1 align="center">Pushary — Control Panel for AI Agents</h1>

<p align="center">
  Push notifications, human-in-the-loop questions, and permission gating for your Cursor agent.<br/>
  Get a push when a task finishes, answer the agent from your phone, and approve risky commands before they run.
</p>

---

Pushary is the **awareness and control layer** for your coding agent. Once installed, the
agent can reach you on your phone, ask you for decisions, and route risky commands through
your approval — even when you've stepped away from the editor.

## What it does

- **Notify** — the agent sends a push when a multi-step task finishes or a build/test/deploy
  fails, with the files changed, the error, and suggested next steps.
- **Ask** — the agent asks you `confirm` / `select` / `input` questions via push and waits for
  your answer from the lock screen.
- **Gate** — risky shell commands (`rm`, force-push, history rewrites, DB drops, deploys,
  `systemctl`, …) are intercepted by a `beforeShellExecution` hook and sent to your phone for
  approval **before they run**. Approve → it runs. Deny → it's blocked. If Pushary is
  unreachable it falls back to Cursor's own in-editor prompt, so it never silently runs a risky
  command. The hook is **fail-closed**: if the gate can't run at all, the command is blocked
  rather than allowed unapproved.

## Install

**1. From the Cursor Marketplace** (recommended)

Open the Marketplace panel in Cursor, search **Pushary**, and install. Then set your API key
(below).

**2. With the CLI** (also configures Claude Code, Codex, Hermes)

```bash
npx @pushary/agent-hooks@latest setup
```

**3. Manual MCP**

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "pushary": {
      "type": "http",
      "url": "https://pushary.com/api/mcp/mcp",
      "headers": { "Authorization": "Bearer ${PUSHARY_API_KEY}" }
    }
  }
}
```

> However you install it, Pushary connects to the same MCP server
> (`https://pushary.com/api/mcp/mcp`), so the plugin and the `@pushary/agent-hooks` CLI are
> interchangeable — same backend, same tools.

### Set your API key

The plugin reads your key from the `PUSHARY_API_KEY` environment variable. Get one at
[pushary.com](https://pushary.com/sign-up?from=cursor-marketplace), then add it to your shell
profile:

```bash
echo 'export PUSHARY_API_KEY="pk_xxx.sk_xxx"' >> ~/.zshrc && source ~/.zshrc
```

Install the [Pushary app](https://pushary.com) (or enable web push) on your phone so the agent
can reach you.

## What's in the plugin

| Component | File | Purpose |
|-----------|------|---------|
| MCP server | `mcp.json` | Connects Cursor to the Pushary tools (`send_notification`, `ask_user`, `wait_for_answer`, `cancel_question`) |
| Rule | `rules/pushary.mdc` | Always-on guidance so the agent uses Pushary proactively |
| Skill | `skills/pushary/SKILL.md` | Full tool reference — parameters, examples, return shapes |
| Hook | `hooks/hooks.json` + `scripts/pushary-gate.mjs` | Routes risky commands to a phone approval |
| Commands | `commands/` | `/pushary-test`, `/notify-when-done` |

### Tuning the gate

Which commands get gated is the `matcher` regex in `hooks/hooks.json`. Edit it to widen or
narrow the set — the script makes the final allow/deny/ask decision on whatever the matcher
lets through.

## Commands

- **`/pushary-test`** — send a test push to confirm delivery.
- **`/notify-when-done`** — have the agent push a summary when the current task finishes.

## Development

`skills/pushary/SKILL.md` mirrors the canonical Pushary skill shipped with
[`@pushary/agent-hooks`](https://www.npmjs.com/package/@pushary/agent-hooks); keep the two in step.

Test the plugin locally before publishing:

```bash
ln -s "$(pwd)" ~/.cursor/plugins/local/pushary
# then reload Cursor: Developer: Reload Window
```

## Security

This repository is open source and contains **no secrets** — the MCP key is supplied at
runtime via `PUSHARY_API_KEY`. The gate script has no dependencies and only contacts
`https://pushary.com`. See the source of `scripts/pushary-gate.mjs` for exactly what it sends.

## License

MIT © Pushary
