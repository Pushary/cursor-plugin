<p align="center">
  <img src="assets/logo.png" alt="Pushary" width="72" height="72" />
</p>

<h1 align="center">Pushary for Cursor</h1>

<p align="center">A control panel for your AI coding agent. Get a push when work finishes, answer the agent from your phone, and approve risky commands before they run.</p>

---

## What it is

Pushary connects Cursor to your phone. When the agent finishes a task, needs a decision, or is about to run something risky, it reaches you with a push notification. You answer from the lock screen and the agent keeps going. It works even when you have stepped away from your computer.

## What it does

There are three things.

1. Notify. The agent sends a push when a long task finishes, or when a build, test, or deploy fails. The push can include what changed, the error, and suggested next steps.

2. Ask. The agent asks you questions through push: yes or no, multiple choice, or free text. It waits for your answer. When Pushary is connected, the agent sends its questions to your phone instead of waiting in the editor.

3. Gate. Risky shell commands (like rm, force push, history rewrites, database drops, deploys, and systemctl) are checked before they run. What happens is set by your Pushary dashboard policy: auto approve trusted commands, push to your phone for approval, or just notify. If you do not answer in time, it falls back to Cursor's own prompt, so nothing dangerous runs silently. If the check cannot run at all, the command is blocked instead of allowed.

## Install

You need two things: the plugin, and an API key.

### Option 1: Cursor Marketplace (recommended)

Open the Marketplace panel in Cursor, search for Pushary, and click install. Then set your API key (see below).

### Option 2: CLI

This also sets up Claude Code, Codex, and Hermes if you use them.

```bash
npx @pushary/agent-hooks@latest setup
```

### Option 3: Manual MCP

Add this to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "pushary": {
      "type": "http",
      "url": "https://pushary.com/api/mcp/mcp",
      "headers": { "Authorization": "Bearer ${env:PUSHARY_API_KEY}" }
    }
  }
}
```

However you install it, Pushary talks to the same server, so the plugin and the CLI give you the same setup.

## Set your API key

The plugin reads your key from the `PUSHARY_API_KEY` environment variable. Get a key at https://pushary.com, then add it to your shell profile:

```bash
echo 'export PUSHARY_API_KEY="pk_xxx.sk_xxx"' >> ~/.zshrc
source ~/.zshrc
```

Install the Pushary app on your phone (or turn on web push) so the agent can reach you.

## Troubleshooting

macOS GUI apps do not read `.zshrc`. If Settings > MCP shows pushary in red after you set the env var, launch Cursor from a terminal where `PUSHARY_API_KEY` is exported, or set the variable system-wide so GUI apps see it.

## What is in the plugin

| Part | File | What it does |
|------|------|--------------|
| MCP server | `mcp.json` | Connects Cursor to the Pushary tools: `send_notification`, `ask_user`, `wait_for_answer`, `cancel_question`, `list_sessions` |
| Rule | `rules/pushary.mdc` | Always on guidance so the agent uses Pushary on its own |
| Skill | `skills/pushary/SKILL.md` | Full tool reference: parameters, examples, return values |
| Hook | `hooks/hooks.json` and `scripts/pushary-gate.mjs` | Sends risky commands to your phone for approval |
| Commands | `commands/` | `/pushary-test` and `/notify-when-done` |

## How the gate decides

There are two layers.

1. The matcher in `hooks/hooks.json` is a list of patterns that decides which commands get checked at all. Edit it to add or remove patterns.

2. Your Pushary dashboard policy decides what happens to a checked command, per tool: auto approve, the approval mode (push and wait, push then prompt, notify only, or prompt only), the timeout action, a live mode override, and the kill switch. This is the same policy your other Pushary agents use, so the behavior stays the same across agents.

## Commands

- `/pushary-test` sends a test push so you can confirm delivery.
- `/notify-when-done` tells the agent to push a summary when the current task finishes.

## Development

`skills/pushary/SKILL.md` mirrors the Pushary skill that ships with `@pushary/agent-hooks`. Keep the two the same.

Test the plugin locally before publishing:

```bash
ln -s "$(pwd)" ~/.cursor/plugins/local/pushary
```

Then reload Cursor with Developer: Reload Window.

## Security

This repository has no secrets. Your key is read at runtime from `PUSHARY_API_KEY`. The gate script has no dependencies and only talks to pushary.com. Read `scripts/pushary-gate.mjs` to see exactly what it sends. See `SECURITY.md` for details.

## License

MIT. See `LICENSE`.
